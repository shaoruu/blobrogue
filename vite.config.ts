import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
// The changelog generator is a plain Node module (kept out of the tsc program) so it can
// run in the build without a compile step. It parses CHANGELOG.md -> src/generated.
import { writeChangelog, latestVersion } from "./tools/genChangelog.mjs";
import { writeChangelogSite } from "./tools/genChangelogSite.mjs";

const root = dirname(fileURLToPath(import.meta.url));

// The build version key = the newest CHANGELOG section (a date, or "unreleased"). This is
// the single source the "What's New" panel reads (package.json stays 0.0.0).
const BUILD_VERSION = latestVersion(root);

export default defineConfig({
  // __BUILD_VERSION__ is the latest changelog version key, injected at build time.
  define: {
    __BUILD_VERSION__: JSON.stringify(BUILD_VERSION),
  },
  plugins: [
    {
      // Regenerate src/generated/changelog.ts from CHANGELOG.md on every dev/build start,
      // so the in-game panel can never drift from the source-of-truth markdown.
      name: "blobrogue-changelog",
      buildStart() {
        writeChangelog(root);
        // The standalone /changelog site is built from the same parse, so it never drifts.
        writeChangelogSite(root);
      },
    },
  ],
});
