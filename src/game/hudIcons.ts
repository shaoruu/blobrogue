// Pixel-icon rasterizer + icon set (ported from docs/ui/hud_section_C_icons.js, the
// ui designer's verbatim spec). Each icon is a tiny char-map painted 1px-per-cell onto
// a canvas, then upscaled with image-rendering:pixelated so it stays crisp and chunky.

const INK = "#120a24";

export function pxIcon(map: readonly string[], pal: Record<string, string>, scale = 2): HTMLCanvasElement {
  const w = map[0].length, h = map.length;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d");
  if (x) {
    for (let y = 0; y < h; y++) {
      for (let i = 0; i < w; i++) {
        const col = pal[map[y][i]];
        if (col) {
          x.fillStyle = col;
          x.fillRect(i, y, 1, 1);
        }
      }
    }
  }
  c.style.imageRendering = "pixelated";
  c.style.width = w * scale + "px";
  c.style.height = h * scale + "px";
  return c;
}

const HEART_FULL = ["..X..X..", ".XRRXRRX", "XRWWRRRX", "XRRRRRRX", ".XRRRRX.", "..XRRX..", "...XX...", "........"];
const HEART_EMPTY = ["..X..X..", ".XddXddX", "Xd....dX", "Xd....dX", ".Xd..dX.", "..XddX..", "...XX...", "........"];
const HEART_PAL: Record<string, string> = { X: INK, R: "#ff5a5a", W: "#ffb0b0", d: "#241a38" };

// Re-render only when hp/maxHp changes (see spec perf note) — callers gate this.
export function renderHearts(el: HTMLElement, hp: number, maxHp: number, scale = 2.8): void {
  el.replaceChildren();
  for (let n = 0; n < maxHp; n++) {
    el.appendChild(pxIcon(n < hp ? HEART_FULL : HEART_EMPTY, HEART_PAL, scale));
  }
}

interface IconDef {
  map: readonly string[];
  pal: Record<string, string>;
  s: number;
}

export const ICONS: Record<string, IconDef> = {
  play: { map: [".X......", ".XX.....", ".XXX....", ".XXXX...", ".XXX....", ".XX.....", ".X......", "........"], pal: { X: INK }, s: 2 },
  coin: { map: ["..XXXX..", ".XWWWWhX", "XWhhWWhX", "XWhhhWhX", "XWhhhWhX", "XWWhhWhX", ".XWWWWhX", "..XXXX.."], pal: { X: INK, W: "#ffd166", h: "#b06e12" }, s: 2 },
  skull: { map: [".XXXXXX.", "XWWWWWWX", "XWKWWKWX", "XWWWWWWX", "XWKKKKWX", ".XWWWWX.", ".XKXKXKX", "..X.X..."], pal: { X: INK, W: "#e8e0c8", K: INK }, s: 2 },
  gun: { map: ["................", "...XXXXXXXX.....", "..XLLLLLLLLX....", ".XLhhhhhhhLX....", "XXXXXXXXXXLX....", "XLLLLLLLLXLX....", "XLbbbbbbLXXX....", "XXXXXXXXXX.X....", "...XLLX...XX....", "...XLLXXXXX.....", "...XXXX........."], pal: { X: INK, L: "#6b401e", h: "#9c6633", b: "#301c0e" }, s: 2.4 },
};

export function mountIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-ic]").forEach((el) => {
    if (el.dataset.mounted) return;
    const key = el.getAttribute("data-ic");
    if (!key) return;
    const d = ICONS[key];
    if (!d) return;
    const cv = pxIcon(d.map, d.pal, d.s);
    if (el.style.width) {
      cv.style.width = el.style.width;
      cv.style.height = el.style.height;
    }
    el.appendChild(cv);
    el.dataset.mounted = "1";
  });
}
