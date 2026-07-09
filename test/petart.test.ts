// Pet art integration contract suite (src/game/petArt.ts) — the hooks the AD's
// FAL-generated strips drop into. Locks: the exact 18 canonical filenames, the per-pet
// role-action names (burn/collect/mark), Facing4-as-3-facings+mirror derivation with its
// deadzone, the enemy-style fallback ladder ({clip}_{facing} -> walk_{facing} ->
// walk_down), the frame0-idle rule, and the registry key format — so the approved art
// copies straight in with zero code changes and zero filename guesswork.
//
// Run: npm run test:petart

import {
  PET_ACTION, PET_FACINGS, PET_FACING_DEADZONE,
  petFacingFrom, petSheetKey, petSheetFile, petSheetCandidates, petFrame, petCanonicalFiles,
} from "../src/game/petArt.js";
import { PET_KINDS } from "../src/sim/pets.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

section("role actions: one per pet, exactly as the AD authored them");
check("ember pup acts with BURN", PET_ACTION.ember_pup === "burn");
check("lantern wisp acts with COLLECT", PET_ACTION.lantern_wisp === "collect");
check("bonebird acts with MARK", PET_ACTION.bonebird === "mark");

section("canonical filenames: the exact 18 strips the AD ships");
const EXPECTED = [
  "/sprites/pet_ember_pup_walk_down.png", "/sprites/pet_ember_pup_walk_up.png", "/sprites/pet_ember_pup_walk_side.png",
  "/sprites/pet_ember_pup_burn_down.png", "/sprites/pet_ember_pup_burn_up.png", "/sprites/pet_ember_pup_burn_side.png",
  "/sprites/pet_lantern_wisp_walk_down.png", "/sprites/pet_lantern_wisp_walk_up.png", "/sprites/pet_lantern_wisp_walk_side.png",
  "/sprites/pet_lantern_wisp_collect_down.png", "/sprites/pet_lantern_wisp_collect_up.png", "/sprites/pet_lantern_wisp_collect_side.png",
  "/sprites/pet_bonebird_walk_down.png", "/sprites/pet_bonebird_walk_up.png", "/sprites/pet_bonebird_walk_side.png",
  "/sprites/pet_bonebird_mark_down.png", "/sprites/pet_bonebird_mark_up.png", "/sprites/pet_bonebird_mark_side.png",
];
const files = petCanonicalFiles();
check("exactly 18 files (3 pets × 2 clips × 3 facings)", files.length === 18, `got ${files.length}`);
check("every canonical filename matches byte-for-byte",
  EXPECTED.every((f) => files.includes(f)) && files.every((f) => EXPECTED.includes(f)),
  files.filter((f) => !EXPECTED.includes(f)).join(",") || "exact");
check("filename builder agrees with the enumeration",
  petSheetFile("ember_pup", "burn", "side") === "/sprites/pet_ember_pup_burn_side.png"
  && petSheetFile("lantern_wisp", "collect", "up") === "/sprites/pet_lantern_wisp_collect_up.png"
  && petSheetFile("bonebird", "walk", "down") === "/sprites/pet_bonebird_walk_down.png");
check("registry keys pair kind with clip_facing",
  petSheetKey("bonebird", "mark", "side") === "bonebird.mark_side"
  && petSheetKey("ember_pup", "walk", "up") === "ember_pup.walk_up");

section("facing derivation: dominant axis, side mirrors for left, deadzone holds");
const start = { facing: "down" as const, mirror: false };
check("rightward motion -> side, unmirrored", (() => {
  const f = petFacingFrom(3, 0.5, start);
  return f.facing === "side" && !f.mirror;
})());
check("leftward motion -> side, MIRRORED (side art is authored facing right)", (() => {
  const f = petFacingFrom(-3, 0.5, start);
  return f.facing === "side" && f.mirror;
})());
check("downward motion -> down", petFacingFrom(0.2, 3, start).facing === "down");
check("upward motion -> up", petFacingFrom(0.2, -3, { facing: "side", mirror: true }).facing === "up");
check("up/down never mirror", !petFacingFrom(0.2, -3, { facing: "side", mirror: true }).mirror);
check("a diagonal picks the dominant axis", petFacingFrom(1, 4, start).facing === "down"
  && petFacingFrom(-4, 1, start).facing === "side");
check("an exact diagonal tie goes to side (the most-read facing)",
  petFacingFrom(2, 2, start).facing === "side");
check("sub-deadzone drift holds the previous facing (no flicker while heeling)", (() => {
  const prev = { facing: "up" as const, mirror: false };
  const eps = PET_FACING_DEADZONE * 0.6;
  const f = petFacingFrom(eps * 0.7, eps * 0.7, prev);
  return f === prev;
})());

section("fallback ladder: {clip}_{facing} -> walk_{facing} -> walk_down, deduplicated");
check("action away from down walks the full ladder", (() => {
  const c = petSheetCandidates("ember_pup", "burn", "side");
  return c.length === 3 && c[0] === "ember_pup.burn_side" && c[1] === "ember_pup.walk_side" && c[2] === "ember_pup.walk_down";
})(), petSheetCandidates("ember_pup", "burn", "side").join(" -> "));
check("action facing down skips the duplicate walk step", (() => {
  const c = petSheetCandidates("bonebird", "mark", "down");
  return c.length === 2 && c[0] === "bonebird.mark_down" && c[1] === "bonebird.walk_down";
})());
check("walk away from down falls back to the canonical walk_down", (() => {
  const c = petSheetCandidates("lantern_wisp", "walk", "up");
  return c.length === 2 && c[0] === "lantern_wisp.walk_up" && c[1] === "lantern_wisp.walk_down";
})());
check("walk_down IS the ladder's floor (a single candidate, never empty)", (() => {
  const c = petSheetCandidates("ember_pup", "walk", "down");
  return c.length === 1 && c[0] === "ember_pup.walk_down";
})());

section("frame0-idle: stationary pets hold frame 0; movers play the strip");
check("idle always resolves frame 0", petFrame(6, 10, 123.456, true) === 0 && petFrame(1, 10, 9.9, true) === 0);
check("motion advances frames", petFrame(4, 8, 0.5, false) !== 0 || petFrame(4, 8, 0.7, false) !== 0);
check("frame index stays inside the strip", (() => {
  for (let t = 0; t < 5; t += 0.13) {
    const i = petFrame(5, 12, t, false);
    if (i < 0 || i >= 5 || !Number.isInteger(i)) return false;
  }
  return true;
})());

section("contract coverage: every roster pet is fully addressable");
check("all pet kinds carry a role action", PET_KINDS.every((k) => PET_ACTION[k].length > 0));
check("all three facings are enumerated", PET_FACINGS.length === 3 && PET_FACINGS.join(",") === "down,up,side");

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
process.stdout.write("\nPet art integration contract locked (AD strips copy straight in).\n");
