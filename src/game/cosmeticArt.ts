// Procedural pixel art for the cosmetic overlays — no image files, exactly like the
// procedural audio engine. Each cosmetic renders once onto a cached 64x64 canvas aligned
// to the hero sprite's frame (hat brim rows ~16-23 spanning x10-53, eye bars at ~x20-26 and
// ~x38-44 around y26-38), so callers draw it with the SAME transform as the body sprite and
// the overlay inherits squash/stretch/bob for free.
//
// Replacement hats are drawn with an opaque skirt over the baked-in cowboy hat's full
// extent so equipping one reads as "wearing this hat", never "two hats"; the halo floats
// above and deliberately keeps the cowboy hat. Unknown ids return null and render nothing —
// the defensive posture for ids minted by a newer catalog.

const FRAME = 64;

type Painter = (g: CanvasRenderingContext2D) => void;

function px(g: CanvasRenderingContext2D, color: string, x: number, y: number, w: number, h: number): void {
  g.fillStyle = color;
  g.fillRect(x, y, w, h);
}

const INK = "#120a24";

// Opaque cover over the baked cowboy hat (crown rows 8-15 x18-45, brim rows 16-23 x10-53)
// in the replacement hat's own base color, so no brown peeks out under any deform.
function coverCowboyHat(g: CanvasRenderingContext2D, color: string): void {
  px(g, color, 18, 8, 28, 8);
  px(g, color, 10, 16, 44, 8);
}

const topHat: Painter = (g) => {
  coverCowboyHat(g, "#1a1426");
  // brim
  px(g, INK, 8, 20, 48, 2);
  px(g, "#1a1426", 9, 16, 46, 5);
  px(g, "#2a2140", 9, 16, 46, 1);
  // cylinder
  px(g, "#1a1426", 17, 0, 30, 17);
  px(g, "#2a2140", 17, 0, 2, 17); // left sheen
  px(g, INK, 45, 0, 2, 17);       // right shade
  px(g, INK, 17, 0, 30, 1);       // top edge
  // amber band
  px(g, "#ffb43b", 17, 12, 30, 4);
  px(g, "#b06e12", 17, 15, 30, 1);
};

const partyCone: Painter = (g) => {
  coverCowboyHat(g, "#5ad1ff");
  // striped cone: widening rows from the apex down to a brim that covers the cowboy hat
  const stripes = ["#ff5a5a", "#ffe9b0", "#5ad1ff"];
  for (let y = 2; y < 24; y++) {
    const t = (y - 2) / 22;
    const halfW = 2 + t * 21; // 2px at the tip -> 23px at the base (x9..x55)
    const color = stripes[Math.floor((y - 2) / 5) % stripes.length];
    px(g, color, Math.round(32 - halfW), y, Math.round(halfW * 2), 1);
  }
  px(g, INK, 9, 23, 46, 1); // base edge
  // pompom
  px(g, "#ffe9b0", 29, 0, 6, 4);
  px(g, "#fff", 30, 0, 2, 2);
};

const crown: Painter = (g) => {
  coverCowboyHat(g, "#ffd166");
  // band (tall enough to fully cover the cowboy crown + brim)
  px(g, "#ffd166", 11, 8, 42, 16);
  px(g, "#b06e12", 11, 21, 42, 3);  // base shadow
  px(g, INK, 11, 23, 42, 1);
  px(g, "#ffe9b0", 11, 8, 42, 2);   // top sheen
  // prongs
  for (const x of [11, 24, 37, 47]) px(g, "#ffd166", x, 2, 6, 7);
  for (const x of [11, 24, 37, 47]) px(g, "#ffe9b0", x, 2, 2, 2);
  // jewels
  px(g, "#ff5a5a", 30, 13, 4, 4);
  px(g, "#5ad1ff", 18, 14, 3, 3);
  px(g, "#7fdd5a", 43, 14, 3, 3);
};

const halo: Painter = (g) => {
  // Floats above the head — the classic cowboy hat stays visible under it.
  px(g, "#ffe9b0", 20, 0, 24, 2);
  px(g, "#ffd166", 16, 2, 6, 2);
  px(g, "#ffd166", 42, 2, 6, 2);
  px(g, "#ffe9b0", 20, 4, 24, 2);
  px(g, "#fff", 24, 0, 4, 2); // glint
};

function lens(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, rim: string, glass: string): void {
  px(g, rim, cx - r, cy - r + 2, r * 2, r * 2 - 4);
  px(g, rim, cx - r + 2, cy - r, r * 2 - 4, r * 2);
  px(g, glass, cx - r + 2, cy - r + 2, r * 2 - 4, r * 2 - 4);
}

const roundSpecs: Painter = (g) => {
  lens(g, 23, 32, 7, INK, "rgba(200,230,255,0.55)");
  lens(g, 41, 32, 7, INK, "rgba(200,230,255,0.55)");
  px(g, INK, 29, 30, 6, 2);  // bridge
  px(g, INK, 12, 30, 4, 2);  // temples
  px(g, INK, 48, 30, 4, 2);
  px(g, "#fff", 19, 28, 2, 2); // glints
  px(g, "#fff", 37, 28, 2, 2);
};

const shades: Painter = (g) => {
  px(g, INK, 12, 26, 40, 11); // visor
  px(g, INK, 10, 26, 44, 3);  // top bar + temples
  px(g, "#5ad1ff", 15, 28, 14, 2); // reflections
  px(g, "#5ad1ff", 35, 28, 14, 2);
  px(g, "#2a2140", 12, 35, 40, 2); // lower fade
};

const monocle: Painter = (g) => {
  lens(g, 41, 32, 8, "#ffd166", "rgba(220,240,255,0.5)");
  px(g, "#ffe9b0", 41 - 6, 32 - 8, 4, 2); // rim sheen
  // chain
  px(g, "#ffd166", 49, 38, 2, 3);
  px(g, "#ffd166", 51, 42, 2, 4);
  px(g, "#ffd166", 53, 47, 2, 5);
  px(g, "#fff", 35, 29, 2, 2); // glint
};

const PAINTERS: Record<string, Painter> = {
  hat_top: topHat,
  hat_party: partyCone,
  hat_crown: crown,
  hat_halo: halo,
  face_round: roundSpecs,
  face_shades: shades,
  face_monocle: monocle,
};

const cache = new Map<string, HTMLCanvasElement | null>();

// The 64x64 overlay canvas for a cosmetic id, cached; null for unknown ids (nothing renders)
// or when a 2d context is unavailable (headless harness).
export function cosmeticOverlay(id: string): HTMLCanvasElement | null {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;
  const paint = PAINTERS[id];
  if (!paint) { cache.set(id, null); return null; }
  const c = document.createElement("canvas");
  c.width = FRAME;
  c.height = FRAME;
  const g = c.getContext("2d");
  if (!g) { cache.set(id, null); return null; }
  paint(g);
  cache.set(id, c);
  return c;
}

// Which ids have real art — the catalog test asserts every hat/face entry does, so a new
// overlay row can never ship invisible (body renders as tint, titles as text).
export function hasCosmeticArt(id: string): boolean {
  return PAINTERS[id] !== undefined;
}
