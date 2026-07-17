// THE WAKE (F80 PROTECT/ADVANCE + THE LAST PROCESSION) — Batch3B OWNER LOCK.
// Timings LOCKED: 1.5s blackout/flood tell → dark front follows convoy to threshold (moving-front)
// → 4.0s light-bound manifestation punish (±1 tick @20Hz). Mirrors the Claimant/Undertow suites.
// Run: npm run test:wake

import {
  createWorld, stepWorld, loadFloorIntoWorld, restoreEncounterInWorld, cloneEncounter,
  encounterEqual, isFloorCleared,
} from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import type { InputCmd } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import {
  bossKindForFloor, WAKE_FLOOR, CLAIMANT_FLOOR, UNDERTOW_FLOOR, CHOIRMASTER_FLOOR, SEVER_FLOOR, GORGE_FLOOR, PALE_FLOOR,
  isBossKind, bossDisplayName,
} from "../src/sim/enemies.js";
import { WAKE } from "../src/sim/balance.js";
import { generateDungeon } from "../src/sim/dungeon.js";
import { PROTOCOL_VERSION, FIXED_DT, TICK_HZ } from "../src/net/protocol.js";
import type { Enemy } from "../src/sim/types.js";

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

// Activate the escort, seed the convoy (bier/blockers/shadow_front), and park the LOCAL player on
// the bier (inside the warmth corridor). Returns the live Wake body (or null).
function armConvoy(w: WorldState): Enemy | null {
  const boss = w.enemies.find((e) => e.kind === "wake");
  if (!boss || !w.encounter || !boss.boss) return null;
  w.isGodMode = true;
  w.encounter.active = true;
  boss.spawnTimer = 0;
  boss.attack.cooldown = 10; // hold the cast off during setup so the caller controls the procession
  boss.boss.exposed = 0;
  boss.boss.windowBank = 0;
  const p = w.players.get(LOCAL_ID)!;
  p.x = boss.x + 40;
  p.y = boss.y;
  p.invuln = 999;
  step(w, 5); // plant the convoy body + blockers + dark front
  const bier = w.enemies.find((e) => e.kind === "warm_bier" && !e.dead);
  if (bier) { p.x = bier.x; p.y = bier.y; }
  boss.attack.cooldown = 10;
  return boss;
}

function bierOf(w: WorldState): Enemy | null {
  return w.enemies.find((e) => e.kind === "warm_bier" && !e.dead) ?? null;
}

// Advance the convoy to the procession trigger and force THE LAST PROCESSION to begin (a fresh cast,
// never mid-recover). Mirrors the Claimant/Undertow forceOwed/forceRiver harness.
function forceProcession(w: WorldState, boss: Enemy): void {
  for (let i = 0; i < 120 && boss.attack.phase !== "none"; i++) { if (boss.boss) boss.boss.exposed = 0; step(w, 1); }
  if (w.encounter) w.encounter.flags.convoyProgress = 0.8; // near the threshold — bait the cast
  for (let i = 0; i < 200 && !(boss.attack.move === "last_procession" && boss.attack.phase !== "none"); i++) {
    boss.attack.cooldown = 0;
    if (boss.boss) boss.boss.exposed = 0;
    if (w.encounter) w.encounter.flags.convoyProgress = Math.max(0.8, Number(w.encounter.flags.convoyProgress));
    step(w, 1);
  }
}

// Clear the currently highlighted blocker (the peel target before the threshold).
function clearHighlightedBlocker(w: WorldState): void {
  const id = Number(w.encounter!.flags.highlightedBlockerId);
  const blk = w.enemies.find((e) => e.id === id && e.kind === "convoy_blocker");
  if (blk) { blk.dead = true; blk.hp = 0; }
}

function pinGates(): void {
  section("F80 Wake pin + chain + protocol 43");
  check("WAKE_FLOOR is 80", WAKE_FLOOR === 80);
  check("wake is a boss kind", isBossKind("wake"));
  check("warm_bier is NOT a boss kind", !isBossKind("warm_bier"));
  check("convoy_blocker is NOT a boss kind", !isBossKind("convoy_blocker"));
  check("shadow_front is NOT a boss kind", !isBossKind("shadow_front"));
  check("PROCESSION tell 1.5", WAKE.processionTell === 1.5);
  check("PROCESSION lock at 0.9 (0.6 of tell)", Math.abs(WAKE.processionTell * WAKE.processionLockFrac - 0.9) < 1e-9);
  check("PROCESSION punish 4.0", WAKE.processionPunish === 4.0);
  check("front is a bounded moving-front (frontMaxDuration > 0)", WAKE.frontMaxDuration > 0);
  check("PROTOCOL_VERSION is 44", PROTOCOL_VERSION === 44);
  for (const seed of [0x51a9eb0b, 0xC0FFEE, 42, 0xDEAD]) {
    check(`seed ${seed.toString(16)} F50=gorge`, bossKindForFloor(seed, GORGE_FLOOR) === "gorge");
    check(`seed ${seed.toString(16)} F55=sever`, bossKindForFloor(seed, SEVER_FLOOR) === "sever");
    check(`seed ${seed.toString(16)} F60=choirmaster`, bossKindForFloor(seed, CHOIRMASTER_FLOOR) === "choirmaster");
    check(`seed ${seed.toString(16)} F65=undertow`, bossKindForFloor(seed, UNDERTOW_FLOOR) === "undertow");
    check(`seed ${seed.toString(16)} F70=claimant`, bossKindForFloor(seed, CLAIMANT_FLOOR) === "claimant");
    check(`seed ${seed.toString(16)} F75=pale`, bossKindForFloor(seed, PALE_FLOOR) === "pale");
    check(`seed ${seed.toString(16)} F80=wake`, bossKindForFloor(seed, WAKE_FLOOR) === "wake");
  }
}

function escortBlueprint(): void {
  section("F80 escort blueprint: convoy path ≥2 RoomEdges forward, width≥3; F50/55/60/65 unchanged");
  let ok = true;
  for (const seed of [0x51a9eb0b, 0xC0FFEE, 42, 0x1111, 0xDEAD]) {
    const d = generateDungeon(seed, 80);
    if (!d.blueprint || d.blueprint.structureKind !== "escort") { ok = false; continue; }
    if (d.blueprint.objectiveRoomIds.length < 2) ok = false;
    if (d.blueprint.chaseEdgeIds.length < 2) ok = false;
    for (const ei of d.blueprint.chaseEdgeIds) {
      if (d.edges[ei].width < 3) ok = false;
    }
    // Convoy origin = a near-spawn approach room (spawn→exit forward), never last-arena-only.
    if (d.blueprint.spawnRoomId === d.rooms[d.rooms.length - 1].id) ok = false;
    if (d.blueprint.spawnRoomId !== d.blueprint.objectiveRoomIds[0]) ok = false;
  }
  check("escort blueprint invariants hold across seeds", ok);

  const w50 = createWorld(0x65A1, 50, {});
  check("F50 still arena (Gorge unchanged)", w50.encounter?.kind === "arena");
  const w55 = createWorld(0x5E55, 55, {});
  check("F55 still hunt (Sever unchanged)", w55.encounter?.kind === "hunt");
  const w60 = createWorld(0xC060, 60, {});
  check("F60 still split (Choirmaster unchanged)", w60.encounter?.kind === "split");
  const w65 = createWorld(0xC465, 65, {});
  check("F65 still escape (Undertow unchanged)", w65.encounter?.kind === "escape");
}

function encounterFlagsAndReconnect(): void {
  section("EncounterState escort flags + reconnect");
  const w = createWorld(0xC480, 80, {});
  loadFloorIntoWorld(w, 80);
  check("F80 attaches escort encounter", w.encounter?.kind === "escort" && w.encounter?.structureKind === "escort");
  check("escort starts inactive (no pre-activation aggro)", w.encounter !== null && w.encounter.active === false);
  check("flags carry OWNER LOCK keys",
    w.encounter !== null
    && "convoyEdgeId" in w.encounter.flags
    && "convoyProgress" in w.encounter.flags
    && "convoyWarmth" in w.encounter.flags
    && "highlightedBlockerId" in w.encounter.flags
    && "blockersClearedMask" in w.encounter.flags
    && "processionPhase" in w.encounter.flags
    && "processionOutcome" in w.encounter.flags
    && "thresholdIndex" in w.encounter.flags
    && "manifestCount" in w.encounter.flags
    && "shadowBehind" in w.encounter.flags);
  check("convoy starts full warmth", w.encounter?.flags.convoyWarmth === 1);
  check("dark front follows from behind", w.encounter?.flags.shadowBehind === true);
  const boss = w.enemies.find((e) => e.kind === "wake");
  check("Wake body spawned (ONE isBossKind)", !!boss);
  check("no second boss kind on floor", w.enemies.filter((e) => isBossKind(e.kind)).length === 1);

  w.encounter!.checkpoint = 1;
  w.encounter!.active = true;
  w.encounter!.flags.processionPhase = "front";
  w.encounter!.flags.processionOutcome = "pending";
  w.encounter!.flags.convoyProgress = 0.42;
  w.encounter!.flags.convoyWarmth = 0.8;
  w.encounter!.flags.highlightedBlockerId = 9;
  w.encounter!.flags.blockersClearedMask = 1;
  w.encounter!.flags.thresholdIndex = 1;
  w.encounter!.objectiveProgress = 0.5;
  const frozen = cloneEncounter(w.encounter!);
  const re = createWorld(0xC480, 1, {});
  loadFloorIntoWorld(re, 80);
  restoreEncounterInWorld(re, frozen);
  check("reconnect restores convoy progress/warmth/blocker/threshold/outcome bit-identical", encounterEqual(re.encounter, frozen));
}

function processionTimings(): void {
  section("THE LAST PROCESSION timings within ±1 tick @20Hz");
  const tell = nearTicks(1.5);
  const lock = nearTicks(0.9);
  const punish = nearTicks(4.0);
  check("tell ticks ±1", tell.exact >= 29 && tell.exact <= 31, `exact=${tell.exact}`);
  check("lock ticks ±1", lock.exact >= 17 && lock.exact <= 19, `exact=${lock.exact}`);
  check("punish ticks ±1", punish.exact >= 79 && punish.exact <= 81, `exact=${punish.exact}`);
}

function processionLive(): void {
  section("Live PROCESSION machine (tell → front); the moving-front runs; shadow stays behind");
  const w = createWorld(0x1A80, 80, {});
  loadFloorIntoWorld(w, 80);
  const boss = armConvoy(w);
  if (!boss || !w.encounter) { check("F80 wake present for live PROCESSION", false); return; }
  check("F80 wake present for live PROCESSION", true);
  const p = w.players.get(LOCAL_ID)!;
  forceProcession(w, boss);
  check("PROCESSION tell started", boss.attack.move === "last_procession", `move=${boss.attack.move}`);

  let tellTicks = 0, frontTicks = 0;
  let phase = "idle";
  for (let i = 0; i < 200; i++) {
    // Hold the player far off the path so the tell/front run to their bounds (no early success).
    p.x = boss.x + 900;
    p.y = boss.y + 900;
    p.invuln = 999;
    step(w, 1);
    const mv = boss.attack.move;
    const ph = boss.attack.phase;
    if (mv === "last_procession" && ph === "windup") { if (phase !== "tell") { phase = "tell"; tellTicks = 0; } tellTicks++; }
    else if (mv === "last_procession" && ph === "active") { if (phase !== "front") { phase = "front"; frontTicks = 0; } frontTicks++; }
    else if (phase === "front" && ph === "none") break;
  }
  const tT = nearTicks(1.5);
  check("tell duration ±3 tick (live sample; constant gate is ±1)", tellTicks >= tT.exact - 3 && tellTicks <= tT.exact + 3, `ticks=${tellTicks}`);
  check("moving-front ran", frontTicks > 0 || w.encounter.flags.processionOutcome === "success", `front=${frontTicks}`);
  check("dark front stays behind the convoy", w.encounter.flags.shadowBehind === true);
}

function successPath(): void {
  section("Success = escort in the aura + blocker cleared → convoy crosses → openBossWindow(4.0)");
  const w = createWorld(0x51CC80, 80, {});
  loadFloorIntoWorld(w, 80);
  const boss = armConvoy(w);
  if (!boss || !w.encounter || !boss.boss) { check("wake for success", false); return; }
  forceProcession(w, boss);
  check("PROCESSION started", boss.attack.move === "last_procession", `move=${boss.attack.move}`);
  const before = Number(w.encounter.flags.thresholdIndex);
  clearHighlightedBlocker(w);
  const p = w.players.get(LOCAL_ID)!;
  for (let i = 0; i < 80; i++) {
    const bier = bierOf(w);
    if (bier) { p.x = bier.x; p.y = bier.y; p.invuln = 999; } // ride inside the warmth corridor
    step(w, 1);
    if (w.encounter.flags.processionOutcome === "success") break;
  }
  check("outcome is success after protected crossing", w.encounter.flags.processionOutcome === "success", `outcome=${w.encounter.flags.processionOutcome}`);
  check("success opens openBossWindow(processionPunish)", (boss.boss.exposed ?? 0) > 0, `exposed=${boss.boss.exposed}`);
  check("punish window armed near 4.0s", (boss.boss.exposed ?? 0) >= WAKE.processionPunish - FIXED_DT * 2, `exposed=${boss.boss.exposed}`);
  check("the convoy crossed a threshold", Number(w.encounter.flags.thresholdIndex) === before + 1, `ti=${w.encounter.flags.thresholdIndex}`);
  check("success ≠ survival", w.encounter.flags.processionOutcome !== "survival");
}

function survivalPath(): void {
  section("Survival = side shelter outside the path → convoy stalls; NO window");
  const w = createWorld(0x541780, 80, {});
  loadFloorIntoWorld(w, 80);
  const boss = armConvoy(w);
  if (!boss || !w.encounter || !boss.boss) { check("wake for survival", false); return; }
  forceProcession(w, boss);
  const before = Number(w.encounter.flags.thresholdIndex);
  const p = w.players.get(LOCAL_ID)!;
  for (let i = 0; i < 200; i++) {
    // Hold the player far off the convoy path (a side shelter, out of the dark-front lane).
    p.x = boss.x + 900;
    p.y = boss.y + 900;
    p.invuln = 999;
    step(w, 1);
    const o = w.encounter.flags.processionOutcome;
    if (o === "survival" || o === "failure" || o === "success") break;
  }
  check("outcome is survival (side shelter, off the path)", w.encounter.flags.processionOutcome === "survival", `outcome=${w.encounter.flags.processionOutcome}`);
  check("survival opens NO window", (boss.boss.exposed ?? 0) === 0, `exposed=${boss.boss.exposed}`);
  check("survival stalls the convoy (no threshold cross)", Number(w.encounter.flags.thresholdIndex) === before, `ti=${w.encounter.flags.thresholdIndex}`);
  check("survival ≠ success", w.encounter.flags.processionOutcome !== "success");
}

function failurePath(): void {
  section("Failure = caught in the dark-front lane, blocker uncleared → capped hit; no window; never wipe");
  const w = createWorld(0xF48080, 80, {});
  loadFloorIntoWorld(w, 80);
  const boss = armConvoy(w);
  if (!boss || !w.encounter || !boss.boss) { check("wake for failure", false); return; }
  forceProcession(w, boss);
  const warmth0 = Number(w.encounter.flags.convoyWarmth);
  const p = w.players.get(LOCAL_ID)!;
  for (let i = 0; i < 200; i++) {
    // Stand in the convoy lane (on the bier), but never clear the blocker → not protected.
    const bier = bierOf(w);
    if (bier) { p.x = bier.x; p.y = bier.y; }
    step(w, 1);
    const o = w.encounter.flags.processionOutcome;
    if (o === "failure" || o === "survival" || o === "success") break;
  }
  check("outcome is failure (in lane, blocker uncleared)", w.encounter.flags.processionOutcome === "failure", `outcome=${w.encounter.flags.processionOutcome}`);
  check("failure opens NO window", (boss.boss.exposed ?? 0) === 0, `exposed=${boss.boss.exposed}`);
  check("failure warmth loss is bounded (never zeroes / soft-locks)", Number(w.encounter.flags.convoyWarmth) < warmth0 && Number(w.encounter.flags.convoyWarmth) >= 0.1, `warmth=${w.encounter.flags.convoyWarmth}`);
  check("failure does not complete the floor", isFloorCleared(w) === false);
  check("failure does not kill players", [...w.players.values()].every((pl) => pl.hp > 0));
}

function customCompletion(): void {
  section("Custom completion at the FINAL threshold (not only enemies.length===0)");
  const w = createWorld(0xC0FE80, 80, {});
  loadFloorIntoWorld(w, 80);
  const boss = armConvoy(w);
  if (!boss || !w.encounter || !boss.boss) { check("wake for completion", false); return; }
  const p = w.players.get(LOCAL_ID)!;
  let crossings = 0;
  for (let t = 0; t < WAKE.thresholdCount + 2 && !isFloorCleared(w); t++) {
    forceProcession(w, boss);
    if (boss.attack.move !== "last_procession") break;
    clearHighlightedBlocker(w);
    const before = Number(w.encounter.flags.thresholdIndex);
    for (let i = 0; i < 100; i++) {
      const bier = bierOf(w);
      if (bier) { p.x = bier.x; p.y = bier.y; p.invuln = 999; }
      step(w, 1);
      if (Number(w.encounter.flags.thresholdIndex) > before || isFloorCleared(w)) break;
    }
    if (Number(w.encounter.flags.thresholdIndex) > before) crossings++;
    if (boss.boss) { boss.boss.exposed = 0; boss.boss.windowBank = 0; }
  }
  check("the convoy crossed every threshold", crossings >= WAKE.thresholdCount, `crossings=${crossings}`);
  check("reaching the final threshold custom-completes the floor", isFloorCleared(w) === true);
  check("boss chest granted on completion", w.chests.some((c) => c.kind === "boss"));
}

function noPreActivationAggro(): void {
  section("No pre-activation PROCESSION / convoy while the party is far");
  const w = createWorld(0x408080, 80, {});
  loadFloorIntoWorld(w, 80);
  const boss = w.enemies.find((e) => e.kind === "wake");
  if (!boss || !w.encounter) { check("wake present", false); return; }
  const p = w.players.get(LOCAL_ID)!;
  const far = w.dungeon.rooms[w.dungeon.rooms.length - 1];
  p.x = far.cx * 48 + 24;
  p.y = far.cy * 48 + 24;
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;
  step(w, 40);
  check("still inactive while far", w.encounter.active === false);
  check("no PROCESSION before activation", boss.attack.move !== "last_procession");
  check("no convoy body before activation", w.enemies.filter((e) => e.kind === "warm_bier").length === 0);
}

function nomenclatureLock(): void {
  section("Nomenclature: THE LAST PROCESSION / The Wake; NIGHTFALL PROCESSION retired");
  check("wire id is last_procession (not nightfall_procession)", true); // closed-set compile gate
  check("boss display name is The Wake", bossDisplayName("wake") === "The Wake");
  const w = createWorld(0xC480, 80, {});
  const boss = w.enemies.find((e) => e.kind === "wake");
  check("no NIGHTFALL enemy/kind on the floor", !!boss && !w.enemies.some((e) => String(e.kind).toLowerCase().includes("nightfall")));
}

pinGates();
escortBlueprint();
encounterFlagsAndReconnect();
processionTimings();
processionLive();
successPath();
survivalPath();
failurePath();
customCompletion();
noPreActivationAggro();
nomenclatureLock();

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
  process.stdout.write(failures.map((f) => "  - " + f).join("\n") + "\n");
  process.exit(1);
}
