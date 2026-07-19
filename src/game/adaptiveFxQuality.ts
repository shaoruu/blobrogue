export const FRAME_MS_EMA_SEED = 16.7;
export const FRAME_MS_EMA_ALPHA = 0.1;
export const FX_QUALITY_MAX = 1;
export const FX_QUALITY_MIN = 0.25;
export const FX_QUALITY_STEP = 0.25;
export const FX_QUALITY_DEGRADE_MS = 28;
export const FX_QUALITY_RESTORE_MS = 20;
export const FX_QUALITY_DEGRADE_FRAMES = 30;
export const FX_QUALITY_RESTORE_FRAMES = 90;

export interface FxQualityDwell {
  degradeFrames: number;
  restoreFrames: number;
}

export function createFxQualityDwell(): FxQualityDwell {
  return { degradeFrames: 0, restoreFrames: 0 };
}

export function resetFxQualityDwell(dwell: FxQualityDwell): void {
  dwell.degradeFrames = 0;
  dwell.restoreFrames = 0;
}

export function updateFrameMsEma(frameMsEma: number, frameMs: number): number {
  return frameMsEma + (frameMs - frameMsEma) * FRAME_MS_EMA_ALPHA;
}

export function updateFxQualityTier(
  fxQuality: number,
  frameMsEma: number,
  dwell: FxQualityDwell,
): number {
  if (frameMsEma > FX_QUALITY_DEGRADE_MS) {
    dwell.restoreFrames = 0;
    if (fxQuality <= FX_QUALITY_MIN) {
      dwell.degradeFrames = 0;
      return FX_QUALITY_MIN;
    }
    dwell.degradeFrames++;
    if (dwell.degradeFrames < FX_QUALITY_DEGRADE_FRAMES) return fxQuality;
    dwell.degradeFrames = 0;
    return Math.max(FX_QUALITY_MIN, fxQuality - FX_QUALITY_STEP);
  }

  if (frameMsEma < FX_QUALITY_RESTORE_MS) {
    dwell.degradeFrames = 0;
    if (fxQuality >= FX_QUALITY_MAX) {
      dwell.restoreFrames = 0;
      return FX_QUALITY_MAX;
    }
    dwell.restoreFrames++;
    if (dwell.restoreFrames < FX_QUALITY_RESTORE_FRAMES) return fxQuality;
    dwell.restoreFrames = 0;
    return Math.min(FX_QUALITY_MAX, fxQuality + FX_QUALITY_STEP);
  }

  resetFxQualityDwell(dwell);
  return fxQuality;
}
