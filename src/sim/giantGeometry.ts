import type { GiantConst } from "./balance.js";

const TAU = Math.PI * 2;

export function giantRingGapStart(attackCount: number, ringIndex: number, config: GiantConst): number {
  const baseGap = (attackCount * 5) % config.ringCount;
  const offset = ringIndex === 1 ? (config.ring2GapOffsetSlots ?? 0) : 0;
  return (baseGap + offset) % config.ringCount;
}

export function giantRingGapCenter(attackCount: number, ringIndex: number, config: GiantConst): number {
  return ((giantRingGapStart(attackCount, ringIndex, config) + config.ringGap / 2) / config.ringCount) * TAU;
}

export function giantSpokeWheel(
  emission: number,
  burstParity: number,
  wheelIndex: number,
  config: GiantConst,
): number {
  const step = wheelIndex === 1 ? (config.spoke2Step ?? config.spokeStep) : config.spokeStep;
  return emission * step + burstParity;
}

export function giantSafeIntersection(
  emission: number,
  burstParity: number,
  config: GiantConst,
): { center: number; width: number } | null {
  if (config.spoke2Step === undefined) return null;
  const primaryWidth = (config.spokeGap / config.spokeCount) * TAU;
  const counterWidth = ((config.spoke2Gap ?? config.spokeGap) / config.spokeCount) * TAU;
  const primaryCenter = giantSpokeWheel(emission, burstParity, 0, config) + primaryWidth / 2;
  const rawCounterCenter = giantSpokeWheel(emission, burstParity, 1, config) + counterWidth / 2;
  const delta = Math.atan2(
    Math.sin(rawCounterCenter - primaryCenter),
    Math.cos(rawCounterCenter - primaryCenter),
  );
  const counterCenter = primaryCenter + delta;
  const left = Math.max(primaryCenter - primaryWidth / 2, counterCenter - counterWidth / 2);
  const right = Math.min(primaryCenter + primaryWidth / 2, counterCenter + counterWidth / 2);
  if (right <= left) return null;
  return { center: Math.atan2(Math.sin((left + right) / 2), Math.cos((left + right) / 2)), width: right - left };
}
