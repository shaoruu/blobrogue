// Dev-only catalog thumbnails for the creative-mode panel (?dev=1). Every spawnable entry
// gets a small, crisp, fixed-size canvas showing EXACTLY what the game renders: enemies and
// pets resolve through the shared Sprites clip ladder (walk-down frame 0 at rest — the same
// pick the world shows the instant a body is placed), cosmetics through the shared blob
// compositor. A thumbnail repaints only until its art has SETTLED (loaded or failed) then
// parks — the canvas is sized from creation, so those repaints are zero layout shift, and a
// missing sprite degrades to a blank slot (never a broken image). Abstract entries with no
// art (kits/mutators/affixes) use a text badge instead; nothing here fabricates a sprite.

import type { Sprites } from "../game/assets.js";
import type { SpriteName } from "../sim/types.js";
import type { EnemyPose } from "../game/facing.js";
import { drawBlob, isBlobReady } from "../ui/blobPreview.js";
import type { BlobLook } from "../ui/blobPreview.js";

export const THUMB_PX = 40;

// The pose a freshly-placed body holds: standing still, facing down — frame 0 of walk_down
// (the idle pose the world renders before the enemy moves), matching devSpawnEnemies' feel.
const REST_POSE: EnemyPose = {
  facing: "down", isMirrored: false, verticalFacing: "down",
  isMoving: false, isAttacking: false,
  move: "none", phase: "none", windup: 0, aimAngle: Math.PI / 2,
};

// One shared repaint pump for every live thumbnail: each pending paint() reports whether its
// art has settled; the pump drops the settled ones and stops once none remain. A paint is
// tracked at most once (dedup by reference) so an updatable preview can re-arm the loop by
// simply calling track again with the same closure.
let pending: Array<() => boolean> = [];
let raf = 0;
function pump(): void {
  raf = 0;
  pending = pending.filter((paint) => !paint());
  if (pending.length > 0) raf = requestAnimationFrame(pump);
}
function track(paint: () => boolean): void {
  if (paint()) return;
  if (!pending.includes(paint)) pending.push(paint);
  if (raf === 0) raf = requestAnimationFrame(pump);
}

function makeCanvas(size: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  c.className = "dev-thumb";
  return c;
}

// Frame 0 of a horizontal sprite strip drawn to fill a square box, nearest-neighbour so the
// pixel art stays crisp. Static square bases are a one-frame strip, so this path serves both.
function drawFrame0(ctx: CanvasRenderingContext2D, img: HTMLImageElement, size: number, isMirrored: boolean): void {
  const fw = img.naturalHeight || 64;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (isMirrored) { ctx.translate(size, 0); ctx.scale(-1, 1); }
  ctx.drawImage(img, 0, 0, fw, fw, 0, 0, size, size);
  ctx.restore();
}

export interface SpritePreview {
  el: HTMLCanvasElement;
  setSprite(name: SpriteName | null): void;
}

// An updatable sprite thumbnail: shows frame 0 of a body's resting clip, resolved through the
// game's own clip ladder so it matches the world. setSprite(null) clears it (a blank slot).
export function spritePreview(sprites: Sprites, size = THUMB_PX): SpritePreview {
  const el = makeCanvas(size);
  const ctx = el.getContext("2d");
  let name: SpriteName | null = null;
  const paint = (): boolean => {
    if (!ctx) return true;
    ctx.clearRect(0, 0, size, size);
    if (name === null) return true;
    const choice = sprites.selectClip(name, REST_POSE);
    const sheet = sprites.sheet(name, choice.clip);
    if (sheet) drawFrame0(ctx, sheet.img, size, choice.isMirrored);
    else if (sprites.ready(name)) drawFrame0(ctx, sprites.get(name), size, false);
    return sprites.isSpriteSettled(name);
  };
  track(paint);
  return {
    el,
    setSprite(next: SpriteName | null) { name = next; track(paint); },
  };
}

// A fixed sprite thumbnail (the common case: one entry, one sprite).
export function spriteThumb(sprites: Sprites, name: SpriteName, size = THUMB_PX): HTMLCanvasElement {
  const p = spritePreview(sprites, size);
  p.setSprite(name);
  return p.el;
}

export interface BlobPreview {
  el: HTMLCanvasElement;
  setLook(look: BlobLook): void;
}

// An updatable composited-blob thumbnail (tint + hat + face) through THE shared blob renderer
// every menu surface uses, so the panel look can never drift from an in-world equip.
export function blobPreview(size = THUMB_PX): BlobPreview {
  const el = makeCanvas(size);
  const ctx = el.getContext("2d");
  let look: BlobLook = { colorIndex: null, hat: null, face: null };
  const paint = (): boolean => {
    if (!ctx) return true;
    ctx.clearRect(0, 0, size, size);
    drawBlob(ctx, look, { cx: size / 2, cy: size * 0.58, size: Math.round(size * 0.82) });
    return isBlobReady(look);
  };
  track(paint);
  return {
    el,
    setLook(next: BlobLook) { look = next; track(paint); },
  };
}

// A fixed composited-blob thumbnail for a catalog cell.
export function blobThumb(look: BlobLook, size = THUMB_PX): HTMLCanvasElement {
  const p = blobPreview(size);
  p.setLook(look);
  return p.el;
}

// A blank thumbnail box — the "None" slot and the graceful fallback for an abstract entry
// with no art (never a broken image).
export function blankThumb(size = THUMB_PX): HTMLCanvasElement {
  return makeCanvas(size);
}

// A monogram text badge — the sanctioned fallback for abstract entries (kits/mutators/affixes)
// that have no sprite. Two letters, derived from the entry's name; never a fabricated sprite.
export function textBadge(label: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "dev-badge";
  const words = label.trim().split(/\s+/);
  el.textContent = (words.length >= 2 ? words[0][0] + words[1][0] : label.slice(0, 2)).toUpperCase();
  return el;
}
