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
  L3, forEachLegalBuild, practicalBossDps, measureBossTtk,
} from "./dpsHarness.js";
import {
  createWorld, spawnPlayerInWorld, setPlayerKit, stepPlayerPhase, stepWorldPhase,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { InputCmd } from "../src/sim/input.js";
import type { SimEvent } from "../src/sim/events.js";
import type { EnemyKind } from "../src/sim/types.js";
import type { PlayerMods } from "../src/sim/items.js";
import { PU_DPS, refDpsForFloor, BOSS_MIN_LEGAL_TTK } from "../src/sim/balance.js";
import { OVERDRIVE, MENDER_HEAL_CLAMP, LIFEBLOOM, ULT, TICKS_PER_SECOND } from "../src/sim/kits.js";

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

function main(): void {
  gate1OverdriveCeiling();
  gate2BossFloorWithOverdrive();
  gate3MenderFacetank();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll kit-ult balance gates hold.\n");
}

main();
