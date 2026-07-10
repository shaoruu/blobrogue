// GATE 1 — the biome-selective encounter deck (docs/blobrogue_WAVE1_FOUNDATIONS.md). Replaces the
// old cumulative/global floorRoster (every unlocked enemy on every deep floor — the repetition
// Ian feels) with a per-REGION deck: each region declares an INCLUDE set + an explicit CARRYOVER
// whitelist, tiered SIGNATURE (common) vs SPICE (rare). A floor draws a HAND — every introduced
// signature kind always in, plus a bounded draw-WITHOUT-replacement subset of the introduced
// spice kinds (seeded off the ENCOUNTER_DECK named stream, contract step 2). A floor never
// over-draws (hand <= pool) and never repeats a kind within its own hand.
//
// Pre-F30 regions declare every kind SIGNATURE with the historical weights and spiceDraw 0, so
// their hand is the full introduced pool in the historical order — BYTE-IDENTICAL to the old
// cumulative roster (existing floors stay valid; goldens unchanged; NO rng consumed). Post-F30
// regions curate INCLUDE + CARRYOVER + a rotating spice draw, so consecutive Sump floors differ.
//
// Adding a region or an enemy is DATA (a row here), not code.

import type { EnemyKind } from "./types.js";
import { regionForFloor } from "./biomes.js";
import type { RegionId } from "./biomes.js";
import { RollStream, rollStream } from "./streams.js";

// The corrected gate §2 cadence table (moved here from enemies.ts — it is deck curriculum data):
// each regular archetype's first legal floor. F1 slime only; F2 expands (bat, skeleton, spitter —
// the flock's first isolated floor); F3 remixes (+ghost, charger); F4 proves (+burrower, first
// guaranteed brute); F6 the orbiter's isolated teaching room; F7 the shielder wall. The bestiary
// wave extends the cadence down the biome ladder: rootward walls Rootbound (F8), caskbellows holds
// Sunless lanes (F11) where the echojack's noise starts lying (F13), the seamcutter tears the
// Deep's load seams (F16), the sinderling feeds Emberreach's vents (F26), the mason bricks them
// (F28), and the fragment sings only after the Choir falls (F31).
export const FAMILY_INTRO_FLOOR: Readonly<Partial<Record<EnemyKind, number>>> = {
  slime: 1, bat: 2, skeleton: 2, spitter: 2, ghost: 3, charger: 3,
  burrower: 4, orbiter: 6, shielder: 7,
  rootward: 8, caskbellows: 11, echojack: 13, seamcutter: 16, sinderling: 26, mason: 28, fragment: 31,
};

export type RosterTier = "signature" | "spice";

// One deck row. `complexWeighted` multiplies the weight by the biome's complexShare (the old
// roster's `* complexShare`). `introTaper` overrides the weight on the kind's OWN intro floor (a
// gentle first lesson — currently only the spitter, weight 1 the floor it debuts, 2 after).
export interface RosterEntry {
  kind: EnemyKind;
  weight: number;
  tier: RosterTier;
  complexWeighted?: boolean;
  introTaper?: number;
}

export interface RegionRoster {
  entries: readonly RosterEntry[];
  spiceDraw: number; // how many introduced SPICE kinds this region draws into a floor's hand
}

// The pre-F30 curriculum deck: the exact cumulative roster the old floorRoster built, in the
// exact push order + weights, every kind SIGNATURE (so a floor's hand is the full introduced
// pool). Shared by all six pre-F30 regions (their decks WERE the one cumulative curriculum). Do
// not reorder — the order is part of the byte-identical contract with the pre-refactor sim.
const CURRICULUM_DECK: readonly RosterEntry[] = [
  { kind: "slime", weight: 5, tier: "signature" },
  { kind: "bat", weight: 3, tier: "signature" },
  { kind: "skeleton", weight: 2, tier: "signature" },
  { kind: "spitter", weight: 2, introTaper: 1, tier: "signature", complexWeighted: true },
  { kind: "ghost", weight: 2, tier: "signature", complexWeighted: true },
  { kind: "charger", weight: 2, tier: "signature" },
  { kind: "burrower", weight: 2, tier: "signature", complexWeighted: true },
  { kind: "orbiter", weight: 2, tier: "signature", complexWeighted: true },
  { kind: "shielder", weight: 2, tier: "signature" },
  { kind: "rootward", weight: 2, tier: "signature" },
  { kind: "caskbellows", weight: 2, tier: "signature", complexWeighted: true },
  { kind: "echojack", weight: 1.5, tier: "signature", complexWeighted: true },
  { kind: "seamcutter", weight: 2, tier: "signature" },
  { kind: "sinderling", weight: 2.5, tier: "signature" },
  { kind: "mason", weight: 1.5, tier: "signature", complexWeighted: true },
  { kind: "fragment", weight: 2, tier: "signature", complexWeighted: true },
];

const CURRICULUM: RegionRoster = { entries: CURRICULUM_DECK, spiceDraw: 0 };

// THE SUMP (31-50) — the first curated post-F30 deck. A tight signature core (the drain chaff, the
// Sump's tethered voice, the melt/heat + the ranged staple) with a small rotating spice draw of
// carried-over pressure. Deliberately NOT the whole bestiary: bat/charger/orbiter/echojack/
// rootward/mason are curated OUT of the Sump's ecology — that exclusion is the anti-repetition fix.
// TODO(content): fold in the 2-3 authored Sump corrupted variants as signatures next build.
const SUMP: RegionRoster = {
  entries: [
    { kind: "slime", weight: 5, tier: "signature" },
    { kind: "fragment", weight: 2.5, tier: "signature", complexWeighted: true },
    { kind: "sinderling", weight: 2, tier: "signature" },
    { kind: "spitter", weight: 2, tier: "signature", complexWeighted: true },
    { kind: "skeleton", weight: 2, tier: "spice" },
    { kind: "ghost", weight: 2, tier: "spice", complexWeighted: true },
    { kind: "burrower", weight: 2, tier: "spice", complexWeighted: true },
    { kind: "shielder", weight: 2, tier: "spice" },
    { kind: "caskbellows", weight: 2, tier: "spice", complexWeighted: true },
    { kind: "seamcutter", weight: 2, tier: "spice" },
  ],
  spiceDraw: 2,
};

// TODO(content): placeholder decks for the wave 2-4 regions — valid + distinct so a descent past
// F50 (deep boss rotation reaches F100) has a real roster, curated properly when their content
// lands. Not exercised by any deterministic test today.
const VEINWORKS: RegionRoster = {
  entries: [
    { kind: "slime", weight: 5, tier: "signature" },
    { kind: "fragment", weight: 2.5, tier: "signature", complexWeighted: true },
    { kind: "spitter", weight: 2, tier: "signature", complexWeighted: true },
    { kind: "seamcutter", weight: 2, tier: "signature" },
    { kind: "skeleton", weight: 2, tier: "spice" },
    { kind: "ghost", weight: 2, tier: "spice", complexWeighted: true },
    { kind: "burrower", weight: 2, tier: "spice", complexWeighted: true },
    { kind: "shielder", weight: 2, tier: "spice" },
    { kind: "caskbellows", weight: 2, tier: "spice", complexWeighted: true },
    { kind: "sinderling", weight: 2, tier: "spice" },
  ],
  spiceDraw: 2,
};

const PALE: RegionRoster = {
  entries: [
    { kind: "slime", weight: 5, tier: "signature" },
    { kind: "fragment", weight: 2.5, tier: "signature", complexWeighted: true },
    { kind: "ghost", weight: 2.5, tier: "signature", complexWeighted: true },
    { kind: "skeleton", weight: 2, tier: "signature" },
    { kind: "spitter", weight: 2, tier: "spice", complexWeighted: true },
    { kind: "burrower", weight: 2, tier: "spice", complexWeighted: true },
    { kind: "shielder", weight: 2, tier: "spice" },
    { kind: "caskbellows", weight: 2, tier: "spice", complexWeighted: true },
    { kind: "seamcutter", weight: 2, tier: "spice" },
  ],
  spiceDraw: 2,
};

const NULLCORE: RegionRoster = {
  entries: [
    { kind: "slime", weight: 5, tier: "signature" },
    { kind: "fragment", weight: 3, tier: "signature", complexWeighted: true },
    { kind: "ghost", weight: 2.5, tier: "signature", complexWeighted: true },
    { kind: "skeleton", weight: 2, tier: "spice" },
    { kind: "spitter", weight: 2, tier: "spice", complexWeighted: true },
    { kind: "shielder", weight: 2, tier: "spice" },
    { kind: "caskbellows", weight: 2, tier: "spice", complexWeighted: true },
  ],
  spiceDraw: 2,
};

// The per-region deck table — the single data source Gate 1 keys off. Every region resolves to a
// RegionRoster; the six pre-F30 regions share the cumulative curriculum.
export const REGION_ROSTERS: Readonly<Record<RegionId, RegionRoster>> = {
  amberwild: CURRICULUM,
  rootbound: CURRICULUM,
  sunless: CURRICULUM,
  deep: CURRICULUM,
  gilded: CURRICULUM,
  ember: CURRICULUM,
  sump: SUMP,
  veinworks: VEINWORKS,
  pale: PALE,
  nullcore: NULLCORE,
};

function isIntroduced(entry: RosterEntry, floor: number): boolean {
  return floor >= (FAMILY_INTRO_FLOOR[entry.kind] ?? Infinity);
}

function effectiveWeight(entry: RosterEntry, floor: number, complexShare: number): number {
  const introFloor = FAMILY_INTRO_FLOOR[entry.kind] ?? Infinity;
  const base = entry.introTaper !== undefined && floor === introFloor ? entry.introTaper : entry.weight;
  return base * (entry.complexWeighted ? complexShare : 1);
}

// The floor's drawn HAND, ready for the planner's weighted pick: every introduced signature kind,
// plus a seeded draw-without-replacement of the region's spice, in DECK ORDER (so weightedPick is
// deterministic). Pure for pre-F30 (spiceDraw 0 => no rng consumed => byte-identical to the old
// roster); post-F30 consumes the ENCOUNTER_DECK named stream (contract step 2), independent of the
// planner's own rng so it never perturbs spawn placement.
export function floorRoster(seed: number, floor: number, complexShare: number): Array<{ kind: EnemyKind; weight: number }> {
  const deck = REGION_ROSTERS[regionForFloor(floor).id];
  const introduced = deck.entries.filter((e) => isIntroduced(e, floor));

  // A stable set of deck indices chosen for this floor's hand (signatures always; spice by draw).
  const chosen = new Set<number>();
  const spiceIdx: number[] = [];
  for (let i = 0; i < introduced.length; i++) {
    if (introduced[i].tier === "signature") chosen.add(i);
    else spiceIdx.push(i);
  }
  const take = Math.min(deck.spiceDraw, spiceIdx.length);
  if (take > 0) {
    const rng = rollStream(seed, floor, RollStream.ENCOUNTER_DECK);
    // Partial Fisher-Yates: draw `take` distinct spice indices without replacement.
    for (let i = 0; i < take; i++) {
      const j = rng.int(i, spiceIdx.length - 1);
      [spiceIdx[i], spiceIdx[j]] = [spiceIdx[j], spiceIdx[i]];
      chosen.add(spiceIdx[i]);
    }
  }

  const hand: Array<{ kind: EnemyKind; weight: number }> = [];
  for (let i = 0; i < introduced.length; i++) {
    if (chosen.has(i)) hand.push({ kind: introduced[i].kind, weight: effectiveWeight(introduced[i], floor, complexShare) });
  }
  return hand;
}
