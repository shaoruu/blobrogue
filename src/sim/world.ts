// The pure, isomorphic simulation core. WorldState is plain data; stepWorld advances it
// one tick from per-player InputCmds and returns the SimEvents that fired (the client
// turns those into juice; a server would ignore most). No DOM, rendering, audio, or
// wall-clock time here — time is the passed dt + state.tick.
//
// This is game.ts's old update(dt) reorganized: the single implicit player became a
// players map (Stage A runs one), every this.px/hp/... became p.x/hp/..., and every FX
// call became an events.push(...). Behavior is preserved byte-for-byte (proven by the
// golden-master oracle).

import { generateDungeon } from "./dungeon.js";
import type { Dungeon, Room } from "./dungeon.js";
import { FlowField } from "./pathfind.js";
import { TILE } from "./types.js";
import type { Enemy, Bullet, Pickup, Prop, Chest, WeaponId, AttackMove, TileKind } from "./types.js";
import { Rng } from "./rng.js";
import { ENEMY_ARCHETYPES, spawnFloorEnemies, createEnemy, threatCostOf, isBossFloor } from "./enemies.js";
import { WEAPONS, DEFAULT_WEAPON, PICKUP_WEAPONS, fire } from "./weapons.js";
import type { ShotSpec } from "./weapons.js";
import { createMods, recomputeMods, itemLevelsOf, MAX_ITEM_LEVEL } from "./items.js";
import type { PlayerMods, ItemDef } from "./items.js";
import type { SimEvent } from "./events.js";
import type { InputCmd, PlayerId } from "./input.js";
import { LOCAL_ID, IDLE_INPUT } from "./input.js";
import * as C from "./constants.js";
import {
  PLAYER, SUSTAIN, DEALER, REVIVE, FANG_PROC_COOLDOWN, BOSS, CAPS, TIERS,
  activeThreatCap, clampPlayers, coopThreatMult, coopHeartRateMult,
  REINFORCE_STAGGER, BIOME_PRESSURE, ELITE_SPLIT_COUNT, BRUTE_HEAVY_DAMAGE,
} from "./balance.js";
import { biomeIndexForFloor } from "./biomes.js";

// A live melee swing, resolving hits over its short duration (sim state, per player).
export interface MeleeSwing {
  timer: number;
  duration: number;
  aim: number;
  arc: number;
  reach: number;
  isThrust: boolean;
  color: string;
  damage: number;
  isCrit: boolean;
  hitList: Array<Enemy | number> | null; // enemies + negative prop-id markers
  burn?: number;
  chill?: number;
  shock?: number;
  // The attacker's pose when the swing started. While the swing's fire-time rewind is active
  // (online), hit tests use THIS pose so both actors are evaluated at fire time — the attacker
  // moving after the swing can't drag the hit arc with it. Solo rewind is 0, so the live pose is
  // used and behavior is unchanged.
  originX: number;
  originY: number;
  // Fire-time lag compensation for the swing (see Bullet.bornTick/lagRewind). A swing is short,
  // so this rewinds hits to when the swing started. 0/undefined in solo.
  bornTick?: number;
  lagRewind?: number;
}

interface StrikeInfo {
  damage: number;
  isCrit: boolean;
  puffX: number;
  puffY: number;
  kbDirX: number;
  kbDirY: number;
  burn?: number;
  chill?: number;
  shock?: number;
  isMelee: boolean;
  // Immutable actor identity for status attribution (burn DoT). Survives the actor's disconnect
  // — a burn lit by a departed player keeps crediting THAT id (which then resolves to no one),
  // never a different live player.
  ownerId: PlayerId | null;
  // The weapon whose knockback profile applies when the striking player is gone (bullet.fx —
  // the fire-time weapon). A present player uses their live weapon, exactly as before.
  fxWeapon: WeaponId | null;
}

export interface PlayerSim {
  id: PlayerId;
  x: number; y: number; pr: number;
  hp: number; maxHp: number;
  mods: PlayerMods;
  // Post-hit protection (0.80s). SEPARATE from the dash iframe: neither may extend the other.
  invuln: number;
  // Dash iframe (0.18s), set once per dash — non-refreshing, non-overlapping.
  dashInvuln: number;
  dashCd: number; dashTime: number; dashDx: number; dashDy: number;
  fireCd: number;
  // Vampire Fang shared proc cooldown (1.25s): at most one kill-heal per window.
  fangCd: number;
  facing: number; aimAngle: number; weapon: WeaponId;
  ownedWeapons: WeaponId[]; // inventory; the client switches with 1-9 / Q / scroll
  shotSeq: number; isDown: boolean;
  // Seconds a teammate has been reviving this downed player (authoritative revive hold). 0 when
  // up or when no one is reviving. Solo never downs, so this stays 0.
  reviveProgress: number;
  // Lag-compensation rewind for THIS player's shots/swings, in ticks (server-computed from the
  // player's measured RTT + interp delay, clamped). 0 in solo/prediction, so hit tests use
  // present-time positions and behavior is unchanged.
  rewindTicks: number;
  kills: number; coins: number; combo: number; comboTimer: number;
  ownedItemIds: string[];
  meleeSwing: MeleeSwing | null;
}

// Extra AI target points fed in by the client from co-op presence (Stage A keeps co-op on
// the existing presence path; the sim only needs remote POSITIONS as enemy aggro targets).
export interface RemoteTarget { x: number; y: number; isDown: boolean }

// A per-enemy ring of recent positions for lag-compensated hit rewind.
interface EnemyHist { x: number[]; y: number[] }

export interface WorldState {
  tick: number;
  seed: number;
  floor: number;
  // World revision: increments on EVERY floor build (create/descend/run reset). Snapshots carry
  // it so a client can key its geometry rebuild + reject stale cross-floor snapshots explicitly
  // (tick alone stays monotonic, but rev makes the world identity first-class on the wire).
  rev: number;
  // Terminal run state: set once when the whole party wipes (or the last standing player leaves
  // a shared world with only downed players behind). Snapshots carry it so game-over is
  // derivable from STATE, not only from the transient gameOver event.
  isRunOver: boolean;
  players: Map<PlayerId, PlayerSim>;
  enemies: Enemy[];
  bullets: Bullet[];
  pickups: Pickup[];
  props: Prop[];
  chests: Chest[];
  dungeon: Dungeon;
  flow: FlowField;
  flowCd: number;
  // Combined hash of every living source tile; the flow field rebuilds when it changes.
  flowKey: number;
  flowSources: number[];
  rng: Rng;
  // Co-op encounter snapshot (§8): living players at floor build, clamped 1–4. Drives
  // enemy HP / threat budget / heart-rate scaling; NEVER rescales living enemies mid-floor.
  encounterPlayers: number;
  // Threat-cap reinforcements: pre-planned units beyond the ActiveThreatCap, released in
  // waves as the living threat drops (spawnReleaseCd staggers the trickle).
  pendingSpawns: Enemy[];
  spawnReleaseCd: number;
  // Heart-economy pity (§2): hearts generated this floor, whether the party entered below
  // 50% HP, the dry-floor streak, and whether the next wood chest is forced to hold a heart.
  heartsThisFloor: number;
  isFloorEnteredLow: boolean;
  pityStreak: number;
  isPityHeartArmed: boolean;
  nextEnemyId: number;
  nextPropId: number;
  nextPickupId: number;
  nextChestId: number;
  // Lag-compensation position history: per-enemy ring of past positions (offset 0 = most
  // recent record). histHead is the ring slot of the most recent record; histCount is how many
  // slots are valid. Recorded once per world tick; read only when a shooter has rewindTicks > 0.
  enemyHist: Map<number, EnemyHist>;
  histHead: number;
  histCount: number;
  // Authoritative pending blessing offers: pid -> seconds left to answer. An entry exists
  // from the moment an offerBlessing event is raised until the pick is applied (or the offer
  // expires / the player leaves). While pending, that player is PAUSED (stepPlayerPhase
  // no-ops) and cannot be damaged, and the party's descend gate holds — a blessing is always
  // picked on the safe side of a floor transition, never under live enemies.
  pendingBlessings: Map<PlayerId, number>;
  // Whether this floor's between-floor blessing offers were already raised at the exit gate
  // (one offer per cleared non-boss floor; reset on every floor build).
  isBlessingOfferedThisFloor: boolean;
  remoteTargets: RemoteTarget[];
  isCoop: boolean;
  // Authoritative shared multiplayer world (the Stage-C server). Like solo it descends in-sim
  // (the server owns floor transitions), but unlike solo a player hitting 0 HP goes DOWN rather
  // than ending the world, and enemy processing never aborts on a single downed player. Solo and
  // the legacy Convex co-op path leave this false, so their behavior is unchanged.
  isShared: boolean;
  isSandbox: boolean;
  isGodMode: boolean; // dev sandbox: damagePlayer no-ops while true
  // Per-query scratch (nearest living target); avoids per-frame allocation, matching the
  // old this.targetX/targetY.
  targetX: number;
  targetY: number;
}

export function createPlayer(id: PlayerId, x: number, y: number): PlayerSim {
  return {
    id, x, y, pr: 18,
    hp: PLAYER.baseMaxHp, maxHp: PLAYER.baseMaxHp,
    mods: createMods(),
    invuln: 0, dashInvuln: 0,
    dashCd: 0, dashTime: 0, dashDx: 0, dashDy: 0,
    fireCd: 0, fangCd: 0,
    facing: 1, aimAngle: 0, weapon: DEFAULT_WEAPON,
    ownedWeapons: [DEFAULT_WEAPON],
    shotSeq: 0, isDown: false, reviveProgress: 0, rewindTicks: 0,
    kills: 0, coins: 0, combo: 0, comboTimer: 0,
    ownedItemIds: [],
    meleeSwing: null,
  };
}

// skipLocalPlayer: the authoritative server owns N per-connection players and adds them via
// spawnPlayerInWorld on join, so it creates the world WITHOUT the implicit LOCAL_ID player.
// Solo/co-op/prediction clients keep the default (one LOCAL_ID player).
export interface WorldOptions { isSandbox?: boolean; isCoop?: boolean; isShared?: boolean; skipLocalPlayer?: boolean }

export function createWorld(seed: number, floor: number, opts: WorldOptions = {}): WorldState {
  const w: WorldState = {
    tick: 0,
    seed,
    floor,
    rev: 0,
    isRunOver: false,
    players: new Map(),
    enemies: [],
    bullets: [],
    pickups: [],
    props: [],
    chests: [],
    dungeon: { w: 0, h: 0, tiles: [], rooms: [], spawn: { x: 0, y: 0 }, exit: { x: 0, y: 0 } },
    flow: new FlowField(),
    flowCd: 0,
    flowKey: -1,
    flowSources: [],
    rng: new Rng(seed ^ 0x53696d21),
    encounterPlayers: 1,
    pendingSpawns: [],
    spawnReleaseCd: 0,
    heartsThisFloor: 0,
    isFloorEnteredLow: false,
    pityStreak: 0,
    isPityHeartArmed: false,
    nextEnemyId: 0,
    nextPropId: 0,
    nextPickupId: 0,
    nextChestId: 0,
    enemyHist: new Map(),
    histHead: 0,
    histCount: 0,
    pendingBlessings: new Map(),
    isBlessingOfferedThisFloor: false,
    remoteTargets: [],
    isCoop: opts.isCoop ?? false,
    isShared: opts.isShared ?? false,
    isSandbox: opts.isSandbox ?? false,
    isGodMode: false,
    targetX: 0,
    targetY: 0,
  };
  loadFloorIntoWorld(w, floor);
  if (!opts.skipLocalPlayer) {
    const spawn = w.dungeon.spawn;
    w.players.set(LOCAL_ID, createPlayer(LOCAL_ID, spawn.x * TILE + TILE / 2, spawn.y * TILE + TILE / 2));
  }
  return w;
}

// Add a fresh player to a live world at the current dungeon spawn (authoritative server:
// on join). Returns the created PlayerSim. No-ops to the existing entry if the id is taken.
export function spawnPlayerInWorld(w: WorldState, id: PlayerId): PlayerSim {
  const existing = w.players.get(id);
  if (existing) return existing;
  const spawn = w.dungeon.spawn;
  const p = createPlayer(id, spawn.x * TILE + TILE / 2, spawn.y * TILE + TILE / 2);
  w.players.set(id, p);
  return p;
}

// Remove a player from a live world (authoritative server: on disconnect). B is ephemeral —
// no grace/resume yet (that is Stage D). Returns whether a player was actually removed.
// Their pending blessing offer (if any) dies with them so the descend gate can't be held
// by a player who is no longer in the world.
export function removePlayerFromWorld(w: WorldState, id: PlayerId): boolean {
  w.pendingBlessings.delete(id);
  return w.players.delete(id);
}

// A single open walled rectangle for the dev sandbox — reuses the Dungeon/Room shape so
// the renderer + pathfinder run unchanged.
function buildArena(): Dungeon {
  const w = 34, h = 24;
  const tiles: TileKind[] = new Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const isBorder = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      tiles[y * w + x] = isBorder ? 1 : 0;
    }
  }
  const room: Room = { x: 1, y: 1, w: w - 2, h: h - 2, cx: w >> 1, cy: h >> 1, kind: "normal" };
  return { w, h, tiles, rooms: [room], spawn: { x: w >> 1, y: h >> 1 }, exit: { x: w - 3, y: 2 } };
}

// Build (or rebuild, on descend) the floor's world content. Does NOT reseed w.rng — the
// sim RNG stream is continuous across a run (matching the old start()/loadFloor split).
// The co-op player count is SNAPSHOTTED here (encounter creation, §8) and never rescales
// living enemies mid-floor.
export function loadFloorIntoWorld(w: WorldState, floor: number): void {
  w.floor = floor;
  w.rev++;
  w.encounterPlayers = clampPlayers(Math.max(1, w.players.size));
  w.dungeon = w.isSandbox ? buildArena() : generateDungeon(w.seed, floor);
  w.bullets = [];
  w.nextEnemyId = 0;
  w.nextPropId = 0;
  w.nextPickupId = 0;
  w.nextChestId = 0;
  const spawns = w.isSandbox
    ? { active: [], pending: [] }
    : spawnFloorEnemies(w.dungeon, w.seed, floor, w.encounterPlayers);
  w.enemies = spawns.active;
  w.pendingSpawns = spawns.pending;
  w.spawnReleaseCd = 0;
  w.nextEnemyId = spawns.active.length + spawns.pending.length;
  w.heartsThisFloor = 0;
  w.isFloorEnteredLow = [...w.players.values()].some((p) => p.hp < p.maxHp * SUSTAIN.pityLowHpFrac);
  w.pendingBlessings.clear();
  w.isBlessingOfferedThisFloor = false;
  w.flowCd = 0;
  w.flowKey = -1;
  w.pickups = [];
  w.props = w.isSandbox ? [] : placeProps(w);
  w.chests = w.isSandbox ? [] : placeChests(w);
  if (!w.isSandbox) {
    stockWeaponChests(w);
    placeDealerHearts(w);
  }
  // Reposition living players to the new spawn.
  const spawn = w.dungeon.spawn;
  for (const p of w.players.values()) {
    p.x = spawn.x * TILE + TILE / 2;
    p.y = spawn.y * TILE + TILE / 2;
  }
}

// Floor cleared = every active enemy dead AND no reinforcements still queued. The exit,
// the snapshot `cleared` flag, and the client HUD/minimap all read this one predicate.
export function isFloorCleared(w: WorldState): boolean {
  return w.enemies.length === 0 && w.pendingSpawns.length === 0;
}

// Reset a live world to a FRESH run: new seed, new RNG stream, floor 1, cleared terminal state.
// The authoritative server calls this when a room empties (party wiped or everyone left), so the
// next group starts a new run rather than inheriting a half-played dungeon. tick keeps counting
// (snapshot ordering stays monotonic across resets); rev increments via loadFloorIntoWorld.
export function resetRunInWorld(w: WorldState, seed: number): void {
  w.seed = seed;
  w.rng = new Rng(seed ^ 0x53696d21);
  w.isRunOver = false;
  w.pityStreak = 0;
  w.isPityHeartArmed = false;
  loadFloorIntoWorld(w, 1);
}

// The still-connected player behind an attributed action (bullet/burn/explosion owner), or null
// when the actor has left. Attribution is IMMUTABLE: a departed owner's outcomes credit NO ONE
// (damage still lands, loot still drops at base value) and are never transferred to another live
// player — the TD audit's ownership contract. There is deliberately NO "primary player"
// fallback anywhere in the credit path. Solo: `id` is always the one LOCAL_ID player.
function ownerOf(w: WorldState, id: PlayerId | null): PlayerSim | null {
  return id !== null ? w.players.get(id) ?? null : null;
}

// ---- deterministic floor placement (seeded per floor, own RNG streams) ----

// The floor's weapon drops are CONTENTS of chests, never loose floor pickups. (They used to
// spawn at room centers — the same tiles chests and props prefer — so guns sat visibly
// stacked on top of chests, and free weapons in the open undercut chests as the reward
// container.) Each rolled weapon is stocked into a weaponless wood chest, treasure room
// first; when the floor placed fewer chests than weapons, an extra chest is placed to hold
// the overflow, roomed where the loose drop used to land. Opening the chest ejects the
// weapon (see openChest). Same seeded stream as the old loose drops, so a given seed still
// finds the same arsenal — just inside chests.
function stockWeaponChests(w: WorldState): void {
  const d = w.dungeon;
  if (w.floor < 2 || d.rooms.length <= 2) return;
  const rng = new Rng((w.seed ^ 0x51ed270b) + w.floor * 40503);
  const kinds: WeaponId[] = [rng.pick(PICKUP_WEAPONS)];
  if (w.floor >= 3 && rng.chance(0.6)) kinds.push(rng.pick(PICKUP_WEAPONS));
  const used = new Set<number>();
  for (const c of w.chests) used.add(Math.floor(c.y / TILE) * d.w + Math.floor(c.x / TILE));
  for (const weapon of kinds) {
    const host = w.chests.find((c) => c.kind === "wood" && c.weapon === undefined);
    if (host) { host.weapon = weapon; continue; }
    const room = d.rooms[1 + rng.int(0, d.rooms.length - 2)];
    let spot = chestTile(w, room, used);
    for (let ri = 1; spot === null && ri < d.rooms.length; ri++) spot = chestTile(w, d.rooms[ri], used);
    if (!spot) continue; // no open tile anywhere: forfeit this weapon roll
    used.add(spot.ty * d.w + spot.tx);
    w.chests.push({ id: w.nextChestId++, kind: "wood", x: (spot.tx + 0.5) * TILE, y: (spot.ty + 0.5) * TILE, radius: 16, opened: false, weapon });
  }
}

// The Dealer's stock (§2): on every third floor, P purchasable hearts near a mid-run room
// center. Walking over one with enough coins buys exactly +1 HP — never a full heal.
function placeDealerHearts(w: WorldState): void {
  if (w.floor % DEALER.floorInterval !== 0 || isBossFloor(w.floor)) return;
  const d = w.dungeon;
  if (d.rooms.length < 3) return;
  const rng = new Rng((w.seed ^ 0x0dea1e12) + w.floor * 68927);
  const room = d.rooms.find((r) => r.kind === "treasure") ?? d.rooms[1 + rng.int(0, d.rooms.length - 3)];
  const stock = w.encounterPlayers;
  for (let i = 0; i < stock; i++) {
    w.pickups.push({
      id: w.nextPickupId++, kind: "dealer_heart",
      x: (room.cx + 0.5) * TILE + (i - (stock - 1) / 2) * 30, y: (room.cy + 0.5) * TILE - 26,
      radius: 13, weapon: null, value: DEALER.price,
    });
  }
}

// Deep floors bias hazard density (§4 biome pressure): a wider explosive-barrel band.
function rollPropKind(rng: Rng, hazardMult: number): Prop["kind"] {
  const r = rng.next();
  const explosiveBand = 0.10 * hazardMult;
  if (r < 0.34) return "pot";
  if (r < 0.62) return "crate";
  if (r < 0.94 - explosiveBand) return "barrel";
  if (r < 0.94) return "barrel_explosive";
  return "brazier";
}

function placeProps(w: WorldState): Prop[] {
  const d = w.dungeon;
  const rng = new Rng((w.seed ^ 0x2f6a35c1) + w.floor * 26417);
  const hazardMult = BIOME_PRESSURE[biomeIndexForFloor(w.floor)].hazardMult;
  const list: Prop[] = [];
  const occupied = new Set<number>();
  for (const room of d.rooms) {
    const target = rng.int(3, 6);
    for (let i = 0; i < target; i++) {
      const tx = room.x + rng.int(0, room.w - 1);
      const ty = room.y + rng.int(0, room.h - 1);
      const idx = ty * d.w + tx;
      if (occupied.has(idx) || d.tiles[idx] !== 0) continue;
      if (Math.abs(tx - d.spawn.x) <= 1 && Math.abs(ty - d.spawn.y) <= 1) continue;
      if (Math.abs(tx - d.exit.x) <= 1 && Math.abs(ty - d.exit.y) <= 1) continue;
      occupied.add(idx);
      const kind = rollPropKind(rng, hazardMult);
      list.push({ id: w.nextPropId++, kind, x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE, radius: C.PROP_RADIUS, hp: C.PROP_HP[kind], dead: false });
    }
  }
  return list;
}

function placeChests(w: WorldState): Chest[] {
  const d = w.dungeon;
  if (d.rooms.length < 2) return [];
  const rng = new Rng((w.seed ^ 0x1b3c9e77) + w.floor * 55697);
  const list: Chest[] = [];
  const used = new Set<number>();
  const count = rng.chance(0.5) ? 2 : 1;
  const addChest = (tx: number, ty: number) => {
    used.add(ty * d.w + tx);
    list.push({ id: w.nextChestId++, kind: "wood", x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE, radius: 16, opened: false });
  };
  const treasure = d.rooms.find((r) => r.kind === "treasure");
  let remaining = count;
  if (treasure) {
    const spot = chestTile(w, treasure, used);
    if (spot) { addChest(spot.tx, spot.ty); remaining--; }
  }
  for (let i = 0; i < remaining; i++) {
    const room = d.rooms[1 + rng.int(0, d.rooms.length - 2)];
    const spot = chestTile(w, room, used);
    if (spot) addChest(spot.tx, spot.ty);
  }
  if (list.length === 0) {
    for (let ri = 1; ri < d.rooms.length; ri++) {
      const spot = chestTile(w, d.rooms[ri], used);
      if (spot) { addChest(spot.tx, spot.ty); break; }
    }
  }
  return list;
}

// A free tile for a chest: open floor, unused, not the spawn/exit tile, and not a tile a
// prop already occupies (props are placed first, and a chest materializing on a barrel is
// the same stacked-loot eyesore as a gun on a chest).
function chestTile(w: WorldState, room: Room, used: Set<number>): { tx: number; ty: number } | null {
  const d = w.dungeon;
  const isBad = (tx: number, ty: number) =>
    d.tiles[ty * d.w + tx] !== 0 ||
    used.has(ty * d.w + tx) ||
    hasLivePropOnTile(w, tx, ty) ||
    (tx === d.spawn.x && ty === d.spawn.y) ||
    (tx === d.exit.x && ty === d.exit.y);
  if (!isBad(room.cx, room.cy)) return { tx: room.cx, ty: room.cy };
  for (let ty = room.y; ty < room.y + room.h; ty++)
    for (let tx = room.x; tx < room.x + room.w; tx++)
      if (!isBad(tx, ty)) return { tx, ty };
  return null;
}

function hasLivePropOnTile(w: WorldState, tx: number, ty: number): boolean {
  for (const p of w.props) {
    if (!p.dead && Math.floor(p.x / TILE) === tx && Math.floor(p.y / TILE) === ty) return true;
  }
  return false;
}

// ---- geometry / collision ----

function isWall(w: WorldState, px: number, py: number): boolean {
  const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
  if (tx < 0 || ty < 0 || tx >= w.dungeon.w || ty >= w.dungeon.h) return true;
  return w.dungeon.tiles[ty * w.dungeon.w + tx] === 1;
}

function moveCircle(w: WorldState, x: number, y: number, r: number, dx: number, dy: number): [number, number] {
  const nx = x + dx, ny = y + dy;
  if (!isWall(w, nx + Math.sign(dx) * r, y) && !blockedByProp(w, nx, y, r)) x = nx;
  if (!isWall(w, x, ny + Math.sign(dy) * r) && !blockedByProp(w, x, ny, r)) y = ny;
  return [x, y];
}

function blockedByProp(w: WorldState, x: number, y: number, r: number): boolean {
  for (const p of w.props) {
    if (p.dead) continue;
    const rr = r + p.radius * 0.8;
    const ddx = x - p.x, ddy = y - p.y;
    if (ddx * ddx + ddy * ddy < rr * rr) return true;
  }
  return false;
}

// ---- item mods ----

function lowHpFactor(p: PlayerSim): number {
  return p.maxHp > 0 ? 1 - Math.max(0, p.hp / p.maxHp) : 0;
}
// The raw caps (§6) bind the LIVE multipliers too: low-HP scalers (berserk/adrenaline) are
// expressive risk payoffs but can never push raw damage/fire-rate past the cap.
function currentDamageMult(p: PlayerSim): number {
  return Math.min(CAPS.damageMult, p.mods.damageMult + p.mods.berserk * lowHpFactor(p));
}
function currentFireRate(p: PlayerSim): number {
  return Math.max(0.25, Math.min(CAPS.fireRateMult, p.mods.fireRateMult + p.mods.adrenaline * lowHpFactor(p)));
}
function dashCooldown(p: PlayerSim): number {
  return PLAYER.dashCooldown * p.mods.dashCdMult;
}
// Post-hit protection and the dash iframe are separate, non-extending windows; a player is
// safe while either is live.
function isProtected(p: PlayerSim): boolean {
  return p.invuln > 0 || p.dashInvuln > 0;
}
function coinGain(p: PlayerSim): number {
  return Math.max(1, Math.round(p.mods.coinMult));
}
function comboMult(p: PlayerSim): number {
  return C.comboTierFor(p.combo).mult;
}
function comboCoinValue(p: PlayerSim): number {
  return Math.max(1, Math.round(coinGain(p) * comboMult(p)));
}

function resolveShot(p: PlayerSim, weapon: WeaponId): ShotSpec {
  const wep = WEAPONS[weapon];
  const pellets = wep.pellets + p.mods.extraPellets;
  const spread = pellets > 1 ? Math.max(wep.spread, C.MIN_MULTI_SPREAD) + p.mods.spreadAdd : wep.spread;
  return {
    pellets,
    spread,
    speed: wep.speed * p.mods.bulletSpeedMult,
    life: wep.life * p.mods.bulletLifeMult,
    radius: wep.bulletRadius * p.mods.bulletSizeMult,
    color: wep.color,
    damage: wep.damage * currentDamageMult(p),
    pierce: Math.min(4, (wep.basePierce ?? 0) + p.mods.pierce),
    critChance: p.mods.critChance,
    critMult: p.mods.critMult,
    fx: wep.id,
    bounce: wep.bounce,
    homing: wep.homing,
    chain: wep.chain,
    chainRange: wep.chainRange,
    burn: wep.burn,
    chill: wep.chill,
    shock: wep.shock,
  };
}

// Recompute maxHp from the mods bonus and clamp current HP into it. Deliberately does NOT
// heal the capacity delta — a max-HP upgrade restores exactly 1 heart (see applyItemToWorld),
// per the Vitality rule in spec §2.
export function applyMaxHpBonus(p: PlayerSim): void {
  p.maxHp = Math.max(1, PLAYER.baseMaxHp + p.mods.maxHpBonus);
  if (p.hp > p.maxHp) p.hp = p.maxHp;
  if (p.hp < 1) p.hp = 1;
}

// Equip a weapon the player already owns. Switching resets the fire cooldown and cancels
// any in-progress melee swing (matches the current game). No-ops if already equipped.
function equipWeapon(p: PlayerSim, id: WeaponId): void {
  if (p.weapon === id) return;
  p.weapon = id;
  p.fireCd = 0;
  p.meleeSwing = null;
}

// Acquire a weapon (dedup into the inventory) and equip it. Used by weapon pickups (sim)
// and by dev/grant. The client's keyboard/scroll switching calls equipWeaponInWorld.
function acquireWeapon(p: PlayerSim, id: WeaponId): void {
  if (!p.ownedWeapons.includes(id)) p.ownedWeapons.push(id);
  equipWeapon(p, id);
}

// Client-driven weapon switch (1-9 / Q / scroll). Equips an already-owned slot.
export function equipWeaponInWorld(w: WorldState, pid: PlayerId, id: WeaponId): void {
  const p = w.players.get(pid);
  if (p) equipWeapon(p, id);
}

// Authoritative, validated weapon switch (the server's switch-input handler). Equips only a
// slot the player actually owns; an unowned id is ignored (a tampered client can't equip a
// weapon it never picked up). Returns whether the switch was accepted. equipWeapon resets the
// fire cooldown and cancels any in-progress melee swing server-side.
export function switchWeaponInWorld(w: WorldState, pid: PlayerId, id: WeaponId): boolean {
  const p = w.players.get(pid);
  if (!p || !p.ownedWeapons.includes(id)) return false;
  equipWeapon(p, id);
  return true;
}

// Client-driven acquire + equip (dev grant, or golden 'weapon' command).
export function acquireWeaponInWorld(w: WorldState, pid: PlayerId, id: WeaponId): void {
  const p = w.players.get(pid);
  if (p) acquireWeapon(p, id);
}

// Apply a picked blessing to a player: append the pick to the level history, RECOMPUTE the
// whole build from levels (no incremental applies — spec §6), clamp the raw caps, and heal
// exactly 1 heart when max HP grew (the Vitality rule). A pick past Lv3 is a no-op.
// Returns the itemPicked FX event.
export function applyItemToWorld(w: WorldState, pid: PlayerId, item: ItemDef): SimEvent[] {
  const p = w.players.get(pid);
  if (!p) return [];
  if ((itemLevelsOf(p.ownedItemIds).get(item.id) ?? 0) >= MAX_ITEM_LEVEL) return [];
  p.ownedItemIds.push(item.id);
  const maxHpBefore = p.maxHp;
  recomputeMods(p.mods, p.ownedItemIds);
  applyMaxHpBonus(p);
  if (p.maxHp > maxHpBefore) p.hp = Math.min(p.maxHp, p.hp + 1);
  return [{ t: "itemPicked", pid, x: p.x, y: p.y, tint: item.tint }];
}

// Raise a blessing offer for one player: the offerBlessing event surfaces the choice UI
// (solo rolls locally; the server rolls + sends a validated offer), and the pending entry
// pauses/shields that player and holds the descend gate until the pick resolves.
function raiseBlessingOffer(w: WorldState, pid: PlayerId, rare: boolean, ev: SimEvent[]): void {
  w.pendingBlessings.set(pid, C.BLESSING_OFFER_TTL);
  ev.push({ t: "offerBlessing", pid, rare });
}

// Resolve a blessing OFFER with a pick: apply the item and clear the player's pending state
// (ending their pause/shield and releasing the descend gate). This is the answer path for
// every real offer — the solo/co-op overlay callback and the server's validated
// chooseBlessing command; dev grants (no offer) keep calling applyItemToWorld directly.
export function chooseBlessingInWorld(w: WorldState, pid: PlayerId, item: ItemDef): SimEvent[] {
  w.pendingBlessings.delete(pid);
  return applyItemToWorld(w, pid, item);
}

// Resolve a pending offer WITHOUT a pick — the roll came up empty (every blessing maxed), so
// there is nothing to choose and the pause/gate must not wait out the TTL.
export function dismissBlessingOfferInWorld(w: WorldState, pid: PlayerId): void {
  w.pendingBlessings.delete(pid);
}

// Tick pending offers on the SIM clock: an unanswered offer expires after BLESSING_OFFER_TTL
// and the run moves on without the pick, so an AFK/hostile client can never hold the party's
// descend gate (or their own damage shield) forever.
function tickPendingBlessings(w: WorldState, dt: number): void {
  if (w.pendingBlessings.size === 0) return;
  for (const [pid, left] of w.pendingBlessings) {
    if (left <= dt) w.pendingBlessings.delete(pid);
    else w.pendingBlessings.set(pid, left - dt);
  }
}

// ---- knockback ----

function applyKnockbackDir(weapon: WeaponId, e: Enemy, dirX: number, dirY: number): void {
  const sp = Math.hypot(dirX, dirY) || 1;
  const v = (C.WEAPON_KB[weapon] * C.KB_LAMBDA) / e.kbResist;
  e.vx += (dirX / sp) * v;
  e.vy += (dirY / sp) * v;
  const mag = Math.hypot(e.vx, e.vy);
  if (mag > C.KB_MAX_SPEED) { const s = C.KB_MAX_SPEED / mag; e.vx *= s; e.vy *= s; }
}

function applyKnockbackDecay(w: WorldState, e: Enemy, dt: number): void {
  if (e.vx === 0 && e.vy === 0) return;
  moveEnemyBy(w, e, e.vx * dt, e.vy * dt);
  const d = Math.min(1, dt * C.KB_LAMBDA);
  e.vx -= e.vx * d; e.vy -= e.vy * d;
  if (e.vx < 1 && e.vx > -1) e.vx = 0;
  if (e.vy < 1 && e.vy > -1) e.vy = 0;
}

// ---- elemental status ----

function isFrozen(e: Enemy): boolean {
  return e.kind !== "boss" && e.chill >= C.FREEZE_AT;
}
function chillMoveScale(e: Enemy): number {
  if (e.chill <= 0) return 1;
  return isFrozen(e) ? 0 : C.CHILL_SLOW;
}
function applyBurn(e: Enemy, secs: number, owner: PlayerId | null): void {
  if (secs > e.burn) e.burn = secs;
  e.burnDmg = Math.min(C.BURN_DMG_MAX, e.burnDmg + C.BURN_DMG_STACK);
  // The most recent igniter owns the burn; its DoT tick credits that id on a kill. The identity
  // is immutable: if the igniter disconnects, the burn keeps THEIR id (which then credits no
  // one), never a different live player.
  e.burnOwner = owner;
}
function applyChill(e: Enemy, secs: number): void {
  e.chill = Math.min(C.CHILL_MAX, e.chill + secs);
}
function applyShock(e: Enemy, secs: number): void {
  if (secs > e.shock) e.shock = secs;
}
// `p` is the striking player when still connected; null when the actor has left (their in-flight
// bullet keeps its baked-in statuses via `src` + the immutable ownerId, but the mods-chance rolls
// need a live player and are skipped).
function applyHitStatuses(w: WorldState, p: PlayerSim | null, e: Enemy, src: StrikeInfo): void {
  if (src.burn !== undefined) applyBurn(e, src.burn, src.ownerId);
  else if (p && p.mods.burnChance > 0 && w.rng.next() < p.mods.burnChance) applyBurn(e, C.ITEM_BURN_SECS, p.id);
  if (src.chill !== undefined) applyChill(e, src.chill);
  else if (p && p.mods.chillChance > 0 && w.rng.next() < p.mods.chillChance) applyChill(e, C.ITEM_CHILL_SECS);
  if (src.shock !== undefined) applyShock(e, src.shock);
  else if (p && p.mods.shockChance > 0 && w.rng.next() < p.mods.shockChance) applyShock(e, C.ITEM_SHOCK_SECS);
}

function tickStatuses(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  if (e.chill > 0) e.chill = e.chill > dt ? e.chill - dt : 0;
  if (e.shock > 0) e.shock = e.shock > dt ? e.shock - dt : 0;
  if (e.burn > 0) {
    e.burn = e.burn > dt ? e.burn - dt : 0;
    e.statusTick += dt;
    while (e.statusTick > C.BURN_TICK) {
      damageEnemy(w, e.burnOwner, e, e.burnDmg * C.BURN_TICK, ev);
      e.statusTick -= C.BURN_TICK;
      ev.push({ t: "burnTick", x: e.x, y: e.y, radius: e.radius, dmg: e.burnDmg * C.BURN_TICK });
      // The burn DoT kill credits whoever last ignited this enemy (authoritative attribution).
      // A departed igniter credits no one — the kill still resolves and drops base-value loot.
      if (e.hp <= 0) { killEnemy(w, ownerOf(w, e.burnOwner), e, ev); break; }
    }
    if (e.burn === 0) { e.burnDmg = 0; e.statusTick = 0; }
  }
}

function shockArc(w: WorldState, p: PlayerSim | null, from: Enemy, ev: SimEvent[]): void {
  arcLightning(w, p, from, 1, C.SHOCK_ARC_RANGE, C.SHOCK_ARC_DMG, "#7fe9ff", [from], ev);
}

function arcLightning(w: WorldState, p: PlayerSim | null, origin: Enemy, jumps: number, range: number, dmg: number, color: string, list: Enemy[], ev: SimEvent[]): void {
  let cur: Enemy = origin;
  for (let j = 0; j < jumps; j++) {
    let best: Enemy | null = null;
    let bestD = range * range;
    for (const e of w.enemies) {
      if (e.dead || list.indexOf(e) !== -1) continue;
      const dx = e.x - cur.x, dy = e.y - cur.y, d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = e; }
    }
    if (!best) break;
    damageEnemy(w, p ? p.id : null, best, dmg, ev);
    const killed = best.hp <= 0 && !best.dead;
    ev.push({ t: "shockArc", eid: best.id, x: cur.x, y: cur.y, tx: best.x, ty: best.y, tRadius: best.radius, dmg, color, killed });
    list.push(best);
    if (killed) killEnemy(w, p, best, ev);
    cur = best;
  }
}

// ---- strikes / kills ----

// EVERY authoritative point of enemy damage funnels through here, so the boss's phase
// thresholds are evaluated after every damage event (spec §5) — bullets, melee, burn ticks,
// arcs, thorns and barrels alike — and its transition roar can reduce/floor/queue uniformly.
function damageEnemy(w: WorldState, by: PlayerId | null, e: Enemy, dmg: number, ev: SimEvent[]): void {
  if (!e.boss) {
    e.hp -= dmg;
    return;
  }
  const boss = e.boss;
  if (boss.roar) {
    // Transition beat: 35% damage reduction (not immunity) + a hard phase floor. Damage
    // that would cross the floor is QUEUED and applies only after the roar exits.
    const reduced = dmg * (1 - BOSS.roarDamageReduction);
    const target = e.hp - reduced;
    if (target < boss.roar.floorHp) {
      boss.roar.queued += boss.roar.floorHp - target;
      boss.roar.queuedBy = by;
      e.hp = boss.roar.floorHp;
    } else {
      e.hp = target;
    }
    return;
  }
  e.hp -= dmg;
  checkBossTransition(w, e, ev);
}

// Crossing 70% / 35% starts a 1.2s transition roar immediately (mid-attack included): the
// HP floors at 62% / 27% (overflow queued), nearby bullets clear, and two slimes spawn at
// opposite marked edges. Total forced downtime across the fight is exactly 2×1.2s. The
// floor is the HARD anti-burst: even an arbitrarily large hit lands on the floor and its
// excess waits out the full roar — the boss can never be deleted through a threshold.
function checkBossTransition(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss;
  if (!boss || boss.roar) return;
  if (boss.transitionsDone >= BOSS.phaseAt.length) return;
  const threshold = BOSS.phaseAt[boss.transitionsDone] * e.maxHp;
  if (e.hp > threshold) return;
  const floorHp = BOSS.phaseFloor[boss.transitionsDone] * e.maxHp;
  const queued = Math.max(0, floorHp - e.hp);
  if (e.hp < floorHp) e.hp = floorHp;
  boss.transitionsDone++;
  boss.phase = boss.transitionsDone + 1;
  boss.attackCount = 0;
  boss.isNextRadial = true;
  boss.roar = { floorHp, queued, queuedBy: null };
  beginWindup(e, "roar");
  // The roar shockwave dissipates every projectile near the boss — a readable reset beat.
  for (const b of w.bullets) {
    if (Math.hypot(b.x - e.x, b.y - e.y) <= BOSS.roarBulletClearRadius) b.life = 0;
  }
  // Two slimes at opposite marked edges of the boss.
  const edgeAngle = w.rng.next() * Math.PI * 2;
  for (let i = 0; i < BOSS.transitionAddCount; i++) {
    spawnBossAdd(w, e, edgeAngle + i * Math.PI, ev);
  }
  ev.push({ t: "bossPhase", eid: e.id, x: e.x, y: e.y });
  ev.push({ t: "bossTransition", eid: e.id, phase: boss.phase, entering: true, queued: boss.roar.queued, hpFrac: e.hp / e.maxHp });
}

// Roar over: apply the queued overflow as a fresh damage event (it may immediately trigger
// the next transition — the 70%→35% double-cross case resolves as two full beats) and log
// the exit so the ≥20s anti-burst gate stays observable.
function endBossTransition(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss;
  if (!boss || !boss.roar) return;
  const { queued, queuedBy } = boss.roar;
  boss.roar = null;
  ev.push({ t: "bossTransition", eid: e.id, phase: boss.phase, entering: false, queued, hpFrac: e.hp / e.maxHp });
  if (queued > 0) {
    damageEnemy(w, queuedBy, e, queued, ev);
    if (e.hp <= 0 && !e.dead) killEnemy(w, ownerOf(w, queuedBy), e, ev);
  }
}

// `p` may be null when the striking actor has left (their projectile outlived them): damage,
// knockback (from the fire-time weapon), and baked-in statuses still land, but nothing is
// credited to any player.
function strikeEnemy(w: WorldState, p: PlayerSim | null, e: Enemy, hit: StrikeInfo, ev: SimEvent[]): void {
  const frozen = isFrozen(e);
  const dmg = hit.damage * (e.shock > 0 ? C.SHOCK_DMG_MULT : 1) * (frozen ? C.FROZEN_DMG_MULT : 1);
  damageEnemy(w, hit.ownerId, e, dmg, ev);
  applyKnockbackDir(p ? p.weapon : hit.fxWeapon ?? "pistol", e, hit.kbDirX, hit.kbDirY);
  applyHitStatuses(w, p, e, hit);
  const closeShotgun = !hit.isMelee && p !== null && p.weapon === "shotgun" && Math.hypot(p.x - e.x, p.y - e.y) < C.SHOTGUN_FREEZE_RANGE;
  const killed = e.hp <= 0 && !e.dead;
  const puffColor = hit.isCrit ? "#fff3c4" : ENEMY_ARCHETYPES[e.kind].tint;
  ev.push({
    t: "enemyHit", eid: e.id, dmgX: e.x, dmgY: e.y - e.radius, dmg, crit: hit.isCrit,
    puffX: hit.puffX, puffY: hit.puffY, puffColor, melee: hit.isMelee, closeShotgun, killed,
  });
  if (e.shock > 0) shockArc(w, p, e, ev);
  if (killed) killEnemy(w, p, e, ev);
}

// `p` null = the killing actor has left: the kill still resolves (death, loot, boss chest) but
// grants no personal reward (kills/combo/lifesteal) and never credits another live player.
function killEnemy(w: WorldState, p: PlayerSim | null, e: Enemy, ev: SimEvent[]): void {
  e.dead = true;
  if (p) {
    p.kills++;
    p.combo++;
    p.comboTimer = C.COMBO_WINDOW;
  }
  const big = e.kind === "boss";
  ev.push({ t: "enemyKill", eid: e.id, kind: e.kind, tier: e.tier, x: e.x, y: e.y, combo: p ? p.combo : 0 });
  if (big) endBossDanger(w, e, ev);
  // Vampire Fang: one heart per proc, on a shared 1.25s cooldown, never off summoned adds —
  // sustain comes from scarcity decisions, not add-farming.
  if (p && !e.isSummoned && p.mods.lifestealChance > 0 && p.fangCd === 0
    && p.hp < p.maxHp && w.rng.next() < p.mods.lifestealChance) {
    p.hp++;
    p.fangCd = FANG_PROC_COOLDOWN;
    ev.push({ t: "heal", pid: p.id, x: e.x, y: e.y });
  }
  // The shipped elite affix: SPLIT — on death the elite breaks into swarm units (readable,
  // summoned, so they feed no hearts/Fang).
  if (e.tier === "elite" && !w.isRunOver) {
    for (let i = 0; i < ELITE_SPLIT_COUNT; i++) {
      const a = w.rng.next() * Math.PI * 2;
      const sx = e.x + Math.cos(a) * (e.radius + 6);
      const sy = e.y + Math.sin(a) * (e.radius + 6);
      if (isWall(w, sx, sy)) continue;
      const child = createEnemy(e.kind, sx, sy, w.floor, w.rng, w.nextEnemyId++, {
        tier: "swarm", isSummoned: true, players: w.encounterPlayers,
      });
      w.enemies.push(child);
      ev.push({ t: "enemySpawn", eid: child.id, kind: child.kind, tier: child.tier, x: sx, y: sy });
    }
  }
  dropLoot(w, p, e, ev);
}

// Boss death ends danger immediately (spec §5): every remaining enemy and queued
// reinforcement despawns (no loot, no credit) and the exit opens regardless of adds.
function endBossDanger(w: WorldState, boss: Enemy, ev: SimEvent[]): void {
  w.bullets = w.bullets.filter((b) => b.friendly);
  w.pendingSpawns = [];
  for (const other of w.enemies) {
    if (other === boss || other.dead) continue;
    other.dead = true;
    ev.push({ t: "puff", x: other.x, y: other.y, n: 6, color: ENEMY_ARCHETYPES[other.kind].tint });
  }
}

function dropLoot(w: WorldState, p: PlayerSim | null, e: Enemy, ev: SimEvent[]): void {
  if (e.kind === "boss") {
    w.chests.push({ id: w.nextChestId++, kind: "boss", x: e.x, y: e.y, radius: 18, opened: false });
    return;
  }
  // An unowned kill (departed actor) drops a face-value coin — no player's combo multiplier.
  if (w.rng.next() < 0.5) w.pickups.push(makePickup(w, "coin", e.x, e.y, ev, p ? comboCoinValue(p) : 1));
  // Ambient hearts (§2): halved rate, party-scaled in co-op, never from summoned adds.
  if (!e.isSummoned && w.rng.next() < SUSTAIN.enemyHeartDrop * coopHeartRateMult(w.encounterPlayers)) {
    w.pickups.push(makePickup(w, "heart", e.x + 10, e.y, ev));
  }
}

function makePickup(w: WorldState, kind: "heart" | "coin", x: number, y: number, ev: SimEvent[], value?: number): Pickup {
  const color = kind === "heart" ? "#ff6a6a" : "#ffd27a";
  ev.push({ t: "lootDrop", x, y, color });
  if (kind === "heart") w.heartsThisFloor++;
  return { id: w.nextPickupId++, kind, x, y, radius: 13, weapon: null, value };
}

// ---- per-tick systems ----

function updatePlayer(w: WorldState, p: PlayerSim, input: InputCmd, dt: number, ev: SimEvent[]): void {
  let ix = input.moveX;
  let iy = input.moveY;
  const len = Math.hypot(ix, iy) || 1;
  ix /= len; iy /= len;
  if (ix !== 0) p.facing = ix > 0 ? 1 : -1;

  const speed = PLAYER.moveSpeed * p.mods.moveSpeedMult;
  // Snap accumulated float dust to zero so a cooldown that is an exact multiple of the
  // tick (Second Wind Lv3: 0.35s at 60Hz) recovers on its true tick, not one late.
  p.dashCd = Math.max(0, p.dashCd - dt);
  if (p.dashCd < 1e-9) p.dashCd = 0;
  if (input.dash && p.dashCd === 0 && (ix || iy)) {
    p.dashTime = PLAYER.dashActive; p.dashCd = dashCooldown(p); p.dashDx = ix; p.dashDy = iy;
    // The dash iframe is its own window (0.18s, covering the 0.16s active dash + tail):
    // SET, never max'd against post-hit protection, so the two can neither refresh nor
    // extend each other.
    p.dashInvuln = PLAYER.dashIframe;
    ev.push({ t: "dashStart", pid: p.id, x: p.x, y: p.y });
  }
  let mvx: number, mvy: number;
  if (p.dashTime > 0) {
    p.dashTime -= dt;
    mvx = p.dashDx * PLAYER.dashSpeed * dt; mvy = p.dashDy * PLAYER.dashSpeed * dt;
    ev.push({ t: "dashTrail", pid: p.id, x: p.x, y: p.y });
  } else {
    mvx = ix * speed * dt; mvy = iy * speed * dt;
  }
  [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, mvx, 0);
  [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, 0, mvy);
  if (p.dashTime > 0 && w.props.length > 0) dashBreakProps(w, p, ev);
  p.invuln = Math.max(0, p.invuln - dt);
  p.dashInvuln = Math.max(0, p.dashInvuln - dt);
}

function updateShooting(w: WorldState, p: PlayerSim, input: InputCmd, dt: number, ev: SimEvent[]): void {
  p.fireCd = Math.max(0, p.fireCd - dt);
  if (input.firing && p.fireCd === 0) {
    const wep = WEAPONS[p.weapon];
    if (wep.melee) {
      startMeleeSwing(w, p, ev);
      return;
    }
    const muzzleX = p.x + Math.cos(p.aimAngle) * 18;
    const muzzleY = p.y + Math.sin(p.aimAngle) * 18;
    const spec = resolveShot(p, p.weapon);
    for (const b of fire(spec, muzzleX, muzzleY, p.aimAngle, w.rng, p.id)) {
      // Anchor lag-comp at fire time: record the tick + the shooter's rewind depth NOW, so hit
      // tests use the shooter's fire-time view and decay to present as the projectile travels.
      b.bornTick = w.tick;
      b.lagRewind = p.rewindTicks;
      w.bullets.push(b);
    }
    p.fireCd = wep.fireCd / currentFireRate(p);
    p.shotSeq++;
    ev.push({ t: "shot", pid: p.id, weapon: p.weapon, x: muzzleX, y: muzzleY, aim: p.aimAngle, px: p.x, py: p.y });
    const kb = C.FIRE_KNOCKBACK[p.weapon];
    if (kb !== 0) {
      [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, -Math.cos(p.aimAngle) * kb, 0);
      [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, 0, -Math.sin(p.aimAngle) * kb);
    }
  }
}

function startMeleeSwing(w: WorldState, p: PlayerSim, ev: SimEvent[]): void {
  const wep = WEAPONS[p.weapon];
  const m = wep.melee;
  if (!m) return;
  const isCrit = p.mods.critChance > 0 && w.rng.next() < p.mods.critChance;
  const baseDmg = wep.damage * currentDamageMult(p);
  p.meleeSwing = {
    timer: m.swingDur ?? 0.2,
    duration: m.swingDur ?? 0.2,
    aim: p.aimAngle,
    arc: m.arc,
    reach: m.reach,
    isThrust: m.isThrust === true,
    color: wep.color,
    damage: isCrit ? baseDmg * p.mods.critMult : baseDmg,
    isCrit,
    hitList: null,
    burn: wep.burn,
    chill: wep.chill,
    shock: wep.shock,
    originX: p.x,
    originY: p.y,
    bornTick: w.tick,
    lagRewind: p.rewindTicks,
  };
  p.fireCd = wep.fireCd / currentFireRate(p);
  p.shotSeq++;
  // Slash-wind fires at the pre-knockback position (x,y); the small tip burst fires after
  // the weapon's self-knockback (bx,by). They differ only for the spear (its kb > 0).
  const preX = p.x, preY = p.y;
  const kb = C.FIRE_KNOCKBACK[p.weapon];
  if (kb !== 0) {
    [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, -Math.cos(p.aimAngle) * kb, 0);
    [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, 0, -Math.sin(p.aimAngle) * kb);
  }
  // The fire-time attacker pose is the post-knockback one (what the first hit test would see).
  p.meleeSwing.originX = p.x;
  p.meleeSwing.originY = p.y;
  ev.push({ t: "meleeSwing", pid: p.id, weapon: p.weapon, x: preX, y: preY, aim: p.aimAngle, bx: p.x, by: p.y });
}

// The attacker pose a swing's hit tests use: while the swing's fire-time rewind is active
// (online lag comp), the swing-START pose — both actors are then evaluated at fire time, so an
// attacker moving after the swing can neither drag the arc onto a target nor have a laggy swing
// judged from a pose it never fired at. Solo/prediction rewind is 0 → the live pose (unchanged).
function swingPose(w: WorldState, p: PlayerSim, swing: MeleeSwing): [number, number] {
  if (fireTimeRewind(w, swing.bornTick, swing.lagRewind) > 0) return [swing.originX, swing.originY];
  return [p.x, p.y];
}

function isPointInMeleeHit(px: number, py: number, x: number, y: number, radius: number, swing: MeleeSwing): boolean {
  const dx = x - px;
  const dy = y - py;
  const dist = Math.hypot(dx, dy);
  if (dist > swing.reach + radius) return false;
  const cos = Math.cos(swing.aim);
  const sin = Math.sin(swing.aim);
  if (swing.isThrust) {
    const fwd = dx * cos + dy * sin;
    if (fwd < -radius * 0.4 || fwd > swing.reach + radius) return false;
    const lat = Math.abs(dx * sin - dy * cos);
    return lat < C.MELEE_THRUST_WIDTH + radius;
  }
  let ang = Math.atan2(dy, dx) - swing.aim;
  while (ang > Math.PI) ang -= Math.PI * 2;
  while (ang < -Math.PI) ang += Math.PI * 2;
  const angPad = Math.atan2(radius, Math.max(dist, 1));
  return Math.abs(ang) <= swing.arc * 0.5 + angPad;
}

function updateBullets(w: WorldState, dt: number, ev: SimEvent[]): void {
  for (const b of w.bullets) {
    if (b.friendly && b.homing !== undefined) steerHoming(w, b, dt);
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    if (isWall(w, b.x, b.y)) {
      if (b.bounce !== undefined && b.bounce > 0) { bounceOffWall(w, b, dt, ev); continue; }
      b.life = 0; ev.push({ t: "bulletWall", x: b.x, y: b.y, aim: Math.atan2(-b.vy, -b.vx) }); continue;
    }
    if (!b.friendly) {
      for (const p of w.players.values()) {
        if (!isProtected(p) && !p.isDown && p.hp > 0 && Math.hypot(p.x - b.x, p.y - b.y) < p.pr + b.radius) {
          b.life = 0;
          ev.push({ t: "bulletExpire", x: b.x, y: b.y, color: b.color });
          damagePlayer(w, p, b.damage, ev);
          break;
        }
      }
    }
  }
  w.bullets = w.bullets.filter((b) => b.life > 0);
}

function steerHoming(w: WorldState, b: Bullet, dt: number): void {
  const rate = b.homing;
  if (rate === undefined || rate <= 0) return;
  const RANGE = 260;
  let best: Enemy | null = null;
  let bestD = RANGE * RANGE;
  for (const e of w.enemies) {
    if (e.dead) continue;
    const dx = e.x - b.x, dy = e.y - b.y, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = e; }
  }
  if (!best) return;
  const speed = Math.hypot(b.vx, b.vy) || 1;
  const cur = Math.atan2(b.vy, b.vx);
  let delta = Math.atan2(best.y - b.y, best.x - b.x) - cur;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const maxTurn = rate * dt;
  const turn = delta > maxTurn ? maxTurn : delta < -maxTurn ? -maxTurn : delta;
  const a = cur + turn;
  b.vx = Math.cos(a) * speed; b.vy = Math.sin(a) * speed;
}

function bounceOffWall(w: WorldState, b: Bullet, dt: number, ev: SimEvent[]): void {
  const px = b.x - b.vx * dt, py = b.y - b.vy * dt;
  let reflected = false;
  if (isWall(w, b.x, py)) { b.vx = -b.vx; reflected = true; }
  if (isWall(w, px, b.y)) { b.vy = -b.vy; reflected = true; }
  if (!reflected) { b.vx = -b.vx; b.vy = -b.vy; }
  b.x = px; b.y = py;
  b.bounce = (b.bounce ?? 0) - 1;
  ev.push({ t: "bulletBounce", x: b.x, y: b.y, aim: Math.atan2(b.vy, b.vx), color: b.color });
}

// Record every enemy's current position into the ring (one entry per world tick). Called at the
// START of the world step so the newest record is the previous tick's end state — i.e. exactly
// what a client rendered in the last snapshot. Stale entries for despawned enemies are pruned so
// the map stays bounded. Pure + deterministic; never read when rewindTicks is 0 (solo), so the
// golden-master behavior is unchanged.
export function recordHistory(w: WorldState): void {
  const H = C.LAGCOMP_HISTORY;
  w.histHead = (w.histHead + 1) % H;
  const slot = w.histHead;
  for (const e of w.enemies) {
    let h = w.enemyHist.get(e.id);
    if (!h) { h = { x: new Array(H).fill(e.x), y: new Array(H).fill(e.y) }; w.enemyHist.set(e.id, h); }
    h.x[slot] = e.x; h.y[slot] = e.y;
  }
  if (w.histCount < H) w.histCount++;
  // Prune history for enemies no longer present (killed/removed) so the map can't grow forever.
  if (w.enemyHist.size > w.enemies.length) {
    const live = new Set<number>();
    for (const e of w.enemies) live.add(e.id);
    for (const id of w.enemyHist.keys()) if (!live.has(id)) w.enemyHist.delete(id);
  }
}

// The position of enemy `e` as the shooter saw it `rewindTicks` ticks ago (offset rewindTicks-1
// into the ring; rewind 1 == the most recent recorded tick). rewindTicks <= 0 returns the
// present authoritative position (the solo/prediction path — identical behavior). Clamped to the
// history window + LAGCOMP_MAX_TICKS so a hit can never be rewound to an impossible time.
// Effective rewind depth for a hit whose lag-comp is anchored at FIRE time. As the projectile/
// swing ages, the shooter's past view converges to the present, so the rewind shrinks one tick
// per tick and reaches 0 — after which collisions test present positions (correct for slow
// projectiles). bornTick/lagRewind undefined (solo, enemy fire) => 0 (present-time), unchanged.
export function fireTimeRewind(w: WorldState, bornTick: number | undefined, lagRewind: number | undefined): number {
  if (bornTick === undefined || lagRewind === undefined || lagRewind <= 0) return 0;
  const age = w.tick - bornTick;
  const eff = lagRewind - (age > 0 ? age : 0);
  return eff > 0 ? eff : 0;
}

export function rewoundEnemyPos(w: WorldState, e: Enemy, rewindTicks: number): [number, number] {
  if (rewindTicks <= 0) return [e.x, e.y];
  const r = Math.min(rewindTicks, C.LAGCOMP_MAX_TICKS, w.histCount);
  if (r <= 0) return [e.x, e.y];
  const h = w.enemyHist.get(e.id);
  if (!h) return [e.x, e.y];
  const slot = (w.histHead - (r - 1) + C.LAGCOMP_HISTORY * 2) % C.LAGCOMP_HISTORY;
  return [h.x[slot], h.y[slot]];
}

// Reinforcement waves (§4): pending units trickle in whenever the LIVING active threat has
// room under the ActiveThreatCap, staggered so a wave reads as a wave (Emberreach
// reinforces faster). Deterministic — pure function of state, positions pre-rolled at
// floor generation, spawn grace protects fairness.
function releaseReinforcements(w: WorldState, dt: number, ev: SimEvent[]): void {
  if (w.pendingSpawns.length === 0) return;
  w.spawnReleaseCd -= dt;
  if (w.spawnReleaseCd > 0) return;
  let living = 0;
  for (const e of w.enemies) {
    if (!e.dead && e.kind !== "boss") living += threatCostOf(e.kind, e.tier);
  }
  const cap = activeThreatCap(w.floor) * coopThreatMult(w.encounterPlayers);
  const next = w.pendingSpawns[0];
  if (living + threatCostOf(next.kind, next.tier) > cap) return;
  // Its spawn grace never ticked while pending, so it activates with the full grace window.
  w.pendingSpawns.shift();
  w.enemies.push(next);
  w.spawnReleaseCd = REINFORCE_STAGGER / BIOME_PRESSURE[biomeIndexForFloor(w.floor)].reinforceRate;
  ev.push({ t: "enemySpawn", eid: next.id, kind: next.kind, tier: next.tier, x: next.x, y: next.y });
}

function updateEnemies(w: WorldState, dt: number, ev: SimEvent[]): void {
  // Stage C: every strike is attributed to the player who caused it (bullet.owner / swing owner
  // / burn igniter), NOT a single "primary player". Kills/coins/combo/lifesteal go to the right
  // authoritative player. Solo resolves to the one player, so behavior is unchanged.
  releaseReinforcements(w, dt, ev);
  refreshFlowField(w, dt);
  for (const e of w.enemies) {
    tickStatuses(w, e, dt, ev);
    if (e.dead) continue;
    if (e.spawnTimer > 0) e.spawnTimer = e.spawnTimer > dt ? e.spawnTimer - dt : 0;
    if (e.attack.cooldown > 0) e.attack.cooldown = e.attack.cooldown > dt ? e.attack.cooldown - dt : 0;
    // Boss pack-surge order: the delay elapses, then a short burst of chase speed.
    if (e.surgeDelay > 0) {
      e.surgeDelay -= dt;
      if (e.surgeDelay <= 0) { e.surgeDelay = 0; e.surgeTime = BOSS.packSurgeDuration; }
    } else if (e.surgeTime > 0) {
      e.surgeTime = e.surgeTime > dt ? e.surgeTime - dt : 0;
    }

    updateEnemyAI(w, e, dt, ev);
    applyKnockbackDecay(w, e, dt);

    const isMoving = e.attack.phase === "none" || (e.attack.phase === "active" && e.attack.move === "lunge");
    e.hopMove += ((isMoving ? 1 : 0) - e.hopMove) * Math.min(1, dt * 9);
    e.hopClock += dt * (1 + e.hopMove * 1.5);

    for (const victim of w.players.values()) {
      if (!isProtected(victim) && !victim.isDown && victim.hp > 0
        && Math.hypot(victim.x - e.x, victim.y - e.y) < victim.pr + e.radius && canTouchDamage(e)) {
        damagePlayer(w, victim, contactDamageOf(e), ev);
        if (e.kind === "skeleton" && e.attack.phase === "active") lungeImpact(w, victim, e, ev);
        applyThorns(w, victim, victim, e, ev);
        // Solo aborts the enemy loop on death (game over). Co-op and the authoritative shared
        // world keep processing — a downed player doesn't stop the world.
        if (victim.hp <= 0 && !w.isCoop && !w.isShared) return;
      }
    }

    for (const b of w.bullets) {
      if (!b.friendly) continue;
      if (b.hitList && b.hitList.indexOf(e) !== -1) continue;
      // Immutable attribution: the bullet keeps flying and dealing damage after its owner leaves
      // (shooter null) — it just credits no one. Never re-attributed to another live player.
      const shooter = ownerOf(w, b.owner);
      // Lag comp anchored at FIRE time (decays as the bullet travels): a hitscan-fast shot tests
      // the shooter's fire-time view; a slow projectile tests present positions. 0 in solo.
      const [btx, bty] = rewoundEnemyPos(w, e, fireTimeRewind(w, b.bornTick, b.lagRewind));
      if (Math.hypot(b.x - btx, b.y - bty) < b.radius + e.radius) {
        strikeEnemy(w, shooter, e, {
          damage: b.damage, isCrit: b.isCrit, puffX: b.x, puffY: b.y, kbDirX: b.vx, kbDirY: b.vy,
          burn: b.burn, chill: b.chill, shock: b.shock, isMelee: false,
          ownerId: b.owner, fxWeapon: b.fx ?? null,
        }, ev);
        if (b.chain !== undefined && b.chain > 0) {
          (b.hitList ??= []).push(e);
          arcLightning(w, shooter, e, b.chain ?? 0, b.chainRange ?? 130, b.damage * 0.7, b.color, (b.hitList ??= []), ev);
          b.life = 0;
        } else if (b.pierce > 0) { b.pierce--; (b.hitList ??= []).push(e); }
        else b.life = 0;
      }
    }

    // Each player resolves their own melee swing against this enemy (solo: one player).
    for (const player of w.players.values()) {
      const swing = player.meleeSwing;
      if (!swing || swing.timer <= 0) continue;
      if (swing.hitList && swing.hitList.indexOf(e) !== -1) continue;
      // Fire-time lag comp for the whole swing: BOTH actors evaluate at fire time while the
      // rewind is active (attacker = swing-start pose, target = rewound position).
      const [mtx, mty] = rewoundEnemyPos(w, e, fireTimeRewind(w, swing.bornTick, swing.lagRewind));
      const [sx, sy] = swingPose(w, player, swing);
      if (isPointInMeleeHit(sx, sy, mtx, mty, e.radius, swing)) {
        const kbDirX = Math.cos(swing.aim);
        const kbDirY = Math.sin(swing.aim);
        const puffDist = swing.isThrust ? swing.reach * 0.65 : swing.reach * 0.55;
        strikeEnemy(w, player, e, {
          damage: swing.damage, isCrit: swing.isCrit,
          puffX: player.x + kbDirX * puffDist, puffY: player.y + kbDirY * puffDist,
          kbDirX, kbDirY, burn: swing.burn, chill: swing.chill, shock: swing.shock, isMelee: true,
          ownerId: player.id, fxWeapon: null,
        }, ev);
        (swing.hitList ??= []).push(e);
      }
    }
  }
  w.enemies = w.enemies.filter((e) => !e.dead);
}

function canTouchDamage(e: Enemy): boolean {
  if (e.kind === "ghost") return e.attack.windup >= C.GHOST_SOLID_AT;
  if (e.kind === "boss" && e.attack.move === "hopslam" && e.attack.phase === "active") return false;
  return true;
}

// Damage tiers (§3): light/contact stays 1 at every floor; only a brute's authored,
// clearly telegraphed commitment (the skeleton's lunge, mid-active) deals the heavy 2.
function contactDamageOf(e: Enemy): number {
  if (e.tier === "brute" && e.kind === "skeleton" && e.attack.phase === "active") return BRUTE_HEAVY_DAMAGE;
  return e.touchDamage;
}

function lungeImpact(w: WorldState, p: PlayerSim, e: Enemy, ev: SimEvent[]): void {
  const push = 26, ang = e.attack.lockedAngle;
  [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, Math.cos(ang) * push, 0);
  [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, 0, Math.sin(ang) * push);
  ev.push({ t: "trauma", amount: 0.16 });
}

function applyThorns(w: WorldState, src: PlayerSim, victim: PlayerSim, e: Enemy, ev: SimEvent[]): void {
  if (victim.mods.thorns <= 0 || e.dead) return;
  damageEnemy(w, victim.id, e, victim.mods.thorns, ev);
  ev.push({ t: "thornsHit", eid: e.id, x: e.x, y: e.y, radius: e.radius, dmg: victim.mods.thorns, tint: ENEMY_ARCHETYPES[e.kind].tint });
  if (e.hp <= 0 && !e.dead) killEnemy(w, src, e, ev);
}

// ---- enemy AI ----

function updateEnemyAI(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  switch (e.kind) {
    case "spitter": updateSpitter(w, e, dt, ev); return;
    case "skeleton": updateSkeleton(w, e, dt, ev); return;
    case "ghost": updateGhost(w, e, dt, ev); return;
    case "boss": updateBoss(w, e, dt, ev); return;
    default: updateChaser(w, e, dt); return;
  }
}

function updateSkeleton(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    if (stepWindupTimer(w, e, dt, C.SKELETON_WINDUP, C.SKELETON_LOCK, false)) {
      a.phase = "active"; a.time = 0; a.windup = 0; a.cooldown = C.SKELETON_CD * attackCdMultOf(e);
      ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 1, gain: 0.85, trauma: 0.12 });
    }
    return;
  }
  if (a.phase === "active") {
    a.time += dt;
    const step = C.SKELETON_LUNGE_SPEED * dt;
    moveEnemyBy(w, e, Math.cos(a.lockedAngle) * step, Math.sin(a.lockedAngle) * step);
    ev.push({ t: "lungeTrail", x: e.x, y: e.y });
    if (a.time >= C.SKELETON_LUNGE_DUR) enterRecover(e);
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= C.SKELETON_RECOVER) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const dx = w.targetX - e.x, dy = w.targetY - e.y;
  const dist = Math.hypot(dx, dy) || 1;
  if (dist <= C.SKELETON_TRIGGER && a.cooldown === 0 && e.spawnTimer === 0
    && hasLineOfSight(w, e.x, e.y, w.targetX, w.targetY)) {
    beginWindup(e, "lunge");
    ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.5, gain: 0.6, trauma: 0 });
    return;
  }
  const chase = chaseAngle(w, e);
  applyChaseStep(w, e, dt, chase, e.speed * dt);
}

function updateChaser(w: WorldState, e: Enemy, dt: number): void {
  const arch = ENEMY_ARCHETYPES[e.kind];
  if (!findTarget(w, e.x, e.y)) return;
  let angle = chaseAngle(w, e);
  if (arch.movement === "zigzag") { e.zig += dt * 5; angle += Math.sin(e.zig) * 0.9; }
  let step = e.speed * dt;
  if (e.kind === "slime") step *= slimeHopPulse(e);
  if (e.surgeTime > 0) step *= BOSS.packSurgeSpeedMult;
  applyChaseStep(w, e, dt, angle, step);
}

function updateGhost(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  const has = findTarget(w, e.x, e.y);
  const angle = has ? Math.atan2(w.targetY - e.y, w.targetX - e.x) : e.zig;
  const near = has && (w.targetX - e.x) ** 2 + (w.targetY - e.y) ** 2 <= C.GHOST_SOLID_RANGE * C.GHOST_SOLID_RANGE;
  const rate = dt / C.GHOST_SOLID_TIME;
  const prev = a.windup;
  a.windup = near ? Math.min(1, a.windup + rate) : Math.max(0, a.windup - rate);
  if (prev < C.GHOST_SOLID_AT && a.windup >= C.GHOST_SOLID_AT) ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 1.7, gain: 0.35, trauma: 0 });
  const step = e.speed * dt;
  moveEnemyBy(w, e, Math.cos(angle) * step, Math.sin(angle) * step);
}

function updateSpitter(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    if (stepWindupTimer(w, e, dt, C.SPITTER_WINDUP, C.SPITTER_LOCK, false)) {
      spitterFire(w, e, ev);
      enterRecover(e);
    }
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= C.SPITTER_RECOVER) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const dx = w.targetX - e.x, dy = w.targetY - e.y;
  const dist = Math.hypot(dx, dy) || 1;
  const toTarget = Math.atan2(dy, dx);
  if (dist >= C.SPITTER_FLEE && dist <= C.SPITTER_APPROACH && a.cooldown === 0 && e.spawnTimer === 0
    && hasLineOfSight(w, e.x, e.y, w.targetX, w.targetY)) {
    beginWindup(e, "spit");
    ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 1.4, gain: 0.5, trauma: 0 });
    return;
  }
  let dir = 0;
  if (dist < C.SPITTER_FLEE) dir = -1;
  else if (dist > C.SPITTER_APPROACH) dir = 1;
  if (dir !== 0) {
    const step = e.speed * dt * dir;
    moveEnemyBy(w, e, Math.cos(toTarget) * step, Math.sin(toTarget) * step);
  }
}

function spitterFire(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack;
  const n = w.floor >= C.SPITTER_SPREAD_FLOOR ? 3 : 1;
  const mx = e.x + Math.cos(a.lockedAngle) * (e.radius + 4);
  const my = e.y + Math.sin(a.lockedAngle) * (e.radius + 4);
  for (let i = 0; i < n; i++) {
    const off = n === 1 ? 0 : (i - 1) * C.GLOB_SPREAD;
    spawnEnemyBullet(w, mx, my, a.lockedAngle + off, 300, 7, 1, "#ff5a7a", 2.5);
  }
  a.cooldown = C.SPITTER_CD * attackCdMultOf(e);
  ev.push({ t: "spitMuzzle", x: mx, y: my });
}

// Elite affix package: 20% shorter commit cooldowns (§4) — never a damage multiplier.
function attackCdMultOf(e: Enemy): number {
  return TIERS[e.tier].attackCdMult;
}

// The Slime King (spec §5, calibrated to ~37.5s median / ≥20s absolute solo TTK). Phase
// changes ride damage events (checkBossTransition); this state machine owns the cadence:
//   P1 (100–70%): hop slam every 3.2s; adds 1 slime @4.5s then every 6.5s (cap 5).
//   P2 (70–35%):  2.7s cadence alternating hop / 10-glob radial; every 2nd radial orders
//                 the living slimes into a delayed pack surge (pressure, no extra HP).
//   P3 (35–0%):   2.25s cadence; hop landings fire 4 cardinal globs; every 3rd attack is a
//                 telegraphed 3s arena squeeze; chase +12%; adds 2 slimes / 7s (cap 7).
function updateBoss(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const boss = e.boss;
  if (!boss) return;
  const a = e.attack;

  // Add pacing pauses during the transition roar (the roar spawns its own marked pair).
  if (!boss.roar) {
    boss.addTimer -= dt;
    if (boss.addTimer <= 0) {
      boss.addTimer = BOSS.addInterval[boss.phase];
      const cap = BOSS.addCap[boss.phase];
      for (let i = 0; i < BOSS.addBatch[boss.phase]; i++) {
        if (countBossAdds(w) >= cap) break;
        spawnBossAdd(w, e, w.rng.next() * Math.PI * 2, ev);
      }
    }
  }

  if (a.phase === "windup") { bossWindup(w, e, dt, ev); return; }
  if (a.phase === "active") { bossActive(w, e, dt, ev); return; }
  if (a.phase === "recover") {
    a.time += dt;
    const recDur = a.move === "hopslam" ? BOSS.hopRecover : BOSS.radialRecover;
    if (a.time >= recDur) enterIdle(e);
    return;
  }

  if (a.cooldown === 0 && e.spawnTimer === 0) { bossBeginAttack(e, ev); return; }
  bossChase(w, e, dt);
}

// Living boss-summoned adds (the cadence cap counts only summons, never floor enemies).
function countBossAdds(w: WorldState): number {
  let n = 0;
  for (const e of w.enemies) if (!e.dead && e.isSummoned && e.kind !== "boss") n++;
  return n;
}

function bossBeginAttack(e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  boss.attackCount++;
  e.attack.cooldown = BOSS.attackCd[boss.phase];
  // P3: every 3rd attack is the arena squeeze (1.0s telegraph, 3.0s hold).
  if (boss.phase >= 3 && boss.attackCount % BOSS.squeezeEvery === 0) {
    beginWindup(e, "squeeze");
    ev.push({ t: "cue", name: "bossSpawn", x: e.x, y: e.y, rate: 0.8, gain: 0.7, trauma: 0.1 });
    return;
  }
  const useRadial = boss.phase === 2 && boss.isNextRadial;
  if (boss.phase === 2) boss.isNextRadial = !boss.isNextRadial;
  beginWindup(e, useRadial ? "radial" : "hopslam");
  ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: useRadial ? 0.6 : 0.4, gain: 0.7, trauma: 0 });
}

function bossWindup(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.move === "roar") {
    a.time += dt;
    a.windup = Math.min(1, a.time / BOSS.roarDuration);
    if (a.time >= BOSS.roarDuration) {
      enterIdle(e);
      endBossTransition(w, e, ev);
    }
    return;
  }
  if (a.move === "radial") {
    a.time += dt;
    a.windup = Math.min(1, a.time / BOSS.radialWindup);
    if (a.time >= BOSS.radialWindup) { bossRadialFire(w, e, ev); enterRecover(e); }
    return;
  }
  if (a.move === "squeeze") {
    a.time += dt;
    a.windup = Math.min(1, a.time / BOSS.squeezeTelegraph);
    if (a.time >= BOSS.squeezeTelegraph) { a.phase = "active"; a.time = 0; a.windup = 0; }
    return;
  }
  if (stepWindupTimer(w, e, dt, BOSS.hopWindup, BOSS.hopLock, true)) {
    a.phase = "active"; a.time = 0; a.windup = 0;
    ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 0.6, gain: 0.9, trauma: 0 });
  }
}

function bossActive(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.move === "squeeze") { bossSqueezeActive(w, e, dt, ev); return; }
  a.time += dt;
  const prev = a.windup;
  a.windup = Math.min(1, a.time / BOSS.hopAir);
  const rem = 1 - prev;
  if (rem > 0.0001) {
    const f = Math.min(1, (a.windup - prev) / rem);
    e.x += (a.markX - e.x) * f;
    e.y += (a.markY - e.y) * f;
  }
  if (a.time >= BOSS.hopAir) { bossLand(w, e, ev); enterRecover(e); }
}

// The arena squeeze: a safe circle around the boss shrinks over 3s — stand inside it or
// take ring damage. Forces movement TOWARD the fight while the boss holds still (the DPS
// window is the reward for reading it). windup carries squeeze progress for the renderer.
function bossSqueezeActive(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  a.time += dt;
  const t = Math.min(1, a.time / BOSS.squeezeDuration);
  a.windup = t;
  const safeR = BOSS.squeezeStartRadius + (BOSS.squeezeEndRadius - BOSS.squeezeStartRadius) * t;
  for (const p of w.players.values()) {
    if (isProtected(p) || p.isDown || p.hp <= 0) continue;
    if (Math.hypot(p.x - e.x, p.y - e.y) > safeR) damagePlayer(w, p, BOSS.squeezeDamage, ev);
  }
  if (a.time >= BOSS.squeezeDuration) enterIdle(e);
}

function bossLand(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack, boss = e.boss;
  const x = a.markX, y = a.markY;
  // Slam center hits for 2; the outer shockwave ring for 1 (spec §5 damage table).
  for (const p of w.players.values()) {
    if (isProtected(p) || p.isDown || p.hp <= 0) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < BOSS.slamInnerRadius) damagePlayer(w, p, BOSS.slamCenterDamage, ev);
    else if (d < BOSS.slamRadius) damagePlayer(w, p, BOSS.slamOuterDamage, ev);
  }
  ev.push({ t: "bossSlam", x, y });
  if (boss && boss.phase >= 3) {
    for (let i = 0; i < 4; i++) spawnEnemyBullet(w, x, y, (i / 4) * 6.28, 220, 7, BOSS.globDamage, "#a24bff", 2.5);
  }
}

function bossRadialFire(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss;
  const parity = boss ? boss.burstParity : 0;
  if (boss) boss.burstParity = parity ^ 1;
  const base = parity ? Math.PI / BOSS.radialCount : 0;
  for (let i = 0; i < BOSS.radialCount; i++) {
    spawnEnemyBullet(w, e.x, e.y, base + (i / BOSS.radialCount) * 6.28, 260, 7, BOSS.globDamage, "#a24bff", 2.6);
  }
  ev.push({ t: "radialBurst", x: e.x, y: e.y });
  // Every 2nd radial orders the living slimes into a delayed pack surge — coordinated
  // pressure with zero extra HP.
  if (boss && boss.burstParity === 0) {
    for (const add of w.enemies) {
      if (add.dead || !add.isSummoned || add.kind !== "slime") continue;
      add.surgeDelay = BOSS.packSurgeDelay;
    }
  }
}

function bossChase(w: WorldState, e: Enemy, dt: number): void {
  if (!findTarget(w, e.x, e.y)) return;
  const angle = Math.atan2(w.targetY - e.y, w.targetX - e.x);
  const mult = e.boss && e.boss.phase >= 3 ? BOSS.p3ChaseMult : 1;
  const step = e.speed * mult * dt;
  moveEnemyBy(w, e, Math.cos(angle) * step, Math.sin(angle) * step);
}

// Spawn one summoned slime at `angle` off the boss's edge. Summons are excluded from
// hearts/Fang (isSummoned) so add pressure never becomes a sustain farm.
function spawnBossAdd(w: WorldState, e: Enemy, angle: number, ev: SimEvent[]): void {
  const mx = e.x + Math.cos(angle) * (e.radius + 20);
  const my = e.y + Math.sin(angle) * (e.radius + 20);
  if (isWall(w, mx, my)) { ev.push({ t: "bossAddSpawn", eid: e.id, x: e.x, y: e.y, mx: e.x, my: e.y, spawned: false }); return; }
  w.enemies.push(createEnemy("slime", mx, my, w.floor, w.rng, w.nextEnemyId++, {
    isSummoned: true, players: w.encounterPlayers,
  }));
  ev.push({ t: "bossAddSpawn", eid: e.id, x: e.x, y: e.y, mx, my, spawned: true });
}

// ---- shared attack helpers ----

function findTarget(w: WorldState, x: number, y: number): boolean {
  let bestD = Infinity, found = false;
  for (const p of w.players.values()) {
    if (p.isDown || p.hp <= 0) continue;
    const dx = p.x - x, dy = p.y - y, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; w.targetX = p.x; w.targetY = p.y; found = true; }
  }
  for (const r of w.remoteTargets) {
    if (r.isDown) continue;
    const dx = r.x - x, dy = r.y - y, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; w.targetX = r.x; w.targetY = r.y; found = true; }
  }
  return found;
}

function hasLineOfSight(w: WorldState, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = x1 - x0, dy = y1 - y0;
  const steps = Math.ceil(Math.hypot(dx, dy) / (TILE * 0.5));
  if (steps <= 1) return !isWall(w, x1, y1);
  const sx = dx / steps, sy = dy / steps;
  let x = x0 + sx, y = y0 + sy;
  for (let i = 1; i < steps; i++) {
    if (isWall(w, x, y)) return false;
    x += sx; y += sy;
  }
  return true;
}

function refreshFlowField(w: WorldState, dt: number): void {
  w.flowCd -= dt;
  const d = w.dungeon;
  // Rebuild trigger keys off a combined hash of EVERY living source tile (players + legacy
  // remote targets), so ANY player crossing a tile refreshes multi-source paths — not only the
  // primary. Solo has exactly one player, so the hash changes precisely when that player's
  // tile changes: identical rebuild ticks, goldens unchanged. The field itself is sourced from
  // every living player, so enemies flow toward whichever player is nearest.
  let keyHash = 0;
  let anyUp = false;
  for (const pl of w.players.values()) {
    if (pl.isDown || pl.hp <= 0) continue;
    anyUp = true;
    keyHash = (Math.imul(keyHash, 31) + Math.floor(pl.y / TILE) * d.w + Math.floor(pl.x / TILE)) | 0;
  }
  for (const r of w.remoteTargets) {
    if (r.isDown) continue;
    anyUp = true;
    keyHash = (Math.imul(keyHash, 31) + Math.floor(r.y / TILE) * d.w + Math.floor(r.x / TILE)) | 0;
  }
  const tileChanged = anyUp && keyHash !== w.flowKey;
  if (w.flowCd > 0 && !tileChanged && w.flow.isReady()) return;
  w.flowCd = C.FLOW_REBUILD;
  w.flowKey = keyHash;

  const srcs = w.flowSources;
  srcs.length = 0;
  for (const pl of w.players.values()) {
    if (pl.isDown || pl.hp <= 0) continue;
    const tx = Math.floor(pl.x / TILE), ty = Math.floor(pl.y / TILE);
    if (tx < 0 || ty < 0 || tx >= d.w || ty >= d.h) continue;
    srcs.push(ty * d.w + tx);
  }
  for (const r of w.remoteTargets) {
    if (r.isDown) continue;
    const rtx = Math.floor(r.x / TILE), rty = Math.floor(r.y / TILE);
    if (rtx < 0 || rty < 0 || rtx >= d.w || rty >= d.h) continue;
    srcs.push(rty * d.w + rtx);
  }
  w.flow.build(d, srcs);
}

function chaseAngle(w: WorldState, e: Enemy): number {
  if (hasLineOfSight(w, e.x, e.y, w.targetX, w.targetY)) {
    return Math.atan2(w.targetY - e.y, w.targetX - e.x);
  }
  const tx = Math.floor(e.x / TILE), ty = Math.floor(e.y / TILE);
  if (w.flow.sampleStep(tx, ty)) return Math.atan2(w.flow.step.dy, w.flow.step.dx);
  return Math.atan2(w.targetY - e.y, w.targetX - e.x);
}

function slimeHopPulse(e: Enemy): number {
  return 1 + C.SLIME_HOP_AMOUNT * Math.sin(e.hopClock * C.SLIME_HOP_FREQ);
}

function applyChaseStep(w: WorldState, e: Enemy, dt: number, angle: number, step: number): void {
  // Local obstacle avoidance: props aren't in the flow field, so a chaser would otherwise
  // grind straight into a barrel/crate and wedge. Steer smoothly around the nearest
  // blocking prop instead.
  angle = avoidPropAhead(w, e, angle, dt);
  const x0 = e.x, y0 = e.y;
  moveEnemyBy(w, e, Math.cos(angle) * step, Math.sin(angle) * step);
  const moved = Math.hypot(e.x - x0, e.y - y0);
  const isBlocked = step > C.STUCK_MIN_STEP && moved < step * C.STUCK_PROGRESS;
  e.stuckTimer = isBlocked ? e.stuckTimer + dt : 0;
  if (e.stuckTimer < C.STUCK_TIME) return;
  e.stuckTimer = 0;
  // Wedged despite the steering (a geometry corner, or a prop flush against a wall): a
  // strong perpendicular escape preferring the committed detour side, then the other side,
  // then a hard back-diagonal. Whichever side the escape actually took BECOMES the
  // commitment, so the following steering keeps rounding the same way instead of shoving
  // straight back into the prop.
  const side = e.avoidSide !== 0 ? e.avoidSide : Math.sin(e.zig) >= 0 ? 1 : -1;
  const esc = step * 1.6;
  e.avoidSide = side;
  e.avoidTime = C.AVOID_COMMIT;
  if (nudgeEnemy(w, e, angle + side * C.HALF_PI, esc)) return;
  if (nudgeEnemy(w, e, angle - side * C.HALF_PI, esc)) { e.avoidSide = -side; return; }
  nudgeEnemy(w, e, angle + side * (Math.PI * 0.75), esc);
}

// Steer a chaser around the nearest live prop blocking its path, or return `angle` when the
// way is clear. Three properties keep enemies from wedging on barrels/crates (the playtest
// complaint):
//  - the whole swept CORRIDOR ahead is tested (radius sum wide, AVOID_LOOKAHEAD deep), not a
//    single probe point, so an offset prop that would still clip the body is seen;
//  - the deflection is the TANGENT past the prop's edge — gentle at range, growing to a
//    perpendicular slide when touching — instead of a fixed 45° kink;
//  - the detour side is COMMITTED for a short window (e.avoidSide/avoidTime), so a dead-on
//    approach can't ping-pong left/right into the prop every tick, and a row of props is
//    rounded consistently along one flank.
function avoidPropAhead(w: WorldState, e: Enemy, angle: number, dt: number): number {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  let hit: Prop | null = null;
  let hitDist = Infinity;
  for (const p of w.props) {
    if (p.dead) continue;
    const dx = p.x - e.x, dy = p.y - e.y;
    const rr = e.radius + p.radius;
    const fwd = dx * cos + dy * sin;
    if (fwd < 0 || fwd > rr + C.AVOID_LOOKAHEAD) continue; // behind, or beyond the lookahead
    if (Math.abs(dx * sin - dy * cos) >= rr) continue;     // outside the swept corridor
    const d = Math.hypot(dx, dy);
    if (d < hitDist) { hit = p; hitDist = d; }
  }
  if (!hit) {
    if (e.avoidTime > 0) {
      e.avoidTime = e.avoidTime > dt ? e.avoidTime - dt : 0;
      if (e.avoidTime === 0) e.avoidSide = 0;
    }
    return angle;
  }
  const toProp = Math.atan2(hit.y - e.y, hit.x - e.x);
  if (e.avoidSide === 0) {
    // A fresh detour follows the side the heading is already biased toward; a dead-on
    // approach picks whichever side has open room (deterministic zig tiebreak).
    let diff = angle - toProp;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    e.avoidSide = Math.abs(diff) > 0.08 ? (diff >= 0 ? 1 : -1) : clearerSide(w, e, toProp);
  }
  e.avoidTime = C.AVOID_COMMIT;
  const clear = e.radius + hit.radius + C.AVOID_CLEARANCE;
  const tangent = hitDist > clear ? Math.asin(clear / hitDist) : C.HALF_PI;
  return toProp + e.avoidSide * tangent;
}

// Which flank of a blocking prop has open room: probe one point past the body on each side,
// perpendicular to the prop direction. A tie falls back to the seeded zig heading, so the
// pick is stable and deterministic.
function clearerSide(w: WorldState, e: Enemy, toProp: number): number {
  const px = -Math.sin(toProp), py = Math.cos(toProp);
  const reach = e.radius + C.AVOID_SIDE_PROBE;
  const isOpen = (side: number): boolean => {
    const x = e.x + px * side * reach, y = e.y + py * side * reach;
    return !isWall(w, x, y) && !blockedByProp(w, x, y, e.radius);
  };
  const left = isOpen(1), right = isOpen(-1);
  if (left !== right) return left ? 1 : -1;
  return Math.sin(e.zig) >= 0 ? 1 : -1;
}

function nudgeEnemy(w: WorldState, e: Enemy, angle: number, step: number): boolean {
  const x0 = e.x, y0 = e.y;
  moveEnemyBy(w, e, Math.cos(angle) * step, Math.sin(angle) * step);
  return Math.hypot(e.x - x0, e.y - y0) > step * C.STUCK_PROGRESS;
}

function stepWindupTimer(w: WorldState, e: Enemy, dt: number, dur: number, lockAt: number, isAoe: boolean): boolean {
  const a = e.attack;
  a.time += dt;
  a.windup = a.time < dur ? a.time / dur : 1;
  if (!a.isAimLocked) {
    if (findTarget(w, e.x, e.y)) {
      a.lockedAngle = Math.atan2(w.targetY - e.y, w.targetX - e.x);
      if (isAoe) { a.markX = w.targetX; a.markY = w.targetY; }
    }
    if (a.time >= lockAt) a.isAimLocked = true;
  }
  return a.time >= dur;
}

function beginWindup(e: Enemy, move: AttackMove): void {
  const a = e.attack;
  a.phase = "windup"; a.time = 0; a.move = move; a.windup = 0; a.isAimLocked = false;
}
function enterRecover(e: Enemy): void { const a = e.attack; a.phase = "recover"; a.time = 0; a.windup = 0; }
function enterIdle(e: Enemy): void { const a = e.attack; a.phase = "none"; a.time = 0; a.move = "none"; a.windup = 0; }

function moveEnemyBy(w: WorldState, e: Enemy, dx: number, dy: number): void {
  if (e.chill > 0) {
    const s = chillMoveScale(e);
    dx *= s; dy *= s;
  }
  if (ENEMY_ARCHETYPES[e.kind].isPhasing) {
    e.x = Math.max(TILE, Math.min((w.dungeon.w - 1) * TILE, e.x + dx));
    e.y = Math.max(TILE, Math.min((w.dungeon.h - 1) * TILE, e.y + dy));
  } else {
    [e.x, e.y] = moveCircle(w, e.x, e.y, e.radius, dx, 0);
    [e.x, e.y] = moveCircle(w, e.x, e.y, e.radius, 0, dy);
  }
}

function spawnEnemyBullet(w: WorldState, x: number, y: number, angle: number, speed: number, radius: number, damage: number, color: string, life: number): void {
  w.bullets.push({
    x, y,
    vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
    radius, life, friendly: false, owner: null, damage, color,
    pierce: 0, hitList: null, isCrit: false,
  });
}

// ---- props / chests / pickups ----

function updateProps(w: WorldState, dt: number, ev: SimEvent[]): void {
  if (w.props.length === 0) return;
  let didBreakFinish = false;
  for (const p of w.props) {
    if (p.breakT !== undefined) {
      p.breakT += dt;
      if (p.breakT >= C.PROP_BREAK_DUR) didBreakFinish = true;
      continue;
    }
    if (p.kind === "brazier") continue;
    for (const b of w.bullets) {
      if (!b.friendly || b.life <= 0) continue;
      if (Math.hypot(b.x - p.x, b.y - p.y) >= b.radius + p.radius) continue;
      p.hp -= b.damage;
      ev.push({ t: "propHit", propId: p.id, kind: p.kind, x: b.x, y: b.y });
      if (b.pierce <= 0) b.life = 0;
      if (p.hp <= 0) { destroyProp(w, p, ev, ownerOf(w, b.owner) ?? undefined); break; }
    }
    if (p.breakT === undefined) {
      for (const player of w.players.values()) {
        const swing = player.meleeSwing;
        if (!swing || swing.timer <= 0) continue;
        const [sx, sy] = swingPose(w, player, swing);
        if (!isPointInMeleeHit(sx, sy, p.x, p.y, p.radius, swing)) continue;
        // Reuse the swing hitList with a stable negative prop id namespace to prevent
        // repeated damage every frame while the same swing overlaps the prop.
        const marker = -1 - p.id;
        if (swing.hitList?.includes(marker)) continue;
        (swing.hitList ??= []).push(marker);
        p.hp -= swing.damage;
        ev.push({ t: "propHit", propId: p.id, kind: p.kind, x: p.x, y: p.y });
        if (p.hp <= 0) destroyProp(w, p, ev, player);
        break;
      }
    }
  }
  if (didBreakFinish) {
    w.props = w.props.filter((p) => p.breakT === undefined || p.breakT < C.PROP_BREAK_DUR);
  }
}

function dashBreakProps(w: WorldState, p: PlayerSim, ev: SimEvent[]): void {
  for (const prop of w.props) {
    if (prop.breakT !== undefined || prop.kind === "brazier") continue;
    if (Math.hypot(p.x - prop.x, p.y - prop.y) < p.pr + prop.radius) destroyProp(w, prop, ev, p);
  }
}

// `by` is the player who destroyed the prop (bullet owner / melee / dash / chain source), so an
// explosive barrel credits its kills to the right player. A departed destroyer (undefined)
// still detonates the barrel — its damage credits no one and never another live player.
function destroyProp(w: WorldState, p: Prop, ev: SimEvent[], by?: PlayerSim): void {
  if (p.breakT !== undefined || p.kind === "brazier") return;
  p.dead = true;
  p.breakT = 0;
  switch (p.kind) {
    case "crate":
      ev.push({ t: "propBreak", kind: "crate", x: p.x, y: p.y });
      if (w.rng.next() < 0.6) w.pickups.push(makePickup(w, "coin", p.x, p.y, ev));
      if (w.rng.next() < SUSTAIN.crateHeartDrop * coopHeartRateMult(w.encounterPlayers)) {
        w.pickups.push(makePickup(w, "heart", p.x + 12, p.y, ev));
      }
      break;
    case "pot":
      ev.push({ t: "propBreak", kind: "pot", x: p.x, y: p.y });
      if (w.rng.next() < 0.35) w.pickups.push(makePickup(w, "coin", p.x, p.y, ev));
      break;
    case "barrel":
      ev.push({ t: "propBreak", kind: "barrel", x: p.x, y: p.y });
      if (w.rng.next() < 0.45) w.pickups.push(makePickup(w, "coin", p.x, p.y, ev));
      break;
    case "barrel_explosive":
      explodeBarrel(w, by ?? null, p, ev);
      break;
  }
}

function explodeBarrel(w: WorldState, p: PlayerSim | null, source: Prop, ev: SimEvent[]): void {
  const r = C.BARREL_EXPLOSION_RADIUS;
  ev.push({ t: "explosion", x: source.x, y: source.y, r });
  for (const e of w.enemies) {
    if (e.dead) continue;
    if (Math.hypot(e.x - source.x, e.y - source.y) > r + e.radius) continue;
    damageEnemy(w, p ? p.id : null, e, C.BARREL_EXPLOSION_DAMAGE, ev);
    ev.push({ t: "flash", eid: e.id });
    ev.push({ t: "puff", x: e.x, y: e.y, n: 6, color: ENEMY_ARCHETYPES[e.kind].tint });
    applyBurn(e, C.BARREL_BURN_SECS, p ? p.id : null);
    if (e.hp <= 0 && !e.dead) killEnemy(w, p, e, ev);
  }
  for (const victim of w.players.values()) {
    if (!isProtected(victim) && !victim.isDown && victim.hp > 0
      && Math.hypot(victim.x - source.x, victim.y - source.y) <= r) {
      damagePlayer(w, victim, C.BARREL_EXPLOSION_SELF_DMG, ev);
    }
  }
  for (const other of w.props) {
    if (other === source || other.breakT !== undefined || other.kind === "brazier") continue;
    if (Math.hypot(other.x - source.x, other.y - source.y) <= r + other.radius) destroyProp(w, other, ev, p ?? undefined);
  }
}

function updateChests(w: WorldState, dt: number, ev: SimEvent[]): void {
  if (w.chests.length === 0) return;
  for (const c of w.chests) {
    if (!c.opened) {
      for (const b of w.bullets) {
        if (!b.friendly || b.life <= 0) continue;
        if (Math.hypot(b.x - c.x, b.y - c.y) >= b.radius + c.radius) continue;
        // The chest opener is the BULLET's owner (the actual shooter) — never a "primary" player.
        // If that shooter has since disconnected, the bullet still stops on the chest but opens
        // nothing (no one is there to receive the roll); the chest stays for live players.
        const opener = ownerOf(w, b.owner);
        if (opener) openChest(w, opener, c, ev);
        if (b.pierce > 0) b.pierce--; else b.life = 0;
        break;
      }
    }
    if (!c.opened) {
      for (const player of w.players.values()) {
        const swing = player.meleeSwing;
        if (!swing || swing.timer <= 0) continue;
        const [sx, sy] = swingPose(w, player, swing);
        if (isPointInMeleeHit(sx, sy, c.x, c.y, c.radius, swing)) {
          openChest(w, player, c, ev);
          break;
        }
      }
    }
    if (c.opened) {
      if (c.openT !== undefined && c.openT < C.CHEST_OPEN_DUR) c.openT += dt;
      continue;
    }
    for (const p of w.players.values()) {
      if (!p.isDown && p.hp > 0 && Math.hypot(p.x - c.x, p.y - c.y) < p.pr + c.radius) {
        openChest(w, p, c, ev);
        break;
      }
    }
  }
}

function openChest(w: WorldState, p: PlayerSim, c: Chest, ev: SimEvent[]): void {
  c.opened = true;
  c.openT = 0;
  ev.push({ t: "chestOpen", kind: c.kind, x: c.x, y: c.y });
  if (c.kind === "boss") { grantBossChest(w, p, c, ev); return; }
  // Baked contents first (the floor's weapon drop lives in this chest — see
  // stockWeaponChests), then the ordinary roll: the weapon replaces nothing, so the heart
  // economy and pity behave exactly as they always did per chest opened.
  if (c.weapon !== undefined) ejectChestWeapon(w, p, c, c.weapon, ev);
  rollWoodChest(w, p, c, ev);
}

// A weapon coming out of a chest lands just in FRONT of it — toward the opener — so it
// reads as spilled loot, clearly collectible, never a pickup stacked under the chest
// sprite. The landing spot must be somewhere the opener can actually STAND (open floor,
// off every live prop's collision ring, clear of other chests): the old loose floor drops
// could sit where the 34px collect range never triggered — the unreachable gun of the
// playtest. Candidate angles fan out from the opener direction in a fixed order; if every
// one is blocked (a chest boxed in by props), the drop degrades to the chest's own tile,
// which is open, prop-free floor by construction (see chestTile).
function ejectChestWeapon(w: WorldState, p: PlayerSim, c: Chest, weapon: WeaponId, ev: SimEvent[]): void {
  const dx = p.x - c.x, dy = p.y - c.y;
  const base = Math.hypot(dx, dy) > 1 ? Math.atan2(dy, dx) : C.HALF_PI;
  let x = c.x, y = c.y;
  for (const off of C.CHEST_EJECT_ANGLES) {
    const ex = c.x + Math.cos(base + off) * C.CHEST_WEAPON_EJECT;
    const ey = c.y + Math.sin(base + off) * C.CHEST_WEAPON_EJECT;
    if (isStandableSpot(w, ex, ey, p.pr)) { x = ex; y = ey; break; }
  }
  w.pickups.push({ id: w.nextPickupId++, kind: "weapon", x, y, radius: 16, weapon });
  ev.push({ t: "lootDrop", x, y, color: "#ffb43b" });
}

// Whether a player of radius `pr` can physically stand at (x, y): open floor and outside
// every live prop's collision ring. Chests don't block movement but a drop under one would
// hide the sprite, so they're excluded too.
function isStandableSpot(w: WorldState, x: number, y: number, pr: number): boolean {
  if (isWall(w, x, y) || blockedByProp(w, x, y, pr)) return false;
  for (const c of w.chests) {
    if (Math.hypot(x - c.x, y - c.y) < c.radius + 16) return false;
  }
  return true;
}

// Wood chest table (§2/§6): heart 15%, weapon 7%, otherwise coins. Blessings no longer
// drop from random chests — the reward cadence lives on descents and the boss chest. The
// recovery pity, once armed, forces the heart.
function rollWoodChest(w: WorldState, p: PlayerSim, c: Chest, ev: SimEvent[]): void {
  if (w.isPityHeartArmed) {
    w.isPityHeartArmed = false;
    w.pityStreak = 0;
    w.pickups.push(makePickup(w, "heart", c.x, c.y, ev));
    return;
  }
  const r = w.rng.next();
  if (r < SUSTAIN.woodChestHeart * coopHeartRateMult(w.encounterPlayers)) {
    w.pickups.push(makePickup(w, "heart", c.x, c.y, ev));
  } else if (r < SUSTAIN.woodChestHeart * coopHeartRateMult(w.encounterPlayers) + SUSTAIN.woodChestWeapon) {
    const weapon = PICKUP_WEAPONS[Math.floor(w.rng.next() * PICKUP_WEAPONS.length)];
    ejectChestWeapon(w, p, c, weapon, ev);
  } else {
    const n = 3 + Math.floor(w.rng.next() * 4);
    for (let i = 0; i < n; i++) w.pickups.push(makePickup(w, "coin", c.x + (i - (n - 1) / 2) * 14, c.y + 12, ev));
  }
}

// Boss completion recovery is the chest's +1 heart ONLY (no descent heal), and its blessing
// offer is the floor's reward — a Rare pick (the `rare` flag steers the roll pool). The boss
// kill already cleared the floor (endBossDanger), so this offer is inherently on the safe
// side; the pending entry still applies so a party can't descend out from under the pick.
function grantBossChest(w: WorldState, p: PlayerSim, c: Chest, ev: SimEvent[]): void {
  w.pickups.push(makePickup(w, "heart", c.x - 18, c.y, ev));
  for (let i = 0; i < 5; i++) w.pickups.push(makePickup(w, "coin", c.x + (i - 2) * 16, c.y + 18, ev));
  raiseBlessingOffer(w, p.id, true, ev);
}

function updatePickups(w: WorldState, dt: number, ev: SimEvent[]): void {
  const remaining: Pickup[] = [];
  for (const p of w.pickups) {
    let collected = false;
    for (const player of w.players.values()) {
      if (player.mods.coinMagnet > 0 && p.kind === "coin" && !player.isDown) {
        const dx = player.x - p.x, dy = player.y - p.y;
        const d = Math.hypot(dx, dy);
        if (d > 0.5 && d < player.mods.coinMagnet) {
          const pull = Math.min(d, player.mods.coinMagnetPull * dt);
          p.x += (dx / d) * pull; p.y += (dy / d) * pull;
        }
      }
      if (!player.isDown && Math.hypot(player.x - p.x, player.y - p.y) < player.pr + p.radius) {
        if (p.kind === "coin") { player.coins += p.value ?? coinGain(player); ev.push({ t: "pickup", pid: player.id, kind: "coin", x: p.x, y: p.y }); collected = true; break; }
        if (p.kind === "heart") {
          // At full HP the heart is consumed and converts to coins (§2) — no backtracking
          // stockpile of floor hearts.
          if (player.hp < player.maxHp) { player.hp++; ev.push({ t: "pickup", pid: player.id, kind: "heart", x: p.x, y: p.y }); }
          else { player.coins += SUSTAIN.fullHpHeartCoins; ev.push({ t: "pickup", pid: player.id, kind: "coin", x: p.x, y: p.y }); }
          collected = true; break;
        }
        if (p.kind === "dealer_heart") {
          // The Dealer sells exactly +1 HP for coins; broke or full-health players walk past.
          if (player.hp < player.maxHp && player.coins >= (p.value ?? DEALER.price)) {
            player.coins -= p.value ?? DEALER.price;
            player.hp += DEALER.heal;
            ev.push({ t: "pickup", pid: player.id, kind: "heart", x: p.x, y: p.y });
            collected = true; break;
          }
          continue;
        }
        if (p.kind === "weapon" && p.weapon && !player.ownedWeapons.includes(p.weapon)) { acquireWeapon(player, p.weapon); ev.push({ t: "pickup", pid: player.id, kind: "weapon", x: p.x, y: p.y }); collected = true; break; }
      }
    }
    if (!collected) remaining.push(p);
  }
  w.pickups = remaining;
}

// Is there another player (or, on the legacy Convex co-op path, a remote target) still up who
// could revive `p`? Drives the authoritative down-vs-gameover decision.
function hasStandingAlly(w: WorldState, p: PlayerSim): boolean {
  for (const other of w.players.values()) {
    if (other === p) continue;
    if (!other.isDown && other.hp > 0) return true;
  }
  return w.isCoop && w.remoteTargets.some((r) => !r.isDown);
}

function damagePlayer(w: WorldState, p: PlayerSim, amount: number, ev: SimEvent[]): void {
  if (w.isGodMode) return; // dev god mode; never set outside the sandbox
  // A player mid-blessing-pick cannot be hurt. Offers are only raised on the safe side of a
  // transition (cleared floor), but the shared world keeps ticking under the chooser's menu
  // online — this shield covers the residue (a stray in-flight glob, a chained barrel).
  if (w.pendingBlessings.has(p.id)) return;
  p.hp -= amount;
  p.invuln = PLAYER.postHitInvuln;
  // Any damage cancels a revive channel the victim was holding (§2): reviving is a real
  // commitment, not something you tank through.
  for (const downed of w.players.values()) {
    if (!downed.isDown || downed.reviveProgress <= 0) continue;
    if (Math.hypot(p.x - downed.x, p.y - downed.y) <= REVIVE.radius) downed.reviveProgress = 0;
  }
  ev.push({ t: "playerHurt", pid: p.id, x: p.x, y: p.y });
  if (p.hp <= 0) {
    p.hp = 0;
    if (hasStandingAlly(w, p)) {
      // A teammate can still revive: go DOWN, not out. reviveProgress accrues in updateRevives.
      p.isDown = true;
      p.reviveProgress = 0;
    } else {
      // No one left to revive -> solo death or full team wipe. End the run for the whole room
      // (every remaining player, incl. already-downed teammates) so all clients see game over.
      // Solo has one player, so this emits exactly one gameOver as before. isRunOver makes the
      // terminal transition derivable from STATE (snapshots carry it), not only from the event.
      endRun(w, ev);
    }
  }
}

// Terminal run transition: mark the world over (once) and emit gameOver for every remaining
// player. Idempotent — re-entering while already over emits nothing.
function endRun(w: WorldState, ev: SimEvent[]): void {
  if (w.isRunOver) return;
  w.isRunOver = true;
  for (const other of w.players.values()) ev.push({ t: "gameOver", pid: other.id });
}

// Shared-world safety net: if the last STANDING player leaves (disconnect, not death), the
// remaining downed players have no possible revive — end the run for them instead of stranding
// them on the floor forever. damagePlayer covers the death path; this covers the leave path.
function checkStrandedWipe(w: WorldState, ev: SimEvent[]): void {
  if (!w.isShared || w.isRunOver || w.players.size === 0) return;
  let anyUp = false;
  let anyDown = false;
  for (const p of w.players.values()) {
    if (!p.isDown && p.hp > 0) anyUp = true;
    else anyDown = true;
  }
  if (!anyUp && anyDown) endRun(w, ev);
}

// Authoritative revive (§2): a living teammate holds within REVIVE.radius for the full
// 1.5s channel (any damage to the channeler cancels it — see damagePlayer). The revived
// player returns at 2 HP with 1.0s protection and a 0.35s attack lockout. Progress decays
// when no one is nearby, so it takes a sustained hold. Solo never has a downed player with
// a standing ally, so this no-ops there.
function updateRevives(w: WorldState, dt: number, ev: SimEvent[]): void {
  for (const downed of w.players.values()) {
    if (!downed.isDown) continue;
    let reviver: PlayerSim | undefined;
    for (const other of w.players.values()) {
      if (other === downed || other.isDown || other.hp <= 0) continue;
      if (Math.hypot(other.x - downed.x, other.y - downed.y) <= REVIVE.radius) { reviver = other; break; }
    }
    if (reviver) {
      downed.reviveProgress += dt;
      if (downed.reviveProgress >= REVIVE.channel) {
        downed.isDown = false;
        downed.hp = Math.min(downed.maxHp, REVIVE.hp);
        downed.invuln = Math.max(downed.invuln, REVIVE.invuln);
        downed.fireCd = Math.max(downed.fireCd, REVIVE.fireLockout);
        downed.reviveProgress = 0;
        ev.push({ t: "revive", pid: downed.id, by: reviver.id, x: downed.x, y: downed.y });
      }
    } else {
      downed.reviveProgress = downed.reviveProgress > dt ? downed.reviveProgress - dt : 0;
    }
  }
}

// ---- exit / descend ----

function updateExit(w: WorldState, ev: SimEvent[]): void {
  if (w.isSandbox) return;
  const d = w.dungeon;
  const ex = d.exit.x * TILE + TILE / 2, ey = d.exit.y * TILE + TILE / 2;
  if (!isFloorCleared(w)) return;
  // Party-wide gate: descend only when EVERY living (up) player stands at the exit. Solo has one
  // player, so this is identical to the old single-player check. The authoritative server owns
  // this decision entirely off server positions — no client triggers the transition.
  let anyLiving = false;
  let allAtExit = true;
  for (const p of w.players.values()) {
    if (p.isDown || p.hp <= 0) continue;
    anyLiving = true;
    if (Math.hypot(p.x - ex, p.y - ey) >= TILE) { allAtExit = false; break; }
  }
  if (!anyLiving || !allAtExit) return;
  // Solo + shared server descend in-sim; the legacy Convex co-op path defers to the client's
  // shared-floor orchestration (everyone descends together via presence, offers ride descend).
  if (w.isCoop) {
    ev.push({ t: "reachExit", toFloor: w.floor + 1 });
    return;
  }
  // The safe-side blessing gate (spec §6 cadence, moved off the descend): with the party
  // gathered at a cleared floor's exit, raise this floor's offers ONCE, then hold the
  // descend until every pick resolves (or expires). The pick therefore always happens
  // BEFORE the next floor's threats exist — never mid-fight, never as a boss floor loads.
  // A boss floor's reward was its chest (the Rare pick), so leaving it offers nothing.
  if (!w.isBlessingOfferedThisFloor && !isBossFloor(w.floor)) {
    w.isBlessingOfferedThisFloor = true;
    for (const p of w.players.values()) raiseBlessingOffer(w, p.id, false, ev);
    return;
  }
  if (w.pendingBlessings.size > 0) return;
  descend(w, w.floor + 1, ev);
}

// A floor descent (solo). Co-op's shared-floor sync is orchestrated client-side; the
// client calls descend via stepWorld's exit check or directly on a coop descend request.
// There is NO descent heal (§2) — the descent is pacing, not a free mistake reset.
export function descend(w: WorldState, nextFloor: number, ev: SimEvent[]): void {
  const isLeavingBossFloor = isBossFloor(w.floor);
  // Reward cadence (§6): one blessing offer per NON-BOSS descent for every player. In solo
  // and the authoritative shared world the exit gate already raised this floor's offers on
  // the safe side (isBlessingOfferedThisFloor — see updateExit), so the debt is paid. A
  // descend that arrives WITHOUT the gate having offered — a legacy co-op follower pulled
  // down by the room's shared floor, or a directly scripted descend — still owes each
  // player their pick and offers it post-load exactly as before (those clients freeze their
  // own local sim under the overlay, so the pick is safe there too).
  const isOfferDue = !isLeavingBossFloor && !w.isBlessingOfferedThisFloor;
  // Recovery pity (§2): two consecutive dry non-boss floors entered below 50% HP arm a
  // guaranteed heart in the next wood chest. Any generated heart resets the streak.
  if (!isLeavingBossFloor && w.heartsThisFloor === 0 && w.isFloorEnteredLow) {
    w.pityStreak++;
    if (w.pityStreak >= SUSTAIN.pityFloors) {
      w.isPityHeartArmed = true;
      w.pityStreak = 0;
    }
  } else if (w.heartsThisFloor > 0) {
    w.pityStreak = 0;
  }
  w.floor = nextFloor;
  for (const p of w.players.values()) {
    p.combo = 0; p.comboTimer = 0;
    p.isDown = false;
    p.reviveProgress = 0;
    if (SUSTAIN.descentHeal > 0) p.hp = Math.min(p.maxHp, p.hp + SUSTAIN.descentHeal);
  }
  ev.push({ t: "descend", toFloor: nextFloor });
  loadFloorIntoWorld(w, nextFloor);
  if (isOfferDue) {
    for (const p of w.players.values()) raiseBlessingOffer(w, p.id, false, ev);
  }
}

// ---- the step ----

// Advance ONE player for one input over dt: aim, movement/dash/collision, shooting, and the
// melee-swing timer. This is the per-player half of stepWorld, factored out so the
// authoritative server and client prediction can step ONLY the local player at an arbitrary
// dt (each InputCmd carries its own frame dt) while the world half runs once per fixed tick.
// stepWorld itself calls this, so solo behavior is unchanged.
export function stepPlayerPhase(w: WorldState, p: PlayerSim, input: InputCmd, dt: number, ev: SimEvent[]): void {
  // A player with a blessing offer open is paused: no aim, movement, or fire. Their client
  // freezes under the overlay and sends nothing anyway; the guard makes a tampered client
  // equally inert (it can't kite or shoot from inside the damage-shielded pick window).
  if (w.pendingBlessings.has(p.id)) return;
  p.aimAngle = input.aim;
  if (!p.isDown) {
    updatePlayer(w, p, input, dt, ev);
    updateShooting(w, p, input, dt, ev);
  }
  if (p.meleeSwing) {
    p.meleeSwing.timer -= dt;
    if (p.meleeSwing.timer <= 0) p.meleeSwing = null;
  }
}

// The world-systems half of stepWorld: bullets, enemies, props, chests, pickups, exit, and
// combo decay. Runs once per authoritative tick at the fixed step AFTER every player has been
// advanced. Only the sim RNG (w.rng) is consumed here, so the server is the single roller.
export function stepWorldPhase(w: WorldState, dt: number, ev: SimEvent[]): void {
  recordHistory(w);
  updateBullets(w, dt, ev);
  updateEnemies(w, dt, ev);
  updateProps(w, dt, ev);
  updateChests(w, dt, ev);
  updatePickups(w, dt, ev);
  updateRevives(w, dt, ev);
  checkStrandedWipe(w, ev);
  tickPendingBlessings(w, dt);
  updateExit(w, ev);

  for (const p of w.players.values()) {
    if (p.comboTimer > 0) {
      p.comboTimer -= dt;
      if (p.comboTimer <= 0) { p.comboTimer = 0; p.combo = 0; }
    }
    if (p.fangCd > 0) p.fangCd = p.fangCd > dt ? p.fangCd - dt : 0;
  }
}

export function stepWorld(w: WorldState, inputs: Map<PlayerId, InputCmd>, dt: number): SimEvent[] {
  const ev: SimEvent[] = [];
  w.tick++;

  for (const p of w.players.values()) {
    stepPlayerPhase(w, p, inputs.get(p.id) ?? IDLE_INPUT, dt, ev);
  }

  stepWorldPhase(w, dt, ev);

  return ev;
}

// ---- dev sandbox helpers (client dev tools mutate the world through these) ----

export function devSpawnEnemy(w: WorldState, kind: Enemy["kind"], x: number, y: number): Enemy {
  const e = createEnemy(kind, x, y, w.floor, w.rng, w.nextEnemyId++, { players: w.encounterPlayers });
  w.enemies.push(e);
  return e;
}
export function devSpawnProp(w: WorldState, kind: Prop["kind"], x: number, y: number): void {
  w.props.push({ id: w.nextPropId++, kind, x, y, radius: C.PROP_RADIUS, hp: C.PROP_HP[kind], dead: false });
}
export function devSpawnChest(w: WorldState, x: number, y: number): void {
  w.chests.push({ id: w.nextChestId++, kind: "wood", x, y, radius: 16, opened: false });
}
