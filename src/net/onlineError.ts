// Client-side normalization of the errors online flows can reject with, into a single clean,
// player-safe shape { code, message }. Every online create/quickPlay/join/invite catch path
// funnels through normalizeOnlineError, so the menu shows ONLY the clean copy — never a raw
// `Uncaught ConvexError:` / JSON blob / `[Request ID: ...] Server Error` framing string.
//
// It recognizes the three shapes a blocked PVP action can arrive as:
//   1. a tagged ConvexError from the Convex SDK boundary (the backend throw) — its structured
//      `.data` is delivered verbatim (a plain Error would be redacted in prod), so we read
//      { code, message } off it. Detected by BOTH `instanceof ConvexError` and the runtime tag
//      Symbol.for("ConvexError") so a structurally-tagged (cross-realm) object still resolves.
//   2. the local client-preflight PvpDisabledError (never crossed RPC).
//   3. a game-server WS error frame { t:"error", code, msg } (the last-line-of-defense reject).
// Anything else is treated as an ORDINARY error: its message is de-framed, else the fallback —
// crucially, a generic/redacted server error is NEVER misclassified as a typed code.

import { ConvexError, type Value } from "convex/values";
import { PvpDisabledError } from "./pvpFlag.js";

const CONVEX_ERROR_TAG = Symbol.for("ConvexError");
const UPDATE_REQUIRED_CODES = new Set([
  "guest_capability_required",
  "guest_capability_invalid",
  "account_auth_required",
]);
const UPDATE_REQUIRED_MESSAGE = "This build is out of date — refresh the page to continue";

export interface NormalizedOnlineError {
  // The stable machine code from a typed error (e.g. "pvp_disabled"), else null.
  code: string | null;
  // Clean, player-safe copy — never a request id, JSON, or "Uncaught …:" framing.
  message: string;
}

// Strip Convex's server-error framing (leading `[…]` groups, an `Uncaught (Convex)?Error:`
// prefix, and any `[Request ID: …]`) so a player never sees transport noise.
function deframe(msg: string): string {
  let out = msg;
  while (/^\s*\[[^\]]*\]\s*/.test(out)) out = out.replace(/^\s*\[[^\]]*\]\s*/, "");
  return out.replace(/^\s*Uncaught\s+(?:Convex)?Error:\s*/i, "").replace(/\s*\[Request ID:[^\]]*\]/gi, "").trim();
}

// The ConvexError structured data, if `err` is one (by instanceof OR the runtime tag).
function convexErrorData(err: object): Value | undefined {
  const isTagged = (err as { [k: symbol]: boolean })[CONVEX_ERROR_TAG] === true;
  if (err instanceof ConvexError || isTagged) return (err as { data?: Value }).data;
  return undefined;
}

// A typed { code, message } payload out of a Convex Value, or null if it is not that shape.
function fromConvexData(data: Value): NormalizedOnlineError | null {
  if (data !== null && typeof data === "object" && !Array.isArray(data) && !(data instanceof ArrayBuffer)) {
    const code = typeof data.code === "string" ? data.code : null;
    const message = typeof data.message === "string" ? data.message : null;
    if (message !== null) return { code, message };
  }
  if (typeof data === "string") return { code: null, message: deframe(data) };
  return null;
}

// A game-server WS error frame { t:"error", code, msg }, or null.
function fromWsErrorFrame(err: object): NormalizedOnlineError | null {
  const frame = err as { t?: string; code?: string; msg?: string };
  if (frame.t === "error" && typeof frame.code === "string") {
    return { code: frame.code, message: typeof frame.msg === "string" && frame.msg.length > 0 ? frame.msg : "" };
  }
  return null;
}

export function normalizeOnlineError(err: unknown, fallback = "something went wrong"): NormalizedOnlineError {
  // Local preflight guard (never crossed RPC): already the clean code + copy.
  if (err instanceof PvpDisabledError) return { code: err.code, message: err.message };

  if (typeof err === "object" && err !== null) {
    const data = convexErrorData(err);
    if (data !== undefined) {
      const parsed = fromConvexData(data);
      if (parsed !== null) {
        return parsed.code && UPDATE_REQUIRED_CODES.has(parsed.code)
          ? { code: "client_outdated", message: UPDATE_REQUIRED_MESSAGE }
          : parsed;
      }
    }
    const frame = fromWsErrorFrame(err);
    if (frame !== null) return { code: frame.code, message: frame.message.length > 0 ? frame.message : fallback };
  }

  if (err instanceof Error) {
    const message = deframe(err.message);
    return { code: null, message: message.length > 0 ? message : fallback };
  }
  if (typeof err === "string") {
    const message = deframe(err);
    return { code: null, message: message.length > 0 ? message : fallback };
  }
  return { code: null, message: fallback };
}
