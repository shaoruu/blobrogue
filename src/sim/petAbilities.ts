// Pet ability framework (PROTOCOL 45 pilot). A companion pet's FOLLOW body stays purely
// client-cosmetic (src/game/petFollow.ts) and out of the sim; its ABILITY, by contrast, is
// owner-bound AUTHORITATIVE state simulated on the server. This module owns the pure contract
// the sim's resolver keys off: the pet -> verb mapping, the Quill FINAL tuning numbers, and the
// small deny/allow predicates. No world mutation lives here (the resolver is in world.ts), so
// the whole ability shape is unit-testable on its own (see test/petability.test.ts).
//
// RAILS (locked): 1 pet/player, utility verbs, ZERO dps, CD >= 6s, server-authoritative,
// reconnect-safe. A pet ability can NEVER revive, vacuum hearts, hold objectives, or trigger a
// boss phase, and every verb is OFF while the owner is downed and OFF entirely in a PVP arena.

import type { PickupKind } from "./types.js";
import { TICKS_PER_SECOND } from "./kits.js";
import { DOGGIE_PET_ID, WICK_PET_ID } from "./camp_nodes.js";

// The two pilot verbs shipped in this PR. Each equipped ability-pet grants exactly ONE verb;
// every other (cosmetic-only or unknown) pet maps to null and grants no ability at all.
export type PetVerb = "fetch" | "pinprick";

// The equipped-pet -> verb table. Kept EXPLICIT (not derived) so a purely-cosmetic pet can never
// accidentally inherit a verb, and an unknown/future pet id resolves to null (no ability, never a
// crash) exactly like the client's cosmetic sprite table.
const PET_VERBS: Readonly<Record<string, PetVerb>> = {
  [DOGGIE_PET_ID]: "fetch",
  [WICK_PET_ID]: "pinprick",
};

// The verb an equipped pet id grants, or null for a cosmetic-only / unknown pet (no ability).
export function petVerbFor(petId: string | null): PetVerb | null {
  if (petId === null) return null;
  return PET_VERBS[petId] ?? null;
}

const secToTicks = (sec: number): number => Math.round(sec * TICKS_PER_SECOND);

// ---- Quill FINAL tuning (design HOLD lifted; ship) ----
// Windows the resolver reasons about in integer TICKS are pre-quantized here; felt effect
// durations stay in seconds (the sim's own effect timers decay in seconds, like the ult buffs).
export const PET_ABILITY = {
  // Shared active-bind cadence for both pilots (>= the 6s rail; Quill FINAL 8.0s).
  cooldownTicks: secToTicks(8.0),
  // The active tell: a 0.30s wind-up telegraph plays, THEN the verb fires (never instant).
  tellSec: 0.30,
  fetch: {
    // Doggie FETCH: a short pull PULSE that yanks loose non-heart loot toward the owner.
    radius: 140,
    pulseSec: 0.60,
    pullSpeed: 420, // px/s
    // Party throttle: at most ONE fetch pulse per PARTY per 2.0s. A throttled fetch is a no-op
    // (no pull opens) and gets NO cooldown refund (the caster still paid the 8s CD at tell start).
    partyThrottleTicks: secToTicks(2.0),
  },
  pinprick: {
    // Wick PINPRICK: a brief OWNER-ONLY light bump (never damage, never party-wide).
    lightRadiusBonus: 40,
    lightSec: 3.0,
    // Party soft-cap: at most 2 PINPRICK light windows may contribute at once; a 3rd activation
    // is a soft-capped no-op (no light), also with no CD refund.
    partyMaxWindows: 2,
  },
} as const;

// FETCH deny/allow: coins (loose resources) are pulled; HEARTS are NEVER pulled (no sustain
// vacuum — a locked rail), and weapons are excluded too (they are loot/objective pedestals a
// pull must never drag or contest). A closed predicate so a future pickup kind is deny-by-default.
export function isFetchablePickup(kind: PickupKind): boolean {
  return kind === "coin";
}
