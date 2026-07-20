// GATE 1 — the biome-selective encounter deck (roster.ts). Locks: the deck is deterministic from
// seed; a floor never over-draws or repeats a kind within its own hand; the six CURATED pre-F30
// regions (PRE_F30_LEVEL_VARIETY §7) keep their signature core always in and rotate their spice
// per floor/seed; and the Sump curation holds (signature core always in, curated-out kinds never
// appear, spice rotates).
//
// Run: npm run test:deck

import type { EnemyKind } from "../src/sim/types.js";
import { floorRoster, FAMILY_INTRO_FLOOR, REGION_ROSTERS } from "../src/sim/roster.js";
import { REGIONS, regionForFloor, biomeIndexForFloor } from "../src/sim/biomes.js";
import type { RegionId } from "../src/sim/biomes.js";
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

  // Both post-F30 AND (now) pre-F30 curated regions vary WITH the seed — the anti-repetition
  // rotation is the whole Tier 1 fix. A large-spice-pool floor in each range must rotate.
  const rotatesAcrossSeeds = (floor: number): boolean => {
    const base = floorRoster(SEEDS[0], floor, complexShareOf(floor)).map((r) => r.kind).join(",");
    return SEEDS.slice(1).some((s) => floorRoster(s, floor, complexShareOf(floor)).map((r) => r.kind).join(",") !== base);
  };
  check("Sump hand rotates across seeds (variety between runs)", rotatesAcrossSeeds(40));
  check("pre-F30 curated hand rotates across seeds (F12 Sunless — the anti-repetition fix)", rotatesAcrossSeeds(12));
  check("pre-F30 curated hand rotates across seeds (F27 Emberreach)", rotatesAcrossSeeds(27));
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

function curatedShapeTests(): void {
  section("pre-F30 regions are curated (signature core always in, spice rotates, cores ratified)");
  // Per-region signature core (PRE_F30_LEVEL_VARIETY_NUMBERS.md §7) + a floor where every core kind
  // is introduced. The core is ALWAYS in the hand once introduced; spice draws around it.
  const CORES: Array<{ region: RegionId; floor: number; core: EnemyKind[] }> = [
    { region: "amberwild", floor: 2, core: ["slime", "bat", "skeleton"] },
    { region: "rootbound", floor: 9, core: ["slime", "rootward", "orbiter"] },
    { region: "sunless", floor: 12, core: ["slime", "spitter", "caskbellows"] },
    { region: "deep", floor: 17, core: ["slime", "charger", "seamcutter"] },
    { region: "gilded", floor: 22, core: ["slime", "shielder", "echojack"] },
    { region: "ember", floor: 29, core: ["slime", "sinderling", "mason"] },
  ];
  let coreAlways = true;
  const detail: string[] = [];
  for (const { floor, core } of CORES) {
    for (const seed of SEEDS) {
      const kinds = new Set(floorRoster(seed, floor, complexShareOf(floor)).map((r) => r.kind));
      if (!core.every((k) => kinds.has(k))) { coreAlways = false; detail.push(`f${floor}`); }
    }
  }
  check("each region's signature core is always in the hand (once introduced)", coreAlways, detail.slice(0, 3).join(","));

  // The declared tiers match the ratified cores — Rootbound's Wren swap: rootward is the core
  // guard, skeleton is demoted to spice.
  const tierOf = (region: RegionId, kind: EnemyKind): string | undefined =>
    REGION_ROSTERS[region].entries.find((e) => e.kind === kind)?.tier;
  check("Rootbound core is rootward (the ratified Wren swap), skeleton demoted to spice",
    tierOf("rootbound", "rootward") === "signature" && tierOf("rootbound", "skeleton") === "spice");

  // rootward debuts F8, so the Rootbound core gracefully falls back on F6-7 (slime present,
  // rootward absent until its intro, never an empty hand).
  let f67Ok = true;
  for (const seed of SEEDS) for (const floor of [6, 7]) {
    const kinds = floorRoster(seed, floor, complexShareOf(floor)).map((r) => r.kind);
    if (kinds.length === 0 || kinds.includes("rootward") || !kinds.includes("slime")) f67Ok = false;
  }
  check("Rootbound F6-7 gracefully falls back (slime core present, rootward absent until F8, never empty)", f67Ok);

  // F1 is slime-only (the locked tutorial baseline).
  let f1Ok = true;
  for (const seed of SEEDS) {
    const kinds = floorRoster(seed, 1, complexShareOf(1)).map((r) => r.kind);
    if (kinds.length !== 1 || kinds[0] !== "slime") f1Ok = false;
  }
  check("F1 hand is slime-only (tutorial baseline)", f1Ok);
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
  check("every region declares a spice draw; Amberwild draws 1 (tutorial legibility), the rest 2",
    ["sump", "veinworks", "pale", "nullcore"].every((id) => REGION_ROSTERS[id as keyof typeof REGION_ROSTERS].spiceDraw > 0) &&
    REGION_ROSTERS.amberwild.spiceDraw === 1 &&
    ["rootbound", "sunless", "deep", "gilded", "ember"].every((id) => REGION_ROSTERS[id as keyof typeof REGION_ROSTERS].spiceDraw === 2));
}

function main(): void {
  determinismTests();
  noOverdrawTests();
  curatedShapeTests();
  sumpCurationTests();
  dataDrivenTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nGate 1 (biome-selective encounter deck) holds.\n");
}

main();
