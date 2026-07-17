// SEVER (F55 HUNT/INTERCEPT + WORLDSPLIT) — Batch1 OWNER LOCK.
// Timings LOCKED: 1.5s plant → 1.2s fracture → 3.0s punish (±1 tick @20Hz).
// Run: npm run test:sever

import {
  createWorld, stepWorld, loadFloorIntoWorld, restoreEncounterInWorld, cloneEncounter,
  encounterEqual, isFloorCleared, spawnPlayerInWorld,
} from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import type { InputCmd } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import { bossKindForFloor, SEVER_FLOOR, GORGE_FLOOR, isBossKind } from "../src/sim/enemies.js";
import { SEVER } from "../src/sim/balance.js";
import { generateDungeon, roomIdAt } from "../src/sim/dungeon.js";
import { PROTOCOL_VERSION, FIXED_DT, TICK_HZ } from "../src/net/protocol.js";
import { TILE } from "../src/sim/types.js";
import { encounterObjectiveCopy } from "../src/game/hud.js";

const DT = FIXED_DT; // 20Hz authoritative

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void { process.stdout.write(`\n[${name}]\n`); }
function idle(seq: number): InputCmd {
  return { seq, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };
}
function step(w: WorldState, n = 1): void {
  for (let i = 0; i < n; i++) stepWorld(w, new Map([[LOCAL_ID, idle(i)]]), DT);
}
function nearTicks(seconds: number): { lo: number; hi: number; exact: number } {
  const exact = Math.round(seconds * TICK_HZ);
  return { lo: exact - 1, hi: exact + 1, exact };
}

function pinGates(): void {
  section("F55 Sever pin + Gorge untouched + protocol");
  check("SEVER_FLOOR is 55", SEVER_FLOOR === 55);
  check("sever is a boss kind", isBossKind("sever"));
  check("sever_anchor is NOT a boss kind", !isBossKind("sever_anchor"));
  check("WORLDSPLIT plant 1.5", SEVER.worldsplitPlant === 1.5);
  check("WORLDSPLIT fracture 1.2", SEVER.worldsplitFracture === 1.2);
  check("WORLDSPLIT punish 3.0", SEVER.worldsplitPunish === 3.0);
  check("PROTOCOL_VERSION is 36 (worldsplit wire on top of Wave A v35)", PROTOCOL_VERSION === 36);
  for (const seed of [0x51a9eb0b, 0xC0FFEE, 42, 0xDEAD]) {
    check(`seed ${seed.toString(16)} F50=gorge`, bossKindForFloor(seed, GORGE_FLOOR) === "gorge");
    check(`seed ${seed.toString(16)} F55=sever`, bossKindForFloor(seed, SEVER_FLOOR) === "sever");
  }
}

function huntBlueprint(): void {
  section("F55 hunt blueprint: 3 checkpoints, ≥2 chase edges width≥3");
  let ok = true;
  for (const seed of [0x51a9eb0b, 0xC0FFEE, 42, 0x1111, 0xDEAD]) {
    const d = generateDungeon(seed, 55);
    if (!d.blueprint || d.blueprint.structureKind !== "hunt") { ok = false; continue; }
    if (d.blueprint.objectiveRoomIds.length < 3) ok = false;
    if (d.blueprint.chaseEdgeIds.length < 2) ok = false;
    if (d.blueprint.spawnRoomId === d.rooms[d.rooms.length - 1].id) ok = false; // not last-only
    for (const ei of d.blueprint.chaseEdgeIds) {
      if (d.edges[ei].width < 3) ok = false;
    }
  }
  check("hunt blueprint invariants hold across seeds", ok);

  const w50 = createWorld(0x60A1, 50, {});
  check("F50 still arena (Gorge unchanged)", w50.encounter?.kind === "arena");
}

function encounterFlagsAndReconnect(): void {
  section("EncounterState hunt flags + reconnect");
  const w = createWorld(0x5E55, 55, {});
  loadFloorIntoWorld(w, 55);
  check("F55 attaches hunt encounter", w.encounter?.kind === "hunt" && w.encounter?.structureKind === "hunt");
  check("hunt starts inactive (no pre-activation aggro)", w.encounter !== null && w.encounter.active === false);
  check("flags carry OWNER LOCK keys",
    w.encounter !== null
    && "escapeMeter" in w.encounter.flags
    && "supportsCut" in w.encounter.flags
    && "interceptState" in w.encounter.flags
    && "chosenExitEdgeId" in w.encounter.flags
    && "worldsplitPhase" in w.encounter.flags);
  const boss = w.enemies.find((e) => e.kind === "sever");
  check("Sever body spawned (ONE isBossKind)", !!boss);
  check("no second boss kind on floor", w.enemies.filter((e) => isBossKind(e.kind)).length === 1);

  w.encounter!.checkpoint = 1;
  w.encounter!.active = true;
  w.encounter!.flags.escapeMeter = 2;
  w.encounter!.flags.worldsplitPhase = "fracture";
  w.encounter!.objectiveProgress = 0.4;
  const frozen = cloneEncounter(w.encounter!);
  const re = createWorld(0x5E55, 1, {});
  loadFloorIntoWorld(re, 55);
  restoreEncounterInWorld(re, frozen);
  check("reconnect restores checkpoint/flags bit-identical", encounterEqual(re.encounter, frozen));
}

function worldsplitTimings(): void {
  section("WORLDSPLIT timings within ±1 tick @20Hz");
  const plant = nearTicks(1.5);
  const frac = nearTicks(1.2);
  const punish = nearTicks(3.0);
  check("plant ticks ±1", plant.exact >= 29 && plant.exact <= 31, `exact=${plant.exact}`);
  check("fracture ticks ±1", frac.exact >= 23 && frac.exact <= 25, `exact=${frac.exact}`);
  check("punish ticks ±1", punish.exact >= 59 && punish.exact <= 61, `exact=${punish.exact}`);
}

function worldsplitLive(): void {
  section("Live WORLDSPLIT phase machine (plant→fracture→punish)");
  const w = createWorld(0x51550, 55, {});
  w.isGodMode = true;
  loadFloorIntoWorld(w, 55);
  const boss = w.enemies.find((e) => e.kind === "sever");
  if (!boss || !w.encounter) { check("F55 sever present for live WORLDSPLIT", false); return; }
  check("F55 sever present for live WORLDSPLIT", true);
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;
  // Activate encounter + place player in pressure range to trigger WORLDSPLIT
  w.encounter.active = true;
  const p = w.players.get(LOCAL_ID)!;
  p.x = boss.x + 80;
  p.y = boss.y;
  p.invuln = 999;

  let plantTicks = 0, fracTicks = 0, punishTicks = 0;
  let phase: string = "idle";
  for (let i = 0; i < 200; i++) {
    step(w, 1);
    const mv = boss.attack.move;
    const ph = boss.attack.phase;
    if (mv === "worldsplit" && ph === "windup") {
      if (phase !== "plant") { phase = "plant"; plantTicks = 0; }
      plantTicks++;
    } else if (mv === "worldsplit" && ph === "active") {
      if (phase !== "fracture") { phase = "fracture"; fracTicks = 0; }
      fracTicks++;
    } else if (mv === "worldsplit" && ph === "recover") {
      if (phase !== "punish") { phase = "punish"; punishTicks = 0; }
      punishTicks++;
    } else if (phase === "punish" && ph === "none") {
      break;
    }
  }
  const pT = nearTicks(1.5), fT = nearTicks(1.2), uT = nearTicks(3.0);
  check("plant duration ±1 tick", plantTicks >= pT.lo && plantTicks <= pT.hi, `ticks=${plantTicks}`);
  check("fracture duration ±1 tick", fracTicks >= fT.lo && fracTicks <= fT.hi, `ticks=${fracTicks}`);
  check("punish duration ±1 tick", punishTicks >= uT.lo && punishTicks <= uT.hi, `ticks=${punishTicks}`);
}

function fleeAcrossEdges(): void {
  section("Flee via RoomEdges ≥2; escape never fails the run");
  const w = createWorld(0xF1EE, 55, {});
  loadFloorIntoWorld(w, 55);
  const boss = w.enemies.find((e) => e.kind === "sever");
  check("sever present", !!boss);
  if (!boss || !w.encounter) return;
  const edgesBefore = w.dungeon.blueprint?.chaseEdgeIds.length ?? 0;
  check("≥2 chase edges authored", edgesBefore >= 2, `n=${edgesBefore}`);

  // Activate and pressure Sever so it flees along authored edges.
  // Clear CP0 anchors so WORLDSPLIT/window cannot interrupt the chase measurement.
  w.encounter.active = true;
  w.encounter.flags.interceptState = "hunt";
  boss.spawnTimer = 0;
  boss.attack.cooldown = 999; // suppress WORLDSPLIT during flee measurement
  boss.boss!.windowAddIds.length = 0;
  for (const a of w.enemies) if (a.kind === "sever_anchor") a.dead = true;
  const p = w.players.get(LOCAL_ID)!;
  const roomsVisited = new Set<number>();
  const edgesUsed = new Set<number>();
  roomsVisited.add(w.encounter.currentRoomId);

  for (let i = 0; i < 900; i++) {
    // Keep player glued just inside pressure radius so Sever stays pressured but never "near"
    // enough to count as intercept (escapeMeter soft-fail path).
    const ang = Math.atan2(boss.y - p.y, boss.x - p.x);
    p.x = boss.x - Math.cos(ang) * (SEVER.pressureRadius * 0.55);
    p.y = boss.y - Math.sin(ang) * (SEVER.pressureRadius * 0.55);
    p.invuln = 999;
    p.isDown = false; p.hp = Math.max(p.hp, 1);
    step(w, 1);
    if (w.encounter.routeEdgeId !== null) edgesUsed.add(w.encounter.routeEdgeId);
    roomsVisited.add(w.encounter.currentRoomId);
    if (edgesUsed.size >= 2 && roomsVisited.size >= 3) break;
  }
  check("Sever flees through ≥2 RoomEdges", edgesUsed.size >= 2, `edges=${[...edgesUsed]} rooms=${roomsVisited.size}`);

  // Soft-fail the escape meter to max — run must remain uncleared-but-winnable (not wiped).
  w.encounter.flags.escapeMeter = SEVER.escapeMeterMax;
  w.encounter.failed = true;
  w.encounter.flags.interceptState = "escaped";
  check("escape soft-fail does not complete floor", isFloorCleared(w) === false);
  check("escape does not kill players", [...w.players.values()].every((pl) => pl.hp > 0));
  w.encounter.completed = true;
  check("custom completion still opens exit after escapes", isFloorCleared(w) === true);
}

function anchorsAndWindow(): void {
  section("Anchor spawn 2/checkpoint + intercept → earned window");
  const w = createWorld(0xA4C4, 55, {});
  loadFloorIntoWorld(w, 55);
  const boss = w.enemies.find((e) => e.kind === "sever");
  if (!boss || !w.encounter) { check("sever for anchors", false); return; }
  // Place player on Sever to activate; CP0 anchors should plant.
  const p = w.players.get(LOCAL_ID)!;
  p.x = boss.x + 40; p.y = boss.y; p.invuln = 999;
  boss.spawnTimer = 0;
  step(w, 3);
  check("encounter activates on approach", w.encounter.active === true);
  const anchors = w.enemies.filter((e) => e.kind === "sever_anchor" && !e.dead);
  check("2 resin anchors planted at checkpoint", anchors.length === 2, `n=${anchors.length}`);
  check("interceptState is trap", w.encounter.flags.interceptState === "trap");

  // Break both anchors → earned window.
  for (const a of anchors) { a.hp = 0; a.dead = true; }
  step(w, 2);
  check("both anchors broken opens intercept window", w.encounter.flags.interceptState === "window");
  check("boss exposure window armed", (boss.boss?.exposed ?? 0) > 0);
  check("carrier pip assigned on intercept", w.encounter.carrierPlayerId !== null);
}

function lateJoinCheckpoint(): void {
  section("Soft: late-join spawns at current checkpoint");
  const w = createWorld(0x1A7E, 55, { isShared: true, skipLocalPlayer: true });
  loadFloorIntoWorld(w, 55);
  if (!w.encounter) { check("hunt for late-join", false); return; }
  w.encounter.active = true;
  w.encounter.checkpoint = 1;
  const cps = w.dungeon.blueprint?.objectiveRoomIds ?? [];
  const targetRoom = cps[1];
  const room = w.dungeon.rooms.find((r) => r.id === targetRoom);
  check("checkpoint room exists", !!room);
  const joiner = spawnPlayerInWorld(w, "late-joiner");
  const rid = roomIdAt(w.dungeon, Math.floor(joiner.x / TILE), Math.floor(joiner.y / TILE));
  check("late-join lands in checkpoint room", rid === targetRoom, `rid=${rid} want=${targetRoom}`);
}

function carrierHudPip(): void {
  section("Soft: carrier HUD pip in WORLDSPLIT objective copy");
  const copyNone = encounterObjectiveCopy({
    kind: "hunt", progress: 0.5, checkpoint: 1, carrierId: null, completed: false,
  });
  const copyPip = encounterObjectiveCopy({
    kind: "hunt", progress: 0.5, checkpoint: 1, carrierId: "p1", completed: false,
  });
  check("objective copy brands WORLDSPLIT", !!copyNone && copyNone.includes("WORLDSPLIT"));
  check("carrier pip present when carrierId set", !!copyPip && copyPip.includes("\u25cf"));
  check("no pip without carrier", !!copyNone && !copyNone.includes("\u25cf"));
}

function noPreActivationAggro(): void {
  section("No pre-activation aggro / WORLDSPLIT");
  const w = createWorld(0x4055, 55, {});
  loadFloorIntoWorld(w, 55);
  const boss = w.enemies.find((e) => e.kind === "sever");
  if (!boss || !w.encounter) { check("sever present", false); return; }
  // Park player far from Sever + outside approach room.
  const p = w.players.get(LOCAL_ID)!;
  const far = w.dungeon.rooms[0];
  p.x = far.cx * TILE + TILE / 2;
  p.y = far.cy * TILE + TILE / 2;
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;
  const x0 = boss.x, y0 = boss.y;
  step(w, 40);
  check("still inactive while far", w.encounter.active === false);
  check("no WORLDSPLIT before activation", boss.attack.move !== "worldsplit");
  check("body did not flee while inactive", Math.hypot(boss.x - x0, boss.y - y0) < 8);
}

pinGates();
huntBlueprint();
encounterFlagsAndReconnect();
worldsplitTimings();
worldsplitLive();
fleeAcrossEdges();
anchorsAndWindow();
lateJoinCheckpoint();
carrierHudPip();
noPreActivationAggro();

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
  process.stdout.write(failures.map((f) => "  - " + f).join("\n") + "\n");
  process.exit(1);
}
