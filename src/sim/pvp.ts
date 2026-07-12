// PVP (free-for-all arena deathmatch) — the ONE place every tunable pvp number, the symmetric
// arena, and the pure match helpers live, so the balancer and designer tune a single surface.
//
// This module is PURE (sim-only, no world.ts dependency): it owns config + arena geometry +
// deterministic helpers over plain data. The match STATE MACHINE and the damage funnel wiring
// live in world.ts (they mutate WorldState); they read the constants and helpers here. Keeping
// the split this way means pvp resolution never forks movement/shooting/collision — mode only
// selects which of the four gated concerns (damage targeting, arena, spawns, match) engages.

import { TILE } from "./types.js";
import type { WeaponId, Vec2, TileKind } from "./types.js";
import type { PlayerId } from "./input.js";
import type { Dungeon, Room } from "./dungeon.js";
import { TICKS_PER_SECOND } from "./kits.js";
import type { KitId } from "./kits.js";

// The world-content discriminant. "coop" is the DEFAULT everywhere (solo, legacy co-op, the
// authoritative shared dungeon) so every existing code path and golden master is zero-diff;
// "pvp" swaps ONLY the four gated concerns. Orthogonal to isSandbox/isShared/isCoop.
export type WorldMode = "coop" | "pvp";

// ---- PVP CONFIG (balancer + designer surface) ---------------------------------------------
// Numbers are the shipped balancer finals (2026-07-12): FIXED 100 HP + a global 2.0x scalar
// (PvE damage 100% untouched) tuned to a ~4.0s median TTK (3-5s band), a small per-weapon
// outlier table, a 35%-of-maxHp anti-one-shot per-hit cap, ults blanket-disabled, and 2.0s
// break-on-fire spawn protection. The match is a FRAG-LIMIT RESPAWN deathmatch (no rounds).
export const PVP = {
  // FIXED pvp HP pool — NOT the PvE 6-HP pool (too coarse). 100 gives smooth, readable TTK
  // (a hit = 3-8%). PvP-only; PvE maxHp is unchanged.
  maxHp: 100,
  // Global player-vs-player damage scalar, applied to pvp hits ONLY. Median gun ~4.0s TTK.
  dmgMult: 2.0,
  // Per-weapon outliers that come in under 3s at the flat 2.0x — an EXTRA multiplier stacked
  // on top of dmgMult (final = raw * dmgMult * (weaponMult[id] ?? 1)) to pull them into 3.5-4s.
  weaponMult: {
    sawnoff: 0.45, // Boomstick: 1.6s -> ~3.6s
    flamer: 0.45,  // Dragon:    1.7s -> ~3.8s (players take no burn DoT — direct pellets only)
    burst: 0.72,   // Triplet:   2.6s -> ~3.6s
    spear: 0.85,   // Pike:      2.9s -> ~3.4s
    beam: 0.85,    // Sunlance:  borderline -> comfortably in band
  } as Partial<Record<WeaponId, number>>,
  // Anti-one-shot backstop: no single tick may remove more than this fraction of maxHp from a
  // player (35 of 100). Enforced as a per-victim-per-tick cumulative clamp, so even a
  // point-blank pellet stack can never one-shot.
  perHitCapFrac: 0.35,
  // (Re)spawn invulnerability in seconds. Ends at this OR the first OUTGOING attack, whichever
  // comes first (can't shoot from invuln). Reuses the shared post-hit iframe channel (invuln),
  // which pvp otherwise leaves off so it never dominates TTK.
  spawnIframeSec: 2.0,
  // Respawn delay after death (frag-limit deathmatch: dead players respawn, never eliminate).
  respawnDelaySec: 2.5,
  // Pre-match countdown after enough players are present.
  countdownSec: 3.0,
  // Match time cap: at expiry the highest frag count wins (id-sorted tiebreak).
  matchTimeSec: 300,
  // Frags to win outright (FFA). Winner = most frags.
  fragLimit: 10,
  // The loop starts at 2 players — frag-limit respawn is a duel-to-N at 2 (fun at 2).
  minPlayers: 2,
  // Ults blanket-disabled for the MVP (every kit ult is degenerate in a duel). Named so v2
  // re-adds them tuned. When false the ult meter never charges and no ult ever fires in pvp.
  ultsEnabled: false,
  // Symmetric loadout: everyone gets the SAME neutral kit + weapon. "none" carries no stat
  // lean and no in-match power loop (no ult/momentum/lifesteal), which is exactly the flat
  // symmetric MVP the balancer's TTK numbers assume. Named so a tuned real kit is one line.
  kit: "none" as KitId,
  startWeapon: "pistol" as WeaponId,
};

// The match timers are counted in TICKS (never ms / wall-clock) for determinism; these convert
// the named second-values at the authoritative tick rate.
export function pvpRespawnDelayTicks(): number { return Math.round(PVP.respawnDelaySec * TICKS_PER_SECOND); }
export function pvpCountdownTicks(): number { return Math.round(PVP.countdownSec * TICKS_PER_SECOND); }
export function pvpMatchTimeTicks(): number { return Math.round(PVP.matchTimeSec * TICKS_PER_SECOND); }

// The final player-vs-player damage for one hit BEFORE the per-tick cap: global scalar times
// the per-weapon outlier multiplier. PvE damage never routes through here.
export function pvpHitDamage(weapon: WeaponId, rawDamage: number): number {
  return rawDamage * PVP.dmgMult * (PVP.weaponMult[weapon] ?? 1);
}

// The absolute per-hit/per-tick damage cap (HP), derived from the fixed maxHp.
export function pvpPerHitCap(): number {
  return PVP.perHitCapFrac * PVP.maxHp;
}

// FFA foe test: distinct players are foes unless they share a NON-ZERO team. team 0 = "no
// team" (every-man-for-himself), so in the MVP every distinct player is a foe. The team axis
// exists purely so future team modes drop in without touching the damage funnel.
export function arePvpFoes(aTeam: number, aId: PlayerId, bTeam: number, bId: PlayerId): boolean {
  if (aId === bId) return false;
  if (aTeam === 0 || bTeam === 0) return true;
  return aTeam !== bTeam;
}

// ---- match state --------------------------------------------------------------------------

// lobby: waiting for >= minPlayers. countdown: spawns assigned, brief freeze-in. live: the
// deathmatch (respawns, frag scoring). over: a winner is decided (frag limit or time cap).
export type MatchPhase = "lobby" | "countdown" | "live" | "over";

export interface MatchState {
  phase: MatchPhase;
  // The tick a TIMED phase ends (countdown -> live; the live time cap). 0 when untimed.
  phaseEndTick: number;
  // Frags per player, keyed by PlayerId (deterministic scoreboard). Winner = most frags.
  scores: Map<PlayerId, number>;
  // Decided winner id once phase === "over" (null otherwise).
  winner: PlayerId | null;
  // The arena's symmetric spawn points (tile-center px), static for the match.
  spawns: Vec2[];
  // Per-victim pvp damage applied THIS tick — the accumulator behind the per-hit cap. Cleared
  // at the top of every world step; never serialized (transient scratch).
  dmgThisTick: Map<PlayerId, number>;
}

export function createMatchState(spawns: Vec2[]): MatchState {
  return {
    phase: "lobby",
    phaseEndTick: 0,
    scores: new Map(),
    winner: null,
    spawns,
    dmgThisTick: new Map(),
  };
}

// The spawn index farthest from every listed occupied position (deterministic: ties break to
// the LOWEST index). Used for respawns (occupied = live opponents) and greedy spread-placement
// at match start (occupied = already-placed players). With no occupants, returns index 0.
export function farthestSpawnIndex(spawns: Vec2[], occupied: Vec2[]): number {
  let best = 0;
  let bestDist = -1;
  for (let i = 0; i < spawns.length; i++) {
    let minD = Infinity;
    for (const o of occupied) {
      const dx = spawns[i].x - o.x;
      const dy = spawns[i].y - o.y;
      const d = dx * dx + dy * dy;
      if (d < minD) minD = d;
    }
    if (occupied.length === 0) minD = 0;
    if (minD > bestDist) { bestDist = minD; best = i; }
  }
  return best;
}

// ---- symmetric arena ----------------------------------------------------------------------

const ARENA_W = 40;
const ARENA_H = 30;

// Point reflection through the grid center (180° rotational symmetry). Two servers agree on a
// fair mirror arena by construction: every wall and spawn stamped with its reflection.
function reflect(x: number, y: number): [number, number] {
  return [ARENA_W - 1 - x, ARENA_H - 1 - y];
}

// The FIXED, symmetric FFA arena: a walled rectangle with a handful of point-symmetric cover
// blocks (fair sightlines + a little cover) and symmetric spawn points, maximally spread. It
// reuses the same Dungeon/Room shape the renderer + pathfinder already consume — the SAME seam
// the dev sandbox's buildArena() uses to suppress enemies/props/chests/hazards.
export function buildPvpArena(): { dungeon: Dungeon; spawns: Vec2[] } {
  const w = ARENA_W;
  const h = ARENA_H;
  const tiles: TileKind[] = new Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const isBorder = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      tiles[y * w + x] = isBorder ? 1 : 0;
    }
  }
  // Light cover, stamped WITH its reflection so the map is provably point-symmetric. Kept off
  // the spawn points and away from the center lanes (fair sightlines).
  const coverRects: Array<{ x: number; y: number; w: number; h: number }> = [
    { x: 12, y: 9, w: 3, h: 2 },   // inner NW block (+ reflected SE)
    { x: 25, y: 9, w: 3, h: 2 },   // inner NE block (+ reflected SW)
    { x: 19, y: 6, w: 2, h: 3 },   // upper central pillar (+ reflected lower)
    { x: 13, y: 19, w: 3, h: 2 },  // outer SW block (self-pair via reflection)
  ];
  const setWall = (x: number, y: number): void => {
    if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1) return; // never seal the border/interior edge oddly
    tiles[y * w + x] = 1;
  };
  for (const r of coverRects) {
    for (let dy = 0; dy < r.h; dy++) {
      for (let dx = 0; dx < r.w; dx++) {
        const x = r.x + dx;
        const y = r.y + dy;
        setWall(x, y);
        const [rx, ry] = reflect(x, y);
        setWall(rx, ry);
      }
    }
  }
  // Symmetric spawn points (tile coords), stamped as reflected pairs so the SET is invariant
  // under the point reflection. Corners + mid-sides = maximally spread for up to 6 FFA blobs.
  const spawnTiles: Array<[number, number]> = [];
  const addSpawnPair = (x: number, y: number): void => {
    spawnTiles.push([x, y]);
    spawnTiles.push(reflect(x, y));
  };
  addSpawnPair(4, 4);   // TL + BR
  addSpawnPair(35, 4);  // TR + BL
  addSpawnPair(4, 14);  // mid-left + mid-right
  // Clear any cover that happens to sit on a spawn tile (spawns must be standable).
  for (const [sx, sy] of spawnTiles) tiles[sy * w + sx] = 0;
  const spawns: Vec2[] = spawnTiles.map(([tx, ty]) => ({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 }));
  const room: Room = { x: 1, y: 1, w: w - 2, h: h - 2, cx: w >> 1, cy: h >> 1, kind: "normal", shape: "rect" };
  const spawn = { x: w >> 1, y: h >> 1 };
  const dungeon: Dungeon = { w, h, tiles, rooms: [room], spawn, exit: { x: spawn.x, y: spawn.y } };
  return { dungeon, spawns };
}
