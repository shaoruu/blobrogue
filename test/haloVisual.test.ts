import {
  HALO_VISUAL_BASE,
  HALO_VISUAL_CAP,
  haloVisualStrength,
  haloVisualTier,
} from "../src/game/haloVisual.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    process.stdout.write(`  PASS ${name}${detail ? ` — ${detail}` : ""}\n`);
    return;
  }
  failed++;
  failures.push(name);
  process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ""}\n`);
}

function main(): void {
  process.stdout.write("\n[Razor Halo visual tier derivation]\n");

  check(
    "unmodified Halo is restrained tier 0",
    haloVisualTier(
      HALO_VISUAL_BASE.blades,
      HALO_VISUAL_BASE.bladeRadius,
      HALO_VISUAL_BASE.speed,
    ) === 0,
  );
  check(
    "one extra blade reaches charged tier 1",
    haloVisualTier(5, HALO_VISUAL_BASE.bladeRadius, HALO_VISUAL_BASE.speed) === 1,
  );
  check(
    "a first Marksman speed upgrade reaches charged tier 1",
    haloVisualTier(
      HALO_VISUAL_BASE.blades,
      HALO_VISUAL_BASE.bladeRadius,
      HALO_VISUAL_BASE.speed * 1.12,
    ) === 1,
  );
  check(
    "Frostbite blade growth reaches charged tier 1",
    haloVisualTier(
      HALO_VISUAL_BASE.blades,
      HALO_VISUAL_BASE.bladeRadius * 1.4,
      HALO_VISUAL_BASE.speed,
    ) === 1,
  );
  check(
    "the legal blade cap reaches formidable tier 2",
    haloVisualTier(
      HALO_VISUAL_CAP.blades,
      HALO_VISUAL_BASE.bladeRadius,
      HALO_VISUAL_BASE.speed,
    ) === 2,
  );
  check(
    "maximum legal size reaches formidable tier 2",
    haloVisualTier(
      HALO_VISUAL_BASE.blades,
      HALO_VISUAL_CAP.bladeRadius,
      HALO_VISUAL_BASE.speed,
    ) === 2,
  );
  check(
    "maximum legal speed reaches formidable tier 2",
    haloVisualTier(
      HALO_VISUAL_BASE.blades,
      HALO_VISUAL_BASE.bladeRadius,
      HALO_VISUAL_CAP.speed,
    ) === 2,
  );

  process.stdout.write("\n[Razor Halo visual input caps]\n");
  check(
    "inputs above every legal cap clamp to strength 1",
    haloVisualStrength(99, 999, 999) === 1,
  );
  check(
    "debuffed inputs never reduce strength below 0",
    haloVisualStrength(0, 0, 0) === 0,
  );
  check(
    "smooth mid-tier strength remains fractional",
    haloVisualStrength(5, HALO_VISUAL_BASE.bladeRadius, HALO_VISUAL_BASE.speed) === 0.5,
  );

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) {
    process.stdout.write(`FAILURES:\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`);
    process.exit(1);
  }
}

main();
