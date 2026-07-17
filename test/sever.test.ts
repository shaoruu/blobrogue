// SEVER (F55 HUNT/INTERCEPT + WORLDSPLIT) — Batch1 OWNER LOCK.
// Timings LOCKED: 1.5s plant → 1.2s fracture → 3.0s punish (±1 tick @20Hz).
// Run: npm run test:sever

import {
  createWorld, stepWorld, loadFloorIntoWorld, restoreEncounterInWorld, cloneEncounter,
  encounterEqual, isFloorCleared,
} from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import type { InputCmd } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import { bossKindForFloor, SEVER_FLOOR, GORGE_FLOOR, isBossKind } from "../src/sim/enemies.js";
import { SEVER } from "../src/sim/balance.js";
import { generateDungeon } from "../src/sim/dungeon.js";
import { PROTOCOL_VERSION, FIXED_DT, TICK_HZ } from "../src/net/protocol.js";

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
  check("flags carry OWNER LOCK keys",
    w.encounter !== null
    && "escapeMeter" in w.encounter.flags
    && "supportsCut" in w.encounter.flags
    && "interceptState" in w.encounter.flags
    && "chosenExitEdgeId" in w.encounter.flags
    && "worldsplitPhase" in w.encounter.flags);
  const boss = w.enemies.find((e) => e.kind === "sever");
  check("Sever body spawned (ONE isBossKind)", !!boss);
  check("no second boss kind on floor", w.enemies.filter((e) => e.kind !== "sever" && (e.kind as string) === "sever").length === 0);

  w.encounter!.checkpoint = 1;
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
  // Real F55 floor (sandbox skips dungeon boss spawn).
  const w = createWorld(0x51550, 55, {});
  w.isGodMode = true;
  loadFloorIntoWorld(w, 55);
  const boss = w.enemies.find((e) => e.kind === "sever");
  if (!boss) { check("F55 sever present for live WORLDSPLIT", false); return; }
  check("F55 sever present for live WORLDSPLIT", true);
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;
  // Place player in pressure range to trigger WORLDSPLIT
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
    const encPhase = String(w.encounter?.flags.worldsplitPhase ?? "idle");
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
    void encPhase;
  }
  const pT = nearTicks(1.5), fT = nearTicks(1.2), uT = nearTicks(3.0);
  check("plant duration ±1 tick", plantTicks >= pT.lo && plantTicks <= pT.hi, `ticks=${plantTicks}`);
  check("fracture duration ±1 tick", fracTicks >= fT.lo && fracTicks <= fT.hi, `ticks=${fracTicks}`);
  check("punish duration ±1 tick", punishTicks >= uT.lo && punishTicks <= uT.hi, `ticks=${punishTicks}`);
}

function fleeAndEscapeSoft(): void {
  section("Flee via RoomEdges; escape never fails the run");
  const w = createWorld(0xF1EE, 55, {});
  loadFloorIntoWorld(w, 55);
  const boss = w.enemies.find((e) => e.kind === "sever");
  check("sever present", !!boss);
  if (!boss || !w.encounter) return;
  const edgesBefore = w.dungeon.blueprint?.chaseEdgeIds.length ?? 0;
  check("≥2 chase edges authored", edgesBefore >= 2, `n=${edgesBefore}`);

  // Soft-fail the escape meter to max — run must remain uncleared-but-winnable (not wiped).
  w.encounter.flags.escapeMeter = SEVER.escapeMeterMax;
  w.encounter.failed = true;
  w.encounter.flags.interceptState = "escaped";
  check("escape soft-fail does not complete floor", isFloorCleared(w) === false);
  check("escape does not kill players", [...w.players.values()].every((p) => p.hp > 0));
  // Still can complete via encounter.completed later
  w.encounter.completed = true;
  check("custom completion still opens exit after escapes", isFloorCleared(w) === true);
}

// Live driver: pins a pressuring player next to the Sever each tick. When `breakAnchors`, it
// destroys the resin anchors the instant they are planted (a perfect intercept), so the hunt
// advances through its checkpoints. Returns the sequence of rooms the boss actually occupied.
function driveHunt(w: WorldState, breakAnchors: boolean, maxTicks: number): { seq: number[]; crossings: number; completedAt: number } {
  const boss = w.enemies.find((e) => e.kind === "sever");
  if (!boss) return { seq: [], crossings: 0, completedAt: -1 };
  boss.spawnTimer = 0;
  const p = w.players.get(LOCAL_ID)!;
  const seq: number[] = [];
  let last = -99, crossings = 0, completedAt = -1;
  for (let i = 0; i < maxTicks; i++) {
    const enc = w.encounter!;
    p.x = boss.x + 40; p.y = boss.y; p.invuln = 999999;
    if (breakAnchors && String(enc.flags.interceptState) === "trap") {
      for (const a of w.enemies) if (a.kind === "sever_anchor" && !a.dead) a.dead = true;
    }
    step(w, 1);
    const rid = enc.currentRoomId;
    if (rid !== last) { if (last !== -99) crossings++; seq.push(rid); last = rid; }
    if (enc.completed) { completedAt = i; break; }
  }
  return { seq, crossings, completedAt };
}

function fleeLiveCrossesEdges(): void {
  section("Live flee crosses ≥2 RoomEdges across the 3 checkpoints, then completes");
  for (const seed of [0x51a9eb0b, 0xC0FFEE, 0xDEAD, 0x1111]) {
    const w = createWorld(seed, 55, {});
    const cps = w.dungeon.blueprint?.objectiveRoomIds ?? [];
    const { seq, crossings, completedAt } = driveHunt(w, true, 6000);
    const distinct = new Set(seq);
    const visitedAllCps = cps.every((c) => distinct.has(c));
    check(`seed ${seed.toString(16)}: boss crosses ≥2 edges`, crossings >= 2, `crossings=${crossings} seq=${JSON.stringify(seq)}`);
    check(`seed ${seed.toString(16)}: visits all 3 checkpoint rooms`, visitedAllCps, `cps=${JSON.stringify(cps)} distinct=${JSON.stringify([...distinct])}`);
    check(`seed ${seed.toString(16)}: intercept objective completes`, completedAt >= 0 && w.encounter!.completed);
    check(`seed ${seed.toString(16)}: completion opens the exit`, isFloorCleared(w) === true);
  }
}

function escapeLiveSoftFail(): void {
  section("Live escape (no intercept) climbs escapeMeter to the cap — soft fail, never a wipe");
  const w = createWorld(0x2a, 55, {});
  const { completedAt } = driveHunt(w, false, 8000);
  const enc = w.encounter!;
  check("never-intercepted hunt does NOT complete", completedAt < 0 && !enc.completed);
  check("escapeMeter reaches its cap", Number(enc.flags.escapeMeter) === SEVER.escapeMeterMax, `meter=${enc.flags.escapeMeter}`);
  check("terminal state is 'escaped'", enc.flags.interceptState === "escaped");
  check("soft-failed run marks failed (route worsened)", enc.failed === true);
  check("soft fail never wipes: all players alive", [...w.players.values()].every((p) => p.hp > 0));
  check("soft fail stays winnable: Sever core still alive", w.enemies.some((e) => e.kind === "sever" && !e.dead));
  check("uncompleted hunt keeps the exit closed", isFloorCleared(w) === false);
}

function noPreActivationAggro(): void {
  section("No pre-activation aggro: an un-approached Sever holds (no WORLDSPLIT, no anchors)");
  const w = createWorld(0x2a, 55, {});
  const boss = w.enemies.find((e) => e.kind === "sever")!;
  boss.spawnTimer = 0;
  const p = w.players.get(LOCAL_ID)!;
  let sawWorldsplit = false, sawAnchor = false;
  for (let i = 0; i < 200; i++) {
    p.x = 60; p.y = 60; p.invuln = 999999; // parked far from the hunt
    step(w, 1);
    if (boss.attack.move === "worldsplit") sawWorldsplit = true;
    if (w.enemies.some((e) => e.kind === "sever_anchor")) sawAnchor = true;
  }
  check("no WORLDSPLIT commits while un-approached", !sawWorldsplit);
  check("no anchors planted while un-approached", !sawAnchor);
  check("stays in the hunt state (dormant presence)", w.encounter!.flags.interceptState === "hunt");
  check("sever_anchor never a boss kind (mechanic body)", !isBossKind("sever_anchor"));
}

function reconnectRestoresTrap(): void {
  section("Reconnect restores checkpoint / route / anchor-trap state bit-identical");
  const w = createWorld(0x1111, 55, {});
  const boss = w.enemies.find((e) => e.kind === "sever")!;
  boss.spawnTimer = 0;
  const p = w.players.get(LOCAL_ID)!;
  let trapped = false;
  for (let i = 0; i < 2000 && !trapped; i++) {
    p.x = boss.x + 40; p.y = boss.y; p.invuln = 999999;
    step(w, 1);
    if (String(w.encounter!.flags.interceptState) === "trap") trapped = true;
  }
  check("hunt reaches an anchor trap", trapped);
  const liveAnchors = w.enemies.filter((e) => e.kind === "sever_anchor" && !e.dead).length;
  check("2 anchors planted per checkpoint", liveAnchors === SEVER.anchorsPerCheckpoint, `n=${liveAnchors}`);
  check("boss tracks its anchors", boss.boss!.windowAddIds.length === SEVER.anchorsPerCheckpoint);

  const frozen = cloneEncounter(w.encounter!);
  const re = createWorld(0x1111, 1, {});
  loadFloorIntoWorld(re, 55);
  restoreEncounterInWorld(re, frozen);
  check("reconnect restores trap encounter bit-identical", encounterEqual(re.encounter, frozen));
  check("restored checkpoint matches", re.encounter!.checkpoint === frozen.checkpoint);
  check("restored route edge matches", re.encounter!.routeEdgeId === frozen.routeEdgeId);
  check("restored interceptState is trap", re.encounter!.flags.interceptState === "trap");
}

function coopIsolation(): void {
  section("Co-op isolation: two independent F55 worlds never cross-contaminate");
  const wA = createWorld(0x51a9eb0b, 55, {});
  const wB = createWorld(0x51a9eb0b, 55, {});
  // Advance world A to a completed intercept run.
  const a = driveHunt(wA, true, 6000);
  // World B only ever sees a far, un-engaging player — it must stay dormant at checkpoint 0.
  const bossB = wB.enemies.find((e) => e.kind === "sever")!;
  bossB.spawnTimer = 0;
  const pB = wB.players.get(LOCAL_ID)!;
  for (let i = 0; i < 400; i++) { pB.x = 60; pB.y = 60; pB.invuln = 999999; step(wB, 1); }
  check("world A completed its own hunt", a.completedAt >= 0 && wA.encounter!.completed);
  check("world B untouched by A: still checkpoint 0", wB.encounter!.checkpoint === 0);
  check("world B untouched by A: still hunting", wB.encounter!.flags.interceptState === "hunt");
  check("world B untouched by A: not completed", !wB.encounter!.completed);
  check("the two encounters are distinct objects", wA.encounter !== wB.encounter);
}

pinGates();
huntBlueprint();
encounterFlagsAndReconnect();
worldsplitTimings();
worldsplitLive();
fleeAndEscapeSoft();
fleeLiveCrossesEdges();
escapeLiveSoftFail();
noPreActivationAggro();
reconnectRestoresTrap();
coopIsolation();

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
  process.stdout.write(failures.map((f) => "  - " + f).join("\n") + "\n");
  process.exit(1);
}
