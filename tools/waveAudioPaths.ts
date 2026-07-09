// Prints the exact audio files the wave manifest expects, straight from the registry —
// the generation box's checklist (single source of truth: src/game/waveSpec.ts).
// Run: npx tsx tools/waveAudioPaths.ts [--missing]
// With --missing, prints only stems whose .ogg is not yet under public/audio/.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WAVE_SOUNDS } from "../src/game/waveSpec.js";
import type { WaveSoundSpec } from "../src/game/waveSpec.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isMissingOnly = process.argv.includes("--missing");

const rows: { event: string; stem: string; isLoop: boolean }[] = [];
for (const [event, spec] of Object.entries<WaveSoundSpec>(WAVE_SOUNDS)) {
  if (spec.stem === null) continue; // REUSE/DERIVE-only rows never ship files
  if (spec.variants <= 1) {
    rows.push({ event, stem: spec.stem, isLoop: spec.loop === true });
  } else {
    for (let v = 1; v <= spec.variants; v++) {
      rows.push({ event, stem: `${spec.stem}_v${v}`, isLoop: spec.loop === true });
    }
  }
}

let missing = 0;
for (const row of rows) {
  const isPresent = existsSync(join(root, "public", "audio", `${row.stem}.ogg`));
  if (!isPresent) missing++;
  if (isMissingOnly && isPresent) continue;
  const mark = isPresent ? "have" : "WAIT";
  console.log(`${mark}  public/audio/${row.stem}.{ogg,mp3}  (${row.event}${row.isLoop ? ", loop" : ""})`);
}
console.log(`\n${rows.length} files expected (${rows.length - missing} present, ${missing} waiting on generation).`);
