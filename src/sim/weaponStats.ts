// The ONE place the "live" weapon-stat math lives: what a weapon actually does for THIS
// player right now, with their blessing mods (and the low-HP berserk/adrenaline scalers)
// applied and capped. world.ts resolves real shots through these same helpers, so the HUD
// (hotbar tooltips + the weapon drawer) can never drift from the authoritative fire math —
// there is no second copy of the balance constants to fall out of sync.
//
// Purity: sim-only imports (this module is part of the isomorphic core).

import { WEAPONS, MAX_ORBIT_BLADES } from "./weapons.js";
import type { Weapon } from "./weapons.js";
import type { WeaponId, WeaponRarity } from "./types.js";
import type { PlayerMods } from "./items.js";
import {
  CAPS, POWER, BOSS_VULN_CAP, BOSS_NATIVE_PELLET_COEF, BOSS_EXTRA_PELLET_COEF,
  WEAPON_BOSS_COEF,
} from "./balance.js";
import { MIN_MULTI_SPREAD, FIRE_KNOCKBACK } from "./constants.js";
import { MOMENTUM, OVERHEAT } from "./kits.js";

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

// The GUNNER's Momentum/Overheat signature (Wave 2) is a FASTER ROUTE to the raw caps, never a
// higher ceiling: the live damage/fire multiplier is the capped build value routed UP by the
// stacks (+ the Overheat burst), then RE-CLAMPED to the same raw cap. Shared by world.ts's real
// fire math and the balancer's ship-gate scan, so the "never above the cap" guarantee has one
// source of truth. (The ult's Overdrive keeps its OWN separate expressive ceiling on top.)
export function gunnerDamageMult(baseCapped: number, momentumStacks: number): number {
  if (momentumStacks <= 0) return baseCapped;
  return Math.min(CAPS.damageMult, baseCapped * (1 + momentumStacks * MOMENTUM.damagePerStack));
}

export function gunnerFireRateMult(baseCapped: number, momentumStacks: number, isOverheat: boolean): number {
  let extra = momentumStacks > 0 ? momentumStacks * MOMENTUM.fireRatePerStack : 0;
  if (isOverheat) extra += OVERHEAT.extraFireRate;
  if (extra <= 0) return baseCapped;
  return Math.min(CAPS.fireRateMult, baseCapped * (1 + extra));
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
  | "WIDE" | "BURST" | "FOCUSED"
  // Effect-wave coverage kinds: what the placed/worn/charged output does to space.
  | "ARTILLERY" | "TRAP" | "ORBIT" | "TURRET" | "TETHER" | "GROUND"
  | "GRAPPLE" | "MODESHIFT" | "GAMBLE" | "PAVE"
  | "TUNE" | "REWRITE" | "COPY" | "FLANK"
  | "STANCE" | "PARRY" | "RELIGHT" | "LINK";

export interface WeaponCoverage {
  kind: CoverageKind;
  patternOrder: number | null; // 0 FOCUSED / 1 BURST / 2 WIDE; null for behavior kinds
}

export interface WeaponDisplayStats {
  isMelee: boolean;
  rarity: WeaponRarity;            // drop-quality tier (the tooltip's rarity badge)
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
  // The effect wave's room verbs (each weapon's authored one-line job).
  if (w.charge !== undefined) return "ERASE AN ANCHOR";
  if (w.wire !== undefined) return "HOLD A DOORWAY";
  if (w.orbit !== undefined) return "OWN YOUR SPACE";
  if (w.sentry !== undefined) return "HOLD A SECOND LANE";
  if (w.tether !== undefined) return "REPOSITION THE THREAT";
  if (w.grapple !== undefined) return "ANCHOR AND GRAPPLE";
  if (w.modeShift !== undefined) return "SHIFT THE ROOM";
  if (w.gamble !== undefined) return "GAMBLE THE PAYLOAD";
  if (w.resonate !== undefined) return "TUNE THE RESONANCE";
  if (w.rewrite !== undefined) return "MARK AND REWRITE";
  if (w.margin !== undefined) return "STORE AND ECHO";
  if (w.sidewinder !== undefined) return "FLANK THE TARGET";
  if (w.stance !== undefined) return "ROOT AND RAMP";
  if (w.parry !== undefined) return "PARRY AND RETURN";
  if (w.relight !== undefined) return "RELIGHT THE ROOM";
  if (w.faultlink !== undefined) return "LINK AND SHARE";
  if (w.paint?.isPaving === true) return "CLEANSE AND PAVE";
  if (w.paint !== undefined) return "CUT THE ROOM IN TWO";
  if (w.lowHpBonus !== undefined) return "TRADE SAFETY FOR THE KILL";
  // The legendary wave's signature mechanics outrank the shared fields: the gimmick IS
  // the job (the Hive reads by its accel+homing pair, above the plain seeker verb).
  if (w.killShards !== undefined) return "REAP THE PACK";
  if (w.coinBoost !== undefined) return "SPEND COINS FOR POWER";
  if (w.isPhase === true) return "SHOOT THROUGH WALLS";
  if (w.nova !== undefined) return "COLLAPSE AND DETONATE";
  if (w.implode !== undefined) return "DRAG THEM TOGETHER";
  if (w.accel !== undefined && w.homing !== undefined) return "UNLEASH THE SWARM";
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
  // Effect-wave families read by their authoring behavior, not their pellet pattern.
  if (w.charge !== undefined) return { kind: "ARTILLERY", patternOrder: null };
  if (w.wire !== undefined) return { kind: "TRAP", patternOrder: null };
  if (w.orbit !== undefined) return { kind: "ORBIT", patternOrder: null };
  if (w.sentry !== undefined) return { kind: "TURRET", patternOrder: null };
  if (w.tether !== undefined) return { kind: "TETHER", patternOrder: null };
  if (w.grapple !== undefined) return { kind: "GRAPPLE", patternOrder: null };
  if (w.modeShift !== undefined) return { kind: "MODESHIFT", patternOrder: null };
  if (w.gamble !== undefined) return { kind: "GAMBLE", patternOrder: null };
  if (w.resonate !== undefined) return { kind: "TUNE", patternOrder: null };
  if (w.rewrite !== undefined) return { kind: "REWRITE", patternOrder: null };
  if (w.margin !== undefined) return { kind: "COPY", patternOrder: null };
  if (w.sidewinder !== undefined) return { kind: "FLANK", patternOrder: null };
  if (w.stance !== undefined) return { kind: "STANCE", patternOrder: null };
  if (w.parry !== undefined) return { kind: "PARRY", patternOrder: null };
  if (w.relight !== undefined) return { kind: "RELIGHT", patternOrder: null };
  if (w.faultlink !== undefined) return { kind: "LINK", patternOrder: null };
  if (w.paint?.isPaving === true) return { kind: "PAVE", patternOrder: null };
  if (w.paint !== undefined) return { kind: "GROUND", patternOrder: null };
  if (w.blast !== undefined) return { kind: "AREA", patternOrder: null };
  if (w.nova !== undefined) return { kind: "AREA", patternOrder: null };
  if (w.implode !== undefined) return { kind: "AREA", patternOrder: null };
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
  // Effect-wave technique/tradeoff lines (the authored special mechanics, priced by rule
  // from canonical WeaponDef fields — never hand-written per weapon).
  if (w.lowHpBonus !== undefined) m.push({ tag: "RISK", text: "HITS HARDER THE LOWER YOUR HP", mag: w.lowHpBonus });
  if (w.charge !== undefined) m.push({ tag: "CHARGE", text: "HOLD TO CHARGE; FULL CHARGE WALKS A BLAST LINE", mag: 1 });
  if (w.wire !== undefined) m.push({ tag: "WIRE", text: "ARMED LINE TRAP", mag: w.wire.max });
  if (w.orbit !== undefined) {
    const blades = Math.min(MAX_ORBIT_BLADES, w.orbit.blades + mods.extraPellets);
    m.push({ tag: "ORBIT", text: `${blades} BLADES ORBIT YOU; FIRE FLARES THE RING`, mag: blades });
  }
  if (w.sentry !== undefined) m.push({ tag: "TURRET", text: "DEPLOYS A DESTRUCTIBLE TURRET", mag: w.sentry.hp });
  if (w.tether !== undefined) m.push({ tag: "TETHER", text: "REELS A TARGET IN; HEAVIES REEL YOU", mag: 1 });
  if (w.grapple !== undefined) m.push({ tag: "GRAPPLE", text: "WALL HIT PULLS YOU TO THE ANCHOR", mag: w.grapple.pull });
  if (w.modeShift !== undefined) m.push({ tag: "MODESHIFT", text: "ALTERNATES FLOOD FAN / DRAIN LANCE", mag: 2 });
  if (w.gamble !== undefined) m.push({ tag: "GAMBLE", text: "ROLLS 1 OF 4 PAYLOAD VERBS", mag: w.gamble.outcomes.length });
  if (w.resonate !== undefined) m.push({ tag: "TUNE", text: "A HIT RESONATES A NEARBY BODY OVER TIME", mag: w.resonate.range });
  if (w.rewrite !== undefined) m.push({ tag: "REWRITE", text: "INK MARKS; A SNAP REWRITES IT FOR A BURST", mag: w.rewrite.snapCoef });
  if (w.margin !== undefined) m.push({ tag: "COPY", text: "STORES ONE PAYLOAD CLASS AND ECHOES IT", mag: w.margin.maxCopyPellets });
  if (w.sidewinder !== undefined) m.push({ tag: "FLANK", text: "TWO CURVING ARCS BITE THE FLANK", mag: w.sidewinder.arcs });
  if (w.stance !== undefined) m.push({ tag: "STANCE", text: "STAND STILL TO RAMP SPREAD + PIERCE", mag: w.stance.maxStacks });
  if (w.parry !== undefined) m.push({ tag: "PARRY", text: "A FRONTAL WINDOW CATCHES A SHOT TO RETURN", mag: w.parry.returnCoef });
  if (w.relight !== undefined) m.push({ tag: "RELIGHT", text: "A LIT SHOT PIERCES AND PLANTS A SAFE PATCH", mag: w.relight.patchRadius });
  if (w.faultlink !== undefined) m.push({ tag: "LINK", text: "MARKS TWO BODIES AND ECHOES DAMAGE BETWEEN", mag: w.faultlink.range });
  if (w.paint?.isPaving === true) m.push({ tag: "PAVE", text: "CLEARS HOSTILE GROUND; PAVES FLOOR HAZARDS", mag: w.paint.radius });
  if (w.melee?.isThrust) m.push({ tag: "THRUST", text: "PIERCING THRUST", mag: 1 });
  if (w.chain !== undefined) m.push({ tag: "CHAIN", text: `CHAINS TO ${w.chain} MORE`, mag: w.chain });
  if (w.bounce !== undefined) m.push({ tag: "RICOCHET", text: w.bounce === 1 ? "RICOCHETS ONCE" : `RICOCHETS \u00d7${w.bounce}`, mag: w.bounce });
  if (w.homing !== undefined) m.push({ tag: "SEEKING", text: "SEEKING ROUNDS", mag: 1 });
  if (w.blast !== undefined) m.push({ tag: "BLAST", text: `${w.blast}PX BLAST`, mag: w.blast });
  if (w.burn !== undefined) m.push({ tag: "BURN", text: "SETS TARGETS ABLAZE", mag: 1 });
  if (w.chill !== undefined) m.push({ tag: "CHILL", text: "CHILLS ON HIT", mag: 1 });
  if (w.shock !== undefined) m.push({ tag: "SHOCK", text: "SHOCKS ON HIT", mag: 1 });
  // Legendary signature mechanics, honestly stated (the sim numbers, never flavor-only).
  if (w.killShards !== undefined) m.push({ tag: "REAP", text: `KILLS BURST INTO ${w.killShards} SEEKING SHARDS`, mag: w.killShards });
  if (w.accel !== undefined) m.push({ tag: "ACCEL", text: "ROUNDS ACCELERATE IN FLIGHT", mag: w.accel });
  if (w.coinBoost !== undefined) m.push({ tag: "GILDED", text: `EATS 1 COIN PER SHOT FOR \u00d7${w.coinBoost} DAMAGE`, mag: w.coinBoost });
  if (w.isPhase === true) m.push({ tag: "PHASE", text: "ROUNDS PASS THROUGH WALLS", mag: 1 });
  if (w.implode !== undefined) m.push({ tag: "IMPLODE", text: `${w.implode}PX IMPLOSION PULLS THE PACK IN`, mag: w.implode });
  if (w.nova !== undefined) m.push({ tag: "NOVA", text: `THE CLUMP TAKES A ${w.nova}PX NOVA BLAST`, mag: w.nova });
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
    rarity: w.rarity,
    role: roleOf(w),
    power: { perHit, count: pellets },
    impact: impactBand(perHit),
    cadence: cadenceBand(rate),
    reach: reachBand(isMelee ? w.melee!.reach : w.speed * mods.bulletSpeedMult * w.life * mods.bulletLifeMult),
    coverage: coverageOf(w, pellets, spread),
    mechanics: mechanicsOf(w, mods),
  };
}
