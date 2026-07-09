// Dungeon walkability readability gates — the regression fence for "I can't tell walls
// from ground". Renders representative floors for every canonical biome (plus synthetic
// wall-arrangement grids) HEADLESSLY through the exact production tile pass at
// production resolution, then gates deterministic image metrics:
//
//   - grayscale floor-vs-wall luminance separation (configurable minimum delta);
//   - boundary edge contrast along every visible collision transition (and on the
//     synthetic grids: EVERY edge — no outline may go missing at any corner/pillar/
//     thin-wall/autotile arrangement);
//   - blurred segmentation: a nearest-class-mean classifier on the blurred frame must
//     separate walkable from wall for >= 95% of pixels away from boundaries (frames
//     contain tiles only — no props/entities);
//   - doorway/corridor mouths must still classify walkable under blur;
//   - neon and floor-noise budgets (readable, not radioactive);
//   - the same reads under colorblind simulation (protanopia/deuteranopia/tritanopia)
//     and inherently in grayscale (all metrics are luma-based).
//
// All three art tiers are gated: authored per-biome tiles, the shared tile set (the
// fallback biomes without dedicated art already live on), and the flat palette
// fallback. No golden pixels are stored; failures emit diagnostic PNGs + report.html
// into test/readability/out/.
//
// Run: npm run test:readability
//      npm run test:readability -- --report            (images + report for every scene)
//      npm run test:readability -- --seed 999 --floors 3,8,13
//      npm run test:readability -- --min-luma-delta 12 --min-seg-accuracy 0.97

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rmSync } from "node:fs";
import { generatedScene, syntheticScenes, renderScene } from "./readability/scenes.js";
import type { Scene } from "./readability/scenes.js";
import { measureScene } from "./readability/metrics.js";
import type { SceneMetrics } from "./readability/metrics.js";
import type { CvdKind } from "./readability/pixels.js";
import { loadTileArt, ART_TIERS } from "./readability/tileArt.js";
import type { ArtTier } from "./readability/tileArt.js";
import { rasterOf, writeSceneImages, writeHtmlReport } from "./readability/report.js";
import type { ReportEntry } from "./readability/report.js";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");
const defaultOutDir = join(here, "readability", "out");

// One representative (non-milestone) floor per canonical biome band, Amberwild -> Null.
const DEFAULT_FLOORS = [3, 8, 13, 18, 23, 28, 33];
const CVD_KINDS: readonly CvdKind[] = ["protanopia", "deuteranopia", "tritanopia"];

// ---- gates ----
// Values are floors/ceilings locked to what the current art + readability layers
// actually deliver (see the PR's measured tables), with margin for raster jitter, so a
// regression that visibly flattens walls-vs-ground trips the fence. The flat tier is the
// no-art-yet palette fallback: dimmer separations by construction, gated accordingly.
interface Gates {
  minLumaDelta: number;          // grayscale median wall-floor separation, 0..255
  minEdgeMean: number;           // mean cross-boundary step over all segments
  minEdgeP05: number;            // 5th-percentile segment
  minEdgeSegment: number;        // per-segment floor (synthetic grids: EVERY edge)
  maxWeakEdgeFraction: number;   // generated floors: share of segments under minEdgeP05
  minSegAccuracy: number;        // blurred Otsu walkable/wall accuracy
  minCvdSegAccuracy: number;
  minCvdLumaDelta: number;
  maxNeonFraction: number;
  maxFloorBusyness: number;      // mean |grad luma| on interior floor px
}

const GATES: Record<ArtTier, Gates> = {
  authored: {
    minLumaDelta: 10,
    minEdgeMean: 26,
    minEdgeP05: 12,
    minEdgeSegment: 8,
    maxWeakEdgeFraction: 0.02,
    minSegAccuracy: 0.95,
    minCvdSegAccuracy: 0.95,
    minCvdLumaDelta: 9,
    maxNeonFraction: 0.002,
    maxFloorBusyness: 14,
  },
  shared: {
    minLumaDelta: 14,
    minEdgeMean: 26,
    minEdgeP05: 12,
    minEdgeSegment: 8,
    maxWeakEdgeFraction: 0.02,
    minSegAccuracy: 0.95,
    minCvdSegAccuracy: 0.95,
    minCvdLumaDelta: 12,
    maxNeonFraction: 0.002,
    maxFloorBusyness: 14,
  },
  flat: {
    minLumaDelta: 9,
    minEdgeMean: 18,
    minEdgeP05: 10,
    minEdgeSegment: 6,
    maxWeakEdgeFraction: 0.02,
    minSegAccuracy: 0.95,
    minCvdSegAccuracy: 0.95,
    minCvdLumaDelta: 7,
    maxNeonFraction: 0.002,
    maxFloorBusyness: 10,
  },
};

// ---- CLI ----
interface Cli {
  seed: number;
  floors: number[];
  tiers: ArtTier[];
  isReport: boolean;
  outDir: string;
  overrides: Partial<Pick<Gates, "minLumaDelta" | "minSegAccuracy" | "minEdgeMean">>;
}

function parseCli(argv: string[]): Cli {
  const cli: Cli = {
    seed: 12345,
    floors: [...DEFAULT_FLOORS],
    tiers: [...ART_TIERS],
    isReport: false,
    outDir: defaultOutDir,
    overrides: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seed") cli.seed = Number(argv[++i]);
    else if (a === "--floors") cli.floors = argv[++i].split(",").map(Number);
    else if (a === "--tiers") cli.tiers = argv[++i].split(",") as ArtTier[];
    else if (a === "--report") cli.isReport = true;
    else if (a === "--out") cli.outDir = argv[++i];
    else if (a === "--min-luma-delta") cli.overrides.minLumaDelta = Number(argv[++i]);
    else if (a === "--min-seg-accuracy") cli.overrides.minSegAccuracy = Number(argv[++i]);
    else if (a === "--min-edge-mean") cli.overrides.minEdgeMean = Number(argv[++i]);
    else throw new Error(`unknown arg: ${a}`);
  }
  return cli;
}

// ---- evaluation ----
// Generated production frames carry the distribution gates (luminance separation,
// blurred segmentation, colorblind reads, neon/noise budgets): they are the
// representative material mix. The synthetic micro-grids exist to pin arrangements —
// they gate boundary edges (including a per-segment "no outline missing" floor) and
// doorway mouths, where a border-ring-dominated frame is exactly the point.
function evaluateScene(scene: Scene, m: SceneMetrics, gates: Gates): string[] {
  const failures: string[] = [];
  const f = (cond: boolean, msg: string): void => { if (!cond) failures.push(msg); };
  if (m.edges.count > 0) {
    f(m.edges.meanOfMeans >= gates.minEdgeMean,
      `edge contrast mean ${m.edges.meanOfMeans.toFixed(1)} < ${gates.minEdgeMean}`);
    f(m.edges.p05OfMeans >= gates.minEdgeP05,
      `edge contrast p05 ${m.edges.p05OfMeans.toFixed(1)} < ${gates.minEdgeP05}`);
  }
  f(m.doorways.visibleCount === m.doorways.count,
    `doorways readable ${m.doorways.visibleCount}/${m.doorways.count} (weakest mouth edge ${m.doorways.worstEdgeContrast.toFixed(1)} < ${gates.minEdgeP05})`);
  if (scene.kind === "synthetic") {
    const weakest = m.edges.weakest;
    f(m.edges.minOfMeans >= gates.minEdgeSegment,
      `outline missing: weakest edge ${m.edges.minOfMeans.toFixed(1)} < ${gates.minEdgeSegment}` +
      (weakest ? ` at tile (${weakest.tx},${weakest.ty}) side ${weakest.side}` : ""));
    return failures;
  }
  f(m.edges.weakCount / Math.max(1, m.edges.count) <= gates.maxWeakEdgeFraction,
    `weak edges ${m.edges.weakCount}/${m.edges.count} exceed ${(gates.maxWeakEdgeFraction * 100).toFixed(0)}%`);
  f(m.luma.medianDelta >= gates.minLumaDelta,
    `luma delta ${m.luma.medianDelta.toFixed(1)} < ${gates.minLumaDelta} (floor ${m.luma.floorMedian.toFixed(1)} vs wall ${m.luma.wallMedian.toFixed(1)})`);
  f(m.segmentation.accuracy >= gates.minSegAccuracy,
    `blurred segmentation ${(m.segmentation.accuracy * 100).toFixed(2)}% < ${(gates.minSegAccuracy * 100).toFixed(0)}%`);
  f(m.neonFraction <= gates.maxNeonFraction,
    `neon fraction ${(m.neonFraction * 100).toFixed(3)}% > ${(gates.maxNeonFraction * 100).toFixed(3)}%`);
  f(m.floorBusyness <= gates.maxFloorBusyness,
    `floor busyness ${m.floorBusyness.toFixed(2)} > ${gates.maxFloorBusyness}`);
  for (const [kind, read] of Object.entries(m.cvd)) {
    f(read.segmentationAccuracy >= gates.minCvdSegAccuracy,
      `${kind} segmentation ${(read.segmentationAccuracy * 100).toFixed(2)}% < ${(gates.minCvdSegAccuracy * 100).toFixed(0)}%`);
    f(read.medianDelta >= gates.minCvdLumaDelta,
      `${kind} luma delta ${read.medianDelta.toFixed(1)} < ${gates.minCvdLumaDelta}`);
  }
  return failures;
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const t0 = Date.now();
  let passed = 0;
  let failed = 0;
  const entries: ReportEntry[] = [];

  if (cli.isReport) rmSync(cli.outDir, { recursive: true, force: true });

  for (const tier of cli.tiers) {
    const art = await loadTileArt(tier, publicDir);
    const gates: Gates = { ...GATES[tier], ...cli.overrides };
    const scenes: Scene[] = [
      ...cli.floors.map((floor) => generatedScene(cli.seed, floor)),
      ...syntheticScenes(),
    ];
    process.stdout.write(`\n[${tier} tiles]\n`);
    for (const scene of scenes) {
      const cvdKinds = scene.kind === "generated" ? CVD_KINDS : [];
      const raster = rasterOf(renderScene(scene, art));
      const metrics = measureScene(scene, raster, {
        minEdgeContrast: gates.minEdgeP05,
        isDetailDressed: art.ready("floor_crack") || art.ready("floor_moss") || art.ready("floor_grate"),
        cvdKinds,
      });
      const failures = evaluateScene(scene, metrics, gates);
      const summary =
        `Δ${metrics.luma.medianDelta.toFixed(0)} ` +
        `edge ${metrics.edges.meanOfMeans.toFixed(0)}/${metrics.edges.p05OfMeans.toFixed(0)} ` +
        `seg ${(metrics.segmentation.accuracy * 100).toFixed(1)}% ` +
        `doors ${metrics.doorways.visibleCount}/${metrics.doorways.count}`;
      let images = null;
      if (cli.isReport || failures.length > 0) {
        images = writeSceneImages(cli.outDir, `${tier}.${scene.id}`, scene, raster, metrics, gates.minEdgeP05, cvdKinds);
      }
      entries.push({ scene, tier, metrics, failures, images });
      if (failures.length === 0) {
        passed++;
        process.stdout.write(`  PASS ${scene.id} — ${summary}\n`);
      } else {
        failed++;
        process.stdout.write(`  FAIL ${scene.id} — ${summary}\n${failures.map((x) => `       · ${x}`).join("\n")}\n`);
      }
    }
  }

  if (cli.isReport || failed > 0) {
    const reportPath = writeHtmlReport(cli.outDir, cli.seed, entries);
    process.stdout.write(`\nreport: ${reportPath}\n`);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (failed > 0) {
    process.stdout.write(`\nFAIL — ${failed}/${passed + failed} scenes below the readability gates (${secs}s)\n`);
    process.exit(1);
  }
  process.stdout.write(`\nAll ${passed} readability scenes pass (seed ${cli.seed}, floors ${cli.floors.join(",")}, tiers ${cli.tiers.join(",")}, ${secs}s)\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
