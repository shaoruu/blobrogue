import {
  FRAME_MS_EMA_SEED,
  FX_QUALITY_DEGRADE_FRAMES,
  FX_QUALITY_MIN,
  FX_QUALITY_RESTORE_FRAMES,
  createFxQualityDwell,
  updateFrameMsEma,
  updateFxQualityTier,
} from "../src/game/adaptiveFxQuality.js";

let passed = 0;
let failed = 0;

function check(name: string, isPassing: boolean, detail = ""): void {
  if (isPassing) {
    passed++;
    process.stdout.write(`PASS ${name}${detail ? ` (${detail})` : ""}\n`);
    return;
  }
  failed++;
  process.stdout.write(`FAIL ${name}${detail ? ` (${detail})` : ""}\n`);
}

function runFrames(
  fxQuality: number,
  frameMsEma: number,
  frameMs: number,
  frames: number,
): { fxQuality: number; frameMsEma: number } {
  const dwell = createFxQualityDwell();
  for (let frame = 0; frame < frames; frame++) {
    frameMsEma = updateFrameMsEma(frameMsEma, frameMs);
    fxQuality = updateFxQualityTier(fxQuality, frameMsEma, dwell);
  }
  return { fxQuality, frameMsEma };
}

{
  const dwell = createFxQualityDwell();
  let fxQuality = 1;
  for (let frame = 0; frame < FX_QUALITY_DEGRADE_FRAMES - 1; frame++) {
    fxQuality = updateFxQualityTier(fxQuality, 29, dwell);
  }
  check("slow pressure waits for the full degrade dwell", fxQuality === 1);
  fxQuality = updateFxQualityTier(fxQuality, 29, dwell);
  check("slow pressure steps quality down by one quarter", fxQuality === 0.75);

  dwell.degradeFrames = 0;
  dwell.restoreFrames = 0;
  for (let frame = 0; frame < FX_QUALITY_RESTORE_FRAMES - 1; frame++) {
    fxQuality = updateFxQualityTier(fxQuality, 19, dwell);
  }
  check("recovery waits for the longer restore dwell", fxQuality === 0.75);
  fxQuality = updateFxQualityTier(fxQuality, 19, dwell);
  check("sustained clear frames restore one quarter", fxQuality === 1);
}

{
  const overloaded = runFrames(1, FRAME_MS_EMA_SEED, 40, 180);
  check("sustained 40ms frames engage every degrade tier", overloaded.fxQuality === FX_QUALITY_MIN);
  const prolonged = runFrames(overloaded.fxQuality, overloaded.frameMsEma, 40, 600);
  check("quality never falls below the 0.25 floor", prolonged.fxQuality === FX_QUALITY_MIN);
  const recovered = runFrames(prolonged.fxQuality, prolonged.frameMsEma, 10, 500);
  check("sustained fast frames restore full quality", recovered.fxQuality === 1);
}

{
  const deadBand = runFrames(0.5, 24, 24, 1_000);
  check("dead-band frames do not oscillate the tier", deadBand.fxQuality === 0.5);
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
