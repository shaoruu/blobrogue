import { FRAME, Sprites } from "./assets.js";
import type { SheetClip } from "./assets.js";
import { frameCount, frameIndex } from "./anim.js";
import type { Xform } from "./anim.js";
import { petSpriteFor } from "./pets.js";

export const PET_RENDER_SIZE = 34;

export interface DrawPetFrameOptions {
  petId: string;
  clip: Extract<SheetClip, "idle" | "walk" | "attack">;
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
  const sheet = sprites.sheet(sprite, options.clip);
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
    const index = frameIndex(count, sheet.fps, options.clock);
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
