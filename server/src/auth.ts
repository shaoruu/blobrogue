// Auth-ticket seam (production spec §3, ops §7). Every WS join carries a short-lived signed
// ticket that binds a playerId; the server verifies it BEFORE binding a player to a world —
// an unauthenticated socket can do nothing. In production the ticket is minted by a trusted
// party (the Convex action convex/gsTicket.ts) using the SAME GS_AUTH_SECRET; here we implement
// the verify side (production-ready) + a mint helper the tests/harness use.
//
// Beyond identity (pid/exp) the payload can carry OPTIONAL room/identity claims, appended by
// the minter in a fixed key order (see convex/gsTicketCore.ts — the byte contract):
//   wld — the world id this ticket AUTHORIZES. Convex mints it only after verifying room
//         membership, and the join handler binds the connection to exactly this world; a
//         client can never assert a world id itself. Absent -> the default/public world.
//   nm  — the player's display name (shown above their blob to other players).
//   cl  — a cosmetic color index (player-chosen blob tint).
// All three are validated/sanitized here before anything trusts them.
//
// The signature is HMAC-SHA256 over `v1.<payload>`, so the secret never leaves the server<->
// minter trust boundary and can be rotated without a client change.
//
// A DEV bypass exists ONLY when explicitly enabled (GS_ALLOW_DEV_AUTH=1) and NEVER in
// production (NODE_ENV=production hard-disables it). It accepts `dev:<playerId>` — optionally
// `dev:<playerId>@<worldId>` so the zero-secret two-tab local proof can exercise room-scoped
// worlds too. It is off by default — production requires a real signed ticket.

import { createHmac, timingSafeEqual } from "node:crypto";
import { isValidWorldId } from "../../src/net/protocol.js";

export { isValidWorldId };

export interface TicketPayload {
  pid: string;  // authenticated playerId
  exp: number;  // unix seconds expiry
  wld?: string; // authorized world id
  nm?: string;  // display name
  cl?: number;  // cosmetic color index
}

// Optional claims for a mint (long-form field names of the wire keys above).
export interface TicketClaims {
  worldId?: string;
  name?: string;
  colorIndex?: number;
}

export interface AuthResult {
  ok: boolean;
  playerId?: string;
  worldId?: string;     // verified world authorization (absent -> default world)
  name?: string;        // sanitized display name
  colorIndex?: number;  // validated cosmetic color index
  reason?: string;
}

const NAME_MAX = 20;
const COLOR_MAX = 15;

// Display names render on other players' screens: strip control characters, collapse
// whitespace runs, clamp length. Returns null when nothing displayable remains.
export function sanitizeDisplayName(raw: string): string | null {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  return cleaned.length > 0 ? cleaned : null;
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
// dev-ticket endpoint — mirrors what the production Convex minter does, byte-for-byte
// (payload keys in the FIXED order pid, exp, wld, nm, cl; see convex/gsTicketCore.ts).
export function mintTicket(secret: string, playerId: string, ttlSecs = 120, nowMs = Date.now(), claims: TicketClaims = {}): string {
  const payload: TicketPayload = { pid: playerId, exp: Math.floor(nowMs / 1000) + ttlSecs };
  if (claims.worldId !== undefined) payload.wld = claims.worldId;
  if (claims.name !== undefined) payload.nm = claims.name;
  if (claims.colorIndex !== undefined) payload.cl = claims.colorIndex;
  const body = "v1." + b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return body + "." + sign(secret, body);
}

export interface AuthConfig {
  secret: string | null; // GS_AUTH_SECRET; when null, real tickets cannot be verified
  allowDev: boolean;      // GS_ALLOW_DEV_AUTH=1 AND NODE_ENV!==production
}

// Verify a ticket, returning the bound playerId (+ any verified claims) or a reason for
// rejection. Pure w.r.t. the clock argument so it is deterministically testable.
export function verifyTicket(cfg: AuthConfig, ticket: string, nowMs = Date.now()): AuthResult {
  if (typeof ticket !== "string" || ticket.length === 0 || ticket.length > 512) {
    return { ok: false, reason: "malformed" };
  }
  if (cfg.allowDev && ticket.startsWith("dev:")) {
    const raw = ticket.slice(4);
    const at = raw.indexOf("@");
    const pid = at < 0 ? raw : raw.slice(0, at);
    const wld = at < 0 ? null : raw.slice(at + 1);
    if (pid.length < 1 || pid.length > 64) return { ok: false, reason: "bad_dev_id" };
    if (wld !== null && !isValidWorldId(wld)) return { ok: false, reason: "bad_world" };
    return { ok: true, playerId: "dev:" + pid, ...(wld !== null ? { worldId: wld } : {}) };
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

  // Optional claims: a signed-but-malformed claim is a minter bug or tamper attempt — reject
  // outright rather than silently misrouting the player or trusting junk.
  const out: AuthResult = { ok: true, playerId: payload.pid };
  if (payload.wld !== undefined) {
    if (typeof payload.wld !== "string" || !isValidWorldId(payload.wld)) return { ok: false, reason: "bad_world" };
    out.worldId = payload.wld;
  }
  if (payload.nm !== undefined) {
    if (typeof payload.nm !== "string" || payload.nm.length > 64) return { ok: false, reason: "bad_name" };
    const name = sanitizeDisplayName(payload.nm);
    if (name !== null) out.name = name;
  }
  if (payload.cl !== undefined) {
    if (typeof payload.cl !== "number" || !Number.isInteger(payload.cl) || payload.cl < 0 || payload.cl > COLOR_MAX) {
      return { ok: false, reason: "bad_color" };
    }
    out.colorIndex = payload.cl;
  }
  return out;
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
