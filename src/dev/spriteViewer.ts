// ?dev=sprites — the sprite / animation viewer. Lists every registered sprite and draws
// it; for the walk/death spritesheets it plays the clip frame-by-frame at its real fps
// with a live frame counter, and an "audit frames" button flags any degenerate frame
// (empty, or a skinny bbox outlier) — the visual mirror of tools/audit-sprites.py, i.e.
// exactly where the "skinny slime frame" bug would jump out.

import { devSpriteManifest, devSheetManifest } from "../game/assets.js";
import type { DevSheetEntry } from "../game/assets.js";
import { injectDevStyles } from "./styles.js";

const OPAQUE_ALPHA = 40;     // matches audit-sprites.py: pixels with a>40 count as opaque
const SKINNY_RATIO = 0.45;   // walk frame flagged if bbox width < 45% of the sibling median

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src;
  });
}

interface FrameStats { width: number; opaque: number; }

// Opaque bounding-box width + pixel count for one square frame of a sheet.
function frameStats(scratch: HTMLCanvasElement, img: HTMLImageElement, frameH: number, index: number): FrameStats {
  scratch.width = frameH;
  scratch.height = frameH;
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { width: 0, opaque: 0 };
  ctx.clearRect(0, 0, frameH, frameH);
  ctx.drawImage(img, index * frameH, 0, frameH, frameH, 0, 0, frameH, frameH);
  const data = ctx.getImageData(0, 0, frameH, frameH).data;
  let minX = frameH, maxX = -1, opaque = 0;
  for (let y = 0; y < frameH; y++) {
    for (let x = 0; x < frameH; x++) {
      if (data[(y * frameH + x) * 4 + 3] > OPAQUE_ALPHA) {
        opaque++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  return { width: maxX >= minX ? maxX - minX + 1 : 0, opaque };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

// The same rule tools/audit-sprites.py applies: flag empty frames anywhere, and (walk
// sheets only) any frame whose bbox width is a wild outlier vs its siblings.
function auditSheet(key: string, stats: FrameStats[]): Map<number, string> {
  const flags = new Map<number, string>();
  stats.forEach((s, i) => { if (s.opaque === 0) flags.set(i, "EMPTY"); });
  if (key.includes("walk") && stats.length >= 2) {
    const med = median(stats.map((s) => s.width));
    stats.forEach((s, i) => {
      if (med > 0 && s.width < SKINNY_RATIO * med) {
        flags.set(i, `skinny ${s.width}px vs median ${med}px`);
      }
    });
  }
  return flags;
}

interface SheetView {
  entry: DevSheetEntry;
  img: HTMLImageElement;
  frameH: number;
  count: number;
  stats: FrameStats[];
  frameCells: HTMLElement[]; // one static cell per frame (for audit flagging)
  counterEl: HTMLElement;
  animCanvas: HTMLCanvasElement;
}

function drawFrame(canvas: HTMLCanvasElement, img: HTMLImageElement, frameH: number, index: number, scale: number): void {
  canvas.width = frameH * scale;
  canvas.height = frameH * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, index * frameH, 0, frameH, frameH, 0, 0, canvas.width, canvas.height);
}

function drawWhole(canvas: HTMLCanvasElement, img: HTMLImageElement, target: number): void {
  const scale = Math.max(1, Math.round(target / Math.max(img.naturalHeight, 1)));
  canvas.width = img.naturalWidth * scale;
  canvas.height = img.naturalHeight * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
}

export async function bootSpriteViewer(): Promise<void> {
  injectDevStyles();
  const root = h("div", "dev-sprites");

  const head = h("div", "head");
  head.appendChild(h("h1", undefined, "SPRITE / ANIM VIEWER"));
  head.appendChild(h("span", "hint", "walk & death sheets play at their real fps"));
  const auditBtn = h("button", "dev-btn", "Audit frames");
  auditBtn.type = "button";
  head.appendChild(auditBtn);
  const backBtn = h("button", "dev-btn", "Back to sandbox");
  backBtn.type = "button";
  backBtn.addEventListener("click", () => { window.location.search = "?dev=1"; });
  head.appendChild(backBtn);
  root.appendChild(head);
  document.body.appendChild(root);

  const scratch = document.createElement("canvas");

  // ---- animated spritesheets ----
  root.appendChild(h("div", "dev-h", "spritesheets"));
  const sheetGrid = h("div", "dev-grid");
  root.appendChild(sheetGrid);

  const views: SheetView[] = [];
  for (const entry of devSheetManifest()) {
    let img: HTMLImageElement;
    try { img = await loadImage(entry.src); } catch { continue; }
    const frameH = img.naturalHeight || 64;
    const count = Math.max(1, Math.round(img.naturalWidth / frameH));
    const stats: FrameStats[] = [];
    for (let i = 0; i < count; i++) stats.push(frameStats(scratch, img, frameH, i));

    const cell = h("div", "dev-cell");
    const animCanvas = h("canvas");
    drawFrame(animCanvas, img, frameH, 0, 2);
    cell.appendChild(animCanvas);
    const cap = h("div", "dev-cap", entry.key);
    cap.appendChild(h("span", "meta", `${entry.fps} fps \u00b7 ${count} frames`));
    const counterEl = h("span", "frame", `frame 1/${count}`);
    cap.appendChild(counterEl);
    cell.appendChild(cap);
    sheetGrid.appendChild(cell);

    // Per-frame static strip beneath the animation, so an audit flag pins the bad frame.
    const strip = h("div", "dev-grid");
    const frameCells: HTMLElement[] = [];
    for (let i = 0; i < count; i++) {
      const fc = h("div", "dev-cell");
      const fcv = h("canvas");
      drawFrame(fcv, img, frameH, i, 1);
      fc.appendChild(fcv);
      fc.appendChild(h("div", "dev-cap", `#${i}`));
      strip.appendChild(fc);
      frameCells.push(fc);
    }
    root.appendChild(strip);

    views.push({ entry, img, frameH, count, stats, frameCells, counterEl, animCanvas });
  }

  // ---- static sprites ----
  root.appendChild(h("div", "dev-h", "static sprites"));
  const staticGrid = h("div", "dev-grid");
  root.appendChild(staticGrid);
  for (const entry of devSpriteManifest()) {
    let img: HTMLImageElement;
    try { img = await loadImage(entry.src); } catch { continue; }
    const cell = h("div", "dev-cell");
    const canvas = h("canvas");
    drawWhole(canvas, img, 96);
    cell.appendChild(canvas);
    const cap = h("div", "dev-cap", entry.label);
    cap.appendChild(h("span", "meta", `${entry.group} \u00b7 ${img.naturalWidth}\u00d7${img.naturalHeight}`));
    cell.appendChild(cap);
    staticGrid.appendChild(cell);
  }

  auditBtn.addEventListener("click", () => {
    let total = 0;
    for (const v of views) {
      const flags = auditSheet(v.entry.key, v.stats);
      v.frameCells.forEach((fc, i) => {
        const msg = flags.get(i);
        fc.classList.toggle("flag", msg !== undefined);
        const existing = fc.querySelector(".flagmsg");
        if (msg && !existing) fc.querySelector(".dev-cap")?.appendChild(h("span", "flagmsg", msg));
        else if (!msg && existing) existing.remove();
      });
      total += flags.size;
    }
    auditBtn.textContent = total === 0 ? "Audit: all clean" : `Audit: ${total} flagged`;
    auditBtn.classList.toggle("on", total > 0);
  });

  // Drive every sheet's playback from one clock so nothing drifts.
  let start = performance.now();
  const tick = (now: number) => {
    const clock = (now - start) / 1000;
    for (const v of views) {
      const index = Math.floor(clock * v.entry.fps) % v.count;
      drawFrame(v.animCanvas, v.img, v.frameH, index, 2);
      v.counterEl.textContent = `frame ${index + 1}/${v.count}`;
    }
    requestAnimationFrame(tick);
  };
  start = performance.now();
  requestAnimationFrame(tick);
}
