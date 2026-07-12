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
  mason: "complex",
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

// ---- the two-wave ecology gate ----
// Wave A: the common decks — predators, supports, and AT MOST ONE topology/material
// WORKER per biome (the bailiff walls Rootbound, the keel plows the Deep, the mason
// bricks Emberreach). Wave B: rare elites/lieutenants that SYNTHESIZE verbs Wave A
// taught, and NEVER enter common decks (summon-only bodies and the seeded miniboss
// cadence; the elite tier is a Wave-B layer over Wave-A chassis).
export type EnemyWave = "A" | "B" | "boss";

export const ENEMY_WAVE: Readonly<Record<EnemyKind, EnemyWave>> = {
  slime: "A", bat: "A", skeleton: "A", ghost: "A", spitter: "A", charger: "A",
  burrower: "A", orbiter: "A", shielder: "A",
  rootward: "A", echojack: "A", seamcutter: "A", caskbellows: "A", sinderling: "A",
  fragment: "A", mason: "A",
  echo: "B", knell: "B", knot: "B", sac: "B", marshal: "B", toll: "B",
  boss: "boss", marrow: "boss", choir: "boss", weaver: "boss", gilded: "boss",
  // Wave 1 deep bosses are boss-grade; their satellite/mechanic bodies are Wave-B summons
  // (never in a common deck), like the Weaver's knots/sacs.
  jet: "boss", tithe: "boss", quorum: "boss",
  tithe_slab: "B", quorum_shield: "B", quorum_heal: "B", quorum_dmg: "B",
  tithe_tribute: "B", quorum_splinter: "B", // surplus adds: Wave-B summons, never in a common deck
  jet_echo: "B", // JET's mirror echo: a Wave-B summon (never in a common deck)
  // GORGE (F50 giant) is boss-grade; its tectonic weak-point is a Wave-B mechanic body (a
  // summon, never in a common deck — like the Weaver's knot).
  gorge: "boss", gorge_seam: "B",
};

// Topology workers: bodies whose commitment EDITS the room (persistent destructible
// constructions). One per biome in the roster, one per room in the planner, one live
// construction per worker in the sim (the replacement rule).
export const WORKER_KINDS: readonly EnemyKind[] = ["rootward", "seamcutter", "mason"];

export function isWorkerKind(kind: EnemyKind): boolean {
  return WORKER_KINDS.indexOf(kind) !== -1;
}

// What each Wave-B body SYNTHESIZES (the ecology gate: learned verbs, never unrelated
// spectacle). Recorded as data so the gate is reviewable and testable.
export const WAVE_B_SYNTHESIS: Readonly<Partial<Record<EnemyKind, readonly EnemyKind[]>>> = {
  echo: ["echojack"],                  // the jack's own noise lesson, made a body
  knell: ["echojack"],                 // the decoy verb retuned to the Toll's bronze
  knot: ["caskbellows"],               // the planted shoot-this-body lesson, made a mechanic target
  sac: ["caskbellows"],                // the same stationary-objective verb, clutch-shaped
  marshal: ["rootward", "shielder"],   // formation guard + the worker's cover verb, weaponized
  toll: ["echojack", "caskbellows"],   // noise-lure misdirection + the locked-lane volley verb
  // Wave 1 boss mechanic bodies synthesize learned Wave-A verbs (like the Weaver's knot/sac):
  tithe_slab: ["shielder"],            // the built destructible-cover verb, made a feeding slab
  quorum_shield: ["shielder"],         // the guard verb, one husk of the shared body
  quorum_heal: ["rootward"],           // the formation-support/anchor verb, the healing husk
  quorum_dmg: ["skeleton"],            // the lunge/aggressor verb, the damage husk
  // Wave 1 surplus adds synthesize the earliest-taught chase verb (simple chasers):
  tithe_tribute: ["slime"],            // the chase verb, aimed at the slab it reinforces
  quorum_splinter: ["skeleton"],       // the aggressor-chaser verb, a role-echo shard
  jet_echo: ["spitter"],               // the ranged warn/lock/fire verb, turned into your own reflection
};

// Biome specialists (the capacity envelope's third bucket): archetypes whose identity
// is coupled to a band's ecology — the sinderling feeds on Emberreach's vents, the
// fragment sings only in the Null after the Choir falls.
export const BIOME_SPECIALISTS: readonly EnemyKind[] = ["sinderling", "fragment", "mason"];

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
  seamcutter: "seam_berm", // the SILT KEEL: the plow raises one persistent berm
  sinderling: "heat_jet",
  fragment: "tether_lane",
  mason: "vent_masonry",
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
    // The FORKROOT BAILIFF consolidation: the anchor's one commitment is now the divider
    // raise (a long stationary tell), and the divider's guaranteed end gaps are the
    // authored escape route. The guard's slow turn stays its defense.
    silhouetteMs: 260, counterVerb: "round the divider's open ends (pierce punches the guard)",
    commitmentS: 1.3, postLockS: null, punishS: 0.7,
    favoredIn: "corridors, anchoring formations behind its wall",
    weakTo: "open flanks, pierce builds, breaking the divider",
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
    // The SILT KEEL consolidation: the previewed plow now PILES a berm instead of
    // spraying sweep bolts — the zoning is the persistent ridge, not projectiles.
    silhouetteMs: 240, counterVerb: "cross the lane early; round or break the berm",
    commitmentS: 1.0, postLockS: 0.45, punishS: 0.9,
    favoredIn: "wide rooms it can bisect with silt", weakTo: "early crossing, the far-wall recover",
  },
  sinderling: {
    silhouetteMs: 220, counterVerb: "kill it unarmed — or armed, from range",
    commitmentS: 0.6, postLockS: 0.30, punishS: 0.5,
    favoredIn: "vent fields and brazier rooms", weakTo: "denial of heat, ranged finishing",
  },
  mason: {
    // Ecology synthesis: it bricks the vents the sinderlings feed at — the L-corner
    // denies your clean lane at the feeders while handing you cover to approach.
    silhouetteMs: 250, counterVerb: "take the open side of the L (or kill the mason mid-tell)",
    commitmentS: 1.4, postLockS: null, punishS: 0.8,
    favoredIn: "vent fields it can fortify", weakTo: "the long tell, splash through bricks",
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
  rootward: ["build"],
  echojack: ["decoy", "blink"],
  seamcutter: ["seam"],
  mason: ["build"],
  caskbellows: ["volley", "crash"],
  sinderling: ["stoke", "rush"],
  fragment: ["harmonize"],
  echo: [],
  knell: [],
  knot: [],
  sac: [],
  marshal: ["sweep", "volley"],
  toll: ["knell", "volley"],
  boss: ["hopslam", "radial", "roar", "squeeze"],
  marrow: ["rush", "crash", "volley", "spin", "shield"],
  choir: ["fade", "wail", "split"],
  // The earned-window kit reuses shared grammar: "blink" (the echojack's visible dash)
  // for the P1 thread traverse, "dive" (the burrower's out-of-play verb) for the P2
  // wall climb, "pounce" for the marked descent, "rush" for the P3 lane charge-dash,
  // and "crash" for every punishable self-stun (the snag, the forcedown, the overshoot).
  weaver: ["weave", "blink", "dive", "pounce", "rush", "crash", "roar"],
  gilded: ["slam", "sweep", "roar"],
  // Wave 1 deep bosses. JET's whole kit is the "mirror" salvo (its varied bullet patterns
  // ride one telegraph read) + the roar transition. The Tithe raises slabs ("build"), fires
  // amber rings ("radial") and bellows ("roar"). Quorum's core drives one shared "radial"
  // telegraph, transitions via "merge". Satellite bodies commit nothing.
  jet: ["mirror", "tracer", "rush", "beam", "roar"],
  tithe: ["build", "slam", "spew", "hurl", "radial", "rip", "roar"],
  quorum: ["radial", "beam", "sweep", "volley", "merge"],
  tithe_slab: [],
  quorum_shield: [],
  quorum_heal: [],
  quorum_dmg: [],
  tithe_tribute: [], // a crawler: its pressure is reaching the slab, not a telegraphed move
  quorum_splinter: [], // a chaser: no telegraphed move
  jet_echo: ["mirror"], // the reflection fires ONE mirrored-school salvo on its own tell
  // GORGE (F50 giant): the shell-peel giant reuses shared grammar — "slam" the P1 shockwave ring,
  // "spew" the P2 slag zones, "sweep" the P3 rotating spokes, "roar" the shell crack-off
  // transition. The tectonic weak-points expose in a PARALLEL loop (harmless peel targets, not a
  // telegraphed danger-move), so they add no move here; its weak-point body commits nothing.
  gorge: ["slam", "spew", "sweep", "roar"],
  gorge_seam: [],
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
  rootward: "directional", // the bailiff raise is its directional attack sheet
  echojack: "directional",
  seamcutter: "directional",
  caskbellows: "directional",
  sinderling: "directional",
  mason: "directional", // the masonry raise is its directional attack sheet
  fragment: "mass",
  echo: "decoy",
  knell: "decoy",
  knot: "decoy",
  sac: "decoy",
  marshal: "directional",
  toll: "mass",
  boss: "legacy",
  marrow: "directional",
  choir: "mass",
  weaver: "directional",
  gilded: "vertical_hold",
  // Wave 1. JET + the Tithe feeder + the Quorum husks ship a directional walk triplet (no
  // attack strip). The Tithe slab is a 2-state destructible (idle only, like a decoy body).
  // The Quorum merge-form core is a drifting mass (idle + omni attack, no triplet).
  jet: "directional_walk",
  tithe: "directional_walk",
  tithe_slab: "decoy",
  quorum: "mass",
  quorum_shield: "directional_walk",
  quorum_heal: "directional_walk",
  quorum_dmg: "directional_walk",
  // Surplus adds: small simple chasers ship a directional walk triplet (no attack strip),
  // like the other contact bodies (placeholder sprites reused; art director refines).
  tithe_tribute: "directional_walk",
  quorum_splinter: "directional_walk",
  jet_echo: "directional_walk", // reuses JET's hero-derived walk triplet (drawn cold + translucent)
  // GORGE (F50 giant): a single front-facing SHELL sprite per state (no orientations — a
  // stationary set-piece), the client swapping rind/chitin/core off boss.phase — the "mass"
  // (idle-only) contract. Its weak-point renders procedurally (a glowing crack-node), so it takes
  // the decoy (idle-loop) contract like the other mechanic bodies.
  gorge: "mass",
  gorge_seam: "decoy",
};

// ---- band helpers (the 5-floor intro-cadence unit) ----

export function bandOfFloor(floor: number): number {
  return Math.floor((Math.max(1, floor) - 1) / 5);
}
