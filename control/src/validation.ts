// Strict request-body validation. Two layers of defense against injection of a command, path,
// process, env, git ref, or URL:
//   1. Structural rejection: ANY body carrying a forbidden key is rejected before dispatch, so a
//      request can never even NAME a target/app/cmd/path/ref/url. Town is unnameable.
//   2. Positive typing: the only accepted fields are `releaseId` (validated grammar, looked up —
//      never used to construct a shell/path) and a boolean `action` enum for /confirm.

import { isValidReleaseId } from "./ids.js";
import type { ConfirmAction } from "./auth/tokens.js";

export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "cmd", "command", "path", "dir", "cwd", "process", "app", "appname", "appName", "name",
  "target", "host", "hostname", "env", "environment", "ref", "gitref", "gitRef", "branch",
  "commit", "sha", "url", "uri", "args", "argv", "script", "shell", "exec", "pm2", "town",
]);

const MAX_BODY_BYTES = 8 * 1024;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export function parseJsonObject(raw: string): ParseResult<Record<string, unknown>> {
  if (raw.length === 0) return { ok: true, value: {} };
  if (raw.length > MAX_BODY_BYTES) return { ok: false, reason: "body_too_large" };
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "bad_json" };
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return { ok: false, reason: "not_an_object" };
  return { ok: true, value: obj as Record<string, unknown> };
}

// Reject any body that carries a forbidden key (case-insensitive). Returns the offending key.
export function findForbiddenKey(obj: Record<string, unknown>): string | null {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(key) || FORBIDDEN_KEYS.has(key.toLowerCase())) return key;
  }
  return null;
}

export interface ReleaseIdBody {
  releaseId: string;
}

export function parseReleaseIdBody(obj: Record<string, unknown>): ParseResult<ReleaseIdBody> {
  const forbidden = findForbiddenKey(obj);
  if (forbidden !== null) return { ok: false, reason: `forbidden_key:${forbidden}` };
  const releaseId = obj.releaseId;
  if (typeof releaseId !== "string") return { ok: false, reason: "releaseId_required" };
  if (!isValidReleaseId(releaseId)) return { ok: false, reason: "releaseId_invalid" };
  return { ok: true, value: { releaseId } };
}

export interface ConfirmBody {
  action: ConfirmAction;
  releaseId: string | null;
}

export function parseConfirmBody(obj: Record<string, unknown>): ParseResult<ConfirmBody> {
  const forbidden = findForbiddenKey(obj);
  if (forbidden !== null) return { ok: false, reason: `forbidden_key:${forbidden}` };
  const action = obj.action;
  if (action !== "deploy" && action !== "restart" && action !== "rollback") return { ok: false, reason: "action_invalid" };
  let releaseId: string | null = null;
  if (action === "deploy" || action === "rollback") {
    if (typeof obj.releaseId !== "string" || !isValidReleaseId(obj.releaseId)) return { ok: false, reason: "releaseId_invalid" };
    releaseId = obj.releaseId;
  } else if (obj.releaseId !== undefined) {
    return { ok: false, reason: "releaseId_not_allowed_for_restart" };
  }
  return { ok: true, value: { action, releaseId } };
}
