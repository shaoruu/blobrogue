import { Sprites, playerColor } from "../game/assets.js";
import { createAnim, stepAnim, characterXform, CHARACTER_STYLE } from "../game/anim.js";
import { drawLoadoutOverlays } from "../game/cosmeticArt.js";
import type { CosmeticXform } from "../game/cosmeticSockets.js";

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

// The hero's eye bars in 64px frame space (the same measurements the cosmetic face
// overlays anchor on — see src/game/cosmeticArt.ts lens positions).
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

export interface BlobPreview {
  el: HTMLCanvasElement;
  setLook(look: BlobLook): void;
  // Host-driven pause: the menu parks the loop while the title is hidden (in-run) or an
  // overlay covers it. setLook still repaints a static frame while paused.
  setPaused(isPaused: boolean): void;
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
    g.imageSmoothingEnabled = false;
    const xf = characterXform(anim, CHARACTER_STYLE);
    const isWaving = opts.isCalmIdle === true && clock < waveUntil;
    const gestureRot = isWaving ? Math.sin((waveUntil - clock) * (Math.PI * 4 / WAVE_SECONDS)) * WAVE_ROT : 0;
    const drawSize = Math.round(size * 0.82);
    const half = drawSize / 2;
    const cx = size / 2 + xf.ox;
    const cy = size * 0.56 + xf.oy;
    g.save();
    g.translate(cx, cy);
    g.rotate(xf.rot + gestureRot);
    g.scale(xf.sx, xf.sy);
    const tint = look.colorIndex !== null && look.colorIndex > 0 ? playerColor(look.colorIndex) : null;
    const body = tint ? sprites().tintedHero(tint) ?? null : null;
    const plain = sprites().ready("hero") ? sprites().get("hero") : null;
    const img = body ?? plain;
    if (img) {
      g.drawImage(img, -half, -half, drawSize, drawSize);
      // Blink: momentary eyelids in the body tint, under any face overlay drawn after.
      if (opts.isCalmIdle === true && clock < blinkUntil) {
        const s = drawSize / 64;
        g.fillStyle = tint ?? "#ffb43b";
        for (const eye of EYES) g.fillRect((eye.x - 32) * s, (eye.y - 32) * s, eye.w * s, eye.h * s);
      }
    } else {
      // Sprite still streaming: a disc in the blob's own tint keeps the slot readable.
      g.fillStyle = tint ?? "#ffb43b";
      g.beginPath();
      g.arc(0, 0, drawSize * 0.3, 0, 6.28);
      g.fill();
    }
    g.restore();
    // The cosmetic pass goes through THE shared loadout renderer — the same code path the
    // world uses, so the mirror can never drift from what teammates see. The wave tilt
    // rides the transform (capped inside), so hats follow the gesture.
    const cosmeticXf: CosmeticXform = { ox: xf.ox, oy: xf.oy, sx: xf.sx, sy: xf.sy, rot: xf.rot + gestureRot };
    drawLoadoutOverlays(g, look.hat, look.face, {
      cx: size / 2, cy: size * 0.56, sizePx: drawSize, facing: 1,
      orientation: "side", xf: cosmeticXf, isSheetPlaying: false, frameIndex: 0, alpha: 1,
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
