import { defineConfig } from "vitest/config";

// Convex function tests only (test/convex/*.test.ts) — the rest of the suite stays on the
// repo's plain-tsx runners. edge-runtime mirrors the Convex default runtime closely enough
// to catch runtime API misuse (see convex-test docs).
export default defineConfig({
  test: {
    include: ["test/convex/**/*.test.ts"],
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
  },
});
