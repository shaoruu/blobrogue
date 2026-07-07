// Multiplayer is opt-in via a single Vite env var. If it is missing (the default),
// the whole online layer stays dormant and blobrogue plays exactly like solo v0.
// This is what guarantees the deployed game never breaks on a missing Convex URL.

const rawUrl = import.meta.env.VITE_CONVEX_URL;

export const CONVEX_URL: string | null =
  typeof rawUrl === "string" && rawUrl.trim().length > 0 ? rawUrl.trim() : null;

export const isMultiplayerEnabled: boolean = CONVEX_URL !== null;

// Authoritative game-server (WebSocket) URL for the Stage-B online path. Opt-in and separate
// from Convex: online play is gated behind an explicit `?online=1` route (never the default),
// so solo/co-op are untouched. Resolution order: ?gs=<wsUrl> query param, VITE_GS_URL, then a
// localhost default for the local dev spike (matches the server's 127.0.0.1:8090 bind).
const rawGs = import.meta.env.VITE_GS_URL;
const envGs: string | null = typeof rawGs === "string" && rawGs.trim().length > 0 ? rawGs.trim() : null;

export function resolveGsUrl(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get("online") === null && !params.has("gs")) return null;
  const q = params.get("gs");
  if (q && q.trim().length > 0) return q.trim();
  if (envGs) return envGs;
  return "ws://127.0.0.1:8090/ws";
}

// Derive the local dev-ticket HTTP endpoint from a ws(s) URL (local spike only; production
// mints tickets via a trusted Convex action instead).
export function devTicketUrl(gsUrl: string): string {
  return gsUrl.replace(/^ws/, "http").replace(/\/ws$/, "/dev-ticket");
}
