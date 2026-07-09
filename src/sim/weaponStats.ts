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
import { MIN_MULTI_SPREAD, WEAPON_KB, FIRE_KNOCKBACK } from "./constants.js";

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

// ---- the weapon CARD model (game-designer tooltip vocabulary) ----
//
// The hotbar tooltip leads with the weapon's room job (a verb, derived from canonical
// WeaponDef fields by rules — never hand-written per weapon), then at most five core rows
// (POWER exact, CADENCE / REACH / COVERAGE-or-SWEEP / IMPACT as categorical bands), then
// concise technique/tradeoff lines for real mechanics only. Everything derives from
// WEAPONS + the balance/constants tables + the player's live mods, so upgrades read
// honestly and no tooltip value can drift from the sim.

// A banded categorical stat: `band` is the player-facing word, `order` ranks bands for
// sidegrade arrows (higher = more of the quality), `num` is the underlying live number
// (kept for tests/aria, never shown as fake precision).
export interface BandedStat {
  band: string;
  order: number;
  num: number;
}

// One real mechanic (technique or tradeoff). `tag` identifies the mechanic across weapons
// for GAINS/LOSES/CHANGES diffs; `mag` disambiguates same-tag magnitude changes.
export interface WeaponMechanic {
  tag: string;
  text: string;
  mag: number;
}

export interface WeaponCard {
  isMelee: boolean;
  role: string;                    // the room-job verb line
  power: { perHit: number; count: number }; // exact, per-pellet × volley — never aggregate DPS
  cadence: BandedStat;
  reach: BandedStat;               // melee reach bands are a separate class from bullet travel
  coverage: BandedStat | null;     // ranged shot pattern; null = tight single shot (default, omitted)
  sweep: BandedStat | null;        // melee arc; null for thrusts (the mechanic line carries it)
  impact: BandedStat | null;       // blast / notable per-hit knockback; null = ordinary (omitted)
  mechanics: WeaponMechanic[];
}

// The room job, by rule priority over canonical behavior fields. Melee splits on its
// geometry; ranged splits on the one field that defines how the weapon solves a room.
function roleOf(w: Weapon): string {
  if (w.melee) {
    if (w.melee.isThrust) return "HOLD A LANE";
    return w.melee.arc >= 1.5 ? "CLEAR YOUR FLANKS" : "DUEL UP CLOSE";
  }
  if (w.homing !== undefined) return "SEEK TARGETS";
  if (w.chain !== undefined) return "ARC THE PACK";
  if (w.blast !== undefined) return "BLAST THE CHOKEPOINT";
  if (w.burn !== undefined) return "TORCH THE PACK";
  if ((w.basePierce ?? 0) >= 2) return "BREAK A LINE";
  if (w.bounce !== undefined) return "WORK THE CORNERS";
  if (w.pellets >= 5) return "SHRED UP CLOSE";
  if (w.damage >= 9) return "DELETE A TARGET";
  const rate = 1 / w.fireCd;
  if (rate >= 18) return "MELT ONE TARGET";
  if (rate >= 8) return "HOSE THEM DOWN";
  return "HANDLE ANYTHING";
}

function cadenceBand(rate: number): BandedStat {
  if (rate >= 12) return { band: "TORRENT", order: 5, num: rate };
  if (rate >= 8) return { band: "VERY FAST", order: 4, num: rate };
  if (rate >= 4) return { band: "FAST", order: 3, num: rate };
  if (rate >= 2) return { band: "STEADY", order: 2, num: rate };
  if (rate >= 1.2) return { band: "SLOW", order: 1, num: rate };
  return { band: "HEAVY", order: 0, num: rate };
}

function rangedReachBand(px: number): BandedStat {
  if (px < 140) return { band: "POINT BLANK", order: 0, num: px };
  if (px < 320) return { band: "SHORT", order: 1, num: px };
  if (px < 620) return { band: "MID", order: 2, num: px };
  if (px < 1000) return { band: "LONG", order: 3, num: px };
  return { band: "VERY LONG", order: 4, num: px };
}

function meleeReachBand(px: number): BandedStat {
  if (px < 55) return { band: "ARM'S LENGTH", order: 0, num: px };
  if (px < 70) return { band: "EXTENDED", order: 1, num: px };
  return { band: "POLE LENGTH", order: 2, num: px };
}

// Shot-pattern coverage: only exists once the volley actually spreads (multi-pellet or a
// real cone). The live spread mirrors resolveShot: a multi-pellet volley widens to the
// MIN_MULTI_SPREAD floor plus any spread mods.
function coverageBand(spread: number, pellets: number): BandedStat | null {
  if (pellets <= 1 && spread < 0.15) return null;
  if (spread >= 0.7) return { band: "WALL", order: 3, num: spread };
  if (spread >= 0.45) return { band: "WIDE FAN", order: 2, num: spread };
  if (spread >= 0.15) return { band: "NARROW FAN", order: 1, num: spread };
  return { band: "TIGHT CLUSTER", order: 0, num: spread };
}

function sweepBand(w: Weapon): BandedStat | null {
  if (!w.melee || w.melee.isThrust) return null;
  return w.melee.arc >= 1.5
    ? { band: "WIDE SWEEP", order: 1, num: w.melee.arc }
    : { band: "FORWARD ARC", order: 0, num: w.melee.arc };
}

// Notable hit feel only: a blast zone, or a per-hit knockback (canonical WEAPON_KB) big
// enough to move the fight. Ordinary impulse is the default and stays off the card.
function impactBand(w: Weapon): BandedStat | null {
  if (w.blast !== undefined) return { band: "AREA BLAST", order: 3, num: w.blast };
  const kb = WEAPON_KB[w.id];
  if (kb >= 16) return { band: "LAUNCHES FOES", order: 2, num: kb };
  if (kb >= 12) return { band: "STAGGERS FOES", order: 1, num: kb };
  if (kb >= 8) return { band: "SHOVES FOES", order: 0, num: kb };
  return null;
}

// Technique/tradeoff mechanics, in priority order. Live pierce includes the player's
// pierce mods on ranged weapons (exactly like resolveShot, same cap).
function mechanicsOf(w: Weapon, mods: PlayerMods): WeaponMechanic[] {
  const m: WeaponMechanic[] = [];
  if (!w.melee) {
    const pierce = Math.min(4, (w.basePierce ?? 0) + mods.pierce);
    if (pierce > 0) m.push({ tag: "PIERCE", text: pierce === 1 ? "PIERCES 1 BODY" : `PIERCES ${pierce} BODIES`, mag: pierce });
  }
  if (w.melee?.isThrust) m.push({ tag: "THRUST", text: "PIERCING THRUST", mag: 1 });
  if (w.chain !== undefined) m.push({ tag: "CHAIN", text: `CHAINS TO ${w.chain} MORE`, mag: w.chain });
  if (w.bounce !== undefined) m.push({ tag: "RICOCHET", text: w.bounce === 1 ? "RICOCHETS ONCE" : `RICOCHETS \u00d7${w.bounce}`, mag: w.bounce });
  if (w.homing !== undefined) m.push({ tag: "SEEKING", text: "SEEKING ROUNDS", mag: 1 });
  if (w.blast !== undefined) m.push({ tag: "BLAST", text: `${w.blast}PX BLAST`, mag: w.blast });
  if (w.burn !== undefined) m.push({ tag: "BURN", text: "SETS TARGETS ABLAZE", mag: 1 });
  if (w.chill !== undefined) m.push({ tag: "CHILL", text: "CHILLS ON HIT", mag: 1 });
  if (w.shock !== undefined) m.push({ tag: "SHOCK", text: "SHOCKS ON HIT", mag: 1 });
  const kick = FIRE_KNOCKBACK[w.id];
  if (kick >= 12) m.push({ tag: "KICK", text: "KICKS YOU BACK", mag: kick });
  return m;
}

export function weaponCard(id: WeaponId, mods: PlayerMods, lowHp: number): WeaponCard {
  const w = WEAPONS[id];
  const isMelee = w.melee !== undefined;
  const rate = (1 / w.fireCd) * liveFireRateMult(mods, lowHp);
  const pellets = isMelee ? 1 : w.pellets + mods.extraPellets;
  const spread = !isMelee && pellets > 1 ? Math.max(w.spread, MIN_MULTI_SPREAD) + mods.spreadAdd : w.spread;
  return {
    isMelee,
    role: roleOf(w),
    power: { perHit: w.damage * liveDamageMult(mods, lowHp), count: pellets },
    cadence: cadenceBand(rate),
    reach: isMelee
      ? meleeReachBand(w.melee!.reach)
      : rangedReachBand(w.speed * mods.bulletSpeedMult * w.life * mods.bulletLifeMult),
    coverage: isMelee ? null : coverageBand(spread, pellets),
    sweep: sweepBand(w),
    impact: impactBand(w),
    mechanics: mechanicsOf(w, mods),
  };
}
