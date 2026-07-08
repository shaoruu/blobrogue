// Redaction for logs (both the service's own structured logs and any gs log lines returned via
// GET /v1/logs). Secrets are never emitted; token-shaped material and known secret env names are
// masked. Audit records reference tokens by jti only, never by value.

import type { LogValue } from "./types.js";

const SECRET_KEY_RE = /(secret|token|password|passwd|authorization|cookie|apikey|api_key|private)/i;
// Bearer/HMAC-ish material: long base64url runs, and the `v1.<b64>.<sig>` token envelope.
const TOKEN_LIKE_RE = /\b(v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b|\b[A-Za-z0-9_-]{40,}\b/g;

export function redactString(s: string): string {
  return s.replace(TOKEN_LIKE_RE, "[REDACTED]");
}

export function redactValue(key: string, value: LogValue): LogValue {
  if (SECRET_KEY_RE.test(key)) return value === null || value === undefined ? value : "[REDACTED]";
  if (typeof value === "string") return redactString(value);
  return value;
}

export function redactFields(fields: Record<string, LogValue>): Record<string, LogValue> {
  const out: Record<string, LogValue> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = redactValue(k, v);
  return out;
}
