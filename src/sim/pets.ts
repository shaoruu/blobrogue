// Companion pets: the account-progression roster (data + unlock rules + balance). This module
// is PURE and dependency-light on purpose — it is the single source of truth consumed by four
// layers: the sim (behavior numbers, world.ts updatePets), Convex (unlock evaluation +
// activePet validation in convex/players.ts), the game server (ticket pet-claim validation),
// and the client UI (picker labels + lock requirements). Keeping requirement EVALUATION here
// means the persistence layer can never drift from what the UI advertises.
//
// Power philosophy (mirrors balance.ts §0, hardened by the owner's ship decision after GD
// review): a pet is flavor + a modest utility lane, never a second weapon. One pet per player;
// no collision, no enemy aggro, no blocking, no loot interference; combat ≤10% of the owner's
// measured DPS and ≤25% of the party's combined; triggered utility on a ≥6s cadence. Every
// number below is bounded by PET_CAPS — the static suite (test/pets.test.ts) checks the
// authored table and the mandatory studio gate (test/petgate.test.ts) checks MEASURED play —
// so no tuning pass can quietly turn a companion into a turret. Pets consume NO sim RNG —
// their behavior is a pure function of world state — so adding one to a world can never perturb
// loot/spawn streams (the golden-master suite stays byte-identical with pets absent).
//
// Difficulty gates: there is no difficulty system in the runtime yet; when one lands, its pet
// scaling hooks belong HERE (a per-difficulty multiplier table next to PET_BALANCE), never
// scattered through world.ts.

import type { PetKind } from "./types.js";
import { BURN_DMG_STACK } from "./constants.js";

export const PET_KINDS: readonly PetKind[] = ["ember_pup", "lantern_wisp", "bonebird"];

export function isPetKind(v: unknown): v is PetKind {
  return v === "ember_pup" || v === "lantern_wisp" || v === "bonebird";
}

// The lifetime-stat milestones an unlock requirement is evaluated against. Both are already
// (or additively become) persisted profile stats, so evaluation is idempotent and re-runnable:
// the same stats always yield the same unlock set.
export interface PetUnlockStats {
  deepestFloor: number;    // deepest floor ever reached
  deepestBossKill: number; // deepest floor on which the player's party ever defeated a boss
}

// One unlock requirement: reach a floor, or defeat the boss of a floor. Exactly one field is
// set per pet (kept as a struct, not a union, so Convex/UI code stays plain).
export interface PetRequirement {
  deepestFloor?: number;
  deepestBossKill?: number;
  label: string; // the exact wording the picker shows on a locked slot
}

export interface PetDef {
  kind: PetKind;
  name: string;
  role: string;        // one-line picker description
  tint: string;        // accent color (procedural body, UI chip, FX)
  requirement: PetRequirement;
}

// Unlock graph, grounded in the LIVE roster: the Slime King guards every 5th floor
// (enemies.ts BOSS_EVERY), and biome bands run 3 floors each (biomes.ts — floor 8 sits in
// The Deep). Boss-kill milestones use deepestBossKill (killing the boss counts even if the
// run ends before the descend); the depth milestone uses deepestFloor.
export const PETS: Record<PetKind, PetDef> = {
  ember_pup: {
    kind: "ember_pup",
    name: "Ember Pup",
    role: "Close companion — periodic small nip that singes its target.",
    tint: "#ff8a3b",
    requirement: { deepestBossKill: 5, label: "Defeat the Slime King (floor 5)" },
  },
  lantern_wisp: {
    kind: "lantern_wisp",
    name: "Lantern Wisp",
    role: "Support light — reveals nearby loot and nudges coins to you.",
    tint: "#8fd8ff",
    requirement: { deepestFloor: 8, label: "Reach floor 8 — The Deep" },
  },
  bonebird: {
    kind: "bonebird",
    name: "Bonebird",
    role: "Ranged peck — its mark makes one foe take extra damage from players.",
    tint: "#e8e0cf",
    requirement: { deepestBossKill: 10, label: "Defeat the Slime King at floor 10" },
  },
};

export function isPetUnlocked(kind: PetKind, stats: PetUnlockStats): boolean {
  const req = PETS[kind].requirement;
  if (req.deepestFloor !== undefined && stats.deepestFloor < req.deepestFloor) return false;
  if (req.deepestBossKill !== undefined && stats.deepestBossKill < req.deepestBossKill) return false;
  return true;
}

// Every pet these stats have earned, in roster order. Pure + idempotent — the Convex fold
// unions this into the persisted set, so re-recording a run can never duplicate or revoke.
export function petUnlocksFor(stats: PetUnlockStats): PetKind[] {
  return PET_KINDS.filter((kind) => isPetUnlocked(kind, stats));
}

// ---- balance (authoritative sim numbers; engine motion constants included for cohesion) ----

export const PET_BALANCE = {
  radius: 10,          // body circle (movement clearance vs walls/props; pets block NOTHING)
  spring: 40,          // follow spring stiffness (accel per px of offset)
  damping: 11,         // velocity damping (slightly under critical — a lively, organic tail)
  maxSpeed: 380,       // px/s cap; outruns the player (200) and closes a dash gap (620) fast
  followBehind: 40,    // anchor offset behind the owner, px (clears the 40px hero sprite)
  followRaise: 14,     // anchor offset above the owner's center, px
  separation: 26,      // boids-style separation radius between pets, px
  // Peak separation acceleration. Must dominate the follow spring inside the overlap band
  // or pets sharing one anchor squash together; 1300 settles a same-anchor pair ~19px apart
  // (equilibrium of spring pull toward the shared anchor vs the linear-falloff push).
  separationPush: 1300,
  ownerClearance: 22,  // gentle push-out radius so a pet never sits inside its owner
  // Safe-teleport failsafe: beyond teleportDist the pet snaps immediately; between
  // stuckFarDist and that, stuckAfter seconds of no real progress trigger the same snap.
  teleportDist: 320,
  stuckFarDist: 120,
  stuckAfter: 1.2,
  stuckProgress: 0.35, // fraction of the intended step below which a tick counts as blocked
  attackAnimTime: 0.3, // seconds the wire `at` action-pose timer holds after an attack

  ember_pup: {
    engageRange: 180,  // leash: the pup only hunts enemies within this range of its OWNER
    nipReach: 6,       // px beyond touching radii the nip connects at
    nipCd: 3.2,
    nipDamage: 1,
    burnSecs: 1.0,     // short singe: 2 burn damage total at the base burn stack rate
  },
  lantern_wisp: {
    pullRadius: 120,   // coins within this range of the WISP get nudged toward its owner
    pullSpeed: 150,    // px/s — a modest assist, well under Coin Magnet Lv1's 240 px/s
    revealRadius: 140, // client-side loot-highlight radius around the wisp
  },
  bonebird: {
    range: 280,        // target acquisition range around the OWNER
    // The peck is the bird's triggered utility (it applies the mark), so its cadence obeys
    // the ≥6s utility-cooldown floor; with the 1.0s mark that is ≈17% worst-case
    // single-target uptime, well under the 25% cap.
    peckCd: 6,
    peckSpeed: 400,
    peckRadius: 5,
    peckDamage: 1,
    peckLife: 0.8,     // seconds of flight (~320 px) before the peck fizzles
    markSecs: 1.0,
    markDamageMult: 1.08, // marked enemies take +8% damage from PLAYER strikes (§5 ceiling)
  },
} as const;

// The exact bounded numbers a companion brings, derived STRAIGHT from PET_BALANCE so the
// UI can never drift from the sim (the UI Director gate: power is stated in numbers, never
// hidden in flavor copy). Two short lines per pet: what it does, and its exact cadence/reach.
export function petStats(kind: PetKind): [string, string] {
  if (kind === "ember_pup") {
    const P = PET_BALANCE.ember_pup;
    const burnTotal = P.burnSecs * BURN_DMG_STACK;
    return [
      `nip: ${P.nipDamage} dmg + ${burnTotal} burn over ${P.burnSecs}s`,
      `every ${P.nipCd}s \u00b7 hunts within ${P.engageRange}px of you`,
    ];
  }
  if (kind === "bonebird") {
    const P = PET_BALANCE.bonebird;
    return [
      `peck: ${P.peckDamage} dmg every ${P.peckCd}s \u00b7 ${P.range}px reach`,
      `mark: +${Math.round((P.markDamageMult - 1) * 100)}% player dmg for ${P.markSecs}s`,
    ];
  }
  const P = PET_BALANCE.lantern_wisp;
  return [
    `reveals loot within ${P.revealRadius}px of it`,
    `pulls coins ${P.pullSpeed}px/s inside ${P.pullRadius}px \u00b7 0 dmg`,
  ];
}

// Hard ceilings on pet contribution — the §5 table of
// docs/specs/blobrogue_STUDIO_BALANCE_GATE.md, tightened to the severe end of the owner's
// ship decision (≤10% owner DPS within the spec's ≤12% allowance; utility cadence ≥6s).
// Same pattern as balance.ts CAPS: tuning may move PET_BALANCE, never past these. The static
// suite (test/pets.test.ts) checks the authored numbers; the MANDATORY studio gate
// (test/petgate.test.ts) checks the same caps against MEASURED play across
// Casual/Standard/Brutal and party sizes 1–4.
export const PET_CAPS = {
  sustainedDps: 1.0,      // absolute ceiling on one pet's steady-state damage/second
  ownerDpsShare: 0.10,    // one pet's sustained DPS vs its owner's measured median weapon DPS
  ownerBurstShare: 0.18,  // pet damage in ANY 3s window vs the owner baseline over 3s
  partyDpsShare: 0.25,    // all party pets combined vs the party's measured player DPS
  killShare: 0.15,        // pet-finished kills vs the owner's total credited kills
  utilityCooldownMin: 6,  // triggered utility (the mark's peck) may never cycle faster
  markDamageMult: 1.08,   // the team-utility mark may never exceed +8% (§5 vulnerability cap)
  markUptime: 0.25,       // worst-case single-target mark uptime
  healingPerFloor: 0.25,  // expected HP/floor a pet may restore (ours restore exactly 0)
  healingPer90s: 1,       // absolute HP per rolling 90s (ours: 0 — Fang never procs off pets)
  coinPullSpeed: 240,     // wisp assist stays at-or-under Coin Magnet Lv1 pull
} as const;
