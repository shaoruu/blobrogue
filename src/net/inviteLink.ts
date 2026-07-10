// Shareable room-invite links: one URL that lands a friend straight in a room's Play
// Online lobby. Two accepted shapes, both case-insensitive and validated against the REAL
// room-code grammar before anything routes:
//
//   https://<origin>/r/<CODE>      the canonical share form (what COPY INVITE writes)
//   https://<origin>/?room=<CODE>  the query fallback (for hosts that can't rewrite paths)
//
// The link is ONLY a convenient path to the same server-validated join a typed code takes
// (convex rooms.join: kind match, capacity, ended check) — it can never bypass room
// validation, and it never requires sign-in (guests join through the same ensurePlayer
// identity as every other flow). Cold loads consume the invite in src/main.ts; warm
// arrivals route through the same parse (popstate -> Menu.openInvite).

export const INVITE_PATH_PREFIX = "/r/";
export const INVITE_QUERY_PARAM = "room";

// The real grammar from convex/rooms.ts: CODE_LEN (4) chars from the unambiguous alphabet
// (no O/0/I/1), plus one extra char on the rare uniqueCode collision fallback.
const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{4,5}$/;

const PATH_FORM_RE = /^\/r\/([^/]+)\/?$/i;

export function normalizeRoomCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return ROOM_CODE_RE.test(code) ? code : null;
}

// The first VALID code wins: the clean path form, then the query fallback. Anything that
// fails the grammar is null — an invalid invite never routes on a guessed code.
export function parseInviteCode(pathname: string, search: string): string | null {
  const m = PATH_FORM_RE.exec(pathname);
  if (m) {
    let raw = m[1];
    try { raw = decodeURIComponent(raw); } catch { /* malformed escape: validate as-is */ }
    const fromPath = normalizeRoomCode(raw);
    if (fromPath !== null) return fromPath;
  }
  const q = new URLSearchParams(search).get(INVITE_QUERY_PARAM);
  return q !== null ? normalizeRoomCode(q) : null;
}

// True when the URL is invite-SHAPED (either form present), valid code or not. A mangled
// invite is still an invite attempt: it deserves the honest "that link is broken" landing
// on the Play Online home, never a silent drop to the title.
export function hasInviteIntent(pathname: string, search: string): boolean {
  return PATH_FORM_RE.test(pathname) || new URLSearchParams(search).get(INVITE_QUERY_PARAM) !== null;
}

// The canonical shareable URL for a room (always the clean path form, always uppercase).
export function inviteUrlFor(code: string, origin: string): string {
  return `${origin.replace(/\/+$/, "")}${INVITE_PATH_PREFIX}${code.trim().toUpperCase()}`;
}

// Consume the invite from the address bar (path back to /, ?room= dropped, everything
// else kept) so a refresh doesn't re-join and the URL players see is the plain app again.
export function stripInviteFromLocation(): void {
  const url = new URL(window.location.href);
  if (PATH_FORM_RE.test(url.pathname)) url.pathname = "/";
  url.searchParams.delete(INVITE_QUERY_PARAM);
  window.history.replaceState({}, "", url.pathname + url.search + url.hash);
}

// ---- the share/copy bridge (SHARE INVITE / COPY INVITE / tap-to-copy badge) ----
//
// Platforms with a native share sheet (navigator.share) get it; everyone else runs the
// clipboard chain: navigator.clipboard.writeText -> execCommand('copy') on a hidden
// field -> honest failure (the UI then reveals the link in a selectable field — never a
// dead action). Outcomes are explicit so confirmations fire ONLY on real success: a
// dismissed share sheet is a no-op, never a fake COPIED.

export type ShareOutcome = "shared" | "dismissed" | "copied" | "failed";

export const INVITE_SHARE_TITLE = "blobrogue";
export const INVITE_SHARE_TEXT = "Join my blobrogue run";

export interface ShareCapabilities {
  share: ((data: { title: string; text: string; url: string }) => Promise<void>) | null;
  writeClipboard: ((text: string) => Promise<void>) | null;
  execCopy: ((text: string) => boolean) | null;
}

// The legacy path: a hidden read-only field, select, execCommand('copy'). Everything is
// guarded — any environment that lacks a piece simply reports false and the chain moves on.
function execCommandCopy(text: string): boolean {
  try {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.left = "-9999px";
    document.body.appendChild(field);
    field.select();
    const isCopied = document.execCommand("copy");
    field.remove();
    return isCopied;
  } catch {
    return false;
  }
}

export function detectShareCapabilities(): ShareCapabilities {
  const nav = navigator;
  return {
    share: typeof nav.share === "function" ? nav.share.bind(nav) : null,
    writeClipboard: nav.clipboard && typeof nav.clipboard.writeText === "function"
      ? nav.clipboard.writeText.bind(nav.clipboard)
      : null,
    execCopy: execCommandCopy,
  };
}

// Drives the button's idle label: SHARE INVITE where a share sheet exists, COPY INVITE
// everywhere else.
export function canShareInvite(caps: ShareCapabilities = detectShareCapabilities()): boolean {
  return caps.share !== null;
}

export async function copyInviteUrl(url: string, caps: ShareCapabilities = detectShareCapabilities()): Promise<"copied" | "failed"> {
  if (caps.writeClipboard) {
    try {
      await caps.writeClipboard(url);
      return "copied";
    } catch {
      // Blocked/denied clipboard: the legacy path below still gets its try.
    }
  }
  if (caps.execCopy?.(url)) return "copied";
  return "failed";
}

export async function shareInviteUrl(url: string, caps: ShareCapabilities = detectShareCapabilities()): Promise<ShareOutcome> {
  if (caps.share) {
    try {
      await caps.share({ title: INVITE_SHARE_TITLE, text: INVITE_SHARE_TEXT, url });
      return "shared";
    } catch (err) {
      // Cancelling the sheet is a deliberate no-op; anything else (unsupported payload,
      // blocked sheet) falls through to the clipboard chain.
      if (err instanceof Error && err.name === "AbortError") return "dismissed";
    }
  }
  return copyInviteUrl(url, caps);
}
