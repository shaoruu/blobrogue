/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Convex deployment URL. Set in Vercel (and .env.local for `convex dev`).
  // When unset, multiplayer is disabled and the game runs solo.
  readonly VITE_CONVEX_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
