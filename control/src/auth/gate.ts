// Auth gate: turns request headers into an authenticated actor, or a typed rejection with the
// right HTTP status. Admin tokens gate every route; confirmation tokens additionally gate
// deploy/restart/rollback and are bound to the exact action + release. Replay is enforced via
// the NonceStore (a jti is accepted at most once). Origin is checked when configured.

import type { ControlConfig } from "../config.js";
import type { Clock } from "../ports.js";
import { NonceStore } from "./nonceStore.js";
import {
  verifyAdminToken,
  verifyConfirmToken,
  type ConfirmAction,
  type ConfirmTokenPayload,
} from "./tokens.js";

export interface AuthContext {
  actor: string;
  tokenJti: string;
}

export type AuthOutcome = { ok: true; ctx: AuthContext } | { ok: false; status: number; reason: string };
export type ConfirmOutcome = { ok: true; jti: string } | { ok: false; status: number; reason: string };

export class AuthGate {
  constructor(
    private cfg: ControlConfig,
    private adminNonces: NonceStore,
    private confirmNonces: NonceStore,
    private clock: Clock,
  ) {}

  checkOrigin(origin: string | null): boolean {
    if (origin === null) return true; // server-to-server proxy; the token is the real gate
    if (this.cfg.allowedOrigins.length === 0) return true;
    return this.cfg.allowedOrigins.includes(origin);
  }

  authenticate(authorization: string | null): AuthOutcome {
    const bearer = parseBearer(authorization);
    if (bearer === null) return { ok: false, status: 401, reason: "missing_bearer" };

    if (this.cfg.allowDevAuth && bearer.startsWith("dev:")) {
      const actor = bearer.slice(4).slice(0, 64);
      if (actor.length < 1) return { ok: false, status: 401, reason: "bad_dev_actor" };
      return { ok: true, ctx: { actor: "dev:" + actor, tokenJti: "dev-" + actor } };
    }

    if (this.cfg.adminTokenSecret === null) return { ok: false, status: 503, reason: "admin_secret_unconfigured" };
    const res = verifyAdminToken(this.cfg.adminTokenSecret, bearer, { audience: this.cfg.tokenAudience, maxTtlSec: this.cfg.adminTokenMaxTtlSec }, this.clock.now());
    if (!res.ok) return { ok: false, status: 401, reason: res.reason };
    if (this.adminNonces.checkAndRecord(res.payload.jti, res.payload.exp)) {
      return { ok: false, status: 401, reason: "replay" };
    }
    return { ok: true, ctx: { actor: res.payload.sub, tokenJti: res.payload.jti } };
  }

  // Verify a confirmation token bound to `action` (+ releaseId when the action carries one).
  verifyConfirmation(header: string | null, action: ConfirmAction, releaseId: string | null): ConfirmOutcome {
    if (this.cfg.allowDevAuth && header !== null && header.startsWith("dev:")) {
      return { ok: true, jti: "dev-confirm" };
    }
    if (header === null || header.length === 0) return { ok: false, status: 401, reason: "missing_confirm_token" };
    if (this.cfg.confirmTokenSecret === null) return { ok: false, status: 503, reason: "confirm_secret_unconfigured" };
    const res = verifyConfirmToken(this.cfg.confirmTokenSecret, header, this.cfg.tokenAudience, this.clock.now());
    if (!res.ok) return { ok: false, status: 401, reason: res.reason };
    const payload: ConfirmTokenPayload = res.payload;
    if (payload.action !== action) return { ok: false, status: 401, reason: "confirm_action_mismatch" };
    if ((payload.releaseId ?? null) !== (releaseId ?? null)) return { ok: false, status: 401, reason: "confirm_release_mismatch" };
    if (this.confirmNonces.checkAndRecord(payload.jti, payload.exp)) return { ok: false, status: 401, reason: "confirm_replay" };
    return { ok: true, jti: payload.jti };
  }
}

function parseBearer(authorization: string | null): string | null {
  if (authorization === null) return null;
  const m = /^Bearer (.+)$/.exec(authorization.trim());
  return m ? m[1].trim() : null;
}
