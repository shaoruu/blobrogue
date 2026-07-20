// GATE 3 — the randomness DETERMINISM backbone (streams.ts + floorRolls.ts). The golden-master:
// "Not golden-mastered = doesn't ship." Locks THE ROLL-ORDER CONTRACT, resolve-once determinism
// across P=1..4, reconnect (rebuild the world from the same seed+floor+players == identical
// descriptor), same-seed replay, the generation caps + the density veto, and the frozen golden
// bytes. The descriptor is a pure function of (seed, floor, playerCountAtLock) and never rides the
// wire (clients recompute it), so it is reproduced here exactly as the sim + every client would.
//
// Run:      npm run test:determinism
// Recapture: npm run test:determinism -- --capture-current   (after an INTENTIONAL roll change)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { RollStream, ROLL_ORDER, rollStream } from "../src/sim/streams.js";
import {
  resolveFloorDescriptor, FLOOR_CAPS, RANDOMNESS_MIN_FLOOR,
  MUTATOR_POOL, ELITE_AFFIX_POOL, BOSS_AFFIX_POOL,
  floorHazardMutation, floorDashProfile, floorVisionMult, floorExtraElites,
} from "../src/sim/floorRolls.js";
import type { FloorDescriptor } from "../src/sim/floorRolls.js";
import { createWorld, loadFloorIntoWorld, spawnPlayerInWorld } from "../src/sim/world.js";
import { isBossFloor } from "../src/sim/enemies.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void { process.stdout.write(`\n[${name}]\n`); }

const SEEDS = [0x51a9eb0b, 0x1111, 0xC0FFEE, 0xDEAD, 42];
// Pre-F30 sample covers the fairness ramp (PRE_F30_LEVEL_VARIETY): F1 clean, F3/F4 band-1 hazards,
// F7 denseDark, F8 fracture + a possible 2-stack, F9 twinnedElites/2-elite, F12, F13 miniboss,
// F27 the heavy slot; boss floors F5/F30 stay clean. F31+ is the unchanged Unmaking behavior.
const FLOORS = [1, 3, 4, 5, 7, 8, 9, 12, 13, 27, 30, 31, 32, 35, 40, 45, 50, 55, 70, 71, 90, 91, 100];
const PLAYERS = [1, 2, 3, 4];

// The pre-F30 ramp's expected per-lever first floors (the test's independent oracle of the spec).
const MUTATOR_FIRST: Record<string, number> = { amberfall: 3, moltenFloor: 4, thinAir: 4, denseDark: 7, fractureStorm: 8, twinnedElites: 9 };
const AFFIX_FIRST: Record<string, number> = { enrage: 6, hazardTrail: 6, shielded: 8, splits: 9, reflect: 11 };
const MILD_SET = new Set(["amberfall", "moltenFloor", "thinAir"]);
const OPENER_FLOORS = new Set([6, 11, 16, 21, 26]);
const MINIBOSS_FLOORS = new Set([13, 18, 23, 28]);

const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = join(here, "golden", "determinism.json");

function j(d: FloorDescriptor): string { return JSON.stringify(d); }

// Build a WorldState locked at `floor` with exactly `players` seats — the reconnect / freeze path.
function worldDescriptorAt(seed: number, floor: number, players: number): FloorDescriptor {
  const w = createWorld(seed, 1, {});
  for (let i = 1; i < players; i++) spawnPlayerInWorld(w, `p${i}`);
  loadFloorIntoWorld(w, floor);
  return w.floorDescriptor;
}

function contractTests(): void {
  section("THE ROLL-ORDER CONTRACT (written + structurally locked)");
  check("stream ids are stable (0=mutators, 1=deck, 2=affixes, 3=boss)",
    RollStream.FLOOR_MUTATORS === 0 && RollStream.ENCOUNTER_DECK === 1 &&
    RollStream.ELITE_AFFIXES === 2 && RollStream.BOSS_AFFIX === 3);
  check("roll order is (1) mutators, (2) deck, (3) elite affixes, (4) boss affix",
    JSON.stringify(ROLL_ORDER) === JSON.stringify([RollStream.FLOOR_MUTATORS, RollStream.ENCOUNTER_DECK, RollStream.ELITE_AFFIXES, RollStream.BOSS_AFFIX]));
  // Named streams are independent: draining one never touches another (append never perturbs).
  const a = rollStream(123, 40, RollStream.FLOOR_MUTATORS);
  a.next(); a.next();
  const b1 = rollStream(123, 40, RollStream.BOSS_AFFIX).next();
  const b2 = rollStream(123, 40, RollStream.BOSS_AFFIX).next();
  check("named streams are independent (a later stream is unaffected by an earlier one's draws)", b1 === b2);
  // Elite-affix ordinal sub-keys a distinct sequence per spawn ordinal.
  check("elite-affix ordinals key distinct streams",
    rollStream(123, 40, RollStream.ELITE_AFFIXES, 0).next() !== rollStream(123, 40, RollStream.ELITE_AFFIXES, 1).next());
}

function determinismTests(): void {
  section("resolve-once determinism across P=1..4 + same-seed replay");
  let stable = true;
  for (const seed of SEEDS) for (const floor of FLOORS) for (const p of PLAYERS) {
    const first = j(resolveFloorDescriptor(seed, floor, p));
    for (let rep = 0; rep < 3; rep++) if (j(resolveFloorDescriptor(seed, floor, p)) !== first) stable = false;
  }
  check("resolveFloorDescriptor is bit-stable on replay (every seed/floor/P)", stable);

  section("reconnect: rebuilding the world from the same seed+floor+players is identical");
  let reconnectOk = true;
  let freezeOk = true;
  for (const seed of [SEEDS[0], SEEDS[2]]) for (const floor of [31, 35, 40, 50]) for (const p of PLAYERS) {
    const a = worldDescriptorAt(seed, floor, p);
    const b = worldDescriptorAt(seed, floor, p);
    if (j(a) !== j(b)) reconnectOk = false;
    // The world's FROZEN descriptor equals the pure resolve (the freeze wiring is honest).
    if (j(a) !== j(resolveFloorDescriptor(seed, floor, p))) freezeOk = false;
    if (a.playerCountAtLock !== p) freezeOk = false;
  }
  check("reconnect: two worlds at the same seed+floor+players freeze the identical descriptor", reconnectOk);
  check("the world's frozen descriptor == the pure resolve (freeze wiring honest)", freezeOk);
}

function capsAndVetoTests(): void {
  section("caps enforced at generation + the density controller's deterministic veto");
  let capsOk = true;
  for (const seed of SEEDS) for (const floor of FLOORS) for (const p of PLAYERS) {
    const d = resolveFloorDescriptor(seed, floor, p);
    if (d.mutators.length > FLOOR_CAPS.maxMutators) capsOk = false;
    if (new Set(d.mutators).size !== d.mutators.length) capsOk = false; // no duplicate mutator
    if (d.eliteAffixes.length > FLOOR_CAPS.eliteAffixSlots) capsOk = false;
    // Pre-F30 (PRE_F30_LEVEL_VARIETY): F1 + boss floors stay clean (empty descriptor); non-boss
    // floors ramp mutators/affixes on but NEVER roll a boss affix (that is F31+ only).
    if (floor < RANDOMNESS_MIN_FLOOR) {
      if (d.bossAffix !== null) capsOk = false;
      if ((floor === 1 || isBossFloor(floor)) && (d.mutators.length > 0 || d.eliteAffixes.length > 0)) capsOk = false;
    }
    // A boss affix only on a boss floor past F30.
    if (d.bossAffix !== null && !(isBossFloor(floor) && floor >= RANDOMNESS_MIN_FLOOR)) capsOk = false;
    // The frozen projected density never exceeds the locked budget (the veto held).
    if (d.projectedDensity > d.densityBudget + 1e-9) capsOk = false;
  }
  check("mutator/affix/boss caps + pre-F30 emptiness + post-veto density all hold", capsOk);

  // The veto is a PURE function of player count: it can only tighten as players are added, and it
  // fires deterministically. Find a (seed, floor) where P=4 vetoes but the raw roll at P=1 didn't.
  let vetoObserved = false;
  let vetoDeterministic = true;
  for (const seed of SEEDS) for (const floor of FLOORS) {
    const d4a = resolveFloorDescriptor(seed, floor, 4);
    const d4b = resolveFloorDescriptor(seed, floor, 4);
    if (j(d4a) !== j(d4b)) vetoDeterministic = false;
    if (d4a.isDensityVetoed) vetoObserved = true;
    // Adding players never RAISES the budget (monotone tightening).
    const d1 = resolveFloorDescriptor(seed, floor, 1);
    if (d4a.densityBudget > d1.densityBudget) vetoDeterministic = false;
  }
  check("the density veto is deterministic + monotone in player count", vetoDeterministic);
  check("the density veto actually fires for some deep floor at 4P (framework exercised)", vetoObserved);
}

// PRE_F30_LEVEL_VARIETY: the fairness ramp. Across a wide seed matrix, pre-F30 floors must honor
// per-lever eligibility, the calm gates (F1 + boss floors clean, post-boss openers 0 mutators),
// the miniboss restriction (≤1 mild mutator + ≤1 affix slot), and still turn the levers on.
function preF30RampTests(): void {
  section("pre-F30 fairness ramp: per-lever eligibility + calm gates + miniboss restriction");
  const RAMP_SEEDS = Array.from({ length: 400 }, (_, i) => i * 2654435761 + 777);
  const seenMut = new Set<string>();
  const seenAffix = new Set<string>();
  let eligibilityOk = true;
  let calmOk = true;
  let minibossOk = true;
  for (const seed of [...SEEDS, ...RAMP_SEEDS]) {
    for (let floor = 1; floor < 31; floor++) {
      const d = resolveFloorDescriptor(seed, floor, 1);
      // F1 + boss floors: fully clean.
      if ((floor === 1 || isBossFloor(floor)) && (d.mutators.length > 0 || d.eliteAffixes.length > 0)) calmOk = false;
      // Post-boss openers: zero mutators.
      if (OPENER_FLOORS.has(floor) && d.mutators.length > 0) calmOk = false;
      // Per-lever eligibility: no mutator/affix before its first floor.
      for (const m of d.mutators) { seenMut.add(m); if (floor < (MUTATOR_FIRST[m] ?? Infinity)) eligibilityOk = false; }
      for (const e of d.eliteAffixes) if (e.affix !== null) { seenAffix.add(e.affix); if (floor < (AFFIX_FIRST[e.affix] ?? Infinity)) eligibilityOk = false; }
      // Miniboss floors: ≤1 mutator, mild-only, ≤1 affix slot.
      if (MINIBOSS_FLOORS.has(floor)) {
        if (d.mutators.length > 1) minibossOk = false;
        if (d.mutators.some((m) => !MILD_SET.has(m))) minibossOk = false;
        if (d.eliteAffixes.length > 1) minibossOk = false;
      }
    }
  }
  check("pre-F30 respects per-lever eligibility (no lever before its first floor)", eligibilityOk);
  check("pre-F30 calm gates hold (F1 + boss clean, openers 0 mutators)", calmOk);
  check("miniboss floors are ≤1 mild mutator + ≤1 affix slot", minibossOk);
  // The ramp actually turns the levers on pre-F30: every pre-F30-eligible lever is reachable.
  check("every pre-F30-eligible mutator is reachable before F31", [...Object.keys(MUTATOR_FIRST)].every((m) => seenMut.has(m)), [...seenMut].join(","));
  check("every pre-F30-eligible affix is reachable before F31", [...Object.keys(AFFIX_FIRST)].every((a) => seenAffix.has(a)), [...seenAffix].join(","));
}

// The AUTHORED Wave 1 content: every rolled id is a real authored pool member (no stubs), every
// authored mutator/affix/boss-affix is reachable across the seed matrix, and every mutator's
// EXPRESSION helper is a pure deterministic function of the frozen set.
function contentTests(): void {
  section("authored content: real pools, full coverage, deterministic expression");
  const mutatorIds = new Set(MUTATOR_POOL.map((m) => m.id));
  const seenMut = new Set<string>();
  const seenAffix = new Set<string>();
  const seenBoss = new Set<string>();
  let idsValid = true;
  const WIDE_SEEDS = Array.from({ length: 240 }, (_, i) => i * 2654435761 + 12345);
  for (const seed of [...SEEDS, ...WIDE_SEEDS]) for (const floor of FLOORS) for (const p of PLAYERS) {
    const d = resolveFloorDescriptor(seed, floor, p);
    for (const m of d.mutators) { seenMut.add(m); if (!mutatorIds.has(m as never)) idsValid = false; }
    for (const e of d.eliteAffixes) if (e.affix !== null) { seenAffix.add(e.affix); if (ELITE_AFFIX_POOL.indexOf(e.affix as never) === -1) idsValid = false; }
    if (d.bossAffix !== null) { seenBoss.add(d.bossAffix); if (BOSS_AFFIX_POOL.indexOf(d.bossAffix as never) === -1) idsValid = false; }
  }
  check("every rolled id is a real authored pool member (no stubs)", idsValid);
  check("all 6 authored floor mutators are reachable", seenMut.size === MUTATOR_POOL.length && MUTATOR_POOL.every((m) => seenMut.has(m.id)), [...seenMut].join(","));
  check("all 5 authored elite affixes are reachable", seenAffix.size === ELITE_AFFIX_POOL.length, [...seenAffix].join(","));
  check("all 3 authored boss affixes are reachable", seenBoss.size === BOSS_AFFIX_POOL.length, [...seenBoss].join(","));

  // Expression helpers are pure + deterministic, and identity when their mutator is absent.
  const idle = floorHazardMutation([], 31);
  check("hazard expression is identity with no hazard mutator", idle.budgetMult === 1 && idle.biasKinds.length === 0);
  check("molten raises the hazard budget + biases fire vents", floorHazardMutation(["moltenFloor"], 31).biasKinds.includes("fire_vent") && floorHazardMutation(["moltenFloor"], 31).budgetMult > 1);
  check("thinAir tunes the dash; identity otherwise", floorDashProfile(["thinAir"], 31).speedMult > 1 && floorDashProfile([], 31).speedMult === 1);
  check("denseDark contracts vision; identity otherwise", floorVisionMult(["denseDark"], 31) < 1 && floorVisionMult([], 31) === 1);
  check("twinnedElites adds one elite; none otherwise", floorExtraElites(["twinnedElites"]) === 1 && floorExtraElites([]) === 0);
  // Purity: the same frozen set always yields the same expression.
  check("expression helpers are pure (repeat-stable)",
    JSON.stringify(floorHazardMutation(["moltenFloor", "amberfall"], 31)) === JSON.stringify(floorHazardMutation(["moltenFloor", "amberfall"], 31)));

  // Intensity ramp (PRE_F30_LEVEL_VARIETY_NUMBERS.md §2): pre-F30 is scaled DOWN vs F31+, reaching
  // the F31+ value by F26-30. F31+ returns exactly today's constants.
  check("amberfall hazard mult ramps up: F3 < F31+ (=1.40)",
    floorHazardMutation(["amberfall"], 3).budgetMult < floorHazardMutation(["amberfall"], 31).budgetMult
    && Math.abs(floorHazardMutation(["amberfall"], 31).budgetMult - 1.40) < 1e-9
    && Math.abs(floorHazardMutation(["amberfall"], 3).budgetMult - 1.15) < 1e-9);
  check("moltenFloor hazard mult ramps up: F4 (=1.20) < F31+ (=1.50)",
    Math.abs(floorHazardMutation(["moltenFloor"], 4).budgetMult - 1.20) < 1e-9
    && Math.abs(floorHazardMutation(["moltenFloor"], 31).budgetMult - 1.50) < 1e-9);
  check("denseDark vision milder early: F7 (=0.85) > F31+ (=0.72)",
    Math.abs(floorVisionMult(["denseDark"], 7) - 0.85) < 1e-9 && Math.abs(floorVisionMult(["denseDark"], 31) - 0.72) < 1e-9);
  check("thinAir dash gentler early: F4 speed (=1.15) < F31+ speed (=1.28)",
    Math.abs(floorDashProfile(["thinAir"], 4).speedMult - 1.15) < 1e-9 && Math.abs(floorDashProfile(["thinAir"], 31).speedMult - 1.28) < 1e-9);
  check("F26-30 reaches the F31+ intensity (seamless into the Unmaking)",
    Math.abs(floorHazardMutation(["amberfall"], 27).budgetMult - floorHazardMutation(["amberfall"], 31).budgetMult) < 1e-9
    && Math.abs(floorVisionMult(["denseDark"], 27) - floorVisionMult(["denseDark"], 31)) < 1e-9
    && floorDashProfile(["thinAir"], 27).speedMult === floorDashProfile(["thinAir"], 31).speedMult);

  // The density veto is SENSIBLE at 4P: whenever it fires, the surviving mutators fit the (tighter)
  // 4P budget and it only ever DROPS mutators (never invents one), keeping stored seeds stable.
  let vetoSane = true;
  for (const seed of SEEDS) for (const floor of FLOORS) {
    const d4 = resolveFloorDescriptor(seed, floor, 4);
    if (d4.projectedDensity > d4.densityBudget + 1e-9) vetoSane = false;
    if (d4.isDensityVetoed && d4.mutators.length >= FLOOR_CAPS.maxMutators) vetoSane = false; // a veto removed at least one
  }
  check("the 4P density veto keeps surviving mutators within budget (sensible at 4P)", vetoSane);
}

function goldenBytes(): Record<string, FloorDescriptor> {
  const out: Record<string, FloorDescriptor> = {};
  for (const seed of SEEDS) for (const floor of FLOORS) for (const p of PLAYERS) {
    out[`${seed}|${floor}|${p}`] = resolveFloorDescriptor(seed, floor, p);
  }
  return out;
}

function capture(): void {
  writeFileSync(goldenPath, JSON.stringify(goldenBytes(), null, 2) + "\n");
  process.stdout.write(`captured determinism golden: ${Object.keys(goldenBytes()).length} entries -> ${goldenPath}\n`);
}

function goldenMasterTests(): void {
  section("golden-master: the frozen roll results match the stored golden");
  let golden: Record<string, FloorDescriptor>;
  try {
    golden = JSON.parse(readFileSync(goldenPath, "utf8")) as Record<string, FloorDescriptor>;
  } catch {
    check("determinism golden exists (run with --capture-current to seed it)", false);
    return;
  }
  const now = goldenBytes();
  const keysMatch = JSON.stringify(Object.keys(golden).sort()) === JSON.stringify(Object.keys(now).sort());
  check("golden covers the same seed/floor/P matrix", keysMatch);
  let allMatch = true;
  const detail: string[] = [];
  for (const k of Object.keys(now)) {
    if (JSON.stringify(now[k]) !== JSON.stringify(golden[k])) { allMatch = false; detail.push(k); }
  }
  check("every frozen descriptor matches the golden (P=1..4 + reconnect + replay)", allMatch, detail.slice(0, 4).join(" "));
}

function main(): void {
  contractTests();
  determinismTests();
  capsAndVetoTests();
  preF30RampTests();
  contentTests();
  goldenMasterTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nGate 3 (randomness determinism backbone) holds — golden-mastered across P=1..4 + reconnect + replay.\n");
}

if (process.argv.includes("--capture-current")) capture(); else main();
