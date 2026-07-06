// Multiplayer is opt-in via a single Vite env var. If it is missing (the default),
// the whole online layer stays dormant and blobrogue plays exactly like solo v0.
// This is what guarantees the deployed game never breaks on a missing Convex URL.

const rawUrl = import.meta.env.VITE_CONVEX_URL;

export const CONVEX_URL: string | null =
  typeof rawUrl === "string" && rawUrl.trim().length > 0 ? rawUrl.trim() : null;

export const isMultiplayerEnabled: boolean = CONVEX_URL !== null;
