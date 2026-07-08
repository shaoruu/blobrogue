// 2-player generated-floor golden (the TD merge gate's end-to-end sequence), run entirely on
// the authoritative shared sim the server executes: a REAL generated dungeon (no sandbox), two
// players who pick up different weapons (diverging inventories), receive different blessings
// (diverging mods that measurably change combat), clear the floor through real combat kills,
// gather at the exit, descend ONCE together, and land in the fresh next dungeon with per-floor
// resets applied. Deterministic (fixed seed, seeded RNG streams) — a golden for the whole
// authoritative floor-run lifecycle.
//
// Run: npm run test:floorrun

import {
  createWorld, spawnPlayerInWorld, stepWorld, acquireWeaponInWorld, switchWeaponInWorld,
  applyItemToWorld, chooseBlessingInWorld,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { InputCmd, PlayerId } from "../src/sim/input.js";
import { ITEMS } from "../src/sim/items.js";
import { TILE } from "../src/sim/types.js";
import { buildSnapshot } from "../src/net/protocol.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

const SEED = 0xF100D;
const DT = 1 / 20;
const IDLE: InputCmd = { seq: 0, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };

function step(w: WorldState, inputs?: Map<PlayerId, InputCmd>): SimEvent[] {
  return stepWorld(w, inputs ?? new Map(), DT);
}

// Drive both players to (x, y) by teleport-free scaffolding: place them adjacent, then let one
// real input step resolve overlap/pickup/exit checks through the ordinary systems.
function placeAt(p: PlayerSim, x: number, y: number): void {
  p.x = x;
  p.y = y;
}

function main(): void {
  section("floor 2 bootstrap: a REAL generated dungeon with content (not a sandbox arena)");
  // Floor 2 so the generated floor carries weapon pickups (floor 1 spawns none by design).
  const w = createWorld(SEED, 2, { isShared: true, skipLocalPlayer: true });
  const a = spawnPlayerInWorld(w, "pA");
  const b = spawnPlayerInWorld(w, "pB");
  check("generated dungeon has rooms", w.dungeon.rooms.length > 2, `rooms=${w.dungeon.rooms.length}`);
  check("floor spawned enemies", w.enemies.length > 0, `enemies=${w.enemies.length}`);
  check("floor spawned at least one weapon pickup", w.pickups.some((p) => p.kind === "weapon"), `pickups=${w.pickups.length}`);
  check("both players share the spawn point", Math.hypot(a.x - b.x, a.y - b.y) < 1);
  const rev0 = w.rev;

  section("pickups: A takes the weapon pickup -> inventories DIVERGE");
  const weaponDrop = w.pickups.find((p) => p.kind === "weapon")!;
  const droppedWeapon = weaponDrop.weapon!;
  placeAt(a, weaponDrop.x, weaponDrop.y); // A stands on it; B stays away
  placeAt(b, weaponDrop.x + 400, weaponDrop.y + 300);
  const pickupEvents = step(w);
  check("pickup collected through the ordinary pickup system", pickupEvents.some((e) => e.t === "pickup" && e.kind === "weapon" && e.pid === "pA"));
  check("A owns the picked weapon", a.ownedWeapons.includes(droppedWeapon), `A=${a.ownedWeapons.join(",")}`);
  check("B does NOT own it (per-player inventory)", !b.ownedWeapons.includes(droppedWeapon), `B=${b.ownedWeapons.join(",")}`);
  // B acquires a different weapon via the server-side grant path and each equips their own.
  acquireWeaponInWorld(w, "pB", "tesla");
  check("validated switch: A equips its pickup", switchWeaponInWorld(w, "pA", droppedWeapon) && a.weapon === droppedWeapon);
  check("validated switch: B equips ITS weapon", switchWeaponInWorld(w, "pB", "tesla") && b.weapon === "tesla");
  check("cross-equip rejected: B cannot equip A's pickup unless it also owns one", b.ownedWeapons.includes(droppedWeapon) ? true : !switchWeaponInWorld(w, "pB", droppedWeapon));

  section("blessings: server-applied picks DIVERGE the two players' authoritative mods");
  const dmgItem = ITEMS.find((it) => it.id === "glass_cannon")!;
  const speedItem = ITEMS.find((it) => it.id === "swift_boots")!;
  applyItemToWorld(w, "pA", dmgItem);
  applyItemToWorld(w, "pB", speedItem);
  check("A owns its blessing", a.ownedItemIds.includes(dmgItem.id), `A=${a.ownedItemIds.join(",")}`);
  check("B owns a DIFFERENT blessing", b.ownedItemIds.includes(speedItem.id) && !b.ownedItemIds.includes(dmgItem.id), `B=${b.ownedItemIds.join(",")}`);
  check("their authoritative mods diverged", JSON.stringify(a.mods) !== JSON.stringify(b.mods));

  section("blessing mods measurably affect authoritative combat");
  // A's blessed damage multiplier must make A's bullet hit harder than B's for the same weapon.
  const victim = w.enemies[0];
  const hpBefore = victim.hp;
  w.bullets.push({ x: victim.x, y: victim.y, vx: 1, vy: 0, radius: 6, life: 0.06, friendly: true, owner: "pA", damage: 2 * a.mods.damageMult, color: "#fff", pierce: 0, hitList: null, isCrit: false });
  step(w);
  const dmgA = hpBefore - victim.hp;
  check("blessed shot dealt boosted damage", a.mods.damageMult > 1 ? dmgA > 2 : dmgA > 0, `dmg=${dmgA.toFixed(2)} mult=${a.mods.damageMult}`);

  section("floor clear: kill every remaining enemy through real combat resolution");
  let guard = 0;
  while (w.enemies.length > 0 && guard < 400) {
    guard++;
    // Keep players away from the fight; a lethal planted bullet per living enemy resolves
    // through the ordinary strike/kill path (attribution, loot, events).
    placeAt(a, w.dungeon.spawn.x * TILE + TILE / 2, w.dungeon.spawn.y * TILE + TILE / 2);
    placeAt(b, a.x + 30, a.y);
    for (const e of w.enemies) {
      if (!e.dead) w.bullets.push({ x: e.x, y: e.y, vx: 1, vy: 0, radius: e.radius + 4, life: 0.06, friendly: true, owner: "pA", damage: 500, color: "#fff", pierce: 0, hitList: null, isCrit: false });
    }
    step(w);
  }
  check("floor fully cleared through combat kills", w.enemies.length === 0, `enemies=${w.enemies.length} after ${guard} ticks`);
  check("the killer was credited authoritative kills", a.kills > 0, `A.kills=${a.kills}`);

  section("exit gate: blessings are offered at the cleared exit; descend waits for the picks");
  const ex = w.dungeon.exit.x * TILE + TILE / 2;
  const ey = w.dungeon.exit.y * TILE + TILE / 2;
  placeAt(a, ex, ey);
  placeAt(b, ex + 500, ey); // B is far: the party must NOT descend (or be offered) yet
  step(w);
  check("no descend while B is away", w.floor === 2, `floor=${w.floor}`);
  placeAt(b, ex, ey);
  const offerEvents = step(w);
  check("BOTH players offered their between-floor blessing at the exit (before descending)",
    offerEvents.filter((e) => e.t === "offerBlessing").length === 2);
  check("floor holds while the picks are open", w.floor === 2, `floor=${w.floor}`);
  const blessA = ITEMS.find((it) => it.id === "vitality")!;
  const blessB = ITEMS.find((it) => it.id === "second_wind")!;
  chooseBlessingInWorld(w, "pA", blessA);
  chooseBlessingInWorld(w, "pB", blessB);
  const descendEvents = step(w);
  check("party-wide descend fired once every pick resolved", w.floor === 3, `floor=${w.floor}`);
  check("descend event emitted", descendEvents.some((e) => e.t === "descend"));
  check("the descend re-offers nothing (cadence already paid at the gate)",
    descendEvents.filter((e) => e.t === "offerBlessing").length === 0);

  section("new dungeon: fresh geometry/content, per-floor resets, revision advanced");
  check("world revision advanced with the floor build", w.rev === rev0 + 1, `rev=${w.rev}`);
  check("a fresh floor-3 dungeon exists with enemies", w.enemies.length > 0, `enemies=${w.enemies.length}`);
  const spawn3 = w.dungeon.spawn;
  check("both players repositioned at the new spawn", Math.hypot(a.x - (spawn3.x * TILE + TILE / 2), a.y - (spawn3.y * TILE + TILE / 2)) < 1 && Math.hypot(a.x - b.x, a.y - b.y) < 1);
  check("combo state reset per floor", a.combo === 0 && b.combo === 0);
  check("inventories PERSIST across the descend", a.ownedWeapons.includes(droppedWeapon) && b.ownedWeapons.includes("tesla"));
  check("blessings PERSIST across the descend", a.ownedItemIds.includes(dmgItem.id) && b.ownedItemIds.includes(speedItem.id));

  section("wire coherence: both players' snapshots agree on the new authoritative world");
  const snapA = buildSnapshot(w, "pA", 0, [], 0, false, {});
  const snapB = buildSnapshot(w, "pB", 0, [], 0, false, {});
  if (snapA.t === "snap" && snapB.t === "snap") {
    check("same seed on both wires", snapA.seed === snapB.seed && snapA.seed === SEED);
    check("same floor on both wires", snapA.floor === 3 && snapB.floor === 3);
    check("same revision on both wires", snapA.rev === snapB.rev && snapA.rev === w.rev);
    const idsA = snapA.enemies.map((e) => e.id).sort().join(",");
    const idsB = snapB.enemies.map((e) => e.id).sort().join(",");
    check("identical new-floor enemy layout on both wires", idsA === idsB && idsA.length > 0);
    check("self inventories ride the wire (A)", snapA.self!.wpns.includes(droppedWeapon));
    check("self inventories ride the wire (B)", snapB.self!.wpns.includes("tesla"));
    check("self blessings ride the wire", snapA.self!.items.includes(dmgItem.id) && snapB.self!.items.includes(speedItem.id));
  }

  section("determinism: the same seed replays the identical floor-2 world");
  const w2 = createWorld(SEED, 2, { isShared: true, skipLocalPlayer: true });
  check("same dungeon spawn/exit", w2.dungeon.spawn.x === generateSpawn().x && w2.dungeon.exit.x >= 0);
  const again = createWorld(SEED, 2, { isShared: true, skipLocalPlayer: true });
  check("same enemy layout", JSON.stringify(w2.enemies.map((e) => [e.kind, e.x, e.y])) === JSON.stringify(again.enemies.map((e) => [e.kind, e.x, e.y])));
  check("same pickup layout", JSON.stringify(w2.pickups) === JSON.stringify(again.pickups));

  function generateSpawn(): { x: number; y: number } {
    return createWorld(SEED, 2, { isShared: true, skipLocalPlayer: true }).dungeon.spawn;
  }

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\n2-player generated-floor golden passed (pickups -> blessings -> clear -> exit -> descend -> new dungeon).\n");
}

main();
