// Scene-level readability measurements: floor/wall grayscale separation, per-edge
// boundary contrast along every collision transition, blurred segmentation
// accuracy, doorway visibility, and neon/noise budgets — plus the same reads under
// colorblind simulation. All deterministic image metrics; no golden pixels.

import { TILE } from "../../src/sim/types.js";
import { tileHash } from "../../src/game/tileRender.js";
import { pixelClassMask } from "./scenes.js";
import type { Scene } from "./scenes.js";
import {
  lumaOf, distanceToBoundary, classLumaStats, blurredSegmentation,
  neonFraction, floorBusyness, simulateCvd, percentile,
} from "./pixels.js";
import type { Raster, ClassLumaStats, SegmentationResult, CvdKind } from "./pixels.js";

// Material interiors start this many px from the collision boundary: outside the
// outline stroke, wall lip, edge strips and the opaque span of the cast wall shadow
// (~17px), all of which are boundary signal rather than material.
export const INTERIOR_DIST = 22;
// Blur radius (3 box passes ~ gaussian, sigma ~6.5px) for the low-acuity read: strong
// enough to dissolve tile texture, weak enough that rooms/corridors survive.
export const BLUR_RADIUS = 6;
// Half-width of the luma profile sampled across each boundary.
const EDGE_PROBE = 7;

export interface EdgeSegment {
  tx: number;
  ty: number;
  side: "N" | "S" | "E" | "W"; // which side of this floor tile the wall sits on
  contrastMean: number;         // mean cross-boundary luma step along the 48px edge
  contrastMin: number;          // weakest column of the edge
}

export interface EdgeStats {
  count: number;
  meanOfMeans: number;
  p05OfMeans: number;
  minOfMeans: number;
  weakCount: number; // segments whose mean step falls under the configured minimum
  weakest: EdgeSegment | null;
}

export interface DoorwayStats {
  count: number;             // doorways whose both flanks were measurable in-view
  visibleCount: number;
  worstEdgeContrast: number; // weakest mouth-flank boundary among all doorways
}

export interface CvdRead {
  medianDelta: number;
  segmentationAccuracy: number;
}

export interface SceneMetrics {
  luma: ClassLumaStats;
  edges: EdgeStats;
  segmentation: SegmentationResult;
  doorways: DoorwayStats;
  neonFraction: number;
  floorBusyness: number;
  cvd: Record<CvdKind, CvdRead>;
}

function wallAt(scene: Scene, tx: number, ty: number): boolean {
  const { dungeon: d } = scene;
  if (tx < 0 || ty < 0 || tx >= d.w || ty >= d.h) return true;
  return d.tiles[ty * d.w + tx] === 1;
}

function floorAt(scene: Scene, tx: number, ty: number): boolean {
  const { dungeon: d } = scene;
  if (tx < 0 || ty < 0 || tx >= d.w || ty >= d.h) return false;
  return d.tiles[ty * d.w + tx] === 0;
}

// Every floor->wall collision transition visible in the scene, with the luminance step
// measured perpendicular to the boundary (max central difference within +-EDGE_PROBE px).
// This is exactly "can you see where walkable ends" in grayscale.
export function boundaryEdgeSegments(scene: Scene, luma: Float32Array): EdgeSegment[] {
  const { dungeon: d } = scene;
  const W = scene.viewW, H = scene.viewH;
  const tx0 = Math.max(0, Math.floor(scene.camX / TILE));
  const ty0 = Math.max(0, Math.floor(scene.camY / TILE));
  const tx1 = Math.min(d.w, Math.ceil((scene.camX + W) / TILE));
  const ty1 = Math.min(d.h, Math.ceil((scene.camY + H) / TILE));
  const segments: EdgeSegment[] = [];

  const columnContrast = (bx: number, by: number, isVertical: boolean): number => {
    let best = 0;
    for (let o = -EDGE_PROBE + 1; o <= EDGE_PROBE - 1; o++) {
      const a = isVertical ? luma[(by + o - 1) * W + bx] : luma[by * W + bx + o - 1];
      const b = isVertical ? luma[(by + o + 1) * W + bx] : luma[by * W + bx + o + 1];
      const step = Math.abs(b - a);
      if (step > best) best = step;
    }
    return best;
  };

  const pushSegment = (tx: number, ty: number, side: EdgeSegment["side"]): void => {
    // Boundary line in screen px, on the wall side of this floor tile.
    const sx = tx * TILE - scene.camX;
    const sy = ty * TILE - scene.camY;
    let sum = 0, min = Infinity, n = 0;
    for (let i = 0; i < TILE; i++) {
      let bx: number, by: number, isVertical: boolean;
      if (side === "N") { bx = sx + i; by = sy; isVertical = true; }
      else if (side === "S") { bx = sx + i; by = sy + TILE; isVertical = true; }
      else if (side === "W") { bx = sx; by = sy + i; isVertical = false; }
      else { bx = sx + TILE; by = sy + i; isVertical = false; }
      if (bx < EDGE_PROBE || by < EDGE_PROBE || bx >= W - EDGE_PROBE || by >= H - EDGE_PROBE) continue;
      const c = columnContrast(bx, by, isVertical);
      sum += c;
      if (c < min) min = c;
      n++;
    }
    if (n < TILE / 2) return; // segment mostly off-screen: not measurable
    segments.push({ tx, ty, side, contrastMean: sum / n, contrastMin: min });
  };

  for (let ty = ty0; ty < ty1; ty++) {
    for (let tx = tx0; tx < tx1; tx++) {
      if (!floorAt(scene, tx, ty)) continue;
      if (wallAt(scene, tx, ty - 1)) pushSegment(tx, ty, "N");
      if (wallAt(scene, tx, ty + 1)) pushSegment(tx, ty, "S");
      if (wallAt(scene, tx - 1, ty)) pushSegment(tx, ty, "W");
      if (wallAt(scene, tx + 1, ty)) pushSegment(tx, ty, "E");
    }
  }
  return segments;
}

export function edgeStats(segments: EdgeSegment[], minEdgeContrast: number): EdgeStats {
  if (segments.length === 0) {
    return { count: 0, meanOfMeans: 0, p05OfMeans: 0, minOfMeans: 0, weakCount: 0, weakest: null };
  }
  const means = segments.map((s) => s.contrastMean).sort((a, b) => a - b);
  let weakCount = 0;
  let weakest = segments[0];
  for (const s of segments) {
    if (s.contrastMean < minEdgeContrast) weakCount++;
    if (s.contrastMean < weakest.contrastMean) weakest = s;
  }
  return {
    count: segments.length,
    meanOfMeans: means.reduce((a, b) => a + b, 0) / means.length,
    p05OfMeans: percentile(means, 0.05),
    minOfMeans: means[0],
    weakCount,
    weakest,
  };
}

export interface DoorwayCell { tx: number; ty: number; orientation: "h" | "v" }

// Corridor mouths / doorways: floor cells pinched between opposite walls. These are the
// navigation-critical pixels — a doorway that reads as wall is a dead player.
export function doorwayCells(scene: Scene): DoorwayCell[] {
  const { dungeon: d } = scene;
  const out: DoorwayCell[] = [];
  const tx0 = Math.max(1, Math.floor(scene.camX / TILE));
  const ty0 = Math.max(1, Math.floor(scene.camY / TILE));
  const tx1 = Math.min(d.w - 1, Math.ceil((scene.camX + scene.viewW) / TILE));
  const ty1 = Math.min(d.h - 1, Math.ceil((scene.camY + scene.viewH) / TILE));
  for (let ty = ty0; ty < ty1; ty++) {
    for (let tx = tx0; tx < tx1; tx++) {
      if (!floorAt(scene, tx, ty)) continue;
      const n = wallAt(scene, tx, ty - 1), s = wallAt(scene, tx, ty + 1);
      const w = wallAt(scene, tx - 1, ty), e = wallAt(scene, tx + 1, ty);
      if (n && s && !w && !e) out.push({ tx, ty, orientation: "h" });
      else if (w && e && !n && !s) out.push({ tx, ty, orientation: "v" });
    }
  }
  return out;
}

// A doorway is "visible" when BOTH boundaries flanking the mouth carry a readable
// luminance step: the gap's edges are what leads the eye through it. Gated per-door,
// so no averaging can hide one fused mouth.
export function doorwayStats(scene: Scene, segments: EdgeSegment[], minEdgeContrast: number): DoorwayStats {
  const cells = doorwayCells(scene);
  const bySide = new Map<string, EdgeSegment>();
  for (const s of segments) bySide.set(`${s.tx},${s.ty},${s.side}`, s);
  let count = 0;
  let visibleCount = 0;
  let worst = Infinity;
  for (const cell of cells) {
    const sides: Array<EdgeSegment["side"]> = cell.orientation === "v" ? ["W", "E"] : ["N", "S"];
    const flanks = sides.map((side) => bySide.get(`${cell.tx},${cell.ty},${side}`)).filter((s) => s !== undefined);
    if (flanks.length < 2) continue; // mouth clipped by the view edge: not measurable
    count++;
    const weakest = Math.min(...flanks.map((s) => s.contrastMean));
    if (weakest < worst) worst = weakest;
    if (weakest >= minEdgeContrast) visibleCount++;
  }
  return { count, visibleCount, worstEdgeContrast: Number.isFinite(worst) ? worst : Infinity };
}

export interface MeasureOptions {
  minEdgeContrast: number;
  // True when the floor-detail dressing (moss/cracks/grates) actually rendered: those
  // tiles are decals ON the walkable ground — excluded from the segmentation accuracy
  // like props/entities are, but still gated by neon/busyness budgets.
  isDetailDressed: boolean;
  cvdKinds: readonly CvdKind[];
}

// Pixels of floor tiles carrying a detail overlay (renderer: tileHash(tx,ty,2) below
// the biome's detailDensity). 1 = dressed.
function detailDressingMask(scene: Scene): Uint8Array {
  const { dungeon: d } = scene;
  const out = new Uint8Array(scene.viewW * scene.viewH);
  const density = scene.biome.detailDensity;
  for (let py = 0; py < scene.viewH; py++) {
    const ty = Math.min(d.h - 1, Math.max(0, Math.floor((py + scene.camY) / TILE)));
    for (let px = 0; px < scene.viewW; px++) {
      const tx = Math.min(d.w - 1, Math.max(0, Math.floor((px + scene.camX) / TILE)));
      if (d.tiles[ty * d.w + tx] === 0 && tileHash(tx, ty, 2) < density) out[py * scene.viewW + px] = 1;
    }
  }
  return out;
}

export function measureScene(scene: Scene, raster: Raster, opts: MeasureOptions): SceneMetrics {
  const W = scene.viewW, H = scene.viewH;
  const mask = pixelClassMask(scene);
  const dist = distanceToBoundary(mask, W, H);
  const excluded = opts.isDetailDressed ? detailDressingMask(scene) : null;
  const luma = lumaOf(raster);
  const segmentation = blurredSegmentation(raster, mask, dist, BLUR_RADIUS, INTERIOR_DIST, excluded);
  const segments = boundaryEdgeSegments(scene, luma);
  const cvd = {} as Record<CvdKind, CvdRead>;
  for (const kind of opts.cvdKinds) {
    const sim = simulateCvd(raster, kind);
    const simStats = classLumaStats(lumaOf(sim), mask, dist, INTERIOR_DIST);
    const simSeg = blurredSegmentation(sim, mask, dist, BLUR_RADIUS, INTERIOR_DIST, excluded);
    cvd[kind] = { medianDelta: simStats.medianDelta, segmentationAccuracy: simSeg.accuracy };
  }
  return {
    luma: classLumaStats(luma, mask, dist, INTERIOR_DIST),
    edges: edgeStats(segments, opts.minEdgeContrast),
    segmentation,
    doorways: doorwayStats(scene, segments, opts.minEdgeContrast),
    neonFraction: neonFraction(raster),
    floorBusyness: floorBusyness(luma, W, H, mask, dist, INTERIOR_DIST),
    cvd,
  };
}
