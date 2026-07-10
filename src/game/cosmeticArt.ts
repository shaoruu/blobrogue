// The cosmetic overlay art layer. Every hat/face is a GENERATED SPRITE (public/sprites/
// cosmetics/<key>_<orientation>.png) anchored on its deterministic socket — there is no
// procedural / code-drawn cosmetic art. An overlay renders once its oriented image has
// loaded; while a file is still streaming, has failed, or the id has no asset, it renders
// NOTHING (never a fabricated placeholder — the defensive posture for ids minted by a
// newer catalog, exactly like PlayerWire.ht/fc decode).

import { COSMETIC_ASSET_SOURCES, socketFor, capCosmeticXform } from "./cosmeticSockets.js";
import type { CosmeticOrientation, SocketPoint, CosmeticXform } from "./cosmeticSockets.js";
import { COSMETICS } from "../../convex/cosmeticsCore.js";

// ---- generated-asset layer -----------------------------------------------------------
// Assets load lazily per key+orientation. A cosmetic whose assetKey has a loaded oriented
// image renders that image anchored on its socket; until then it renders nothing.

interface AssetSlot {
  img: HTMLImageElement;
  isFailed: boolean;
}

const assetCache = new Map<string, AssetSlot>();

function assetSlot(key: string, orientation: CosmeticOrientation): AssetSlot {
  const def = COSMETIC_ASSET_SOURCES[key];
  const cacheKey = `${key}|${orientation}`;
  let slot = assetCache.get(cacheKey);
  if (!slot) {
    const img = new Image();
    slot = { img, isFailed: false };
    img.addEventListener("error", () => { slot!.isFailed = true; });
    img.src = def.src[orientation];
    assetCache.set(cacheKey, slot);
  }
  return slot;
}

// Catalog id -> generated-asset key (built once). An id without a hook has no art.
const ASSET_KEY_BY_ID = new Map<string, string>(
  COSMETICS.filter((c) => c.assetKey !== undefined).map((c) => [c.id, c.assetKey as string]),
);

// Which ids have real art — the catalog test asserts every hat/face entry does, so a new
// overlay row can never ship invisible (body renders as tint, titles as text).
export function hasCosmeticArt(id: string): boolean {
  const key = ASSET_KEY_BY_ID.get(id);
  return key !== undefined && COSMETIC_ASSET_SOURCES[key] !== undefined;
}

// The front (down) oriented image for a cosmetic, for a static icon (the closet card
// mirror). Null while the file streams in / on failure / for an id without art, so the
// caller falls back to its glyph.
export function cosmeticIcon(id: string): CanvasImageSource | null {
  const key = ASSET_KEY_BY_ID.get(id);
  if (key === undefined || COSMETIC_ASSET_SOURCES[key] === undefined) return null;
  const slot = assetSlot(key, "down");
  if (slot.isFailed || !slot.img.complete || slot.img.naturalWidth === 0) return null;
  return slot.img;
}

// Whether the art a still-frame needs for this loadout has stopped streaming: every
// referenced overlay's oriented image has SETTLED (loaded or failed) for this orientation.
// A fixed-frame surface (the closet grid thumbnail) repaints only until this flips true,
// then parks — the canvas is fixed-size, so those repaints are zero layout shift. A live
// surface (the world, the animated mirror) ignores this: it already repaints every frame.
// Ids without art never gate (they render nothing by contract). Requesting a slot here also
// kicks off its lazy load, exactly like the first draw would.
export function isLoadoutArtSettled(
  hat: string | null,
  face: string | null,
  orientation: CosmeticOrientation,
): boolean {
  for (const id of [face, hat]) {
    if (id === null) continue;
    const key = ASSET_KEY_BY_ID.get(id);
    if (key === undefined || COSMETIC_ASSET_SOURCES[key] === undefined) continue;
    const slot = assetSlot(key, orientation);
    if (!slot.isFailed && !(slot.img.complete && slot.img.naturalWidth > 0)) return false;
  }
  return true;
}

// The drawable overlay for a cosmetic: its generated asset centered on the deterministic
// socket for the given orientation/frame, or null when the id has no art, the image has
// not loaded, or the socket is invisible for this facing (a face on the back of the head).
export interface OverlayResolved {
  source: CanvasImageSource;
  socket: SocketPoint;
  sizePx: number;
}

export function resolveOverlay(
  id: string,
  orientation: CosmeticOrientation,
  frameIndex: number,
): OverlayResolved | null {
  const key = ASSET_KEY_BY_ID.get(id);
  if (key === undefined || COSMETIC_ASSET_SOURCES[key] === undefined) return null;
  const def = COSMETIC_ASSET_SOURCES[key];
  const slot = assetSlot(key, orientation);
  if (slot.isFailed || !slot.img.complete || slot.img.naturalWidth === 0) return null;
  const socket = socketFor(def.socket, orientation, frameIndex);
  if (!socket.isVisible) return null;
  return { source: slot.img, socket, sizePx: def.sizePx };
}

// ---- THE shared loadout renderer ----------------------------------------------------------
// Every surface that draws a blob's worn cosmetics — the world (self + teammates), the menu
// previews, the profile stages, the closet mirror — goes through THIS one function, so the
// look can never drift between surfaces. It owns the capped transform, the orientation
// resolution, and the socket draw math.

export interface LoadoutDrawOpts {
  cx: number;
  cy: number;
  sizePx: number;               // the body sprite's drawn size (64px frame scaled)
  facing: number;               // 1 right / -1 left (mirrors the side-authored orientation)
  orientation: CosmeticOrientation;
  xf: CosmeticXform;            // the BODY transform; capped internally for the cosmetic pass
  isSheetPlaying: boolean;      // frame sheets bake the deform — neutralize procedural scale
  frameIndex: number;           // the body sheet's current frame (socket anchors track it)
  alpha: number;
}

export function drawLoadoutOverlays(
  ctx: CanvasRenderingContext2D,
  hat: string | null,
  face: string | null,
  o: LoadoutDrawOpts,
): void {
  if (hat === null && face === null) return;
  const capped = capCosmeticXform(o.xf);
  const scale = o.sizePx / 64; // frame space -> drawn px
  ctx.save();
  ctx.globalAlpha = o.alpha;
  ctx.translate(o.cx + capped.ox, o.cy + capped.oy);
  ctx.rotate(capped.rot);
  ctx.scale(o.isSheetPlaying ? o.facing : o.facing * capped.sx, o.isSheetPlaying ? 1 : capped.sy);
  for (const id of [face, hat]) {
    if (id === null) continue;
    const overlay = resolveOverlay(id, o.orientation, o.frameIndex);
    if (!overlay) continue;
    const drawSize = overlay.sizePx * scale;
    const sx = (overlay.socket.x - 32) * scale;
    const sy = (overlay.socket.y - 32) * scale;
    ctx.drawImage(overlay.source, sx - drawSize / 2, sy - drawSize / 2, drawSize, drawSize);
  }
  ctx.restore();
}
