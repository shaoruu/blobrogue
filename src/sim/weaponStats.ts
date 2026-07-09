// Weapon stat cards for the hotbar tooltip: base vs effective-current values, computed
// through the SAME functions the authoritative sim fires with (resolveShot /
// currentDamageMult / currentFireRate), so the tooltip can never drift from real combat
// math. Pure data in, pure data out — no DOM, usable by any surface (mouse tooltip today,
// controller/mobile focus panels later) and directly unit-testable.

import { WEAPONS } from "./weapons.js";
import type { Weapon } from "./weapons.js";
import type { WeaponId } from "./types.js";
import { createMods } from "./items.js";
import { resolveShot, currentDamageMult, currentFireRate } from "./world.js";
import type { ShotContext } from "./world.js";

// One tooltip row. `delta` grades the current value against base for the highlight:
// +1 improved (blessings buffed it), -1 worsened, 0 unchanged.
export interface WeaponStatLine {
  label: string;
  base: string;
  current: string;
  delta: -1 | 0 | 1;
}

export interface WeaponCard {
  id: WeaponId;
  name: string;
  kind: "ranged" | "melee";
  verb: string; // plain-English special-behavior line
  lines: WeaponStatLine[];
}

// The plain-English behavior line per weapon (what the numbers can't say).
const WEAPON_VERBS: Record<WeaponId, string> = {
  pistol: "Old faithful. No tricks, no excuses.",
  shotgun: "A wall of pellets. Get close.",
  rapid: "A hose of lead. Hold the trigger.",
  smg: "Fast, tight stinger fire.",
  cannon: "Slow slug that punches through 2 enemies.",
  burst: "Three-round volley per pull.",
  ricochet: "Rounds bounce off walls twice.",
  homing: "Wisps steer themselves toward enemies.",
  tesla: "Lightning chains to 3 extra enemies.",
  sawnoff: "Devastating point-blank. Useless far away.",
  railgun: "Near-hitscan precision slug.",
  nailer: "Full-auto nails that bounce once.",
  flamer: "Sprays fire that sets enemies ablaze.",
  sword: "Quick slashing arc.",
  longsword: "Huge, slow cleave.",
  spear: "Long forward thrust. Pokes through the crowd.",
};

// A neutral context (identity mods, full HP): the "base" column. Frozen per call site cost —
// tiny object, rebuilt per card computation to stay stateless.
function neutralContext(): ShotContext {
  return { mods: createMods(), hp: 1, maxHp: 1 };
}

const RAD_TO_DEG = 180 / Math.PI;

export function fmtNum(n: number, decimals = 1): string {
  const r = Math.round(n * 10 ** decimals) / 10 ** decimals;
  return Number.isInteger(r) ? String(r) : r.toFixed(decimals);
}

function fmtPct(frac: number): string {
  return `${Math.round(frac * 100)}%`;
}

// delta grading with an epsilon so float dust never fakes a buff arrow. `higherIsBetter`
// flips for stats like cooldown where lower is the improvement.
function grade(base: number, current: number, higherIsBetter = true): -1 | 0 | 1 {
  const eps = Math.max(1e-9, Math.abs(base) * 1e-6);
  if (Math.abs(current - base) <= eps) return 0;
  const isHigher = current > base;
  return isHigher === higherIsBetter ? 1 : -1;
}

function line(label: string, baseValue: number, currentValue: number, fmt: (n: number) => string, higherIsBetter = true): WeaponStatLine {
  return {
    label,
    base: fmt(baseValue),
    current: fmt(currentValue),
    delta: grade(baseValue, currentValue, higherIsBetter),
  };
}

function meleeCard(wep: Weapon, p: ShotContext, base: ShotContext): WeaponCard {
  const m = wep.melee!;
  const swingDur = m.swingDur ?? 0.2;
  const lines: WeaponStatLine[] = [
    line("damage", wep.damage * currentDamageMult(base), wep.damage * currentDamageMult(p), (n) => fmtNum(n)),
    line("cooldown", wep.fireCd / currentFireRate(base), wep.fireCd / currentFireRate(p), (n) => `${fmtNum(n, 2)}s`, false),
    line("swings/sec", currentFireRate(base) / wep.fireCd, currentFireRate(p) / wep.fireCd, (n) => fmtNum(n)),
    line("reach", m.reach, m.reach, (n) => `${fmtNum(n, 0)}px`),
    line(m.isThrust ? "thrust arc" : "swing arc", m.arc * RAD_TO_DEG, m.arc * RAD_TO_DEG, (n) => `${fmtNum(n, 0)}\u00b0`),
    line("swing time", swingDur, swingDur, (n) => `${fmtNum(n, 2)}s`, false),
  ];
  if (p.mods.critChance > 0) {
    lines.push(line("crit", base.mods.critChance, p.mods.critChance, fmtPct));
    lines.push(line("crit damage", base.mods.critMult, p.mods.critMult, (n) => `x${fmtNum(n)}`));
  }
  return { id: wep.id, name: wep.name, kind: "melee", verb: WEAPON_VERBS[wep.id], lines };
}

function rangedCard(wep: Weapon, p: ShotContext, base: ShotContext): WeaponCard {
  const cur = resolveShot(p, wep.id);
  const ref = resolveShot(base, wep.id);
  const lines: WeaponStatLine[] = [
    line("damage", ref.damage, cur.damage, (n) => fmtNum(n)),
    line("cooldown", wep.fireCd / currentFireRate(base), wep.fireCd / currentFireRate(p), (n) => `${fmtNum(n, 2)}s`, false),
    line("shots/sec", currentFireRate(base) / wep.fireCd, currentFireRate(p) / wep.fireCd, (n) => fmtNum(n)),
    line("speed", ref.speed, cur.speed, (n) => `${fmtNum(n, 0)}px/s`),
    line("range", ref.speed * ref.life, cur.speed * cur.life, (n) => `${fmtNum(n, 0)}px`),
  ];
  if (ref.pellets > 1 || cur.pellets > 1) {
    lines.push(line("pellets", ref.pellets, cur.pellets, (n) => `x${fmtNum(n, 0)}`));
  }
  if (ref.spread > 0 || cur.spread > 0) {
    lines.push(line("spread", ref.spread * RAD_TO_DEG, cur.spread * RAD_TO_DEG, (n) => `${fmtNum(n, 0)}\u00b0`, false));
  }
  if (ref.pierce > 0 || cur.pierce > 0) {
    lines.push(line("pierce", ref.pierce, cur.pierce, (n) => fmtNum(n, 0)));
  }
  if (wep.bounce !== undefined) lines.push(line("bounces", wep.bounce, wep.bounce, (n) => fmtNum(n, 0)));
  if (wep.chain !== undefined) lines.push(line("chains", wep.chain, wep.chain, (n) => fmtNum(n, 0)));
  if (cur.critChance > 0) {
    lines.push(line("crit", ref.critChance, cur.critChance, fmtPct));
    lines.push(line("crit damage", ref.critMult, cur.critMult, (n) => `x${fmtNum(n)}`));
  }
  return { id: wep.id, name: wep.name, kind: "ranged", verb: WEAPON_VERBS[wep.id], lines };
}

// Build the card for one weapon against the player's LIVE context (mods + hp, so
// berserk/adrenaline show their true current effect) versus the unmodified base weapon.
export function weaponCard(id: WeaponId, p: ShotContext): WeaponCard {
  const wep = WEAPONS[id];
  const base = neutralContext();
  return wep.melee ? meleeCard(wep, p, base) : rangedCard(wep, p, base);
}

// Cheap identity for change detection: the tooltip re-renders only when this differs.
export function weaponCardKey(card: WeaponCard): string {
  return card.id + "|" + card.lines.map((l) => l.base + ">" + l.current + l.delta).join("|");
}
