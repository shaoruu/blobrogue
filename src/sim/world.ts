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
import { ENEMY_ARCHETYPES, spawnFloorEnemies, createEnemy } from "./enemies.js";
import { WEAPONS, DEFAULT_WEAPON, PICKUP_WEAPONS, fire } from "./weapons.js";
import type { ShotSpec } from "./weapons.js";
import { createMods } from "./items.js";
import type { PlayerMods, ItemDef } from "./items.js";
import type { SimEvent } from "./events.js";
import type { InputCmd, PlayerId } from "./input.js";
import { LOCAL_ID, IDLE_INPUT } from "./input.js";
import * as C from "./constants.js";

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
}

export interface PlayerSim {
  id: PlayerId;
  x: number; y: number; pr: number;
  hp: number; maxHp: number;
  mods: PlayerMods;
  invuln: number;
  dashCd: number; dashTime: number; dashDx: number; dashDy: number;
  fireCd: number;
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
  players: Map<PlayerId, PlayerSim>;
  enemies: Enemy[];
  bullets: Bullet[];
  pickups: Pickup[];
  props: Prop[];
  chests: Chest[];
  dungeon: Dungeon;
  flow: FlowField;
  flowCd: number;
  flowKeyTx: number;
  flowKeyTy: number;
  flowSources: number[];
  rng: Rng;
  nextEnemyId: number;
  nextPropId: number;
  // Lag-compensation position history: per-enemy ring of past positions (offset 0 = most
  // recent record). histHead is the ring slot of the most recent record; histCount is how many
  // slots are valid. Recorded once per world tick; read only when a shooter has rewindTicks > 0.
  enemyHist: Map<number, EnemyHist>;
  histHead: number;
  histCount: number;
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
    hp: C.BASE_MAX_HP, maxHp: C.BASE_MAX_HP,
    mods: createMods(),
    invuln: 0,
    dashCd: 0, dashTime: 0, dashDx: 0, dashDy: 0,
    fireCd: 0,
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
    players: new Map(),
    enemies: [],
    bullets: [],
    pickups: [],
    props: [],
    chests: [],
    dungeon: { w: 0, h: 0, tiles: [], rooms: [], spawn: { x: 0, y: 0 }, exit: { x: 0, y: 0 } },
    flow: new FlowField(),
    flowCd: 0,
    flowKeyTx: -1,
    flowKeyTy: -1,
    flowSources: [],
    rng: new Rng(seed ^ 0x53696d21),
    nextEnemyId: 0,
    nextPropId: 0,
    enemyHist: new Map(),
    histHead: 0,
    histCount: 0,
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
export function removePlayerFromWorld(w: WorldState, id: PlayerId): boolean {
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
export function loadFloorIntoWorld(w: WorldState, floor: number): void {
  w.floor = floor;
  w.dungeon = w.isSandbox ? buildArena() : generateDungeon(w.seed, floor);
  w.bullets = [];
  w.nextEnemyId = 0;
  w.nextPropId = 0;
  w.enemies = w.isSandbox ? [] : spawnFloorEnemies(w.dungeon, w.seed, floor);
  w.nextEnemyId = w.enemies.length;
  w.flowCd = 0;
  w.flowKeyTx = -1;
  w.flowKeyTy = -1;
  w.pickups = w.isSandbox ? [] : placeWeaponPickups(w);
  w.props = w.isSandbox ? [] : placeProps(w);
  w.chests = w.isSandbox ? [] : placeChests(w);
  // Reposition living players to the new spawn.
  const spawn = w.dungeon.spawn;
  for (const p of w.players.values()) {
    p.x = spawn.x * TILE + TILE / 2;
    p.y = spawn.y * TILE + TILE / 2;
  }
}

// The "primary" player used for flow-field sourcing, kill/status credit, and the exit check.
// Solo/co-op/prediction clients always have the LOCAL_ID player; the authoritative server owns
// per-connection players ("p<id>") with no LOCAL_ID, so this falls back to the first player and
// returns undefined only for an empty world (idle server) — callers guard that case. Because
// solo always has LOCAL_ID, this returns the exact same player it always did (behavior
// unchanged, goldens green).
function primaryPlayer(w: WorldState): PlayerSim | undefined {
  return w.players.get(LOCAL_ID) ?? w.players.values().next().value;
}

// Resolve the player who should receive credit for an attributed action (bullet/burn/etc).
// Returns the owning player if still connected, else falls back to the primary player so loot
// still drops and combos still resolve when the shooter has left mid-flight (bullet outlives
// its owner). Solo: `id` is always LOCAL_ID, so this returns the one player unchanged.
function resolveOwner(w: WorldState, id: PlayerId | null): PlayerSim | undefined {
  if (id !== null) {
    const p = w.players.get(id);
    if (p) return p;
  }
  return primaryPlayer(w);
}

// ---- deterministic floor placement (seeded per floor, own RNG streams) ----

function placeWeaponPickups(w: WorldState): Pickup[] {
  const d = w.dungeon;
  if (w.floor < 2 || d.rooms.length <= 2) return [];
  const rng = new Rng((w.seed ^ 0x51ed270b) + w.floor * 40503);
  const drops: Pickup[] = [];
  const kinds: WeaponId[] = [rng.pick(PICKUP_WEAPONS)];
  if (w.floor >= 3 && rng.chance(0.6)) kinds.push(rng.pick(PICKUP_WEAPONS));
  for (const weapon of kinds) {
    const room = d.rooms[1 + rng.int(0, d.rooms.length - 2)];
    drops.push({ kind: "weapon", x: (room.cx + 0.5) * TILE, y: (room.cy + 0.5) * TILE, radius: 16, weapon });
  }
  return drops;
}

function rollPropKind(rng: Rng): Prop["kind"] {
  const r = rng.next();
  if (r < 0.34) return "pot";
  if (r < 0.62) return "crate";
  if (r < 0.84) return "barrel";
  if (r < 0.94) return "barrel_explosive";
  return "brazier";
}

function placeProps(w: WorldState): Prop[] {
  const d = w.dungeon;
  const rng = new Rng((w.seed ^ 0x2f6a35c1) + w.floor * 26417);
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
      const kind = rollPropKind(rng);
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
    list.push({ kind: "wood", x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE, radius: 16, opened: false });
  };
  const treasure = d.rooms.find((r) => r.kind === "treasure");
  let remaining = count;
  if (treasure) {
    const spot = chestTile(d, treasure, used);
    if (spot) { addChest(spot.tx, spot.ty); remaining--; }
  }
  for (let i = 0; i < remaining; i++) {
    const room = d.rooms[1 + rng.int(0, d.rooms.length - 2)];
    const spot = chestTile(d, room, used);
    if (spot) addChest(spot.tx, spot.ty);
  }
  if (list.length === 0) {
    for (let ri = 1; ri < d.rooms.length; ri++) {
      const spot = chestTile(d, d.rooms[ri], used);
      if (spot) { addChest(spot.tx, spot.ty); break; }
    }
  }
  return list;
}

function chestTile(d: Dungeon, room: Room, used: Set<number>): { tx: number; ty: number } | null {
  const isBad = (tx: number, ty: number) =>
    d.tiles[ty * d.w + tx] !== 0 ||
    used.has(ty * d.w + tx) ||
    (tx === d.spawn.x && ty === d.spawn.y) ||
    (tx === d.exit.x && ty === d.exit.y);
  if (!isBad(room.cx, room.cy)) return { tx: room.cx, ty: room.cy };
  for (let ty = room.y; ty < room.y + room.h; ty++)
    for (let tx = room.x; tx < room.x + room.w; tx++)
      if (!isBad(tx, ty)) return { tx, ty };
  return null;
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
function currentDamageMult(p: PlayerSim): number {
  return p.mods.damageMult + p.mods.berserk * lowHpFactor(p);
}
function currentFireRate(p: PlayerSim): number {
  return Math.max(0.25, p.mods.fireRateMult + p.mods.adrenaline * lowHpFactor(p));
}
function dashCooldown(p: PlayerSim): number {
  return C.DASH_COOLDOWN * p.mods.dashCdMult;
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

export function applyMaxHpBonus(p: PlayerSim): void {
  const next = Math.max(1, C.BASE_MAX_HP + p.mods.maxHpBonus);
  if (next > p.maxHp) p.hp += next - p.maxHp;
  p.maxHp = next;
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

// Apply a picked blessing to a player (client calls this when a choice is made). Returns
// the itemPicked FX event.
export function applyItemToWorld(w: WorldState, pid: PlayerId, item: ItemDef): SimEvent[] {
  const p = w.players.get(pid);
  if (!p) return [];
  item.apply(p.mods);
  p.ownedItemIds.push(item.id);
  applyMaxHpBonus(p);
  return [{ t: "itemPicked", pid, x: p.x, y: p.y, tint: item.tint }];
}

// ---- knockback ----

function applyKnockbackDir(weapon: WeaponId, e: Enemy, dirX: number, dirY: number): void {
  const sp = Math.hypot(dirX, dirY) || 1;
  const v = (C.WEAPON_KB[weapon] * C.KB_LAMBDA) / ENEMY_ARCHETYPES[e.kind].kbResist;
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
function applyBurn(e: Enemy, secs: number, owner: PlayerId): void {
  if (secs > e.burn) e.burn = secs;
  e.burnDmg = Math.min(C.BURN_DMG_MAX, e.burnDmg + C.BURN_DMG_STACK);
  // The most recent igniter owns the burn; its DoT tick credits that player on a kill.
  e.burnOwner = owner;
}
function applyChill(e: Enemy, secs: number): void {
  e.chill = Math.min(C.CHILL_MAX, e.chill + secs);
}
function applyShock(e: Enemy, secs: number): void {
  if (secs > e.shock) e.shock = secs;
}
function applyHitStatuses(w: WorldState, p: PlayerSim, e: Enemy, src: { burn?: number; chill?: number; shock?: number }): void {
  if (src.burn !== undefined) applyBurn(e, src.burn, p.id);
  else if (p.mods.burnChance > 0 && w.rng.next() < p.mods.burnChance) applyBurn(e, C.ITEM_BURN_SECS, p.id);
  if (src.chill !== undefined) applyChill(e, src.chill);
  else if (p.mods.chillChance > 0 && w.rng.next() < p.mods.chillChance) applyChill(e, C.ITEM_CHILL_SECS);
  if (src.shock !== undefined) applyShock(e, src.shock);
  else if (p.mods.shockChance > 0 && w.rng.next() < p.mods.shockChance) applyShock(e, C.ITEM_SHOCK_SECS);
}

function tickStatuses(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  if (e.chill > 0) e.chill = e.chill > dt ? e.chill - dt : 0;
  if (e.shock > 0) e.shock = e.shock > dt ? e.shock - dt : 0;
  if (e.burn > 0) {
    e.burn = e.burn > dt ? e.burn - dt : 0;
    e.statusTick += dt;
    while (e.statusTick > C.BURN_TICK) {
      e.hp -= e.burnDmg * C.BURN_TICK;
      e.statusTick -= C.BURN_TICK;
      ev.push({ t: "burnTick", x: e.x, y: e.y, radius: e.radius, dmg: e.burnDmg * C.BURN_TICK });
      // The burn DoT kill credits whoever last ignited this enemy (authoritative attribution).
      if (e.hp <= 0) { const cr = resolveOwner(w, e.burnOwner); if (cr) killEnemy(w, cr, e, ev); else e.dead = true; break; }
    }
    if (e.burn === 0) { e.burnDmg = 0; e.statusTick = 0; }
  }
}

function shockArc(w: WorldState, p: PlayerSim, from: Enemy, ev: SimEvent[]): void {
  arcLightning(w, p, from, 1, C.SHOCK_ARC_RANGE, C.SHOCK_ARC_DMG, "#7fe9ff", [from], ev);
}

function arcLightning(w: WorldState, p: PlayerSim, origin: Enemy, jumps: number, range: number, dmg: number, color: string, list: Enemy[], ev: SimEvent[]): void {
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
    best.hp -= dmg;
    const killed = best.hp <= 0 && !best.dead;
    ev.push({ t: "shockArc", eid: best.id, x: cur.x, y: cur.y, tx: best.x, ty: best.y, tRadius: best.radius, dmg, color, killed });
    list.push(best);
    if (killed) killEnemy(w, p, best, ev);
    cur = best;
  }
}

// ---- strikes / kills ----

function strikeEnemy(w: WorldState, p: PlayerSim, e: Enemy, hit: StrikeInfo, ev: SimEvent[]): void {
  const frozen = isFrozen(e);
  const dmg = hit.damage * (e.shock > 0 ? C.SHOCK_DMG_MULT : 1) * (frozen ? C.FROZEN_DMG_MULT : 1);
  e.hp -= dmg;
  applyKnockbackDir(p.weapon, e, hit.kbDirX, hit.kbDirY);
  applyHitStatuses(w, p, e, hit);
  const closeShotgun = !hit.isMelee && p.weapon === "shotgun" && Math.hypot(p.x - e.x, p.y - e.y) < C.SHOTGUN_FREEZE_RANGE;
  const killed = e.hp <= 0 && !e.dead;
  const puffColor = hit.isCrit ? "#fff3c4" : ENEMY_ARCHETYPES[e.kind].tint;
  ev.push({
    t: "enemyHit", eid: e.id, dmgX: e.x, dmgY: e.y - e.radius, dmg, crit: hit.isCrit,
    puffX: hit.puffX, puffY: hit.puffY, puffColor, melee: hit.isMelee, closeShotgun, killed,
  });
  if (e.shock > 0) shockArc(w, p, e, ev);
  if (killed) killEnemy(w, p, e, ev);
}

function killEnemy(w: WorldState, p: PlayerSim, e: Enemy, ev: SimEvent[]): void {
  e.dead = true;
  p.kills++;
  p.combo++;
  p.comboTimer = C.COMBO_WINDOW;
  const big = e.kind === "boss";
  ev.push({ t: "enemyKill", eid: e.id, kind: e.kind, x: e.x, y: e.y, combo: p.combo });
  if (big) w.bullets = w.bullets.filter((b) => b.friendly);
  if (p.mods.lifestealChance > 0 && p.hp < p.maxHp && w.rng.next() < p.mods.lifestealChance) {
    p.hp++;
    ev.push({ t: "heal", pid: p.id, x: e.x, y: e.y });
  }
  dropLoot(w, p, e, ev);
}

function dropLoot(w: WorldState, p: PlayerSim, e: Enemy, ev: SimEvent[]): void {
  if (e.kind === "boss") {
    w.chests.push({ kind: "boss", x: e.x, y: e.y, radius: 18, opened: false });
    return;
  }
  if (w.rng.next() < 0.5) w.pickups.push(makePickup("coin", e.x, e.y, ev, comboCoinValue(p)));
  if (w.rng.next() < 0.12) w.pickups.push(makePickup("heart", e.x + 10, e.y, ev));
}

function makePickup(kind: "heart" | "coin", x: number, y: number, ev: SimEvent[], value?: number): Pickup {
  const color = kind === "heart" ? "#ff6a6a" : "#ffd27a";
  ev.push({ t: "lootDrop", x, y, color });
  return { kind, x, y, radius: 13, weapon: null, value };
}

// ---- per-tick systems ----

function updatePlayer(w: WorldState, p: PlayerSim, input: InputCmd, dt: number, ev: SimEvent[]): void {
  let ix = input.moveX;
  let iy = input.moveY;
  const len = Math.hypot(ix, iy) || 1;
  ix /= len; iy /= len;
  if (ix !== 0) p.facing = ix > 0 ? 1 : -1;

  const speed = 200 * p.mods.moveSpeedMult;
  p.dashCd = Math.max(0, p.dashCd - dt);
  if (input.dash && p.dashCd === 0 && (ix || iy)) {
    p.dashTime = 0.16; p.dashCd = dashCooldown(p); p.dashDx = ix; p.dashDy = iy;
    p.invuln = Math.max(p.invuln, 0.35);
    ev.push({ t: "dashStart", pid: p.id, x: p.x, y: p.y });
  }
  let mvx: number, mvy: number;
  if (p.dashTime > 0) {
    p.dashTime -= dt;
    mvx = p.dashDx * 620 * dt; mvy = p.dashDy * 620 * dt;
    ev.push({ t: "dashTrail", pid: p.id, x: p.x, y: p.y });
  } else {
    mvx = ix * speed * dt; mvy = iy * speed * dt;
  }
  [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, mvx, 0);
  [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, 0, mvy);
  if (p.dashTime > 0 && w.props.length > 0) dashBreakProps(w, p, ev);
  p.invuln = Math.max(0, p.invuln - dt);
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
  ev.push({ t: "meleeSwing", pid: p.id, weapon: p.weapon, x: preX, y: preY, aim: p.aimAngle, bx: p.x, by: p.y });
}

function isPointInMeleeHit(p: PlayerSim, x: number, y: number, radius: number, swing: MeleeSwing): boolean {
  const dx = x - p.x;
  const dy = y - p.y;
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
        if (p.invuln === 0 && !p.isDown && p.hp > 0 && Math.hypot(p.x - b.x, p.y - b.y) < p.pr + b.radius) {
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

function updateEnemies(w: WorldState, dt: number, ev: SimEvent[]): void {
  // Stage C: every strike is attributed to the player who caused it (bullet.owner / swing owner
  // / burn igniter), NOT a single "primary player". Kills/coins/combo/lifesteal go to the right
  // authoritative player. Solo resolves to the one player, so behavior is unchanged.
  refreshFlowField(w, dt);
  for (const e of w.enemies) {
    tickStatuses(w, e, dt, ev);
    if (e.dead) continue;
    if (e.spawnTimer > 0) e.spawnTimer = e.spawnTimer > dt ? e.spawnTimer - dt : 0;
    if (e.attack.cooldown > 0) e.attack.cooldown = e.attack.cooldown > dt ? e.attack.cooldown - dt : 0;

    updateEnemyAI(w, e, dt, ev);
    applyKnockbackDecay(w, e, dt);

    const isMoving = e.attack.phase === "none" || (e.attack.phase === "active" && e.attack.move === "lunge");
    e.hopMove += ((isMoving ? 1 : 0) - e.hopMove) * Math.min(1, dt * 9);
    e.hopClock += dt * (1 + e.hopMove * 1.5);

    for (const victim of w.players.values()) {
      if (victim.invuln === 0 && !victim.isDown && victim.hp > 0
        && Math.hypot(victim.x - e.x, victim.y - e.y) < victim.pr + e.radius && canTouchDamage(e)) {
        damagePlayer(w, victim, e.touchDamage, ev);
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
      const shooter = resolveOwner(w, b.owner);
      if (!shooter) continue;
      // Lag comp anchored at FIRE time (decays as the bullet travels): a hitscan-fast shot tests
      // the shooter's fire-time view; a slow projectile tests present positions. 0 in solo.
      const [btx, bty] = rewoundEnemyPos(w, e, fireTimeRewind(w, b.bornTick, b.lagRewind));
      if (Math.hypot(b.x - btx, b.y - bty) < b.radius + e.radius) {
        strikeEnemy(w, shooter, e, {
          damage: b.damage, isCrit: b.isCrit, puffX: b.x, puffY: b.y, kbDirX: b.vx, kbDirY: b.vy,
          burn: b.burn, chill: b.chill, shock: b.shock, isMelee: false,
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
      const [mtx, mty] = rewoundEnemyPos(w, e, fireTimeRewind(w, swing.bornTick, swing.lagRewind));
      if (isPointInMeleeHit(player, mtx, mty, e.radius, swing)) {
        const kbDirX = Math.cos(swing.aim);
        const kbDirY = Math.sin(swing.aim);
        const puffDist = swing.isThrust ? swing.reach * 0.65 : swing.reach * 0.55;
        strikeEnemy(w, player, e, {
          damage: swing.damage, isCrit: swing.isCrit,
          puffX: player.x + kbDirX * puffDist, puffY: player.y + kbDirY * puffDist,
          kbDirX, kbDirY, burn: swing.burn, chill: swing.chill, shock: swing.shock, isMelee: true,
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

function lungeImpact(w: WorldState, p: PlayerSim, e: Enemy, ev: SimEvent[]): void {
  const push = 26, ang = e.attack.lockedAngle;
  [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, Math.cos(ang) * push, 0);
  [p.x, p.y] = moveCircle(w, p.x, p.y, p.pr, 0, Math.sin(ang) * push);
  ev.push({ t: "trauma", amount: 0.16 });
}

function applyThorns(w: WorldState, src: PlayerSim, victim: PlayerSim, e: Enemy, ev: SimEvent[]): void {
  if (victim.mods.thorns <= 0 || e.dead) return;
  e.hp -= victim.mods.thorns;
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
      a.phase = "active"; a.time = 0; a.windup = 0; a.cooldown = C.SKELETON_CD;
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
  a.cooldown = C.SPITTER_CD;
  ev.push({ t: "spitMuzzle", x: mx, y: my });
}

function updateBoss(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const boss = e.boss;
  if (!boss) return;
  const a = e.attack;

  boss.minionTimer -= dt;
  if (boss.minionTimer <= 0) { boss.minionTimer = C.BOSS_MINION_CD; spawnBossMinion(w, e, ev); }

  if (a.phase === "windup") { bossWindup(w, e, dt, ev); return; }
  if (a.phase === "active") { bossActive(w, e, dt, ev); return; }
  if (a.phase === "recover") {
    a.time += dt;
    const recDur = a.move === "hopslam" ? C.BOSS_HOPSLAM_RECOVER : C.BOSS_RADIAL_RECOVER;
    if (a.time >= recDur) enterIdle(e);
    return;
  }

  const desired = bossPhaseFor(e);
  if (desired > boss.phase) {
    boss.phase = desired;
    beginWindup(e, "roar");
    ev.push({ t: "bossPhase", eid: e.id, x: e.x, y: e.y });
    return;
  }
  if (a.cooldown === 0 && e.spawnTimer === 0) { bossBeginAttack(e, ev); return; }
  bossChase(w, e, dt);
}

function bossPhaseFor(e: Enemy): number {
  const r = e.hp / e.maxHp;
  return r > 0.66 ? 1 : r > 0.33 ? 2 : 3;
}

function bossBeginAttack(e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  const useRadial = boss.phase >= 2 && boss.isNextRadial;
  if (boss.phase >= 2) boss.isNextRadial = !boss.isNextRadial;
  e.attack.cooldown = C.BOSS_ATTACK_CD[boss.phase];
  beginWindup(e, useRadial ? "radial" : "hopslam");
  ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: useRadial ? 0.6 : 0.4, gain: 0.7, trauma: 0 });
}

function bossWindup(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.move === "roar") {
    a.time += dt;
    a.windup = Math.min(1, a.time / C.BOSS_ROAR_DUR);
    if (a.time >= C.BOSS_ROAR_DUR) enterIdle(e);
    return;
  }
  if (a.move === "radial") {
    a.time += dt;
    a.windup = Math.min(1, a.time / C.BOSS_RADIAL_WINDUP);
    if (a.time >= C.BOSS_RADIAL_WINDUP) { bossRadialFire(w, e, ev); enterRecover(e); }
    return;
  }
  if (stepWindupTimer(w, e, dt, C.BOSS_HOPSLAM_WINDUP, C.BOSS_HOPSLAM_LOCK, true)) {
    a.phase = "active"; a.time = 0; a.windup = 0;
    ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 0.6, gain: 0.9, trauma: 0 });
  }
}

function bossActive(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  a.time += dt;
  const prev = a.windup;
  a.windup = Math.min(1, a.time / C.BOSS_HOPSLAM_AIR);
  const rem = 1 - prev;
  if (rem > 0.0001) {
    const f = Math.min(1, (a.windup - prev) / rem);
    e.x += (a.markX - e.x) * f;
    e.y += (a.markY - e.y) * f;
  }
  if (a.time >= C.BOSS_HOPSLAM_AIR) { bossLand(w, e, ev); enterRecover(e); }
}

function bossLand(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack, boss = e.boss;
  const x = a.markX, y = a.markY;
  for (const p of w.players.values()) {
    if (p.invuln === 0 && !p.isDown && p.hp > 0 && Math.hypot(p.x - x, p.y - y) < C.BOSS_SLAM_RADIUS) {
      damagePlayer(w, p, 2, ev);
    }
  }
  ev.push({ t: "bossSlam", x, y });
  if (boss && boss.phase >= 3) {
    for (let i = 0; i < 4; i++) spawnEnemyBullet(w, x, y, (i / 4) * 6.28, 220, 7, 1, "#a24bff", 2.5);
    spawnBossMinion(w, e, ev);
    spawnBossMinion(w, e, ev);
  }
}

function bossRadialFire(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss;
  const parity = boss ? boss.burstParity : 0;
  if (boss) boss.burstParity = parity ^ 1;
  const base = parity ? Math.PI / C.BOSS_RADIAL_COUNT : 0;
  for (let i = 0; i < C.BOSS_RADIAL_COUNT; i++) {
    spawnEnemyBullet(w, e.x, e.y, base + (i / C.BOSS_RADIAL_COUNT) * 6.28, 260, 7, 1, "#a24bff", 2.6);
  }
  ev.push({ t: "radialBurst", x: e.x, y: e.y });
}

function bossChase(w: WorldState, e: Enemy, dt: number): void {
  if (!findTarget(w, e.x, e.y)) return;
  const angle = Math.atan2(w.targetY - e.y, w.targetX - e.x);
  const mult = e.boss && e.boss.phase >= 3 ? 1.2 : 1;
  const step = e.speed * mult * dt;
  moveEnemyBy(w, e, Math.cos(angle) * step, Math.sin(angle) * step);
}

function spawnBossMinion(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  if (w.enemies.length >= C.BOSS_MINION_CAP) return;
  // The recoil pop fires regardless (matches the old triggerRecoil-before-wall-check);
  // the particle burst + near-cam sound/trauma only fire when a minion actually spawns.
  const a = w.rng.next() * Math.PI * 2;
  const mx = e.x + Math.cos(a) * (e.radius + 20);
  const my = e.y + Math.sin(a) * (e.radius + 20);
  if (isWall(w, mx, my)) { ev.push({ t: "bossAddSpawn", eid: e.id, x: e.x, y: e.y, mx: e.x, my: e.y, spawned: false }); return; }
  w.enemies.push(createEnemy("slime", mx, my, w.floor, w.rng, w.nextEnemyId++));
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
  // Rebuild trigger keys off the primary player's tile (solo: LOCAL_ID, unchanged). The field
  // itself is sourced from EVERY living player (solo: exactly one, so identical), so enemies
  // flow toward whichever player is nearest.
  const key = primaryPlayer(w);
  const isUp = key !== undefined && !key.isDown && key.hp > 0;
  const ptx = key ? Math.floor(key.x / TILE) : -1;
  const pty = key ? Math.floor(key.y / TILE) : -1;
  const tileChanged = isUp && (ptx !== w.flowKeyTx || pty !== w.flowKeyTy);
  if (w.flowCd > 0 && !tileChanged && w.flow.isReady()) return;
  w.flowCd = C.FLOW_REBUILD;
  w.flowKeyTx = ptx; w.flowKeyTy = pty;

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
  // Local obstacle avoidance: props/chests aren't in the flow field, so a chaser would
  // path straight into a chest and wedge. Probe ahead; if a prop sits there, deflect the
  // heading around it so the enemy curves past instead of grinding into it.
  angle = avoidPropAhead(w, e, angle);
  const x0 = e.x, y0 = e.y;
  moveEnemyBy(w, e, Math.cos(angle) * step, Math.sin(angle) * step);
  const moved = Math.hypot(e.x - x0, e.y - y0);
  const isBlocked = step > C.STUCK_MIN_STEP && moved < step * C.STUCK_PROGRESS;
  e.stuckTimer = isBlocked ? e.stuckTimer + dt : 0;
  if (e.stuckTimer < C.STUCK_TIME) return;
  e.stuckTimer = 0;
  // Wedged: a strong perpendicular escape on both sides, then a hard back-diagonal, so a
  // chaser never freezes against geometry or a prop.
  const side = Math.sin(e.zig) >= 0 ? 1 : -1;
  const esc = step * 1.6;
  if (nudgeEnemy(w, e, angle + side * C.HALF_PI, esc)) return;
  if (nudgeEnemy(w, e, angle - side * C.HALF_PI, esc)) return;
  nudgeEnemy(w, e, angle + side * (Math.PI * 0.75), esc);
}

// If a live prop lies within a short probe ahead of `angle`, return a deflected heading
// that curves around it; otherwise return `angle`.
function avoidPropAhead(w: WorldState, e: Enemy, angle: number): number {
  const probe = e.radius + 22;
  const px = e.x + Math.cos(angle) * probe, py = e.y + Math.sin(angle) * probe;
  let hit: Prop | null = null;
  let hitD2 = Infinity;
  for (const p of w.props) {
    if (p.dead) continue;
    const rr = e.radius + p.radius;
    const ddx = px - p.x, ddy = py - p.y, d2 = ddx * ddx + ddy * ddy;
    if (d2 < rr * rr && d2 < hitD2) { hit = p; hitD2 = d2; }
  }
  if (!hit) return angle;
  const toProp = Math.atan2(hit.y - e.y, hit.x - e.x);
  let diff = angle - toProp;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  const turn = diff >= 0 ? 1 : -1;
  return angle + turn * (Math.PI / 4);
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
      if (p.hp <= 0) { destroyProp(w, p, ev, resolveOwner(w, b.owner)); break; }
    }
    if (p.breakT === undefined) {
      for (const player of w.players.values()) {
        const swing = player.meleeSwing;
        if (!swing || swing.timer <= 0 || !isPointInMeleeHit(player, p.x, p.y, p.radius, swing)) continue;
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
// explosive barrel credits its kills to the right player. Falls back to the primary player if a
// caller can't attribute it. Solo: always the one player, so behavior is unchanged.
function destroyProp(w: WorldState, p: Prop, ev: SimEvent[], by?: PlayerSim): void {
  if (p.breakT !== undefined || p.kind === "brazier") return;
  p.dead = true;
  p.breakT = 0;
  const player = by ?? primaryPlayer(w);
  switch (p.kind) {
    case "crate":
      ev.push({ t: "propBreak", kind: "crate", x: p.x, y: p.y });
      if (w.rng.next() < 0.6) w.pickups.push(makePickup("coin", p.x, p.y, ev));
      if (w.rng.next() < 0.15) w.pickups.push(makePickup("heart", p.x + 12, p.y, ev));
      break;
    case "pot":
      ev.push({ t: "propBreak", kind: "pot", x: p.x, y: p.y });
      if (w.rng.next() < 0.35) w.pickups.push(makePickup("coin", p.x, p.y, ev));
      break;
    case "barrel":
      ev.push({ t: "propBreak", kind: "barrel", x: p.x, y: p.y });
      if (w.rng.next() < 0.45) w.pickups.push(makePickup("coin", p.x, p.y, ev));
      break;
    case "barrel_explosive":
      if (player) explodeBarrel(w, player, p, ev);
      break;
  }
}

function explodeBarrel(w: WorldState, p: PlayerSim, source: Prop, ev: SimEvent[]): void {
  const r = C.BARREL_EXPLOSION_RADIUS;
  ev.push({ t: "explosion", x: source.x, y: source.y, r });
  for (const e of w.enemies) {
    if (e.dead) continue;
    if (Math.hypot(e.x - source.x, e.y - source.y) > r + e.radius) continue;
    e.hp -= C.BARREL_EXPLOSION_DAMAGE;
    ev.push({ t: "flash", eid: e.id });
    ev.push({ t: "puff", x: e.x, y: e.y, n: 6, color: ENEMY_ARCHETYPES[e.kind].tint });
    applyBurn(e, C.BARREL_BURN_SECS, p.id);
    if (e.hp <= 0 && !e.dead) killEnemy(w, p, e, ev);
  }
  for (const victim of w.players.values()) {
    if (victim.invuln === 0 && !victim.isDown && victim.hp > 0
      && Math.hypot(victim.x - source.x, victim.y - source.y) <= r) {
      damagePlayer(w, victim, C.BARREL_EXPLOSION_SELF_DMG, ev);
    }
  }
  for (const other of w.props) {
    if (other === source || other.breakT !== undefined || other.kind === "brazier") continue;
    if (Math.hypot(other.x - source.x, other.y - source.y) <= r + other.radius) destroyProp(w, other, ev, p);
  }
}

function updateChests(w: WorldState, dt: number, ev: SimEvent[]): void {
  if (w.chests.length === 0) return;
  for (const c of w.chests) {
    if (!c.opened) {
      for (const b of w.bullets) {
        if (!b.friendly || b.life <= 0) continue;
        if (Math.hypot(b.x - c.x, b.y - c.y) >= b.radius + c.radius) continue;
        // Credit the BULLET's owner (the actual shooter), falling back to the primary player only
        // if that shooter has since disconnected (bullet outlived them). Solo: the one player.
        const opener = resolveOwner(w, b.owner);
        if (opener) openChest(w, opener, c, ev);
        if (b.pierce > 0) b.pierce--; else b.life = 0;
        break;
      }
    }
    if (!c.opened) {
      for (const player of w.players.values()) {
        const swing = player.meleeSwing;
        if (swing && swing.timer > 0 && isPointInMeleeHit(player, c.x, c.y, c.radius, swing)) {
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
  if (c.kind === "boss") grantBossChest(w, p, c, ev);
  else rollWoodChest(w, p, c, ev);
}

function rollWoodChest(w: WorldState, p: PlayerSim, c: Chest, ev: SimEvent[]): void {
  const r = w.rng.next();
  if (r < 0.55) {
    const n = 3 + Math.floor(w.rng.next() * 4);
    for (let i = 0; i < n; i++) w.pickups.push(makePickup("coin", c.x + (i - (n - 1) / 2) * 14, c.y + 12, ev));
  } else if (r < 0.75) {
    w.pickups.push(makePickup("heart", c.x, c.y, ev));
  } else if (r < 0.93) {
    ev.push({ t: "offerBlessing", pid: p.id });
  } else {
    const weapon = PICKUP_WEAPONS[Math.floor(w.rng.next() * PICKUP_WEAPONS.length)];
    w.pickups.push({ kind: "weapon", x: c.x, y: c.y, radius: 16, weapon });
  }
}

function grantBossChest(w: WorldState, p: PlayerSim, c: Chest, ev: SimEvent[]): void {
  w.pickups.push(makePickup("heart", c.x - 18, c.y, ev));
  for (let i = 0; i < 5; i++) w.pickups.push(makePickup("coin", c.x + (i - 2) * 16, c.y + 18, ev));
  ev.push({ t: "offerBlessing", pid: p.id });
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
          const pull = Math.min(d, C.COIN_MAGNET_PULL * dt);
          p.x += (dx / d) * pull; p.y += (dy / d) * pull;
        }
      }
      if (!player.isDown && Math.hypot(player.x - p.x, player.y - p.y) < player.pr + p.radius) {
        if (p.kind === "coin") { player.coins += p.value ?? coinGain(player); ev.push({ t: "pickup", pid: player.id, kind: "coin", x: p.x, y: p.y }); collected = true; break; }
        if (p.kind === "heart") {
          if (player.hp < player.maxHp) { player.hp++; ev.push({ t: "pickup", pid: player.id, kind: "heart", x: p.x, y: p.y }); collected = true; break; }
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
  p.hp -= amount;
  p.invuln = 0.9;
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
      // Solo has one player, so this emits exactly one gameOver as before.
      for (const other of w.players.values()) ev.push({ t: "gameOver", pid: other.id });
    }
  }
}

// Authoritative revive: a living teammate standing within REVIVE_RADIUS of a downed player for
// REVIVE_HOLD seconds brings them back. Progress decays when no one is nearby, so it takes a
// sustained hold. Solo never has a downed player with a standing ally, so this no-ops there.
function updateRevives(w: WorldState, dt: number, ev: SimEvent[]): void {
  for (const downed of w.players.values()) {
    if (!downed.isDown) continue;
    let reviver: PlayerSim | undefined;
    for (const other of w.players.values()) {
      if (other === downed || other.isDown || other.hp <= 0) continue;
      if (Math.hypot(other.x - downed.x, other.y - downed.y) <= C.REVIVE_RADIUS) { reviver = other; break; }
    }
    if (reviver) {
      downed.reviveProgress += dt;
      if (downed.reviveProgress >= C.REVIVE_HOLD) {
        downed.isDown = false;
        downed.hp = Math.min(downed.maxHp, C.REVIVE_HP);
        downed.invuln = Math.max(downed.invuln, C.REVIVE_INVULN);
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
  const isCleared = w.enemies.length === 0;
  if (!isCleared) return;
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
  // shared-floor orchestration (everyone descends together via presence).
  if (w.isCoop) ev.push({ t: "reachExit", toFloor: w.floor + 1 });
  else descend(w, w.floor + 1, ev);
}

// A floor descent (solo). Co-op's shared-floor sync is orchestrated client-side; the
// client calls descend via stepWorld's exit check or directly on a coop descend request.
export function descend(w: WorldState, nextFloor: number, ev: SimEvent[]): void {
  w.floor = nextFloor;
  for (const p of w.players.values()) {
    p.combo = 0; p.comboTimer = 0;
    p.isDown = false;
    p.reviveProgress = 0;
    p.hp = Math.min(p.maxHp, p.hp + 2);
  }
  ev.push({ t: "descend", toFloor: nextFloor });
  loadFloorIntoWorld(w, nextFloor);
  // Offer a between-floor blessing to EVERY player (solo: the one LOCAL_ID player, identical to
  // before). The server turns each offer into that client's seeded choice set (see the server's
  // offer handling); solo rolls its own choices client-side.
  for (const p of w.players.values()) ev.push({ t: "offerBlessing", pid: p.id });
}

// ---- the step ----

// Advance ONE player for one input over dt: aim, movement/dash/collision, shooting, and the
// melee-swing timer. This is the per-player half of stepWorld, factored out so the
// authoritative server and client prediction can step ONLY the local player at an arbitrary
// dt (each InputCmd carries its own frame dt) while the world half runs once per fixed tick.
// stepWorld itself calls this, so solo behavior is unchanged.
export function stepPlayerPhase(w: WorldState, p: PlayerSim, input: InputCmd, dt: number, ev: SimEvent[]): void {
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
  updateExit(w, ev);

  for (const p of w.players.values()) {
    if (p.comboTimer > 0) {
      p.comboTimer -= dt;
      if (p.comboTimer <= 0) { p.comboTimer = 0; p.combo = 0; }
    }
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
  const e = createEnemy(kind, x, y, w.floor, w.rng, w.nextEnemyId++);
  w.enemies.push(e);
  return e;
}
export function devSpawnProp(w: WorldState, kind: Prop["kind"], x: number, y: number): void {
  w.props.push({ id: w.nextPropId++, kind, x, y, radius: C.PROP_RADIUS, hp: C.PROP_HP[kind], dead: false });
}
export function devSpawnChest(w: WorldState, x: number, y: number): void {
  w.chests.push({ kind: "wood", x, y, radius: 16, opened: false });
}
