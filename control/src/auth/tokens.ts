// Admin ops tokens + action-bound confirmation tokens. Same compact HMAC envelope shape as the
// game ticket (`v1.<b64url(payload)>.<sig>`) but a DIFFERENT secret and a richer payload — the
// game and control credential systems never overlap. Signatures use constant-time comparison to
// avoid timing oracles. Verification here is pure (clock injected); replay (jti) is enforced one
// layer up with the NonceStore so this stays a pure function.

import { createHmac, timingSafeEqual } from "node:crypto";

export const REQUIRED_SCOPE = "blobrogue:ops";
export type ConfirmAction = "deploy" | "restart" | "rollback";

export interface AdminTokenPayload {
  sub: string;
  scope: string[];
  aud: string;
  iss: string | null;
  iat: number;
  exp: number;
  jti: string;
}

export interface ConfirmTokenPayload {
  action: ConfirmAction;
  releaseId: string | null;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}

export type TokenVerify<T> = { ok: true; payload: T } | { ok: false; reason: string };

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function sign(secret: string, body: string): string {
  return b64url(createHmac("sha256", secret).update(body).digest());
}

function encodeEnvelope(secret: string, payloadJson: string): string {
  const body = "v1." + b64url(Buffer.from(payloadJson, "utf8"));
  return body + "." + sign(secret, body);
}

// Verify signature + envelope, returning the raw parsed object for the caller to type-narrow.
function decodeEnvelope(secret: string, token: string): { ok: true; obj: Record<string, unknown> } | { ok: false; reason: string } {
  if (typeof token !== "string" || token.length < 1 || token.length > 4096) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return { ok: false, reason: "bad_format" };
  const body = parts[0] + "." + parts[1];
  const expected = sign(secret, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_sig" };
  let obj: unknown;
  try {
    obj = JSON.parse(fromB64url(parts[1]).toString("utf8"));
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
  if (typeof obj !== "object" || obj === null) return { ok: false, reason: "bad_payload" };
  return { ok: true, obj: obj as Record<string, unknown> };
}

function str(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === "string" ? v : null;
}
function numField(o: Record<string, unknown>, k: string): number | null {
  const v = o[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export interface AdminTokenPolicy {
  audience: string;
  maxTtlSec: number;
}

export function mintAdminToken(secret: string, payload: AdminTokenPayload): string {
  return encodeEnvelope(secret, JSON.stringify(payload));
}

export function verifyAdminToken(secret: string, token: string, policy: AdminTokenPolicy, nowMs: number): TokenVerify<AdminTokenPayload> {
  const env = decodeEnvelope(secret, token);
  if (!env.ok) return env;
  const o = env.obj;
  const sub = str(o, "sub");
  const aud = str(o, "aud");
  const jti = str(o, "jti");
  const iat = numField(o, "iat");
  const exp = numField(o, "exp");
  const scope = Array.isArray(o.scope) ? o.scope.filter((s): s is string => typeof s === "string") : null;
  if (sub === null || sub.length < 1 || sub.length > 128) return { ok: false, reason: "bad_sub" };
  if (jti === null || jti.length < 8 || jti.length > 128) return { ok: false, reason: "bad_jti" };
  if (iat === null || exp === null) return { ok: false, reason: "bad_times" };
  if (aud !== policy.audience) return { ok: false, reason: "bad_audience" };
  if (scope === null || !scope.includes(REQUIRED_SCOPE)) return { ok: false, reason: "missing_scope" };
  const nowSec = Math.floor(nowMs / 1000);
  if (exp <= nowSec) return { ok: false, reason: "expired" };
  if (iat > nowSec + 60) return { ok: false, reason: "not_yet_valid" };
  if (exp - iat > policy.maxTtlSec) return { ok: false, reason: "ttl_too_long" };
  return { ok: true, payload: { sub, scope, aud, iss: str(o, "iss"), iat, exp, jti } };
}

export function mintConfirmToken(secret: string, payload: ConfirmTokenPayload): string {
  return encodeEnvelope(secret, JSON.stringify(payload));
}

export function verifyConfirmToken(secret: string, token: string, audience: string, nowMs: number): TokenVerify<ConfirmTokenPayload> {
  const env = decodeEnvelope(secret, token);
  if (!env.ok) return env;
  const o = env.obj;
  const action = str(o, "action");
  const sub = str(o, "sub");
  const aud = str(o, "aud");
  const jti = str(o, "jti");
  const iat = numField(o, "iat");
  const exp = numField(o, "exp");
  const releaseId = str(o, "releaseId"); // null when the object omits it or it is not a string
  if (action !== "deploy" && action !== "restart" && action !== "rollback") return { ok: false, reason: "bad_action" };
  if (sub === null) return { ok: false, reason: "bad_sub" };
  if (jti === null || jti.length < 8 || jti.length > 128) return { ok: false, reason: "bad_jti" };
  if (iat === null || exp === null) return { ok: false, reason: "bad_times" };
  if (aud !== audience) return { ok: false, reason: "bad_audience" };
  const nowSec = Math.floor(nowMs / 1000);
  if (exp <= nowSec) return { ok: false, reason: "expired" };
  if (exp - iat > 60) return { ok: false, reason: "confirm_ttl_too_long" };
  return { ok: true, payload: { action, releaseId, sub, aud, iat, exp, jti } };
}
