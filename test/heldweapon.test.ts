// Held-weapon overlay regression (playtest bug: hotbar slot said SUNLANCE while the hero
// held purple Umbra art). Two contracts, both driven against the REAL renderer + REAL art:
//
//   1. RENDER PATH: whatever weapon is equipped, the held overlay is sourced from THAT
//      weapon id every frame — never a stale previously-equipped id. Equip each of a set
//      of weapons in turn and assert the render frame requests heldWeapon(equippedId).
//   2. ART IDENTITY: a weapon's held sprite must read as the SAME weapon as its hotbar
//      icon. Sunlance's held art must share its pickup icon's color family, not collide
//      with Umbra's (the exact #77 re-snap regression that turned held_beam2_px purple).
//
// Run: npm run test:heldweapon

import { bootGame, loadDeterministicFloor, settleAt, ROOT } from "./harness/raster.js";
import type { HarnessGame } from "./harness/raster.js";
import { heldWeaponSrc, weaponIconSrc } from "../src/game/assets.js";
import type { Sprites } from "../src/game/assets.js";
import type { WeaponId } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import { createCanvas, loadImage } from "canvas";
import { join } from "node:path";

const VIEW_W = 1280;
const VIEW_H = 720;
const SEED = 0x11c817;

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void { process.stdout.write(`\n[${name}]\n`); }

// The dev hooks this rig reaches past the shared HarnessGame surface.
interface WeaponHarness extends HarnessGame {
  devSprites(): Sprites;
  devSnapshot(): { weapon: WeaponId };
}

// Brightness-independent color of a sprite's opaque pixels (chromaticity: each channel over
// the RGB sum). Two artworks of the same weapon share a chromaticity; a purple-vs-silver
// swap does not — which is exactly what this metric must catch.
async function meanChroma(publicPath: string): Promise<[number, number, number]> {
  const img = await loadImage(join(ROOT, "public", publicPath));
  const c = createCanvas(img.width, img.height);
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0);
  const { data } = g.getImageData(0, 0, img.width, img.height);
  let r = 0, gr = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue; // ignore transparent + soft edges
    r += data[i]; gr += data[i + 1]; b += data[i + 2]; n++;
  }
  if (n === 0) return [1 / 3, 1 / 3, 1 / 3];
  const sum = r + gr + b || 1;
  return [r / sum, gr / sum, b / sum];
}
function chromaDist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

async function renderPathTests(): Promise<void> {
  section("render path: the held overlay always sources the EQUIPPED weapon (never a stale id)");
  const { game } = await bootGame(VIEW_W, VIEW_H);
  const harness = game as WeaponHarness;
  harness.devStartSandbox();
  loadDeterministicFloor(harness, SEED, 1);
  const spawn = harness.devWorld().dungeon.spawn;
  settleAt(harness, (spawn.x + 0.5) * TILE, (spawn.y + 0.5) * TILE, VIEW_W, VIEW_H);

  // Record every held-sprite lookup a rendered frame makes. Solo sandbox has no remotes,
  // so the only requester is the local hero's held-weapon draw.
  const sprites = harness.devSprites();
  const requested: WeaponId[] = [];
  const origHeld = sprites.heldWeapon.bind(sprites);
  sprites.heldWeapon = (id: WeaponId) => { requested.push(id); return origHeld(id); };

  // A ranged bug-report weapon (beam = Sunlance), its color collision (phase = Umbra), a
  // second ranged id, and a melee (melee draws through renderHeldMelee -> heldWeapon too).
  const order: WeaponId[] = ["beam", "phase", "tesla", "sword", "beam"];
  for (const id of order) {
    harness.devGiveWeapon(id); // acquires AND equips, so this is now the hotbar current
    check(`equipping ${id} makes it the hotbar current`, harness.devSnapshot().weapon === id);
    requested.length = 0;
    harness.render();
    check(`the held overlay requests the equipped id (${id}), not a stale one`,
      requested.includes(id), `requested=[${requested.join(",")}]`);
  }
  harness.stop();
}

async function artIdentityTests(): Promise<void> {
  section("art identity: Sunlance's held art matches its hotbar icon, not Umbra");
  const beamHeldSrc = heldWeaponSrc("beam");
  const beamIconSrc = weaponIconSrc("beam");
  const umbraHeldSrc = heldWeaponSrc("phase");
  if (!beamHeldSrc || !beamIconSrc || !umbraHeldSrc) {
    check("Sunlance + Umbra art hooks are registered", false,
      `beamHeld=${beamHeldSrc} beamIcon=${beamIconSrc} umbraHeld=${umbraHeldSrc}`);
    return;
  }
  const beamHeld = await meanChroma(beamHeldSrc);
  const beamIcon = await meanChroma(beamIconSrc);
  const umbraHeld = await meanChroma(umbraHeldSrc);
  const dSelf = chromaDist(beamHeld, beamIcon);
  const dUmbra = chromaDist(beamHeld, umbraHeld);
  check("the held Sunlance reads as its own hotbar weapon, not Umbra",
    dSelf < dUmbra, `dist(held,icon)=${dSelf.toFixed(3)} < dist(held,umbra)=${dUmbra.toFixed(3)}`);
}

async function main(): Promise<void> {
  await renderPathTests();
  await artIdentityTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll held-weapon assertions passed.\n");
}

main();
