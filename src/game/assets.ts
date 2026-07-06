// Central sprite registry. Every sprite is a 64x64 transparent PNG in /public/sprites.

export type SpriteName =
  | "hero" | "slime" | "bat" | "skeleton" | "ghost" | "boss"
  | "heart" | "coin" | "gun";

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

export class Sprites {
  private images = new Map<SpriteName, HTMLImageElement>();
  private tintCache = new Map<string, HTMLCanvasElement>();

  constructor() {
    for (const name of Object.keys(SOURCES) as SpriteName[]) {
      const img = new Image();
      img.src = SOURCES[name];
      this.images.set(name, img);
    }
  }

  get(name: SpriteName): HTMLImageElement {
    return this.images.get(name)!;
  }

  ready(name: SpriteName): boolean {
    const img = this.images.get(name);
    return !!img && img.complete && img.naturalWidth > 0;
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
