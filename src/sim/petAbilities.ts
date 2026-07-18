// Pet ability framework (PROTOCOL 46). A companion pet's FOLLOW body stays purely client-cosmetic
// (src/game/petFollow.ts) and out of the sim; its ABILITY, by contrast, is owner-bound
// AUTHORITATIVE state simulated on the server. This module owns the pure contract the sim's
// resolver keys off: the pet -> verb mapping, the Quill FINAL tuning numbers, and the small
// deny/allow predicates. No world mutation lives here (the resolver is in world.ts), so the whole
// ability shape is unit-testable on its own (see test/petability.test.ts).
//
// RAILS (locked): 1 pet/player, utility verbs, ZERO dps, CD >= 6s, server-authoritative,
// reconnect-safe. A pet ability can NEVER revive, vacuum hearts, hold objectives, or trigger a
// boss phase, and every verb is OFF while the owner is downed and OFF entirely in a PVP arena.

import type { PickupKind } from "./types.js";
import { TICKS_PER_SECOND } from "./kits.js";
import {
  DOGGIE_PET_ID, WICK_PET_ID, CAT_PET_ID, DRAGON_PET_ID, SLIME_PET_ID,
  PEBBLE_PET_ID, CLATTER_PET_ID, NULLFIN_PET_ID,
} from "./camp_nodes.js";

// One utility verb per equipped ability-pet (all 8 roster pets grant one). Every other
// (cosmetic-only or unknown) pet maps to null and grants no ability at all.
export type PetVerb =
  | "fetch"       // Doggie: pull loose loot
  | "pinprick"    // Wick: owner-only light bump
  | "stalk"       // Cat: info-only enemy mark
  | "emberpuff"   // Baby Dragon: shorten a floor hazard's remaining life
  | "slimetrail"  // Baby Slime: drop an enemy-slowing floor patch
  | "pebblebrace" // Pebble: a one-hit absorb shield on the owner
  | "rattle"      // Clatter: interrupt one trash wind-up
  | "nullwake";   // Nullfin: briefly null owner floor-hazard damage

// The equipped-pet -> verb table. Kept EXPLICIT (not derived) so a purely-cosmetic pet can never
// accidentally inherit a verb, and an unknown/future pet id resolves to null (no ability, never a
// crash) exactly like the client's cosmetic sprite table.
const PET_VERBS: Readonly<Record<string, PetVerb>> = {
  [DOGGIE_PET_ID]: "fetch",
  [WICK_PET_ID]: "pinprick",
  [CAT_PET_ID]: "stalk",
  [DRAGON_PET_ID]: "emberpuff",
  [SLIME_PET_ID]: "slimetrail",
  [PEBBLE_PET_ID]: "pebblebrace",
  [CLATTER_PET_ID]: "rattle",
  [NULLFIN_PET_ID]: "nullwake",
};

// The verb an equipped pet id grants, or null for a cosmetic-only / unknown pet (no ability).
export function petVerbFor(petId: string | null): PetVerb | null {
  if (petId === null) return null;
  return PET_VERBS[petId] ?? null;
}

const secToTicks = (sec: number): number => Math.round(sec * TICKS_PER_SECOND);

// ---- Quill FINAL tuning (design HOLD lifted; ship) ----
// Each verb owns its own auto-cast cooldown (all >= the 6s rail). Windows the resolver reasons
// about in integer TICKS are pre-quantized here; felt effect durations stay in seconds (the sim's
// own effect timers decay in seconds, like the ult buffs). The tell is one shared cadence.
export const PET_ABILITY = {
  // The active tell: a 0.30s wind-up telegraph plays, THEN the verb fires (never instant).
  tellSec: 0.30,
  fetch: {
    cooldownTicks: secToTicks(8.0),
    // Doggie FETCH: a short pull PULSE that yanks loose non-heart loot toward the owner.
    radius: 140,
    pulseSec: 0.60,
    pullSpeed: 420, // px/s
    // Party throttle: at most ONE fetch pulse per PARTY per 2.0s. A throttled fetch is a no-op
    // (no pull opens) and gets NO cooldown refund (the caster still paid the CD at tell start).
    partyThrottleTicks: secToTicks(2.0),
  },
  pinprick: {
    cooldownTicks: secToTicks(8.0),
    // Wick PINPRICK: a brief OWNER-ONLY light bump (never damage, never party-wide).
    lightRadiusBonus: 40,
    lightSec: 3.0,
    // Party soft-cap: at most 2 PINPRICK light windows may contribute at once; a 3rd activation
    // is a soft-capped no-op (no light), also with no CD refund.
    partyMaxWindows: 2,
  },
  stalk: {
    cooldownTicks: secToTicks(7.0),
    // Cat STALK: an INFO pip on one enemy (elite, or anyone mid-tell). Never damage/stun/phase.
    // The CD (7.0s) exceeds the mark duration (2.5s), so "max 1 mark / owner" holds for free.
    radius: 220,
    markSec: 2.5,
  },
  emberpuff: {
    cooldownTicks: secToTicks(10.0),
    // Baby Dragon EMBERPUFF: scales a floor hazard's REMAINING life (never a boss tell / pave /
    // convoy / objective light). 0 damage — it only shortens fire underfoot.
    radius: 70,
    hazardLifeMul: 0.55,
  },
  slimetrail: {
    cooldownTicks: secToTicks(8.0),
    // Baby Slime SLIMETRAIL: a floor patch that slows ENEMIES only (allies never). Bosses immune;
    // elites take half the slow. The whole PARTY shares a hard cap of 2 live patches per room.
    patchRadius: 48,
    patchLifeSec: 2.5,
    enemySlowMul: 0.75,
    eliteSlowMul: 0.875,
    partyPatchCap: 2,
  },
  pebblebrace: {
    cooldownTicks: secToTicks(12.0),
    // Pebble PEBBLEBRACE: absorbs ONE incoming hit of at most 2 damage, then is spent. No
    // self-stack (a recast replaces the window); clears when the owner is downed. Not a
    // lethal-save (it can never stop more than 2), orthogonal to Remember Me.
    absorbMax: 2,
    shieldSec: 2.5,
  },
  rattle: {
    cooldownTicks: secToTicks(10.0),
    // Clatter RATTLE: cancels ONE trash wind-up into recover. Elites/bosses/mechanic sockets are
    // immune. No valid target -> fail-soft, no CD (checked at cast).
    radius: 120,
  },
  nullwake: {
    cooldownTicks: secToTicks(12.0),
    // Nullfin NULLWAKE: a brief OWNER-only window that nulls floor-hazard damage (never projectile
    // i-frames). Fail-closed: it only voids generic floor damage, never an objective's required
    // hazard presence.
    nullSec: 0.45,
  },
} as const;

// The auto-cast cooldown (ticks) a verb burns on a successful cast.
export function petCooldownTicks(verb: PetVerb): number {
  return PET_ABILITY[verb].cooldownTicks;
}

// ---- AUTO-CAST (smart AI) tuning ----
// Pets fire their OWN verb — no player bind. Each verb's "should I cast now?" read is a
// deterministic function of the current world (evaluated in world.ts, which owns the geometry);
// the two numbers those reads need that no effect window already defines live here so the tuning
// stays in one file. A read with no useful context returns false and the CD is never burned (the
// same fail-soft rail the retired manual bind had).
export const PET_AUTOCAST = {
  // PEBBLEBRACE braces when the owner is hurt: any HP missing, or a hit landed within this window.
  // A pure tick comparison (deterministic, no wall-clock) keeps the AI reconnect-safe.
  recentDamageTicks: secToTicks(2.0),
  // SLIMETRAIL drops a slow patch when at least one NON-boss enemy stands within this reach of the
  // owner — close enough that the patch under the owner will actually be crossed.
  slimeEnemyRadius: 100,
} as const;

// The SLIMETRAIL enemy-slow decision (the tuning lives here; the sim supplies the geometry of
// which bodies stand on a patch): a BOSS is immune (1.0×), an ELITE takes half the slow, and every
// other body takes the full slow. Allies never reach this — the sim only calls it for enemies.
export function slimeSlowMul(isBoss: boolean, isElite: boolean): number {
  if (isBoss) return 1;
  return isElite ? PET_ABILITY.slimetrail.eliteSlowMul : PET_ABILITY.slimetrail.enemySlowMul;
}

// STALK and RATTLE need a live target: auto-casting with nothing in reach is a fail-soft
// no-op that burns NO cooldown (checked at cast). Every other verb always commits its CD.
export function petVerbNeedsTarget(verb: PetVerb): boolean {
  return verb === "stalk" || verb === "rattle";
}

// FETCH deny/allow: coins (loose resources) are pulled; HEARTS are NEVER pulled (no sustain
// vacuum — a locked rail), and weapons are excluded too (they are loot/objective pedestals a
// pull must never drag or contest). A closed predicate so a future pickup kind is deny-by-default.
export function isFetchablePickup(kind: PickupKind): boolean {
  return kind === "coin";
}
