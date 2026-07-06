import type { TileKind } from "./types.js";

export interface Dungeon {
  w: number;
  h: number;
  tiles: TileKind[]; // row-major, 1 = wall, 0 = floor
  rooms: Room[];
  spawn: { x: number; y: number }; // tile coords
  exit: { x: number; y: number };  // tile coords
}

export interface Room { x: number; y: number; w: number; h: number; cx: number; cy: number; }

function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Simple room-and-corridor generator (Soul-Knight-ish: several rooms joined by halls).
export function generateDungeon(seed: number, floor: number): Dungeon {
  const rand = mulberry32(seed + floor * 1013904223);
  const w = 40 + Math.min(floor * 2, 20);
  const h = 30 + Math.min(floor * 2, 16);
  const tiles: TileKind[] = new Array(w * h).fill(1);
  const idx = (x: number, y: number) => y * w + x;

  const rooms: Room[] = [];
  const roomCount = 6 + Math.floor(rand() * 4) + Math.min(floor, 4);
  let attempts = 0;
  while (rooms.length < roomCount && attempts < 300) {
    attempts++;
    const rw = 5 + Math.floor(rand() * 7);
    const rh = 5 + Math.floor(rand() * 6);
    const rx = 1 + Math.floor(rand() * (w - rw - 2));
    const ry = 1 + Math.floor(rand() * (h - rh - 2));
    const overlaps = rooms.some(
      (r) => rx < r.x + r.w + 1 && rx + rw + 1 > r.x && ry < r.y + r.h + 1 && ry + rh + 1 > r.y
    );
    if (overlaps) continue;
    const room: Room = { x: rx, y: ry, w: rw, h: rh, cx: Math.floor(rx + rw / 2), cy: Math.floor(ry + rh / 2) };
    rooms.push(room);
    for (let yy = ry; yy < ry + rh; yy++) for (let xx = rx; xx < rx + rw; xx++) tiles[idx(xx, yy)] = 0;
  }

  // connect rooms in order with L-shaped corridors
  const carveH = (x0: number, x1: number, y: number) => {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) { tiles[idx(x, y)] = 0; tiles[idx(x, y + 1)] = 0; }
  };
  const carveV = (y0: number, y1: number, x: number) => {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) { tiles[idx(x, y)] = 0; tiles[idx(x + 1, y)] = 0; }
  };
  for (let i = 1; i < rooms.length; i++) {
    const a = rooms[i - 1], b = rooms[i];
    if (rand() < 0.5) { carveH(a.cx, b.cx, a.cy); carveV(a.cy, b.cy, b.cx); }
    else { carveV(a.cy, b.cy, a.cx); carveH(a.cx, b.cx, b.cy); }
  }

  const first = rooms[0], last = rooms[rooms.length - 1];
  return {
    w, h, tiles, rooms,
    spawn: { x: first.cx, y: first.cy },
    exit: { x: last.cx, y: last.cy },
  };
}
