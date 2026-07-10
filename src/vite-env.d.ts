/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Convex deployment URL. Set in Vercel (and .env.local for `convex dev`).
  // When unset, multiplayer is disabled and the game runs solo.
  readonly VITE_CONVEX_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Injected by vite (define) = the latest CHANGELOG version key (a date, or "unreleased").
// Undefined outside a vite build (tsx tests) — the changelog module falls back to
// LATEST_VERSION, so every read stays guarded with `typeof __BUILD_VERSION__`.
declare const __BUILD_VERSION__: string;
