import { Sprites, playerColor } from "../game/assets.js";
import { createAnim, stepAnim, characterXform, CHARACTER_STYLE } from "../game/anim.js";
import { drawLoadoutOverlays } from "../game/cosmeticArt.js";

// A small live preview of a blob's appearance (tint + cosmetic overlays) for the menu:
// the closet's mirror, the title's identity card, and the leaderboard profile view. Renders
// the REAL hero sprite through the same tint cache and overlay art the game uses, with the
// idle squash-and-stretch, so what you preview is exactly what everyone sees in a run.
//
// The canvas element is fixed-size from creation (zero layout shift while the sprite
// streams in — a placeholder disc renders until then), and the animation loop parks itself
// the moment the canvas leaves the document (menu screens swap via replaceChildren).

// The EFFECTIVE render look: callers resolve the body palette (cosmetic body item or the
// party-color fallback) into colorIndex before handing it here.
export interface BlobLook {
  colorIndex: number | null;
  hat: string | null;
  face: string | null;
}

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
}

export function createBlobPreview(initial: BlobLook, size = 96): BlobPreview {
  const el = document.createElement("canvas");
  el.width = size;
  el.height = size;
  el.className = "blob-preview";
  el.setAttribute("aria-hidden", "true");
  let look = initial;
  const anim = createAnim();
  let last = 0;
  let raf = 0;

  const draw = () => {
    const g = el.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, size, size);
    g.imageSmoothingEnabled = false;
    const xf = characterXform(anim, CHARACTER_STYLE);
    const drawSize = Math.round(size * 0.82);
    const half = drawSize / 2;
    const cx = size / 2 + xf.ox;
    const cy = size * 0.56 + xf.oy;
    g.save();
    g.translate(cx, cy);
    g.rotate(xf.rot);
    g.scale(xf.sx, xf.sy);
    const tint = look.colorIndex !== null && look.colorIndex > 0 ? playerColor(look.colorIndex) : null;
    const body = tint ? sprites().tintedHero(tint) ?? null : null;
    const plain = sprites().ready("hero") ? sprites().get("hero") : null;
    const img = body ?? plain;
    if (img) {
      g.drawImage(img, -half, -half, drawSize, drawSize);
    } else {
      // Sprite still streaming: a disc in the blob's own tint keeps the slot readable.
      g.fillStyle = tint ?? "#ffb43b";
      g.beginPath();
      g.arc(0, 0, drawSize * 0.3, 0, 6.28);
      g.fill();
    }
    g.restore();
    // The cosmetic pass goes through THE shared loadout renderer — the same code path the
    // world uses, so the mirror can never drift from what teammates see.
    drawLoadoutOverlays(g, look.hat, look.face, {
      cx: size / 2, cy: size * 0.56, sizePx: drawSize, facing: 1,
      orientation: "side", xf, isSheetPlaying: false, frameIndex: 0, alpha: 1,
    });
  };

  const tick = (now: number) => {
    raf = 0;
    if (!el.isConnected) return; // screen swapped away — park the loop
    const dt = Math.min(0.05, last > 0 ? (now - last) / 1000 : 0.016);
    last = now;
    stepAnim(anim, dt, false, 0);
    draw();
    raf = requestAnimationFrame(tick);
  };

  // First frame immediately (fixed geometry from paint one), then the idle loop once the
  // canvas is actually in the document.
  draw();
  queueMicrotask(() => {
    if (raf === 0) raf = requestAnimationFrame(tick);
  });

  return {
    el,
    setLook(next: BlobLook) {
      look = next;
      draw();
    },
  };
}
