// Batch0 — Encounter architecture foundation.
// Locks: dungeon room ids + graph edges (incl. shortcuts), EncounterState serialize/restore,
// custom completion opening the exit without clearing phantom adds, Gorge F50 arena path,
// reconnect/late-join fixtures, co-op isolation (no PvP flag changes).
//
// Run: npm run test:encounterArch

import { generateDungeon, roomIdAt, neighbors, edgeBetween } from "../src/sim/dungeon.js";
import {
  createWorld, loadFloorIntoWorld, spawnPlayerInWorld, isFloorCleared,
  restoreEncounterInWorld, completeEncounter, initSmokeEncounter, cloneEncounter,
  encounterEqual, grantEncounterCompletionReward, isPvp, setPlayerKit,
  adminWarpToFloorInWorld, adminForceOpenExitInWorld,
} from "../src/sim/world.js";
import { buildSnapshot, validateSnap, jsonCodec, PROTOCOL_VERSION, toEncounterWire } from "../src/net/protocol.js";
import { diffSnapshot, applySnapshotDelta, snapshotToWire, type WorldLiveIds } from "../src/net/snapshotDelta.js";
import { isBossFloor, bossKindForFloor } from "../src/sim/enemies.js";
import { TILE } from "../src/sim/types.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void { process.stdout.write(`\n[${name}]\n`); }

const SEEDS = [0x51a9eb0b, 0xC0FFEE, 42, 0xDEAD, 0x1111];

function graphTests(): void {
  section("Room.id + Dungeon.edges retain chain AND shortcuts");
  let idsOk = true, edgesOk = true, shortcutsSeen = 0, helpersOk = true, tilesStable = true;
  for (const seed of SEEDS) {
    for (const floor of [1, 3, 8, 12, 20, 50]) {
      const d = generateDungeon(seed, floor);
      const again = generateDungeon(seed, floor);
      if (JSON.stringify(d.tiles) !== JSON.stringify(again.tiles)) tilesStable = false;
      if (JSON.stringify(d.edges) !== JSON.stringify(again.edges)) tilesStable = false;
      for (let i = 0; i < d.rooms.length; i++) {
        if (d.rooms[i].id !== i) idsOk = false;
      }
      for (let i = 1; i < d.rooms.length; i++) {
        const e = edgeBetween(d, d.rooms[i - 1].id, d.rooms[i].id);
        if (!e || e.isShortcut) edgesOk = false;
      }
      for (const e of d.edges) {
        if (e.isShortcut) shortcutsSeen++;
        if (!e.path.length) edgesOk = false;
        if (e.width < 1) edgesOk = false;
      }
      const spawnId = roomIdAt(d, d.spawn.x, d.spawn.y);
      if (spawnId !== d.rooms[0].id) helpersOk = false;
      const exitId = roomIdAt(d, d.exit.x, d.exit.y);
      if (exitId !== d.rooms[d.rooms.length - 1].id) helpersOk = false;
      const n0 = neighbors(d, d.rooms[0].id);
      if (d.rooms.length > 1 && n0.length < 1) helpersOk = false;
      if (edgeBetween(d, 0, 0) !== null) helpersOk = false;
    }
  }
  check("room.id equals journey index for every seed/floor", idsOk);
  check("chain corridors retained as non-shortcut edges", edgesOk);
  check("shortcuts appear on floors with enough rooms (graph retains them)", shortcutsSeen > 0, `seen=${shortcutsSeen}`);
  check("roomIdAt/neighbors/edgeBetween helpers are stable", helpersOk);
  check("tiles + edges bit-identical across regenerate (RNG order preserved)", tilesStable);

  section("Boss-floor arena blueprint preserves Gorge spawn room = last");
  let bpOk = true;
  for (const seed of SEEDS) {
    const d = generateDungeon(seed, 50);
    if (!d.blueprint || d.blueprint.structureKind !== "arena") bpOk = false;
    else {
      const last = d.rooms[d.rooms.length - 1];
      if (d.blueprint.spawnRoomId !== last.id) bpOk = false;
      if (!d.blueprint.objectiveRoomIds.includes(last.id)) bpOk = false;
      for (const ei of d.blueprint.chaseEdgeIds) {
        if (d.edges[ei].width < 3) bpOk = false;
      }
    }
  }
  check("F50 blueprint is arena with spawn/objective = final room, chase width>=3", bpOk);
}

function encounterStateTests(): void {
  section("WorldState.encounter plain-data + serialize/restore bit-identical");
  const w = createWorld(0xBA7C, 50, {});
  check("boss floor attaches arena encounter", w.encounter !== null && w.encounter!.kind === "arena");
  check("arena encounter active", !!w.encounter?.active);
  const snap = cloneEncounter(w.encounter!);
  snap.checkpoint = 2;
  snap.objectiveProgress = 0.4;
  snap.carrierPlayerId = "p1";
  snap.flags.note = "x";
  restoreEncounterInWorld(w, snap);
  check("restoreEncounterInWorld is bit-identical", encounterEqual(w.encounter, snap));
  const again = cloneEncounter(w.encounter!);
  check("cloneEncounter round-trip", encounterEqual(again, snap));

  const w1 = createWorld(0xBA7C, 1, {});
  check("non-boss floor has null encounter", w1.encounter === null);

  section("Custom completion opens exit WITHOUT clearing phantom adds");
  const w2 = createWorld(0x5F0C, 3, {});
  w2.encounter = initSmokeEncounter(w2.dungeon);
  const beforeEnemies = w2.enemies.length;
  completeEncounter(w2.encounter);
  check("custom completion predicate true", w2.encounter.completed && w2.encounter.active);
  check("isFloorCleared opens via encounter.completed even with living enemies",
    isFloorCleared(w2) === true, `enemies=${w2.enemies.length} pending=${w2.pendingSpawns.length}`);
  check("phantom adds still present (not wiped by custom complete)", w2.enemies.length === beforeEnemies);
  grantEncounterCompletionReward(w2);
  check("reward hook places a boss chest", w2.chests.some((c) => c.kind === "boss"));

  section("Gorge F50 path unchanged (arena encounter + boss kind)");
  check("floor 50 is boss floor", isBossFloor(50));
  check("floor 50 boss kind is gorge", bossKindForFloor(0x60A1, 50) === "gorge");
  const wg = createWorld(0x60A1, 50, {});
  check("F50 world has arena encounter (not custom hunt)", wg.encounter?.kind === "arena");
  check("F50 not cleared until boss death / empty", isFloorCleared(wg) === false);

  section("Reconnect / co-op isolation");
  const host = createWorld(0xC00B, 50, { isShared: true });
  spawnPlayerInWorld(host, "p1");
  spawnPlayerInWorld(host, "p2");
  loadFloorIntoWorld(host, 50);
  host.encounter!.checkpoint = 3;
  host.encounter!.carrierPlayerId = "p1";
  host.encounter!.objectiveProgress = 0.55;
  const frozen = cloneEncounter(host.encounter!);
  const rejoin = createWorld(0xC00B, 1, { isShared: true });
  spawnPlayerInWorld(rejoin, "p1");
  spawnPlayerInWorld(rejoin, "p2");
  loadFloorIntoWorld(rejoin, 50);
  restoreEncounterInWorld(rejoin, frozen);
  check("same-run reconnect restores exact encounter progress", encounterEqual(rejoin.encounter, frozen));
  check("co-op lock players unchanged", rejoin.encounterPlayers === host.encounterPlayers);
  check("pvp flag untouched (still coop)", !isPvp(rejoin) && rejoin.mode === "coop");

  section("Admin rescue overrides preserve authority and player loadouts");
  const rescue = createWorld(0x5E7E, 3, { isShared: true, skipLocalPlayer: true });
  spawnPlayerInWorld(rescue, "ian");
  spawnPlayerInWorld(rescue, "coop");
  setPlayerKit(rescue, "ian", "bulwark");
  const ian = rescue.players.get("ian")!;
  ian.ownedWeapons = ["pistol", "sword", "halo"];
  ian.weapon = "halo";
  ian.ownedItemIds = ["it_dmg"];
  ian.isDown = true;
  ian.hp = 0;
  const kitBefore = ian.kitId;
  const weaponsBefore = JSON.stringify(ian.ownedWeapons);
  const blessingsBefore = JSON.stringify(ian.ownedItemIds);
  const warped = adminWarpToFloorInWorld(rescue, 55);
  check("admin warp lands the authoritative room on floor 55", warped && rescue.floor === 55);
  check("admin warp preserves kit, weapons, and blessings",
    ian.kitId === kitBefore
    && JSON.stringify(ian.ownedWeapons) === weaponsBefore
    && JSON.stringify(ian.ownedItemIds) === blessingsBefore);
  check("admin warp rescues downed players onto the fresh floor",
    [...rescue.players.values()].every((player) => !player.isDown && player.hp > 0));
  const spawnX = rescue.dungeon.spawn.x * TILE + TILE / 2;
  const spawnY = rescue.dungeon.spawn.y * TILE + TILE / 2;
  check("admin warp advances every player in the room together",
    [...rescue.players.values()].every((player) => player.x === spawnX && player.y === spawnY));

  if (rescue.encounter !== null) {
    rescue.encounter.failed = true;
    rescue.encounter.completed = false;
  }
  if (rescue.dungeon.edges.length > 0) rescue.dungeon.edges[0].locked = true;
  const forced = adminForceOpenExitInWorld(rescue);
  check("admin force-open clears stuck combat and opens the exit",
    forced
    && isFloorCleared(rescue)
    && rescue.enemies.length === 0
    && rescue.pendingSpawns.length === 0);
  check("admin force-open resolves encounter and route blockers",
    rescue.encounter?.completed === true
    && rescue.encounter.failed === false
    && rescue.dungeon.edges.every((edge) => !edge.locked));

  const pvp = createWorld(0xA11C, 1, { mode: "pvp", isShared: true, skipLocalPlayer: true });
  check("admin rescue overrides reject PVP worlds",
    !adminWarpToFloorInWorld(pvp, 55)
    && !adminForceOpenExitInWorld(pvp)
    && pvp.floor === 1);
}

function wireTests(): void {
  section("Wire/HUD: EncounterWire on snapshot (protocol v47)");
  check("PROTOCOL_VERSION is 49", PROTOCOL_VERSION === 49);
  const w = createWorld(0x5150, 50, { skipLocalPlayer: true, isShared: true });
  spawnPlayerInWorld(w, "alice");
  const snap = buildSnapshot(w, "alice", 0, [], 0, true, {
    worldId: "w_test",
    sseq: 1,
    roster: [{ pid: "alice", aid: "a1", nm: "Alice", cl: 0, st: "on" }],
  });
  if (snap.t !== "snap") { check("snap built", false); return; }
  check("snap.enc present on boss floor", snap.enc !== null && snap.enc!.k === "arena");
  const encoded = jsonCodec.encodeServer(snap);
  const decoded = jsonCodec.decodeServer(encoded);
  check("snap+enc round-trips through strict decoder", JSON.stringify(decoded) === JSON.stringify(snap));

  w.encounter = initSmokeEncounter(w.dungeon);
  w.encounter.checkpoint = 1;
  w.encounter.carrierPlayerId = "alice";
  w.encounter.objectiveProgress = 0.25;
  const snap2 = buildSnapshot(w, "alice", 0, [], 0, false, {
    worldId: "w_test", sseq: 2,
    roster: [{ pid: "alice", aid: "a1", nm: "Alice", cl: 0, st: "on" }],
  });
  if (snap2.t !== "snap" || !snap2.enc) { check("custom enc on wire", false); return; }
  check("wire carries checkpoint/carrier/progress",
    snap2.enc.cp === 1 && snap2.enc.ca === "alice" && snap2.enc.op === 0.25);
  const wire = toEncounterWire(w.encounter);
  check("toEncounterWire maps nulls to sentinels", wire.re === (w.encounter.routeEdgeId ?? -1) && wire.ca === "alice");

  const base = snapshotToWire(snap2 as unknown as object);
  const nextObj = { ...snap2, enc: { ...snap2.enc!, op: 0.9 }, sseq: 3, tick: (snap2.tick ?? 0) + 1 };
  const live: WorldLiveIds = {
    enemies: new Set(), players: new Set(["alice"]), props: new Set(), pickups: new Set(),
    chests: new Set(), hzds: new Set(), effs: new Set(),
  };
  const delta = diffSnapshot(base, snapshotToWire(nextObj as unknown as object), 3, live);
  const rebuilt = applySnapshotDelta(base, delta);
  const validated = validateSnap(rebuilt as Record<string, unknown>);
  check("delta whole-replace restores enc.op", validated.enc?.op === 0.9);

  const wN = createWorld(0xA011, 1, { skipLocalPlayer: true });
  spawnPlayerInWorld(wN, "bob");
  const snapN = buildSnapshot(wN, "bob", 0, [], 0, true, {
    worldId: "w_test", sseq: 1, roster: [{ pid: "bob", aid: "b1", nm: "Bob", cl: 1, st: "on" }],
  });
  check("non-encounter snap.enc is null", snapN.t === "snap" && snapN.enc === null);
}

graphTests();
encounterStateTests();
wireTests();

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
  process.stdout.write(failures.map((f) => "  - " + f).join("\n") + "\n");
  process.exit(1);
}
