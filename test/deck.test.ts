// GATE 1 — the biome-selective encounter deck (roster.ts). Locks: the deck is deterministic from
// seed; a floor never over-draws or repeats a kind within its own hand; pre-F30 stays BYTE-
// IDENTICAL to the old cumulative roster (existing floors valid, goldens unchanged); and the Sump
// curation holds (signature core always in, curated-out kinds never appear, spice rotates).
//
// Run: npm run test:deck

import type { EnemyKind } from "../src/sim/types.js";
import { floorRoster, FAMILY_INTRO_FLOOR, REGION_ROSTERS } from "../src/sim/roster.js";
import { REGIONS, regionForFloor, biomeIndexForFloor } from "../src/sim/biomes.js";
import { BIOME_PRESSURE } from "../src/sim/balance.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void { process.stdout.write(`\n[${name}]\n`); }

const SEEDS = [0x1111, 0x2222, 0x51a9e, 0xDEAD, 0xC0FFEE, 7, 99999];
const complexShareOf = (floor: number): number => BIOME_PRESSURE[biomeIndexForFloor(floor)].complexShare;

// The pre-refactor cumulative roster, reproduced verbatim, as the byte-identical oracle.
function oldRoster(floor: number, complexShare: number): Array<{ kind: EnemyKind; weight: number }> {
  const roster: Array<{ kind: EnemyKind; weight: number }> = [{ kind: "slime", weight: 5 }];
  const has = (kind: EnemyKind): boolean => floor >= (FAMILY_INTRO_FLOOR[kind] ?? Infinity);
  if (has("bat")) roster.push({ kind: "bat", weight: 3 });
  if (has("skeleton")) roster.push({ kind: "skeleton", weight: 2 });
  if (has("spitter")) roster.push({ kind: "spitter", weight: (floor >= 3 ? 2 : 1) * complexShare });
  if (has("ghost")) roster.push({ kind: "ghost", weight: 2 * complexShare });
  if (has("charger")) roster.push({ kind: "charger", weight: 2 });
  if (has("burrower")) roster.push({ kind: "burrower", weight: 2 * complexShare });
  if (has("orbiter")) roster.push({ kind: "orbiter", weight: 2 * complexShare });
  if (has("shielder")) roster.push({ kind: "shielder", weight: 2 });
  if (has("rootward")) roster.push({ kind: "rootward", weight: 2 });
  if (has("caskbellows")) roster.push({ kind: "caskbellows", weight: 2 * complexShare });
  if (has("echojack")) roster.push({ kind: "echojack", weight: 1.5 * complexShare });
  if (has("seamcutter")) roster.push({ kind: "seamcutter", weight: 2 });
  if (has("sinderling")) roster.push({ kind: "sinderling", weight: 2.5 });
  if (has("mason")) roster.push({ kind: "mason", weight: 1.5 * complexShare });
  if (has("fragment")) roster.push({ kind: "fragment", weight: 2 * complexShare });
  return roster;
}

function eq(a: Array<{ kind: EnemyKind; weight: number }>, b: Array<{ kind: EnemyKind; weight: number }>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].kind !== b[i].kind || a[i].weight !== b[i].weight) return false;
  return true;
}

function determinismTests(): void {
  section("deck is deterministic from seed");
  let stable = true;
  for (const seed of SEEDS) {
    for (const floor of [3, 12, 25, 32, 40, 55, 80]) {
      const a = floorRoster(seed, floor, complexShareOf(floor));
      const b = floorRoster(seed, floor, complexShareOf(floor));
      if (!eq(a, b)) stable = false;
    }
  }
  check("same seed+floor => identical hand (every repeat)", stable);

  // Post-F30 varies WITH the seed (the anti-repetition rotation), while pre-F30 is seed-invariant.
  let sumpVaries = false;
  const baseSump = floorRoster(SEEDS[0], 40, complexShareOf(40)).map((r) => r.kind).join(",");
  for (const seed of SEEDS.slice(1)) {
    if (floorRoster(seed, 40, complexShareOf(40)).map((r) => r.kind).join(",") !== baseSump) sumpVaries = true;
  }
  check("Sump hand rotates across seeds (variety between runs)", sumpVaries);
  check("pre-F30 hand is seed-invariant (authored curriculum)",
    SEEDS.every((s) => eq(floorRoster(s, 12, complexShareOf(12)), floorRoster(SEEDS[0], 12, complexShareOf(12)))));
}

function noOverdrawTests(): void {
  section("a floor never over-draws or repeats a kind within its hand");
  let ok = true;
  const detail: string[] = [];
  for (const seed of SEEDS) {
    for (let floor = 1; floor <= 100; floor++) {
      const hand = floorRoster(seed, floor, complexShareOf(floor));
      const kinds = hand.map((r) => r.kind);
      // No repeat within the hand.
      if (new Set(kinds).size !== kinds.length) { ok = false; detail.push(`repeat @f${floor} s${seed.toString(16)}`); }
      // Never over-draws the region's introduced pool.
      const deck = REGION_ROSTERS[regionForFloor(floor).id];
      const introduced = deck.entries.filter((e) => floor >= (FAMILY_INTRO_FLOOR[e.kind] ?? Infinity));
      if (hand.length > introduced.length) { ok = false; detail.push(`over-draw @f${floor}`); }
      // Every weight is a positive finite number.
      if (hand.some((r) => !(r.weight > 0) || !Number.isFinite(r.weight))) { ok = false; detail.push(`bad weight @f${floor}`); }
    }
  }
  check("hands never repeat / over-draw / carry non-positive weights", ok, detail.slice(0, 3).join("; "));
}

function byteIdenticalTests(): void {
  section("pre-F30 stays byte-identical to the old cumulative roster");
  let identical = true;
  const detail: string[] = [];
  for (const seed of SEEDS) {
    for (let floor = 1; floor <= 30; floor++) {
      const cs = complexShareOf(floor);
      if (!eq(floorRoster(seed, floor, cs), oldRoster(floor, cs))) {
        identical = false;
        detail.push(`f${floor}`);
      }
    }
  }
  check("floors 1-30 reproduce the old roster exactly (kinds + weights + order)", identical, detail.slice(0, 5).join(","));
}

function sumpCurationTests(): void {
  section("the Sump deck is a curated INCLUDE + CARRYOVER, not the whole bestiary");
  // Signature core is ALWAYS present on every Sump floor (across seeds); curated-out kinds NEVER.
  const CURATED_OUT: EnemyKind[] = ["bat", "charger", "orbiter", "echojack", "rootward", "mason"];
  const SIGNATURES: EnemyKind[] = ["slime", "fragment", "sinderling", "spitter"];
  let sigAlways = true, outNever = true;
  const seen = new Set<EnemyKind>();
  for (const seed of SEEDS) {
    for (const floor of [31, 32, 40, 45, 50]) {
      const kinds = new Set(floorRoster(seed, floor, complexShareOf(floor)).map((r) => r.kind));
      for (const k of kinds) seen.add(k);
      if (!SIGNATURES.every((s) => kinds.has(s))) sigAlways = false;
      if (CURATED_OUT.some((c) => kinds.has(c))) outNever = false;
    }
  }
  check("Sump signature core (slime/fragment/sinderling/spitter) is always in the hand", sigAlways);
  check("Sump curates OUT bat/charger/orbiter/echojack/rootward/mason", outNever);
  check("Sump includes fragment (its native voice) — the F32 presence contract", seen.has("fragment"));
  check("Sump includes a swarm kind (slime) for the depth swarm-spacing gate", seen.has("slime"));

  // The spice tier actually rotates: over many seeds, more than one distinct spice kind appears.
  const spiceSeen = new Set<EnemyKind>();
  const SUMP_SIG = new Set<EnemyKind>(SIGNATURES);
  for (let seed = 1; seed <= 200; seed++) {
    for (const r of floorRoster(seed, 40, complexShareOf(40))) if (!SUMP_SIG.has(r.kind)) spiceSeen.add(r.kind);
  }
  check("Sump spice rotates (multiple distinct spice kinds appear across seeds)", spiceSeen.size >= 3, [...spiceSeen].join(","));
}

function dataDrivenTests(): void {
  section("the deck is data-driven — every region resolves to a roster");
  check("every region id has a deck", REGIONS.every((r) => REGION_ROSTERS[r.id] !== undefined && REGION_ROSTERS[r.id].entries.length > 0));
  check("post-F30 decks declare a spice draw (rotation); pre-F30 draw 0 (full pool)",
    ["sump", "veinworks", "pale", "nullcore"].every((id) => REGION_ROSTERS[id as keyof typeof REGION_ROSTERS].spiceDraw > 0) &&
    ["amberwild", "rootbound", "sunless", "deep", "gilded", "ember"].every((id) => REGION_ROSTERS[id as keyof typeof REGION_ROSTERS].spiceDraw === 0));
}

function main(): void {
  determinismTests();
  noOverdrawTests();
  byteIdenticalTests();
  sumpCurationTests();
  dataDrivenTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nGate 1 (biome-selective encounter deck) holds.\n");
}

main();
