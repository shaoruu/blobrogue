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
  // Global player-vs-player damage scalar, applied to pvp hits ONLY. Median gun ~4.5s TTK vs
  // 100 HP (1.78, bumped from 2.0 for the FFA respawn third-party reset beat).
  dmgMult: 1.78,
  // Per-weapon outliers that come in fast at the flat scalar — an EXTRA multiplier stacked on
  // top of dmgMult (final = raw * dmgMult * (weaponMult[id] ?? 1)) to pull them into band.
  // (ricochet/tesla/thumper come in slow ~5.8-6.7s — fine, left on the flat scalar.)
  weaponMult: {
    sawnoff: 0.45, // Boomstick (worst offender)
    flamer: 0.45,  // Dragon (players take no burn DoT — direct pellets only)
    burst: 0.72,   // Triplet
    spear: 0.85,   // Pike
    beam: 0.85,    // Sunlance
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

// Frags to win, SCALED by the match-start player count: clamp(round(6 + playerCount), 8, 16) —
// 2p:8, 4p:10, 6p:12. Resolved once at the live whistle so a mid-match join never moves the goal.
export function pvpFragLimit(playerCount: number): number {
  const n = Math.round(6 + Math.max(0, playerCount));
  return n < 8 ? 8 : n > 16 ? 16 : n;
}

// The final player-vs-player damage for one hit BEFORE the per-tick cap: global scalar times
// the per-weapon outlier multiplier. PvE damage never routes through here.
export function pvpHitDamage(weapon: WeaponId, rawDamage: number): number {
  return rawDamage * PVP.dmgMult * (PVP.weaponMult[weapon] ?? 1);
}

// The absolute per-hit/per-tick damage cap (HP), derived from the fixed maxHp.
export function pvpPerHitCap(): number {
  return PVP.perHitCapFrac * PVP.maxHp;
}

// A participant in the foe test: the (team, id) pair the damage funnel already carries for the
// attacker and the target. A named struct (not four same-typed positional args) so a call site
// can never silently transpose team/id or attacker/target — the swap-prone shape the audit flagged.
export interface PvpActor { team: number; id: PlayerId }

// FFA foe test: distinct players are foes unless they share a NON-ZERO team. team 0 = "no
// team" (every-man-for-himself), so in the MVP every distinct player is a foe. The team axis
// exists purely so future team modes drop in without touching the damage funnel.
export function arePvpFoes(a: PvpActor, b: PvpActor): boolean {
  if (a.id === b.id) return false;
  if (a.team === 0 || b.team === 0) return true;
  return a.team !== b.team;
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
  // Frags to win, resolved at the live whistle from the player count (pvpFragLimit). 0 until then.
  fragLimit: number;
  // Decided winner id once phase === "over" (null otherwise).
  winner: PlayerId | null;
  // The arena's symmetric spawn CANDIDATES (tile-center px), static for the match. The spread
  // assignment / respawn picks a subset (farthest-from-opponents) deterministically.
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
    fragLimit: 0,
    winner: null,
    spawns,
    dmgThisTick: new Map(),
  };
}

// The spawn index farthest from every listed occupied position (deterministic: ties break to
// the LOWEST index). Used for greedy spread-placement at match start (occupied = already-placed
// players). With no occupants, returns index 0.
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

// A respawn spot is "in an opponent's crosshair" if the opponent is facing within this cone of
// the spawn — respawning there drops you straight into their line of fire.
const CROSSHAIR_CONE = 0.44; // ~25 degrees

// The RESPAWN spawn index (anti-camp core): maximize distance to the nearest living opponent AND
// avoid any opponent's crosshair (heavily penalized, chosen only if every candidate is covered).
// Deterministic: ties break to the LOWEST index. With no opponents, returns index 0.
export function pvpRespawnIndex(spawns: Vec2[], opponents: Array<{ x: number; y: number; aim: number }>): number {
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < spawns.length; i++) {
    let minD = Infinity;
    let inCrosshair = false;
    for (const o of opponents) {
      const dx = spawns[i].x - o.x;
      const dy = spawns[i].y - o.y;
      const d = Math.hypot(dx, dy);
      if (d < minD) minD = d;
      const bearing = Math.atan2(dy, dx);
      const delta = Math.abs(Math.atan2(Math.sin(bearing - o.aim), Math.cos(bearing - o.aim)));
      if (delta < CROSSHAIR_CONE) inCrosshair = true;
    }
    if (opponents.length === 0) minD = 0;
    const score = minD - (inCrosshair ? 1e6 : 0); // never respawn in a crosshair unless forced
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

// ---- symmetric arena ----------------------------------------------------------------------

// The AUTHORITATIVE arena grid (game designer, independently re-verified 4-fold symmetric): a
// 19x19 square (0..18, center 9,9), clipped corners, 8 spawn candidates, and 16 BREAKABLE-PROP
// cover pieces. All groups are invariant under the 90° rotation rot90(x,y)=(y,18-x) — the pvp
// tests assert this. Cover is destructible props (not walls), so the arena degrades over a match
// (thinning cover → late-game raw aim), and props block movement + bullets via the shared sim.
// ARENA_N is the tunable size dial (design band 15..21); the coord tables below are hand-authored
// for 19 (the GD's exact grid), so retuning the size means re-authoring them for 4-fold symmetry.
const ARENA_N = 19;

// Wall cells cut from each corner (an octagon-ish clip so no one-angle corner camp), 4-fold
// symmetric. Listed verbatim from the authoritative grid.
const CLIP_WALLS: ReadonlyArray<[number, number]> = [
  [0, 0], [1, 0], [0, 1], [17, 0], [18, 0], [18, 1],
  [0, 17], [0, 18], [1, 18], [18, 17], [17, 18], [18, 18],
];

// Spawn CANDIDATES (8): 4 edge-mids + 4 diagonals. The match picks the N-most-spread subset
// deterministically (greedy farthest-from-placed). Diagonals are listed as point-opposite pairs
// so the greedy's lowest-index tiebreak yields OPPOSITE diagonals at 6p (max spread), matching the
// authoritative selection: 2->opposite edge-mids, 4->all edge-mids, 6->edge-mids + opposite diagonals.
const SPAWN_TILES: ReadonlyArray<[number, number]> = [
  [9, 3], [3, 9], [9, 15], [15, 9],   // edge-mids
  [12, 6], [6, 12], [6, 6], [12, 12], // diagonals (opposite pairs consecutive)
];

// Breakable cover (16 props): center knot (center 9,9 stays OPEN), four mid pairs, four corner
// blockers. Tile coords; every piece small + breakable + flankable, lanes >= 3 tiles.
const COVER_TILES: ReadonlyArray<[number, number]> = [
  [8, 8], [10, 8], [8, 10], [10, 10],                 // center knot
  [9, 6], [9, 7], [6, 9], [7, 9], [9, 12], [9, 11], [12, 9], [11, 9], // mid pairs
  [3, 3], [15, 3], [3, 15], [15, 15],                 // corner blockers
];

function tileCenter(tx: number, ty: number): Vec2 {
  return { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
}

// The FIXED symmetric FFA arena. Reuses the same Dungeon/Room shape the renderer + pathfinder
// consume (the SAME seam the dev sandbox's buildArena() uses to suppress population); the caller
// places `cover` as breakable props. `spawns` are the candidate points; `cover` the prop coords.
export function buildPvpArena(): { dungeon: Dungeon; spawns: Vec2[]; cover: Vec2[] } {
  const n = ARENA_N;
  const tiles: TileKind[] = new Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const isBorder = x === 0 || y === 0 || x === n - 1 || y === n - 1;
      tiles[y * n + x] = isBorder ? 1 : 0;
    }
  }
  for (const [x, y] of CLIP_WALLS) tiles[y * n + x] = 1;
  const spawns: Vec2[] = SPAWN_TILES.map(([tx, ty]) => tileCenter(tx, ty));
  const cover: Vec2[] = COVER_TILES.map(([tx, ty]) => tileCenter(tx, ty));
  const c = (n - 1) >> 1; // center tile (9)
  const room: Room = { x: 1, y: 1, w: n - 2, h: n - 2, cx: c, cy: c, kind: "normal", shape: "rect" };
  const dungeon: Dungeon = { w: n, h: n, tiles, rooms: [room], spawn: { x: c, y: c }, exit: { x: c, y: c } };
  return { dungeon, spawns, cover };
}

// The 90° rotation the arena is symmetric under — in tile space rot90(tx,ty)=(ty,N-1-tx), which
// in tile-CENTER px is (p.y, N*TILE - p.x). Exported so the pvp test can assert the arena walls +
// spawn set + cover are rotation-invariant (provably fair).
export function pvpArenaRot90(p: Vec2): Vec2 {
  return { x: p.y, y: ARENA_N * TILE - p.x };
}
