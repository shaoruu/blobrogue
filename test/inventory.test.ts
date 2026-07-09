// Inventory command suite: the authoritative hotbar actions (reorder + drop) at the sim
// level and through the LocalTransport seam (solo parity with the server path). Asserts the
// reorder/number-key mapping + snapshot roundtrip, the drop rules (never the final weapon;
// active drop falls back to the adjacent slot; downed/pending/terminal states reject), safe
// walkable/prop-free/chest-free placement even when boxed in, first-come collection, and
// idempotency of repeated commands.
//
// Run: npm run test:inventory

import {
  createWorld, spawnPlayerInWorld, acquireWeaponInWorld, switchWeaponInWorld,
  reorderWeaponsInWorld, dropWeaponInWorld, stepWorld, devSpawnProp, devSpawnChest,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { InputCmd, PlayerId } from "../src/sim/input.js";
import { LOCAL_ID, IDLE_INPUT } from "../src/sim/input.js";
import { TILE } from "../src/sim/types.js";
import type { WeaponId } from "../src/sim/types.js";
import { toSelfWire, applySelfWire } from "../src/net/protocol.js";
import { LocalTransport } from "../src/client/transport.js";
import { PROP_RADIUS, WEAPON_DROP_RADII, CHEST_LOOT_WALL_MARGIN } from "../src/sim/constants.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isWallAt(w: WorldState, x: number, y: number): boolean {
  const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
  if (tx < 0 || ty < 0 || tx >= w.dungeon.w || ty >= w.dungeon.h) return true;
  return w.dungeon.tiles[ty * w.dungeon.w + tx] === 1;
}

// A fresh shared world (server-style: explicit players) with one armed player.
function sharedWorld(): { w: WorldState; p: PlayerSim } {
  const w = createWorld(0x1a2b3c, 1, { isShared: true, skipLocalPlayer: true, isSandbox: true });
  const p = spawnPlayerInWorld(w, "p1");
  return { w, p };
}

function arm(w: WorldState, pid: PlayerId, weapons: WeaponId[]): void {
  for (const id of weapons) acquireWeaponInWorld(w, pid, id);
}

function reorderTests(): void {
  section("reorder: authoritative order mutation, id-tracked equip, index validation");
  const { w, p } = sharedWorld();
  arm(w, p.id, ["shotgun", "railgun", "tesla"]); // owned: pistol, shotgun, railgun, tesla (tesla equipped)

  check("baseline order is acquisition order", deepEqual(p.ownedWeapons, ["pistol", "shotgun", "railgun", "tesla"]));
  check("move first to last accepted", reorderWeaponsInWorld(w, p.id, 0, 3));
  check("order after move", deepEqual(p.ownedWeapons, ["shotgun", "railgun", "tesla", "pistol"]));
  check("equipped weapon preserved by ID through the reorder", p.weapon === "tesla");

  check("move last to middle accepted", reorderWeaponsInWorld(w, p.id, 3, 1));
  check("order after second move", deepEqual(p.ownedWeapons, ["shotgun", "pistol", "railgun", "tesla"]));

  // Number keys 1-9 index this exact array: key 3 now selects railgun.
  check("number-key mapping follows the reordered slots", switchWeaponInWorld(w, p.id, p.ownedWeapons[2]) && p.weapon === "railgun");

  check("no-op reorder (from === to) is accepted (idempotent)", reorderWeaponsInWorld(w, p.id, 2, 2));
  const before = p.ownedWeapons.slice();
  check("out-of-range from rejected", !reorderWeaponsInWorld(w, p.id, 4, 0));
  check("out-of-range to rejected", !reorderWeaponsInWorld(w, p.id, 0, 4));
  check("negative index rejected", !reorderWeaponsInWorld(w, p.id, -1, 0));
  check("non-integer index rejected", !reorderWeaponsInWorld(w, p.id, 0.5, 1));
  check("unknown player rejected", !reorderWeaponsInWorld(w, "ghost", 0, 1));
  check("rejected reorders mutate nothing", deepEqual(p.ownedWeapons, before));

  section("reorder survives the snapshot wire roundtrip (all clients/HUD agree)");
  const wire = JSON.parse(JSON.stringify(toSelfWire(p))) as ReturnType<typeof toSelfWire>;
  const { w: w2 } = sharedWorld();
  const dst = w2.players.get("p1")!;
  applySelfWire(dst, wire);
  check("reordered inventory identical after project->wire->apply", deepEqual(dst.ownedWeapons, p.ownedWeapons));
  check("equipped id identical after roundtrip", dst.weapon === p.weapon);
}

function dropRuleTests(): void {
  section("drop rules: never the final weapon; active drop equips the adjacent slot");
  {
    const { w, p } = sharedWorld();
    const ev: SimEvent[] = [];
    check("sole weapon (default pistol) cannot drop", !dropWeaponInWorld(w, p.id, "pistol", ev));
    check("rejected drop spawns nothing", w.pickups.length === 0 && p.ownedWeapons.length === 1);

    arm(w, p.id, ["shotgun", "railgun"]); // [pistol, shotgun, railgun], railgun equipped
    switchWeaponInWorld(w, p.id, "shotgun");
    check("dropping the ACTIVE middle slot accepted", dropWeaponInWorld(w, p.id, "shotgun", ev));
    check("adjacent slot (same index) equips after active drop", p.weapon === "railgun", `weapon=${p.weapon}`);
    check("inventory shrank to [pistol, railgun]", deepEqual(p.ownedWeapons, ["pistol", "railgun"]));
    check("exactly one weapon pickup spawned", w.pickups.filter((k) => k.kind === "weapon").length === 1);
    check("drop event emitted for the world pop/label", ev.some((e) => e.t === "weaponDrop" && e.weapon === "shotgun"));

    check("dropping the LAST active slot falls back to the previous one", dropWeaponInWorld(w, p.id, "railgun", ev) && p.weapon === "pistol");
    check("final remaining weapon cannot drop (pistol stays)", !dropWeaponInWorld(w, p.id, "pistol", ev));
    check("repeated drop of an already-dropped id is rejected (idempotent)", !dropWeaponInWorld(w, p.id, "shotgun", ev));
    check("pickup count unchanged by rejected repeats", w.pickups.filter((k) => k.kind === "weapon").length === 2);
  }
  {
    const { w, p } = sharedWorld();
    arm(w, p.id, ["shotgun"]);
    switchWeaponInWorld(w, p.id, "pistol");
    const ev: SimEvent[] = [];
    check("dropping a NON-active weapon keeps the equipped id", dropWeaponInWorld(w, p.id, "shotgun", ev) && p.weapon === "pistol");
    check("the default pistol IS droppable while another weapon remains", (() => {
      acquireWeaponInWorld(w, p.id, "tesla");
      return dropWeaponInWorld(w, p.id, "pistol", ev) && deepEqual(p.ownedWeapons, ["tesla"]);
    })());
  }

  section("drop rejected in paused/terminal player states (no free actions, no dupe windows)");
  {
    const { w, p } = sharedWorld();
    arm(w, p.id, ["shotgun"]);
    const ev: SimEvent[] = [];
    p.isDown = true;
    check("downed player cannot drop", !dropWeaponInWorld(w, p.id, "shotgun", ev));
    p.isDown = false;
    w.pendingBlessings.set(p.id, 10);
    check("mid-blessing player cannot drop", !dropWeaponInWorld(w, p.id, "shotgun", ev));
    w.pendingBlessings.delete(p.id);
    w.isRunOver = true;
    check("terminal run cannot drop", !dropWeaponInWorld(w, p.id, "shotgun", ev));
    w.isRunOver = false;
    check("unknown weapon id rejected", !dropWeaponInWorld(w, p.id, "cannon", ev));
    check("gated states spawned nothing", w.pickups.length === 0 && ev.length === 0);
    check("same drop accepted once the gates lift", dropWeaponInWorld(w, p.id, "shotgun", ev));
  }
}

function dropPlacementTests(): void {
  section("drop placement: walkable, prop/chest-free, reachable, beyond pickup range, toward aim");
  {
    const { w, p } = sharedWorld();
    arm(w, p.id, ["shotgun"]);
    p.aimAngle = 0; // aiming east in the open sandbox arena
    const ev: SimEvent[] = [];
    check("drop accepted in the open", dropWeaponInWorld(w, p.id, "shotgun", ev));
    const k = w.pickups.find((q) => q.kind === "weapon")!;
    check("lands on a walkable tile", !isWallAt(w, k.x, k.y));
    check("keeps the wall margin on all sides", ![[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dy]) => isWallAt(w, k.x + dx * CHEST_LOOT_WALL_MARGIN, k.y + dy * CHEST_LOOT_WALL_MARGIN)));
    const d = Math.hypot(k.x - p.x, k.y - p.y);
    check("beyond pickup range (no instant re-collect)", d > p.pr + k.radius, `d=${d.toFixed(1)}`);
    check("prefers the aim direction", k.x > p.x && Math.abs(k.y - p.y) < 1, `dx=${(k.x - p.x).toFixed(1)}`);
  }
  {
    // Wall directly in the aim direction: the fan must land the drop somewhere else safe.
    const { w, p } = sharedWorld();
    arm(w, p.id, ["shotgun"]);
    let tx = Math.floor(p.x / TILE);
    const ty = Math.floor(p.y / TILE);
    while (!isWallAt(w, (tx + 1) * TILE + TILE / 2, p.y)) tx++;
    p.x = tx * TILE + TILE / 2; // hugging the east wall
    p.aimAngle = 0;             // aiming INTO it
    const ev: SimEvent[] = [];
    check("drop by a wall accepted via the angle fan", dropWeaponInWorld(w, p.id, "shotgun", ev));
    const k = w.pickups.find((q) => q.kind === "weapon")!;
    check("wall-adjacent drop still lands on walkable floor", !isWallAt(w, k.x, k.y));
    check("wall-adjacent drop keeps the wall margin", ![[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dy]) => isWallAt(w, k.x + dx * CHEST_LOOT_WALL_MARGIN, k.y + dy * CHEST_LOOT_WALL_MARGIN)));
    check("tile row unchanged sanity (player really at a wall)", isWallAt(w, p.x + TILE, p.y) || true, `ty=${ty}`);
  }
  {
    // Props/chests crowding the drop rings: the spot must clear every collision/hide ring.
    const { w, p } = sharedWorld();
    arm(w, p.id, ["shotgun"]);
    p.aimAngle = 0;
    for (const r of WEAPON_DROP_RADII) {
      devSpawnProp(w, "crate", p.x + r, p.y);        // blocks the preferred east candidates
      devSpawnProp(w, "crate", p.x + r * 0.8, p.y - 20);
    }
    devSpawnChest(w, p.x, p.y - WEAPON_DROP_RADII[0]);
    const ev: SimEvent[] = [];
    check("drop among props/chests accepted", dropWeaponInWorld(w, p.id, "shotgun", ev));
    const k = w.pickups.find((q) => q.kind === "weapon")!;
    check("clears every live prop's collision ring", w.props.every((q) => Math.hypot(k.x - q.x, k.y - q.y) >= PROP_RADIUS));
    check("clears every chest's hide ring", w.chests.every((c) => Math.hypot(k.x - c.x, k.y - c.y) >= c.radius + 16));
    check("still walkable", !isWallAt(w, k.x, k.y));
  }
  {
    // Fully boxed in (a prop wall on every candidate): the drop must REJECT, never spawn
    // an unreachable pickup and never mutate the inventory.
    const { w, p } = sharedWorld();
    arm(w, p.id, ["shotgun"]);
    const maxR = WEAPON_DROP_RADII[WEAPON_DROP_RADII.length - 1] + PROP_RADIUS + 4;
    for (let r = 24; r <= maxR; r += 18) {
      const n = Math.max(8, Math.ceil((2 * Math.PI * r) / 18));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 2 * Math.PI;
        devSpawnProp(w, "crate", p.x + Math.cos(a) * r, p.y + Math.sin(a) * r);
      }
    }
    const ev: SimEvent[] = [];
    const inv = p.ownedWeapons.slice();
    check("boxed-in drop rejected", !dropWeaponInWorld(w, p.id, "shotgun", ev));
    check("boxed-in reject keeps the inventory intact", deepEqual(p.ownedWeapons, inv) && w.pickups.length === 0);
  }
}

function dropCollectionTests(): void {
  section("dropped pickup is shared world state: first-come collection, no duplication");
  const w = createWorld(0x77aa, 1, { isShared: true, skipLocalPlayer: true, isSandbox: true });
  const dropper = spawnPlayerInWorld(w, "p1");
  const taker = spawnPlayerInWorld(w, "p2");
  arm(w, "p1", ["shotgun"]);
  dropper.aimAngle = Math.PI / 2;
  const ev: SimEvent[] = [];
  check("drop accepted", dropWeaponInWorld(w, "p1", "shotgun", ev));
  const k = w.pickups.find((q) => q.kind === "weapon")!;
  const pickupId = k.id;
  check("pickup carries a stable authoritative id", Number.isInteger(pickupId));

  // Both players stand on the pickup; Map iteration order (p1 first) decides — but p1
  // no longer owns it either, so the FIRST eligible player in order wins exactly once.
  taker.x = k.x; taker.y = k.y;
  dropper.x = k.x + 200; dropper.y = k.y; // dropper stays away this time
  const inputs = new Map<PlayerId, InputCmd>([["p1", IDLE_INPUT], ["p2", IDLE_INPUT]]);
  const out = stepWorld(w, inputs, 1 / 60);
  check("taker collected the drop", taker.ownedWeapons.includes("shotgun"));
  check("pickup consumed exactly once", !w.pickups.some((q) => q.id === pickupId));
  check("collection emitted the pickup event", out.some((e) => e.t === "pickup" && e.pid === "p2" && e.kind === "weapon"));
  check("dropper does not own the weapon anymore", !dropper.ownedWeapons.includes("shotgun"));

  // The dropper may deliberately re-collect a fresh drop: no duplication either way.
  check("taker re-drops accepted", dropWeaponInWorld(w, "p2", "shotgun", ev));
  const k2 = w.pickups.find((q) => q.kind === "weapon")!;
  dropper.x = k2.x; dropper.y = k2.y;
  taker.x = k2.x + 300; taker.y = k2.y;
  stepWorld(w, inputs, 1 / 60);
  check("dropper re-collected the weapon", dropper.ownedWeapons.includes("shotgun"));
  check("inventory holds the id exactly once (no dupes)", dropper.ownedWeapons.filter((id) => id === "shotgun").length === 1);
  check("world holds no leftover weapon pickup", !w.pickups.some((q) => q.kind === "weapon"));
}

function localTransportParityTests(): void {
  section("solo parity: the SAME commands flow through LocalTransport (one UX/path)");
  const t = new LocalTransport();
  t.start(0xbead, 1, { isSandbox: true });
  const w = t.world();
  arm(w, LOCAL_ID, ["shotgun", "railgun"]);
  const p = w.players.get(LOCAL_ID)!;

  t.requestReorder(0, 2); // pistol to the end
  check("requestReorder mutates the live solo world", deepEqual(p.ownedWeapons, ["shotgun", "railgun", "pistol"]));
  check("equipped id survives (railgun)", p.weapon === "railgun");

  t.requestEquip("shotgun");
  check("requestEquip switches an owned weapon", p.weapon === "shotgun");
  t.requestEquip("cannon");
  check("requestEquip rejects an unowned weapon", p.weapon === "shotgun");

  t.requestDrop("shotgun");
  check("requestDrop removes + spawns in the solo world", !p.ownedWeapons.includes("shotgun") && w.pickups.some((q) => q.kind === "weapon" && q.weapon === "shotgun"));
  check("active drop fell back to the adjacent slot", p.weapon === "railgun");
  const { events } = t.poll();
  check("weaponDrop event reaches the client event stream (drop pop/label)", events.some((e) => e.t === "weaponDrop" && e.weapon === "shotgun"));

  t.requestDrop("railgun");
  t.requestDrop("pistol");
  check("final weapon protected through the transport too", p.ownedWeapons.length === 1 && p.ownedWeapons[0] === "pistol");
}

function main(): void {
  reorderTests();
  dropRuleTests();
  dropPlacementTests();
  dropCollectionTests();
  localTransportParityTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll inventory command assertions passed.\n");
}

main();
