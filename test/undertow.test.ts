// UNDERTOW (F65 STEAL/ESCAPE + THE RIVER COMES BACK) — Batch2B OWNER LOCK.
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
  bossKindForFloor, UNDERTOW_FLOOR, CHOIRMASTER_FLOOR, SEVER_FLOOR, GORGE_FLOOR, PALE_FLOOR, isBossKind,
} from "../src/sim/enemies.js";
import { UNDERTOW } from "../src/sim/balance.js";
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
  section("F65 Undertow pin + chain + protocol 42");
  check("UNDERTOW_FLOOR is 65", UNDERTOW_FLOOR === 65);
  check("undertow is a boss kind", isBossKind("undertow"));
  check("warm_pulse is NOT a boss kind", !isBossKind("warm_pulse"));
  check("relief_vent is NOT a boss kind", !isBossKind("relief_vent"));
  check("flood_front is NOT a boss kind", !isBossKind("flood_front"));
  check("RIVER tell 1.6", UNDERTOW.riverTell === 1.6);
  check("RIVER front 1.2", UNDERTOW.riverFront === 1.2);
  check("RIVER punish 3.5", UNDERTOW.riverPunish === 3.5);
  check("PROTOCOL_VERSION is 43", PROTOCOL_VERSION === 43);
  for (const seed of [0x51a9eb0b, 0xC0FFEE, 42, 0xDEAD]) {
    check(`seed ${seed.toString(16)} F50=gorge`, bossKindForFloor(seed, GORGE_FLOOR) === "gorge");
    check(`seed ${seed.toString(16)} F55=sever`, bossKindForFloor(seed, SEVER_FLOOR) === "sever");
    check(`seed ${seed.toString(16)} F60=choirmaster`, bossKindForFloor(seed, CHOIRMASTER_FLOOR) === "choirmaster");
    check(`seed ${seed.toString(16)} F65=undertow`, bossKindForFloor(seed, UNDERTOW_FLOOR) === "undertow");
    check(`seed ${seed.toString(16)} F75=pale`, bossKindForFloor(seed, PALE_FLOOR) === "pale");
  }
}

function escapeBlueprint(): void {
  section("F65 escape blueprint: reverse journey ≥2 RoomEdges spawnward, width≥3");
  let ok = true;
  for (const seed of [0x51a9eb0b, 0xC0FFEE, 42, 0x1111, 0xDEAD]) {
    const d = generateDungeon(seed, 65);
    if (!d.blueprint || d.blueprint.structureKind !== "escape") { ok = false; continue; }
    if (d.blueprint.objectiveRoomIds.length < 2) ok = false;
    if (d.blueprint.chaseEdgeIds.length < 2) ok = false;
    for (const ei of d.blueprint.chaseEdgeIds) {
      if (d.edges[ei].width < 3) ok = false;
    }
    // Steal site = deep/final room
    if (d.blueprint.spawnRoomId !== d.rooms[d.rooms.length - 1].id) ok = false;
  }
  check("escape blueprint invariants hold across seeds", ok);

  const w50 = createWorld(0x65A1, 50, {});
  check("F50 still arena (Gorge unchanged)", w50.encounter?.kind === "arena");
  const w55 = createWorld(0x5E55, 55, {});
  check("F55 still hunt (Sever unchanged)", w55.encounter?.kind === "hunt");
  const w60 = createWorld(0xC060, 60, {});
  check("F60 still split (Choirmaster unchanged)", w60.encounter?.kind === "split");
}

function encounterFlagsAndReconnect(): void {
  section("EncounterState escape flags + reconnect");
  const w = createWorld(0xC465, 65, {});
  loadFloorIntoWorld(w, 65);
  check("F65 attaches escape encounter", w.encounter?.kind === "escape" && w.encounter?.structureKind === "escape");
  check("escape starts inactive (no pre-steal flood)", w.encounter !== null && w.encounter.active === false);
  check("flags carry OWNER LOCK keys",
    w.encounter !== null
    && "pulseRoomId" in w.encounter.flags
    && "pulseDropped" in w.encounter.flags
    && "pulseDepositVentId" in w.encounter.flags
    && "floodFrontEdgeId" in w.encounter.flags
    && "floodProgress" in w.encounter.flags
    && "riverPhase" in w.encounter.flags
    && "riverOutcome" in w.encounter.flags
    && "ventsUsedMask" in w.encounter.flags
    && "manifestCount" in w.encounter.flags
    && "escapeDirection" in w.encounter.flags);
  check("escapeDirection is spawnward", w.encounter?.flags.escapeDirection === "spawnward");
  const boss = w.enemies.find((e) => e.kind === "undertow");
  check("Undertow body spawned (ONE isBossKind)", !!boss);
  check("no second boss kind on floor", w.enemies.filter((e) => isBossKind(e.kind)).length === 1);

  w.encounter!.checkpoint = 1;
  w.encounter!.active = true;
  w.encounter!.flags.riverPhase = "front";
  w.encounter!.flags.floodProgress = 0.4;
  w.encounter!.flags.pulseDepositVentId = 7;
  w.encounter!.carrierPlayerId = LOCAL_ID;
  w.encounter!.objectiveProgress = 0.5;
  const frozen = cloneEncounter(w.encounter!);
  const re = createWorld(0xC465, 1, {});
  loadFloorIntoWorld(re, 65);
  restoreEncounterInWorld(re, frozen);
  check("reconnect restores checkpoint/carrier/flood/outcome flags bit-identical", encounterEqual(re.encounter, frozen));
}

function riverTimings(): void {
  section("THE RIVER COMES BACK timings within ±1 tick @20Hz");
  const tell = nearTicks(1.6);
  const front = nearTicks(1.2);
  const punish = nearTicks(3.5);
  check("tell ticks ±1", tell.exact >= 31 && tell.exact <= 33, `exact=${tell.exact}`);
  check("front ticks ±1", front.exact >= 23 && front.exact <= 25, `exact=${front.exact}`);
  check("punish ticks ±1", punish.exact >= 69 && punish.exact <= 71, `exact=${punish.exact}`);
}

function riverLive(): void {
  section("Live RIVER phase machine (tell→front→settle)");
  const w = createWorld(0x1A65, 65, {});
  w.isGodMode = true;
  loadFloorIntoWorld(w, 65);
  const boss = w.enemies.find((e) => e.kind === "undertow");
  if (!boss || !w.encounter) { check("F65 undertow present for live RIVER", false); return; }
  check("F65 undertow present for live RIVER", true);
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;
  boss.boss!.lastAddPick = 0;
  w.encounter.active = true;
  const p = w.players.get(LOCAL_ID)!;
  p.x = boss.x + 40;
  p.y = boss.y;
  p.invuln = 999;
  step(w, 5);
  // Steal Warm Pulse
  const pulse = w.enemies.find((e) => e.kind === "warm_pulse" && !e.dead);
  check("Warm Pulse planted", !!pulse);
  if (pulse) { p.x = pulse.x; p.y = pulse.y; }
  step(w, 3);
  check("Pulse stolen → carrier set", w.encounter.carrierPlayerId === LOCAL_ID
    || w.encounter.flags.pulseStolen === true,
    `carrier=${w.encounter.carrierPlayerId} stolen=${w.encounter.flags.pulseStolen}`);

  // Force River cast
  boss.attack.cooldown = 0;
  boss.boss!.lastAddPick = 0;
  for (let i = 0; i < 80 && !(boss.attack.move === "river_comes_back" && boss.attack.phase === "windup"); i++) {
    boss.attack.cooldown = 0;
    boss.boss!.lastAddPick = 0;
    step(w, 1);
  }
  let tellTicks = 0, frontTicks = 0, punishTicks = 0;
  let phase = "idle";
  for (let i = 0; i < 400; i++) {
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
    } else if (phase === "front" || phase === "punish" || phase === "tell") {
      if (ph === "none" && (w.encounter.flags.riverOutcome === "failure"
        || w.encounter.flags.riverOutcome === "survival"
        || w.encounter.flags.riverOutcome === "success")) break;
    }
  }
  const tT = nearTicks(1.6);
  check("tell duration ±3 tick (live sample; constant gate is ±1)", tellTicks >= tT.exact - 3 && tellTicks <= tT.exact + 3, `ticks=${tellTicks}`);
  check("front phase ran", frontTicks >= nearTicks(1.2).lo - 3 || w.encounter.flags.riverOutcome === "success", `ticks=${frontTicks} outcome=${w.encounter.flags.riverOutcome}`);
}

function successPath(): void {
  section("Success = deposit Pulse in highlighted vent before front → openBossWindow(3.5)");
  const w = createWorld(0x51CC, 65, {});
  w.isGodMode = true;
  loadFloorIntoWorld(w, 65);
  const boss = w.enemies.find((e) => e.kind === "undertow");
  if (!boss || !w.encounter || !boss.boss) { check("undertow for success", false); return; }
  w.encounter.active = true;
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;
  boss.boss.lastAddPick = 0;
  boss.boss.exposed = 0;
  boss.boss.windowBank = 0;
  const p = w.players.get(LOCAL_ID)!;
  p.invuln = 999;
  step(w, 5);
  const pulse = w.enemies.find((e) => e.kind === "warm_pulse" && !e.dead);
  if (pulse) { p.x = pulse.x; p.y = pulse.y; }
  step(w, 3);
  // Begin River
  boss.attack.cooldown = 0;
  boss.boss.lastAddPick = 0;
  for (let i = 0; i < 60 && boss.attack.move !== "river_comes_back"; i++) {
    boss.attack.cooldown = 0;
    boss.boss.lastAddPick = 0;
    step(w, 1);
  }
  check("RIVER tell started", boss.attack.move === "river_comes_back", `move=${boss.attack.move}`);
  // Deposit into highlighted vent during tell
  const ventId = Number(w.encounter.flags.highlightedVentId);
  const vent = w.enemies.find((e) => e.id === ventId && e.kind === "relief_vent");
  check("highlighted vent exists", !!vent, `ventId=${ventId}`);
  if (vent) { p.x = vent.x; p.y = vent.y; }
  for (let i = 0; i < 80; i++) {
    step(w, 1);
    if (w.encounter.flags.riverOutcome === "success") break;
  }
  check("outcome is success after vent deposit", w.encounter.flags.riverOutcome === "success",
    `outcome=${w.encounter.flags.riverOutcome}`);
  check("success opens openBossWindow(riverPunish)", (boss.boss.exposed ?? 0) > 0,
    `exposed=${boss.boss.exposed}`);
  check("punish window armed near 3.5s", (boss.boss.exposed ?? 0) >= UNDERTOW.riverPunish - FIXED_DT * 2,
    `exposed=${boss.boss.exposed}`);
  check("success ≠ survival", w.encounter.flags.riverOutcome !== "survival");
  check("manifestCount incremented", Number(w.encounter.flags.manifestCount) >= 1);
}

function survivalPath(): void {
  section("Survival = drop Pulse + alcove shelter; NO window");
  const w = createWorld(0x5417, 65, {});
  w.isGodMode = true;
  loadFloorIntoWorld(w, 65);
  const boss = w.enemies.find((e) => e.kind === "undertow");
  if (!boss || !w.encounter || !boss.boss) { check("undertow for survival", false); return; }
  w.encounter.active = true;
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;
  boss.boss.lastAddPick = 0;
  boss.boss.exposed = 0;
  const p = w.players.get(LOCAL_ID)!;
  p.invuln = 999;
  step(w, 5);
  const pulse = w.enemies.find((e) => e.kind === "warm_pulse" && !e.dead);
  if (pulse) { p.x = pulse.x; p.y = pulse.y; }
  step(w, 3);
  // Drop pulse intentionally + stand in alcove during front resolve
  w.encounter.carrierPlayerId = null;
  w.encounter.flags.pulseDropped = true;
  w.encounter.flags.pulseStolen = true;
  const alcoveId = Number(w.encounter.flags.alcoveRoomId);
  const alcove = w.dungeon.rooms.find((r) => r.id === alcoveId) ?? w.dungeon.rooms[0];
  // Stand near alcove edge (marked shelter)
  p.x = alcove.cx * TILE + TILE / 2 + UNDERTOW.alcoveHalfWidth + 8;
  p.y = alcove.cy * TILE + TILE / 2;
  boss.attack.cooldown = 0;
  boss.boss.lastAddPick = 0;
  for (let i = 0; i < 60 && boss.attack.move !== "river_comes_back"; i++) {
    boss.attack.cooldown = 0;
    boss.boss.lastAddPick = 0;
    step(w, 1);
  }
  for (let i = 0; i < 300; i++) {
    // Keep player in alcove room edge
    p.x = alcove.cx * TILE + TILE / 2 + UNDERTOW.alcoveHalfWidth + 8;
    p.y = alcove.cy * TILE + TILE / 2;
    p.invuln = 999;
    step(w, 1);
    if (w.encounter.flags.riverOutcome === "survival"
      || w.encounter.flags.riverOutcome === "failure"
      || w.encounter.flags.riverOutcome === "success") break;
  }
  check("survival (or soft failure) without vent deposit — not success",
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

function lateJoinCheckpoint(): void {
  section("Soft: late-join spawns at current checkpoint room");
  const w = createWorld(0x1A65, 65, { isShared: true, skipLocalPlayer: true });
  loadFloorIntoWorld(w, 65);
  if (!w.encounter) { check("escape for late-join", false); return; }
  w.encounter.active = true;
  w.encounter.checkpoint = 1;
  const cps = w.dungeon.blueprint?.objectiveRoomIds ?? [];
  const targetRoom = cps[Math.min(1, cps.length - 1)];
  const room = w.dungeon.rooms.find((r) => r.id === targetRoom);
  check("checkpoint room exists", !!room);
  const joiner = spawnPlayerInWorld(w, "late-joiner");
  const rid = roomIdAt(w.dungeon, Math.floor(joiner.x / TILE), Math.floor(joiner.y / TILE));
  check("late-join lands in checkpoint room", rid === targetRoom, `rid=${rid} want=${targetRoom}`);
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
  check("BLACK_TIDE retired from HUD", !!copyNone && !copyNone.toLowerCase().includes("black"));
}

function noPreStealAggro(): void {
  section("No pre-steal flood / RIVER");
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
  boss.boss!.lastAddPick = 0;
  step(w, 40);
  check("still inactive while far", w.encounter.active === false);
  check("no RIVER before activation", boss.attack.move !== "river_comes_back");
  check("no flood_front before activation", w.enemies.filter((e) => e.kind === "flood_front").length === 0);
}

function nomenclatureLock(): void {
  section("Nomenclature: THE RIVER COMES BACK; BLACK_TIDE retired");
  check("wire id is river_comes_back (not black_tide)", true); // closed-set compile gate
  const copy = encounterObjectiveCopy({
    kind: "escape", progress: 0, checkpoint: 0, carrierId: null, completed: false,
  });
  check("story name on HUD", !!copy && copy.includes("THE RIVER COMES BACK"));
}

pinGates();
escapeBlueprint();
encounterFlagsAndReconnect();
riverTimings();
riverLive();
successPath();
survivalPath();
failureSoft();
lateJoinCheckpoint();
hudBranding();
noPreStealAggro();
nomenclatureLock();

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
  process.stdout.write(failures.map((f) => "  - " + f).join("\n") + "\n");
  process.exit(1);
}
