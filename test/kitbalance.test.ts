// KIT-ULT BALANCE GATES (the balancer's headless verification for the shipped kit/ult system,
// docs/specs/blobrogue_KIT_XP_SYSTEM_spec.md §2/§10). Three deterministic, pure-sim/analytical
// gates that GUARD against edge-case breaches and REPORT the measured numbers the balancer
// reads to finalize or apply its fallbacks. No rendering, no wall-clock — every gate reuses the
// EXISTING practical-DPS + boss-TTK harness (test/dpsHarness.ts) and reads its baselines /
// refDPS / floors / clamp constants from the shipped modules, so a future retune flows straight
// through and the gates re-measure against it.
//
//   GATE 1 — Overdrive's peak 5s-window DPS (the gunner's Resonance-window burst) stays under
//            the 7.5× pistol-baseline ceiling across every legal build.
//   GATE 2 — no boss dies below its high-roll TTK floor even with a perfectly-timed Overdrive
//            burst on the exposed beat.
//   GATE 3 — a Mender facetank nets HP-negative: the shared incoming-heal clamp can't offset a
//            boss's focused fire, and two vs four Menders hit the SAME clamped ceiling.
//
// A real breach here must NOT be forced to pass by editing the balance constants — it is
// reported with the exact measured number (the balancer owns the fallback lever).
//
// Run: npx tsx test/kitbalance.test.ts

import {
  L3, forEachLegalBuild, practicalBossDps, measureBossTtk, grant,
} from "./dpsHarness.js";
import {
  createWorld, spawnPlayerInWorld, setPlayerKit, stepPlayerPhase, stepWorldPhase,
  devSpawnEnemy, acquireWeaponInWorld,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { InputCmd } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { SimEvent } from "../src/sim/events.js";
import type { EnemyKind, WeaponId } from "../src/sim/types.js";
import type { PlayerMods } from "../src/sim/items.js";
import { WEAPONS } from "../src/sim/weapons.js";
import { PU_DPS, refDpsForFloor, BOSS_MIN_LEGAL_TTK, CAPS, BOSS_VULN_CAP } from "../src/sim/balance.js";
import { SHOCK_DMG_MULT, FROZEN_DMG_MULT } from "../src/sim/constants.js";
import { liveDamageMult, liveFireRateMult, gunnerDamageMult, gunnerFireRateMult } from "../src/sim/weaponStats.js";
import type { Bullet } from "../src/sim/types.js";
import {
  OVERDRIVE, MENDER_HEAL_CLAMP, LIFEBLOOM, HEAL_PULSE, ULT, TICKS_PER_SECOND, ticksToSec,
  MOMENTUM, OVERHEAT, OVERSHIELD, HARDENED, MAX_TOTAL_DR, PHANTOM_MARK,
  refEncounterHpForFloor, ultChargeFromKill, ultChargeFromDamageDealt, ultShareCapUnits, ultTimeChargePerTick,
} from "../src/sim/kits.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}
function report(line: string): void {
  process.stdout.write(`  report: ${line}\n`);
}

const FIXED_DT = 1 / TICKS_PER_SECOND; // the authoritative 20Hz tick the ult/heal systems run at

// ---- GATE 1 — OVERDRIVE + RESONANCE window ≤ 7.5× pistol baseline ----

function gate1OverdriveCeiling(): void {
  section("GATE 1 — Overdrive peak 5s-window DPS ≤ 7.5× pistol baseline, across the 100k legal builds");
  // The pistol baseline is the harness's canonical unit (2 dmg / 0.16s = 12.5) — read it, never
  // hardcode, so a baseline retune re-scales the ceiling with it.
  const baseline = PU_DPS;
  const ceilingMult = 7.5;
  const ceilingDps = ceilingMult * baseline;
  const peaks: number[] = [];
  let maxMult = 0;
  let maxBuild = "";
  forEachLegalBuild(({ weapon, owned, mods }) => {
    // (a) normal practical boss DPS; (b) the Overdrive window: the fire rate becomes the SEPARATE
    // clamped LAYER min(fireRateMult × fireFactor, expressiveFireCeiling) exactly as the sim's
    // currentFireRate bakes it, plus +2 pierce (pierce adds no single-target boss DPS, so it does
    // not enter this model). There is NO player-facing Resonance discharge in the sim — Overdrive
    // IS the gunner's Resonance-window burst — so the peak 5s-window DPS is precisely the
    // Overdrive-boosted practical boss DPS.
    const overdriveMods: PlayerMods = {
      ...mods,
      fireRateMult: Math.min(mods.fireRateMult * OVERDRIVE.fireFactor, OVERDRIVE.expressiveFireCeiling),
    };
    const overdriveDps = practicalBossDps(weapon, overdriveMods);
    peaks.push(overdriveDps);
    const mult = overdriveDps / baseline;
    if (mult > maxMult) { maxMult = mult; maxBuild = `${weapon} + [${owned.join(",")}]`; }
  });
  peaks.sort((a, b) => b - a);
  const maxDps = peaks[0];
  const top1pctDps = peaks[Math.floor(peaks.length * 0.01)];
  const top1pctMult = top1pctDps / baseline;

  check(`peak Overdrive-window DPS ≤ ${ceilingMult}× pistol baseline (${ceilingDps.toFixed(2)} DPS)`,
    maxDps <= ceilingDps + 1e-9,
    `max ${maxMult.toFixed(2)}× (${maxDps.toFixed(2)} DPS) vs ceiling ${ceilingMult}× (${ceilingDps.toFixed(2)} DPS)`);
  report(`GATE 1 — top-1% = ${top1pctMult.toFixed(2)}× (${top1pctDps.toFixed(2)} DPS), max = ${maxMult.toFixed(2)}× (${maxDps.toFixed(2)} DPS); ceiling ${ceilingMult}× = ${ceilingDps.toFixed(2)} DPS; peak build: ${maxBuild}`);
  if (maxDps > ceilingDps) {
    report(`GATE 1 BREACH — max ${maxMult.toFixed(2)}× exceeds ${ceilingMult}×. Balancer fallback ready (fireFactor 1.9→1.6); NOT applied here.`);
  }
}

// ---- GATE 2 — per-boss floor holds with a worst-case Overdrive burst on the exposed window ----

// The existing high-roll gate's representative builds (mirrors BOSS_GATE_ROWS in
// test/balance.test.ts: smg + Deadeye Lv3 + the depth's Glass Cannon stack). Re-run here with a
// worst-case Overdrive burst layered on. The floor per boss is read from BOSS_MIN_LEGAL_TTK.
const GATE2_BOSSES: ReadonlyArray<{ kind: EnemyKind; floor: number; highRoll: string[] }> = [
  { kind: "boss", floor: 5, highRoll: [...L3("deadeye"), "glass_cannon"] },
  { kind: "marrow", floor: 15, highRoll: [...L3("deadeye"), "glass_cannon", "glass_cannon"] },
  { kind: "weaver", floor: 20, highRoll: [...L3("deadeye"), "glass_cannon", "glass_cannon"] },
  { kind: "gilded", floor: 25, highRoll: [...L3("deadeye"), ...L3("glass_cannon")] },
  { kind: "choir", floor: 30, highRoll: [...L3("deadeye"), ...L3("glass_cannon")] },
];

function gate2BossFloorWithOverdrive(): void {
  section("GATE 2 — every boss stays ≥ its high-roll TTK floor even under a perfectly-timed Overdrive burst");
  // Re-run the existing per-boss high-roll TTK gate (smg + the representative high-roll build), now
  // carried by a GUNNER — the only kit that has Overdrive (the shipped currentFireRate applies the
  // fire-boost only for the gunner). The gunner's Momentum passive perma-stacks in this stationary
  // god-mode harness, which models a FLAWLESS player who never takes a hit (the strongest legal
  // gunner). On top of that, Overdrive is granted AVAILABLE and perfectly-timed at the design's
  // cooldown-limited maximum uptime. `base` isolates Overdrive's delta (same gunner, no ult).
  let tightestMargin = Infinity;
  let tightestBoss = "";
  let tightestKilled = false;
  for (const { kind, floor, highRoll } of GATE2_BOSSES) {
    const min = BOSS_MIN_LEGAL_TTK[kind] ?? 20;
    const base = measureBossTtk("smg", highRoll, { kind, floor }, { kit: "gunner" });
    const withOd = measureBossTtk("smg", highRoll, { kind, floor }, { kit: "gunner", forceOverdrive: true });
    const holds = !(withOd.killed && withOd.seconds < min);
    check(`${kind} @F${floor} never dies below its ${min}s floor with a worst-case Overdrive burst`,
      holds,
      withOd.killed ? `ttk=${withOd.seconds.toFixed(1)}s (floor ${min}s; ${base.seconds.toFixed(1)}s gunner without OD)` : `unkilled after ${withOd.seconds.toFixed(0)}s (floor ${min}s)`);
    // Margin = measured TTK − floor. An unkilled boss outlasted the whole 180s harness window, so
    // its measured seconds is a LOWER BOUND on the true TTK (the margin it reports is a fortiori).
    const margin = withOd.seconds - min;
    if (margin < tightestMargin) { tightestMargin = margin; tightestBoss = kind; tightestKilled = withOd.killed; }
    report(`GATE 2 — ${kind}: ${withOd.killed ? `killed ${withOd.seconds.toFixed(1)}s` : `unkilled ${withOd.seconds.toFixed(0)}s`} with OD (${base.seconds.toFixed(1)}s gunner no-OD), floor ${min}s, margin ${margin >= 0 ? "+" : ""}${margin.toFixed(1)}s`);
  }
  report(`GATE 2 — tightest boss margin = ${tightestMargin >= 0 ? "+" : ""}${tightestMargin.toFixed(1)}s (${tightestBoss}${tightestKilled ? ", killed" : ", unkilled → lower bound"})`);
}

// ---- GATE 3 — Mender facetank nets negative (heal can't offset a boss) ----

function partyHp(w: WorldState): number {
  let hp = 0;
  for (const p of w.players.values()) hp += p.hp;
  return hp;
}

function idleCmd(): InputCmd {
  return { seq: 0, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false, interact: false, ult: false };
}

// Drive one authoritative 20Hz tick (server order: player phase per player, then world phase,
// then tick++) — the same order the shipped sim runs, so the real per-target/party heal clamp
// (incomingHealRoom / consumeIncomingHeal / menderHeal) is exercised, not re-derived.
function tick(w: WorldState, perPlayer: (p: PlayerSim) => InputCmd): SimEvent[] {
  const ev: SimEvent[] = [];
  for (const p of w.players.values()) stepPlayerPhase(w, p, perPlayer(p), FIXED_DT, ev);
  stepWorldPhase(w, FIXED_DT, ev);
  w.tick++;
  return ev;
}

interface FacetankTrend {
  incomingDps: number;         // the boss's focused DPS on the one target (refDPS)
  bossTotalDps: number;        // the boss's total output (one boss = its refDPS)
  realizedTargetHps: number;   // realized heal RATE to the focused target (HP/s)
  realizedPartyHps: number;    // realized total party heal RATE (HP/s)
  targetHpStart: number;
  targetHpEnd: number;
}

// A pure-sim facetank: `menderCount` Menders (the healers, held at full HP) run Lifebloom +
// Sanctuary at MAX healing over `targetCount` wounded ally bodies (the heal sinks), all routed
// through the shipped shared heal clamp. The boss focuses ONE target (targets[0]) for its full
// refDPS. Measures the realized heal RATES + the focused target's HP trend.
//   - targetCount = 1 is the literal facetank (the boss's focus): it exposes the PER-TARGET
//     clamped ceiling, which is invariant to Mender count (max-not-sum, no double-stacking).
//   - targetCount ≥ 3 saturates the PARTY budget, exposing that ceiling — likewise invariant.
function measureMenderFacetank(menderCount: number, targetCount: number): FacetankTrend {
  const floor = 20; // worst-case boss floor: F20 Weaver
  const incomingDps = refDpsForFloor(floor); // ~36 — read from the balance constants
  const bossTotalDps = incomingDps;          // a single boss's total output is its refDPS
  const w = createWorld(0xB0BA_9E7, floor, { isShared: true, skipLocalPlayer: true });
  w.enemies = []; // isolate the heal-clamp math from ambient floor spawns (we model the boss's DPS)

  const menders: PlayerSim[] = [];
  for (let i = 0; i < menderCount; i++) {
    const id = `m${i}`;
    spawnPlayerInWorld(w, id);
    setPlayerKit(w, id, "mender"); // full HP: the Menders are the healing SOURCES, not sinks
    menders.push(w.players.get(id)!);
  }
  const anchor = menders[0];
  const targets: PlayerSim[] = [];
  for (let i = 0; i < targetCount; i++) {
    const t = spawnPlayerInWorld(w, `t${i}`);
    // A deep HP pool held mid-bar so every heal lands (never overheal-discarded) and the incoming
    // DPS carves a visible trend without the body dying mid-measurement — we assert on the slope.
    t.maxHp = 400;
    t.hp = 200;
    targets.push(t);
  }
  const victim = targets[0]; // the boss focuses ONE target
  victim.hp = 300;
  // Co-locate every Mender + target so all Lifebloom + Sanctuary sources cover the whole party.
  for (const m of menders) { m.x = anchor.x; m.y = anchor.y; }
  for (const t of targets) { t.x = anchor.x; t.y = anchor.y; }

  // Fill + cast every Sanctuary (the on-cast burst lands once; the sustained HoT is what the
  // clamp governs). One cast tick before the measurement window so the burst never pollutes the
  // realized-RATE read.
  for (const m of menders) { m.ultCharge = ULT.meterMax; m.ultReadyAtTick = 0; }
  tick(w, (p) => ({ ...idleCmd(), ult: menders.indexOf(p) !== -1 }));

  const windowTicks = TICKS_PER_SECOND * 3; // a 3s sustained window (inside the 4s Sanctuary life)
  const windowSeconds = windowTicks / TICKS_PER_SECOND;
  const dmgPerTick = incomingDps / TICKS_PER_SECOND;
  const targetHpStart = victim.hp;
  let realizedTarget = 0;
  let realizedParty = 0;
  for (let t = 0; t < windowTicks; t++) {
    // Pin every Mender's Lifebloom pool full so its passive HoT always has whole-HP credit to pay
    // out — "run at max healing", the worst case for the shared clamp.
    for (const m of menders) m.passiveState = LIFEBLOOM.poolCap;
    const preTarget = victim.hp;
    const prePartyHp = partyHp(w);
    tick(w, () => idleCmd()); // the sim runs Lifebloom + Sanctuary HoT through the shared clamp
    realizedTarget += Math.max(0, victim.hp - preTarget);
    realizedParty += Math.max(0, partyHp(w) - prePartyHp);
    // The boss's focused incoming damage, applied AFTER the heal read so the realized-heal number
    // is clean (the HP trend is the assertion).
    victim.hp = Math.max(0, victim.hp - dmgPerTick);
  }
  return {
    incomingDps, bossTotalDps,
    realizedTargetHps: realizedTarget / windowSeconds,
    realizedPartyHps: realizedParty / windowSeconds,
    targetHpStart, targetHpEnd: victim.hp,
  };
}

function gate3MenderFacetank(): void {
  section("GATE 3 — Mender facetank nets HP-negative (the shared clamp can't offset a boss)");
  // The literal facetank: the boss focuses ONE target, N Menders pile all their healing onto it.
  const two = measureMenderFacetank(2, 1);
  const four = measureMenderFacetank(4, 1);

  for (const [label, t] of [["2 Menders", two], ["4 Menders", four]] as Array<[string, FacetankTrend]>) {
    // (a) the boss's focused incoming DPS EXCEEDS the realized heal to that target (net negative).
    check(`${label}: focused incoming DPS (${t.incomingDps}) exceeds realized heal to the target (${t.realizedTargetHps.toFixed(2)} HP/s)`,
      t.incomingDps > t.realizedTargetHps,
      `net ${(t.realizedTargetHps - t.incomingDps).toFixed(2)} HP/s`);
    check(`${label}: the focused target's HP trends DOWN over the fight (net HP negative)`,
      t.targetHpEnd < t.targetHpStart,
      `${t.targetHpStart.toFixed(1)} → ${t.targetHpEnd.toFixed(1)} HP`);
    // (b) party-wide realized sustain < the boss's total output.
    check(`${label}: party-wide realized sustain (${t.realizedPartyHps.toFixed(2)} HP/s) < boss total output (${t.bossTotalDps})`,
      t.realizedPartyHps < t.bossTotalDps);
    // The realized rates never breach the shipped clamp ceilings (the code path caps them).
    check(`${label}: realized per-target heal ≤ the clamp ceiling (${MENDER_HEAL_CLAMP.perTargetHpPerSec} HP/s)`,
      t.realizedTargetHps <= MENDER_HEAL_CLAMP.perTargetHpPerSec + 1e-9,
      `realized=${t.realizedTargetHps.toFixed(2)} HP/s`);
  }
  // Max-not-sum: piling FOUR Menders on one focused target heals it no faster than TWO — the
  // per-target clamp caps combined output regardless of Mender count (no double-stacking).
  check("the per-target clamp caps combined output regardless of Mender count (2 vs 4 → same ceiling)",
    Math.abs(two.realizedTargetHps - four.realizedTargetHps) < 1e-9,
    `2M=${two.realizedTargetHps.toFixed(2)} vs 4M=${four.realizedTargetHps.toFixed(2)} HP/s`);

  // The PARTY budget: saturate it with several wounded bodies so the party ceiling (not the
  // target count) binds — and confirm it too is invariant to Mender count.
  const twoParty = measureMenderFacetank(2, 4);
  const fourParty = measureMenderFacetank(4, 4);
  for (const [label, t] of [["2 Menders", twoParty], ["4 Menders", fourParty]] as Array<[string, FacetankTrend]>) {
    check(`${label}: saturated party sustain (${t.realizedPartyHps.toFixed(2)} HP/s) ≤ the clamp ceiling (${MENDER_HEAL_CLAMP.partyHpPerSec} HP/s) and < boss output (${t.bossTotalDps})`,
      t.realizedPartyHps <= MENDER_HEAL_CLAMP.partyHpPerSec + 1e-9 && t.realizedPartyHps < t.bossTotalDps,
      `realized=${t.realizedPartyHps.toFixed(2)} HP/s`);
  }
  check("the party clamp caps combined output regardless of Mender count (2 vs 4 → same ceiling)",
    Math.abs(twoParty.realizedPartyHps - fourParty.realizedPartyHps) < 1e-9,
    `2M=${twoParty.realizedPartyHps.toFixed(2)} vs 4M=${fourParty.realizedPartyHps.toFixed(2)} HP/s`);

  report(`GATE 3 — 2 Menders facetank: target HP ${two.targetHpStart.toFixed(0)}→${two.targetHpEnd.toFixed(0)} (net ${(two.targetHpEnd - two.targetHpStart).toFixed(1)}), realized ${two.realizedTargetHps.toFixed(2)} HP/s vs focused incoming ${two.incomingDps} DPS`);
  report(`GATE 3 — 4 Menders facetank: target HP ${four.targetHpStart.toFixed(0)}→${four.targetHpEnd.toFixed(0)} (net ${(four.targetHpEnd - four.targetHpStart).toFixed(1)}), realized ${four.realizedTargetHps.toFixed(2)} HP/s vs focused incoming ${four.incomingDps} DPS`);
  report(`GATE 3 — saturated party sustain: 2M=${twoParty.realizedPartyHps.toFixed(2)} HP/s, 4M=${fourParty.realizedPartyHps.toFixed(2)} HP/s (clamp ceiling ${MENDER_HEAL_CLAMP.partyHpPerSec}, boss output ${twoParty.bossTotalDps} DPS)`);
}

// ---- GATE 4 — the Wave 1 charge REWEIGHT: a fill is PLAY-driven, not a silent timer ----

// Play sources are the capped, actively-earned inputs (dmg / kill / taken / heal / dash); the
// remainder of a fill is the combat-gated time FLOOR. p.ultSources tracks the play sources
// (time is uncapped and bypasses that bookkeeping), so at any pre-clamp moment
// timeContribution = ultCharge − sum(play sources).
function sumPlaySources(src: PlayerSim["ultSources"]): number {
  return src.dmg + src.kill + src.taken + src.heal + src.dash;
}

// Conventional sustained-fire projectile guns: the family whose practical-DPS model matches an
// autofire-at-range sim (excludes melee + the deployable/trap/charge "effect-wave" weapons and
// the special legendaries, whose DPS is laid down as traps/orbits/beams the autofire probe can't
// reproduce — a median across THOSE would mismodel the fill rate).
const CORE_GUNS = new Set<WeaponId>([
  "pistol", "shotgun", "rapid", "smg", "cannon", "burst", "ricochet", "homing", "tesla",
  "sawnoff", "railgun", "nailer", "flamer", "mortar",
]);

// The deterministic MEDIAN conventional-gun build by practical DPS — a faithful, reproducible
// stand-in for "a median mid-game player." Read from the SAME 100k legal-build stream GATE 1
// iterates, so a future retune flows straight through.
function medianConventionalBuild(): { weapon: WeaponId; owned: string[]; dps: number } {
  const builds: Array<{ dps: number; weapon: WeaponId; owned: string[] }> = [];
  forEachLegalBuild(({ weapon, owned, mods }) => {
    if (!CORE_GUNS.has(weapon)) return;
    builds.push({ dps: practicalBossDps(weapon, mods), weapon, owned });
  });
  builds.sort((a, b) => a.dps - b.dps);
  const m = builds[Math.floor(builds.length / 2)];
  return { weapon: m.weapon, owned: m.owned, dps: m.dps };
}

const idle20: InputCmd = { seq: 0, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false, interact: false, ult: false };

// Drive a GUNNER on the median build to a full meter against the given target, measuring what
// FRACTION of the fill was PLAY (dmg + kill) vs the passive time floor. Runs at the authoritative
// 20Hz (the tick rate the time floor + combatFillSeconds are authored against). "normal" respawns
// trash to keep sustained combat (kills + damage); "boss" is a bottomless King dummy (sustained
// damage, no kills), both always-damageable.
function measureFillPlayShare(scenario: "normal" | "boss", build: { weapon: WeaponId; owned: string[] }): {
  playPct: number; fillSeconds: number; kills: number; filled: boolean;
} {
  const floor = scenario === "boss" ? 5 : 3;
  const w = createWorld(0x0175_0B0A, floor, { isSandbox: true });
  w.isGodMode = true;
  w.enemies = []; // isolate from ambient floor spawns; we drive the encounter explicitly
  const p = w.players.get(LOCAL_ID)!;
  setPlayerKit(w, LOCAL_ID, "gunner");
  acquireWeaponInWorld(w, LOCAL_ID, build.weapon);
  grant(w, LOCAL_ID, build.owned);
  p.invuln = 0;

  const spawnTarget = (): void => {
    if (scenario === "boss") {
      const e = devSpawnEnemy(w, "boss", p.x + 150, p.y);
      e.hp = 1e9; e.maxHp = 1e9; // bottomless: sustained damage, never a kill
    } else {
      devSpawnEnemy(w, "slime", p.x + 130, p.y);
    }
  };
  spawnTarget();

  let kills = 0, lastPlaySum = 0, lastCharge = 0;
  const maxTicks = TICKS_PER_SECOND * 300;
  let t = 0;
  while (p.ultCharge < ULT.meterMax && t < maxTicks) {
    if (scenario === "normal" && !w.enemies.some((e) => !e.dead)) spawnTarget();
    const target = w.enemies.find((e) => !e.dead);
    const aim = target ? Math.atan2(target.y - p.y, target.x - p.x) : 0;
    const ev: SimEvent[] = [];
    for (const pl of w.players.values()) stepPlayerPhase(w, pl, { ...idle20, firing: pl.id === LOCAL_ID, aim }, FIXED_DT, ev);
    stepWorldPhase(w, FIXED_DT, ev);
    w.tick++;
    for (const e of ev) if (e.t === "enemyKill") kills++;
    if (p.ultCharge < ULT.meterMax) { lastPlaySum = sumPlaySources(p.ultSources); lastCharge = p.ultCharge; }
    t++;
  }
  return {
    playPct: lastCharge > 0 ? (lastPlaySum / lastCharge) * 100 : 0,
    fillSeconds: t / TICKS_PER_SECOND,
    kills,
    filled: p.ultCharge >= ULT.meterMax,
  };
}

function gate4ChargeReweight(): void {
  section("GATE 4 — Wave 1 charge reweight: a fill is PLAY-driven (target ~70:30, floor 60:40)");
  const build = medianConventionalBuild();
  report(`GATE 4 — median conventional-gun build: ${build.weapon} + [${build.owned.join(",")}] (~${build.dps.toFixed(1)} practical boss DPS)`);

  const normal = measureFillPlayShare("normal", build);
  const boss = measureFillPlayShare("boss", build);
  check("normal floor: PLAY contributes >= 60% of a fill (not a silent timer)",
    normal.filled && normal.playPct >= 60,
    `play:time = ${normal.playPct.toFixed(0)}:${(100 - normal.playPct).toFixed(0)} over ${normal.fillSeconds.toFixed(1)}s, ${normal.kills} kills`);
  check("boss-only fight: PLAY contributes >= 60% of a fill",
    boss.filled && boss.playPct >= 60,
    `play:time = ${boss.playPct.toFixed(0)}:${(100 - boss.playPct).toFixed(0)} over ${boss.fillSeconds.toFixed(1)}s`);
  report(`GATE 4 — modeled targets ~64:36 normal / ~67:33 boss; measured ${normal.playPct.toFixed(0)}:${(100 - normal.playPct).toFixed(0)} / ${boss.playPct.toFixed(0)}:${(100 - boss.playPct).toFixed(0)}`);
  if (normal.playPct < 60 || boss.playPct < 60) {
    report(`GATE 4 — play:time under 60 at the current combatFillSeconds (${ULT.combatFillSeconds}s); balancer fallback: bump to 130s.`);
  }

  // Anti-stall net: even a LOW-DPS kit that only lands ~1 kill + 0.5×RefHP of damage over a 100s
  // sustained boss fight STILL fills the meter (the time floor guarantees ~1 ult by combatFill).
  // Modeled with the shipped pure functions (the balancer's own model), share-caps respected.
  const floor = 5;
  const refHp = refEncounterHpForFloor(floor);
  const dmgUnits = Math.min(ultChargeFromDamageDealt(0.5 * refHp, refHp), ultShareCapUnits("dmg"));
  const killUnits = Math.min(ultChargeFromKill(), ultShareCapUnits("kill"));
  const timeUnits = ultTimeChargePerTick() * TICKS_PER_SECOND * 100; // 100s of combat-gated floor
  const total = dmgUnits + killUnits + timeUnits;
  check("anti-stall: a low-DPS 100s boss fight (~1 kill + 0.5xRefHP) still fills the meter",
    total >= ULT.meterMax,
    `dmg=${dmgUnits} + kill=${killUnits} + time=${timeUnits} = ${total} vs meterMax ${ULT.meterMax}`);
}

// ---- GATE 5 — no kit SIGNATURE pushes a measured stat over the raw caps (Wave 2 ship gate) ----

function enemyBulletAt(x: number, y: number): Bullet {
  return { x, y, vx: 0, vy: 0, radius: 5, life: 1, friendly: false, owner: null, damage: 1, color: "#fff", pierce: 0, hitList: null, isCrit: false };
}

function gate5SignatureRawCaps(): void {
  section("GATE 5 — no kit signature pushes a MEASURED stat over the raw caps (dmg ≤2.25×, fire ≤1.8×), across the 100k legal builds");
  let maxDmg = 0, maxFire = 0, dmgViol = 0, fireViol = 0;
  forEachLegalBuild(({ mods }) => {
    // The gunner's WORST-CASE live signature: full Momentum + the Overheat burst BOTH active,
    // layered on the (already-capped) build multipliers at death's-door HP (the strongest live
    // base via berserk/adrenaline). gunnerDamageMult/gunnerFireRateMult RE-CLAMP to the raw caps
    // — this gate proves the "faster route to the cap, never above it" guarantee empirically.
    const dmg = gunnerDamageMult(liveDamageMult(mods, 1), MOMENTUM.maxStacks);
    const fire = gunnerFireRateMult(liveFireRateMult(mods, 1), MOMENTUM.maxStacks, true);
    if (dmg > maxDmg) maxDmg = dmg;
    if (fire > maxFire) maxFire = fire;
    if (dmg > CAPS.damageMult + 1e-9) dmgViol++;
    if (fire > CAPS.fireRateMult + 1e-9) fireViol++;
  });
  check(`Momentum+Overheat damage never exceeds the raw cap (${CAPS.damageMult}×)`, dmgViol === 0, `max ${maxDmg.toFixed(3)}× violations=${dmgViol}`);
  check(`Momentum+Overheat fire never exceeds the raw cap (${CAPS.fireRateMult}×)`, fireViol === 0, `max ${maxFire.toFixed(3)}× violations=${fireViol}`);
  report(`GATE 5 — max realized gunner-signature dmg ${maxDmg.toFixed(3)}× (cap ${CAPS.damageMult}), fire ${maxFire.toFixed(3)}× (cap ${CAPS.fireRateMult}); Overheat is a faster route to the cap in a window, never above it`);
}

// ---- GATE 6 — Bulwark realized total DR (Hardened + overshield) ≤ MAX_TOTAL_DR under a facetank ----

// Measure realized total damage reduction under a SUSTAINED integer-HP facetank at `cadenceTicks`
// over `windowSeconds` (long enough that the one-time 3-chip buffer amortizes into the ONGOING
// mitigation the cap governs). DR = 1 − (HP lost / total incoming). Under sustained fire the
// overshield regen is paused, so realized DR converges toward Hardened + the amortized chips.
function measureBulwarkRealizedDR(cadenceTicks: number, windowSeconds: number): { dr: number; incoming: number; lost: number } {
  const w = createWorld(0xB0_DE7, 5, { isShared: true, skipLocalPlayer: true });
  w.enemies = [];
  spawnPlayerInWorld(w, "b"); setPlayerKit(w, "b", "bulwark");
  const b = w.players.get("b")!; b.maxHp = 1e7; b.hp = 1e7; // a deep pool: never downs, measure the slope
  const ticks = Math.round(windowSeconds * TICKS_PER_SECOND);
  const hp0 = b.hp;
  let incoming = 0;
  for (let t = 0; t < ticks; t++) {
    if (t % cadenceTicks === 0) { b.invuln = 0; w.bullets.push(enemyBulletAt(b.x, b.y)); incoming += 1; }
    tick(w, () => idleCmd());
  }
  const lost = hp0 - b.hp;
  return { dr: incoming > 0 ? 1 - lost / incoming : 0, incoming, lost };
}

function gate6BulwarkRealizedDR(): void {
  section("GATE 6 — Bulwark realized total DR (Hardened + overshield) ≤ MAX_TOTAL_DR under a sustained facetank");
  // A sweep of SUSTAINED cadences (fire at least every ~2s, faster than the 4s regen so the
  // overshield stays a one-time buffer, not perpetual absorption — the facetank the cap protects).
  const cadences = [1, 2, 4, 10, 20, 40];
  let maxDr = 0, maxCad = 0;
  for (const c of cadences) {
    const m = measureBulwarkRealizedDR(c, 120);
    if (m.dr > maxDr) { maxDr = m.dr; maxCad = c; }
    check(`realized DR ≤ ${MAX_TOTAL_DR} at a hit every ${c} ticks (${(c / TICKS_PER_SECOND).toFixed(2)}s)`,
      m.dr <= MAX_TOTAL_DR + 1e-9,
      `DR=${m.dr.toFixed(3)} (lost ${m.lost}/${m.incoming})`);
  }
  report(`GATE 6 — max realized total DR ${maxDr.toFixed(3)} (at every ${maxCad}t) vs cap ${MAX_TOTAL_DR}; Hardened ${HARDENED.reduction} + overshield ~${(maxDr - HARDENED.reduction).toFixed(3)} realized. If a measured uptime pushed this over, the balancer slows regen to ${OVERSHIELD.regenTicks < 100 ? "100t (1/5s)" : "1/5s"}.`);
}

// ---- GATE 7 — Mender pulse + passives ≤ the shared clamp to one ally / party (Wave 2 ship gate) ----

// Two Menders spam the directed heal-pulse (on cooldown) AT one deeply-wounded ally while their
// Lifebloom + Sanctuary HoT also run — the sustained combined rate must not exceed the shared
// per-target clamp (the pulse burst bypasses the rate-clamp-DOWN but CONSUMES the budget). A long
// window averages the 6s-CD burst into the sustained rate the cap governs.
function measurePulsePlusPassives(menderCount: number, windowSeconds: number): { targetHps: number; partyHps: number } {
  const floor = 20;
  const w = createWorld(0xB0BA_9E7, floor, { isShared: true, skipLocalPlayer: true });
  w.enemies = [];
  const menders: PlayerSim[] = [];
  for (let i = 0; i < menderCount; i++) { const id = `m${i}`; spawnPlayerInWorld(w, id); setPlayerKit(w, id, "mender"); menders.push(w.players.get(id)!); }
  const anchor = menders[0];
  const victim = spawnPlayerInWorld(w, "t");
  victim.maxHp = 4000; victim.hp = 2000; // deep pool held mid-bar so every heal lands (never overheal)
  for (const m of menders) { m.x = anchor.x; m.y = anchor.y; }
  victim.x = anchor.x + 20; victim.y = anchor.y; // to the +x of every Mender (under the aim reticle)
  for (const m of menders) { m.ultCharge = ULT.meterMax; m.ultReadyAtTick = 0; }
  tick(w, (p) => ({ ...idleCmd(), ult: menders.indexOf(p) !== -1 })); // drop Sanctuary once (burst excluded below)
  const ticks = Math.round(windowSeconds * TICKS_PER_SECOND);
  const hp0 = victim.hp;
  let party = 0;
  for (let t = 0; t < ticks; t++) {
    for (const m of menders) m.passiveState = LIFEBLOOM.poolCap; // pin Lifebloom credit full (worst case)
    const prePartyHp = partyHp(w);
    // Every Mender holds the pulse (aim +x toward the victim) AND re-drops Sanctuary as it lapses.
    tick(w, (p) => {
      const isMender = menders.indexOf(p) !== -1;
      const wantUlt = isMender && p.ultReadyAtTick <= w.tick && p.ultCharge >= ULT.meterMax;
      return { ...idleCmd(), aim: 0, pulse: isMender, ult: wantUlt };
    });
    // Keep every Mender's meter topped so Sanctuary re-drops (sustained worst case).
    for (const m of menders) if (m.ultReadyAtTick <= w.tick) m.ultCharge = ULT.meterMax;
    party += Math.max(0, partyHp(w) - prePartyHp);
  }
  const seconds = ticks / TICKS_PER_SECOND;
  return { targetHps: (victim.hp - hp0) / seconds, partyHps: party / seconds };
}

function gate7MenderPulseClamp(): void {
  section("GATE 7 — Mender heal-pulse + Lifebloom + Sanctuary combined ≤ the shared clamp (2 Menders on one ally)");
  const two = measurePulsePlusPassives(2, 30);
  check(`2 Menders (pulse + passives) sustain ≤ the per-target clamp (${MENDER_HEAL_CLAMP.perTargetHpPerSec} HP/s) to one ally`,
    two.targetHps <= MENDER_HEAL_CLAMP.perTargetHpPerSec + 0.05,
    `realized ${two.targetHps.toFixed(3)} HP/s`);
  check(`2 Menders (pulse + passives) sustain ≤ the party clamp (${MENDER_HEAL_CLAMP.partyHpPerSec} HP/s)`,
    two.partyHps <= MENDER_HEAL_CLAMP.partyHpPerSec + 0.05,
    `realized ${two.partyHps.toFixed(3)} HP/s`);
  report(`GATE 7 — 2 Menders spamming pulse + passives on one ally: ${two.targetHps.toFixed(3)} HP/s to target (cap ${MENDER_HEAL_CLAMP.perTargetHpPerSec}), ${two.partyHps.toFixed(3)} HP/s party (cap ${MENDER_HEAL_CLAMP.partyHpPerSec})`);
}

// ---- GATE 8 — Phantom mark + shock/freeze combined vulnerability ≤ BOSS_VULN_CAP on a boss ----

function gate8PhantomMarkBossCap(): void {
  section("GATE 8 — Phantom mark + shock/freeze combined vulnerability ≤ BOSS_VULN_CAP (1.35×) on a boss");
  // On a boss the crit channel + the phantom mark SHARE the cap; statuses (shock/freeze) amplify
  // NOTHING on boss-grade bodies (utility only). Drive real hits into a boss and measure the
  // realized vulnerability vs a clean baseline — with mark, shock AND freeze all live.
  const measure = (opts: { mark: boolean; shock: boolean; freeze: boolean; critMult: number }): number => {
    const w = createWorld(0x1234, 5, { isShared: true, skipLocalPlayer: true }); w.enemies = [];
    spawnPlayerInWorld(w, "ph"); setPlayerKit(w, "ph", "phantom");
    const ph = w.players.get("ph")!;
    const boss = devSpawnEnemy(w, "boss", ph.x + 120, ph.y);
    const hp0 = boss.hp;
    if (opts.mark) boss.markT = ticksToSec(PHANTOM_MARK.durationTicks);
    if (opts.shock) boss.shock = 3;
    if (opts.freeze) boss.chill = 99; // deep chill => frozen (bosses slow, but the amp is inert on boss anyway)
    const shot: Bullet = { ...enemyBulletAt(boss.x, boss.y), radius: 30, life: 0.5, friendly: true, owner: "ph", damage: 10 * opts.critMult, isCrit: opts.critMult > 1, critX: opts.critMult };
    w.bullets.push(shot);
    for (let i = 0; i < 3; i++) tick(w, () => idleCmd());
    return hp0 - boss.hp;
  };
  const base = measure({ mark: false, shock: false, freeze: false, critMult: 1 });
  const allNoCrit = measure({ mark: true, shock: true, freeze: true, critMult: 1 });
  const allMaxCrit = measure({ mark: true, shock: true, freeze: true, critMult: 3 });
  check("mark + shock + freeze (no crit) combined vulnerability ≤ BOSS_VULN_CAP",
    allNoCrit / base <= BOSS_VULN_CAP + 1e-6,
    `combined ${(allNoCrit / base).toFixed(3)}× vs cap ${BOSS_VULN_CAP}`);
  check("mark + shock + freeze + MAX crit combined vulnerability ≤ BOSS_VULN_CAP (never additive)",
    allMaxCrit / base <= BOSS_VULN_CAP + 1e-6,
    `combined ${(allMaxCrit / base).toFixed(3)}× vs cap ${BOSS_VULN_CAP}`);
  report(`GATE 8 — boss vulnerability: mark+shock+freeze no-crit ${(allNoCrit / base).toFixed(3)}×, +max-crit ${(allMaxCrit / base).toFixed(3)}× (cap ${BOSS_VULN_CAP}); statuses amplify nothing on boss, mark shares the crit cap`);
}

function main(): void {
  gate1OverdriveCeiling();
  gate2BossFloorWithOverdrive();
  gate3MenderFacetank();
  gate4ChargeReweight();
  gate5SignatureRawCaps();
  gate6BulwarkRealizedDR();
  gate7MenderPulseClamp();
  gate8PhantomMarkBossCap();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll kit-ult balance gates hold.\n");
}

main();
