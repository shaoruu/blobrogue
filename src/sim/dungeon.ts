import type { TileKind } from "./types.js";
import { Rng } from "./rng.js";

export type RoomKind = "spawn" | "normal" | "large" | "treasure" | "exit";

export interface Dungeon {
  w: number;
  h: number;
  tiles: TileKind[]; // row-major, 1 = wall, 0 = floor
  rooms: Room[];
  spawn: { x: number; y: number }; // tile coords
  exit: { x: number; y: number };  // tile coords
}

export interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  kind: RoomKind;
}

function rollRoomSize(rand: Rng, isTreasure: boolean): { w: number; h: number } {
  if (isTreasure) {
    const s = 7 + rand.int(0, 2);
    return { w: s, h: s };
  }
  if (rand.chance(0.18)) {
    return { w: 4 + rand.int(0, 2), h: 4 + rand.int(0, 2) };
  }
  if (rand.chance(0.22)) {
    return { w: 9 + rand.int(0, 4), h: 8 + rand.int(0, 3) };
  }
  return { w: 5 + rand.int(0, 6), h: 5 + rand.int(0, 5) };
}

function assignKinds(rooms: Room[], floor: number, treasureIdx: number): void {
  const effectiveTreasureIdx =
    floor >= 2 && rooms.length >= 3
      ? Math.min(Math.max(treasureIdx, 1), rooms.length - 2)
      : -1;
  for (let i = 0; i < rooms.length; i++) {
    if (i === 0) rooms[i].kind = "spawn";
    else if (i === rooms.length - 1) rooms[i].kind = "exit";
    else if (i === effectiveTreasureIdx) rooms[i].kind = "treasure";
    else if (rooms[i].w >= 9 || rooms[i].h >= 8) rooms[i].kind = "large";
    else rooms[i].kind = "normal";
  }
}

function carveTreasureRing(tiles: TileKind[], w: number, room: Room): void {
  const idx = (x: number, y: number) => y * w + x;
  const inset = 2;
  if (room.w < 7 || room.h < 7) return;
  const ix0 = room.x + inset;
  const iy0 = room.y + inset;
  const ix1 = room.x + room.w - inset - 1;
  const iy1 = room.y + room.h - inset - 1;
  for (let x = ix0; x <= ix1; x++) {
    tiles[idx(x, iy0)] = 1;
    tiles[idx(x, iy1)] = 1;
  }
  for (let y = iy0; y <= iy1; y++) {
    tiles[idx(ix0, y)] = 1;
    tiles[idx(ix1, y)] = 1;
  }
  tiles[idx(room.cx, iy0)] = 0;
  tiles[idx(room.cx, iy1)] = 0;
  tiles[idx(ix0, room.cy)] = 0;
  tiles[idx(ix1, room.cy)] = 0;
}

export function generateDungeon(seed: number, floor: number): Dungeon {
  const rand = new Rng(seed + floor * 1013904223);
  const w = 40 + Math.min(floor * 2, 20);
  const h = 30 + Math.min(floor * 2, 16);
  const tiles: TileKind[] = new Array(w * h).fill(1);
  const idx = (x: number, y: number) => y * w + x;

  const roomCount = 6 + rand.int(0, 3) + Math.min(floor, 4);
  const hasTreasure = floor >= 2 && roomCount >= 3;
  const treasureIdx = hasTreasure ? 1 + rand.int(0, roomCount - 3) : -1;

  const rooms: Room[] = [];
  let attempts = 0;
  while (rooms.length < roomCount && attempts < 300) {
    attempts++;
    const isTreasure = rooms.length === treasureIdx;
    const { w: rw, h: rh } = rollRoomSize(rand, isTreasure);
    const rx = 1 + rand.int(0, w - rw - 3);
    const ry = 1 + rand.int(0, h - rh - 3);
    const overlaps = rooms.some(
      (r) => rx < r.x + r.w + 1 && rx + rw + 1 > r.x && ry < r.y + r.h + 1 && ry + rh + 1 > r.y
    );
    if (overlaps) continue;
    const room: Room = {
      x: rx,
      y: ry,
      w: rw,
      h: rh,
      cx: Math.floor(rx + rw / 2),
      cy: Math.floor(ry + rh / 2),
      kind: "normal",
    };
    rooms.push(room);
    for (let yy = ry; yy < ry + rh; yy++) for (let xx = rx; xx < rx + rw; xx++) tiles[idx(xx, yy)] = 0;
  }

  assignKinds(rooms, floor, treasureIdx);

  const carveH = (x0: number, x1: number, y: number) => {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      tiles[idx(x, y)] = 0;
      tiles[idx(x, y + 1)] = 0;
    }
  };
  const carveV = (y0: number, y1: number, x: number) => {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
      tiles[idx(x, y)] = 0;
      tiles[idx(x + 1, y)] = 0;
    }
  };
  const connect = (a: Room, b: Room) => {
    if (rand.chance(0.5)) {
      carveH(a.cx, b.cx, a.cy);
      carveV(a.cy, b.cy, b.cx);
    } else {
      carveV(a.cy, b.cy, a.cx);
      carveH(a.cx, b.cx, b.cy);
    }
  };

  for (let i = 1; i < rooms.length; i++) connect(rooms[i - 1], rooms[i]);

  // Extra corridors (loops/shortcuts). Only meaningful with enough rooms to have a
  // non-adjacent pair (i and j must differ by >= 2), so guard rooms.length < 3.
  const extraCount = rooms.length >= 3 ? rand.int(1, Math.min(3, Math.max(1, Math.floor(rooms.length / 3)))) : 0;
  const linked = new Set<string>();
  for (let n = 0; n < extraCount; n++) {
    let pickI = -1;
    let pickJ = -1;
    let pickDist = Infinity;
    for (let t = 0; t < 12; t++) {
      // i must leave room for a j >= i+2 within bounds, so i ranges [0, rooms.length-3].
      const i = rand.int(0, rooms.length - 3);
      const j = rand.int(i + 2, rooms.length - 1);
      const key = i < j ? `${i}:${j}` : `${j}:${i}`;
      if (linked.has(key)) continue;
      const dist = Math.abs(rooms[i].cx - rooms[j].cx) + Math.abs(rooms[i].cy - rooms[j].cy);
      if (dist < pickDist) {
        pickDist = dist;
        pickI = i;
        pickJ = j;
      }
    }
    if (pickI < 0) continue;
    linked.add(`${pickI}:${pickJ}`);
    connect(rooms[pickI], rooms[pickJ]);
  }

  if (floor >= 2 && rooms.length >= 3) {
    const effectiveTreasureIdx = Math.min(Math.max(treasureIdx, 1), rooms.length - 2);
    carveTreasureRing(tiles, w, rooms[effectiveTreasureIdx]);
  }

  const first = rooms[0];
  const last = rooms[rooms.length - 1];
  return {
    w,
    h,
    tiles,
    rooms,
    spawn: { x: first.cx, y: first.cy },
    exit: { x: last.cx, y: last.cy },
  };
}
