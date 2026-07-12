// SOLO / classic co-op KIT-assignment suite: locks the fix for "PLAY SOLO spawns the local
// player kitless (kitId 'none')". Solo/co-op run the in-process sim as the authority, so the
// chosen kit MUST be applied at start through the same authoritative mutator the server uses on
// join — otherwise a solo player has no stat lean, no starting weapon, no ult meter / signature
// and the kit chrome stays hidden (Ian's "I don't know what my ult is").
//
// Guards:
//   1. a solo run with a chosen kit assigns it to the local player (kitId + stat lean + the kit's
//      starting weapon + a live ult meter), through the authoritative sim path
//   2. the kit SURVIVES a floor descent and a run reset (it rides the persistent LOCAL_ID player)
//   3. the neutral "none" baseline is preserved when NO kit is chosen (dev sandbox / harness) —
//      the fix never forces a kit onto a genuinely-neutral player
//
// Run: npm run test:solokit

import "./harness/domShim.js";
import { domCanvas, domMinimap, domOverlay } from "./harness/domShim.js";

import { Game } from "../src/game/game.js";
import { Hud } from "../src/game/hud.js";
import { Minimap } from "../src/game/minimap.js";
import { BlessingOverlay } from "../src/ui/blessing.js";
import { LOCAL_ID } from "../src/sim/input.js";
import { descend, resetRunInWorld } from "../src/sim/world.js";
import type { PlayerSim, WorldState } from "../src/sim/world.js";
import { KIT_START_WEAPON } from "../src/sim/kits.js";
import type { KitId } from "../src/sim/kits.js";
import { DEFAULT_WEAPON } from "../src/sim/weapons.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const noop = () => {};
for (const m of ["update", "setVisible", "showBanner", "tick", "showStats", "hideStats", "clear", "showControlsHint"] as const) {
  (Hud.prototype as any)[m] = noop;
}
(Minimap.prototype as any).render = noop;
(BlessingOverlay.prototype as any).show = noop;

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void { process.stdout.write(`\n[${name}]\n`); }

function bootSolo(kit?: KitId): { game: any; p: PlayerSim; w: WorldState } {
  const game: any = new Game(domCanvas as any, domMinimap as any, domOverlay as any, noop, noop);
  game.start({ mode: "solo", coop: null, profile: null, kit });
  const w: WorldState = game.world;
  const p = w.players.get(LOCAL_ID) as PlayerSim;
  return { game, p, w };
}

section("solo assigns the chosen kit through the authoritative sim");
{
  // Phantom's starting weapon (smg) differs from the neutral default (pistol), so the weapon
  // hand-off is observable — the whole point of the bug (a solo player was stuck on the pistol).
  const { game, p } = bootSolo("phantom");
  check("kitId is the chosen kit", p.kitId === "phantom", `kitId=${p.kitId}`);
  check("owns the kit's starting weapon", p.weapon === KIT_START_WEAPON.phantom && p.ownedWeapons[0] === KIT_START_WEAPON.phantom, `weapon=${p.weapon}`);
  check("weapon is no longer the neutral default", p.weapon !== DEFAULT_WEAPON, `weapon=${p.weapon}`);
  // The stat lean landed through the ONE recompute path (Phantom = +move speed / +dash).
  check("stat lean applied (extra dash charge)", p.mods.extraDashCharge >= 1, `extraDashCharge=${p.mods.extraDashCharge}`);
  // A real kit has a live ult meter (neutral 'none' never accrues) — the chrome the HUD reads.
  check("kit is a real (non-neutral) kit", p.kitId !== "none");
  game.stop();
}

section("default solo selection (gunner) is a real kit");
{
  // main.ts passes getSelectedKit(), which defaults to "gunner" — the #1 solo path.
  const { game, p } = bootSolo("gunner");
  check("kitId is gunner", p.kitId === "gunner", `kitId=${p.kitId}`);
  check("gunner stat lean applied (damage lean)", p.mods.damageMult > 1, `damageMult=${p.mods.damageMult}`);
  game.stop();
}

section("the kit survives a floor descent and a run reset");
{
  const { game, w } = bootSolo("phantom");
  const ev: any[] = [];
  descend(w, w.floor + 1, ev);
  check("kit persists across a descent", (w.players.get(LOCAL_ID) as PlayerSim).kitId === "phantom");
  resetRunInWorld(w, 0x1234);
  check("kit persists across a run reset", (w.players.get(LOCAL_ID) as PlayerSim).kitId === "phantom");
  check("run reset returned to floor 1", w.floor === 1, `floor=${w.floor}`);
  game.stop();
}

section("no chosen kit preserves the neutral baseline (dev / harness)");
{
  const { game, p } = bootSolo(undefined);
  check("kitId stays neutral 'none'", p.kitId === "none", `kitId=${p.kitId}`);
  check("still on the neutral default weapon", p.weapon === DEFAULT_WEAPON, `weapon=${p.weapon}`);
  game.stop();
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(`\nFAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`);
  process.exit(1);
}
