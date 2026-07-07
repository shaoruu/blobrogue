// Central sprite registry. Every sprite is a 64x64 transparent PNG in /public/sprites.

import type { WeaponId } from "./types.js";

export type SpriteName =
  | "hero" | "slime" | "bat" | "skeleton" | "ghost" | "spitter" | "boss"
  | "heart" | "coin" | "gun" | "spit";

// Animation clip an entity can request. When a matching sheet is registered below
// it plays frame-by-frame; otherwise the draw path falls back to procedural juice.
// "death" is a one-shot clip played over a corpse (see game.ts renderCorpses).
export type SheetClip = "idle" | "walk" | "death";

export const FRAME = 64; // px per frame in a horizontal strip spritesheet

export interface SheetDef { src: string; fps: number; }

// Optional frame-based spritesheets, keyed by `${SpriteName}.${SheetClip}`.
// EMPTY BY DEFAULT so nothing extra is fetched (no 404s). Drop a horizontal 1xN
// strip (64px per frame) into public/sprites and add an entry to light it up.
// See ART.md for the format. Example:
//   "hero.walk": { src: "/sprites/hero_walk.png", fps: 10 },
export const SHEETS: Partial<Record<string, SheetDef>> = {
  "hero.walk": { src: "/sprites/hero_walk.png", fps: 10 },
  "slime.walk": { src: "/sprites/slime_walk.png", fps: 7 },
  "bat.walk": { src: "/sprites/bat_walk.png", fps: 9 },
  "skeleton.walk": { src: "/sprites/skeleton_walk.png", fps: 8 },
  "ghost.walk": { src: "/sprites/ghost_walk.png", fps: 6 },
  "boss.walk": { src: "/sprites/boss_walk.png", fps: 4 },
  "boss.idle": { src: "/sprites/boss_walk.png", fps: 4 },
  // One-shot death clips, played once over the corpse. Ghost/spitter have none and keep
  // the procedural corpse fade. Boss is 8 frames (768x96); the rest 5 frames (320x64).
  "slime.death": { src: "/sprites/slime_death.png", fps: 12 },
  "skeleton.death": { src: "/sprites/skeleton_death.png", fps: 12 },
  "bat.death": { src: "/sprites/bat_death.png", fps: 12 },
  "boss.death": { src: "/sprites/boss_death.png", fps: 12 },
};

// Tintable bullet-FX primitives (public/sprites/fx). Authored pure white with all
// intensity in the alpha channel so a single source-in fill recolors them and they
// composite additively. Sizes are baked into the art; the renderer scales per bullet.
export type FxName =
  | "glow_round" | "core_dot" | "trail_streak" | "slug" | "spark"
  | "comet_trail" | "crackle" | "arc_chain" | "smoke_puff";

const FX_SOURCES: Record<FxName, string> = {
  glow_round: "/sprites/fx/glow_round.png",
  core_dot: "/sprites/fx/core_dot.png",
  trail_streak: "/sprites/fx/trail_streak.png",
  slug: "/sprites/fx/slug.png",
  spark: "/sprites/fx/spark.png",
  comet_trail: "/sprites/fx/comet_trail.png",
  crackle: "/sprites/fx/crackle.png",
  arc_chain: "/sprites/fx/arc_chain.png",
  smoke_puff: "/sprites/fx/smoke_puff.png",
};

// World props (destructibles + atmosphere) and the treasure chest, all in /public/sprites.
// The break/chest sheets are 3-frame 192x64 horizontal strips (frame 0 = intact/closed);
// barrel_explosive + brazier are 64x64 statics. The renderer slices frames itself, so no
// SpriteName/SheetClip unions are polluted and nothing extra is fetched if unused.
export type PropSpriteName =
  | "crate_break" | "pot_break" | "barrel_break" | "barrel_explosive_break"
  | "barrel_explosive" | "brazier" | "chest_open";

const PROP_SOURCES: Record<PropSpriteName, string> = {
  crate_break: "/sprites/crate_break.png",
  pot_break: "/sprites/pot_break.png",
  barrel_break: "/sprites/barrel_break.png",
  barrel_explosive_break: "/sprites/barrel_explosive_break.png",
  barrel_explosive: "/sprites/barrel_explosive.png",
  brazier: "/sprites/brazier.png",
  chest_open: "/sprites/chest_open.png",
};

const SOURCES: Record<SpriteName, string> = {
  hero: "/sprites/hero.png",
  slime: "/sprites/slime.png",
  bat: "/sprites/bat.png",
  skeleton: "/sprites/skeleton.png",
  ghost: "/sprites/ghost.png",
  spitter: "/sprites/spitter.png",
  boss: "/sprites/boss.png",
  heart: "/sprites/heart.png",
  coin: "/sprites/coin.png",
  gun: "/sprites/gun.png",
  spit: "/sprites/spit.png",
};

export interface LoadedSheet { img: HTMLImageElement; fps: number; }

// Held-weapon overlay sprites drawn over the hero, rotating to aim. Each is authored
// 40px with the gun centered in the file, pointing +X (0 rad). Opt-in registry like
// SHEETS: only weapons with real art are listed, so nothing else is fetched (no 404s).
// Weapons absent here fall back at draw time (see game.ts renderHeldWeapon).
const HELD_SOURCES: Partial<Record<WeaponId, string>> = {
  pistol: "/sprites/held_pistol.png",
  shotgun: "/sprites/held_shotgun.png",
  rapid: "/sprites/held_rapid.png",
};

export class Sprites {
  private images = new Map<SpriteName, HTMLImageElement>();
  private tintCache = new Map<string, HTMLCanvasElement>();
  private flashCache = new Map<SpriteName, HTMLCanvasElement>();
  private sheets = new Map<string, LoadedSheet>();
  private heldImages = new Map<WeaponId, HTMLImageElement>();
  private fxImages = new Map<FxName, HTMLImageElement>();
  private fxTintCache = new Map<string, HTMLCanvasElement>();
  private propImages = new Map<PropSpriteName, HTMLImageElement>();
  private propFlashCache = new Map<PropSpriteName, HTMLCanvasElement>();

  constructor() {
    for (const name of Object.keys(SOURCES) as SpriteName[]) {
      const img = new Image();
      img.src = SOURCES[name];
      this.images.set(name, img);
    }
    for (const key of Object.keys(SHEETS)) {
      const def = SHEETS[key];
      if (!def) continue;
      const img = new Image();
      img.src = def.src;
      this.sheets.set(key, { img, fps: def.fps });
    }
    for (const id of Object.keys(HELD_SOURCES) as WeaponId[]) {
      const src = HELD_SOURCES[id];
      if (!src) continue;
      const img = new Image();
      img.src = src;
      this.heldImages.set(id, img);
    }
    for (const name of Object.keys(FX_SOURCES) as FxName[]) {
      const img = new Image();
      img.src = FX_SOURCES[name];
      this.fxImages.set(name, img);
    }
    for (const name of Object.keys(PROP_SOURCES) as PropSpriteName[]) {
      const img = new Image();
      img.src = PROP_SOURCES[name];
      this.propImages.set(name, img);
    }
  }

  // A loaded prop/chest image (break sheet or static), or null while it streams in so the
  // renderer can fall back to a plain box.
  prop(name: PropSpriteName): HTMLImageElement | null {
    const img = this.propImages.get(name);
    return img && img.complete && img.naturalWidth > 0 ? img : null;
  }

  // A cached fully-white silhouette of a prop image, used to flash it white on a hit.
  // Drawing a sub-rect of this yields the white silhouette of that sheet frame.
  propFlash(name: PropSpriteName): HTMLCanvasElement | null {
    const cached = this.propFlashCache.get(name);
    if (cached) return cached;
    const img = this.propImages.get(name);
    if (!img || !img.complete || img.naturalWidth === 0) return null;
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d");
    if (!g) return null;
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = "source-atop";
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    this.propFlashCache.set(name, c);
    return c;
  }

  fxTinted(name: FxName, color: string): HTMLCanvasElement | null {
    // White art carries its shape in alpha, so a single source-in fill recolors it once;
    // callers draw the result with globalCompositeOperation 'lighter'. Cached per
    // name+color, so steady state never allocates. Null until the source image has loaded,
    // letting the bullet renderer fall back to a plain circle.
    const key = `${name}|${color}`;
    const cached = this.fxTintCache.get(key);
    if (cached) return cached;
    const img = this.fxImages.get(name);
    if (!img || !img.complete || img.naturalWidth === 0) return null;
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d");
    if (!g) return null;
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = "source-in";
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    this.fxTintCache.set(key, c);
    return c;
  }

  // A loaded held-weapon overlay for this weapon, or null to skip / fall back.
  heldWeapon(id: WeaponId): HTMLImageElement | null {
    const img = this.heldImages.get(id);
    return img && img.complete && img.naturalWidth > 0 ? img : null;
  }

  get(name: SpriteName): HTMLImageElement {
    return this.images.get(name)!;
  }

  ready(name: SpriteName): boolean {
    const img = this.images.get(name);
    return !!img && img.complete && img.naturalWidth > 0;
  }

  // A loaded spritesheet for this clip, or null to fall back to procedural animation.
  sheet(name: SpriteName, clip: SheetClip): LoadedSheet | null {
    const s = this.sheets.get(`${name}.${clip}`);
    if (s && s.img.complete && s.img.naturalWidth > 0) return s;
    return null;
  }

  // A cached fully-white silhouette of a sprite, used to flash it on hit.
  flashSprite(name: SpriteName): HTMLCanvasElement | null {
    const img = this.images.get(name);
    if (!img || !img.complete || img.naturalWidth === 0) return null;
    const cached = this.flashCache.get(name);
    if (cached) return cached;
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d");
    if (!g) return null;
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = "source-atop";
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    this.flashCache.set(name, c);
    return c;
  }

  tintedHero(color: string): HTMLCanvasElement | null {
    const hero = this.images.get("hero")!;
    if (!hero.complete || hero.naturalWidth === 0) return null;
    const cached = this.tintCache.get(color);
    if (cached) return cached;
    const c = document.createElement("canvas");
    c.width = hero.naturalWidth;
    c.height = hero.naturalHeight;
    const g = c.getContext("2d");
    if (!g) return null;
    g.drawImage(hero, 0, 0);
    g.globalCompositeOperation = "source-atop";
    g.fillStyle = color;
    g.globalAlpha = 0.5;
    g.fillRect(0, 0, c.width, c.height);
    this.tintCache.set(color, c);
    return c;
  }
}

// Environment tiles + props. Every PNG is 48x48 (torch_glow is 96x96) and lives in
// /public/tiles. Kept as a tiny parallel loader to Sprites so the tile renderer can
// draw real art with a graceful fillRect fallback while images stream in.
export type TileName =
  | "floor" | "floor2" | "floor3" | "floor4"
  | "floor_crack" | "floor_grate" | "floor_moss"
  | "wall_top" | "wall_face" | "wall_shadow"
  | "torch_f0" | "torch_f1" | "torch_f2" | "torch_glow"
  | "portal_f0" | "portal_f1";

const TILE_SOURCES: Record<TileName, string> = {
  floor: "/tiles/floor.png",
  floor2: "/tiles/floor2.png",
  floor3: "/tiles/floor3.png",
  floor4: "/tiles/floor4.png",
  floor_crack: "/tiles/floor_crack.png",
  floor_grate: "/tiles/floor_grate.png",
  floor_moss: "/tiles/floor_moss.png",
  wall_top: "/tiles/wall_top.png",
  wall_face: "/tiles/wall_face.png",
  wall_shadow: "/tiles/wall_shadow.png",
  torch_f0: "/tiles/props/torch_f0.png",
  torch_f1: "/tiles/props/torch_f1.png",
  torch_f2: "/tiles/props/torch_f2.png",
  torch_glow: "/tiles/props/torch_glow.png",
  portal_f0: "/tiles/props/portal_f0.png",
  portal_f1: "/tiles/props/portal_f1.png",
};

export class TileSet {
  private images = new Map<TileName, HTMLImageElement>();

  constructor() {
    for (const name of Object.keys(TILE_SOURCES) as TileName[]) {
      const img = new Image();
      img.src = TILE_SOURCES[name];
      this.images.set(name, img);
    }
  }

  get(name: TileName): HTMLImageElement {
    return this.images.get(name)!;
  }

  ready(name: TileName): boolean {
    const img = this.images.get(name);
    return !!img && img.complete && img.naturalWidth > 0;
  }
}

// A stable, readable palette for co-op players (host first).
export const PLAYER_COLORS = [
  "#ffb43b", // amber (you / host)
  "#5ad1ff", // cyan
  "#7CFC98", // green
  "#ff7ad1", // pink
  "#c98bff", // violet
  "#ff8a5a", // orange
] as const;

export function playerColor(index: number): string {
  return PLAYER_COLORS[index % PLAYER_COLORS.length];
}
