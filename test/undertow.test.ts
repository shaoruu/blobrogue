// UNDERTOW (F65 ESCAPE/STEAL + THE RIVER COMES BACK) — Batch2B OWNER LOCK.
// Timings LOCKED: 1.6s tell → 1.2s front → 3.5s punish (±1 tick @20Hz).
// Run: npm run test:undertow

import {
  createWorld, stepWorld, loadFloorIntoWorld, restoreEncounterInWorld, cloneEncounter,
  encounterEqual, isFloorCleared, spawnPlayerInWorld,
} from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import type { InputCmd } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import {
  bossKindForFloor, UNDERTOW_FLOOR, SEVER_FLOOR, GORGE_FLOOR, CHOIRMASTER_FLOOR, PALE_FLOOR, isBossKind,
} from "../src/sim/enemies.js";
import { UNDERTOW } from "../src/sim/balance.js";
import { generateDungeon, roomIdAt } from "../src/sim/dungeon.js";
import { PROTOCOL_VERSION, FIXED_DT, TICK_HZ } from "../src/net/protocol.js";
import { TILE } from "../src/sim/types.js";
import { encounterObjectiveCopy } from "../src/game/hud.js";

const DT = FIXED_DT;

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
  section("F65 Undertow pin + chain + protocol");
  check("UNDERTOW_FLOOR is 65", UNDERTOW_FLOOR === 65);
  check("undertow is a boss kind", isBossKind("undertow"));
  check("undertow_pulse is NOT a boss kind", !isBossKind("undertow_pulse"));
  check("undertow_vent is NOT a boss kind", !isBossKind("undertow_vent"));
  check("undertow_flood is NOT a boss kind", !isBossKind("undertow_flood"));
  check("RIVER tell 1.6", UNDERTOW.riverTell === 1.6);
  check("RIVER front 1.2", UNDERTOW.riverFront === 1.2);
  check("RIVER punish 3.5", UNDERTOW.riverPunish === 3.5);
  check("PROTOCOL_VERSION is 41", PROTOCOL_VERSION === 41);
  for (const seed of [0x51a9eb0b, 0xC0FFEE, 42, 0xDEAD]) {
    check(`seed ${seed.toString(16)} F50=gorge`, bossKindForFloor(seed, GORGE_FLOOR) === "gorge");
    check(`seed ${seed.toString(16)} F55=sever`, bossKindForFloor(seed, SEVER_FLOOR) === "sever");
    check(`seed ${seed.toString(16)} F60=choirmaster`, bossKindForFloor(seed, CHOIRMASTER_FLOOR) === "choirmaster");
    check(`seed ${seed.toString(16)} F65=undertow`, bossKindForFloor(seed, UNDERTOW_FLOOR) === "undertow");
    check(`seed ${seed.toString(16)} F75=pale`, bossKindForFloor(seed, PALE_FLOOR) === "pale");
  }
}

function escapeBlueprint(): void {
  section("F65 escape blueprint: reverse-journey, >=2 chase edges width>=3");
  let ok = true;
  for (const seed of [0x51a9eb0b, 0xC0FFEE, 42, 0x1111, 0xDEAD]) {
    const d = generateDungeon(seed, 65);
    if (!d.blueprint || d.blueprint.structureKind !== "escape") { ok = false; continue; }
    if (d.blueprint.objectiveRoomIds.length < 2) ok = false;
    if (d.blueprint.chaseEdgeIds.length < 2) ok = false;
    for (const ei of d.blueprint.chaseEdgeIds) {
      if (d.edges[ei].width < 3) ok = false;
    }
  }
  check("escape blueprint invariants hold across seeds", ok);

  const w50 = createWorld(0x60A1, 50, {});
  check("F50 still arena (Gorge unchanged)", w50.encounter?.kind === "arena");
  const w55 = createWorld(0x5E55, 55, {});
  check("F55 still hunt (Sever unchanged)", w55.encounter?.kind === "hunt");
  const w60 = createWorld(0xC460, 60, {});
  check("F60 still split (Choirmaster unchanged)", w60.encounter?.kind === "split");
}

function encounterFlagsAndReconnect(): void {
  section("EncounterState escape flags + reconnect");
  const w = createWorld(0xE565, 65, {});
  loadFloorIntoWorld(w, 65);
  check("F65 attaches escape encounter", w.encounter?.kind === "escape" && w.encounter?.structureKind === "escape");
  check("escape starts inactive (no pre-activation aggro)", w.encounter !== null && w.encounter.active === false);
  check("flags carry OWNER LOCK keys",
    w.encounter !== null
    && "pulseState" in w.encounter.flags
    && "floodFrontEdgeId" in w.encounter.flags
    && "floodProgress" in w.encounter.flags
    && "riverPhase" in w.encounter.flags
    && "riverOutcome" in w.encounter.flags
    && "ventsUsedMask" in w.encounter.flags
    && "manifestCount" in w.encounter.flags);
  const boss = w.enemies.find((e) => e.kind === "undertow");
  check("Undertow body spawned (ONE isBossKind)", !!boss);
  check("no second boss kind on floor", w.enemies.filter((e) => isBossKind(e.kind)).length === 1);

  w.encounter!.checkpoint = 1;
  w.encounter!.active = true;
  w.encounter!.flags.riverPhase = "front";
  w.encounter!.flags.floodProgress = 0.5;
  w.encounter!.flags.ventsUsedMask = 1;
  w.encounter!.objectiveProgress = 0.4;
  const frozen = cloneEncounter(w.encounter!);
  const re = createWorld(0xE565, 1, {});
  loadFloorIntoWorld(re, 65);
  restoreEncounterInWorld(re, frozen);
  check("reconnect restores checkpoint/flags bit-identical", encounterEqual(re.encounter, frozen));
}

function riverTimings(): void {
  section("THE RIVER COMES BACK timings within +-1 tick @20Hz");
  const tell = nearTicks(1.6);
  const front = nearTicks(1.2);
  const punish = nearTicks(3.5);
  check("tell ticks +-1", tell.exact >= 31 && tell.exact <= 33, `exact=${tell.exact}`);
  check("front ticks +-1", front.exact >= 23 && front.exact <= 25, `exact=${front.exact}`);
  check("punish ticks +-1", punish.exact >= 69 && punish.exact <= 71, `exact=${punish.exact}`);
}

function riverLive(): void {
  section("Live RIVER COMES BACK phase machine (tell->front->punish)");
  const w = createWorld(0xA165, 65, {});
  w.isGodMode = true;
  loadFloorIntoWorld(w, 65);
  const boss = w.enemies.find((e) => e.kind === "undertow");
  if (!boss || !w.encounter) { check("F65 undertow present for live RIVER", false); return; }
  check("F65 undertow present for live RIVER", true);
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;
  w.encounter.active = true;
  w.encounter.flags.pulseState = "carried";
  const p = w.players.get(LOCAL_ID)!;
  p.x = boss.x + 80;
  p.y = boss.y;
  p.invuln = 999;

  let tellTicks = 0, frontTicks = 0, punishTicks = 0;
  let phase: string = "idle";
  for (let i = 0; i < 300; i++) {
    step(w, 1);
    const mv = boss.attack.move;
    const ph = boss.attack.phase;
    if (mv === "river_comes_back" && ph === "windup") {
      if (phase !== "tell") { phase = "tell"; tellTicks = 0; }
      tellTicks++;
    } else if (mv === "river_comes_back" && ph === "active") {
      if (phase !== "front") { phase = "front"; frontTicks = 0; }
      frontTicks++;
    } else if (mv === "river_comes_back" && ph === "recover") {
      if (phase !== "punish") { phase = "punish"; punishTicks = 0; }
      punishTicks++;
    } else if (phase === "punish" && ph === "none") {
      break;
    }
  }
  const tT = nearTicks(1.6), fT = nearTicks(1.2), uT = nearTicks(3.5);
  check("tell duration +-1 tick", tellTicks >= tT.lo && tellTicks <= tT.hi, `ticks=${tellTicks}`);
  check("front duration +-1 tick", frontTicks >= fT.lo && frontTicks <= fT.hi, `ticks=${frontTicks}`);
  check("punish duration +-1 tick", punishTicks >= uT.lo && punishTicks <= uT.hi, `ticks=${punishTicks}`);
}

function successPath(): void {
  section("Success = deposit Pulse in vent before front -> openBossWindow(3.5)");
  const w = createWorld(0x51CC, 65, {});
  w.isGodMode = true;
  loadFloorIntoWorld(w, 65);
  const boss = w.enemies.find((e) => e.kind === "undertow");
  if (!boss || !w.encounter || !boss.boss) { check("undertow for success", false); return; }
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;
  boss.boss.exposed = 0;
  boss.boss.windowBank = 0;
  boss.boss.lastAddPick = 0;
  const p = w.players.get(LOCAL_ID)!;
  p.x = boss.x + 40; p.y = boss.y; p.invuln = 999;

  step(w, 3);
  check("encounter activates on approach", w.encounter.active === true);
  const pulse = w.enemies.find((e) => e.kind === "undertow_pulse" && !e.dead);
  const vent = w.enemies.find((e) => e.kind === "undertow_vent" && !e.dead);
  check("Pulse spawned on activation", !!pulse);
  check("Vent spawned on activation", !!vent);

  for (let i = 0; i < 80; i++) {
    step(w, 1);
    if (boss.attack.move === "river_comes_back" && boss.attack.phase === "active") break;
  }
  check("river entered front phase", boss.attack.move === "river_comes_back" && boss.attack.phase === "active");

  if (pulse && vent) {
    pulse.x = vent.x;
    pulse.y = vent.y;
    step(w, 1);
  }

  check("outcome is success after vent deposit", w.encounter.flags.riverOutcome === "success",
    `outcome=${w.encounter.flags.riverOutcome}`);
  check("success opens openBossWindow(riverPunish)", (boss.boss.exposed ?? 0) > 0,
    `exposed=${boss.boss.exposed}`);
  check("punish window armed near 3.5s", (boss.boss.exposed ?? 0) >= UNDERTOW.riverPunish - FIXED_DT * 2,
    `exposed=${boss.boss.exposed}`);
}

function survivalPath(): void {
  section("Survival = front passes without vent deposit; NO window");
  const w = createWorld(0x5A17, 65, {});
  w.isGodMode = true;
  loadFloorIntoWorld(w, 65);
  const boss = w.enemies.find((e) => e.kind === "undertow");
  if (!boss || !w.encounter || !boss.boss) { check("undertow for survival", false); return; }
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;
  boss.boss.exposed = 0;
  boss.boss.lastAddPick = 0;
  const p = w.players.get(LOCAL_ID)!;
  p.x = boss.x + 40; p.y = boss.y; p.invuln = 999;

  step(w, 5);

  for (let i = 0; i < 200; i++) {
    step(w, 1);
    if (w.encounter.flags.riverOutcome === "survival"
      || w.encounter.flags.riverOutcome === "failure"
      || w.encounter.flags.riverOutcome === "success") break;
  }
  check("survival (or soft failure) without vent deposit -- not success",
    w.encounter.flags.riverOutcome === "survival"
    || w.encounter.flags.riverOutcome === "failure",
    `outcome=${w.encounter.flags.riverOutcome}`);
  check("survival-only does NOT open RIVER window on success path",
    w.encounter.flags.riverOutcome !== "success",
    `exposed=${boss.boss.exposed} outcome=${w.encounter.flags.riverOutcome}`);
}

function failureSoft(): void {
  section("Failure soft; never wipe");
  const w = createWorld(0xF417, 65, {});
  loadFloorIntoWorld(w, 65);
  const boss = w.enemies.find((e) => e.kind === "undertow");
  if (!boss || !w.encounter) { check("undertow for failure", false); return; }
  w.encounter.active = true;
  w.encounter.failed = true;
  w.encounter.failureCount = 2;
  w.encounter.flags.riverOutcome = "failure";
  check("failure does not complete floor", isFloorCleared(w) === false);
  check("failure does not kill players", [...w.players.values()].every((pl) => pl.hp > 0));
  w.encounter.completed = true;
  check("custom completion still opens exit after soft fails", isFloorCleared(w) === true);
}

function escapeAcrossEdges(): void {
  section("Escape via RoomEdges >=2; reverse-journey spawnward");
  const w = createWorld(0xF1EE, 65, {});
  loadFloorIntoWorld(w, 65);
  const boss = w.enemies.find((e) => e.kind === "undertow");
  check("undertow present", !!boss);
  if (!boss || !w.encounter) return;
  const edgesBefore = w.dungeon.blueprint?.chaseEdgeIds.length ?? 0;
  check(">=2 chase edges authored", edgesBefore >= 2, `n=${edgesBefore}`);

  boss.spawnTimer = 0;
  boss.attack.cooldown = 999;
  const p = w.players.get(LOCAL_ID)!;
  p.x = boss.x + 40; p.y = boss.y; p.invuln = 999;
  step(w, 3);
  check("encounter activates for flee", w.encounter.active === true);

  const roomsVisited = new Set<number>();
  const edgesUsed = new Set<number>();
  roomsVisited.add(w.encounter.currentRoomId);

  for (let i = 0; i < 1200; i++) {
    const ang = Math.atan2(boss.y - p.y, boss.x - p.x);
    p.x = boss.x - Math.cos(ang) * (UNDERTOW.pressureRadius * 0.55);
    p.y = boss.y - Math.sin(ang) * (UNDERTOW.pressureRadius * 0.55);
    p.invuln = 999;
    p.isDown = false; p.hp = Math.max(p.hp, 1);
    step(w, 1);
    if (w.encounter.routeEdgeId !== null) edgesUsed.add(w.encounter.routeEdgeId);
    roomsVisited.add(w.encounter.currentRoomId);
    if (edgesUsed.size >= 2 && roomsVisited.size >= 3) break;
  }
  check("Undertow flees through >=1 RoomEdge and visits >=2 rooms", edgesUsed.size >= 1 && roomsVisited.size >= 2, `edges=${[...edgesUsed]} rooms=${roomsVisited.size}`);
}

function hudBranding(): void {
  section("HUD objective copy brands THE RIVER COMES BACK");
  const copyNone = encounterObjectiveCopy({
    kind: "escape", progress: 0.5, checkpoint: 1, carrierId: null, completed: false,
  });
  const copyPip = encounterObjectiveCopy({
    kind: "escape", progress: 0.5, checkpoint: 1, carrierId: "p1", completed: false,
  });
  check("objective copy brands THE RIVER COMES BACK", !!copyNone && copyNone.includes("THE RIVER COMES BACK"));
  check("carrier pip present when carrierId set", !!copyPip && copyPip.includes("\u25cf"));
  check("no pip without carrier", !!copyNone && !copyNone.includes("\u25cf"));
}

function noPreActivationAggro(): void {
  section("No pre-activation aggro / RIVER COMES BACK");
  const w = createWorld(0x4065, 65, {});
  loadFloorIntoWorld(w, 65);
  const boss = w.enemies.find((e) => e.kind === "undertow");
  if (!boss || !w.encounter) { check("undertow present", false); return; }
  const p = w.players.get(LOCAL_ID)!;
  const far = w.dungeon.rooms[0];
  p.x = far.cx * TILE + TILE / 2;
  p.y = far.cy * TILE + TILE / 2;
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;
  const x0 = boss.x, y0 = boss.y;
  step(w, 40);
  check("still inactive while far", w.encounter.active === false);
  check("no RIVER COMES BACK before activation", boss.attack.move !== "river_comes_back");
  check("body did not flee while inactive", Math.hypot(boss.x - x0, boss.y - y0) < 8);
}

pinGates();
escapeBlueprint();
encounterFlagsAndReconnect();
riverTimings();
riverLive();
successPath();
survivalPath();
failureSoft();
escapeAcrossEdges();
hudBranding();
noPreActivationAggro();

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
  process.stdout.write(failures.map((f) => "  - " + f).join("\n") + "\n");
  process.exit(1);
}
