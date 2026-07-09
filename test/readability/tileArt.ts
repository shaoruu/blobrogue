// Disk-backed TileArtSource for headless rendering: loads the SAME PNGs the client
// fetches over HTTP straight from public/, through the canonical source maps in
// src/game/assets.ts. Three tiers mirror the renderer's real fallback ladder:
//   authored — per-biome art + the shared tile set (what a player with all art sees)
//   shared   — shared tile set only (biomes without authored art live here already)
//   flat     — no images at all (the pure palette fillRect fallback)

import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { Canvas, Image } from "@napi-rs/canvas";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TILE_SOURCES, BIOME_TILE_SOURCES } from "../../src/game/assets.js";
import type { TileName } from "../../src/game/assets.js";
import type { TileArtSource } from "../../src/game/tileRender.js";

export type HeadlessImage = Image | Canvas;
export type ArtTier = "authored" | "shared" | "flat";
export const ART_TIERS: readonly ArtTier[] = ["authored", "shared", "flat"];

export class HeadlessTileArt implements TileArtSource<HeadlessImage> {
  private images = new Map<TileName, Image>();
  private biomeFloors = new Map<string, Image[]>();
  private biomeWallTops = new Map<string, Image>();
  private tintCache = new Map<string, Canvas>();

  constructor(readonly tier: ArtTier) {}

  set(name: TileName, img: Image): void {
    this.images.set(name, img);
  }

  setBiome(tileKey: string, floors: Image[], wallTop: Image | null): void {
    this.biomeFloors.set(tileKey, floors);
    if (wallTop) this.biomeWallTops.set(tileKey, wallTop);
  }

  ready(name: TileName): boolean {
    return this.images.has(name);
  }

  get(name: TileName): HeadlessImage {
    const img = this.images.get(name);
    if (!img) throw new Error(`tile art not loaded: ${name}`);
    return img;
  }

  // Mirrors TileSet.tinted: recolor via source-in, shape kept from alpha.
  tinted(name: TileName, color: string): HeadlessImage | null {
    const key = `${name}|${color}`;
    const cached = this.tintCache.get(key);
    if (cached) return cached;
    const img = this.images.get(name);
    if (!img) return null;
    const c = createCanvas(img.width, img.height);
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = "source-in";
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    this.tintCache.set(key, c);
    return c;
  }

  biomeFloor(tileKey: string, pick: number): HeadlessImage | null {
    const list = this.biomeFloors.get(tileKey);
    if (!list || list.length === 0) return null;
    return list[Math.abs(pick) % list.length];
  }

  biomeWallTop(tileKey: string): HeadlessImage | null {
    return this.biomeWallTops.get(tileKey) ?? null;
  }
}

export async function loadTileArt(tier: ArtTier, publicDir: string): Promise<HeadlessTileArt> {
  const art = new HeadlessTileArt(tier);
  if (tier === "flat") return art;
  for (const name of Object.keys(TILE_SOURCES) as TileName[]) {
    const path = join(publicDir, TILE_SOURCES[name]);
    // Same grace as the client loader: a registered-but-absent file simply stays
    // not-ready and the renderer's fallback holds.
    if (!existsSync(path)) continue;
    art.set(name, await loadImage(path));
  }
  if (tier !== "authored") return art;
  for (const tileKey of Object.keys(BIOME_TILE_SOURCES)) {
    const def = BIOME_TILE_SOURCES[tileKey];
    if (!def) continue;
    const floors: Image[] = [];
    for (const src of def.floors) {
      const path = join(publicDir, src);
      if (existsSync(path)) floors.push(await loadImage(path));
    }
    let wallTop: Image | null = null;
    if (def.wallTop) {
      const path = join(publicDir, def.wallTop);
      if (existsSync(path)) wallTop = await loadImage(path);
    }
    art.setBiome(tileKey, floors, wallTop);
  }
  return art;
}
