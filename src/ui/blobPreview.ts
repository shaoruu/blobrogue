import { Sprites, playerColor, heroBodySprite } from "../game/assets.js";
import { createAnim, stepAnim, characterXform, CHARACTER_STYLE } from "../game/anim.js";
import { drawLoadoutOverlays, isLoadoutArtSettled } from "../game/cosmeticArt.js";
import type { CosmeticXform } from "../game/cosmeticSockets.js";
import { drawPetFrame } from "../game/petRenderer.js";
import { petSpriteFor } from "../game/pets.js";

// A small live preview of a blob's appearance (tint + cosmetic overlays) for the menu:
// the closet's mirror, the title's character stage, and the leaderboard profile view.
// Renders the REAL hero sprite through the same tint cache and overlay art the game uses,
// with the idle squash-and-stretch, so what you preview is exactly what everyone sees in
// a run.
//
// The canvas element is fixed-size from creation (zero layout shift while the sprite
// streams in — a static default-blob silhouette renders until then, never an empty box).
// The animation loop is the in-game idle clip (stepAnim/characterXform — no bespoke
// tween) and runs via requestAnimationFrame only while the preview is actually visible:
// it parks when the canvas leaves the document (screens swap via replaceChildren), when
// the host pauses it (title hidden, overlay open), when the tab hides (visibilitychange),
// and permanently under prefers-reduced-motion (a static idle frame stands instead).

// The EFFECTIVE render look: callers resolve the body palette (cosmetic body item or the
// party-color fallback) into colorIndex before handing it here.
export interface BlobLook {
  colorIndex: number | null;
  hat: string | null;
  face: string | null;
}

// The title stage's CALM idle: on top of the breathe, an occasional blink (eyelids in the
// body tint, drawn under any glasses) and a small wave-tilt. Deliberately quiet — no VFX,
// no glow, motion within the cosmetic transform caps so equipped items follow readably
// and can never outshout the Play actions.
export interface BlobPreviewOptions {
  isCalmIdle?: boolean;
}

const BLINK_SECONDS = 0.14;
const WAVE_SECONDS = 0.8;
const WAVE_ROT = 0.05; // radians — under COSMETIC_ROT_CAP, so hats ride along exactly

// The hero's eye bars in 64px frame space (the same eye line the cosmetic face socket
// anchors on — see src/game/cosmeticSockets.ts SOCKETS face entries).
const EYES: ReadonlyArray<{ x: number; y: number; w: number; h: number }> = [
  { x: 19, y: 27, w: 9, h: 9 },
  { x: 37, y: 27, w: 9, h: 9 },
];

// One shared sprite loader for every preview (the browser cache makes this free once the
// game itself has booted at least one run).
let sharedSprites: Sprites | null = null;
function sprites(): Sprites {
  if (!sharedSprites) sharedSprites = new Sprites();
  return sharedSprites;
}

// The blob's default amber body tint (party-color slot 0): the fallback body fill when no
// palette tint applies, and the color the momentary blink eyelids borrow.
const DEFAULT_BLOB_COLOR = "#ffb43b";

// The still (untransformed) body pose — the static default a fixed-frame surface (a closet
// grid thumbnail) draws with, no idle deform.
const IDLE_XFORM: CosmeticXform = { ox: 0, oy: 0, sx: 1, sy: 1, rot: 0 };

// How a blob is drawn into a canvas: the anchor + drawn body size, an optional body
// transform (the live idle deform; identity for a static thumbnail), and an optional
// body-space pass drawn BETWEEN the body and its cosmetics (the calm-idle blink eyelids).
export interface DrawBlobOpts {
  cx: number;
  cy: number;
  size: number;
  xf?: CosmeticXform;
  afterBody?: (ctx: CanvasRenderingContext2D, drawSize: number, bodyColor: string) => void;
}

// THE one blob still-frame draw path: the tinted hero base (bald under any hat, the classic
// cowboy with none) plus its cosmetics through the shared loadout renderer at side
// orientation — the exact composite the world and the big preview render. Every surface that
// shows a blob (the big mirror AND each closet grid thumbnail) goes through here, so a card
// can never drift from what a player actually wears. While a sprite streams in, the body
// falls back to a tinted disc and a not-yet-loaded cosmetic simply doesn't draw (never a
// fabricated placeholder); isBlobReady is the repaint-until-ready signal for still surfaces.
export function drawBlob(ctx: CanvasRenderingContext2D, look: BlobLook, o: DrawBlobOpts): void {
  const xf = o.xf ?? IDLE_XFORM;
  const half = o.size / 2;
  const tint = look.colorIndex !== null && look.colorIndex > 0 ? playerColor(look.colorIndex) : null;
  const bodyColor = tint ?? DEFAULT_BLOB_COLOR;
  ctx.imageSmoothingEnabled = false;
  ctx.save();
  ctx.translate(o.cx + xf.ox, o.cy + xf.oy);
  ctx.rotate(xf.rot);
  ctx.scale(xf.sx, xf.sy);
  // A hatted blob draws from the bald base so the equipped hat replaces the baked cowboy hat
  // (exactly as the world renders it); a bare-headed blob keeps the classic hatted hero.
  const base = heroBodySprite(look.hat);
  const body = tint ? sprites().tintedSprite(base, tint) ?? null : null;
  const plain = sprites().ready(base) ? sprites().get(base) : null;
  const img = body ?? plain;
  if (img) {
    ctx.drawImage(img, -half, -half, o.size, o.size);
    o.afterBody?.(ctx, o.size, bodyColor);
  } else {
    // Sprite still streaming: a disc in the blob's own tint keeps the slot readable.
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.arc(0, 0, o.size * 0.3, 0, 6.28);
    ctx.fill();
  }
  ctx.restore();
  drawLoadoutOverlays(ctx, look.hat, look.face, {
    cx: o.cx, cy: o.cy, sizePx: o.size, facing: 1,
    orientation: "side", xf, isSheetPlaying: false, frameIndex: 0, alpha: 1,
  });
}

// Whether every sprite drawBlob needs for this look has SETTLED (loaded or failed): the
// body base and each equipped cosmetic's side-oriented art. A fixed-frame surface (a closet
// thumbnail) uses this to repaint once — and only until — its art has settled (the canvas is
// fixed-size, so the repaint is zero layout shift), then parks; a failed sprite still counts
// as settled, so the loop never spins on missing art (drawBlob's disc/no-overlay fallback
// simply stands). The overlay-load check lives in cosmeticArt so this surface keeps no
// private overlay resolution.
export function isBlobReady(look: BlobLook): boolean {
  if (!sprites().get(heroBodySprite(look.hat)).complete) return false;
  return isLoadoutArtSettled(look.hat, look.face, "side");
}

export interface BlobPreview {
  el: HTMLCanvasElement;
  setLook(look: BlobLook): void;
  // Host-driven pause: the menu parks the loop while the title is hidden (in-run) or an
  // overlay covers it. setLook still repaints a static frame while paused.
  setPaused(isPaused: boolean): void;
}

export interface LoadoutPreview {
  el: HTMLCanvasElement;
  setLoadout(look: BlobLook, petId: string | null): void;
  setPaused(isPaused: boolean): void;
  dispose(): void;
}

export function createPetThumbnail(petId: string, size = 60): HTMLCanvasElement {
  const el = document.createElement("canvas");
  el.width = size;
  el.height = size;
  el.className = "pet-card-thumb";
  el.setAttribute("aria-hidden", "true");
  const sprite = petSpriteFor(petId);
  const draw = () => {
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, size, size);
    drawPetFrame(ctx, sprites(), {
      petId,
      clip: "idle",
      cx: size / 2,
      cy: size / 2,
      size: Math.round(size * 0.88),
      facing: 1,
      xform: { ox: 0, oy: 0, sx: 1, sy: 1, rot: 0 },
      clock: 0,
    });
  };
  const settle = () => {
    draw();
    if (el.isConnected && sprite !== null && !sprites().isSpriteSettled(sprite)) {
      requestAnimationFrame(settle);
    }
  };
  draw();
  queueMicrotask(settle);
  return el;
}

export function createBlobPreview(initial: BlobLook, size = 96, opts: BlobPreviewOptions = {}): BlobPreview {
  const el = document.createElement("canvas");
  // Canvas dimensions are set BEFORE any render — the box is fixed from first paint.
  el.width = size;
  el.height = size;
  el.className = "blob-preview";
  el.setAttribute("aria-hidden", "true");
  let look = initial;
  const anim = createAnim();
  let last = 0;
  let raf = 0;
  let isPausedByHost = false;
  // prefers-reduced-motion holds a static idle frame: draw once (and on every setLook),
  // never run the animation loop.
  const isReducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  // The calm-idle gesture clock (seconds of preview time). Blinks and waves are scheduled
  // sparsely at randomized intervals — alive, never busy.
  let clock = 0;
  let blinkUntil = -1;
  let nextBlinkAt = 2 + Math.random() * 4;
  let waveUntil = -1;
  let nextWaveAt = 6 + Math.random() * 6;

  const draw = () => {
    const g = el.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, size, size);
    const xf = characterXform(anim, CHARACTER_STYLE);
    const isWaving = opts.isCalmIdle === true && clock < waveUntil;
    const gestureRot = isWaving ? Math.sin((waveUntil - clock) * (Math.PI * 4 / WAVE_SECONDS)) * WAVE_ROT : 0;
    // The idle deform carries the wave tilt into the body rotation; drawBlob feeds the same
    // transform to the shared loadout renderer (capped inside), so hats follow the gesture.
    const bodyXf: CosmeticXform = { ox: xf.ox, oy: xf.oy, sx: xf.sx, sy: xf.sy, rot: xf.rot + gestureRot };
    const isBlinking = opts.isCalmIdle === true && clock < blinkUntil;
    drawBlob(g, look, {
      cx: size / 2, cy: size * 0.56, size: Math.round(size * 0.82), xf: bodyXf,
      // Blink: momentary eyelids in the body tint, under any face overlay drawn after.
      afterBody: isBlinking
        ? (bg, drawSize, bodyColor) => {
            const s = drawSize / 64;
            bg.fillStyle = bodyColor;
            for (const eye of EYES) bg.fillRect((eye.x - 32) * s, (eye.y - 32) * s, eye.w * s, eye.h * s);
          }
        : undefined,
    });
  };

  // The loop runs ONLY while the preview can actually be seen: the canvas is in the
  // document, the host hasn't paused it (title hidden / overlay open), the tab is
  // visible, and the player hasn't asked for reduced motion.
  const isRunnable = () => el.isConnected && !isPausedByHost && document.hidden !== true && !isReducedMotion;

  const schedule = () => {
    if (raf === 0 && isRunnable()) raf = requestAnimationFrame(tick);
  };

  const tick = (now: number) => {
    raf = 0;
    if (!isRunnable()) { last = 0; return; } // parked; schedule()/visibility resumes
    const dt = Math.min(0.05, last > 0 ? (now - last) / 1000 : 0.016);
    last = now;
    stepAnim(anim, dt, false, 0);
    if (opts.isCalmIdle === true) {
      clock += dt;
      if (clock >= nextBlinkAt) {
        blinkUntil = clock + BLINK_SECONDS;
        nextBlinkAt = clock + 2.5 + Math.random() * 3.5;
      }
      if (clock >= nextWaveAt) {
        waveUntil = clock + WAVE_SECONDS;
        nextWaveAt = clock + 8 + Math.random() * 6;
      }
    }
    draw();
    schedule();
  };

  // Tab visibility gates the loop too; the listener retires itself once the canvas has
  // left the document (screens swap via replaceChildren, so previews are per-screen).
  const onVisibility = () => {
    if (!el.isConnected) { document.removeEventListener("visibilitychange", onVisibility); return; }
    if (document.hidden === true) { cancelAnimationFrame(raf); raf = 0; last = 0; }
    else schedule();
  };
  document.addEventListener("visibilitychange", onVisibility);

  // First frame immediately (fixed geometry from paint one — a static idle frame even
  // under reduced motion), then the loop once the canvas is actually in the document.
  draw();
  queueMicrotask(schedule);

  return {
    el,
    setLook(next: BlobLook) {
      look = next;
      draw();
    },
    setPaused(isPaused: boolean) {
      isPausedByHost = isPaused;
      if (isPaused) { cancelAnimationFrame(raf); raf = 0; last = 0; }
      else schedule();
    },
  };
}

export function createLoadoutPreview(
  initialLook: BlobLook,
  initialPetId: string | null,
  width = 220,
  height = 300,
): LoadoutPreview {
  const el = document.createElement("canvas");
  el.width = width;
  el.height = height;
  el.className = "loadout-preview-canvas";
  el.setAttribute("aria-hidden", "true");
  let look = initialLook;
  let petId = initialPetId;
  let raf = 0;
  let last = 0;
  let clock = 0;
  let isPaused = false;
  let isDisposed = false;
  const blobAnim = createAnim();
  const petAnim = createAnim();
  const isReducedMotion = typeof matchMedia === "function"
    && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const draw = () => {
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = false;
    const isTrotting = !isReducedMotion && clock % 5 < 1.4;
    const blobXform = characterXform(blobAnim, CHARACTER_STYLE);
    drawBlob(ctx, look, {
      cx: width * 0.43,
      cy: height * 0.5,
      size: Math.min(124, width * 0.58),
      xf: blobXform,
    });
    if (petId !== null) {
      const petXform = characterXform(petAnim, CHARACTER_STYLE);
      const trotOffset = isTrotting ? Math.sin(clock * 5) * 10 : 0;
      drawPetFrame(ctx, sprites(), {
        petId,
        clip: isTrotting ? "walk" : "idle",
        cx: width * 0.76 + trotOffset,
        cy: height * 0.64,
        size: Math.min(58, width * 0.27),
        facing: isTrotting && Math.cos(clock * 5) < 0 ? -1 : 1,
        xform: petXform,
        clock: petAnim.clock,
      });
    }
  };

  const isSettled = () => {
    const petSprite = petId === null ? null : petSpriteFor(petId);
    return isBlobReady(look)
      && (petSprite === null || sprites().isSpriteSettled(petSprite));
  };

  const isRunnable = () => !isDisposed
    && el.isConnected
    && !isPaused
    && document.hidden !== true
    && (!isReducedMotion || !isSettled());

  const schedule = () => {
    if (raf === 0 && isRunnable()) raf = requestAnimationFrame(tick);
  };

  const tick = (now: number) => {
    raf = 0;
    if (!isRunnable()) { last = 0; return; }
    const dt = Math.min(0.05, last > 0 ? (now - last) / 1000 : 0.016);
    last = now;
    if (!isReducedMotion) {
      clock += dt;
      const isTrotting = clock % 5 < 1.4;
      stepAnim(blobAnim, dt, false, 0);
      stepAnim(petAnim, dt, isTrotting, isTrotting ? 0.4 : 0);
    }
    draw();
    schedule();
  };

  const onVisibility = () => {
    if (!el.isConnected) {
      document.removeEventListener("visibilitychange", onVisibility);
      return;
    }
    if (document.hidden === true) {
      cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
    } else {
      schedule();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  draw();
  queueMicrotask(schedule);

  return {
    el,
    setLoadout(nextLook, nextPetId) {
      look = nextLook;
      petId = nextPetId;
      draw();
      schedule();
    },
    setPaused(nextIsPaused) {
      isPaused = nextIsPaused;
      if (isPaused) {
        cancelAnimationFrame(raf);
        raf = 0;
        last = 0;
      } else {
        schedule();
      }
    },
    dispose() {
      isDisposed = true;
      cancelAnimationFrame(raf);
      raf = 0;
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
