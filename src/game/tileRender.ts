// The dungeon tile pass (floors, room flourishes, extruded walls, biome wash) extracted
// verbatim from Game.renderTiles so the exact production pixels can also be rasterized
// headlessly (test/readability.test.ts renders through this module on a skia canvas).
// The context/art parameters are minimal structural interfaces satisfied by BOTH the
// browser's CanvasRenderingContext2D/TileSet and a Node canvas + disk-backed art loader,
// so there is one renderer and the readability gates measure the real thing.

import type { Biome } from "../sim/biomes.js";
import type { Dungeon } from "../sim/dungeon.js";
import { TILE } from "../sim/types.js";
import type { TileName } from "./assets.js";

export interface TileRenderGradient {
  addColorStop(offset: number, color: string): void;
}
export interface TileRenderPattern {
  setTransform(transform?: DOMMatrix2DInit): void;
}
export type TileRenderPaint = string | TileRenderGradient | TileRenderPattern;

// The exact subset of the 2D API this pass uses — the module's render contract. Generic
// over the drawable image type so the browser context binds Img = CanvasImageSource and
// a Node skia context binds its own image/canvas classes.
export interface TileRenderContext<Img> {
  globalAlpha: number;
  globalCompositeOperation: string;
  fillStyle: TileRenderPaint;
  strokeStyle: TileRenderPaint;
  lineWidth: number;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: Img, dx: number, dy: number, dw: number, dh: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): TileRenderGradient;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): TileRenderGradient;
}

// What the pass needs from the tile art registry (TileSet satisfies this).
export interface TileArtSource<Img> {
  ready(name: TileName): boolean;
  get(name: TileName): Img;
  tinted(name: TileName, color: string): Img | null;
  biomeFloor(tileKey: string, pick: number): Img | null;
  biomeWallTop(tileKey: string): Img | null;
}

export interface TileRenderScene<Img> {
  dungeon: Dungeon;
  biome: Biome;
  biomeIdx: number;
  camX: number;
  camY: number;
  viewW: number;
  viewH: number;
  art: TileArtSource<Img>;
  wallSide: readonly [TileRenderGradient, TileRenderGradient];
  animClock: number;
}

// Walls are drawn as extruded blocks: a lit top cap, a dark front face dropping down
// toward the world floor. Side strips are precomputed gradients (built once) that fade
// inward; corners where two faces meet get an extra darken so the cube edge reads.
export const WALL_SIDE_W = 7;        // px width of an exposed side face
const WALL_SIDE_ALPHA = 0.62; // side-strip darkness at the edge

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// Stable per-tile hash -> 0..1. Salted so different features (variant vs. detail) draw
// from independent streams, and identical every frame so tiles never shimmer.
export function tileHash(x: number, y: number, salt: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(salt, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Pick a floor variant from a stable hash: mostly plain floor, others sprinkled in.
function floorVariant(r: number): TileName {
  if (r < 0.7) return "floor";
  if (r < 0.8) return "floor2";
  if (r < 0.9) return "floor3";
  return "floor4";
}

// One biome's side-face gradient pair (left edge, right edge), built once per context.
export function buildWallSideGradients<Img>(ctx: TileRenderContext<Img>, biome: Biome): [TileRenderGradient, TileRenderGradient] {
  const edge = `rgba(${biome.wallSideRgb},${WALL_SIDE_ALPHA})`;
  const inner = `rgba(${biome.wallSideRgb},0)`;
  const left = ctx.createLinearGradient(0, 0, WALL_SIDE_W, 0);
  left.addColorStop(0, edge);
  left.addColorStop(1, inner);
  const right = ctx.createLinearGradient(0, 0, WALL_SIDE_W, 0);
  right.addColorStop(0, inner);
  right.addColorStop(1, edge);
  return [left, right];
}

export function renderDungeonTiles<Img>(ctx: TileRenderContext<Img>, scene: TileRenderScene<Img>): void {
  const { dungeon: d, biome, art: tiles } = scene;
  const cam = { x: scene.camX, y: scene.camY };
  const [sideL, sideR] = scene.wallSide;
  // +1 tile of margin on each edge so the screen-shake translate never exposes bg.
  const x0 = Math.max(0, Math.floor(cam.x / TILE) - 1);
  const y0 = Math.max(0, Math.floor(cam.y / TILE) - 1);
  const x1 = Math.min(d.w, Math.ceil((cam.x + scene.viewW) / TILE) + 1);
  const y1 = Math.min(d.h, Math.ceil((cam.y + scene.viewH) / TILE) + 1);

  // Pass 1: floors (+ detail overlay at the biome's density + cast shadow under walls).
  // Dedicated per-biome floor art (BIOME_TILE_SOURCES) wins when registered; otherwise
  // the shared set carries the biome through the grade below.
  const detailDensity = biome.detailDensity;
  for (let ty = y0; ty < y1; ty++) {
    for (let tx = x0; tx < x1; tx++) {
      if (d.tiles[ty * d.w + tx] !== 0) continue;
      const sx = tx * TILE - cam.x, sy = ty * TILE - cam.y;
      const vHash = tileHash(tx, ty, 1);
      const biomeArt = tiles.biomeFloor(biome.tileKey, Math.floor(vHash * 61));
      if (biomeArt) {
        ctx.drawImage(biomeArt, sx, sy, TILE, TILE);
      } else if (tiles.ready(floorVariant(vHash))) {
        ctx.drawImage(tiles.get(floorVariant(vHash)), sx, sy, TILE, TILE);
      } else {
        ctx.fillStyle = (tx + ty) % 2 === 0 ? biome.floorA : biome.floorB;
        ctx.fillRect(sx, sy, TILE, TILE);
      }
      // Structural value hierarchy: floor material stays quieter/darker than wall caps.
      // The biome wash later shifts hue across both, so this per-floor dim preserves a
      // grayscale walkable-vs-solid distinction independent of palette. Alpha is biome
      // data, calibrated per band against its authored art (see Biome.floorDim).
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = biome.floorDim;
      ctx.fillStyle = "#05030b";
      ctx.fillRect(sx, sy, TILE, TILE);
      ctx.restore();
      const rd = tileHash(tx, ty, 2);
      if (rd < detailDensity) {
        const t = rd / detailDensity;
        // Built-dungeon grates only suit the built bands (the Archive's order, the Ember
        // works); the living and wrong places crack and grow instead.
        const hasGrates = scene.biomeIdx === 4 || scene.biomeIdx === 5;
        const detail: TileName = t < 0.33 ? "floor_crack" : t < 0.66 ? (hasGrates ? "floor_grate" : "floor_crack") : "floor_moss";
        if (tiles.ready(detail)) {
          ctx.drawImage(tiles.get(detail), sx, sy, TILE, TILE);
          // Deep biomes recolor their growth dressing (frost lichen, ember-lit cracks,
          // void bloom): the tinted silhouette blends OVER the original at partial
          // alpha, so the art keeps its texture and only the hue shifts.
          if (biome.detailTint && detail === "floor_moss") {
            const tinted = tiles.tinted(detail, biome.detailTint);
            if (tinted) {
              ctx.save();
              ctx.globalAlpha = 0.45;
              ctx.drawImage(tinted, sx, sy, TILE, TILE);
              ctx.restore();
            }
          }
        }
      }
      // A wall directly above casts a shadow onto this floor tile — sells the height.
      const wallN = ty > 0 && d.tiles[(ty - 1) * d.w + tx] === 1;
      const wallS = ty + 1 < d.h && d.tiles[(ty + 1) * d.w + tx] === 1;
      const wallW = tx > 0 && d.tiles[ty * d.w + tx - 1] === 1;
      const wallE = tx + 1 < d.w && d.tiles[ty * d.w + tx + 1] === 1;
      if (wallN && tiles.ready("wall_shadow")) {
        ctx.drawImage(tiles.get("wall_shadow"), sx, sy, TILE, TILE);
      }
      // Walkability outline: trace the exact floor/wall collision boundary ON the floor
      // side. This is structural navigation guidance, visible in grayscale and blur, so
      // it draws ABOVE the cast shadow — under it, every north boundary loses its line.
      if (wallN || wallS || wallW || wallE) {
        ctx.save();
        ctx.globalAlpha = 0.72;
        ctx.strokeStyle = biome.accent;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (wallN) { ctx.moveTo(sx, sy + 1); ctx.lineTo(sx + TILE, sy + 1); }
        if (wallS) { ctx.moveTo(sx, sy + TILE - 1); ctx.lineTo(sx + TILE, sy + TILE - 1); }
        if (wallW) { ctx.moveTo(sx + 1, sy); ctx.lineTo(sx + 1, sy + TILE); }
        if (wallE) { ctx.moveTo(sx + TILE - 1, sy); ctx.lineTo(sx + TILE - 1, sy + TILE); }
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // Room flourishes: per-archetype floor lighting drawn between floors and walls, so
  // wall tiles crop the edges naturally. Arenas get a fighting-pit spotlight, vaults a
  // treasure-warm glow, hazard set-piece rooms an ominous accent pool.
  renderRoomFlourishes(ctx, scene, x0, y0, x1, y1);

  // Pass 2: walls as extruded blocks — lit top cap, dark front face where a floor sits
  // directly below, and mid-dark side strips on exposed left/right edges. Corners where
  // the front meets a side get an extra darken so the cube edge reads.
  for (let ty = y0; ty < y1; ty++) {
    for (let tx = x0; tx < x1; tx++) {
      if (d.tiles[ty * d.w + tx] !== 1) continue;
      const sx = tx * TILE - cam.x, sy = ty * TILE - cam.y;
      const aboveFloor = ty > 0 && d.tiles[(ty - 1) * d.w + tx] === 0;
      const belowFloor = ty + 1 < d.h && d.tiles[(ty + 1) * d.w + tx] === 0;
      const leftFloor = tx > 0 && d.tiles[ty * d.w + tx - 1] === 0;
      const rightFloor = tx + 1 < d.w && d.tiles[ty * d.w + tx + 1] === 0;
      // Per-biome wall art (opt-in) wins outright; the extruded side/corner shading
      // below still runs over it, so a single authored block reads as a full cube.
      const biomeWall = tiles.biomeWallTop(biome.tileKey);
      if (!biomeWall) {
        // Full 16-piece autotile (AD): pick the block by which of N/E/S/W neighbours are
        // FLOOR (NESW order). One self-contained piece bakes cap + all exposed faces +
        // corners — handles thin walls, pillars, and gaps, not just room perimeters.
        const sides = (aboveFloor ? "N" : "") + (rightFloor ? "E" : "") + (belowFloor ? "S" : "") + (leftFloor ? "W" : "");
        const wf = ("wf_" + (sides || "top")) as TileName;
        if (tiles.ready(wf)) { ctx.drawImage(tiles.get(wf), sx, sy, TILE, TILE); continue; }
      }
      if (biomeWall) {
        ctx.drawImage(biomeWall, sx, sy, TILE, TILE);
        // Lift the authored wall cap as a material plane; floor is darkened separately.
        // Alpha is biome data (Biome.wallLift): bands whose authored wall art sits at
        // floor luminance need a stronger lift to stay readable as solid.
        ctx.save();
        ctx.globalCompositeOperation = "screen";
        ctx.globalAlpha = biome.wallLift;
        ctx.fillStyle = biome.wallCap;
        ctx.fillRect(sx, sy, TILE, TILE);
        ctx.restore();
      } else if (tiles.ready("wall_top")) {
        ctx.drawImage(tiles.get("wall_top"), sx, sy, TILE, TILE);
      } else {
        ctx.fillStyle = biome.wallFront;
        ctx.fillRect(sx, sy, TILE, TILE);
        ctx.fillStyle = biome.wallCap;
        ctx.fillRect(sx, sy, TILE, 6);
      }
      // Universal material hierarchy over every authored/fallback wall: a pale top lip and
      // hard dark floor-facing edge make collision/walkability readable even in grayscale.
      // Biome art supplies material; this supplies structural depth.
      ctx.save();
      ctx.globalAlpha = 0.72;
      ctx.fillStyle = biome.wallCap;
      ctx.fillRect(sx + 2, sy + 1, TILE - 4, 2);
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = "#05030b";
      if (belowFloor) ctx.fillRect(sx, sy + TILE - 6, TILE, 6);
      if (leftFloor) ctx.fillRect(sx, sy, 3, TILE);
      if (rightFloor) ctx.fillRect(sx + TILE - 3, sy, 3, TILE);
      ctx.restore();
      // Front face (darkest): a real sprite if present, then reinforce the inner edge.
      if (belowFloor && tiles.ready("wall_face")) {
        ctx.drawImage(tiles.get("wall_face"), sx, sy, TILE, TILE);
        ctx.save();
        ctx.globalAlpha = 0.72;
        ctx.fillStyle = "#05030b";
        ctx.fillRect(sx, sy + TILE - 5, TILE, 5);
        ctx.globalAlpha = 0.65;
        ctx.fillStyle = biome.wallCap;
        ctx.fillRect(sx + 2, sy + 2, TILE - 4, 2);
        ctx.restore();
      }
      // Side faces: a translucent gradient strip fading inward from the exposed edge.
      if (leftFloor && sideL) {
        ctx.save();
        ctx.translate(sx, sy);
        ctx.fillStyle = sideL;
        ctx.fillRect(0, 0, WALL_SIDE_W, TILE);
        ctx.restore();
      }
      if (rightFloor && sideR) {
        ctx.save();
        ctx.translate(sx + TILE - WALL_SIDE_W, sy);
        ctx.fillStyle = sideR;
        ctx.fillRect(0, 0, WALL_SIDE_W, TILE);
        ctx.restore();
      }
      // Darken the bottom corners where the front face meets a side face.
      if (belowFloor && (leftFloor || rightFloor)) {
        ctx.fillStyle = biome.wallCorner;
        if (leftFloor) ctx.fillRect(sx, sy + TILE - WALL_SIDE_W, WALL_SIDE_W, WALL_SIDE_W);
        if (rightFloor) ctx.fillRect(sx + TILE - WALL_SIDE_W, sy + TILE - WALL_SIDE_W, WALL_SIDE_W, WALL_SIDE_W);
      }
      // Isolated in-room wall cells are pillars/cover, not floor patches. Give them a
      // compact raised-block silhouette: dark cast shadow/face, inset lit cap, hard outline.
      if (aboveFloor && belowFloor && leftFloor && rightFloor) {
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = "#05030b";
        ctx.fillRect(sx + 5, sy + 8, TILE - 4, TILE - 3);
        ctx.globalAlpha = 1;
        ctx.fillStyle = biome.wallFront;
        ctx.fillRect(sx + 3, sy + 3, TILE - 8, TILE - 9);
        ctx.strokeStyle = "#05030b";
        ctx.lineWidth = 3;
        ctx.strokeRect(sx + 2.5, sy + 2.5, TILE - 7, TILE - 8);
        ctx.fillStyle = biome.wallCap;
        ctx.fillRect(sx + 5, sy + 5, TILE - 12, 4);
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(sx + 7, sy + 5, TILE - 16, 1);
        ctx.restore();
      }
    }
  }

  // Two-pass wash so the biome reads at a glance over the purple-baked wall sprites:
  // a "color" pass to shift hue, then a lighter "overlay" pass to push saturation/warmth
  // through while preserving the tile shading. Alphas kept tasteful (cohesion, not neon).
  const wx = x0 * TILE - cam.x, wy = y0 * TILE - cam.y, ww = (x1 - x0) * TILE, wh = (y1 - y0) * TILE;
  ctx.save();
  ctx.globalCompositeOperation = "color";
  ctx.globalAlpha = biome.tintAlpha;
  ctx.fillStyle = biome.tint;
  ctx.fillRect(wx, wy, ww, wh);
  ctx.globalCompositeOperation = "overlay";
  ctx.globalAlpha = biome.tintAlpha * 0.85;
  ctx.fillRect(wx, wy, ww, wh);
  // Depth darkness: the world itself dims band over band (entities draw ABOVE this, so
  // combat readability never pays for the mood). Ember/Null breathe — the dark swells.
  if (biome.lightLevel > 0) {
    ctx.globalCompositeOperation = "source-over";
    const breathe = biome.pulse > 0 ? biome.pulse * 0.5 * (1 + Math.sin(scene.animClock * 1.3)) : 0;
    ctx.globalAlpha = Math.min(0.5, biome.lightLevel + breathe);
    ctx.fillStyle = "#020108";
    ctx.fillRect(wx, wy, ww, wh);
  }
  ctx.restore();
}

// Per-archetype room lighting (screen-cropped, gradient fills only). Cheap: a handful
// of rooms intersect the camera and each is one radial fill.
function renderRoomFlourishes<Img>(ctx: TileRenderContext<Img>, scene: TileRenderScene<Img>, x0: number, y0: number, x1: number, y1: number): void {
  const { biome } = scene;
  const cam = { x: scene.camX, y: scene.camY };
  for (const room of scene.dungeon.rooms) {
    if (room.x >= x1 || room.y >= y1 || room.x + room.w <= x0 || room.y + room.h <= y0) continue;
    const cx = (room.cx + 0.5) * TILE - cam.x;
    const cy = (room.cy + 0.5) * TILE - cam.y;
    const radius = Math.max(room.w, room.h) * TILE * 0.55;
    if (room.shape === "arena") {
      // Fighting-pit spotlight: brightest at the center where the duel happens.
      const g = ctx.createRadialGradient(cx, cy, radius * 0.15, cx, cy, radius);
      g.addColorStop(0, "rgba(255,244,214,0.10)");
      g.addColorStop(1, "rgba(255,244,214,0)");
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = g;
      ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
      ctx.restore();
    } else if (room.kind === "treasure") {
      const g = ctx.createRadialGradient(cx, cy, 6, cx, cy, radius * 0.7);
      g.addColorStop(0, "rgba(255,209,102,0.12)");
      g.addColorStop(1, "rgba(255,209,102,0)");
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = g;
      ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
      ctx.restore();
    } else if (room.kind === "hazard") {
      const [r, g2, b] = hexToRgb(biome.accent);
      const pulse = 0.05 + 0.03 * Math.sin(scene.animClock * 2.1);
      const g = ctx.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius);
      g.addColorStop(0, `rgba(${r},${g2},${b},${pulse})`);
      g.addColorStop(1, `rgba(${r},${g2},${b},0)`);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = g;
      ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
      ctx.restore();
    }
  }
}
