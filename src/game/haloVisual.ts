import { WEAPONS, MAX_ORBIT_BLADES } from "../sim/weapons.js";

export type HaloVisualTier = 0 | 1 | 2;

const spec = WEAPONS.halo.orbit;
if (spec === undefined) throw new Error("Razor Halo orbit spec is missing");

export const HALO_VISUAL_BASE = {
  blades: spec.blades,
  bladeRadius: spec.bladeRadius,
  speed: spec.speed,
} as const;

export const HALO_VISUAL_CAP = {
  blades: MAX_ORBIT_BLADES,
  bladeRadius: spec.bladeRadius * 1.8,
  speed: spec.speed * 1.24,
} as const;

function normalizedGain(value: number, base: number, cap: number): number {
  if (value <= base) return 0;
  if (value >= cap) return 1;
  return (value - base) / (cap - base);
}

export function haloVisualStrength(blades: number, bladeRadius: number, speed: number): number {
  const bladeGain = normalizedGain(blades, HALO_VISUAL_BASE.blades, HALO_VISUAL_CAP.blades);
  const sizeGain = normalizedGain(
    bladeRadius,
    HALO_VISUAL_BASE.bladeRadius,
    HALO_VISUAL_CAP.bladeRadius,
  );
  const speedGain = normalizedGain(speed, HALO_VISUAL_BASE.speed, HALO_VISUAL_CAP.speed);
  return Math.max(bladeGain, sizeGain * 0.75, speedGain * 0.65);
}

export function haloVisualTier(blades: number, bladeRadius: number, speed: number): HaloVisualTier {
  const strength = haloVisualStrength(blades, bladeRadius, speed);
  if (strength >= 0.64) return 2;
  if (strength >= 0.3) return 1;
  return 0;
}
