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
//   ht/fc — cosmetic hat/face ids (visual-only labels; ownership was validated by the
//           minter's profile system, so this side gates FORMAT only — a short lowercase
//           token — never the catalog, keeping server deploys independent of catalog adds).
// All claims are validated/sanitized here before anything trusts them.
// The verifier stays backward-compatible; MessageRouter requires the full generation-bound
// loadout claim set whenever dev auth is disabled.
//
// The signature is HMAC-SHA256 over `v1.<payload>`, so the secret never leaves the server<->
// minter trust boundary and can be rotated without a client change.
//
// A DEV bypass exists ONLY when explicitly enabled (GS_ALLOW_DEV_AUTH=1) and NEVER in
// production (NODE_ENV=production hard-disables it). It accepts `dev:<playerId>` — optionally
// `dev:<playerId>@<worldId>` so the zero-secret two-tab local proof can exercise room-scoped
// worlds too. It is off by default — production requires a real signed ticket.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isValidWorldId } from "../../src/net/protocol.js";
import { isKitId } from "../../src/sim/kits.js";

export { isValidWorldId };

// ---- resume tokens (reconnect seats) ----
// A seat token is NOT a ticket: it is a single-use, server-minted random capability that
// proves connection CONTINUITY (this is the same client session that held the seat), on top
// of the ticket's identity/room proof. 192 random bits, unforgeable by construction; rotated
// on every successful resume, so a captured token replays exactly zero times.

export function mintResumeToken(): string {
  return randomBytes(24).toString("base64url");
}

// Constant-time comparison (length leak is fine — every real token is the same length).
export function resumeTokensEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && bufA.length > 0 && timingSafeEqual(bufA, bufB);
}

export interface TicketPayload {
  pid: string;  // authenticated playerId
  exp: number;  // unix seconds expiry
  wld?: string; // authorized world id
  nm?: string;  // display name
  cl?: number;  // cosmetic color index
  ht?: string;  // cosmetic hat id
  fc?: string;  // cosmetic face id
  // The KIT the player chose in the lobby + the account's Mastery LEVEL, both minted by the
  // Convex account authority (which validated the pick against the account's unlocks). The game
  // server RE-GATES kt against ml (isKitUnlocked) and downgrades on mismatch — a client can
  // never inflate either (both are inside the HMAC signature).
  kt?: string;  // chosen kit id
  ml?: number;  // account mastery level
  pt?: string;  // cosmetic companion pet id (visual-only; META spec §3)
  pc?: boolean; // explicit pet-or-No-Pet choice was validated for this run
}

// Optional claims for a mint (long-form field names of the wire keys above).
export interface TicketClaims {
  worldId?: string;
  name?: string;
  colorIndex?: number;
  hat?: string;
  face?: string;
  kit?: string;
  masteryLevel?: number;
  pet?: string;
  isPetChoiceMade?: boolean;
}

export interface AuthResult {
  ok: boolean;
  playerId?: string;
  worldId?: string;     // verified world authorization (absent -> default world)
  name?: string;        // sanitized display name
  colorIndex?: number;  // validated cosmetic color index
  hat?: string;         // format-validated cosmetic hat id
  face?: string;        // format-validated cosmetic face id
  kit?: string;         // format-validated chosen kit id (the join gate re-checks the unlock)
  masteryLevel?: number;// account mastery level (drives the server-side kit-unlock gate)
  pet?: string;         // format-validated cosmetic companion pet id (visual-only)
  isPetChoiceMade?: boolean;
  isDev?: boolean;
  reason?: string;
}

const NAME_MAX = 20;
const COLOR_MAX = 15;

// Cosmetic ids are short lowercase tokens (convex/cosmeticsCore.ts isCosmeticIdFormat) —
// mirrored here rather than imported so the server keeps zero convex-source deps.
const COSMETIC_ID_RE = /^[a-z0-9_]{1,24}$/;

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
// (payload keys in the FIXED order pid, exp, wld, nm, cl, ht, fc, kt, ml, pt, pc; see convex/gsTicketCore.ts).
export function mintTicket(secret: string, playerId: string, ttlSecs = 120, nowMs = Date.now(), claims: TicketClaims = {}): string {
  const payload: TicketPayload = { pid: playerId, exp: Math.floor(nowMs / 1000) + ttlSecs };
  if (claims.worldId !== undefined) payload.wld = claims.worldId;
  if (claims.name !== undefined) payload.nm = claims.name;
  if (claims.colorIndex !== undefined) payload.cl = claims.colorIndex;
  if (claims.hat !== undefined) payload.ht = claims.hat;
  if (claims.face !== undefined) payload.fc = claims.face;
  if (claims.kit !== undefined) payload.kt = claims.kit;
  if (claims.masteryLevel !== undefined) payload.ml = claims.masteryLevel;
  if (claims.pet !== undefined) payload.pt = claims.pet;
  if (claims.isPetChoiceMade !== undefined) payload.pc = claims.isPetChoiceMade;
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
    return { ok: true, playerId: "dev:" + pid, isDev: true, ...(wld !== null ? { worldId: wld } : {}) };
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
  if (payload.ht !== undefined) {
    if (typeof payload.ht !== "string" || !COSMETIC_ID_RE.test(payload.ht)) return { ok: false, reason: "bad_cosmetic" };
    out.hat = payload.ht;
  }
  if (payload.fc !== undefined) {
    if (typeof payload.fc !== "string" || !COSMETIC_ID_RE.test(payload.fc)) return { ok: false, reason: "bad_cosmetic" };
    out.face = payload.fc;
  }
  if (payload.kt !== undefined) {
    if (!isKitId(payload.kt)) return { ok: false, reason: "bad_kit" };
    out.kit = payload.kt;
  }
  if (payload.pt !== undefined) {
    if (typeof payload.pt !== "string" || !COSMETIC_ID_RE.test(payload.pt)) return { ok: false, reason: "bad_cosmetic" };
    out.pet = payload.pt;
  }
  if (payload.ml !== undefined) {
    if (typeof payload.ml !== "number" || !Number.isInteger(payload.ml) || payload.ml < 1 || payload.ml > 1e6) {
      return { ok: false, reason: "bad_mastery" };
    }
    out.masteryLevel = payload.ml;
  }
  if (payload.pc !== undefined) {
    if (typeof payload.pc !== "boolean") return { ok: false, reason: "bad_pet_choice" };
    out.isPetChoiceMade = payload.pc;
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
