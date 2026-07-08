// Auth-ticket seam (production spec §3, ops §7). Every WS join carries a short-lived signed
// ticket that binds a playerId; the server verifies it BEFORE binding a player to a world —
// an unauthenticated socket can do nothing. In production the ticket is minted by a trusted
// party (a Convex action, Stage C wiring) using the SAME GS_AUTH_SECRET; here we implement the
// verify side (production-ready) + a mint helper the tests/harness use.
//
// The signature is HMAC-SHA256 over `v1.<payload>`, so the secret never leaves the server<->
// minter trust boundary and can be rotated without a client change.
//
// A DEV bypass exists ONLY when explicitly enabled (GS_ALLOW_DEV_AUTH=1) and NEVER in
// production (NODE_ENV=production hard-disables it). It accepts `dev:<playerId>` so a local
// browser tab can connect without a Convex mint. It is off by default — production requires a
// real signed ticket.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface TicketPayload {
  pid: string; // authenticated playerId
  exp: number; // unix seconds expiry
}

export interface AuthResult {
  ok: boolean;
  playerId?: string;
  reason?: string;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function sign(secret: string, body: string): string {
  return b64url(createHmac("sha256", secret).update(body).digest());
}

// Mint a signed ticket valid for `ttlSecs`. Used by tests, the harness, and the local
// dev-ticket endpoint — mirrors what the production Convex minter will do.
export function mintTicket(secret: string, playerId: string, ttlSecs = 120, nowMs = Date.now()): string {
  const payload: TicketPayload = { pid: playerId, exp: Math.floor(nowMs / 1000) + ttlSecs };
  const body = "v1." + b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return body + "." + sign(secret, body);
}

export interface AuthConfig {
  secret: string | null; // GS_AUTH_SECRET; when null, real tickets cannot be verified
  allowDev: boolean;      // GS_ALLOW_DEV_AUTH=1 AND NODE_ENV!==production
}

// Verify a ticket, returning the bound playerId or a reason for rejection. Pure w.r.t. the
// clock argument so it is deterministically testable.
export function verifyTicket(cfg: AuthConfig, ticket: string, nowMs = Date.now()): AuthResult {
  if (typeof ticket !== "string" || ticket.length === 0 || ticket.length > 512) {
    return { ok: false, reason: "malformed" };
  }
  if (cfg.allowDev && ticket.startsWith("dev:")) {
    const pid = ticket.slice(4);
    if (pid.length < 1 || pid.length > 64) return { ok: false, reason: "bad_dev_id" };
    return { ok: true, playerId: "dev:" + pid };
  }
  if (!cfg.secret) return { ok: false, reason: "no_secret" };

  const parts = ticket.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return { ok: false, reason: "bad_format" };
  const body = parts[0] + "." + parts[1];
  const expected = sign(cfg.secret, body);
  // Constant-time comparison to avoid signature-timing oracles.
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_sig" };

  let payload: TicketPayload;
  try {
    payload = JSON.parse(fromB64url(parts[1]).toString("utf8")) as TicketPayload;
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
  if (typeof payload.pid !== "string" || payload.pid.length < 1 || payload.pid.length > 64) {
    return { ok: false, reason: "bad_pid" };
  }
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return { ok: false, reason: "bad_exp" };
  if (payload.exp * 1000 < nowMs) return { ok: false, reason: "expired" };
  return { ok: true, playerId: payload.pid };
}

// Build the auth config from the environment, enforcing that the dev bypass can never be on
// in production regardless of GS_ALLOW_DEV_AUTH.
export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const isProd = env.NODE_ENV === "production";
  return {
    secret: env.GS_AUTH_SECRET && env.GS_AUTH_SECRET.length > 0 ? env.GS_AUTH_SECRET : null,
    allowDev: !isProd && env.GS_ALLOW_DEV_AUTH === "1",
  };
}
