// Locks the changelog media map (tools/changelogMedia.mjs): a couple of representative
// title->paths mappings, and the hard invariant that it NEVER points at a sprite that isn't
// actually shipped under public/ (every path is fs.existsSync-checked against the real repo).
//
// Run: node test/changelogMedia.test.mjs

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mediaForEntry, attachMedia } from "../tools/changelogMedia.mjs";
import { parseChangelog } from "../tools/genChangelog.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CAP = 8; // the montage cap; every entry stays at or under this

let passed = 0;
const eq = (name, actual, expected) => {
  assert.deepEqual(actual, expected, `${name}: got ${JSON.stringify(actual)}`);
  passed++;
  process.stdout.write(`  PASS ${name}\n`);
};
const ok = (name, cond, detail = "") => {
  assert.ok(cond, `${name}${detail ? " — " + detail : ""}`);
  passed++;
  process.stdout.write(`  PASS ${name}\n`);
};

// 1. Representative keyword mappings ----------------------------------------------------
eq("wave C guns -> the four named weapon sprites",
  mediaForEntry({ title: "Wave C gun art (pickup + held)", body: "Hushiron, Backtalk, Lamplighter, and Faultlink now have real floor-pickup sprites." }),
  ["/sprites/weapon_hushiron.png", "/sprites/weapon_backtalk.png", "/sprites/weapon_lamplighter.png", "/sprites/weapon_faultlink.png"]);

eq("rescue pets -> the four companion sprites",
  mediaForEntry({ title: "Rescue pets now read as real animals", body: "Wick (moth), Pebble (toad), Clatter (hermit crab), and Nullfin (fish)." }),
  ["/sprites/pets/wick.png", "/sprites/pets/pebble.png", "/sprites/pets/clatter.png", "/sprites/pets/nullfin.png"]);

eq("the F50 GORGE -> its three shell layers (no F75 pale bleed-through)",
  mediaForEntry({ title: "The F50 GIANT has arrived — the GORGE", body: "the template for the giants waiting at F75 and F100." }),
  ["/sprites/gorge_shell_core.png", "/sprites/gorge_shell_rind.png", "/sprites/gorge_shell_chitin.png"]);

eq("the cosmetics montage -> curated 4 hats + 4 faces (guns/bosses named in prose excluded)",
  mediaForEntry({ title: "More hats + more face items", body: "8 new hats — Corked Cap, Lamplighter's Brim ... plus 6 new face items — Amber Specs ... and Choir Veil." }),
  ["/sprites/cosmetics/hat_cork_side.png", "/sprites/cosmetics/hat_lamp_brim_side.png", "/sprites/cosmetics/hat_root_side.png", "/sprites/cosmetics/hat_ember_visor_side.png",
   "/sprites/cosmetics/face_amber_specs_side.png", "/sprites/cosmetics/face_coal_smudge_side.png", "/sprites/cosmetics/face_shale_goggles_side.png", "/sprites/cosmetics/face_choir_veil_side.png"]);

eq("a plain enemy mention never pulls the pet slime",
  mediaForEntry({ body: "Difficulty reset: tougher Slime King, threat-budgeted floors." }),
  []);

eq("a purely textual entry stays image-free",
  mediaForEntry({ title: "Audio settings", body: "master / music / SFX volume sliders." }),
  []);

// 2. Every path the real CHANGELOG resolves to must exist under public/ -----------------
const md = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
const sections = attachMedia(parseChangelog(md));
const all = new Set();
let matched = 0;
for (const s of sections) {
  for (const e of s.entries) {
    const media = e.media ?? [];
    ok(`"${(e.title ?? e.body).slice(0, 40)}" stays within the cap`, media.length <= CAP, `len=${media.length}`);
    ok(`"${(e.title ?? e.body).slice(0, 40)}" has no duplicate paths`, new Set(media).size === media.length);
    if (media.length) matched++;
    for (const p of media) all.add(p);
  }
}
for (const p of all) {
  ok(`shipped: ${p}`, existsSync(join(ROOT, "public", p.replace(/^\//, ""))));
}

ok("the map actually matched a healthy number of entries", matched >= 20, `matched=${matched}`);
ok("resolved a broad set of real sprites", all.size >= 30, `unique=${all.size}`);

process.stdout.write(`\n${passed} checks passed (${matched} entries matched, ${all.size} unique sprites)\n`);
