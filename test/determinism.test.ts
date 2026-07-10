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
const FLOORS = [1, 5, 30, 31, 32, 35, 40, 45, 50, 55, 70, 71, 90, 91, 100];
const PLAYERS = [1, 2, 3, 4];

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
    // Pre-F30 is the authored curriculum: no mutators, no boss affix.
    if (floor < RANDOMNESS_MIN_FLOOR && (d.mutators.length > 0 || d.bossAffix !== null || d.eliteAffixes.length > 0)) capsOk = false;
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
  const idle = floorHazardMutation([]);
  check("hazard expression is identity with no hazard mutator", idle.budgetMult === 1 && idle.biasKinds.length === 0);
  check("molten raises the hazard budget + biases fire vents", floorHazardMutation(["moltenFloor"]).biasKinds.includes("fire_vent") && floorHazardMutation(["moltenFloor"]).budgetMult > 1);
  check("thinAir tunes the dash; identity otherwise", floorDashProfile(["thinAir"]).speedMult > 1 && floorDashProfile([]).speedMult === 1);
  check("denseDark contracts vision; identity otherwise", floorVisionMult(["denseDark"]) < 1 && floorVisionMult([]) === 1);
  check("twinnedElites adds one elite; none otherwise", floorExtraElites(["twinnedElites"]) === 1 && floorExtraElites([]) === 0);
  // Purity: the same frozen set always yields the same expression.
  check("expression helpers are pure (repeat-stable)",
    JSON.stringify(floorHazardMutation(["moltenFloor", "amberfall"])) === JSON.stringify(floorHazardMutation(["moltenFloor", "amberfall"])));

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
  contentTests();
  goldenMasterTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nGate 3 (randomness determinism backbone) holds — golden-mastered across P=1..4 + reconnect + replay.\n");
}

if (process.argv.includes("--capture-current")) capture(); else main();
