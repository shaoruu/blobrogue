// Multiplayer is opt-in via a single Vite env var. If it is missing (the default),
// the whole online layer stays dormant and blobrogue plays exactly like solo v0.
// This is what guarantees the deployed game never breaks on a missing Convex URL.

const rawUrl = import.meta.env.VITE_CONVEX_URL;

export const CONVEX_URL: string | null =
  typeof rawUrl === "string" && rawUrl.trim().length > 0 ? rawUrl.trim() : null;

export const isMultiplayerEnabled: boolean = CONVEX_URL !== null;

// Authoritative game-server (WebSocket) URL for the online path. Opt-in and separate from
// Convex: online play is gated behind an explicit `?online=1` (or `?gs=`) route (NEVER the
// default), so solo/co-op are completely untouched and an unreachable game server can never
// break the deployed game for solo players. Resolution order: ?gs=<wsUrl> query param,
// VITE_GS_URL, then the production game server on production builds / localhost on dev builds.
const rawGs = import.meta.env.VITE_GS_URL;
const envGs: string | null = typeof rawGs === "string" && rawGs.trim().length > 0 ? rawGs.trim() : null;

// The deployed game server (nginx wss on 443 -> loopback:8090; ops spec §6/§7).
export const PROD_GS_URL = "wss://gs.create.town/ws";

export function resolveGsUrl(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get("online") === null && !params.has("gs")) return null;
  const q = params.get("gs");
  if (q && q.trim().length > 0) return q.trim();
  if (envGs) return envGs;
  return import.meta.env.PROD ? PROD_GS_URL : "ws://127.0.0.1:8090/ws";
}

// True when the url came from an explicit ?gs= override — the local-dev path, whose tickets
// come from that server's own /dev-ticket endpoint instead of the production Convex minter.
export function isExplicitGsOverride(search: string): boolean {
  const params = new URLSearchParams(search);
  const q = params.get("gs");
  return q !== null && q.trim().length > 0;
}

// Derive the local dev-ticket HTTP endpoint from a ws(s) URL (local dev only; production mints
// tickets via the trusted Convex action gsTicket:mint).
export function devTicketUrl(gsUrl: string): string {
  return gsUrl.replace(/^ws/, "http").replace(/\/ws$/, "/dev-ticket");
}
