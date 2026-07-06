// Central sprite registry. Every sprite is a 64x64 transparent PNG in /public/sprites.

export type SpriteName =
  | "hero" | "slime" | "bat" | "skeleton" | "ghost" | "boss"
  | "heart" | "coin" | "gun";

// Animation clip an entity can request. When a matching sheet is registered below
// it plays frame-by-frame; otherwise the draw path falls back to procedural juice.
export type SheetClip = "idle" | "walk";

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
};

const SOURCES: Record<SpriteName, string> = {
  hero: "/sprites/hero.png",
  slime: "/sprites/slime.png",
  bat: "/sprites/bat.png",
  skeleton: "/sprites/skeleton.png",
  ghost: "/sprites/ghost.png",
  boss: "/sprites/boss.png",
  heart: "/sprites/heart.png",
  coin: "/sprites/coin.png",
  gun: "/sprites/gun.png",
};

export interface LoadedSheet { img: HTMLImageElement; fps: number; }

export class Sprites {
  private images = new Map<SpriteName, HTMLImageElement>();
  private tintCache = new Map<string, HTMLCanvasElement>();
  private flashCache = new Map<SpriteName, HTMLCanvasElement>();
  private sheets = new Map<string, LoadedSheet>();

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
