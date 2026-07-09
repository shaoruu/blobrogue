// Diagnostic images + the QA compare report. Nothing here is a golden fixture: PNGs are
// emitted into test/readability/out/ (gitignored) on failure or on demand (--report),
// so a human can see exactly what the metrics saw.

import { createCanvas, ImageData } from "@napi-rs/canvas";
import type { Canvas } from "@napi-rs/canvas";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TILE } from "../../src/sim/types.js";
import type { Scene } from "./scenes.js";
import { pixelClassMask } from "./scenes.js";
import { grayscaleRaster, simulateCvd, distanceToBoundary, lumaOf } from "./pixels.js";
import type { Raster, CvdKind, SegmentationResult } from "./pixels.js";
import { boundaryEdgeSegments, INTERIOR_DIST } from "./metrics.js";
import type { SceneMetrics, EdgeSegment } from "./metrics.js";

export function rasterOf(canvas: Canvas): Raster {
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { w: canvas.width, h: canvas.height, data: img.data };
}

function canvasOf(raster: Raster): Canvas {
  const c = createCanvas(raster.w, raster.h);
  c.getContext("2d").putImageData(new ImageData(raster.data, raster.w, raster.h), 0, 0);
  return c;
}

export function writePng(path: string, raster: Raster): void {
  writeFileSync(path, canvasOf(raster).encodeSync("png"));
}

// Misclassified interior pixels tinted red over the (dimmed) frame: where the blurred
// walkability read disagrees with the collision grid.
export function segmentationErrorOverlay(scene: Scene, raster: Raster, seg: SegmentationResult): Raster {
  const mask = pixelClassMask(scene);
  const dist = distanceToBoundary(mask, scene.viewW, scene.viewH);
  const data = new Uint8ClampedArray(raster.data.length);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    data[p] = raster.data[p] * 0.55;
    data[p + 1] = raster.data[p + 1] * 0.55;
    data[p + 2] = raster.data[p + 2] * 0.55;
    data[p + 3] = 255;
    if (dist[i] >= INTERIOR_DIST && seg.labels[i] !== mask[i]) {
      data[p] = 255; data[p + 1] = 40; data[p + 2] = 40;
    }
  }
  return { w: raster.w, h: raster.h, data };
}

// Boundary segments drawn over the frame: green = passes the configured edge-contrast
// floor, red = too weak to see. Failing outlines become literally visible.
export function edgeContrastOverlay(scene: Scene, raster: Raster, minEdgeContrast: number): Raster {
  const luma = lumaOf(raster);
  const segments = boundaryEdgeSegments(scene, luma);
  const data = Uint8ClampedArray.from(raster.data);
  const mark = (seg: EdgeSegment): void => {
    const sx = seg.tx * TILE - scene.camX;
    const sy = seg.ty * TILE - scene.camY;
    const ok = seg.contrastMean >= minEdgeContrast;
    for (let i = 0; i < TILE; i++) {
      let px: number, py: number;
      if (seg.side === "N") { px = sx + i; py = sy; }
      else if (seg.side === "S") { px = sx + i; py = sy + TILE - 1; }
      else if (seg.side === "W") { px = sx; py = sy + i; }
      else { px = sx + TILE - 1; py = sy + i; }
      if (px < 0 || py < 0 || px >= raster.w || py >= raster.h) continue;
      const p = (py * raster.w + px) * 4;
      data[p] = ok ? 40 : 255;
      data[p + 1] = ok ? 255 : 40;
      data[p + 2] = 60;
      data[p + 3] = 255;
    }
  };
  for (const seg of segments) mark(seg);
  return { w: raster.w, h: raster.h, data };
}

export interface SceneImages {
  frame: string;
  grayscale: string;
  segmentationErrors: string;
  edgeOverlay: string;
  cvd: Partial<Record<CvdKind, string>>;
}

export function writeSceneImages(
  outDir: string, prefix: string, scene: Scene, raster: Raster, metrics: SceneMetrics,
  minEdgeContrast: number, cvdKinds: readonly CvdKind[],
): SceneImages {
  mkdirSync(outDir, { recursive: true });
  const images: SceneImages = {
    frame: `${prefix}.png`,
    grayscale: `${prefix}.grayscale.png`,
    segmentationErrors: `${prefix}.segmentation-errors.png`,
    edgeOverlay: `${prefix}.edge-contrast.png`,
    cvd: {},
  };
  writePng(join(outDir, images.frame), raster);
  writePng(join(outDir, images.grayscale), grayscaleRaster(raster));
  writePng(join(outDir, images.segmentationErrors), segmentationErrorOverlay(scene, raster, metrics.segmentation));
  writePng(join(outDir, images.edgeOverlay), edgeContrastOverlay(scene, raster, minEdgeContrast));
  for (const kind of cvdKinds) {
    const name = `${prefix}.${kind}.png`;
    writePng(join(outDir, name), simulateCvd(raster, kind));
    images.cvd[kind] = name;
  }
  return images;
}

export interface ReportEntry {
  scene: Scene;
  tier: string;
  metrics: SceneMetrics;
  failures: string[];
  images: SceneImages | null;
}

const fmt = (v: number, digits = 1): string => (Number.isFinite(v) ? v.toFixed(digits) : "—");

export function writeHtmlReport(outDir: string, seed: number, entries: ReportEntry[]): string {
  const rows = entries.map((e) => {
    const m = e.metrics;
    const status = e.failures.length === 0
      ? '<span class="pass">PASS</span>'
      : `<span class="fail">FAIL</span><div class="why">${e.failures.map(esc).join("<br>")}</div>`;
    const imgs = e.images
      ? [
          ["frame", e.images.frame], ["grayscale", e.images.grayscale],
          ["seg errors", e.images.segmentationErrors], ["edges", e.images.edgeOverlay],
          ...Object.entries(e.images.cvd).map(([k, v]) => [k, v] as [string, string]),
        ].map(([label, src]) => `<figure><a href="${src}"><img src="${src}" loading="lazy"></a><figcaption>${esc(label)}</figcaption></figure>`).join("")
      : "<em>images not emitted (pass; rerun with --report)</em>";
    return `<tr>
      <td><strong>${esc(e.scene.label)}</strong><br><code>${esc(e.scene.id)}</code> · ${esc(e.tier)} art</td>
      <td>${status}</td>
      <td>floor ${fmt(m.luma.floorMedian)} / wall ${fmt(m.luma.wallMedian)}<br><strong>Δ ${fmt(m.luma.medianDelta)}</strong></td>
      <td>n=${m.edges.count} mean ${fmt(m.edges.meanOfMeans)}<br>p05 ${fmt(m.edges.p05OfMeans)} min ${fmt(m.edges.minOfMeans)} weak ${m.edges.weakCount}</td>
      <td>${fmt(m.segmentation.accuracy * 100, 2)}%</td>
      <td>${m.doorways.visibleCount}/${m.doorways.count}<br>weakest edge ${fmt(m.doorways.worstEdgeContrast)}</td>
      <td>${Object.entries(m.cvd).map(([k, v]) => `${esc(k)}: ${fmt(v.segmentationAccuracy * 100, 1)}% Δ${fmt(v.medianDelta)}`).join("<br>") || "—"}</td>
      <td>neon ${fmt(m.neonFraction * 100, 3)}%<br>busy ${fmt(m.floorBusyness, 2)}</td>
    </tr>
    <tr class="imgs"><td colspan="8">${imgs}</td></tr>`;
  }).join("\n");

  const html = `<!doctype html>
<meta charset="utf-8">
<title>blobrogue walkability readability report — seed ${seed}</title>
<style>
  body { font: 14px system-ui, sans-serif; background: #14121c; color: #e8e2f4; margin: 24px; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #3a3450; padding: 8px 10px; vertical-align: top; text-align: left; }
  th { background: #201c30; position: sticky; top: 0; }
  .pass { color: #7cfc98; font-weight: 700; }
  .fail { color: #ff6a5a; font-weight: 700; }
  .why { color: #ffb43b; margin-top: 4px; font-size: 12px; }
  .imgs td { background: #0d0b14; }
  figure { display: inline-block; margin: 4px; text-align: center; }
  figure img { max-width: 340px; max-height: 200px; image-rendering: pixelated; border: 1px solid #3a3450; }
  figcaption { font-size: 11px; color: #8f87a8; }
  code { color: #9fd4ff; }
</style>
<h1>Walkability readability report</h1>
<p>seed ${seed} · ${entries.length} scenes · Δ = grayscale floor/wall median separation (0–255) ·
edge = cross-boundary luma step along collision transitions · seg = blurred walkable/wall
classification accuracy ≥ ${INTERIOR_DIST}px from boundaries · doorways = mouths that still read walkable.</p>
<table>
<tr><th>scene</th><th>gate</th><th>luma Δ</th><th>boundary edges</th><th>segmentation</th><th>doorways</th><th>colorblind</th><th>noise</th></tr>
${rows}
</table>`;
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, "report.html");
  writeFileSync(path, html);
  return path;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
