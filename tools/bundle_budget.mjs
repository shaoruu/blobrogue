#!/usr/bin/env node
// Build-time bundle budget guard (TD's twice-flagged safeguard): after a build, assert the
// INITIAL critical-path chunks (index + main — everything eagerly loaded before a run starts)
// stay under a raw-KB ceiling, so content growth can't silently re-inflate first load. The
// heavy game/waveAudio chunks are LAZY (loaded on run-start / first cue) and are budgeted
// separately + loosely. Run after `vite build` (reads dist/assets). Non-zero exit on breach.
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIST = "dist/assets";
// Budgets in KB (raw). Set from the measured baseline + headroom (index ~243 + main ~24 =
// ~268KB today; ceiling 340KB leaves ~25% growth room before it trips). The lazy game chunk
// gets a loose ceiling just to catch a runaway, not to police normal content growth.
const INITIAL_KB = 340;   // index-*.js + main-*.js (critical path)
const LAZY_GAME_KB = 950; // game-*.js (loaded on run start) — raised 700->950 (2026-07-19): 8 days of Wave A/B/C content (bosses, guns, blessings, sprites) grew the LAZY chunk to ~759KB measured; critical-path (index+main) budget unchanged at 340KB and healthy. Headroom ~25% before it trips again.

if (!existsSync(DIST)) {
  console.error(`bundle-budget: ${DIST} not found — run \`npm run build\` first`);
  process.exit(1);
}
const files = readdirSync(DIST).filter((f) => f.endsWith(".js"));
const kb = (f) => statSync(join(DIST, f)).size / 1024;
const sum = (pred) => files.filter(pred).reduce((a, f) => a + kb(f), 0);

const initial = sum((f) => f.startsWith("index-") || f.startsWith("main-"));
const game = sum((f) => f.startsWith("game-"));

let ok = true;
const line = (name, val, budget) => {
  const pass = val <= budget;
  ok = ok && pass;
  console.log(`  ${pass ? "PASS" : "FAIL"} ${name}: ${val.toFixed(1)}KB / ${budget}KB budget`);
};
console.log("[bundle-budget] initial critical-path + lazy-chunk ceilings");
line("initial critical path (index + main)", initial, INITIAL_KB);
line("lazy game chunk", game, LAZY_GAME_KB);

if (!ok) {
  console.error("\nbundle-budget FAILED — the initial download grew past budget. Code-split a" +
    " newly-eager import off the critical path (see PR #99), or if this is deliberate, raise" +
    " the budget in tools/bundle_budget.mjs from a measured baseline + headroom.");
  process.exit(1);
}
console.log("\nBundle budget holds (initial critical path under ceiling).");
