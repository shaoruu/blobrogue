import {
  HALO_VISUAL_BASE,
  HALO_VISUAL_CAP,
  haloVisualStrength,
  haloVisualTier,
} from "../src/game/haloVisual.js";
import { createMods, recomputeMods } from "../src/sim/items.js";

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

function tierFor(items: readonly string[]): number {
  const mods = createMods();
  recomputeMods(mods, items);
  return haloVisualTier(
    Math.min(HALO_VISUAL_CAP.blades, HALO_VISUAL_BASE.blades + mods.extraPellets),
    HALO_VISUAL_BASE.bladeRadius * mods.bulletSizeMult,
    HALO_VISUAL_BASE.speed * mods.bulletSpeedMult,
  );
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
    tierFor(["split_shot"]) === 1,
  );
  check(
    "a first Marksman speed upgrade reaches charged tier 1",
    tierFor(["marksman"]) === 1,
  );
  check(
    "Frostbite blade growth reaches charged tier 1",
    tierFor(["frostbite"]) === 1,
  );
  check(
    "Split Shot II reaches the formidable blade cap",
    tierFor(["split_shot", "split_shot"]) === 2,
  );
  check(
    "Big Iron reaches the formidable visual size cap",
    tierFor(["big_iron"]) === 2,
  );
  check(
    "Marksman III reaches the formidable speed cap",
    tierFor(["marksman", "marksman", "marksman"]) === 2,
  );

  process.stdout.write("\n[Razor Halo visual input caps]\n");
  check(
    "inputs above every visual cap clamp to strength 1",
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
