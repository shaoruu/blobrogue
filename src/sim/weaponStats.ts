// The ONE place the "live" weapon-stat math lives: what a weapon actually does for THIS
// player right now, with their blessing mods (and the low-HP berserk/adrenaline scalers)
// applied and capped. world.ts resolves real shots through these same helpers, so the HUD
// (hotbar tooltips + the weapon drawer) can never drift from the authoritative fire math —
// there is no second copy of the balance constants to fall out of sync.
//
// Purity: sim-only imports (this module is part of the isomorphic core).

import { WEAPONS } from "./weapons.js";
import type { Weapon } from "./weapons.js";
import type { WeaponId } from "./types.js";
import type { PlayerMods } from "./items.js";
import { CAPS } from "./balance.js";

// 0 at full HP -> 1 at death's door; scales the berserk/adrenaline payoffs.
export function lowHpFrac(hp: number, maxHp: number): number {
  return maxHp > 0 ? 1 - Math.max(0, hp / maxHp) : 0;
}

// The raw caps (§6) bind the LIVE multipliers too: low-HP scalers are expressive risk
// payoffs but can never push raw damage/fire-rate past the cap.
export function liveDamageMult(mods: PlayerMods, lowHp: number): number {
  return Math.min(CAPS.damageMult, mods.damageMult + mods.berserk * lowHp);
}

export function liveFireRateMult(mods: PlayerMods, lowHp: number): number {
  return Math.max(0.25, Math.min(CAPS.fireRateMult, mods.fireRateMult + mods.adrenaline * lowHp));
}

// Player-facing live stats for one weapon card. Every number is what the player would
// actually get on the next trigger pull (mods applied, caps enforced):
//   damage  — per pellet / per swing
//   pellets — volley size (extra-pellet mods included; always 1 for melee)
//   rate    — attacks per second
//   range   — bullet travel px (speed × life, mods applied) or melee reach px
// `special` is the weapon's distinctive behavior line (null for a plain gun) — derived
// from the canonical Weapon fields, never hand-maintained copy.
export interface WeaponHudStats {
  isMelee: boolean;
  damage: number;
  pellets: number;
  rate: number;
  range: number;
  special: string | null;
}

function specialOf(w: Weapon): string | null {
  const parts: string[] = [];
  if (w.chain !== undefined) parts.push(`CHAINS TO ${w.chain} MORE`);
  if (w.bounce !== undefined) parts.push(w.bounce === 1 ? "RICOCHETS ONCE" : `RICOCHETS \u00d7${w.bounce}`);
  if (w.homing !== undefined) parts.push("HOMING ROUNDS");
  if (w.blast !== undefined) parts.push(`${w.blast}PX BLAST`);
  if (w.burn !== undefined) parts.push("SETS TARGETS ABLAZE");
  if (w.chill !== undefined) parts.push("CHILLS ON HIT");
  if (w.shock !== undefined) parts.push("SHOCKS ON HIT");
  if (w.basePierce !== undefined && w.basePierce > 0)
    parts.push(w.basePierce === 1 ? "PIERCES 1 BODY" : `PIERCES ${w.basePierce} BODIES`);
  if (w.melee?.isThrust) parts.push("PIERCING THRUST");
  else if (w.melee !== undefined && w.melee.arc >= 1.5) parts.push("WIDE SWEEP");
  return parts.length > 0 ? parts.join(" \u00b7 ") : null;
}

export function weaponHudStats(id: WeaponId, mods: PlayerMods, lowHp: number): WeaponHudStats {
  const w = WEAPONS[id];
  const isMelee = w.melee !== undefined;
  return {
    isMelee,
    damage: w.damage * liveDamageMult(mods, lowHp),
    pellets: isMelee ? 1 : w.pellets + mods.extraPellets,
    rate: (1 / w.fireCd) * liveFireRateMult(mods, lowHp),
    range: isMelee ? w.melee!.reach : w.speed * mods.bulletSpeedMult * w.life * mods.bulletLifeMult,
    special: specialOf(w),
  };
}
