// The bestiary BALANCE ENVELOPE's identity layer: what each regular archetype IS —
// its role class (threat pricing + composition caps), its movement/attack MODULE (the
// per-band intro-cadence unit: max ENVELOPE.maxNewModulesPerBand truly-new modules per
// 5-floor band, remixes only after a teaching floor), and its ACCEPTANCE manifest
// (silhouette read, counter verb, commitment/punish timing, matchups). Pure data over
// EnemyKind so the whole envelope is testable headless (test/envelope.test.ts) and a
// new enemy cannot land without declaring its identity — an HP/speed/damage-only
// variant has nothing to declare and fails the acceptance gates by construction.

import type { EnemyKind, AttackMove } from "./types.js";

// Role classes (the envelope's threat-cost ladder): simple bodies price 1, ranged 1.5,
// complex verbs 2, controllers (support / decoys / space control) 2.25. Summon-only
// decoys carry a small real cost so summons always count against live pressure.
export type EnemyRole = "simple" | "ranged" | "complex" | "controller";

// Regular archetypes only — bosses, captains and summon-only decoys sit outside the
// roster capacity and never consult the roster envelope.
export const ENEMY_ROLE: Readonly<Partial<Record<EnemyKind, EnemyRole>>> = {
  slime: "simple",
  bat: "simple",
  skeleton: "simple",
  ghost: "simple",
  spitter: "ranged",
  orbiter: "ranged",
  caskbellows: "ranged",
  charger: "complex",
  burrower: "complex",
  shielder: "complex",
  rootward: "complex",
  seamcutter: "complex",
  sinderling: "complex",
  echojack: "controller",
  fragment: "controller",
};

export function roleOf(kind: EnemyKind): EnemyRole | null {
  return ENEMY_ROLE[kind] ?? null;
}

export function isRegularKind(kind: EnemyKind): boolean {
  return ENEMY_ROLE[kind] !== undefined;
}

export function isControllerKind(kind: EnemyKind): boolean {
  return ENEMY_ROLE[kind] === "controller";
}

// Biome specialists (the capacity envelope's third bucket): archetypes whose identity
// is coupled to a band's ecology — the sinderling feeds on Emberreach's vents, the
// fragment sings only in the Null after the Choir falls.
export const BIOME_SPECIALISTS: readonly EnemyKind[] = ["sinderling", "fragment"];

// The movement/attack MODULE each archetype teaches. A module is the intro-cadence unit
// (never the archetype): a kind that reuses an existing module is a REMIX and must land
// at least one floor after the module's teaching kind (REMIX_OF below).
export const ENEMY_MODULE: Readonly<Partial<Record<EnemyKind, string>>> = {
  slime: "chase_hop",
  bat: "flock",
  skeleton: "lunge",
  ghost: "phase_solidify",
  spitter: "kite_volley",
  charger: "line_rush",
  burrower: "burrow_ambush",
  orbiter: "orbit_stopshot",
  shielder: "guard",
  rootward: "guard", // remix: the slow-turning formation guard over the snap arc
  caskbellows: "sentry_volley",
  echojack: "decoy_blink",
  seamcutter: "seam_sweep",
  sinderling: "heat_jet",
  fragment: "tether_lane",
};

// Every remix names the kind that TAUGHT its module (the teaching-room-before-remix
// contract); the envelope test enforces the intro gap.
export const REMIX_OF: Readonly<Partial<Record<EnemyKind, EnemyKind>>> = {
  rootward: "shielder",
};

// ---- the acceptance manifest ----
// Every regular archetype ships with its acceptance review on record: the authored
// silhouette-read budget (≤300ms at gameplay zoom — reviewed against the art gate's
// contrast rules), its UNIQUE counter verb (unique per module — two kinds may share a
// module only by remixing the verb), its commitment/punish timing (nulls mark contact
// bodies with no committed attack), and its favorable/unfavorable matchup statement.
// Timing numbers mirror the constants the sim runs; the envelope test cross-checks the
// §4 guarantees (≥0.30s post-lock dodge, ≥0.35s punish) against them.
export interface EnemyAcceptance {
  silhouetteMs: number;      // authored read budget (accepted at ≤300)
  counterVerb: string;       // the ONE answer this body teaches
  commitmentS: number | null; // main committed windup (null = contact body, no commit)
  postLockS: number | null;   // guaranteed dodge window after the aim lock
  punishS: number | null;     // the recover/punish window after the commitment
  favoredIn: string;         // where this body wins
  weakTo: string;            // what beats it
}

export const ENEMY_ACCEPTANCE: Readonly<Partial<Record<EnemyKind, EnemyAcceptance>>> = {
  slime: {
    silhouetteMs: 180, counterVerb: "outpace the hop pulse",
    commitmentS: null, postLockS: null, punishS: null,
    favoredIn: "packs and tight rooms", weakTo: "any range, any kiting",
  },
  bat: {
    silhouetteMs: 200, counterVerb: "funnel the flock through a corridor",
    commitmentS: null, postLockS: null, punishS: null,
    favoredIn: "open air, wheeling as one body", weakTo: "doorways, splash, walls",
  },
  skeleton: {
    silhouetteMs: 200, counterVerb: "sidestep the locked lunge",
    commitmentS: 0.55, postLockS: 0.30, punishS: 0.5,
    favoredIn: "mid-range standoffs it can close", weakTo: "lateral movement, the recover",
  },
  ghost: {
    silhouetteMs: 220, counterVerb: "keep spacing — never let it solidify",
    commitmentS: null, postLockS: null, punishS: null,
    favoredIn: "cluttered rooms it drifts through", weakTo: "constant motion, open floors",
  },
  spitter: {
    silhouetteMs: 220, counterVerb: "close in or corner it",
    commitmentS: 0.7, postLockS: 0.30, punishS: 0.35,
    favoredIn: "long sightlines", weakTo: "pressure inside its flee band",
  },
  charger: {
    silhouetteMs: 220, counterVerb: "sidestep the lane, punish the crash",
    commitmentS: 0.75, postLockS: 0.35, punishS: 1.4,
    favoredIn: "long open lanes", weakTo: "sidesteps, its own wall crash",
  },
  burrower: {
    silhouetteMs: 240, counterVerb: "leave the eruption marker",
    commitmentS: 0.6, postLockS: 0.6, punishS: 0.82,
    favoredIn: "denying kite play", weakTo: "reading the marker, the surfaced recover",
  },
  orbiter: {
    silhouetteMs: 220, counterVerb: "hit it the moment it stops",
    commitmentS: 0.6, postLockS: 0.30, punishS: 0.5,
    favoredIn: "open rings around a stationary target", weakTo: "its stationary tell",
  },
  shielder: {
    silhouetteMs: 240, counterVerb: "flank the snap guard (melee/splash over it)",
    commitmentS: 0.6, postLockS: 0.30, punishS: 0.55,
    favoredIn: "head-on firefights", weakTo: "flanks, melee, mortar splash",
  },
  rootward: {
    silhouetteMs: 260, counterVerb: "out-turn the slow guard (pierce punches through)",
    // Its commitment is the guard's turn itself: a quarter-turn takes ~1.1s at the
    // capped rate — footwork always wins the angle race. No attack, no punish clock.
    commitmentS: null, postLockS: null, punishS: null,
    favoredIn: "corridors, anchoring formations", weakTo: "open flanks, pierce builds, melee",
  },
  caskbellows: {
    silhouetteMs: 240, counterVerb: "circle behind and crank-stagger it",
    commitmentS: 0.85, postLockS: 0.35, punishS: 1.5,
    favoredIn: "guarded lanes at range", weakTo: "the rear crank, closing the angle",
  },
  echojack: {
    silhouetteMs: 240, counterVerb: "ignore the noise — kill the jack",
    commitmentS: 0.7, postLockS: 0.7, punishS: 0.4,
    favoredIn: "chaotic fights it can misdirect", weakTo: "target discipline, corners",
  },
  seamcutter: {
    silhouetteMs: 240, counterVerb: "cross the seam early (or trail behind it)",
    commitmentS: 1.0, postLockS: 0.45, punishS: 0.9,
    favoredIn: "wide rooms it can bisect", weakTo: "early crossing, the far-wall recover",
  },
  sinderling: {
    silhouetteMs: 220, counterVerb: "kill it unarmed — or armed, from range",
    commitmentS: 0.6, postLockS: 0.30, punishS: 0.5,
    favoredIn: "vent fields and brazier rooms", weakTo: "denial of heat, ranged finishing",
  },
  fragment: {
    silhouetteMs: 240, counterVerb: "cut the tether: kill its source or break sight",
    // Non-aimed lane: the tether endpoints are visible for the whole windup.
    commitmentS: 0.9, postLockS: 0.9, punishS: 0.5,
    favoredIn: "mixed packs it can harmonize with", weakTo: "target priority, walls",
  },
};

// ---- the committed-move set (QA authority manifest) ----
// Every attack move each kind may COMMIT, over ALL kinds (compile-exhaustive: a new
// kind, or a new move on an old kind, does not build until declared here). This is the
// QA gates' authority record: telegraphs, aim-lock facing, projectile origins and the
// direction matrix are all validated against exactly this set. Contact bodies (slime,
// bat, rootward, the decoys) commit nothing — their pressure is the body itself; the
// ghost's solidify is a windup CHANNEL, not a move. Elite affixes add their own moves
// on top (brace on every brace-kind; the commander's rally rides "roar").
export const ENEMY_MOVESET: Readonly<Record<EnemyKind, readonly AttackMove[]>> = {
  slime: [],
  bat: [],
  skeleton: ["lunge"],
  ghost: [],
  spitter: ["spit"],
  charger: ["rush", "crash"],
  burrower: ["dive", "erupt"],
  orbiter: ["spit"],
  shielder: ["lunge"],
  rootward: [],
  echojack: ["decoy", "blink"],
  seamcutter: ["seam"],
  caskbellows: ["volley", "crash"],
  sinderling: ["stoke", "rush"],
  fragment: ["harmonize"],
  echo: [],
  knell: [],
  marshal: ["sweep", "volley"],
  toll: ["knell", "volley"],
  boss: ["hopslam", "radial", "roar", "squeeze"],
  marrow: ["rush", "crash", "volley", "spin", "shield"],
  choir: ["fade", "wail", "split"],
  weaver: ["pounce", "weave", "roar"],
  gilded: ["slam", "sweep", "roar"],
};

// ---- the directional-art contract (QA render manifest) ----
// Which sheet contract each kind's sprite ships under — the QA gates cross-check the
// asset registrations against this declaration, so a kind cannot silently miss its
// directional states:
//  - directional:      walk_{down,up,side} + attack_{down,up,side} (side mirrors left)
//  - directional_walk: walk triplet only (contact bodies with no attack strip)
//  - vertical_hold:    approved down/up sets only; horizontal movement holds the
//                      nearest vertical (the Gilded Warden's blocked-side contract)
//  - mass:             drifting/stationary mass — idle loop + omni attack, no triplet
//  - decoy:            idle loop only
//  - legacy:           single-strip walk (+ optional idle/death) — today's shipped art
// The 4-dir projection (down/up/side + mirror) is the DOCUMENTED direction matrix:
// 8-way velocity resolves through the deadzone + axis-hysteresis tracker in
// src/game/facing.ts; no kind ships 8-way sheets.
export type SpriteContract = "directional" | "directional_walk" | "vertical_hold" | "mass" | "decoy" | "legacy";

export const SPRITE_CONTRACT: Readonly<Record<EnemyKind, SpriteContract>> = {
  slime: "directional_walk",
  bat: "directional_walk",
  skeleton: "directional",
  ghost: "directional_walk",
  spitter: "directional",
  charger: "directional",
  burrower: "directional",
  orbiter: "directional",
  shielder: "directional",
  rootward: "directional_walk",
  echojack: "directional",
  seamcutter: "directional",
  caskbellows: "directional",
  sinderling: "directional",
  fragment: "mass",
  echo: "decoy",
  knell: "decoy",
  marshal: "directional",
  toll: "mass",
  boss: "legacy",
  marrow: "directional",
  choir: "mass",
  weaver: "directional",
  gilded: "vertical_hold",
};

// ---- band helpers (the 5-floor intro-cadence unit) ----

export function bandOfFloor(floor: number): number {
  return Math.floor((Math.max(1, floor) - 1) / 5);
}
