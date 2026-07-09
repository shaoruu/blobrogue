// Pure pixel math for the readability gates: rasters, grayscale luma, separable box
// blur, nearest-mean segmentation, chamfer distance to a class boundary, and colorblind
// (CVD) simulation. No canvas, no DOM — everything operates on plain typed arrays so
// the metrics are deterministic and portable.

export interface Raster {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8ClampedArray; // RGBA
}

// Rec.709 luma on the gamma-encoded frame — the standard "convert to grayscale" a
// player's eye (or a grayscale screenshot) applies. Range 0..255.
export function lumaOf(r: Raster): Float32Array {
  const out = new Float32Array(r.w * r.h);
  const d = r.data;
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
  }
  return out;
}

export function grayscaleRaster(r: Raster): Raster {
  const data = new Uint8ClampedArray(r.data.length);
  const d = r.data;
  for (let p = 0; p < d.length; p += 4) {
    const y = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
    data[p] = y; data[p + 1] = y; data[p + 2] = y; data[p + 3] = 255;
  }
  return { w: r.w, h: r.h, data };
}

// Separable box blur with edge clamp; `passes` box passes approximate a gaussian.
export function boxBlur(src: Float32Array, w: number, h: number, radius: number, passes: number): Float32Array {
  let cur = Float32Array.from(src);
  let tmp = new Float32Array(src.length);
  const win = 2 * radius + 1;
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let x = -radius; x <= radius; x++) acc += cur[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / win;
        const add = Math.min(w - 1, x + radius + 1);
        const sub = Math.max(0, x - radius);
        acc += cur[row + add] - cur[row + sub];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -radius; y <= radius; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        cur[y * w + x] = acc / win;
        const add = Math.min(h - 1, y + radius + 1);
        const sub = Math.max(0, y - radius);
        acc += tmp[add * w + x] - tmp[sub * w + x];
      }
    }
  }
  return cur;
}

// Chamfer (3-4) distance in pixels from every pixel to the nearest class boundary of a
// binary mask. Two passes, deterministic, ~exact for gate purposes.
export function distanceToBoundary(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h).fill(INF);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = mask[i];
      if ((x + 1 < w && mask[i + 1] !== c) || (x > 0 && mask[i - 1] !== c) ||
          (y + 1 < h && mask[i + w] !== c) || (y > 0 && mask[i - w] !== c)) d[i] = 0;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 3);
      if (y > 0) {
        d[i] = Math.min(d[i], d[i - w] + 3);
        if (x > 0) d[i] = Math.min(d[i], d[i - w - 1] + 4);
        if (x + 1 < w) d[i] = Math.min(d[i], d[i - w + 1] + 4);
      }
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x + 1 < w) d[i] = Math.min(d[i], d[i + 1] + 3);
      if (y + 1 < h) {
        d[i] = Math.min(d[i], d[i + w] + 3);
        if (x + 1 < w) d[i] = Math.min(d[i], d[i + w + 1] + 4);
        if (x > 0) d[i] = Math.min(d[i], d[i + w - 1] + 4);
      }
    }
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}

export function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return NaN;
  const idx = Math.min(sortedAscending.length - 1, Math.max(0, Math.round(p * (sortedAscending.length - 1))));
  return sortedAscending[idx];
}

export interface ClassLumaStats {
  floorMean: number; floorMedian: number; floorP10: number; floorP90: number;
  wallMean: number; wallMedian: number; wallP10: number; wallP90: number;
  medianDelta: number; // |wall median - floor median| in 0..255
  meanDelta: number;
}

// Floor-vs-wall grayscale distributions over MATERIAL INTERIOR pixels (>= minDist px
// from the collision boundary, so caps/outlines/shadow bands measure as edges, not as
// the material itself).
export function classLumaStats(luma: Float32Array, mask: Uint8Array, dist: Float32Array, minDist: number): ClassLumaStats {
  const floor: number[] = [];
  const wall: number[] = [];
  for (let i = 0; i < luma.length; i++) {
    if (dist[i] < minDist) continue;
    (mask[i] === 0 ? floor : wall).push(luma[i]);
  }
  floor.sort((a, b) => a - b);
  wall.sort((a, b) => a - b);
  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / Math.max(1, xs.length);
  const s: ClassLumaStats = {
    floorMean: mean(floor), floorMedian: percentile(floor, 0.5), floorP10: percentile(floor, 0.1), floorP90: percentile(floor, 0.9),
    wallMean: mean(wall), wallMedian: percentile(wall, 0.5), wallP10: percentile(wall, 0.1), wallP90: percentile(wall, 0.9),
    medianDelta: 0, meanDelta: 0,
  };
  s.medianDelta = Math.abs(s.wallMedian - s.floorMedian);
  s.meanDelta = Math.abs(s.wallMean - s.floorMean);
  return s;
}

export interface SegmentationResult {
  accuracy: number;     // fraction of evaluated pixels classified correctly
  evaluated: number;    // pixel count >= minDist from the boundary
  labels: Uint8Array;   // per-pixel predicted class (0 floor, 1 wall), for diagnostics
}

// Blur-then-classify segmentation: what a squinting / low-acuity / small-screen read of
// the frame resolves. The frame is blurred per channel, then the simplest possible
// classifier — nearest class mean in RGB — labels every pixel walkable or wall. Class
// means are the only trained parameters; accuracy is judged away from boundaries so
// this measures region separability (edge sharpness has its own metric).
export function blurredSegmentation(
  raster: Raster, mask: Uint8Array, dist: Float32Array,
  blurRadius: number, minDist: number, excluded: Uint8Array | null = null,
): SegmentationResult {
  const { w, h, data } = raster;
  const n = w * h;
  const channels: Float32Array[] = [0, 1, 2].map((c) => {
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) ch[i] = data[i * 4 + c];
    return boxBlur(ch, w, h, blurRadius, 3);
  });
  const mean = [new Float64Array(3), new Float64Array(3)];
  const count = [0, 0];
  for (let i = 0; i < n; i++) {
    const k = mask[i];
    count[k]++;
    for (let c = 0; c < 3; c++) mean[k][c] += channels[c][i];
  }
  for (const k of [0, 1]) {
    if (count[k] === 0) continue;
    for (let c = 0; c < 3; c++) mean[k][c] /= count[k];
  }
  const labels = new Uint8Array(n);
  let correct = 0, evaluated = 0;
  for (let i = 0; i < n; i++) {
    let d0 = 0, d1 = 0;
    for (let c = 0; c < 3; c++) {
      const v = channels[c][i];
      d0 += (v - mean[0][c]) * (v - mean[0][c]);
      d1 += (v - mean[1][c]) * (v - mean[1][c]);
    }
    labels[i] = d1 < d0 ? 1 : 0;
    if (dist[i] < minDist || (excluded !== null && excluded[i] === 1)) continue;
    evaluated++;
    if (labels[i] === mask[i]) correct++;
  }
  return { accuracy: evaluated > 0 ? correct / evaluated : 1, evaluated, labels };
}

// Fraction of pixels that read as neon (very saturated AND very bright): the "tasteful,
// not neon" guard on washes/outlines.
export function neonFraction(r: Raster): number {
  const d = r.data;
  let neon = 0;
  const n = r.w * r.h;
  for (let p = 0; p < d.length; p += 4) {
    const max = Math.max(d[p], d[p + 1], d[p + 2]);
    if (max <= 217) continue; // v <= 0.85
    const min = Math.min(d[p], d[p + 1], d[p + 2]);
    const sat = max === 0 ? 0 : (max - min) / max;
    if (sat > 0.75) neon++;
  }
  return neon / n;
}

// Mean absolute luma gradient over interior floor pixels: how "busy" the walkable
// ground is. High-frequency noise on floors erodes the walkable read.
export function floorBusyness(luma: Float32Array, w: number, h: number, mask: Uint8Array, dist: Float32Array, minDist: number): number {
  let sum = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mask[i] !== 0 || dist[i] < minDist) continue;
      sum += Math.abs(luma[i + 1] - luma[i - 1]) / 2 + Math.abs(luma[i + w] - luma[i - w]) / 2;
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

// ---- colorblind simulation (Machado, Oliveira & Fernandes 2009, severity 1.0) ----

export type CvdKind = "protanopia" | "deuteranopia" | "tritanopia";

const CVD_MATRICES: Record<CvdKind, readonly number[]> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.303900],
};

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

export function simulateCvd(r: Raster, kind: CvdKind): Raster {
  const m = CVD_MATRICES[kind];
  const d = r.data;
  const out = new Uint8ClampedArray(d.length);
  for (let p = 0; p < d.length; p += 4) {
    const lr = SRGB_TO_LINEAR[d[p]], lg = SRGB_TO_LINEAR[d[p + 1]], lb = SRGB_TO_LINEAR[d[p + 2]];
    out[p] = linearToSrgb(m[0] * lr + m[1] * lg + m[2] * lb);
    out[p + 1] = linearToSrgb(m[3] * lr + m[4] * lg + m[5] * lb);
    out[p + 2] = linearToSrgb(m[6] * lr + m[7] * lg + m[8] * lb);
    out[p + 3] = 255;
  }
  return { w: r.w, h: r.h, data: out };
}
