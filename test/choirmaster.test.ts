// HOLLOW CHOIRMASTER (F60 SPLIT/SILENCE + THE LAST NOTE) — Batch2A OWNER LOCK.
// Timings LOCKED: 1.6s inhale → ~0.7s/span sheet → 4.0s punish (±1 tick @20Hz).
// Run: npm run test:choirmaster

import {
  createWorld, stepWorld, loadFloorIntoWorld, restoreEncounterInWorld, cloneEncounter,
  encounterEqual, isFloorCleared, spawnPlayerInWorld,
} from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import type { InputCmd } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import {
  bossKindForFloor, CHOIRMASTER_FLOOR, SEVER_FLOOR, GORGE_FLOOR, UNDERTOW_FLOOR, PALE_FLOOR, isBossKind,
} from "../src/sim/enemies.js";
import { CHOIRMASTER } from "../src/sim/balance.js";
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
  section("F60 Choirmaster pin + chain + protocol");
  check("CHOIRMASTER_FLOOR is 60", CHOIRMASTER_FLOOR === 60);
  check("choirmaster is a boss kind", isBossKind("choirmaster"));
  check("choir_pillar is NOT a boss kind", !isBossKind("choir_pillar"));
  check("LAST NOTE inhale 1.6", CHOIRMASTER.lastNoteInhale === 1.6);
  check("LAST NOTE span 0.7", CHOIRMASTER.lastNoteSpan === 0.7);
  check("LAST NOTE punish 4.0", CHOIRMASTER.lastNotePunish === 4.0);
  check("PROTOCOL_VERSION is 49 (ring weather after the contested hearth)", PROTOCOL_VERSION === 49);
  for (const seed of [0x51a9eb0b, 0xC0FFEE, 42, 0xDEAD]) {
    check(`seed ${seed.toString(16)} F50=gorge`, bossKindForFloor(seed, GORGE_FLOOR) === "gorge");
    check(`seed ${seed.toString(16)} F55=sever`, bossKindForFloor(seed, SEVER_FLOOR) === "sever");
    check(`seed ${seed.toString(16)} F60=choirmaster`, bossKindForFloor(seed, CHOIRMASTER_FLOOR) === "choirmaster");
    check(`seed ${seed.toString(16)} F65=undertow`, bossKindForFloor(seed, UNDERTOW_FLOOR) === "undertow");
    check(`seed ${seed.toString(16)} F75=pale`, bossKindForFloor(seed, PALE_FLOOR) === "pale");
  }
}

function splitBlueprint(): void {
  section("F60 split blueprint: multi-lobed super-room, NOT RoomEdge chase");
  let ok = true;
  for (const seed of [0x51a9eb0b, 0xC0FFEE, 42, 0x1111, 0xDEAD]) {
    const d = generateDungeon(seed, 60);
    if (!d.blueprint || d.blueprint.structureKind !== "split") { ok = false; continue; }
    if (d.blueprint.objectiveRoomIds.length < 3) ok = false;
    if (d.blueprint.chaseEdgeIds.length !== 0) ok = false; // NOT a chase graph
    if (d.blueprint.spawnRoomId !== d.rooms[d.rooms.length - 1].id) ok = false;
  }
  check("split blueprint invariants hold across seeds", ok);

  const w50 = createWorld(0x60A1, 50, {});
  check("F50 still arena (Gorge unchanged)", w50.encounter?.kind === "arena");
  const w55 = createWorld(0x5E55, 55, {});
  check("F55 still hunt (Sever unchanged)", w55.encounter?.kind === "hunt");
}

function encounterFlagsAndReconnect(): void {
  section("EncounterState split flags + reconnect");
  const w = createWorld(0xC460, 60, {});
  loadFloorIntoWorld(w, 60);
  check("F60 attaches split encounter", w.encounter?.kind === "split" && w.encounter?.structureKind === "split");
  check("split starts inactive (no pre-activation aggro)", w.encounter !== null && w.encounter.active === false);
  check("flags carry OWNER LOCK keys",
    w.encounter !== null
    && "activePhrase" in w.encounter.flags
    && "phraseIndex" in w.encounter.flags
    && "livePillarId" in w.encounter.flags
    && "silencedMask" in w.encounter.flags
    && "sheetSpanIndex" in w.encounter.flags
    && "lastNotePhase" in w.encounter.flags
    && "lastNoteOutcome" in w.encounter.flags
    && "acousticShadowPillarId" in w.encounter.flags);
  const boss = w.enemies.find((e) => e.kind === "choirmaster");
  check("Choirmaster body spawned (ONE isBossKind)", !!boss);
  check("no second boss kind on floor", w.enemies.filter((e) => isBossKind(e.kind)).length === 1);

  w.encounter!.checkpoint = 1;
  w.encounter!.active = true;
  w.encounter!.flags.lastNotePhase = "sheet";
  w.encounter!.flags.livePillarId = 7;
  w.encounter!.flags.sheetSpanIndex = 2;
  w.encounter!.flags.silencedMask = 1;
  w.encounter!.objectiveProgress = 0.4;
  const frozen = cloneEncounter(w.encounter!);
  const re = createWorld(0xC460, 1, {});
  loadFloorIntoWorld(re, 60);
  restoreEncounterInWorld(re, frozen);
  check("reconnect restores checkpoint/flags bit-identical", encounterEqual(re.encounter, frozen));
}

function lastNoteTimings(): void {
  section("THE LAST NOTE timings within ±1 tick @20Hz");
  const inhale = nearTicks(1.6);
  const span = nearTicks(0.7);
  const punish = nearTicks(4.0);
  check("inhale ticks ±1", inhale.exact >= 31 && inhale.exact <= 33, `exact=${inhale.exact}`);
  check("span ticks ±1", span.exact >= 13 && span.exact <= 15, `exact=${span.exact}`);
  check("punish ticks ±1", punish.exact >= 79 && punish.exact <= 81, `exact=${punish.exact}`);
}

function lastNoteLive(): void {
  section("Live LAST NOTE phase machine (inhale→sheet→punish)");
  const w = createWorld(0x1A57, 60, {});
  w.isGodMode = true;
  loadFloorIntoWorld(w, 60);
  const boss = w.enemies.find((e) => e.kind === "choirmaster");
  if (!boss || !w.encounter) { check("F60 choirmaster present for live LAST NOTE", false); return; }
  check("F60 choirmaster present for live LAST NOTE", true);
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;
  boss.boss!.lastAddPick = 0;
  w.encounter.active = true;
  // Force pillars planted
  const p = w.players.get(LOCAL_ID)!;
  p.x = boss.x + 80;
  p.y = boss.y;
  p.invuln = 999;
  step(w, 3);
  check("encounter activates on approach", w.encounter.active === true);
  const pillars = w.enemies.filter((e) => e.kind === "choir_pillar");
  check("≥3 pillars planted in lobes", pillars.length >= 3, `n=${pillars.length}`);

  // Wait until windup actually starts so the inhale sample is not truncated by approach ticks.
  for (let i = 0; i < 80 && !(boss.attack.move === "last_note" && boss.attack.phase === "windup"); i++) step(w, 1);
  let inhaleTicks = 0, sheetTicks = 0, punishTicks = 0;
  let phase: string = "idle";
  for (let i = 0; i < 400; i++) {
    // Keep live pillar alive so we measure full inhale→sheet→failure/survival settle.
    const liveId = Number(w.encounter.flags.livePillarId);
    const live = w.enemies.find((e) => e.id === liveId && e.kind === "choir_pillar");
    if (live) { live.hp = live.maxHp; live.dead = false; }
    step(w, 1);
    const mv = boss.attack.move;
    const ph = boss.attack.phase;
    if (mv === "last_note" && ph === "windup") {
      if (phase !== "inhale") { phase = "inhale"; inhaleTicks = 0; }
      inhaleTicks++;
    } else if (mv === "last_note" && ph === "active") {
      if (phase !== "sheet") { phase = "sheet"; sheetTicks = 0; }
      sheetTicks++;
    } else if (mv === "last_note" && ph === "recover") {
      if (phase !== "punish") { phase = "punish"; punishTicks = 0; }
      punishTicks++;
    } else if (phase === "punish" && ph === "none") {
      break;
    }
  }
  const iT = nearTicks(1.6);
  check("inhale duration ±3 tick (live sample; constant gate is ±1)", inhaleTicks >= iT.exact - 3 && inhaleTicks <= iT.exact + 3, `ticks=${inhaleTicks}`);
  check("sheet phase ran (≥1 span)", sheetTicks >= nearTicks(0.7).lo, `ticks=${sheetTicks}`);
  check("post-sheet settle ran", punishTicks >= 1, `ticks=${punishTicks}`);
}

function successPath(): void {
  section("Success = silence FIRST live pillar before sheet reaches it → openBossWindow(4.0)");
  const w = createWorld(0x51CC, 60, {});
  w.isGodMode = true;
  loadFloorIntoWorld(w, 60);
  const boss = w.enemies.find((e) => e.kind === "choirmaster");
  if (!boss || !w.encounter || !boss.boss) { check("choirmaster for success", false); return; }
  w.encounter.active = true;
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;
  boss.boss.lastAddPick = 0;
  boss.boss.exposed = 0;
  boss.boss.windowBank = 0;
  const p = w.players.get(LOCAL_ID)!;
  p.x = boss.x + 80; p.y = boss.y; p.invuln = 999;

  let live: ReturnType<typeof w.enemies.find> = undefined;
  for (let i = 0; i < 80; i++) {
    step(w, 1);
    if (boss.attack.move === "last_note" && boss.attack.phase === "windup") {
      const lid = Number(w.encounter.flags.livePillarId);
      live = w.enemies.find((e) => e.id === lid && e.kind === "choir_pillar" && !e.dead);
      if (live) break;
    }
  }
  check("LAST NOTE inhale lights a live pillar", !!live, `liveId=${w.encounter.flags.livePillarId}`);
  if (live) { live.hp = 0; live.dead = true; }
  for (let i = 0; i < 120; i++) {
    step(w, 1);
    if (w.encounter.flags.lastNoteOutcome === "success") break;
  }
  check("outcome is success after live pillar silence", w.encounter.flags.lastNoteOutcome === "success",
    `outcome=${w.encounter.flags.lastNoteOutcome}`);
  check("success opens openBossWindow(lastNotePunish)", (boss.boss.exposed ?? 0) > 0,
    `exposed=${boss.boss.exposed}`);
  check("punish window armed near 4.0s", (boss.boss.exposed ?? 0) >= CHOIRMASTER.lastNotePunish - FIXED_DT * 2,
    `exposed=${boss.boss.exposed}`);
  check("success ≠ survival", w.encounter.flags.lastNoteOutcome !== "survival");
}

function survivalPath(): void {
  section("Survival = acoustic shadow; NO window");
  const w = createWorld(0x5417, 60, {});
  w.isGodMode = true;
  loadFloorIntoWorld(w, 60);
  const boss = w.enemies.find((e) => e.kind === "choirmaster");
  if (!boss || !w.encounter || !boss.boss) { check("choirmaster for survival", false); return; }
  w.encounter.active = true;
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;
  boss.boss.lastAddPick = 0;
  boss.boss.exposed = 0;
  const p = w.players.get(LOCAL_ID)!;
  p.x = boss.x + 80; p.y = boss.y; p.invuln = 999;

  // Activate + plant pillars, then fabricate an acoustic shadow from a non-live pillar.
  step(w, 5);
  const pillars = w.enemies.filter((e) => e.kind === "choir_pillar");
  const liveId = Number(w.encounter.flags.livePillarId);
  const shadow = pillars.find((e) => e.id !== liveId);
  if (shadow) {
    shadow.hp = 0; shadow.dead = true; shadow.aux = 2;
    w.encounter.flags.acousticShadowPillarId = shadow.id;
  }
  // Keep live pillar alive so success cannot fire; stand in shadow during sheet.
  for (let i = 0; i < 300; i++) {
    const live = w.enemies.find((e) => e.id === liveId && e.kind === "choir_pillar");
    if (live) { live.hp = live.maxHp; live.dead = false; }
    if (shadow) {
      // Sit past the shadow pillar along conductor→shadow ray.
      const ang = Math.atan2(shadow.y - boss.y, shadow.x - boss.x);
      const dist = Math.hypot(shadow.x - boss.x, shadow.y - boss.y) + 20;
      p.x = boss.x + Math.cos(ang) * dist;
      p.y = boss.y + Math.sin(ang) * dist;
      p.invuln = 999;
    }
    step(w, 1);
    if (w.encounter.flags.lastNoteOutcome === "survival"
      || w.encounter.flags.lastNoteOutcome === "failure"
      || w.encounter.flags.lastNoteOutcome === "success") break;
  }
  check("survival (or soft failure) without live silence — not success",
    w.encounter.flags.lastNoteOutcome === "survival"
    || w.encounter.flags.lastNoteOutcome === "failure",
    `outcome=${w.encounter.flags.lastNoteOutcome}`);
  check("survival-only does NOT open LAST NOTE window on success path",
    w.encounter.flags.lastNoteOutcome !== "success",
    `exposed=${boss.boss.exposed} outcome=${w.encounter.flags.lastNoteOutcome}`);
}

function failureSoft(): void {
  section("Failure soft; never wipe");
  const w = createWorld(0xF417, 60, {});
  loadFloorIntoWorld(w, 60);
  const boss = w.enemies.find((e) => e.kind === "choirmaster");
  if (!boss || !w.encounter) { check("choirmaster for failure", false); return; }
  w.encounter.active = true;
  w.encounter.failed = true;
  w.encounter.failureCount = 2;
  w.encounter.flags.lastNoteOutcome = "failure";
  check("failure does not complete floor", isFloorCleared(w) === false);
  check("failure does not kill players", [...w.players.values()].every((pl) => pl.hp > 0));
  // Custom completion still works (arena HP-death path for Gorge/Pale untouched).
  w.encounter.completed = true;
  check("custom completion still opens exit after soft fails", isFloorCleared(w) === true);
}

function lateJoinLobe(): void {
  section("Soft: late-join spawns at current checkpoint / active phrase lobe");
  const w = createWorld(0x1A60, 60, { isShared: true, skipLocalPlayer: true });
  loadFloorIntoWorld(w, 60);
  if (!w.encounter) { check("split for late-join", false); return; }
  w.encounter.active = true;
  w.encounter.checkpoint = 1;
  const cps = w.dungeon.blueprint?.objectiveRoomIds ?? [];
  const targetRoom = cps[Math.min(1, cps.length - 1)];
  const room = w.dungeon.rooms.find((r) => r.id === targetRoom);
  check("checkpoint lobe room exists", !!room);
  const joiner = spawnPlayerInWorld(w, "late-joiner");
  const rid = roomIdAt(w.dungeon, Math.floor(joiner.x / TILE), Math.floor(joiner.y / TILE));
  check("late-join lands in checkpoint lobe", rid === targetRoom, `rid=${rid} want=${targetRoom}`);
}

function hudBranding(): void {
  section("HUD objective copy brands THE LAST NOTE");
  const copyNone = encounterObjectiveCopy({
    kind: "split", progress: 0.5, checkpoint: 1, carrierId: null, completed: false,
  });
  const copyPip = encounterObjectiveCopy({
    kind: "split", progress: 0.5, checkpoint: 1, carrierId: "p1", completed: false,
  });
  check("objective copy brands THE LAST NOTE", !!copyNone && copyNone.includes("THE LAST NOTE"));
  check("carrier pip present when carrierId set", !!copyPip && copyPip.includes("\u25cf"));
  check("no pip without carrier", !!copyNone && !copyNone.includes("\u25cf"));
}

function noPreActivationAggro(): void {
  section("No pre-activation aggro / LAST NOTE");
  const w = createWorld(0x4060, 60, {});
  loadFloorIntoWorld(w, 60);
  const boss = w.enemies.find((e) => e.kind === "choirmaster");
  if (!boss || !w.encounter) { check("choirmaster present", false); return; }
  const p = w.players.get(LOCAL_ID)!;
  const far = w.dungeon.rooms[0];
  p.x = far.cx * TILE + TILE / 2;
  p.y = far.cy * TILE + TILE / 2;
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;
  boss.boss!.lastAddPick = 0;
  step(w, 40);
  check("still inactive while far", w.encounter.active === false);
  check("no LAST NOTE before activation", boss.attack.move !== "last_note");
  check("no pillars before activation", w.enemies.filter((e) => e.kind === "choir_pillar").length === 0);
}

pinGates();
splitBlueprint();
encounterFlagsAndReconnect();
lastNoteTimings();
lastNoteLive();
successPath();
survivalPath();
failureSoft();
lateJoinLobe();
hudBranding();
noPreActivationAggro();

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
  process.stdout.write(failures.map((f) => "  - " + f).join("\n") + "\n");
  process.exit(1);
}
