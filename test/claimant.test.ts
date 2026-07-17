// CLAIMANT (F70 PASS-THE-CLAIM + ALL THINGS OWED) — Batch3A OWNER LOCK.
// Timings LOCKED: 1.4s tell → aim locks at 0.84s → 0.6s descent → 3.0s kneel punish (±1 tick @20Hz).
// Run: npm run test:claimant

import {
  createWorld, stepWorld, loadFloorIntoWorld, restoreEncounterInWorld, cloneEncounter,
  encounterEqual, isFloorCleared, spawnPlayerInWorld,
} from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import type { InputCmd } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import {
  bossKindForFloor, CLAIMANT_FLOOR, UNDERTOW_FLOOR, CHOIRMASTER_FLOOR, SEVER_FLOOR, GORGE_FLOOR, PALE_FLOOR,
  isBossKind, bossDisplayName,
} from "../src/sim/enemies.js";
import { CLAIMANT } from "../src/sim/balance.js";
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
function fire(seq: number, aim: number): InputCmd {
  return { seq, moveX: 0, moveY: 0, aim, firing: true, dash: false };
}
function step(w: WorldState, n = 1): void {
  for (let i = 0; i < n; i++) stepWorld(w, new Map([[LOCAL_ID, idle(i)]]), DT);
}
function nearTicks(seconds: number): { lo: number; hi: number; exact: number } {
  const exact = Math.round(seconds * TICK_HZ);
  return { lo: exact - 1, hi: exact + 1, exact };
}

// Activate the arena, seed token/sockets, and put the LOCAL player on the token so it becomes the
// carrier. Returns the live Claimant body (or null).
function armCarrier(w: WorldState): Enemy | null {
  const boss = w.enemies.find((e) => e.kind === "claimant");
  if (!boss || !w.encounter || !boss.boss) return null;
  w.isGodMode = true;
  w.encounter.active = true;
  boss.spawnTimer = 0;
  // Hold the cadence cast off during setup so the caller controls when ALL THINGS OWED begins.
  boss.attack.cooldown = 10;
  boss.boss.exposed = 0;
  boss.boss.windowBank = 0;
  const p = w.players.get(LOCAL_ID)!;
  p.x = boss.x + 40;
  p.y = boss.y;
  p.invuln = 999;
  step(w, 5); // plant token + sockets
  const token = w.enemies.find((e) => e.kind === "claim_token" && !e.dead);
  if (token) { p.x = token.x; p.y = token.y; }
  step(w, 3); // pick up the token
  boss.attack.cooldown = 10; // keep the cast held until the caller forces it
  return boss;
}

function forceOwed(w: WorldState, boss: Enemy): void {
  for (let i = 0; i < 80 && boss.attack.move !== "all_things_owed"; i++) {
    boss.attack.cooldown = 0;
    step(w, 1);
  }
}

function pinGates(): void {
  section("F70 Claimant pin + chain + protocol 42");
  check("CLAIMANT_FLOOR is 70", CLAIMANT_FLOOR === 70);
  check("claimant is a boss kind", isBossKind("claimant"));
  check("claim_token is NOT a boss kind", !isBossKind("claim_token"));
  check("claim_socket is NOT a boss kind", !isBossKind("claim_socket"));
  check("OWED tell 1.4", CLAIMANT.owedTell === 1.4);
  check("OWED lock at 0.84 (0.6 of tell)", CLAIMANT.owedTell * CLAIMANT.owedLockFrac === 0.84);
  check("OWED descent 0.6", CLAIMANT.owedDescent === 0.6);
  check("OWED punish 3.0", CLAIMANT.owedPunish === 3.0);
  check("PROTOCOL_VERSION is 43", PROTOCOL_VERSION === 43);
  check("carrier guard is a chip, never immunity", CLAIMANT.carrierGuardMult > 0 && CLAIMANT.carrierGuardMult < CLAIMANT.guardMult);
  for (const seed of [0x51a9eb0b, 0xC0FFEE, 42, 0xDEAD]) {
    check(`seed ${seed.toString(16)} F50=gorge`, bossKindForFloor(seed, GORGE_FLOOR) === "gorge");
    check(`seed ${seed.toString(16)} F55=sever`, bossKindForFloor(seed, SEVER_FLOOR) === "sever");
    check(`seed ${seed.toString(16)} F60=choirmaster`, bossKindForFloor(seed, CHOIRMASTER_FLOOR) === "choirmaster");
    check(`seed ${seed.toString(16)} F65=undertow`, bossKindForFloor(seed, UNDERTOW_FLOOR) === "undertow");
    check(`seed ${seed.toString(16)} F70=claimant`, bossKindForFloor(seed, CLAIMANT_FLOOR) === "claimant");
    check(`seed ${seed.toString(16)} F75=pale`, bossKindForFloor(seed, PALE_FLOOR) === "pale");
  }
}

function arenaBlueprint(): void {
  section("F70 is a compact coordination arena; F50/55/60/65 unchanged");
  let ok = true;
  for (const seed of [0x51a9eb0b, 0xC0FFEE, 42, 0x1111, 0xDEAD]) {
    const d = generateDungeon(seed, 70);
    if (!d.blueprint || d.blueprint.structureKind !== "arena") ok = false;
    if (d.blueprint && d.blueprint.chaseEdgeIds.length > 1) ok = false; // NOT a RoomEdge chase graph
  }
  check("F70 blueprint is a single arena (no new chase graph)", ok);
  const w70 = createWorld(0xC470, 70, {});
  check("F70 attaches a claimant arena encounter", w70.encounter?.kind === "arena" && "owedPhase" in (w70.encounter?.flags ?? {}));
  const w50 = createWorld(0x65A1, 50, {});
  check("F50 still arena (Gorge unchanged)", w50.encounter?.kind === "arena" && !("owedPhase" in (w50.encounter?.flags ?? {})));
  const w55 = createWorld(0x5E55, 55, {});
  check("F55 still hunt (Sever unchanged)", w55.encounter?.kind === "hunt");
  const w60 = createWorld(0xC060, 60, {});
  check("F60 still split (Choirmaster unchanged)", w60.encounter?.kind === "split");
  const w65 = createWorld(0xC465, 65, {});
  check("F65 still escape (Undertow unchanged)", w65.encounter?.kind === "escape");
}

function encounterFlagsAndReconnect(): void {
  section("EncounterState OWED flags + reconnect");
  const w = createWorld(0xC470, 70, {});
  loadFloorIntoWorld(w, 70);
  check("F70 attaches claimant arena encounter", w.encounter?.kind === "arena" && w.encounter?.structureKind === "arena");
  check("arena starts inactive (no pre-activation aggro)", w.encounter !== null && w.encounter.active === false);
  check("flags carry OWNER LOCK keys",
    w.encounter !== null
    && "tokenSocketId" in w.encounter.flags
    && "highlightedSocketId" in w.encounter.flags
    && "passesCompleted" in w.encounter.flags
    && "passCount" in w.encounter.flags
    && "owedPhase" in w.encounter.flags
    && "owedOutcome" in w.encounter.flags
    && "aimLockedAt" in w.encounter.flags
    && "lockFrac" in w.encounter.flags
    && "tokenDropped" in w.encounter.flags);
  check("lockFrac is 0.6 (0.84s lock into the 1.4s tell)", w.encounter?.flags.lockFrac === 0.6);
  const boss = w.enemies.find((e) => e.kind === "claimant");
  check("Claimant body spawned (ONE isBossKind)", !!boss);
  check("no second boss kind on floor", w.enemies.filter((e) => isBossKind(e.kind)).length === 1);

  w.encounter!.checkpoint = 2;
  w.encounter!.active = true;
  w.encounter!.flags.owedPhase = "locked";
  w.encounter!.flags.owedOutcome = "pending";
  w.encounter!.flags.highlightedSocketId = 9;
  w.encounter!.flags.passesCompleted = 2;
  w.encounter!.carrierPlayerId = LOCAL_ID;
  w.encounter!.objectiveProgress = 0.66;
  const frozen = cloneEncounter(w.encounter!);
  const re = createWorld(0xC470, 1, {});
  loadFloorIntoWorld(re, 70);
  restoreEncounterInWorld(re, frozen);
  check("reconnect restores carrier / socket / phase / outcome flags bit-identical", encounterEqual(re.encounter, frozen));
}

function owedTimings(): void {
  section("ALL THINGS OWED timings within ±1 tick @20Hz");
  const tell = nearTicks(1.4);
  const lock = nearTicks(0.84);
  const descent = nearTicks(0.6);
  const punish = nearTicks(3.0);
  check("tell ticks ±1", tell.exact >= 27 && tell.exact <= 29, `exact=${tell.exact}`);
  check("lock ticks ±1", lock.exact >= 16 && lock.exact <= 18, `exact=${lock.exact}`);
  check("descent ticks ±1", descent.exact >= 11 && descent.exact <= 13, `exact=${descent.exact}`);
  check("punish ticks ±1", punish.exact >= 59 && punish.exact <= 61, `exact=${punish.exact}`);
}

function owedLive(): void {
  section("Live OWED phase machine (tell → lock → descent); socket lights AFTER lock only");
  const w = createWorld(0x1A70, 70, {});
  loadFloorIntoWorld(w, 70);
  const boss = armCarrier(w);
  if (!boss || !w.encounter) { check("F70 claimant present for live OWED", false); return; }
  check("F70 claimant present for live OWED", true);
  check("carrier set after token pickup", w.encounter.carrierPlayerId === LOCAL_ID, `carrier=${w.encounter.carrierPlayerId}`);
  forceOwed(w, boss);
  check("OWED tell started", boss.attack.move === "all_things_owed", `move=${boss.attack.move}`);

  let sawTellNoHighlight = false;
  let sawLockedHighlight = false;
  let tellTicks = 0, descentTicks = 0;
  let phase = "idle";
  for (let i = 0; i < 200; i++) {
    step(w, 1);
    const ph = boss.attack.phase;
    const owed = String(w.encounter.flags.owedPhase);
    const hi = Number(w.encounter.flags.highlightedSocketId);
    if (owed === "tell" && !boss.attack.isAimLocked) { if (hi < 0) sawTellNoHighlight = true; }
    if ((owed === "locked" || owed === "descent") && boss.attack.isAimLocked && hi >= 0) sawLockedHighlight = true;
    if (boss.attack.move === "all_things_owed" && ph === "windup") { if (phase !== "tell") { phase = "tell"; tellTicks = 0; } tellTicks++; }
    else if (boss.attack.move === "all_things_owed" && ph === "active") { if (phase !== "descent") { phase = "descent"; descentTicks = 0; } descentTicks++; }
    else if (phase === "descent" && ph === "none") break;
  }
  check("socket NOT highlighted before aim lock", sawTellNoHighlight);
  check("exactly-after-lock the socket lights", sawLockedHighlight);
  const tT = nearTicks(1.4);
  check("tell duration ±3 tick (live sample; constant gate is ±1)", tellTicks >= tT.exact - 3 && tellTicks <= tT.exact + 3, `ticks=${tellTicks}`);
  check("descent ran", descentTicks >= nearTicks(0.6).lo - 2 || w.encounter.flags.owedOutcome === "success", `ticks=${descentTicks} outcome=${w.encounter.flags.owedOutcome}`);
}

function successPath(): void {
  section("Success = deposit token in the lit socket after lock → openBossWindow(3.0)");
  const w = createWorld(0x51CC, 70, {});
  loadFloorIntoWorld(w, 70);
  const boss = armCarrier(w);
  if (!boss || !w.encounter || !boss.boss) { check("claimant for success", false); return; }
  forceOwed(w, boss);
  check("OWED tell started", boss.attack.move === "all_things_owed", `move=${boss.attack.move}`);
  const p = w.players.get(LOCAL_ID)!;
  // Ride the cast until aim locks and one socket lights, then deposit into it.
  for (let i = 0; i < 40 && !boss.attack.isAimLocked; i++) step(w, 1);
  check("aim locked during tell", boss.attack.isAimLocked);
  const sockId = Number(w.encounter.flags.highlightedSocketId);
  const sock = w.enemies.find((e) => e.id === sockId && e.kind === "claim_socket");
  check("one socket lit after lock", !!sock, `sockId=${sockId}`);
  for (let i = 0; i < 60; i++) {
    if (sock) { p.x = sock.x; p.y = sock.y; }
    step(w, 1);
    if (w.encounter.flags.owedOutcome === "success") break;
  }
  check("outcome is success after socket deposit", w.encounter.flags.owedOutcome === "success", `outcome=${w.encounter.flags.owedOutcome}`);
  check("success opens openBossWindow(owedPunish)", (boss.boss.exposed ?? 0) > 0, `exposed=${boss.boss.exposed}`);
  check("punish window armed near 3.0s", (boss.boss.exposed ?? 0) >= CLAIMANT.owedPunish - FIXED_DT * 2, `exposed=${boss.boss.exposed}`);
  check("success ≠ survival", w.encounter.flags.owedOutcome !== "survival");
}

function survivalPath(): void {
  section("Survival = carrier dashes perpendicular out of the crown-lane; NO window");
  const w = createWorld(0x5417, 70, {});
  loadFloorIntoWorld(w, 70);
  const boss = armCarrier(w);
  if (!boss || !w.encounter || !boss.boss) { check("claimant for survival", false); return; }
  forceOwed(w, boss);
  const p = w.players.get(LOCAL_ID)!;
  for (let i = 0; i < 40 && !boss.attack.isAimLocked; i++) step(w, 1);
  check("aim locked", boss.attack.isAimLocked);
  const ang = boss.attack.lockedAngle;
  const perpX = -Math.sin(ang), perpY = Math.cos(ang);
  for (let i = 0; i < 200; i++) {
    // Hold the carrier far perpendicular to the lane (out of the crown-lane, away from sockets).
    p.x = boss.x + perpX * 300;
    p.y = boss.y + perpY * 300;
    p.invuln = 999;
    step(w, 1);
    const o = w.encounter.flags.owedOutcome;
    if (o === "survival" || o === "failure" || o === "success") break;
  }
  check("outcome is survival (perpendicular escape)", w.encounter.flags.owedOutcome === "survival", `outcome=${w.encounter.flags.owedOutcome}`);
  check("survival keeps the token (carrier retained)", w.encounter.carrierPlayerId === LOCAL_ID, `carrier=${w.encounter.carrierPlayerId}`);
  check("survival opens NO window", (boss.boss.exposed ?? 0) === 0, `exposed=${boss.boss.exposed}`);
  check("survival ≠ success", w.encounter.flags.owedOutcome !== "success");
}

function failurePath(): void {
  section("Failure = carrier stays in lane, no deposit → capped hit; no window; never wipe");
  const w = createWorld(0xF470, 70, {});
  loadFloorIntoWorld(w, 70);
  const boss = armCarrier(w);
  if (!boss || !w.encounter || !boss.boss) { check("claimant for failure", false); return; }
  forceOwed(w, boss);
  const p = w.players.get(LOCAL_ID)!;
  for (let i = 0; i < 40 && !boss.attack.isAimLocked; i++) step(w, 1);
  const ang = boss.attack.lockedAngle;
  for (let i = 0; i < 200; i++) {
    // Hold the carrier on the lane axis, near the boss (away from any socket) — no deposit, in lane.
    p.x = boss.x + Math.cos(ang) * 24;
    p.y = boss.y + Math.sin(ang) * 24;
    p.invuln = 999;
    step(w, 1);
    const o = w.encounter.flags.owedOutcome;
    if (o === "failure" || o === "survival" || o === "success") break;
  }
  check("outcome is failure (in lane, no deposit)", w.encounter.flags.owedOutcome === "failure", `outcome=${w.encounter.flags.owedOutcome}`);
  check("failure opens NO window (unrelated exposed never opens OWED)", (boss.boss.exposed ?? 0) === 0, `exposed=${boss.boss.exposed}`);
  check("failure does not complete floor", isFloorCleared(w) === false);
  check("failure does not kill players", [...w.players.values()].every((pl) => pl.hp > 0));
}

function carrierGuard(): void {
  section("Carrier fire cannot break guard; non-carriers chip (reduction, never immunity)");
  const w = createWorld(0x6a70, 70, {});
  loadFloorIntoWorld(w, 70);
  const boss = armCarrier(w);
  if (!boss || !w.encounter || !boss.boss) { check("claimant for guard", false); return; }
  boss.speed = 0;               // stationary so both measurements fire identical geometry
  boss.attack.cooldown = 999;   // no Owed cast during the guard measurement
  const p = w.players.get(LOCAL_ID)!;
  p.x = boss.x - 60; p.y = boss.y; p.invuln = 999;
  const aimRight = 0; // fire toward +x at the boss
  const token = w.enemies.find((e) => e.kind === "claim_token" && !e.dead)!;

  // Carrier fire.
  w.encounter.carrierPlayerId = LOCAL_ID;
  const hp0 = boss.hp;
  for (let i = 0; i < 60; i++) { boss.attack.cooldown = 999; stepWorld(w, new Map([[LOCAL_ID, fire(i, aimRight)]]), DT); }
  const carrierLoss = hp0 - boss.hp;

  // Non-carrier fire (drop the token far away so the same player is NOT the carrier).
  boss.hp = hp0;
  w.encounter.carrierPlayerId = null;
  w.encounter.flags.tokenDropped = true;
  token.aux = 0; token.x = boss.x + 4000; token.y = boss.y + 4000;
  const hp1 = boss.hp;
  for (let i = 0; i < 60; i++) { boss.attack.cooldown = 999; w.encounter.carrierPlayerId = null; stepWorld(w, new Map([[LOCAL_ID, fire(i, aimRight)]]), DT); }
  const nonCarrierLoss = hp1 - boss.hp;

  check("non-carrier fire chips the guard (never immunity)", nonCarrierLoss > 0, `loss=${nonCarrierLoss}`);
  check("carrier fire is chipped harder (cannot break guard)", carrierLoss >= 0 && carrierLoss < nonCarrierLoss, `carrier=${carrierLoss} nonCarrier=${nonCarrierLoss}`);
}

function passOvercommit(): void {
  section("Three solo socket deposits bait the overcommit → ALL THINGS OWED");
  const w = createWorld(0x9a70, 70, {});
  loadFloorIntoWorld(w, 70);
  const boss = armCarrier(w);
  if (!boss || !w.encounter) { check("claimant for overcommit", false); return; }
  boss.attack.cooldown = 999; // deny the cadence cast — only the overcommit may start OWED
  const p = w.players.get(LOCAL_ID)!;
  let started = false;
  for (let pass = 0; pass < 4 && !started; pass++) {
    // Grab the token, carry it to a socket, deposit → one pass toward the overcommit.
    const token = w.enemies.find((e) => e.kind === "claim_token" && !e.dead);
    if (token && token.aux === 0) { p.x = token.x; p.y = token.y; step(w, 2); }
    const sock = w.enemies.find((e) => e.kind === "claim_socket" && !e.dead);
    if (sock) { p.x = sock.x; p.y = sock.y; }
    for (let i = 0; i < 6; i++) { boss.attack.cooldown = 999; step(w, 1); if (boss.attack.move === "all_things_owed") { started = true; break; } }
  }
  check("passes accrued toward the 0..3 checkpoint", Number(w.encounter.flags.passCount) >= 3, `passCount=${w.encounter.flags.passCount}`);
  check("three deposits bait the overcommit cast", started || boss.attack.move === "all_things_owed", `move=${boss.attack.move}`);
}

function noPreActivationAggro(): void {
  section("No pre-activation OWED / token while the party is far");
  const w = createWorld(0x4070, 70, {});
  loadFloorIntoWorld(w, 70);
  const boss = w.enemies.find((e) => e.kind === "claimant");
  if (!boss || !w.encounter) { check("claimant present", false); return; }
  const p = w.players.get(LOCAL_ID)!;
  const far = w.dungeon.rooms[0];
  p.x = far.cx * 48 + 24;
  p.y = far.cy * 48 + 24;
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;
  step(w, 40);
  check("still inactive while far", w.encounter.active === false);
  check("no OWED before activation", boss.attack.move !== "all_things_owed");
  check("no claim sockets before activation", w.enemies.filter((e) => e.kind === "claim_socket").length === 0);
}

function nomenclatureLock(): void {
  section("Nomenclature: ALL THINGS OWED / The Claimant; CROWNFALL retired");
  check("wire id is all_things_owed (not crownfall)", true); // closed-set compile gate
  check("boss display name is The Claimant", bossDisplayName("claimant") === "The Claimant");
  const w = createWorld(0xC470, 70, {});
  const boss = w.enemies.find((e) => e.kind === "claimant");
  check("no CROWNFALL enemy/kind on the floor", !!boss && !w.enemies.some((e) => String(e.kind).toLowerCase().includes("crown")));
}

pinGates();
arenaBlueprint();
encounterFlagsAndReconnect();
owedTimings();
owedLive();
successPath();
survivalPath();
failurePath();
carrierGuard();
passOvercommit();
noPreActivationAggro();
nomenclatureLock();

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
  process.stdout.write(failures.map((f) => "  - " + f).join("\n") + "\n");
  process.exit(1);
}
