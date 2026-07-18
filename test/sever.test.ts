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
  check("PROTOCOL_VERSION is 47 (contested hearth after the pet abilities roster)", PROTOCOL_VERSION === 47);
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
    && "worldsplitPhase" in w.encounter.flags
    && "worldsplitToothId" in w.encounter.flags
    && "worldsplitOutcome" in w.encounter.flags);
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

  // Soft-fail the escape meter to max. Sever has NO other damage path (the body is guarded
  // until a window), so this MUST open the exit — the run can never softlock on F55.
  w.encounter.flags.escapeMeter = SEVER.escapeMeterMax;
  step(w, 2);
  check("escape soft-fail OPENS the exit (no Sev-0 softlock)", isFloorCleared(w) === true);
  check("the hunt resolves failed/escaped (worsened route, not a wipe)",
    w.encounter.failed === true && w.encounter.flags.interceptState === "escaped" && w.encounter.completed === true);
  check("escape does not kill players", [...w.players.values()].every((pl) => pl.hp > 0));
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
  check("both anchors broken opens intercept window", w.encounter.flags.interceptState === "exposed");
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

function severNoSoftlock(): void {
  section("Sev-0 fail-safe: stuck party never softlocks F55 (anchors never broken)");
  const w = createWorld(0x50FA, 55, {});
  loadFloorIntoWorld(w, 55);
  const boss = w.enemies.find((e) => e.kind === "sever");
  if (!boss || !w.encounter) { check("sever for no-softlock", false); return; }
  const p = w.players.get(LOCAL_ID)!;
  p.x = boss.x + 40; p.y = boss.y; p.invuln = 999;
  boss.spawnTimer = 0;
  boss.attack.cooldown = 999; // suppress WORLDSPLIT — with anchors never broken there is NO damage path
  step(w, 3);
  check("encounter active with the boss fully guarded", w.encounter.active === true);
  const hp0 = boss.hp;
  // Glue a LIVING player to Sever (so the escape meter never bumps) and never break an anchor:
  // the stall watchdog is the ONLY thing that can save the run.
  const budget = Math.ceil((SEVER.stallFailoverSec + 90) / DT);
  let clearedAt = -1;
  for (let i = 0; i < budget; i++) {
    p.x = boss.x + 40; p.y = boss.y; p.invuln = 999; p.isDown = false; p.hp = Math.max(p.hp, 1);
    step(w, 1);
    if (isFloorCleared(w)) { clearedAt = i; break; }
  }
  check("fail-safe opens the exit before an infinite softlock", clearedAt >= 0, `clearedAt=${clearedAt}`);
  check("fail-safe dealt the boss no damage (guard intact — HP only drops in windows)", boss.hp === hp0, `hp=${boss.hp}/${hp0}`);
  check("hunt resolves as a soft escape, not a wipe",
    w.encounter.failed === true && w.encounter.flags.interceptState === "escaped");
  check("floor completes via the encounter path (boss still alive)",
    w.encounter.completed === true && !boss.dead);
  check("no player was killed by the fail-safe", [...w.players.values()].every((pl) => pl.hp > 0));
}

function anchorReadability(): void {
  section("Anchors readable + distinguishable (client render hooks)");
  // Copy: the hunt objective LEADS with the live action so players know what to shoot NOW.
  const copyAnchors = encounterObjectiveCopy({
    kind: "hunt", progress: 0.2, checkpoint: 0, carrierId: null, completed: false, mechanic: "anchors",
  });
  const copyTooth = encounterObjectiveCopy({
    kind: "hunt", progress: 0.5, checkpoint: 1, carrierId: null, completed: false, mechanic: "tooth",
  });
  const copyIdle = encounterObjectiveCopy({
    kind: "hunt", progress: 0.5, checkpoint: 1, carrierId: null, completed: false, mechanic: null,
  });
  check("trap copy says BREAK THE EXIT ANCHORS", !!copyAnchors && copyAnchors.includes("BREAK THE EXIT ANCHORS"));
  check("WORLDSPLIT copy says BREAK THE TOOTH", !!copyTooth && copyTooth.includes("BREAK THE TOOTH"));
  check("no break-target falls back to WORLDSPLIT brand", !!copyIdle && copyIdle.includes("WORLDSPLIT") && !copyIdle.includes("BREAK"));

  // Live plant: exactly 2 intercept anchors, aux===0 (distinct from the aux===1 tooth), at
  // clearly separate positions — never piled on each other or the boss body.
  const w = createWorld(0xAEAD, 55, {});
  loadFloorIntoWorld(w, 55);
  const boss = w.enemies.find((e) => e.kind === "sever");
  if (!boss || !w.encounter) { check("sever for anchor readability", false); return; }
  const p = w.players.get(LOCAL_ID)!;
  p.x = boss.x + 40; p.y = boss.y; p.invuln = 999;
  boss.spawnTimer = 0;
  step(w, 3);
  const anchors = w.enemies.filter((e) => e.kind === "sever_anchor" && !e.dead);
  check("CP0 plant yields 2 living anchors", anchors.length === 2, `n=${anchors.length}`);
  check("intercept anchors ride aux===0 (tooth is aux===1)", anchors.length === 2 && anchors.every((a) => a.aux === 0));
  if (anchors.length === 2) {
    const [a0, a1] = anchors;
    const sep = Math.hypot(a0.x - a1.x, a0.y - a1.y);
    check("the two anchors are visibly separated (not piled)", sep > TILE, `sep=${sep.toFixed(1)}`);
    check("neither anchor is colocated with the boss body",
      Math.hypot(a0.x - boss.x, a0.y - boss.y) > TILE && Math.hypot(a1.x - boss.x, a1.y - boss.y) > TILE);
  }
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


function worldsplitToothSuccess(): void {
  section("WORLDSPLIT success requires dedicated tooth break (not intercept exposed)");
  const w = createWorld(0x7017, 55, {});
  w.isGodMode = true;
  loadFloorIntoWorld(w, 55);
  const boss = w.enemies.find((e) => e.kind === "sever");
  if (!boss || !w.encounter || !boss.boss) { check("sever for tooth success", false); return; }
  w.encounter.active = true;
  w.encounter.flags.interceptState = "hunt";
  // Keep intercept anchors out of the success path — kill them but do NOT leave exposed.
  boss.boss.windowAddIds.length = 0;
  for (const a of w.enemies) if (a.kind === "sever_anchor") a.dead = true;
  boss.boss.exposed = 0;
  boss.boss.windowBank = 0;
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;
  const p = w.players.get(LOCAL_ID)!;
  p.x = boss.x + 80; p.y = boss.y; p.invuln = 999;

  // Drive until WORLDSPLIT plant starts and tooth is live.
  let tooth: ReturnType<typeof w.enemies.find> = undefined;
  for (let i = 0; i < 80; i++) {
    step(w, 1);
    if (boss.attack.move === "worldsplit" && boss.attack.phase === "windup") {
      const tid = Number(w.encounter.flags.worldsplitToothId);
      tooth = w.enemies.find((e) => e.id === tid && e.kind === "sever_anchor" && !e.dead);
      if (tooth) break;
    }
  }
  check("WORLDSPLIT plant spawns dedicated tooth", !!tooth, `toothId=${w.encounter.flags.worldsplitToothId}`);
  check("tooth is distinct from intercept windowAddIds",
    !!tooth && boss.boss.windowAddIds.indexOf(tooth!.id) < 0);
  check("tooth highlighted via aux", !!tooth && tooth!.aux === 1);

  // Break the WORLDSPLIT tooth during plant/fracture.
  if (tooth) { tooth.hp = 0; tooth.dead = true; }
  // Ensure intercept did not sneak an exposure in.
  const exposedBefore = boss.boss.exposed;
  for (let i = 0; i < 120; i++) {
    step(w, 1);
    if (w.encounter.flags.worldsplitOutcome === "success") break;
    if (boss.attack.move === "worldsplit" && boss.attack.phase === "recover") break;
  }
  check("outcome is success after tooth break", w.encounter.flags.worldsplitOutcome === "success",
    `outcome=${w.encounter.flags.worldsplitOutcome}`);
  check("blades jam → openBossWindow(worldsplitPunish)", (boss.boss.exposed ?? 0) > 0,
    `exposed=${boss.boss.exposed} before=${exposedBefore}`);
  // Punish window should be ~3.0s (may be slightly less if a tick already drained).
  check("punish window armed near 3.0s", (boss.boss.exposed ?? 0) >= SEVER.worldsplitPunish - FIXED_DT * 2,
    `exposed=${boss.boss.exposed}`);
}

function worldsplitSurvivalOnly(): void {
  section("WORLDSPLIT survival-only path: cross band, NO window");
  const w = createWorld(0x5017, 55, {});
  w.isGodMode = true;
  loadFloorIntoWorld(w, 55);
  const boss = w.enemies.find((e) => e.kind === "sever");
  if (!boss || !w.encounter || !boss.boss) { check("sever for survival", false); return; }
  w.encounter.active = true;
  w.encounter.flags.interceptState = "hunt";
  boss.boss.windowAddIds.length = 0;
  for (const a of w.enemies) if (a.kind === "sever_anchor") a.dead = true;
  boss.boss.exposed = 0;
  boss.boss.windowBank = 0;
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;
  const p = w.players.get(LOCAL_ID)!;
  p.x = boss.x + 80; p.y = boss.y; p.invuln = 999; // dash/iframe crossing

  for (let i = 0; i < 200; i++) {
    // Keep player on the fracture band while invuln so survival fires; leave tooth alive.
    step(w, 1);
    if (boss.attack.move === "worldsplit" && boss.attack.phase === "active") {
      // Sit on the locked ray so the band check sees an invuln cross.
      p.x = boss.x + Math.cos(boss.attack.lockedAngle) * 40;
      p.y = boss.y + Math.sin(boss.attack.lockedAngle) * 40;
      p.invuln = 999;
    }
    if (w.encounter.flags.worldsplitOutcome === "survival"
      || w.encounter.flags.worldsplitOutcome === "failure"
      || w.encounter.flags.worldsplitOutcome === "success") break;
  }
  check("survival (or soft failure) without tooth break — not success",
    w.encounter.flags.worldsplitOutcome === "survival"
    || w.encounter.flags.worldsplitOutcome === "failure",
    `outcome=${w.encounter.flags.worldsplitOutcome}`);
  check("survival-only does NOT open WORLDSPLIT window",
    w.encounter.flags.worldsplitOutcome !== "success" && (boss.boss.exposed ?? 0) === 0,
    `exposed=${boss.boss.exposed} outcome=${w.encounter.flags.worldsplitOutcome}`);
  check("tooth left unbroken (or cleared without success credit)",
    w.encounter.flags.worldsplitToothBroken !== true
    || w.encounter.flags.worldsplitOutcome !== "success");
}

function interceptIndependentOfWorldsplit(): void {
  section("Intercept 2-anchor trap opens window independently of WORLDSPLIT");
  const w = createWorld(0xA17C, 55, {});
  loadFloorIntoWorld(w, 55);
  const boss = w.enemies.find((e) => e.kind === "sever");
  if (!boss || !w.encounter || !boss.boss) { check("sever for intercept independence", false); return; }
  // Suppress WORLDSPLIT so intercept is the only verb under test.
  boss.spawnTimer = 0;
  boss.attack.cooldown = 999;
  const p = w.players.get(LOCAL_ID)!;
  p.x = boss.x + 40; p.y = boss.y; p.invuln = 999;
  step(w, 3);
  check("encounter active for intercept", w.encounter.active === true);
  const trapAnchors = w.enemies.filter((e) =>
    e.kind === "sever_anchor" && !e.dead && boss.boss!.windowAddIds.indexOf(e.id) >= 0);
  check("intercept planted exactly 2 trap anchors", trapAnchors.length === 2, `n=${trapAnchors.length}`);
  // Fabricate a stale exposed=0 and ensure WORLDSPLIT tooth flag is idle.
  w.encounter.flags.worldsplitOutcome = "idle";
  w.encounter.flags.worldsplitToothBroken = false;
  for (const a of trapAnchors) { a.hp = 0; a.dead = true; }
  step(w, 2);
  check("intercept opens window without WORLDSPLIT success",
    w.encounter.flags.interceptState === "exposed" && (boss.boss.exposed ?? 0) > 0);
  check("WORLDSPLIT outcome untouched by intercept",
    w.encounter.flags.worldsplitOutcome === "idle"
    || w.encounter.flags.worldsplitOutcome === "pending");
  check("WORLDSPLIT tooth-broken flag not set by intercept",
    w.encounter.flags.worldsplitToothBroken !== true);
}


pinGates();
huntBlueprint();
encounterFlagsAndReconnect();
worldsplitTimings();
worldsplitLive();
worldsplitToothSuccess();
worldsplitSurvivalOnly();
interceptIndependentOfWorldsplit();
fleeAcrossEdges();
severNoSoftlock();
anchorsAndWindow();
lateJoinCheckpoint();
carrierHudPip();
anchorReadability();
noPreActivationAggro();

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
  process.stdout.write(failures.map((f) => "  - " + f).join("\n") + "\n");
  process.exit(1);
}
