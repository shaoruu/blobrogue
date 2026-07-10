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
import {
  CAPS, POWER, BOSS_VULN_CAP, BOSS_NATIVE_PELLET_COEF, BOSS_EXTRA_PELLET_COEF,
  WEAPON_BOSS_COEF,
} from "./balance.js";
import { MIN_MULTI_SPREAD, FIRE_KNOCKBACK } from "./constants.js";

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

// ---- the ONE weapon display-stats model (game-designer tooltip vocabulary) ----
//
// WeaponDisplayStats is the single effective-stats source BOTH the hotbar tooltip and the
// tap-to-inspect drawer render from (so blessing/modifier values can never drift between
// surfaces). It leads with the weapon's room job (a verb, derived from canonical
// WeaponDef fields by rules — never hand-written per weapon), then at most five core rows
// (POWER exact, CADENCE / REACH / COVERAGE-or-SWEEP / IMPACT as categorical bands), then
// concise technique/tradeoff lines for real mechanics only. Everything derives from
// WEAPONS + the balance/constants tables + the player's live mods, so upgrades read
// honestly and no displayed value can drift from the sim.

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

// Behavior-first coverage category (the accepted vocabulary): what the shot DOES to space.
// THRUST/SWEEP are melee geometry; AREA/CHAIN/TRACKING/RICOCHET are behavior fields; the
// spread-pattern family FOCUSED < BURST < WIDE carries `patternOrder` so those three may
// compare as tighter/wider (behavior categories never rank against each other).
export type CoverageKind =
  | "THRUST" | "SWEEP" | "AREA" | "CHAIN" | "TRACKING" | "RICOCHET"
  | "WIDE" | "BURST" | "FOCUSED";

export interface WeaponCoverage {
  kind: CoverageKind;
  patternOrder: number | null; // 0 FOCUSED / 1 BURST / 2 WIDE; null for behavior kinds
}

export interface WeaponDisplayStats {
  isMelee: boolean;
  role: string;                    // the room-job verb line
  power: { perHit: number; count: number }; // exact, per-pellet/swing × count — never a guaranteed sum
  impact: BandedStat;              // weight class of one hit (effective per-pellet/swing damage)
  cadence: BandedStat;
  reach: BandedStat;               // banded from internal px — the px number is never displayed
  coverage: WeaponCoverage;
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

// The accepted shared band tables (UI designer sign-off). All thresholds are on LIVE
// effective numbers, so mods can move a weapon between bands honestly.

// Weight class of a single hit: effective per-pellet / per-swing damage.
function impactBand(perHit: number): BandedStat {
  if (perHit < 1) return { band: "LIGHT", order: 0, num: perHit };
  if (perHit < 2.5) return { band: "SOLID", order: 1, num: perHit };
  if (perHit < 6) return { band: "HEAVY", order: 2, num: perHit };
  return { band: "CRUSHING", order: 3, num: perHit };
}

function cadenceBand(rate: number): BandedStat {
  if (rate < 1.8) return { band: "SLOW", order: 0, num: rate };
  if (rate < 5) return { band: "STEADY", order: 1, num: rate };
  if (rate < 10) return { band: "FAST", order: 2, num: rate };
  return { band: "RAPID", order: 3, num: rate };
}

// One reach scale for everything (internal px — melee reach and bullet travel are both
// "how far a hit lands"); the px number itself is NEVER displayed.
function reachBand(px: number): BandedStat {
  if (px < 180) return { band: "CLOSE", order: 0, num: px };
  if (px < 520) return { band: "MID", order: 1, num: px };
  if (px < 950) return { band: "LONG", order: 2, num: px };
  return { band: "EXTREME", order: 3, num: px };
}

// Behavior-first coverage: melee geometry, then the defining behavior field, then the
// live shot pattern (a modded multi-pellet volley moves FOCUSED -> BURST/WIDE honestly).
function coverageOf(w: Weapon, pellets: number, spread: number): WeaponCoverage {
  if (w.melee) return { kind: w.melee.isThrust ? "THRUST" : "SWEEP", patternOrder: null };
  if (w.blast !== undefined) return { kind: "AREA", patternOrder: null };
  if (w.chain !== undefined) return { kind: "CHAIN", patternOrder: null };
  if (w.homing !== undefined) return { kind: "TRACKING", patternOrder: null };
  if (w.bounce !== undefined) return { kind: "RICOCHET", patternOrder: null };
  if (pellets > 1) {
    return spread >= 0.45 ? { kind: "WIDE", patternOrder: 2 } : { kind: "BURST", patternOrder: 1 };
  }
  return { kind: "FOCUSED", patternOrder: 0 };
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

// ---- the R framework's per-player measurement (party+gear-aware boss scaling) ----
// One player's EXPECTED boss-facing DPS from their loadout alone: weapon base output
// through the SAME boss-facing coefficients real shots resolve with (pellet coefs,
// per-family boss coefs, the capped crit channel — statuses amplify nothing against
// boss-grade bodies; burn counts its flat bounded DoT), times the balancer's 0.72
// practical factor (the 12s-moving-target model behind the DPS ceilings). Pure and
// deterministic over (weapon, mods): the pull's R sample derives from exactly this.
export function expectedBossDps(id: WeaponId, mods: PlayerMods): number {
  const w = WEAPONS[id];
  const isMelee = w.melee !== undefined;
  const pellets = isMelee ? 1 : w.pellets + mods.extraPellets;
  const extra = Math.max(0, pellets - w.pellets);
  const effPellets = isMelee
    ? 1
    : 1 + Math.max(0, w.pellets - 1) * BOSS_NATIVE_PELLET_COEF + extra * BOSS_EXTRA_PELLET_COEF;
  const wepCoef = WEAPON_BOSS_COEF[id] ?? 1;
  const vuln = (1 - mods.critChance) + mods.critChance * Math.min(BOSS_VULN_CAP, mods.critMult);
  const rate = (1 / w.fireCd) * mods.fireRateMult;
  const burnDot = mods.burnChance > 0 ? 3 : 0;
  return w.damage * mods.damageMult * effPellets * wepCoef * rate * vuln * POWER.practicalFactor + burnDot;
}

export function weaponDisplayStats(id: WeaponId, mods: PlayerMods, lowHp: number): WeaponDisplayStats {
  const w = WEAPONS[id];
  const isMelee = w.melee !== undefined;
  const rate = (1 / w.fireCd) * liveFireRateMult(mods, lowHp);
  const pellets = isMelee ? 1 : w.pellets + mods.extraPellets;
  const spread = !isMelee && pellets > 1 ? Math.max(w.spread, MIN_MULTI_SPREAD) + mods.spreadAdd : w.spread;
  const perHit = w.damage * liveDamageMult(mods, lowHp);
  return {
    isMelee,
    role: roleOf(w),
    power: { perHit, count: pellets },
    impact: impactBand(perHit),
    cadence: cadenceBand(rate),
    reach: reachBand(isMelee ? w.melee!.reach : w.speed * mods.bulletSpeedMult * w.life * mods.bulletLifeMult),
    coverage: coverageOf(w, pellets, spread),
    mechanics: mechanicsOf(w, mods),
  };
}
