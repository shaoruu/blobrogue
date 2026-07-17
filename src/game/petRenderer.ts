import { FRAME, Sprites } from "./assets.js";
import { frameCount, frameIndex, oneShotFrameIndex } from "./anim.js";
import type { Xform } from "./anim.js";
import { petSpriteFor } from "./pets.js";

export const PET_RENDER_SIZE = 34;

// The three pet render clips. "attack" is a purely cosmetic one-shot emote beat (owner fires /
// pet reacts) — NEVER combat; pets are out of the sim entirely. It is a subset of the engine's
// SheetClip so pet sheets register under the same `${sprite}.${clip}` contract as everyone else.
export type PetClip = "idle" | "walk" | "attack";

// The graceful clip ladder for a pet (pure, so it is unit-testable on its own): the requested
// clip when its sheet is LOADED, otherwise a missing ATTACK strip degrades to the motion clip
// (walk while trotting, idle while settled) so the emote never blanks the pet. A missing
// walk/idle sheet is left as-is here and the draw path falls to the static base + procedural
// juice — so an unknown/absent attack sheet can never crash or freeze a pet.
export function resolvePetClip(
  requested: PetClip,
  isMoving: boolean,
  isClipLoaded: (clip: PetClip) => boolean,
): PetClip {
  if (isClipLoaded(requested)) return requested;
  if (requested === "attack") return isMoving ? "walk" : "idle";
  return requested;
}

export interface DrawPetFrameOptions {
  petId: string;
  // Whether the pet is trotting (drives walk vs idle, and the attack-fallback motion clip).
  isMoving: boolean;
  // While the attack emote plays: 0..1 progress through the one-shot beat (the attack strip
  // plays through exactly once, clamping on its last frame). null when not emoting.
  emoteProgress: number | null;
  cx: number;
  cy: number;
  size: number;
  facing: number;
  xform: Xform;
  clock: number;
}

export function drawPetFrame(
  ctx: CanvasRenderingContext2D,
  sprites: Sprites,
  options: DrawPetFrameOptions,
): void {
  const sprite = petSpriteFor(options.petId);
  if (sprite === null) return;
  const isEmoting = options.emoteProgress !== null;
  const requested: PetClip = isEmoting ? "attack" : options.isMoving ? "walk" : "idle";
  const clip = resolvePetClip(requested, options.isMoving, (c) => sprites.sheet(sprite, c) !== null);
  const sheet = sprites.sheet(sprite, clip);
  if (!sheet && !sprites.ready(sprite)) {
    ctx.save();
    ctx.fillStyle = "#a855f7";
    ctx.beginPath();
    ctx.arc(options.cx, options.cy, options.size * 0.34, 0, 6.28);
    ctx.fill();
    ctx.restore();
    return;
  }
  const half = options.size / 2;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(options.cx + options.xform.ox, options.cy + options.xform.oy);
  ctx.rotate(options.xform.rot);
  ctx.scale(
    sheet ? options.facing : options.facing * options.xform.sx,
    sheet ? 1 : options.xform.sy,
  );
  if (sheet) {
    const frameWidth = sheet.img.naturalHeight || FRAME;
    const count = frameCount(sheet.img.naturalWidth, sheet.img.naturalHeight);
    // A played-once attack beat maps its progress across the strip and holds the last frame;
    // every other clip loops off the shared clock.
    const index = clip === "attack" && options.emoteProgress !== null
      ? oneShotFrameIndex(count, options.emoteProgress)
      : frameIndex(count, sheet.fps, options.clock);
    ctx.drawImage(
      sheet.img,
      index * frameWidth,
      0,
      frameWidth,
      frameWidth,
      -half,
      -half,
      options.size,
      options.size,
    );
  } else {
    ctx.drawImage(sprites.get(sprite), -half, -half, options.size, options.size);
  }
  ctx.restore();
}
