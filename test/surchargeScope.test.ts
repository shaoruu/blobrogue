// Regression TRAP for the elite-affix threat surcharge's floor scope (PR #244 balance gate).
//
// The surcharge (AFFIX_THREAT_SURCHARGE, balance.ts) is a PRE-F30 budget lever: an affixed elite
// trades chaff instead of adding free difficulty. It must NEVER fire at F31+, where the shipped
// "Unmaking" balance is already tuned — folding +1.0 into a simple-chassis elite's cost there
// (4.0 -> 5.0, still under ELITE_COST_CAP) silently makes F31+ easier. planFloorUnits guards it
// with `floor < RANDOMNESS_MIN_FLOOR`.
//
// THE TRAP (why this test is not vacuously green): the equality assertion below is measured over
// a matrix that provably CONTAINS the cases the bug would corrupt. applyRollAffix consumes no RNG,
// so varying ONLY the eliteAffixes argument between two spawnFloorEnemies calls isolates the
// surcharge's budget effect — any composition delta is purely the surcharge's spend. The trio is:
//   1. F31+ has MANY "biting" cases (>= BITING_MIN): forced-max affixes land on simple-chassis
//      elites whose cost the surcharge WOULD move if it were applied there.
//   2. AND YET at F31+ the spawn composition is IDENTICAL for real vs forced-max vs empty affixes —
//      because the guard turns the surcharge off. (Remove the guard and (1)'s biting cases break
//      this equality, turning the test RED — the whole point.)
//   3. Pre-F30 CONTROL: with the surcharge still active, affixes DO change composition — proving
//      the measurement can actually detect a difference, so the F31+ equality is meaningful.
//
// Run: tsx test/surchargeScope.test.ts

import { generateDungeon } from "../src/sim/dungeon.js";
import { spawnFloorEnemies, isBossFloor, isGauntletFloor, threatCostOf } from "../src/sim/enemies.js";
import type { FloorSpawns } from "../src/sim/enemies.js";
import { resolveFloorDescriptor, floorExtraElites, ELITE_AFFIX_POOL } from "../src/sim/floorRolls.js";
import type { EliteAffixRoll } from "../src/sim/floorRolls.js";
import { AFFIX_THREAT_SURCHARGE, ELITE_COST_CAP } from "../src/sim/balance.js";
import type { EnemyKind } from "../src/sim/types.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void { process.stdout.write(`\n[${name}]\n`); }

// The matrix: F31+ regular + miniboss floors only (boss floors floor%5==0 and the gauntlet early-
// return before planFloorUnits, so their spawns never read the surcharge), several seeds, P 1/2/4.
const PLAYERS: readonly number[] = [1, 2, 4];
const SEEDS: number[] = [];
for (let i = 0; i < 60; i++) SEEDS.push((0x9e3779b9 + i * 0x6d2b79f5) >>> 0);
const DEEP_FLOORS: number[] = [];
for (let f = 31; f <= 120; f++) DEEP_FLOORS.push(f);
// Pre-F30 control range: elites debut F6, and pre-F30 affixes roll from F6 up (floorRolls ramp).
const SHALLOW_FLOORS: number[] = [];
for (let f = 6; f <= 29; f++) SHALLOW_FLOORS.push(f);

const BITING_MIN = 20; // F31+ cases where the surcharge WOULD bite absent the guard (want plenty)
const CONTROL_MIN = 3; // pre-F30 cases where affixes DO change composition (a few is enough)

// A forced-max affix roster: every ordinal an elite could take carries a (non-null) affix. The
// concrete affix id is irrelevant — the surcharge is a flat +1.0 regardless — so any pool entry
// works. (floor>=9?2:1) + twinnedElites(+1) is at most 3 elites; 8 is comfortable headroom.
const FORCED_MAX_AFFIXES: readonly EliteAffixRoll[] = Array.from(
  { length: 8 },
  (_unused, ordinal): EliteAffixRoll => ({ ordinal, affix: ELITE_AFFIX_POOL[0] }),
);
const EMPTY_AFFIXES: readonly EliteAffixRoll[] = [];

// The floor's spawned composition as an order-agnostic multiset of (kind|tier) over active+pending.
function composition(spawns: FloorSpawns): string {
  const tally = new Map<string, number>();
  for (const e of [...spawns.active, ...spawns.pending]) {
    const key = `${e.kind}|${e.tier}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return [...tally.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, n]) => `${k}x${n}`).join(",");
}

// A simple-chassis elite (base cost 4.0) still prices UNDER ELITE_COST_CAP after +1.0, so the
// surcharge WOULD change the floor budget were it applied — this is the exact class that trips the
// bug. A complex/controller elite already sits at the cap, so the surcharge folds into the clamp
// (a no-op). Mirrors planFloorUnits' own fold: min(threatCostOf(kind,"elite") + surcharge, cap).
function surchargeBitesFor(kind: EnemyKind): boolean {
  const base = threatCostOf(kind, "elite");
  return Math.min(base + AFFIX_THREAT_SURCHARGE, ELITE_COST_CAP) > base;
}

// Mirror the live buildFloor path (world.ts loadFloorIntoWorld): resolve + freeze the descriptor,
// derive extraElites from its mutators, then spawn with everything held identical EXCEPT the
// eliteAffixes argument.
function spawnWith(seed: number, floor: number, players: number, affixes: readonly EliteAffixRoll[]): FloorSpawns {
  const dungeon = generateDungeon(seed, floor);
  const desc = resolveFloorDescriptor(seed, floor, players);
  const extraElites = floorExtraElites(desc.mutators);
  return spawnFloorEnemies(dungeon, seed, floor, players, 1, { extraElites, eliteAffixes: affixes });
}
function realAffixesAt(seed: number, floor: number, players: number): readonly EliteAffixRoll[] {
  return resolveFloorDescriptor(seed, floor, players).eliteAffixes;
}

function deepFloorEqualityTests(): void {
  section("F31+ (post-F30 Unmaking): elite affixes NEVER move spawn composition — surcharge is scoped out");
  let equalityHolds = true;
  let bitingCases = 0;
  let combosChecked = 0;
  let firstBreak = "";
  for (const seed of SEEDS) {
    for (const floor of DEEP_FLOORS) {
      if (isBossFloor(floor) || isGauntletFloor(floor)) continue; // early-return before planFloorUnits
      for (const players of PLAYERS) {
        const real = spawnWith(seed, floor, players, realAffixesAt(seed, floor, players));
        const forced = spawnWith(seed, floor, players, FORCED_MAX_AFFIXES);
        const empty = spawnWith(seed, floor, players, EMPTY_AFFIXES);
        combosChecked++;
        // Biting case: under forced-max affixes, at least one affixed elite is a simple chassis whose
        // cost the surcharge WOULD move — a case the bug would corrupt if the guard were removed.
        if ([...forced.active, ...forced.pending].some((e) => e.tier === "elite" && surchargeBitesFor(e.kind))) {
          bitingCases++;
        }
        const cReal = composition(real), cForced = composition(forced), cEmpty = composition(empty);
        if (!(cReal === cForced && cForced === cEmpty)) {
          equalityHolds = false;
          if (!firstBreak) firstBreak = `seed=0x${seed.toString(16)} F${floor} P${players}: real=${cReal} forced=${cForced} empty=${cEmpty}`;
        }
      }
    }
  }
  check("F31+ spawn composition is identical for real vs forced-max vs empty affixes",
    equalityHolds, firstBreak || `${combosChecked} combos identical`);
  check(`the matrix EXERCISES the bug: >= ${BITING_MIN} forced-max simple-chassis affixed elites present`,
    bitingCases >= BITING_MIN, `biting cases=${bitingCases} / ${combosChecked} combos`);
}

function shallowControlTests(): void {
  section("pre-F30 CONTROL: the surcharge is STILL active — affixes DO change composition");
  let candidates = 0;
  let positives = 0;
  const examples: string[] = [];
  for (const seed of SEEDS) {
    for (const floor of SHALLOW_FLOORS) {
      if (isBossFloor(floor) || isGauntletFloor(floor)) continue;
      for (const players of PLAYERS) {
        const real = spawnWith(seed, floor, players, realAffixesAt(seed, floor, players));
        // Only meaningful where an affixed SIMPLE-chassis elite actually placed: that's the only
        // unit whose +1.0 surcharge changes the budget (a complex elite absorbs it at the cap).
        const hasBitingAffixedElite = [...real.active, ...real.pending].some(
          (e) => e.tier === "elite" && e.rollAffix !== "" && surchargeBitesFor(e.kind));
        if (!hasBitingAffixedElite) continue;
        candidates++;
        const empty = spawnWith(seed, floor, players, EMPTY_AFFIXES);
        if (composition(real) !== composition(empty)) {
          positives++;
          if (examples.length < 3) examples.push(`seed=0x${seed.toString(16)} F${floor} P${players}`);
        }
      }
    }
  }
  check("pre-F30 has affixed simple-chassis elites to test against (non-vacuous control)",
    candidates > 0, `candidates=${candidates}`);
  check(`pre-F30 affixes DO change composition on >= ${CONTROL_MIN} floors (surcharge still budget-active)`,
    positives >= CONTROL_MIN,
    `positive control cases=${positives} / ${candidates} candidates${examples.length ? " e.g. " + examples.join("; ") : ""}`);
}

function main(): void {
  deepFloorEqualityTests();
  shallowControlTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nElite-affix surcharge is scoped to pre-F30 only; F31+ Unmaking balance is frozen.\n");
}

main();
