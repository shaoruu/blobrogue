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
import type { FlowField } from "./pathfind.js";
import { createNav, markNavTargets, navChaseField, navReachField, navClassFor, navStepPoint, navPoint } from "./nav.js";
import type { NavRuntime } from "./nav.js";
import { TILE } from "./types.js";
import type { Enemy, Bullet, Pickup, Prop, Chest, Hazard, FloorHazard, WeaponId, AttackMove, TileKind } from "./types.js";
import { placeFloorHazards, isFloorHazardDamaging, floorHazardPhaseAt, FLOOR_HAZARD_DAMAGE, RIFT_PULL_RADIUS, RIFT_PULL_SPEED } from "./hazards.js";
import { Rng } from "./rng.js";
import {
  ENEMY_ARCHETYPES, BOSS_KIN, spawnFloorEnemies, createEnemy, threatCostOf, isBossFloor,
  isBossKind, isComplexMover, isGauntletFloor, eliteAffixOf, isMinibossKind,
} from "./enemies.js";
import { WEAPONS, DEFAULT_WEAPON, PICKUP_WEAPONS, fire } from "./weapons.js";
import type { ShotSpec } from "./weapons.js";
import { createMods, recomputeMods, itemLevelsOf, MAX_ITEM_LEVEL } from "./items.js";
import type { PlayerMods, ItemDef } from "./items.js";
import type { SimEvent } from "./events.js";
import type { InputCmd, PlayerId } from "./input.js";
import { LOCAL_ID, IDLE_INPUT } from "./input.js";
import * as C from "./constants.js";
import {
  PLAYER, SUSTAIN, DEALER, REVIVE, FANG_PROC_COOLDOWN, BOSS, MARROW, CHOIR, WEAVER, GILDED,
  GAUNTLET, gauntletCaptainHp, CAPS, TIERS, coopBossHpMult,
  activeThreatCap, clampPlayers, coopThreatMult, coopHeartRateMult,
  REINFORCE_STAGGER, BIOME_PRESSURE, BRUTE_HEAVY_DAMAGE, ELITE_BRACE, BOSS_VULN_CAP,
  ELITE_COMMANDER, ELITE_BULWARK, ELITE_VOLATILE, ELITE_ECHOED, MARSHAL, TOLL,
  WEAPON_BOSS_COEF, WIPE_HOLD_SECONDS,
  LIVE_CAPS, activeMoverCapFor, pedestalWeaponRolls, bossWeaponChoices, dealerWeaponStock,
} from "./balance.js";
import { isControllerKind } from "./bestiary.js";
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
  // The blade's boss coefficient (WEAPON_BOSS_COEF), baked when the swing starts.
  bossCoef: number;
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
  // The crit multiplier baked into damage when isCrit (1 otherwise) — the boss
  // vulnerability channel divides it out and re-applies it capped.
  critX: number;
  // Boss-facing pellet/weapon coefficient baked at fire time. 1 for melee.
  bossCoef: number;
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
  // Network-absent (authoritative server only): the player's connection dropped and their body
  // is RESERVED for the reconnect grace window. An absent body is paused and safe — it cannot
  // act, take damage, attract enemies, collect loot, or open chests — and it is excluded from
  // the exit/blessing gates so it can neither trigger nor deadlock a party transition. It
  // still counts as ALIVE for the wipe checks (a resumed player can revive the party), which
  // is exactly what keeps a brief Wi-Fi drop from reading as a death. Solo/co-op/prediction
  // never set this.
  isAbsent: boolean;
  // Seconds a teammate has been reviving this downed player (authoritative revive hold). 0 when
  // up or when no one is reviving. Solo never downs, so this stays 0.
  reviveProgress: number;
  // WHO is channeling this downed player's revive (gate §6: one reviver only, 1.5s
  // UNINTERRUPTED). Identity makes the cancel rules exact: the channeler's damage, dash,
  // attack, or exit resets the channel; a bystander's does not. Null when up / unattended.
  reviveBy: PlayerId | null;
  // Downs on THIS floor (gate §1, Standard: 3/player/floor). Past the limit the player is
  // OUT — unrevivable until the party's descent rescues them. Reset every floor.
  downsThisFloor: number;
  // Whether this player's interact key (E) is held THIS tick — the explicit revive-channel
  // intent. Derived from the consumed input every stepPlayerPhase, never wired: the server
  // sets it from the inputs it consumes, prediction from the same inputs locally.
  isInteracting: boolean;
  // Lag-compensation rewind for THIS player's shots/swings, in ticks (server-computed from the
  // player's measured RTT + interp delay, clamped). 0 in solo/prediction, so hit tests use
  // present-time positions and behavior is unchanged.
  rewindTicks: number;
  kills: number; coins: number; combo: number; comboTimer: number;
  ownedItemIds: string[];
  meleeSwing: MeleeSwing | null;
  // Studio gate §4: the boss chest offers P+1 weapon CHOICES and each player claims exactly
  // one per boss floor. Reset on every floor build.
  hasClaimedBossChoice: boolean;
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
  // Authored ground hazards (the Weaver's webs): shared authoritative floor state, capped
  // and self-expiring; rebuilt empty on every floor load.
  hazards: Hazard[];
  // Environmental FLOOR hazards (depth escalation) — distinct from the boss webs above:
  // layout is derived per floor from the seed (never on the wire); pulse timing keys off
  // floorHazardClock — accumulated SIM seconds, monotonic across floors like tick, so
  // solo (60Hz) and the server (20Hz) agree on cycles in real time and an online client
  // can reconstruct it as tick x FIXED_DT.
  floorHazards: FloorHazard[];
  floorHazardClock: number;
  // Overlap arbiter (studio gate §2): damage releases mobs committed in the last 0.30s.
  // A new mob release whose area overlaps a recent one HOLDS until the window clears — no
  // two releases may pincer the same escape lane inside one reaction window. (Seeded
  // floor-hazard groups arbitrate the same rule at placement time — see hazards.ts.)
  recentReleases: Array<{ x: number; y: number; radius: number; t: number }>;
  // The F10 Arena Gauntlet stage machine (curriculum §2): `stage` counts spawned stages,
  // `breath` is the authored 1.2s beat between a clear and the next entrance, and
  // `isRewarded` latches once the premium chest has dropped. Null on ordinary floors.
  gauntlet: { stage: number; breath: number; isRewarded: boolean } | null;
  dungeon: Dungeon;
  // Dynamic-obstacle navigation caches (prop clearance grid + per-class flow fields).
  // Derived data only — never on the wire; every consumer rebuilds lazily off
  // (obstacleRev, flowKey), so server and clients always agree.
  nav: NavRuntime;
  // Obstacle revision: increments whenever the blocking prop set changes (floor build,
  // prop destroyed, dev spawn). Keys every navigation cache; content systems that
  // destroy cover (charges, slams) bump it implicitly through destroyProp.
  obstacleRev: number;
  flowCd: number;
  // Combined hash of every living source tile; the chase fields rebuild when it changes.
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
  nextHazardId: number;
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
  // Seconds EVERY player has been down simultaneously (gate §6): the wipe is a held
  // 4.0s all-down beat, not an instant cut. Resets whenever anyone is standing.
  wipeTimer: number;
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
    shotSeq: 0, isDown: false, isAbsent: false, reviveProgress: 0, reviveBy: null, downsThisFloor: 0, isInteracting: false, rewindTicks: 0,
    kills: 0, coins: 0, combo: 0, comboTimer: 0,
    ownedItemIds: [],
    meleeSwing: null,
    hasClaimedBossChoice: false,
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
    hazards: [],
    floorHazards: [],
    floorHazardClock: 0,
    recentReleases: [],
    gauntlet: null,
    dungeon: { w: 0, h: 0, tiles: [], rooms: [], spawn: { x: 0, y: 0 }, exit: { x: 0, y: 0 } },
    nav: createNav(),
    obstacleRev: 0,
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
    nextHazardId: 0,
    enemyHist: new Map(),
    histHead: 0,
    histCount: 0,
    pendingBlessings: new Map(),
    isBlessingOfferedThisFloor: false,
    wipeTimer: 0,
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
    const p = createPlayer(LOCAL_ID, spawn.x * TILE + TILE / 2, spawn.y * TILE + TILE / 2);
    // Run start is a floor entry too: the same spawn grace every descend grants (the
    // reposition loop in loadFloorIntoWorld ran before this player existed).
    p.invuln = C.PLAYER_SPAWN_GRACE;
    w.players.set(LOCAL_ID, p);
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

// Remove a player from a live world (authoritative server: deliberate leave, or the reconnect
// grace expiring). Returns whether a player was actually removed. Their pending blessing offer
// (if any) dies with them so the descend gate can't be held by a player who is no longer in
// the world.
export function removePlayerFromWorld(w: WorldState, id: PlayerId): boolean {
  w.pendingBlessings.delete(id);
  for (const downed of w.players.values()) {
    if (downed.reviveBy === id) { downed.reviveBy = null; downed.reviveProgress = 0; }
  }
  return w.players.delete(id);
}

// Flip a player's network-absence (authoritative server: socket dropped -> reserved seat;
// resume -> back). Returning from absence grants the spawn-grace mercy window: the world kept
// moving while they were gone, and materializing into a surrounding pack un-hittable-for-a-
// beat beats materializing already dying.
export function setPlayerAbsence(w: WorldState, id: PlayerId, isAbsent: boolean): void {
  const p = w.players.get(id);
  if (!p || p.isAbsent === isAbsent) return;
  p.isAbsent = isAbsent;
  if (!isAbsent) p.invuln = Math.max(p.invuln, C.PLAYER_SPAWN_GRACE);
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
  const room: Room = { x: 1, y: 1, w: w - 2, h: h - 2, cx: w >> 1, cy: h >> 1, kind: "normal", shape: "rect" };
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
  w.hazards = [];
  w.recentReleases = [];
  w.gauntlet = !w.isSandbox && isGauntletFloor(floor) ? { stage: 0, breath: 0, isRewarded: false } : null;
  w.nextEnemyId = 0;
  w.nextPropId = 0;
  w.nextPickupId = 0;
  w.nextChestId = 0;
  w.nextHazardId = 0;
  w.heartsThisFloor = 0;
  w.isFloorEnteredLow = [...w.players.values()].some((p) => p.hp < p.maxHp * SUSTAIN.pityLowHpFrac);
  w.pendingBlessings.clear();
  w.wipeTimer = 0;
  w.isBlessingOfferedThisFloor = false;
  w.flowCd = 0;
  w.flowKey = -1;
  w.pickups = [];
  for (const p of w.players.values()) p.hasClaimedBossChoice = false;
  // Floor hazards place FIRST: props/chests/dealer stock then avoid hazard tiles (a
  // barrel on spikes reads as a bug). floorHazardClock is NOT reset — it is monotonic
  // sim time (phases are per-hazard), so an online client reconstructs it from the tick.
  w.floorHazards = w.isSandbox ? [] : placeFloorHazards(w.dungeon, w.seed, floor);
  // Obstacles land BEFORE enemies: spawn settling needs the floor's real prop/chest
  // footprint, and the obstacle revision must already name this floor's layout. The
  // ordering is free — every placement draws from its own seeded stream.
  w.props = w.isSandbox ? [] : placeProps(w);
  w.chests = w.isSandbox ? [] : placeChests(w);
  if (!w.isSandbox) {
    stockWeaponChests(w);
    placeDealerStock(w);
  }
  w.obstacleRev++;
  const spawns = w.isSandbox
    ? { active: [], pending: [] }
    : spawnFloorEnemies(w.dungeon, w.seed, floor, w.encounterPlayers);
  w.enemies = spawns.active;
  w.pendingSpawns = spawns.pending;
  w.spawnReleaseCd = 0;
  w.nextEnemyId = spawns.active.length + spawns.pending.length;
  // Every planned unit — the active wave AND the queued reinforcements — settles onto a
  // spawn point with full body clearance and a route to the playable region now, at
  // build time. Props only ever VANISH mid-floor, so a point valid here is still valid
  // when a reinforcement releases.
  for (const e of w.enemies) settleEnemySpawn(w, e);
  for (const e of w.pendingSpawns) settleEnemySpawn(w, e);
  // Reposition living players to the new spawn, each under the spawn-grace mercy window:
  // nobody loads into a fresh floor (a boss floor especially) already taking damage.
  const spawn = w.dungeon.spawn;
  for (const p of w.players.values()) {
    p.x = spawn.x * TILE + TILE / 2;
    p.y = spawn.y * TILE + TILE / 2;
    p.invuln = Math.max(p.invuln, C.PLAYER_SPAWN_GRACE);
  }
}

// Floor cleared = every active enemy dead AND no reinforcements still queued. The exit,
// the snapshot `cleared` flag, and the client HUD/minimap all read this one predicate.
export function isFloorCleared(w: WorldState): boolean {
  if (w.gauntlet !== null && (w.gauntlet.stage < GAUNTLET.rounds.length || !w.gauntlet.isRewarded)) return false;
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

// The floor's weapon drops are CONTENTS of chests (pedestals), never loose floor pickups.
// (They used to spawn at room centers — the same tiles chests and props prefer — so guns
// sat visibly stacked on top of chests, and free weapons in the open undercut chests as the
// reward container.) Each pedestal is stocked into a weaponless wood chest, treasure room
// first; when the floor placed fewer chests than pedestals, an extra chest is placed to
// hold the overflow, roomed where the loose drop used to land. Opening the chest ejects the
// contents (see openChest).
//
// Studio gate §4 pedestal rolls: max(1, ceil(P/2)) physical weapons per floor (P1–2
// roll 1, P3–4 roll 2), DISTINCT ids when the pool permits. Party size buys options,
// never rarity — the roll table is identical solo and co-op.
function stockWeaponChests(w: WorldState): void {
  const d = w.dungeon;
  if (w.floor < 2 || d.rooms.length <= 2) return;
  const rng = new Rng((w.seed ^ 0x51ed270b) + w.floor * 40503);
  const kinds: WeaponId[] = [];
  for (let i = 0; i < pedestalWeaponRolls(w.encounterPlayers); i++) {
    kinds.push(rollDistinctWeapon(rng, kinds));
  }
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

// A weapon roll that avoids the ids already taken this batch (distinct while the pool
// permits — with a 17-weapon pool the retry loop is a formality, but bounded regardless).
function rollDistinctWeapon(rng: Rng, taken: readonly WeaponId[]): WeaponId {
  let pick = rng.pick(PICKUP_WEAPONS);
  for (let i = 0; i < PICKUP_WEAPONS.length && taken.includes(pick); i++) pick = rng.pick(PICKUP_WEAPONS);
  return pick;
}

// The Dealer's stock (§2 + studio gate §4): on every third floor, P purchasable hearts
// plus max(2, P) DISTINCT weapons at the fixed 12/18/24 price ladder, near a mid-run room
// center. Hearts buy exactly +1 HP — never a full heal. Weapon purchases are PERSONAL:
// buying one never depletes a teammate's stock (see updatePickups), and prices/stats are
// identical solo and co-op.
function placeDealerStock(w: WorldState): void {
  if (w.floor % DEALER.floorInterval !== 0 || isBossFloor(w.floor)) return;
  const d = w.dungeon;
  if (d.rooms.length < 3) return;
  const rng = new Rng((w.seed ^ 0x0dea1e12) + w.floor * 68927);
  // The stall row needs clean ground: never a sealed vault's sanctum (its center IS the
  // chest tile — a buyer's touch would pop the chest mid-purchase) and never any room
  // whose center already holds a chest, for the same reason.
  const hasCenterChest = (r: Room): boolean =>
    w.chests.some((c) => Math.floor(c.x / TILE) === r.cx && Math.floor(c.y / TILE) === r.cy);
  const treasure = d.rooms.find((r) => r.kind === "treasure");
  let room = treasure && treasure.shape !== "vault" && !hasCenterChest(treasure) ? treasure : null;
  if (!room) {
    const candidates = d.rooms.slice(1, d.rooms.length - 1).filter((r) => r.shape !== "vault" && !hasCenterChest(r));
    if (candidates.length === 0) return;
    room = candidates[rng.int(0, candidates.length - 1)];
  }
  const stock = w.encounterPlayers;
  for (let i = 0; i < stock; i++) {
    w.pickups.push({
      id: w.nextPickupId++, kind: "dealer_heart",
      x: (room.cx + 0.5) * TILE + (i - (stock - 1) / 2) * 30, y: (room.cy + 0.5) * TILE - 26,
      radius: 13, weapon: null, value: DEALER.price,
    });
  }
  const weapons: WeaponId[] = [];
  const weaponStock = dealerWeaponStock(w.encounterPlayers);
  for (let i = 0; i < weaponStock; i++) {
    const weapon = rollDistinctWeapon(rng, weapons);
    weapons.push(weapon);
    w.pickups.push({
      id: w.nextPickupId++, kind: "dealer_weapon",
      x: (room.cx + 0.5) * TILE + (i - (weaponStock - 1) / 2) * 34, y: (room.cy + 0.5) * TILE + 14,
      radius: 15, weapon, value: DEALER.weaponPrices[Math.min(i, DEALER.weaponPrices.length - 1)],
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
  const addProp = (kind: Prop["kind"], tx: number, ty: number) => {
    occupied.add(ty * d.w + tx);
    list.push({ id: w.nextPropId++, kind, x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE, radius: C.PROP_RADIUS, hp: C.PROP_HP[kind], dead: false });
  };

  // Boss arenas stage an AUTHORED ring of destructible cover just outside the squeeze's
  // final safe radius: real cover to fight from, and real physics when the boss's slams,
  // charges and body smash through it (enemySmashEnvironment). Explosive barrels in the
  // ring make slamming a fuel cluster the boss's own problem.
  const arena = isBossFloor(w.floor) ? d.rooms[d.rooms.length - 1] : null;
  if (arena) {
    const ringR = Math.min(arena.w, arena.h) * TILE * 0.3;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + rng.range(-0.25, 0.25);
      const tx = Math.floor(((arena.cx + 0.5) * TILE + Math.cos(a) * ringR) / TILE);
      const ty = Math.floor(((arena.cy + 0.5) * TILE + Math.sin(a) * ringR) / TILE);
      const idx = ty * d.w + tx;
      if (occupied.has(idx) || d.tiles[idx] !== 0 || hasFloorHazardOnTile(w, tx, ty)) continue;
      if (Math.abs(tx - arena.cx) + Math.abs(ty - arena.cy) <= 1) continue; // exit tile ground
      const r = rng.next();
      addProp(r < 0.5 ? "crate" : r < 0.8 ? "barrel" : "barrel_explosive", tx, ty);
    }
  }

  for (const room of d.rooms) {
    if (room === arena) continue; // the arena's cover is authored above
    // Room-aware density: pillared halls and fighting pits carry more cover; hazard
    // set-piece rooms stay lean — their floor is the obstacle, and flocks/dodges need
    // the open lanes.
    const target = room.kind === "hazard" ? rng.int(1, 2)
      : (room.shape === "pillars" || room.shape === "arena") ? rng.int(4, 7)
      : rng.int(3, 6);
    for (let i = 0; i < target; i++) {
      const tx = room.x + rng.int(0, room.w - 1);
      const ty = room.y + rng.int(0, room.h - 1);
      const idx = ty * d.w + tx;
      if (occupied.has(idx) || d.tiles[idx] !== 0 || hasFloorHazardOnTile(w, tx, ty)) continue;
      if (isCorridorMouth(d, tx, ty)) continue;
      // Room centers are reserved ground: chests and dealer stock land there (a vault's
      // chest belongs INSIDE its ring, not wherever a crate left space).
      if (Math.abs(tx - room.cx) + Math.abs(ty - room.cy) <= 1) continue;
      if (Math.abs(tx - d.spawn.x) <= 1 && Math.abs(ty - d.spawn.y) <= 1) continue;
      if (Math.abs(tx - d.exit.x) <= 1 && Math.abs(ty - d.exit.y) <= 1) continue;
      addProp(rollPropKind(rng, hazardMult), tx, ty);
    }
  }
  return list;
}

function isRoomTile(d: Dungeon, tx: number, ty: number): boolean {
  for (const r of d.rooms) {
    if (tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h) return true;
  }
  return false;
}

// A room tile with corridor floor beside it is a DOOR MOUTH: a prop there can seal a
// room's only connection to the rest of the floor (observed in a live-seed audit — two
// barrels stacked across a 2-wide corridor mouth cut half the map off the spawn, and
// with braziers the barricade isn't even breakable). Props are placed per-room so
// corridors themselves never take one; guarding the mouths keeps the whole floor graph
// connected for every clearance class.
function isCorridorMouth(d: Dungeon, tx: number, ty: number): boolean {
  const isCorridorFloor = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < d.w && y < d.h && d.tiles[y * d.w + x] === 0 && !isRoomTile(d, x, y);
  return isCorridorFloor(tx + 1, ty) || isCorridorFloor(tx - 1, ty) || isCorridorFloor(tx, ty + 1) || isCorridorFloor(tx, ty - 1);
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
    hasFloorHazardOnTile(w, tx, ty) ||
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

function hasFloorHazardOnTile(w: WorldState, tx: number, ty: number): boolean {
  for (const h of w.floorHazards) if (h.tx === tx && h.ty === ty) return true;
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
    const rr = r + p.radius * C.PROP_BLOCK_RING;
    const ddx = x - p.x, ddy = y - p.y;
    if (ddx * ddx + ddy * ddy < rr * rr) return true;
  }
  return false;
}

// ---- dynamic-obstacle navigation (see nav.ts for the module rationale) ----

// The prop-aware chase field for a body of this radius (lazily rebuilt off the current
// targets + obstacle revision — see refreshNav / nav.ts).
function chaseFieldFor(w: WorldState, radius: number): FlowField {
  return navChaseField(w.nav, w.dungeon, w.props, w.obstacleRev, navClassFor(radius));
}

// Reachability from the floor spawn tile (where players enter — and the only region a
// player can ever walk, since obstacles only OPEN mid-floor). The oracle behind every
// spawn-position validation.
function reachFieldFor(w: WorldState, radius: number): FlowField {
  const d = w.dungeon;
  return navReachField(w.nav, d, w.props, w.obstacleRev, navClassFor(radius), d.spawn.y * d.w + d.spawn.x);
}

// Whether a body of radius `r` can physically exist at (x, y): the same wall probes
// movement uses, outside every live prop's collision ring, and off every chest footprint
// (chests never block movement, but a body materializing ON one reads as a bug).
function isBodyClear(w: WorldState, x: number, y: number, r: number): boolean {
  if (isWall(w, x, y) || isWall(w, x - r, y) || isWall(w, x + r, y) || isWall(w, x, y - r) || isWall(w, x, y + r)) return false;
  if (blockedByProp(w, x, y, r)) return false;
  for (const c of w.chests) {
    const rr = r + c.radius;
    const dx = x - c.x, dy = y - c.y;
    if (dx * dx + dy * dy < rr * rr) return false;
  }
  return true;
}

// Shared scratch for settleSpawnPoint (read immediately by callers).
const settlePoint = { x: 0, y: 0 };

// Validate a spawn point for a body of radius `r`, or deterministically relocate it: the
// intended point stands when it is body-clear AND its tile has a route to the playable
// region; otherwise the scan walks outward over Chebyshev tile rings (fixed order — no
// RNG, so spawn placement never shifts any seeded stream) and takes the first reachable,
// body-clear tile center. Returns false when even the bounded scan finds nothing.
function settleSpawnPoint(w: WorldState, x: number, y: number, r: number): boolean {
  const reach = reachFieldFor(w, r);
  const tx0 = Math.floor(x / TILE), ty0 = Math.floor(y / TILE);
  if (isBodyClear(w, x, y, r) && reach.distAt(tx0, ty0) >= 0) {
    settlePoint.x = x;
    settlePoint.y = y;
    return true;
  }
  for (let ring = 1; ring <= C.SPAWN_SCAN_RINGS; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const tx = tx0 + dx, ty = ty0 + dy;
        if (reach.distAt(tx, ty) < 0) continue; // wall / prop-blocked / unreachable pocket
        const cx = (tx + 0.5) * TILE, cy = (ty + 0.5) * TILE;
        if (!isBodyClear(w, cx, cy, r)) continue; // off-center prop ring / chest footprint
        settlePoint.x = cx;
        settlePoint.y = cy;
        return true;
      }
    }
  }
  return false;
}

// Settle a freshly created floor enemy onto its validated spawn point. Falls back to the
// intended point when the bounded scan finds nothing (never worse than the old behavior;
// practically unreachable — a scan ring covers any generatable room).
function settleEnemySpawn(w: WorldState, e: Enemy): void {
  if (settleSpawnPoint(w, e.x, e.y, e.radius)) {
    e.x = settlePoint.x;
    e.y = settlePoint.y;
  }
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
    basePellets: wep.pellets,
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
    blast: wep.blast,
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
// and by dev/grant. Manual switching (1-9 / scroll / hotbar) goes through the validated
// switchWeaponInWorld below on every path (LocalTransport and the server).
function acquireWeapon(p: PlayerSim, id: WeaponId): void {
  if (!p.ownedWeapons.includes(id)) p.ownedWeapons.push(id);
  equipWeapon(p, id);
}

// Authoritative, validated weapon switch (LocalTransport + the server's equip handler).
// Equips only a slot the player actually owns; an unowned id is ignored (a tampered client
// can't equip a weapon it never picked up). Returns whether the switch was accepted.
// equipWeapon resets the fire cooldown and cancels any in-progress melee swing.
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

export function reorderWeaponsInWorld(w: WorldState, pid: PlayerId, from: number, to: number): boolean {
  // Authoritative inventory reorder (drag/drop on the hotbar). Moves the slot at `from` to
  // position `to`; every other slot keeps its relative order. The equipped weapon is tracked
  // by ID (p.weapon), so it survives any reorder — only the 1-9 key mapping changes. Both
  // indices must name real slots; a stale index (inventory changed in flight) is rejected.
  const p = w.players.get(pid);
  if (!p) return false;
  const n = p.ownedWeapons.length;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
  if (from < 0 || from >= n || to < 0 || to >= n) return false;
  if (from === to) return true; // no-op reorder is valid (idempotent)
  const [moved] = p.ownedWeapons.splice(from, 1);
  p.ownedWeapons.splice(to, 0, moved);
  return true;
}

export function dropWeaponInWorld(w: WorldState, pid: PlayerId, id: WeaponId, ev: SimEvent[]): boolean {
  // Authoritative weapon drop (Q / inventory UI): remove an OWNED weapon from the player's
  // inventory and spawn it as a shared world pickup on a safe, reachable spot. Gates:
  //  - never while the run is over, the player is downed, or a pick is pending (blessing
  //    or weapon claim — those states pause the player; a drop there would be a free
  //    action or a dupe window);
  //  - never the final weapon — the player always keeps at least one (the default pistol
  //    if that is all they own). Any weapon may be dropped while another remains.
  // If the dropped weapon was equipped, the adjacent slot (same index, else the new last)
  // is equipped so the hand is never empty. Rejected drops mutate nothing.
  const p = w.players.get(pid);
  if (!p) return false;
  if (w.isRunOver || p.isDown || w.pendingBlessings.has(pid)) return false;
  if (p.ownedWeapons.length <= 1) return false;
  const idx = p.ownedWeapons.indexOf(id);
  if (idx < 0) return false;
  const spot = weaponDropSpot(w, p);
  if (!spot) return false; // fully boxed in: keep the weapon rather than spawn it unreachable
  p.ownedWeapons.splice(idx, 1);
  if (p.weapon === id) equipWeapon(p, p.ownedWeapons[Math.min(idx, p.ownedWeapons.length - 1)]);
  const [x, y] = spot;
  w.pickups.push({ id: w.nextPickupId++, kind: "weapon", x, y, radius: 16, weapon: id });
  ev.push({ t: "weaponDrop", weapon: id, x, y });
  return true;
}

function weaponDropSpot(w: WorldState, p: PlayerSim): [number, number] | null {
  // Deterministic candidate scan for a player-initiated drop, sharing the chest-loot safety
  // rules: the spot must be standable (walkable floor with wall margin, prop-free,
  // chest-free) AND straight-line reachable from the dropper, so the pickup is always
  // collectible. Candidates prefer the aim direction (drop lands where the player faces),
  // then fan out; radii walk inner-to-outer starting past pickup range (no instant
  // re-collect). Null when everything nearby is blocked — the caller keeps the weapon.
  const angles = C.CHEST_EJECT_ANGLES;
  for (const radius of C.WEAPON_DROP_RADII) {
    for (const da of angles) {
      const a = p.aimAngle + da;
      const x = p.x + Math.cos(a) * radius;
      const y = p.y + Math.sin(a) * radius;
      if (!isStandableSpot(w, x, y, p.pr)) continue;
      if (!isPathOpen(w, p.x, p.y, x, y, p.pr)) continue;
      return [x, y];
    }
  }
  return null;
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
// descend gate (or their own damage shield) forever. Expiry is EMITTED, not silent — the
// authoritative server clears the matching connection/seat offer off the event (both sides
// resolve on the same tick) and the owning client closes its overlay.
function tickPendingBlessings(w: WorldState, dt: number, ev: SimEvent[]): void {
  if (w.pendingBlessings.size === 0) return;
  for (const [pid, left] of w.pendingBlessings) {
    if (left <= dt) {
      w.pendingBlessings.delete(pid);
      ev.push({ t: "blessingExpired", pid });
    } else {
      w.pendingBlessings.set(pid, left - dt);
    }
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
  return !isBossKind(e.kind) && e.chill >= C.FREEZE_AT;
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
      if (e.dead || isUntargetable(e) || list.indexOf(e) !== -1) continue;
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

// The shared anti-burst transition contract, per boss kind: the King's roar, MARROW's
// shield, the Choir's split, the Weaver's molt and the Warden's sanctify are ONE mechanism
// (damage reduction + hard HP floor + queued overflow) with different thresholds,
// presentation moves and add kinds. Interactive beats (`isBreakable`) track their adds in
// boss.beatAddIds and collapse early once every one of them dies.
interface BossBeatDef {
  phaseAt: readonly number[];
  phaseFloor: readonly number[];
  move: AttackMove;
  damageReduction: number;
  bulletClearRadius: number;
  addCount: number;
  isBreakable: boolean;
}

const BOSS_BEATS: Readonly<Partial<Record<Enemy["kind"], BossBeatDef>>> = {
  boss: {
    phaseAt: BOSS.phaseAt, phaseFloor: BOSS.phaseFloor, move: "roar",
    damageReduction: BOSS.roarDamageReduction, bulletClearRadius: BOSS.roarBulletClearRadius,
    addCount: BOSS.transitionAddCount, isBreakable: false,
  },
  marrow: {
    phaseAt: MARROW.phaseAt, phaseFloor: MARROW.phaseFloor, move: "shield",
    damageReduction: MARROW.shieldDamageReduction, bulletClearRadius: MARROW.shieldBulletClearRadius,
    addCount: MARROW.shieldHusks, isBreakable: true,
  },
  // The Choir's split: the boss itself is GONE (untargetable) for the beat, so its
  // reduction never applies — your damage goes into the wisps that end the beat early.
  choir: {
    phaseAt: CHOIR.phaseAt, phaseFloor: CHOIR.phaseFloor, move: "split",
    damageReduction: 1, bulletClearRadius: CHOIR.splitBulletClearRadius,
    addCount: CHOIR.splitWisps, isBreakable: true,
  },
  weaver: {
    phaseAt: WEAVER.phaseAt, phaseFloor: WEAVER.phaseFloor, move: "roar",
    damageReduction: WEAVER.moltDamageReduction, bulletClearRadius: WEAVER.moltBulletClearRadius,
    addCount: WEAVER.moltAdds, isBreakable: false,
  },
  gilded: {
    phaseAt: GILDED.phaseAt, phaseFloor: GILDED.phaseFloor, move: "roar",
    damageReduction: GILDED.sanctifyDamageReduction, bulletClearRadius: GILDED.sanctifyBulletClearRadius,
    addCount: 0, isBreakable: false,
  },
};

function bossBeatOf(e: Enemy): BossBeatDef {
  return BOSS_BEATS[e.kind] ?? BOSS_BEATS.boss!;
}

// EVERY authoritative point of enemy damage funnels through here, so a boss's phase
// thresholds are evaluated after every damage event (spec §5) — bullets, melee, burn ticks,
// arcs, thorns and barrels alike — and its transition beat can reduce/floor/queue uniformly.
// `isOverflow` marks a transition beat's queued damage being released: it already passed
// every reduction when it first landed, so it must not be chipped a second time.
function damageEnemy(w: WorldState, by: PlayerId | null, e: Enemy, dmg: number, ev: SimEvent[], isOverflow = false): void {
  if (!e.boss) {
    // The elite's brace: ≤25% reduction through its 0.9s defensive slide — never immunity.
    if (e.attack.move === "brace" && e.attack.phase === "windup") dmg *= 1 - ELITE_BRACE.damageReduction;
    e.hp -= dmg;
    return;
  }
  const boss = e.boss;
  if (boss.roar) {
    // Transition beat: damage reduction (not immunity) + a hard phase floor. Damage
    // that would cross the floor is QUEUED and applies only after the beat exits.
    const reduced = dmg * (1 - bossBeatOf(e).damageReduction);
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
  // The Gilded Warden's plate: chip damage while closed, full damage through the EXPOSED
  // recover after its commitments — tempo, never immunity (see isGildedExposed).
  if (!isOverflow && e.kind === "gilded" && !isGildedExposed(e)) dmg *= GILDED.armorChip;
  e.hp -= dmg;
  checkBossTransition(w, e, ev);
}

// The Warden's plate hangs open through the long recover after each committed quake or
// sweep — the authored full-damage window the whole fight is paced around.
export function isGildedExposed(e: Enemy): boolean {
  const a = e.attack;
  return a.phase === "recover" && (a.move === "slam" || a.move === "sweep");
}

// Crossing a phase threshold starts the transition beat immediately (mid-attack included):
// the HP floors (overflow queued), nearby bullets clear, and the beat's adds spawn at
// opposite marked edges. The floor is the HARD anti-burst: even an arbitrarily large hit
// lands on the floor and its excess waits out the beat — a boss can never be deleted
// through a threshold. King: 70%/35% → floors 62%/27%, fixed 1.2s roars. MARROW: 65%/30%
// → floors 57%/22%, a shield that holds up to 2.6s but BREAKS EARLY once both husks die.
function checkBossTransition(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss;
  if (!boss || boss.roar) return;
  const def = bossBeatOf(e);
  if (boss.transitionsDone >= def.phaseAt.length) return;
  const threshold = def.phaseAt[boss.transitionsDone] * e.maxHp;
  if (e.hp > threshold) return;
  const floorHp = def.phaseFloor[boss.transitionsDone] * e.maxHp;
  const queued = Math.max(0, floorHp - e.hp);
  if (e.hp < floorHp) e.hp = floorHp;
  boss.transitionsDone++;
  boss.phase = boss.transitionsDone + 1;
  boss.attackCount = 0;
  boss.isNextRadial = true;
  boss.roar = { floorHp, queued, queuedBy: null };
  beginWindup(e, def.move);
  // The beat's shockwave dissipates every projectile near the boss — a readable reset.
  for (const b of w.bullets) {
    if (Math.hypot(b.x - e.x, b.y - e.y) <= def.bulletClearRadius) b.life = 0;
  }
  // The beat's adds at evenly marked edges. Interactive beats (MARROW's husks, the
  // Choir's wisps) remember them: killing every one collapses the beat early.
  boss.beatAddIds.length = 0;
  const edgeAngle = w.rng.next() * Math.PI * 2;
  for (let i = 0; i < def.addCount; i++) {
    const add = spawnBossAdd(w, e, edgeAngle + (i / Math.max(1, def.addCount)) * Math.PI * 2, ev);
    if (add && def.isBreakable) boss.beatAddIds.push(add.id);
  }
  ev.push({ t: "bossPhase", eid: e.id, x: e.x, y: e.y });
  ev.push({ t: "bossTransition", eid: e.id, phase: boss.phase, entering: true, queued: boss.roar.queued, hpFrac: e.hp / e.maxHp });
}

// Beat over (roar elapsed / shield elapsed or broken): apply the queued overflow as a
// fresh damage event (it may immediately trigger the next transition — the double-cross
// case resolves as two full beats) and log the exit so the anti-burst gate stays observable.
function endBossTransition(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss;
  if (!boss || !boss.roar) return;
  const { queued, queuedBy } = boss.roar;
  boss.roar = null;
  ev.push({ t: "bossTransition", eid: e.id, phase: boss.phase, entering: false, queued, hpFrac: e.hp / e.maxHp });
  if (queued > 0) {
    damageEnemy(w, queuedBy, e, queued, ev, true);
    if (e.hp <= 0 && !e.dead) killEnemy(w, ownerOf(w, queuedBy), e, ev);
  }
}

// `p` may be null when the striking actor has left (their projectile outlived them): damage,
// knockback (from the fire-time weapon), and baked-in statuses still land, but nothing is
// credited to any player.
function strikeEnemy(w: WorldState, p: PlayerSim | null, e: Enemy, hit: StrikeInfo, ev: SimEvent[]): void {
  const frozen = isFrozen(e);
  const isBossGrade = isBossKind(e.kind) || e.captainPhase !== undefined;
  let dmg: number;
  if (isBossGrade) {
    // The boss vulnerability CHANNEL (balancer remediation): statuses keep their utility
    // (arc, slow, DoT) but amplify NOTHING here, and the crit multiplier counts at most
    // BOSS_VULN_CAP — combined vulnerability ≤1.35, non-multiplicative by construction.
    // hit.damage carries the crit multiplier baked in, so it is divided back out before
    // the capped channel applies. The fire-time pellet/weapon coefficient rides on top.
    dmg = (hit.damage / hit.critX) * Math.min(BOSS_VULN_CAP, hit.critX) * hit.bossCoef;
  } else {
    dmg = hit.damage * (e.shock > 0 ? C.SHOCK_DMG_MULT : 1) * (frozen ? C.FROZEN_DMG_MULT : 1);
  }
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
  // Decoys are noise, not kills: no credit, no combo fuel — popping the echojack's echo
  // (or silencing a knell) is a play, never an economy.
  const isDecoy = e.kind === "echo" || e.kind === "knell";
  if (p && !isDecoy) {
    p.kills++;
    p.combo++;
    p.comboTimer = C.COMBO_WINDOW;
  }
  const big = isBossKind(e.kind);
  ev.push({ t: "enemyKill", eid: e.id, kind: e.kind, tier: e.tier, x: e.x, y: e.y, combo: p ? p.combo : 0 });
  if (big) endBossDanger(w, e, ev);
  // An ARMED sinderling dies loudly: an immediate shared-risk burst — players take 1,
  // enemies take more (the fire is nobody's friend), cover splinters. Enemy kills inside
  // the burst credit the sinderling's killer (their shot lit the fuse).
  if (e.kind === "sinderling" && e.aux === 1) sinderlingBurst(w, p, e, ev);
  // Volatile elite: the delayed shared burst — death plants a visible fused charge that
  // detonates on expiry (see updateHazards). The kill itself is always safe.
  if (e.tier === "elite" && e.captainPhase === undefined && eliteAffixOf(e.kind) === "volatile") {
    w.hazards.push({
      id: w.nextHazardId++, kind: "charge", x: e.x, y: e.y,
      radius: ELITE_VOLATILE.radius, life: ELITE_VOLATILE.fuseSeconds, maxLife: ELITE_VOLATILE.fuseSeconds,
    });
    ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 1.6, gain: 0.5, trauma: 0 });
  }
  // Commander elite: the pack PANICS leaderless — nearby allies scatter and start
  // nothing from idle for the panic window.
  if (e.tier === "elite" && e.captainPhase === undefined && eliteAffixOf(e.kind) === "commander") {
    for (const ally of w.enemies) {
      if (ally === e || ally.dead || isBossKind(ally.kind) || ally.touchDamage <= 0) continue;
      if (Math.hypot(ally.x - e.x, ally.y - e.y) > ELITE_COMMANDER.panicRadius) continue;
      ally.panicTime = ELITE_COMMANDER.panicDuration;
      ally.surgeDelay = 0;
      ally.surgeTime = 0;
    }
    ev.push({ t: "cue", name: "elite.panic", x: e.x, y: e.y, rate: 1, gain: 0.7, trauma: 0.05 });
  }
  // Vampire Fang: one heart per proc, on a shared 1.25s cooldown, never off summoned adds —
  // sustain comes from scarcity decisions, not add-farming.
  if (p && !e.isSummoned && p.mods.lifestealChance > 0 && p.fangCd === 0
    && p.hp < p.maxHp && w.rng.next() < p.mods.lifestealChance) {
    p.hp++;
    p.fangCd = FANG_PROC_COOLDOWN;
    ev.push({ t: "heal", pid: p.id, x: e.x, y: e.y });
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

// Each boss's authored chest weapon: its fight's answer, handed to you for the road.
// The King's zoning begets the Thumper; blind MARROW yields the Longshot (its own line,
// straightened into a slug); the Choir leaves a lance of light; the Weaver leaves the
// Tesla — its web of threads recast as chained arcs between bodies; the Warden gives up
// the heavy Thunderbolt its plate shrugged off.
const BOSS_SIGNATURE_WEAPON: Readonly<Partial<Record<Enemy["kind"], WeaponId>>> = {
  boss: "mortar", marrow: "railgun", choir: "beam", weaver: "tesla", gilded: "cannon",
};

function dropLoot(w: WorldState, p: PlayerSim | null, e: Enemy, ev: SimEvent[]): void {
  if (isBossKind(e.kind)) {
    w.chests.push({
      id: w.nextChestId++, kind: "boss", x: e.x, y: e.y, radius: 18, opened: false,
      weapon: BOSS_SIGNATURE_WEAPON[e.kind],
    });
    return;
  }
  // Decoys (the echojack's echo, The Toll's knell) are noise, not bodies: no loot, ever.
  if (e.kind === "echo" || e.kind === "knell") return;
  // A mid-band miniboss pays an authored purse (a heart + a coin handful) instead of the
  // ambient roll — the floor's beat has a guaranteed reward without a whole boss chest.
  if (isMinibossKind(e.kind)) {
    w.pickups.push(makePickup(w, "heart", e.x, e.y, ev));
    for (let i = 0; i < 3; i++) {
      w.pickups.push(makePickup(w, "coin", e.x + (i - 1) * 18, e.y + 16, ev, p ? comboCoinValue(p) : 1));
    }
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

  // Webs slow the WALK only — the dash (below) rips through at full speed, so a snared
  // player always has an out; it just costs the dash.
  const speed = PLAYER.moveSpeed * p.mods.moveSpeedMult * webSlowMult(w, p.x, p.y);
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
    cancelReviveChannelBy(w, p.id); // gate §6: the reviver's dash cancels their channel
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
    cancelReviveChannelBy(w, p.id); // gate §6: the reviver's attack cancels their channel
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
    bossCoef: WEAPON_BOSS_COEF[wep.id] ?? 1,
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
    // Anchor this tick's swept-collision segment BEFORE any steering/move. A wall bounce
    // resets the bullet to exactly this point, leaving that tick's segment degenerate —
    // a reflected round never sweeps backward through the wall it hit.
    b.prevX = b.x;
    b.prevY = b.y;
    if (b.homing !== undefined) {
      if (b.friendly) steerHoming(w, b, dt);
      else steerEnemyHoming(w, b, dt); // the Choir's wails seek the nearest standing player
    }
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    // A mortar shell that reaches the end of its arc airbursts instead of vanishing.
    if (b.life <= 0 && b.friendly && b.blast !== undefined) { detonateBullet(w, b, b.x, b.y, ev); continue; }
    if (isWall(w, b.x, b.y)) {
      if (b.friendly && b.blast !== undefined) {
        // Shells burst ON the wall face (the last in-bounds point), not inside it.
        detonateBullet(w, b, b.prevX ?? b.x, b.prevY ?? b.y, ev);
        continue;
      }
      if (b.bounce !== undefined && b.bounce > 0) { bounceOffWall(w, b, dt, ev); continue; }
      b.life = 0; ev.push({ t: "bulletWall", x: b.x, y: b.y, aim: Math.atan2(-b.vy, -b.vx) }); continue;
    }
    if (!b.friendly) {
      for (const p of w.players.values()) {
        if (!isProtected(p) && !p.isDown && !p.isAbsent && p.hp > 0 && Math.hypot(p.x - b.x, p.y - b.y) < p.pr + b.radius) {
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

// Mortar detonation: the shell's ONE payload, applied as an ordinary strike (attribution,
// crits, elemental blessings, knockback radially out of the blast) to every targetable
// enemy in the radius, plus prop destruction — explosive barrels chain, exactly like §prop
// explosions. The bullet collapses onto the blast point so its spent segment can never
// also plain-hit something later this tick.
function detonateBullet(w: WorldState, b: Bullet, x: number, y: number, ev: SimEvent[]): void {
  const r = b.blast;
  if (r === undefined) return;
  b.blast = undefined;
  b.life = 0;
  b.x = x; b.y = y; b.prevX = x; b.prevY = y;
  ev.push({ t: "explosion", x, y, r });
  const shooter = ownerOf(w, b.owner);
  for (const e of w.enemies) {
    if (e.dead || isUntargetable(e)) continue;
    if (Math.hypot(e.x - x, e.y - y) > r + e.radius) continue;
    const kbX = e.x - x, kbY = e.y - y;
    strikeEnemy(w, shooter, e, {
      damage: b.damage, isCrit: b.isCrit, critX: b.critX ?? 1, bossCoef: b.bossCoef ?? 1, puffX: e.x, puffY: e.y,
      kbDirX: kbX === 0 && kbY === 0 ? 1 : kbX, kbDirY: kbY,
      burn: b.burn, chill: b.chill, shock: b.shock, isMelee: false,
      ownerId: b.owner, fxWeapon: b.fx ?? null,
    }, ev);
    (b.hitList ??= []).push(e);
  }
  for (const prop of w.props) {
    if (prop.breakT !== undefined || prop.kind === "brazier") continue;
    if (Math.hypot(prop.x - x, prop.y - y) <= r + prop.radius) destroyProp(w, prop, ev, shooter ?? undefined);
  }
}

function steerHoming(w: WorldState, b: Bullet, dt: number): void {
  const rate = b.homing;
  if (rate === undefined || rate <= 0) return;
  const RANGE = 260;
  let best: Enemy | null = null;
  let bestD = RANGE * RANGE;
  for (const e of w.enemies) {
    if (e.dead || isUntargetable(e)) continue;
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

// Enemy seekers (the Choir's wails): a capped turn toward the nearest standing player.
// The cap is the counterplay — hold a curve and the wail overshoots.
function steerEnemyHoming(w: WorldState, b: Bullet, dt: number): void {
  const rate = b.homing;
  if (rate === undefined || rate <= 0) return;
  let best: PlayerSim | null = null;
  let bestD = Infinity;
  for (const p of w.players.values()) {
    if (p.isDown || p.hp <= 0) continue;
    const dx = p.x - b.x, dy = p.y - b.y, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = p; }
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
  b.vx = Math.cos(a) * speed;
  b.vy = Math.sin(a) * speed;
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

// Swept (continuous) bullet collision. Fast rounds cover many body-widths per fixed tick —
// the Longshot's 1400px/s slug crosses ~70px per 20Hz step against swarm bodies barely 10px
// wide — so testing only the endpoint tunnels straight through small targets. The whole
// travel segment [prev -> current] is tested against the target circle; the closest point
// comes back in `sweptHit` (per-query scratch, like w.targetX/targetY) so impact FX land ON
// the target instead of wherever the bullet ended up.
const sweptHit = { x: 0, y: 0 };
function sweptBulletHit(b: Bullet, cx: number, cy: number, r: number): boolean {
  const x1 = b.x, y1 = b.y;
  const x0 = b.prevX ?? x1, y0 = b.prevY ?? y1;
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((cx - x0) * dx + (cy - y0) * dy) / len2)) : 0;
  const px = x0 + dx * t, py = y0 + dy * t;
  const ddx = cx - px, ddy = cy - py;
  if (ddx * ddx + ddy * ddy >= r * r) return false;
  sweptHit.x = px;
  sweptHit.y = py;
  return true;
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
  let livingBodies = 0;
  let livingMovers = 0;
  let livingBrutes = 0;
  let livingElites = 0;
  let livingControllers = 0;
  for (const e of w.enemies) {
    if (e.dead || isBossKind(e.kind)) continue;
    // Summons count too (envelope: summons cost threat) — a decoy or a ward holds real
    // live budget until it resolves.
    living += threatCostOf(e.kind, e.tier);
    livingBodies++;
    if (isComplexMover(e.kind)) livingMovers++;
    if (e.tier === "brute") livingBrutes++;
    if (e.tier === "elite") livingElites++;
    if (isControllerKind(e.kind)) livingControllers++;
  }
  const cap = activeThreatCap(w.floor) * coopThreatMult(w.encounterPlayers);
  const moverCap = activeMoverCapFor(w.encounterPlayers);
  // The head of the queue releases when it fits EVERY live budget (threat cap, body
  // cap, and the envelope's per-class simultaneity caps). A blocked unit never
  // head-blocks the queue: the first releasable unit behind it goes instead,
  // preserving order otherwise.
  let idx = -1;
  for (let i = 0; i < w.pendingSpawns.length; i++) {
    const cand = w.pendingSpawns[i];
    if (living + threatCostOf(cand.kind, cand.tier) > cap) continue;
    if (livingBodies >= LIVE_CAPS.bodies) continue;
    if (isComplexMover(cand.kind) && livingMovers >= moverCap) continue;
    if (cand.tier === "brute" && livingBrutes >= LIVE_CAPS.brutes) continue;
    if (cand.tier === "elite" && livingElites >= LIVE_CAPS.elites) continue;
    if (isControllerKind(cand.kind) && livingControllers >= LIVE_CAPS.controllers) continue;
    idx = i;
    break;
  }
  if (idx === -1) return;
  // Its spawn grace never ticked while pending, so it activates with the full grace window.
  const next = w.pendingSpawns.splice(idx, 1)[0];
  w.enemies.push(next);
  w.spawnReleaseCd = REINFORCE_STAGGER / BIOME_PRESSURE[biomeIndexForFloor(w.floor)].reinforceRate;
  ev.push({ t: "enemySpawn", eid: next.id, kind: next.kind, tier: next.tier, x: next.x, y: next.y });
}

function updateEnemies(w: WorldState, dt: number, ev: SimEvent[]): void {
  // Stage C: every strike is attributed to the player who caused it (bullet.owner / swing owner
  // / burn igniter), NOT a single "primary player". Kills/coins/combo/lifesteal go to the right
  // authoritative player. Solo resolves to the one player, so behavior is unchanged.
  tickReleaseArbiter(w, dt);
  releaseReinforcements(w, dt, ev);
  refreshNav(w, dt);
  for (const e of w.enemies) {
    tickStatuses(w, e, dt, ev);
    if (e.dead) continue;
    if (e.captainPhase !== undefined) tickCaptainPhase(w, e, ev);
    if (e.spawnTimer > 0) e.spawnTimer = e.spawnTimer > dt ? e.spawnTimer - dt : 0;
    if (e.attack.cooldown > 0) e.attack.cooldown = e.attack.cooldown > dt ? e.attack.cooldown - dt : 0;
    if (e.braceCd !== undefined && e.braceCd > 0) e.braceCd = e.braceCd > dt ? e.braceCd - dt : 0;
    if (e.panicTime > 0) e.panicTime = e.panicTime > dt ? e.panicTime - dt : 0;
    // The echoed elite's scheduled repeat: the last ranged release refires once, along
    // the same locked bearing, from wherever the body now stands.
    if (e.echoTime > 0) {
      e.echoTime = e.echoTime > dt ? e.echoTime - dt : 0;
      if (e.echoTime === 0) refireEcho(w, e, ev);
    }
    // Boss pack-surge order: the delay elapses, then a short burst of chase speed.
    if (e.surgeDelay > 0) {
      e.surgeDelay -= dt;
      if (e.surgeDelay <= 0) {
        e.surgeDelay = 0;
        e.surgeTime = BOSS.packSurgeDuration;
        // The commander's ordered surge lands: ONE aggregate cue off the leader (the
        // flock's lock beat), never a voice per surged body.
        if (e.tier === "elite" && eliteAffixOf(e.kind) === "commander") {
          ev.push({ t: "cue", name: "flock.surge", x: e.x, y: e.y, rate: 1, gain: 0.65, trauma: 0 });
        }
      }
    } else if (e.surgeTime > 0) {
      e.surgeTime = e.surgeTime > dt ? e.surgeTime - dt : 0;
    }

    updateEnemyAI(w, e, dt, ev);
    applyKnockbackDecay(w, e, dt);

    const isMoving = e.attack.phase === "none" || (e.attack.phase === "active" && isRushMove(e.attack.move));
    e.hopMove += ((isMoving ? 1 : 0) - e.hopMove) * Math.min(1, dt * 9);
    e.hopClock += dt * (1 + e.hopMove * 1.5);

    for (const victim of w.players.values()) {
      if (!isProtected(victim) && !victim.isDown && !victim.isAbsent && victim.hp > 0
        && Math.hypot(victim.x - e.x, victim.y - e.y) < victim.pr + e.radius && canTouchDamage(e)) {
        damagePlayer(w, victim, contactDamageOf(e), ev);
        // A connecting line commitment (skeleton lunge, charger/MARROW rush) shoves the
        // victim along the committed angle — the hit reads as impact, not overlap.
        if (isRushMove(e.attack.move) && e.attack.phase === "active") lungeImpact(w, victim, e, ev);
        applyThorns(w, victim, victim, e, ev);
        // Solo aborts the enemy loop on death (game over). Co-op and the authoritative shared
        // world keep processing — a downed player doesn't stop the world.
        if (victim.hp <= 0 && !w.isCoop && !w.isShared) return;
      }
    }

    // Underground: every round and swing passes over it (see isUntargetable).
    const isBelowGround = isUntargetable(e);

    for (const b of w.bullets) {
      if (isBelowGround || !b.friendly) continue;
      // A SPENT round stops mattering the instant it lands. Bullets are only culled at the
      // next updateBullets pass, so without this guard a pierce-0 round that just died on
      // one body could strike every other body overlapping its final segment in the same
      // tick — phantom pierce that quietly inflated pack damage (~50% on tight clumps)
      // past everything the balance tables authorize. Piercing rounds keep life > 0
      // by design, so legitimate multi-hits are untouched (chests already apply this
      // same spent-round rule).
      if (b.life <= 0) continue;
      if (b.hitList && b.hitList.indexOf(e) !== -1) continue;
      // Immutable attribution: the bullet keeps flying and dealing damage after its owner leaves
      // (shooter null) — it just credits no one. Never re-attributed to another live player.
      const shooter = ownerOf(w, b.owner);
      // Lag comp anchored at FIRE time (decays as the bullet travels): a hitscan-fast shot tests
      // the shooter's fire-time view; a slow projectile tests present positions. 0 in solo.
      const [btx, bty] = rewoundEnemyPos(w, e, fireTimeRewind(w, b.bornTick, b.lagRewind));
      // Formation guards (rootward / P1 marshal) reach a little PAST the body: allies
      // trailing the guard's shadow get real cover. The pad only matters to the guard —
      // a graze through it that the arc does not cover passes clean.
      const guardPad = guardPadOf(e);
      const isBodyHit = sweptBulletHit(b, btx, bty, b.radius + e.radius);
      const isGuardHit = !isBodyHit && guardPad > 0 && sweptBulletHit(b, btx, bty, b.radius + e.radius + guardPad);
      if (isBodyHit || isGuardHit) {
        // Mortar shells never strike directly — the blast IS the payload (the direct
        // target is inside the radius and takes exactly one blast hit; explosions are
        // the one ranged answer a guard cannot eat).
        if (b.blast !== undefined) {
          detonateBullet(w, b, sweptHit.x, sweptHit.y, ev);
          continue;
        }
        // A formation guard swallows a non-piercing shot arriving inside its slow arc.
        if (isGuardBlocked(e, b)) {
          b.life = 0;
          ev.push({ t: "bulletBlocked", kind: e.kind, x: sweptHit.x, y: sweptHit.y, aim: Math.atan2(-b.vy, -b.vx) });
          continue;
        }
        if (!isBodyHit) continue; // pad graze the guard did not cover: flies on
        // The shielder's front arc swallows the shot: no damage, the round is spent.
        if (isShieldBlocked(e, b.vx, b.vy)) {
          b.life = 0;
          ev.push({ t: "bulletBlocked", kind: e.kind, x: sweptHit.x, y: sweptHit.y, aim: Math.atan2(-b.vy, -b.vx) });
          continue;
        }
        // A bulwark elite's directional plate absorbs the round instead (until it breaks).
        if (absorbOnBulwark(e, b, ev)) continue;
        strikeEnemy(w, shooter, e, {
          damage: b.damage, isCrit: b.isCrit, critX: b.critX ?? 1, bossCoef: b.bossCoef ?? 1, puffX: sweptHit.x, puffY: sweptHit.y, kbDirX: b.vx, kbDirY: b.vy,
          burn: b.burn, chill: b.chill, shock: b.shock, isMelee: false,
          ownerId: b.owner, fxWeapon: b.fx ?? null,
        }, ev);
        // The caskbellows' rear crank: a hit on its back mid-commitment staggers it.
        if (!e.dead) maybeCrankStagger(e, b, ev);
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
      if (isBelowGround) break;
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
          critX: swing.isCrit ? player.mods.critMult : 1, bossCoef: swing.bossCoef,
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
  if (e.touchDamage <= 0) return false; // decoys (echo/knell) are fake bodies, not threats
  if (isUntargetable(e)) return false; // an underground burrower neither deals nor takes touch
  if (e.kind === "ghost") return e.attack.windup >= C.GHOST_SOLID_AT;
  if (e.kind === "boss" && e.attack.move === "hopslam" && e.attack.phase === "active") return false;
  return true;
}

// A body that is temporarily OUT OF PLAY: bullets, swings, arcs, blasts and barrel
// explosions all pass over it, and it neither deals nor takes touch. Every window is
// bounded by construction (hard caps on travel/fade/air-time/beat duration):
//  - burrower: underground (tunneling, or armed under its eruption marker);
//  - Hollow Choir: mid-fade drift, or scattered into wisps for its split beat;
//  - Weaver: airborne during the pounce.
function isUntargetable(e: Enemy): boolean {
  const a = e.attack;
  switch (e.kind) {
    case "burrower":
      return (a.move === "dive" && a.phase === "active") || (a.move === "erupt" && a.phase === "windup");
    case "choir":
      return (a.move === "fade" && a.phase === "active") || a.move === "split";
    case "weaver":
      return a.move === "pounce" && a.phase === "active";
    default:
      return false;
  }
}

// The straight-line commitments that shove on impact (skeleton lunge, charger/MARROW
// rush, the sinderling's flame jet).
function isRushMove(move: AttackMove): boolean {
  return move === "lunge" || move === "rush";
}

// Whether a rusher is overlapping any standing player (the connect test that ends a rush).
function isTouchingAnyPlayer(w: WorldState, e: Enemy): boolean {
  for (const p of w.players.values()) {
    if (p.isDown || p.hp <= 0) continue;
    if (Math.hypot(p.x - e.x, p.y - e.y) < p.pr + e.radius) return true;
  }
  return false;
}

// Damage tiers (§3): light/contact stays 1 at every floor; only a brute's authored,
// clearly telegraphed commitment (the skeleton's lunge or the charger's rush, mid-active)
// deals the heavy 2.
function contactDamageOf(e: Enemy): number {
  if (e.tier === "brute" && (e.kind === "skeleton" || e.kind === "charger") && e.attack.phase === "active") return BRUTE_HEAVY_DAMAGE;
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

// The elite's one visible affix COMMITMENT (balancer final): the first time it is
// bloodied (≤70% HP) — and again off a cooldown that keeps the duty cycle ≤35% — it
// BRACES: a 0.9s defensive slide away from its target at ≤25% damage reduction (never
// immunity), then a ≥0.5s recover. Gauntlet captains run their own two-phase contract
// and never brace.
function updateEliteBrace(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): boolean {
  const a = e.attack;
  if (a.move === "brace") {
    a.time += dt;
    if (a.phase === "windup") {
      a.windup = Math.min(1, a.time / ELITE_BRACE.duration);
      // The reposition: strafe PERPENDICULAR to the fire line (deterministic side by id
      // parity) — in-flight bullets aimed at the old position miss, which is the visible
      // payoff of the commitment.
      if (findTarget(w, e.x, e.y)) {
        const toward = Math.atan2(w.targetY - e.y, w.targetX - e.x);
        const strafe = toward + (e.id % 2 === 0 ? Math.PI / 2 : -Math.PI / 2);
        moveEnemyBy(w, e, Math.cos(strafe) * ELITE_BRACE.slideSpeed * dt, Math.sin(strafe) * ELITE_BRACE.slideSpeed * dt);
      }
      if (a.time >= ELITE_BRACE.duration) enterRecover(e);
      return true;
    }
    if (a.phase === "recover") {
      if (a.time >= ELITE_BRACE.recover) {
        enterIdle(e);
        e.braceCd = ELITE_BRACE.cooldown;
      }
      return true;
    }
  }
  // Trigger only from idle (a brace never cancels a committed telegraph).
  if (a.phase === "none" && (e.braceCd ?? 0) <= 0 && e.hp <= e.maxHp * ELITE_BRACE.triggerHpFrac) {
    beginWindup(e, "brace");
    ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 1.3, gain: 0.45, trauma: 0 });
    return true;
  }
  return false;
}

function updateEnemyAI(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  // Commander-panic: a leaderless body SCATTERS — flees the nearest player and starts
  // nothing from idle. A committed telegraph still finishes (a panic never deletes an
  // already-visible attack), so the read stays honest.
  if (e.panicTime > 0 && e.attack.phase === "none") {
    if (findTarget(w, e.x, e.y)) {
      const away = Math.atan2(e.y - w.targetY, e.x - w.targetX);
      applyChaseStep(w, e, dt, away, e.speed * ELITE_COMMANDER.panicSpeedMult * dt);
    }
    return;
  }
  if (e.tier === "elite" && e.captainPhase === undefined && updateEliteAffix(w, e, dt, ev)) return;
  switch (e.kind) {
    case "spitter": updateSpitter(w, e, dt, ev); return;
    case "bat": updateFlocker(w, e, dt); return;
    case "skeleton": updateSkeleton(w, e, dt, ev); return;
    case "ghost": updateGhost(w, e, dt, ev); return;
    case "charger": updateCharger(w, e, dt, ev); return;
    case "burrower": updateBurrower(w, e, dt, ev); return;
    case "orbiter": updateOrbiter(w, e, dt, ev); return;
    case "shielder": updateShielder(w, e, dt, ev); return;
    case "rootward": updateRootward(w, e, dt); return;
    case "echojack": updateEchojack(w, e, dt, ev); return;
    case "seamcutter": updateSeamcutter(w, e, dt, ev); return;
    case "caskbellows": updateCaskbellows(w, e, dt, ev); return;
    case "sinderling": updateSinderling(w, e, dt, ev); return;
    case "fragment": updateFragment(w, e, dt, ev); return;
    case "echo": updateEcho(e, dt, ev); return;
    case "knell": updateKnell(w, e, dt, ev); return;
    case "marshal": updateMarshal(w, e, dt, ev); return;
    case "toll": updateToll(w, e, dt, ev); return;
    case "boss": updateBoss(w, e, dt, ev); return;
    case "marrow": updateMarrow(w, e, dt, ev); return;
    case "choir": updateChoir(w, e, dt, ev); return;
    case "weaver": updateWeaver(w, e, dt, ev); return;
    case "gilded": updateGilded(w, e, dt, ev); return;
    default: updateChaser(w, e, dt); return;
  }
}

// One affix per elite, deterministic by kind (ELITE_AFFIXES). Returns true when the
// affix consumed this tick's AI (a live brace slide, a rally beat); passive affixes
// (bulwark's plate upkeep, volatile/echoed which act on death/after fire) return false
// so the chassis behavior runs unchanged.
function updateEliteAffix(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): boolean {
  switch (eliteAffixOf(e.kind)) {
    case "commander": return updateEliteCommander(w, e, dt, ev);
    case "bulwark":
      // The plate tracks its target SLOWLY while the body is idle (committed attacks own
      // lockedAngle themselves, and the plate rides along — an attacking bulwark faces
      // its attack). Slower than a strafing player: footwork beats it even solo.
      if (e.aux > 0 && e.attack.phase === "none" && findTarget(w, e.x, e.y)) {
        const want = Math.atan2(w.targetY - e.y, w.targetX - e.x);
        const d = angleDiff(want, e.attack.lockedAngle);
        const maxTurn = ELITE_BULWARK.turnRate * dt;
        e.attack.lockedAngle += d > maxTurn ? maxTurn : d < -maxTurn ? -maxTurn : d;
      }
      return false;
    case "volatile":
    case "echoed":
      return false;
    default:
      return updateEliteBrace(w, e, dt, ev);
  }
}

// The commander's synchronized ONE commit: a fixed rally beat (roar grammar — a
// stationary horn) that orders every nearby ally into the existing pack surge. Speed,
// never damage: the gate's release arbiter is untouched, and the surge lands a readable
// beat later. The cooldown rides the shared elite-affix timer (braceCd).
function updateEliteCommander(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): boolean {
  const a = e.attack;
  if (a.move === "roar") {
    if (a.phase === "windup") {
      a.time += dt;
      a.windup = Math.min(1, a.time / ELITE_COMMANDER.rallyWindup);
      if (a.time >= ELITE_COMMANDER.rallyWindup) {
        commanderRally(w, e, ev);
        enterRecover(e);
      }
      return true;
    }
    if (a.phase === "recover") {
      a.time += dt;
      if (a.time >= ELITE_COMMANDER.rallyRecover) {
        enterIdle(e);
        e.braceCd = ELITE_COMMANDER.rallyCooldown;
      }
      return true;
    }
  }
  if (a.phase === "none" && (e.braceCd ?? 0) <= 0 && e.spawnTimer === 0 && findTarget(w, e.x, e.y)
    && Math.hypot(w.targetX - e.x, w.targetY - e.y) <= ELITE_COMMANDER.rallyTrigger) {
    beginWindup(e, "roar");
    ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 0.6, gain: 0.7, trauma: 0 });
    return true;
  }
  return false;
}

function commanderRally(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  e.surgeDelay = ELITE_COMMANDER.surgeDelay;
  for (const ally of w.enemies) {
    if (ally === e || ally.dead || isBossKind(ally.kind) || ally.touchDamage <= 0) continue;
    if (Math.hypot(ally.x - e.x, ally.y - e.y) > ELITE_COMMANDER.rallyRadius) continue;
    ally.surgeDelay = ELITE_COMMANDER.surgeDelay;
  }
  ev.push({ t: "cue", name: "elite.rally", x: e.x, y: e.y, rate: 1, gain: 0.75, trauma: 0.04 });
}

// The echoed elite's repeat: refire the last ranged release along its stored bearing
// from the CURRENT position. The refire never re-arms itself, so one shot echoes once.
function refireEcho(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  if (e.dead) return;
  switch (e.kind) {
    case "spitter": spitterVolley(w, e, e.echoAngle, ev); return;
    case "orbiter": orbiterBolt(w, e, e.echoAngle, ev); return;
    default: return;
  }
}

function updateSkeleton(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    if (stepWindupTimer(w, e, dt, C.SKELETON_WINDUP, C.SKELETON_LOCK, false)
      && tryReleaseLane(w, e, a.lockedAngle, C.SKELETON_LUNGE_SPEED * C.SKELETON_LUNGE_DUR)) {
      a.phase = "active"; a.time = 0; a.windup = 0; a.cooldown = C.SKELETON_CD * attackCdMultOf(e);
      ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 1, gain: 0.85, trauma: 0.12 });
    }
    return;
  }
  if (a.phase === "active") {
    a.time += dt;
    const step = C.SKELETON_LUNGE_SPEED * dt;
    moveEnemyBy(w, e, Math.cos(a.lockedAngle) * step, Math.sin(a.lockedAngle) * step);
    // A committed charge is a physical object: crates and barrels in its path shatter.
    // Cover absorbs the telegraphed hit — and is spent doing it.
    enemySmashEnvironment(w, e.x, e.y, e.radius + 4, ev);
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
  applyChaseStep(w, e, dt, chase, e.speed * surgeMult(e) * dt);
}

function updateChaser(w: WorldState, e: Enemy, dt: number): void {
  if (!findTarget(w, e.x, e.y)) return;
  const angle = chaseAngle(w, e);
  let step = e.speed * dt;
  if (e.kind === "slime") step *= slimeHopPulse(e);
  step *= surgeMult(e);
  applyChaseStep(w, e, dt, angle, step);
}

// The pack-surge speed factor (the boss's P2 order AND the commander elite's rally):
// consumed by every ordinary ground walk, never by committed attack movement.
function surgeMult(e: Enemy): number {
  return e.surgeTime > 0 ? BOSS.packSurgeSpeedMult : 1;
}

// Deterministic boids for the bat family. Each bat carries a persistent heading in its
// `zig` scratch (seeded at spawn, so a fresh flock fans out reproducibly) and blends four
// steering pulls into it under a capped turn rate:
//   separation (strong, inside FLOCK_SEP_RADIUS)  — never stack;
//   alignment + cohesion (with capped, deterministic array-order neighbors) — move as ONE
//   wheeling body;
//   target attraction (the flow-field chase bearing) — the flock still hunts.
// Pure state math, no RNG, bounded O(n·FLOCK_MAX_NEIGHBORS): replay-identical every run.
function updateFlocker(w: WorldState, e: Enemy, dt: number): void {
  const hasTarget = findTarget(w, e.x, e.y);
  let sepX = 0, sepY = 0;
  let aliX = 0, aliY = 0;
  let cohX = 0, cohY = 0;
  let social = 0;
  let closest = Infinity;
  // One pass over the enemy list (the same per-enemy scan shape every AI routine here
  // uses). The SOCIAL terms (alignment/cohesion) cap at FLOCK_MAX_NEIGHBORS in
  // deterministic array order; SEPARATION must instead see every body inside its small
  // radius — a capped-by-array-order pick can starve exactly the stacked pair it exists
  // to split (two late-array bats never scanning each other).
  for (const other of w.enemies) {
    if (other === e || other.dead || other.kind !== e.kind) continue;
    const dx = other.x - e.x, dy = other.y - e.y;
    const d = Math.hypot(dx, dy);
    if (d >= C.FLOCK_RADIUS) continue;
    if (d < closest) closest = d;
    if (d < C.FLOCK_SEP_RADIUS) {
      // A fully co-located pair has no separation axis — break the tie along each bat's
      // own id-derived bearing (golden-angle spread: stable, deterministic, never shared),
      // so an exactly-stacked pair can never become a fixed point.
      if (d < 1) {
        const tie = e.id * 2.399963;
        sepX -= Math.cos(tie);
        sepY -= Math.sin(tie);
      } else {
        const push = (C.FLOCK_SEP_RADIUS - d) / C.FLOCK_SEP_RADIUS;
        sepX -= (dx / d) * push;
        sepY -= (dy / d) * push;
      }
    }
    if (social < C.FLOCK_MAX_NEIGHBORS) {
      social++;
      aliX += Math.cos(other.zig);
      aliY += Math.sin(other.zig);
      cohX += dx;
      cohY += dy;
    }
  }
  let desX = sepX * C.FLOCK_SEP_WEIGHT;
  let desY = sepY * C.FLOCK_SEP_WEIGHT;
  // Priority arbitration: inside the hard core, separation is the ONLY voice. The shared
  // target pull focuses converging bats onto one point like rays — without this override
  // it laterally re-compresses any pair it likes back into a stack.
  const isCrowded = closest < C.FLOCK_HARD_CORE;
  if (!isCrowded && social > 0) {
    const aliLen = Math.hypot(aliX, aliY) || 1;
    desX += (aliX / aliLen) * C.FLOCK_ALIGN_WEIGHT;
    desY += (aliY / aliLen) * C.FLOCK_ALIGN_WEIGHT;
    const cohLen = Math.hypot(cohX, cohY) || 1;
    desX += (cohX / cohLen) * C.FLOCK_COHESION_WEIGHT;
    desY += (cohY / cohLen) * C.FLOCK_COHESION_WEIGHT;
  }
  if (!isCrowded && hasTarget) {
    const hunt = chaseAngle(w, e);
    desX += Math.cos(hunt) * C.FLOCK_TARGET_WEIGHT;
    desY += Math.sin(hunt) * C.FLOCK_TARGET_WEIGHT;
  }
  // No pulls at all (lone bat, no target): glide on the current heading at full speed.
  let brake = 1;
  if (desX !== 0 || desY !== 0) {
    let delta = Math.atan2(desY, desX) - e.zig;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const maxTurn = C.FLOCK_TURN_RATE * dt;
    e.zig += delta > maxTurn ? maxTurn : delta < -maxTurn ? -maxTurn : delta;
    // Variable airspeed: a bat whose desired pull opposes its heading BRAKES (a trailing
    // bat glued to a leader's tail can fall back and slide out) — turning alone can never
    // unstack a pair flying the same axis at the same speed.
    brake = C.FLOCK_MIN_SPEED + (1 - C.FLOCK_MIN_SPEED) * Math.max(0, Math.cos(delta));
  }
  const step = e.speed * brake * dt * surgeMult(e);
  applyChaseStep(w, e, dt, e.zig, step);
}

// The charger: a slow stalker whose whole threat is one long, telegraphed straight rush.
// The lane is authored to be SIDESTEPPED (backpedaling loses — it outruns you on a line),
// and a wall crash swaps the move to "crash": a long self-stun, the authored punish window.
function updateCharger(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    if (stepWindupTimer(w, e, dt, C.CHARGER_WINDUP, C.CHARGER_LOCK, false)
      && tryReleaseLane(w, e, a.lockedAngle, C.CHARGER_RUSH_SPEED * C.CHARGER_RUSH_DUR)) {
      a.phase = "active"; a.time = 0; a.windup = 0; a.cooldown = C.CHARGER_CD * attackCdMultOf(e);
      ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 0.8, gain: 0.85, trauma: 0.08 });
    }
    return;
  }
  if (a.phase === "active") {
    a.time += dt;
    // A connect ends the rush BEFORE the next step (hit-and-stop, never a drag): the
    // contact pass already landed the damage + shove on the tick the bodies met.
    if (isTouchingAnyPlayer(w, e)) { enterRecover(e); return; }
    const step = C.CHARGER_RUSH_SPEED * dt;
    const x0 = e.x, y0 = e.y;
    rushSmashEnvironment(w, e, ev); // the lane splinters FIRST — furniture never wedges a rush
    moveEnemyBy(w, e, Math.cos(a.lockedAngle) * step, Math.sin(a.lockedAngle) * step);
    ev.push({ t: "lungeTrail", x: e.x, y: e.y });
    // Wall crash: barely progressing at full commitment = it hit something solid.
    // (chill scales the intended step too, so a slowed rush is not a false crash.)
    const moved = Math.hypot(e.x - x0, e.y - y0);
    if (moved < step * chillMoveScale(e) * 0.5) {
      a.move = "crash";
      enterRecover(e);
      ev.push({ t: "chargeCrash", x: e.x, y: e.y });
      return;
    }
    if (a.time >= C.CHARGER_RUSH_DUR) enterRecover(e);
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= (a.move === "crash" ? C.CHARGER_CRASH_STUN : C.CHARGER_RECOVER)) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const dist = Math.hypot(w.targetX - e.x, w.targetY - e.y) || 1;
  if (dist <= C.CHARGER_TRIGGER && a.cooldown === 0 && e.spawnTimer === 0
    && hasLineOfSight(w, e.x, e.y, w.targetX, w.targetY)) {
    beginWindup(e, "rush");
    ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.45, gain: 0.65, trauma: 0 });
    return;
  }
  applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * surgeMult(e) * dt);
}

// The burrower: kite-denial. It dives (telegraph), tunnels toward the target at a speed
// multiple while untargetable (bounded), then arms a marked eruption where it stopped —
// the marker holds for the FULL windup, so the dodge is always readable. Surfacing leaves
// it exposed through the pop + recover: the punish window for holding your ground.
function updateBurrower(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    if (a.move === "dive") {
      a.time += dt;
      a.windup = Math.min(1, a.time / C.BURROW_DIVE_WINDUP);
      if (a.time >= C.BURROW_DIVE_WINDUP) {
        a.phase = "active"; a.time = 0; a.windup = 0;
        ev.push({ t: "burrowDive", x: e.x, y: e.y });
      }
      return;
    }
    // erupt: stationary underground, marker armed — the player's reaction window.
    a.time += dt;
    a.windup = Math.min(1, a.time / C.BURROW_ERUPT_WINDUP);
    if (a.time >= C.BURROW_ERUPT_WINDUP && tryRelease(w, a.markX, a.markY, C.BURROW_ERUPT_RADIUS)) {
      burrowerErupt(w, e, ev);
    }
    return;
  }
  if (a.phase === "active") {
    if (a.move === "dive") {
      a.time += dt;
      const has = findTarget(w, e.x, e.y);
      const dist = has ? Math.hypot(w.targetX - e.x, w.targetY - e.y) : Infinity;
      if (a.time >= C.BURROW_MAX_TRAVEL || dist <= C.BURROW_EMERGE_DIST) {
        beginWindup(e, "erupt");
        a.markX = e.x; a.markY = e.y; a.isAimLocked = true;
        return;
      }
      applyChaseStep(w, e, dt, chaseAngle(w, e), C.BURROW_TRAVEL_SPEED * dt);
      return;
    }
    // The surfacing pop itself.
    a.time += dt;
    if (a.time >= C.BURROW_POP) enterRecover(e);
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= C.BURROW_RECOVER) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const dist = Math.hypot(w.targetX - e.x, w.targetY - e.y) || 1;
  if (dist <= C.BURROW_TRIGGER && dist > C.BURROW_EMERGE_DIST && a.cooldown === 0 && e.spawnTimer === 0) {
    beginWindup(e, "dive");
    ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.7, gain: 0.55, trauma: 0 });
    return;
  }
  applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
}

function burrowerErupt(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack;
  a.phase = "active"; a.time = 0; a.windup = 0;
  a.cooldown = C.BURROW_CD * attackCdMultOf(e);
  for (const p of w.players.values()) {
    if (isProtected(p) || p.isDown || p.hp <= 0) continue;
    if (Math.hypot(p.x - a.markX, p.y - a.markY) < C.BURROW_ERUPT_RADIUS) damagePlayer(w, p, e.touchDamage, ev);
  }
  enemySmashEnvironment(w, a.markX, a.markY, C.BURROW_ERUPT_RADIUS, ev);
  ev.push({ t: "burrowErupt", x: a.markX, y: a.markY, r: C.BURROW_ERUPT_RADIUS });
}

// The orbiter: holds a strafing ring around the target (rotational tracking, not radial
// kiting), then STOPS to fire a quick telegraphed bolt — the stillness is the tell.
function updateOrbiter(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    if (stepWindupTimer(w, e, dt, C.ORBITER_WINDUP, C.ORBITER_LOCK, false)) {
      orbiterBolt(w, e, a.lockedAngle, ev);
      a.cooldown = C.ORBITER_CD * attackCdMultOf(e);
      armEcho(e, a.lockedAngle);
      enterRecover(e);
    }
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= C.ORBITER_RECOVER) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const dx = w.targetX - e.x, dy = w.targetY - e.y;
  const dist = Math.hypot(dx, dy) || 1;
  const toTarget = Math.atan2(dy, dx);
  if (a.cooldown === 0 && e.spawnTimer === 0 && dist <= C.ORBITER_RING + C.ORBITER_RING_SLACK * 2
    && hasLineOfSight(w, e.x, e.y, w.targetX, w.targetY)) {
    beginWindup(e, "spit");
    ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 1.5, gain: 0.45, trauma: 0 });
    return;
  }
  // Ring hold: strafe tangentially (seeded flip direction), blending inward/outward when
  // outside the ring's slack band.
  e.zig += dt * C.ORBITER_FLIP_RATE;
  const side = Math.sin(e.zig) >= 0 ? 1 : -1;
  let angle = toTarget + side * C.HALF_PI;
  if (dist > C.ORBITER_RING + C.ORBITER_RING_SLACK) angle = toTarget + side * (Math.PI * 0.3);
  else if (dist < C.ORBITER_RING - C.ORBITER_RING_SLACK) angle = toTarget + Math.PI - side * (Math.PI * 0.3);
  applyChaseStep(w, e, dt, angle, e.speed * dt);
}

// The orbiter's release body, shared by the live fire and the echoed repeat.
function orbiterBolt(w: WorldState, e: Enemy, angle: number, ev: SimEvent[]): void {
  const mx = e.x + Math.cos(angle) * (e.radius + 4);
  const my = e.y + Math.sin(angle) * (e.radius + 4);
  spawnEnemyBullet(w, mx, my, angle, C.ORBITER_BOLT_SPEED, C.ORBITER_BOLT_RADIUS, 1, "#8fb8ff", C.ORBITER_BOLT_LIFE);
  ev.push({ t: "spitMuzzle", x: mx, y: my });
}

// The shielder: an ordinary chaser whose front arc EATS bullets (see the bullet pass in
// updateEnemies) — the fight is a positioning question. Its guard angle is stored in
// lockedAngle (already on the wire), so the client draws exactly what the sim blocks.
function updateShielder(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    if (stepWindupTimer(w, e, dt, C.SHIELDER_WINDUP, C.SHIELDER_LOCK, false)
      && tryReleaseLane(w, e, a.lockedAngle, C.SHIELDER_BASH_SPEED * C.SHIELDER_BASH_DUR)) {
      a.phase = "active"; a.time = 0; a.windup = 0; a.cooldown = C.SHIELDER_CD * attackCdMultOf(e);
      ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 0.9, gain: 0.7, trauma: 0.05 });
    }
    return;
  }
  if (a.phase === "active") {
    a.time += dt;
    const step = C.SHIELDER_BASH_SPEED * dt;
    moveEnemyBy(w, e, Math.cos(a.lockedAngle) * step, Math.sin(a.lockedAngle) * step);
    if (a.time >= C.SHIELDER_BASH_DUR) enterRecover(e);
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= C.SHIELDER_RECOVER) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const dist = Math.hypot(w.targetX - e.x, w.targetY - e.y) || 1;
  if (dist <= C.SHIELDER_TRIGGER && a.cooldown === 0 && e.spawnTimer === 0
    && hasLineOfSight(w, e.x, e.y, w.targetX, w.targetY)) {
    beginWindup(e, "lunge");
    ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.6, gain: 0.6, trauma: 0 });
    return;
  }
  const chase = chaseAngle(w, e);
  // The guard tracks the walk (and holds through windup/recover via lockedAngle's last value).
  a.lockedAngle = chase;
  applyChaseStep(w, e, dt, chase, e.speed * dt);
}

// Whether the shielder's front arc swallows a shot arriving along `vx/vy`.
function isShieldBlocked(e: Enemy, vx: number, vy: number): boolean {
  if (e.kind !== "shielder") return false;
  const incoming = Math.atan2(-vy, -vx); // the direction the shot came FROM
  let diff = incoming - e.attack.lockedAngle;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return Math.abs(diff) <= C.SHIELDER_BLOCK_ARC / 2;
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// How far past the body a formation guard still eats bullets: the rootward's shadow pad,
// the marshal's wider P1 frontage. 0 everywhere else (the ordinary body-only test).
function guardPadOf(e: Enemy): number {
  if (e.kind === "rootward") return C.ROOTWARD_GUARD_PAD;
  if (e.kind === "marshal" && e.captainPhase !== 2) return MARSHAL.guardReach;
  return 0;
}

// The formation guard (rootward / P1 marshal): swallows NON-PIERCING bullets arriving
// inside its slow-turning frontal arc (anchored on lockedAngle, exactly what the wire
// carries). Piercing rounds punch through — the authored hard counter alongside the
// flank, melee over the top, and splash.
function isGuardBlocked(e: Enemy, b: Bullet): boolean {
  if (b.pierce > 0) return false;
  const arc = e.kind === "rootward" ? C.ROOTWARD_GUARD_ARC
    : e.kind === "marshal" && e.captainPhase !== 2 ? MARSHAL.guardArc
    : 0;
  if (arc === 0) return false;
  const incoming = Math.atan2(-b.vy, -b.vx);
  return Math.abs(angleDiff(incoming, e.attack.lockedAngle)) <= arc / 2;
}

// The bulwark elite's ONE directional breakable plate: absorbs non-piercing bullets
// arriving inside its frontal arc until the plate HP (the aux channel) is spent, then
// shatters for good. Reduction of a different shape — never immunity: melee, blasts,
// pierce and the flank always work, and the plate itself is finite.
function absorbOnBulwark(e: Enemy, b: Bullet, ev: SimEvent[]): boolean {
  if (e.tier !== "elite" || e.captainPhase !== undefined || e.aux <= 0) return false;
  if (eliteAffixOf(e.kind) !== "bulwark") return false;
  if (b.pierce > 0) return false;
  const incoming = Math.atan2(-b.vy, -b.vx);
  if (Math.abs(angleDiff(incoming, e.attack.lockedAngle)) > ELITE_BULWARK.arc / 2) return false;
  e.aux = Math.max(0, e.aux - b.damage);
  b.life = 0;
  ev.push({ t: "bulletBlocked", kind: e.kind, x: sweptHit.x, y: sweptHit.y, aim: Math.atan2(-b.vy, -b.vx) });
  if (e.aux === 0) {
    // The shatter: loud and final — from here the elite is just its chassis.
    ev.push({ t: "puff", x: e.x, y: e.y, n: 8, color: "#cfd6dd" });
    ev.push({ t: "cue", name: "guard.break", x: e.x, y: e.y, rate: 1, gain: 0.85, trauma: 0.06 });
  }
  return true;
}

// The caskbellows' rear crank: a round landing on its BACK arc mid-commitment knocks the
// sentry into the shared crash-grammar stagger — the long punish window. The stagger
// also spends the volley (cooldown restarts), so circling behind between shots is the
// authored answer.
function maybeCrankStagger(e: Enemy, b: Bullet, ev: SimEvent[]): void {
  if (e.kind !== "caskbellows") return;
  const a = e.attack;
  if (a.phase !== "windup" && a.phase !== "active") return;
  const incoming = Math.atan2(-b.vy, -b.vx);
  if (Math.abs(angleDiff(incoming, a.lockedAngle + Math.PI)) > C.CASK_REAR_ARC / 2) return;
  a.move = "crash";
  enterRecover(e);
  a.cooldown = C.CASK_CD * attackCdMultOf(e);
  ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.5, gain: 0.75, trauma: 0.05 });
}

// ---- the bestiary wave: rootward / echojack / seamcutter / caskbellows / sinderling /
// ---- fragment, their decoys (echo / knell), and the mid-band miniboss templates ----

// The rootward: a walking wall with a SLOW-TURNING guard. No committed attack — it herds.
// Its guard angle lives in lockedAngle (already on the wire), turning toward the chase
// heading at a capped rate, so circling it opens the flank the shielder never gives.
function updateRootward(w: WorldState, e: Enemy, dt: number): void {
  if (!findTarget(w, e.x, e.y)) return;
  const chase = chaseAngle(w, e);
  const d = angleDiff(chase, e.attack.lockedAngle);
  const maxTurn = C.ROOTWARD_TURN_RATE * dt;
  e.attack.lockedAngle += d > maxTurn ? maxTurn : d < -maxTurn ? -maxTurn : d;
  applyChaseStep(w, e, dt, chase, e.speed * surgeMult(e) * dt);
}

function countLiveKind(w: WorldState, kind: Enemy["kind"]): number {
  let n = 0;
  for (const e of w.enemies) if (!e.dead && e.kind === kind) n++;
  return n;
}

// The echojack: flee support. It keeps its distance; on cadence it PLANTS a false-noise
// decoy at its own position (a telegraphed beat — the jangling is visible), then BLINKS:
// a fast perpendicular relocation dash, deterministic side by id parity. The decoy is a
// real 1-HP body that draws homing fire and attention; the jack is already elsewhere.
function updateEchojack(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    a.time += dt;
    a.windup = Math.min(1, a.time / C.ECHOJACK_DECOY_WINDUP);
    if (a.time >= C.ECHOJACK_DECOY_WINDUP) {
      spawnEchoDecoy(w, e, ev);
      a.phase = "active"; a.move = "blink"; a.time = 0; a.windup = 0;
      a.cooldown = C.ECHOJACK_CD * attackCdMultOf(e);
      const toTarget = findTarget(w, e.x, e.y) ? Math.atan2(w.targetY - e.y, w.targetX - e.x) : e.zig;
      a.lockedAngle = toTarget + (e.id % 2 === 0 ? C.HALF_PI : -C.HALF_PI);
      ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 1.6, gain: 0.6, trauma: 0 });
    }
    return;
  }
  if (a.phase === "active") {
    a.time += dt;
    const step = C.ECHOJACK_BLINK_SPEED * dt;
    moveEnemyBy(w, e, Math.cos(a.lockedAngle) * step, Math.sin(a.lockedAngle) * step);
    ev.push({ t: "lungeTrail", x: e.x, y: e.y });
    if (a.time >= C.ECHOJACK_BLINK_DUR) enterRecover(e);
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= C.ECHOJACK_RECOVER) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const dx = w.targetX - e.x, dy = w.targetY - e.y;
  const dist = Math.hypot(dx, dy) || 1;
  const toTarget = Math.atan2(dy, dx);
  if (dist <= C.ECHOJACK_APPROACH && a.cooldown === 0 && e.spawnTimer === 0
    && countLiveKind(w, "echo") < C.ECHO_CAP) {
    beginWindup(e, "decoy");
    ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 1.5, gain: 0.5, trauma: 0 });
    return;
  }
  if (dist < C.ECHOJACK_FLEE) {
    const step = e.speed * dt;
    moveEnemyBy(w, e, -Math.cos(toTarget) * step, -Math.sin(toTarget) * step);
  } else if (dist > C.ECHOJACK_APPROACH) {
    applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
  }
}

function spawnEchoDecoy(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const decoy = createEnemy("echo", e.x, e.y, w.floor, w.rng, w.nextEnemyId++, {
    isSummoned: true, players: w.encounterPlayers,
  });
  decoy.aux = C.ECHO_LIFE;
  w.enemies.push(decoy);
  ev.push({ t: "enemySpawn", eid: decoy.id, kind: decoy.kind, tier: decoy.tier, x: decoy.x, y: decoy.y });
}

// The echo: pure noise. It stands still, counts its fuse down the aux channel, and
// expires quietly (never a kill, never loot). Shooting it works — that is the trick.
function updateEcho(e: Enemy, dt: number, ev: SimEvent[]): void {
  e.aux -= dt;
  if (e.aux <= 0) {
    e.aux = 0;
    e.dead = true;
    ev.push({ t: "puff", x: e.x, y: e.y, n: 5, color: ENEMY_ARCHETYPES.echo.tint });
  }
}

// The Toll's noise-lure: a planted bell-bomb. Harmless while the fuse (aux) burns; on
// expiry it tolls its own ring. Killed early (1 HP), it never sounds.
function updateKnell(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  e.aux -= dt;
  if (e.aux > 0) return;
  e.aux = 0;
  e.dead = true;
  for (let i = 0; i < TOLL.lureRingCount; i++) {
    spawnEnemyBullet(w, e.x, e.y, (i / TOLL.lureRingCount) * Math.PI * 2, TOLL.lureRingSpeed, TOLL.shotRadius, 1, ENEMY_ARCHETYPES.knell.tint, TOLL.shotLife);
  }
  ev.push({ t: "radialBurst", x: e.x, y: e.y });
  ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 0.5, gain: 0.8, trauma: 0.06 });
}

// The seamcutter: the lane. Windup previews the whole wall-to-wall seam (the mark is the
// far wall, frozen at aim lock); active travels it at a flat speed, splintering cover
// and throwing timed PERPENDICULAR sweep bolts; the far-wall recover is the punish
// window. Cross the seam early or trail behind it — the lane never turns post-lock.
function updateSeamcutter(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    a.time += dt;
    a.windup = Math.min(1, a.time / C.SEAM_WINDUP);
    if (!a.isAimLocked) {
      if (findTarget(w, e.x, e.y)) a.lockedAngle = Math.atan2(w.targetY - e.y, w.targetX - e.x);
      setSeamMark(w, e);
      if (a.time >= C.SEAM_LOCK) a.isAimLocked = true;
    }
    if (a.time >= C.SEAM_WINDUP
      && tryReleaseLane(w, e, a.lockedAngle, Math.hypot(a.markX - e.x, a.markY - e.y))) {
      a.phase = "active"; a.time = 0; a.windup = 0;
      e.seq = 0;
      a.cooldown = C.SEAM_CD * attackCdMultOf(e);
      ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 0.7, gain: 0.85, trauma: 0.06 });
    }
    return;
  }
  if (a.phase === "active") {
    a.time += dt;
    const step = C.SEAM_SPEED * dt;
    const x0 = e.x, y0 = e.y;
    rushSmashEnvironment(w, e, ev); // the seam splinters its furrow — furniture never wedges the cut
    moveEnemyBy(w, e, Math.cos(a.lockedAngle) * step, Math.sin(a.lockedAngle) * step);
    ev.push({ t: "lungeTrail", x: e.x, y: e.y });
    // The timed sweeps: a perpendicular bolt pair every interval along the cut.
    while (e.seq < Math.floor(a.time / C.SEAM_SWEEP_INTERVAL)) {
      e.seq++;
      spawnEnemyBullet(w, e.x, e.y, a.lockedAngle + C.HALF_PI, C.SEAM_SWEEP_SPEED, C.SEAM_SWEEP_RADIUS, 1, ENEMY_ARCHETYPES.seamcutter.tint, C.SEAM_SWEEP_LIFE);
      spawnEnemyBullet(w, e.x, e.y, a.lockedAngle - C.HALF_PI, C.SEAM_SWEEP_SPEED, C.SEAM_SWEEP_RADIUS, 1, ENEMY_ARCHETYPES.seamcutter.tint, C.SEAM_SWEEP_LIFE);
      ev.push({ t: "spitMuzzle", x: e.x, y: e.y });
    }
    const moved = Math.hypot(e.x - x0, e.y - y0);
    if (moved < step * chillMoveScale(e) * 0.5 || a.time >= C.SEAM_MAX_DUR) {
      enterRecover(e);
      ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.6, gain: 0.6, trauma: 0.04 });
    }
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= C.SEAM_RECOVER) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const dist = Math.hypot(w.targetX - e.x, w.targetY - e.y) || 1;
  if (dist <= C.SEAM_TRIGGER && a.cooldown === 0 && e.spawnTimer === 0
    && hasLineOfSight(w, e.x, e.y, w.targetX, w.targetY)) {
    beginWindup(e, "seam");
    setSeamMark(w, e);
    ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.4, gain: 0.65, trauma: 0 });
    return;
  }
  applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * surgeMult(e) * dt);
}

// The seam's far endpoint: a bounded ray march from the body along the locked bearing to
// the first wall (or the travel cap). Recomputed while tracking, frozen at aim lock —
// the previewed lane IS the traveled lane.
function setSeamMark(w: WorldState, e: Enemy): void {
  const a = e.attack;
  const maxDist = C.SEAM_SPEED * C.SEAM_MAX_DUR;
  const stepLen = TILE / 2;
  const cos = Math.cos(a.lockedAngle), sin = Math.sin(a.lockedAngle);
  let x = e.x, y = e.y;
  for (let d = stepLen; d <= maxDist; d += stepLen) {
    const nx = e.x + cos * d, ny = e.y + sin * d;
    if (isWall(w, nx, ny)) break;
    x = nx; y = ny;
  }
  a.markX = x;
  a.markY = y;
}

// The caskbellows: a stationary lane sentry. It locks a target, fires a 3-shot volley
// down the locked lane, and staggers hard (crash grammar — see maybeCrankStagger) when a
// round lands on its rear crank mid-commitment. It waddles back to range when crowded;
// otherwise it holds its ground and tracks.
function updateCaskbellows(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    if (stepWindupTimer(w, e, dt, C.CASK_WINDUP, C.CASK_LOCK, false)) {
      a.phase = "active"; a.time = 0; a.windup = 0;
      e.seq = 0;
      a.cooldown = C.CASK_CD * attackCdMultOf(e);
    }
    return;
  }
  if (a.phase === "active") {
    a.time += dt;
    while (e.seq < C.CASK_SHOTS && a.time >= e.seq * C.CASK_SHOT_GAP) {
      const mx = e.x + Math.cos(a.lockedAngle) * (e.radius + 4);
      const my = e.y + Math.sin(a.lockedAngle) * (e.radius + 4);
      spawnEnemyBullet(w, mx, my, a.lockedAngle, C.CASK_BOLT_SPEED, C.CASK_BOLT_RADIUS, 1, ENEMY_ARCHETYPES.caskbellows.tint, C.CASK_BOLT_LIFE);
      ev.push({ t: "spitMuzzle", x: mx, y: my });
      e.seq++;
    }
    if (e.seq >= C.CASK_SHOTS && a.time >= (C.CASK_SHOTS - 1) * C.CASK_SHOT_GAP + 0.05) enterRecover(e);
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= (a.move === "crash" ? C.CASK_STAGGER : C.CASK_RECOVER)) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const dx = w.targetX - e.x, dy = w.targetY - e.y;
  const dist = Math.hypot(dx, dy) || 1;
  const toTarget = Math.atan2(dy, dx);
  // The crank faces away from the lane: keep the lane tracking while idle so the rear
  // arc (and the client's crank render) stays honest between volleys.
  a.lockedAngle = toTarget;
  if (dist <= C.CASK_TRIGGER && a.cooldown === 0 && e.spawnTimer === 0
    && hasLineOfSight(w, e.x, e.y, w.targetX, w.targetY)) {
    beginWindup(e, "volley");
    ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 0.8, gain: 0.6, trauma: 0 });
    return;
  }
  // The periodic reposition: crowded, it waddles back toward its firing range; too far,
  // it closes. In its band it is a turret.
  if (dist < C.CASK_TOO_CLOSE) {
    const step = e.speed * dt;
    moveEnemyBy(w, e, -Math.cos(toTarget) * step, -Math.sin(toTarget) * step);
  } else if (dist > C.CASK_TRIGGER) {
    applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
  }
}

// The sinderling: the heat-feeder. Unarmed it seeks environmental heat — an ACTIVE fire
// vent or a brazier — and consumes one pulse to ARM (aux 1, on the wire: the client
// renders the stoked glow). With no heat in reach it stokes itself on a long stationary
// channel instead, so the identity works on every floor. Armed: a locked flame-jet dash
// (rush grammar) laying a burning cinder wake; an armed DEATH bursts shared-risk fire.
function updateSinderling(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    if (a.move === "stoke") {
      a.time += dt;
      a.windup = Math.min(1, a.time / C.SINDER_STOKE_WINDUP);
      if (a.time >= C.SINDER_STOKE_WINDUP) {
        sinderArm(e, ev);
        enterIdle(e);
      }
      return;
    }
    // The jet (rush grammar: aimed, locked, shoves on impact).
    if (stepWindupTimer(w, e, dt, C.SINDER_JET_WINDUP, C.SINDER_JET_LOCK, false)
      && tryReleaseLane(w, e, a.lockedAngle, C.SINDER_JET_SPEED * C.SINDER_JET_DUR)) {
      a.phase = "active"; a.time = 0; a.windup = 0;
      e.seq = 0;
      a.cooldown = C.SINDER_CD * attackCdMultOf(e);
      ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 1.2, gain: 0.75, trauma: 0.05 });
    }
    return;
  }
  if (a.phase === "active") {
    a.time += dt;
    if (isTouchingAnyPlayer(w, e)) { enterRecover(e); return; }
    const step = C.SINDER_JET_SPEED * dt;
    const x0 = e.x, y0 = e.y;
    moveEnemyBy(w, e, Math.cos(a.lockedAngle) * step, Math.sin(a.lockedAngle) * step);
    ev.push({ t: "lungeTrail", x: e.x, y: e.y });
    // The flame wedge: a burning cinder dropped every few px of the jet's wake.
    while (e.seq < Math.floor(a.time / C.SINDER_CINDER_GAP)) {
      e.seq++;
      plantCinder(w, e.x, e.y);
    }
    const moved = Math.hypot(e.x - x0, e.y - y0);
    if (moved < step * chillMoveScale(e) * 0.5 || a.time >= C.SINDER_JET_DUR) enterRecover(e);
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= C.SINDER_JET_RECOVER) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const dist = Math.hypot(w.targetX - e.x, w.targetY - e.y) || 1;
  if (e.aux === 0) {
    // Unarmed: feed first. Consume standing heat, else walk to the nearest source, else
    // stoke — the channel is long and stationary: killing it unarmed is always on offer.
    if (isOnHeat(w, e)) { sinderArm(e, ev); return; }
    const heat = nearestHeatPoint(w, e);
    if (heat !== null) {
      applyChaseStep(w, e, dt, Math.atan2(heat.y - e.y, heat.x - e.x), e.speed * dt);
      return;
    }
    if (a.cooldown === 0 && e.spawnTimer === 0 && dist <= C.SINDER_HEAT_RANGE) {
      beginWindup(e, "stoke");
      ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 0.65, gain: 0.55, trauma: 0 });
      return;
    }
    applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
    return;
  }
  // Armed: faster, hungrier, and carrying the jet.
  if (dist <= C.SINDER_JET_TRIGGER && a.cooldown === 0 && e.spawnTimer === 0
    && hasLineOfSight(w, e.x, e.y, w.targetX, w.targetY)) {
    beginWindup(e, "rush");
    ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.9, gain: 0.6, trauma: 0 });
    return;
  }
  applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * C.SINDER_ARMED_SPEED_MULT * surgeMult(e) * dt);
}

function sinderArm(e: Enemy, ev: SimEvent[]): void {
  e.aux = 1;
  ev.push({ t: "flash", eid: e.id });
  ev.push({ t: "puff", x: e.x, y: e.y, n: 6, color: ENEMY_ARCHETYPES.sinderling.tint });
  ev.push({ t: "cue", name: "barrel", x: e.x, y: e.y, rate: 1.4, gain: 0.5, trauma: 0 });
}

// Standing heat: an ACTIVE fire vent under its feet, or a brazier at arm's reach.
function isOnHeat(w: WorldState, e: Enemy): boolean {
  const tx = Math.floor(e.x / TILE), ty = Math.floor(e.y / TILE);
  for (const h of w.floorHazards) {
    if (h.kind !== "fire_vent" || h.tx !== tx || h.ty !== ty) continue;
    if (floorHazardPhaseAt(h, w.floorHazardClock) === "active") return true;
  }
  for (const p of w.props) {
    if (p.dead || p.kind !== "brazier") continue;
    if (Math.hypot(e.x - p.x, e.y - p.y) <= e.radius + p.radius + C.SINDER_BRAZIER_RANGE) return true;
  }
  return false;
}

// Shared scratch for nearestHeatPoint (read immediately by the one caller).
const heatPoint = { x: 0, y: 0 };

function nearestHeatPoint(w: WorldState, e: Enemy): { x: number; y: number } | null {
  let bestD = C.SINDER_HEAT_RANGE * C.SINDER_HEAT_RANGE;
  let found = false;
  for (const h of w.floorHazards) {
    if (h.kind !== "fire_vent") continue;
    const cx = (h.tx + 0.5) * TILE, cy = (h.ty + 0.5) * TILE;
    const dx = cx - e.x, dy = cy - e.y, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; heatPoint.x = cx; heatPoint.y = cy; found = true; }
  }
  for (const p of w.props) {
    if (p.dead || p.kind !== "brazier") continue;
    const dx = p.x - e.x, dy = p.y - e.y, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; heatPoint.x = p.x; heatPoint.y = p.y; found = true; }
  }
  return found ? heatPoint : null;
}

function plantCinder(w: WorldState, x: number, y: number): void {
  if (isWall(w, x, y)) return;
  let cinders = 0;
  for (const h of w.hazards) if (h.kind === "cinder") cinders++;
  if (cinders >= C.SINDER_CINDER_CAP) return; // hard cap: a wake, never a lake
  w.hazards.push({
    id: w.nextHazardId++, kind: "cinder", x, y,
    radius: C.SINDER_CINDER_RADIUS, life: C.SINDER_CINDER_LIFE, maxLife: C.SINDER_CINDER_LIFE,
  });
}

// The armed sinderling's death: an immediate SHARED-risk burst. Players take 1 (their
// protection rules apply); enemies take more — the fire is nobody's friend — and enemy
// kills inside it credit the sinderling's killer. Cover splinters.
function sinderlingBurst(w: WorldState, p: PlayerSim | null, e: Enemy, ev: SimEvent[]): void {
  const r = C.SINDER_BURST_RADIUS;
  ev.push({ t: "explosion", x: e.x, y: e.y, r });
  ev.push({ t: "cue", name: "sinderling.burst", x: e.x, y: e.y, rate: 1, gain: 0.8, trauma: 0.05 });
  for (const victim of w.players.values()) {
    if (isProtected(victim) || victim.isDown || victim.isAbsent || victim.hp <= 0) continue;
    if (Math.hypot(victim.x - e.x, victim.y - e.y) <= r) damagePlayer(w, victim, C.SINDER_BURST_PLAYER_DMG, ev);
  }
  for (const other of w.enemies) {
    if (other === e || other.dead || isUntargetable(other)) continue;
    if (Math.hypot(other.x - e.x, other.y - e.y) > r + other.radius) continue;
    damageEnemy(w, p ? p.id : null, other, C.SINDER_BURST_ENEMY_DMG, ev);
    ev.push({ t: "puff", x: other.x, y: other.y, n: 4, color: ENEMY_ARCHETYPES[other.kind].tint });
    if (other.hp <= 0 && !other.dead) killEnemy(w, p, other, ev);
  }
  enemySmashEnvironment(w, e.x, e.y, r, ev);
}

// The choir fragment: the tethered voice. It binds to the nearest OTHER enemy in line of
// sight (the source id + 1 rides the aux channel so the client draws the authoritative
// tether); on cadence the tether HARMONIZES — the segment between the two bodies becomes
// a damaging lane for a short pulse. Kill the source or break line of sight and the
// pattern simplifies to a slow contact drifter.
function updateFragment(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  let src = fragmentSourceOf(w, e);
  if (src !== null && (src.dead || !hasLineOfSight(w, e.x, e.y, src.x, src.y))) src = null;
  if (src === null) {
    if (e.aux !== 0) {
      e.aux = 0;
      // The lane dissolves the moment the tether breaks — mid-pulse included.
      if (a.move === "harmonize") enterIdle(e);
    }
    src = pickFragmentSource(w, e);
    if (src !== null) e.aux = src.id + 1;
  }
  if (a.phase === "windup" && a.move === "harmonize") {
    a.time += dt;
    a.windup = Math.min(1, a.time / C.FRAGMENT_PULSE_WINDUP);
    if (a.time >= C.FRAGMENT_PULSE_WINDUP && src !== null) {
      // The release area is the whole lane: arbitrated at its midpoint like every other
      // line commitment. Blocked pulses hold at full windup and re-check.
      const midX = (e.x + src.x) / 2, midY = (e.y + src.y) / 2;
      const half = Math.hypot(src.x - e.x, src.y - e.y) / 2;
      if (tryRelease(w, midX, midY, half)) {
        a.phase = "active"; a.time = 0; a.windup = 0;
        ev.push({ t: "cue", name: "fragment.pulse", x: e.x, y: e.y, rate: 1, gain: 0.7, trauma: 0.03 });
      }
    }
    return;
  }
  if (a.phase === "active" && a.move === "harmonize") {
    a.time += dt;
    if (src !== null) harmonizeLaneDamage(w, e, src, ev);
    if (a.time >= C.FRAGMENT_PULSE_ACTIVE) {
      enterRecover(e);
      a.cooldown = C.FRAGMENT_CD * attackCdMultOf(e);
    }
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= C.FRAGMENT_PULSE_RECOVER) enterIdle(e);
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  const dist = Math.hypot(w.targetX - e.x, w.targetY - e.y) || 1;
  // Tethered it hovers at mid-range, singing; untethered it drifts in with contact only.
  const hold = e.aux !== 0 ? C.FRAGMENT_HOLD_DIST : 0;
  if (dist > hold) applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
  if (e.aux !== 0 && src !== null && a.cooldown === 0 && e.spawnTimer === 0) {
    beginWindup(e, "harmonize");
    ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 1.8, gain: 0.45, trauma: 0 });
  }
}

function fragmentSourceOf(w: WorldState, e: Enemy): Enemy | null {
  if (e.aux === 0) return null;
  const id = e.aux - 1;
  for (const other of w.enemies) if (other.id === id && !other.dead) return other;
  return null;
}

// A valid tether source: the nearest other living enemy in range with line of sight —
// never another fragment (no daisy chains) and never a decoy (noise cannot sing).
function pickFragmentSource(w: WorldState, e: Enemy): Enemy | null {
  let best: Enemy | null = null;
  let bestD = C.FRAGMENT_TETHER_RANGE * C.FRAGMENT_TETHER_RANGE;
  for (const other of w.enemies) {
    if (other === e || other.dead) continue;
    if (other.kind === "fragment" || other.kind === "echo" || other.kind === "knell") continue;
    const dx = other.x - e.x, dy = other.y - e.y, d = dx * dx + dy * dy;
    if (d >= bestD) continue;
    if (!hasLineOfSight(w, e.x, e.y, other.x, other.y)) continue;
    bestD = d;
    best = other;
  }
  return best;
}

function harmonizeLaneDamage(w: WorldState, e: Enemy, src: Enemy, ev: SimEvent[]): void {
  const dx = src.x - e.x, dy = src.y - e.y;
  const len2 = dx * dx + dy * dy;
  for (const p of w.players.values()) {
    if (isProtected(p) || p.isDown || p.isAbsent || p.hp <= 0) continue;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - e.x) * dx + (p.y - e.y) * dy) / len2)) : 0;
    const px = e.x + dx * t, py = e.y + dy * t;
    if (Math.hypot(p.x - px, p.y - py) < C.FRAGMENT_BEAM_HALF_WIDTH + p.pr) damagePlayer(w, p, 1, ev);
  }
}

// ROOT MARSHAL (miniboss template: the formation fight). P1 (captainPhase 1): a wide
// slow-turning guard + a live formation — it raises swarm rootwards on a cadence and
// walks its wall forward. At 50% the generic captain transition fires and the shield
// SHATTERS INTO DESTRUCTIBLE COVER (see marshalShatterShield); P2 trades the wall for
// tempo: ring sweeps alternating aimed fans, with the guard gone for good.
function updateMarshal(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (e.captainPhase === 1 || e.captainPhase === undefined) {
    if (!findTarget(w, e.x, e.y)) return;
    const chase = chaseAngle(w, e);
    const d = angleDiff(chase, a.lockedAngle);
    const maxTurn = MARSHAL.guardTurnRate * dt;
    a.lockedAngle += d > maxTurn ? maxTurn : d < -maxTurn ? -maxTurn : d;
    // The formation: seq is the summon countdown while the shield stands.
    e.seq -= dt;
    if (e.seq <= 0 && e.spawnTimer === 0) {
      e.seq = MARSHAL.summonInterval;
      if (countMarshalWards(w) < MARSHAL.summonCap) spawnMarshalWard(w, e, ev);
    }
    applyChaseStep(w, e, dt, chase, e.speed * dt);
    return;
  }
  // P2: the sweeps.
  if (a.phase === "windup") {
    if (a.move === "sweep") {
      a.time += dt;
      a.windup = Math.min(1, a.time / MARSHAL.sweepWindup);
      if (a.time >= MARSHAL.sweepWindup) {
        marshalRing(w, e, ev);
        enterRecover(e);
      }
      return;
    }
    // The aimed fan (volley grammar).
    if (stepWindupTimer(w, e, dt, MARSHAL.sweepWindup, MARSHAL.sweepWindup * 0.55, false)) {
      marshalFan(w, e, ev);
      enterRecover(e);
    }
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= MARSHAL.sweepRecover) enterIdle(e);
    return;
  }
  if (a.cooldown === 0 && e.spawnTimer === 0 && findTarget(w, e.x, e.y)) {
    e.seq = Math.floor(e.seq) + 1;
    a.cooldown = MARSHAL.sweepCooldown;
    beginWindup(e, e.seq % 2 === 1 ? "sweep" : "volley");
    ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.5, gain: 0.7, trauma: 0 });
    return;
  }
  if (!findTarget(w, e.x, e.y)) return;
  applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
}

function countMarshalWards(w: WorldState): number {
  let n = 0;
  for (const e of w.enemies) if (!e.dead && e.isSummoned && e.kind === "rootward") n++;
  return n;
}

function spawnMarshalWard(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const angle = e.attack.lockedAngle + (countMarshalWards(w) === 0 ? 0.9 : -0.9);
  const mx = e.x + Math.cos(angle) * (e.radius + 26);
  const my = e.y + Math.sin(angle) * (e.radius + 26);
  if (!settleSpawnPoint(w, mx, my, ENEMY_ARCHETYPES.rootward.radius)) return;
  const ward = createEnemy("rootward", settlePoint.x, settlePoint.y, w.floor, w.rng, w.nextEnemyId++, {
    tier: "swarm", isSummoned: true, players: w.encounterPlayers,
  });
  w.enemies.push(ward);
  ev.push({ t: "enemySpawn", eid: ward.id, kind: ward.kind, tier: ward.tier, x: ward.x, y: ward.y });
}

function marshalRing(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const base = e.seq % 4 < 2 ? 0 : Math.PI / MARSHAL.sweepCount;
  for (let i = 0; i < MARSHAL.sweepCount; i++) {
    spawnEnemyBullet(w, e.x, e.y, base + (i / MARSHAL.sweepCount) * Math.PI * 2, MARSHAL.sweepSpeed, MARSHAL.shotRadius, 1, ENEMY_ARCHETYPES.marshal.tint, MARSHAL.shotLife);
  }
  ev.push({ t: "radialBurst", x: e.x, y: e.y });
}

function marshalFan(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack;
  for (let i = 0; i < MARSHAL.fanShots; i++) {
    const off = (i - (MARSHAL.fanShots - 1) / 2) * MARSHAL.fanSpread;
    spawnEnemyBullet(w, e.x, e.y, a.lockedAngle + off, MARSHAL.fanSpeed, MARSHAL.shotRadius, 1, ENEMY_ARCHETYPES.marshal.tint, MARSHAL.shotLife);
  }
  ev.push({ t: "bossVolley", x: e.x + Math.cos(a.lockedAngle) * (e.radius + 6), y: e.y + Math.sin(a.lockedAngle) * (e.radius + 6) });
}

// The marshal's 50% beat: the shield SHATTERS INTO COVER — real destructible crates land
// where the guard hung, becoming the player's cover against the P2 rings. Placement is
// deterministic (the guard's arc), validated for walls/props/players, and bumps the
// obstacle revision through the ordinary door so navigation re-routes.
function marshalShatterShield(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const spread = 0.7;
  for (let i = 0; i < MARSHAL.coverCount; i++) {
    const ang = e.attack.lockedAngle + (i - (MARSHAL.coverCount - 1) / 2) * spread;
    const x = e.x + Math.cos(ang) * MARSHAL.coverDist;
    const y = e.y + Math.sin(ang) * MARSHAL.coverDist;
    if (isWall(w, x, y) || blockedByProp(w, x, y, C.PROP_RADIUS)) continue;
    let isClear = true;
    for (const p of w.players.values()) {
      if (Math.hypot(p.x - x, p.y - y) < p.pr + C.PROP_RADIUS + 4) { isClear = false; break; }
    }
    if (!isClear) continue;
    w.props.push({ id: w.nextPropId++, kind: "crate", x, y, radius: C.PROP_RADIUS, hp: C.PROP_HP.crate, dead: false });
    ev.push({ t: "puff", x, y, n: 5, color: ENEMY_ARCHETYPES.marshal.tint });
  }
  w.obstacleRev++;
  e.seq = 0; // P2's sweep alternation starts fresh
  ev.push({ t: "cue", name: "enemyDeath", x: e.x, y: e.y, rate: 0.6, gain: 0.85, trauma: 0.1 });
}

// THE TOLL (miniboss template: the sound-lane fight). Nearly stationary. P1: the knell —
// an expanding sound ring — alternating an aimed three-bolt peal (volley grammar). P2:
// every knell also plants a NOISE-LURE at the nearest player's feet (a 1-HP knell decoy
// that tolls its own ring when its fuse runs out — shoot the noise or leave it).
function updateToll(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.phase === "windup") {
    if (a.move === "knell") {
      a.time += dt;
      a.windup = Math.min(1, a.time / TOLL.ringWindup);
      if (a.time >= TOLL.ringWindup) {
        tollRing(w, e, ev);
        if (e.captainPhase === 2) tollPlantLure(w, e, ev);
        enterRecover(e);
      }
      return;
    }
    // The peal (volley grammar: aimed, locked).
    if (stepWindupTimer(w, e, dt, TOLL.pealWindup, TOLL.pealLock, false)) {
      tollPeal(w, e, ev);
      enterRecover(e);
    }
    return;
  }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= (a.move === "knell" ? TOLL.ringRecover : TOLL.pealRecover)) enterIdle(e);
    return;
  }
  if (a.cooldown === 0 && e.spawnTimer === 0 && findTarget(w, e.x, e.y)) {
    e.seq++;
    a.cooldown = TOLL.ringCooldown;
    beginWindup(e, e.seq % 2 === 1 ? "knell" : "volley");
    ev.push({ t: "cue", name: "enemyAttack", x: e.x, y: e.y, rate: 0.45, gain: 0.7, trauma: 0 });
    return;
  }
  // The bell barely walks: it creeps only when the fight has left it behind entirely.
  if (!findTarget(w, e.x, e.y)) return;
  if (Math.hypot(w.targetX - e.x, w.targetY - e.y) > 500) {
    applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
  }
}

function tollRing(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const base = e.seq % 4 < 2 ? 0 : Math.PI / TOLL.ringCount;
  for (let i = 0; i < TOLL.ringCount; i++) {
    spawnEnemyBullet(w, e.x, e.y, base + (i / TOLL.ringCount) * Math.PI * 2, TOLL.ringSpeed, TOLL.shotRadius, 1, ENEMY_ARCHETYPES.toll.tint, TOLL.shotLife);
  }
  ev.push({ t: "radialBurst", x: e.x, y: e.y });
}

function tollPeal(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack;
  for (let i = 0; i < TOLL.pealShots; i++) {
    const off = (i - (TOLL.pealShots - 1) / 2) * TOLL.pealSpread;
    spawnEnemyBullet(w, e.x, e.y, a.lockedAngle + off, TOLL.pealSpeed, TOLL.shotRadius, 1, ENEMY_ARCHETYPES.toll.tint, TOLL.shotLife);
  }
  ev.push({ t: "bossVolley", x: e.x + Math.cos(a.lockedAngle) * (e.radius + 6), y: e.y + Math.sin(a.lockedAngle) * (e.radius + 6) });
}

function tollPlantLure(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  if (!findTarget(w, e.x, e.y)) return;
  if (!settleSpawnPoint(w, w.targetX, w.targetY, ENEMY_ARCHETYPES.knell.radius)) return;
  const lure = createEnemy("knell", settlePoint.x, settlePoint.y, w.floor, w.rng, w.nextEnemyId++, {
    isSummoned: true, players: w.encounterPlayers,
  });
  lure.aux = TOLL.lureLife;
  w.enemies.push(lure);
  ev.push({ t: "enemySpawn", eid: lure.id, kind: lure.kind, tier: lure.tier, x: lure.x, y: lure.y });
  ev.push({ t: "cue", name: "knell.fuse", x: lure.x, y: lure.y, rate: 1, gain: 0.65, trauma: 0 });
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
  if (dist < C.SPITTER_FLEE) {
    // Retreat stays a direct backpedal: a cornered spitter is the player's reward.
    const step = e.speed * dt;
    moveEnemyBy(w, e, -Math.cos(toTarget) * step, -Math.sin(toTarget) * step);
  } else if (dist > C.SPITTER_APPROACH) {
    // The approach routes like every other ground enemy (prop-aware + anti-stuck):
    // a kiter that wedges on a barrel forever out of range never becomes a fight.
    applyChaseStep(w, e, dt, chaseAngle(w, e), e.speed * dt);
  }
}

function spitterFire(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  spitterVolley(w, e, e.attack.lockedAngle, ev);
  e.attack.cooldown = C.SPITTER_CD * attackCdMultOf(e);
  armEcho(e, e.attack.lockedAngle);
}

// The release body, shared by the live fire and the echoed elite's delayed repeat.
function spitterVolley(w: WorldState, e: Enemy, angle: number, ev: SimEvent[]): void {
  const n = w.floor >= C.SPITTER_SPREAD_FLOOR ? 3 : 1;
  const mx = e.x + Math.cos(angle) * (e.radius + 4);
  const my = e.y + Math.sin(angle) * (e.radius + 4);
  for (let i = 0; i < n; i++) {
    const off = n === 1 ? 0 : (i - 1) * C.GLOB_SPREAD;
    spawnEnemyBullet(w, mx, my, angle + off, 300, 7, 1, "#ff5a7a", 2.5);
  }
  ev.push({ t: "spitMuzzle", x: mx, y: my });
}

// Arm the echoed elite's one repeat at fire time. A refire never re-arms (refireEcho
// calls the volley bodies directly), so a release echoes exactly once.
function armEcho(e: Enemy, angle: number): void {
  if (e.tier !== "elite" || e.captainPhase !== undefined || eliteAffixOf(e.kind) !== "echoed") return;
  e.echoTime = ELITE_ECHOED.delay;
  e.echoAngle = angle;
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
  bossChase(w, e, dt, ev);
}

// Living boss-summoned adds (the cadence cap counts only summons, never floor enemies).
function countBossAdds(w: WorldState): number {
  let n = 0;
  for (const e of w.enemies) if (!e.dead && e.isSummoned && !isBossKind(e.kind)) n++;
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
    if (isProtected(p) || p.isDown || p.isAbsent || p.hp <= 0) continue;
    if (Math.hypot(p.x - e.x, p.y - e.y) > safeR) damagePlayer(w, p, BOSS.squeezeDamage, ev);
  }
  if (a.time >= BOSS.squeezeDuration) enterIdle(e);
}

function bossLand(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack, boss = e.boss;
  const x = a.markX, y = a.markY;
  // Slam center hits for 2; the outer shockwave ring for 1 (spec §5 damage table).
  for (const p of w.players.values()) {
    if (isProtected(p) || p.isDown || p.isAbsent || p.hp <= 0) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < BOSS.slamInnerRadius) damagePlayer(w, p, BOSS.slamCenterDamage, ev);
    else if (d < BOSS.slamRadius) damagePlayer(w, p, BOSS.slamOuterDamage, ev);
  }
  enemySmashEnvironment(w, x, y, BOSS.slamRadius, ev);
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

function bossChase(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  if (!findTarget(w, e.x, e.y)) return;
  const angle = Math.atan2(w.targetY - e.y, w.targetX - e.x);
  const mult = e.boss && e.boss.phase >= 3 ? BOSS.p3ChaseMult : 1;
  const step = e.speed * mult * dt;
  moveEnemyBy(w, e, Math.cos(angle) * step, Math.sin(angle) * step);
  // The boss does not walk around cover — it walks THROUGH it. The crush reach extends
  // just past moveCircle's prop-block ring (prop.radius * 0.8 off the body), so a crate
  // can never body-block the boss: whatever stops its step is destroyed by it.
  enemySmashEnvironment(w, e.x, e.y, e.radius + 2, ev);
}

// Spawn one summoned add at `angle` off the boss's edge — each boss raises its own kin
// (the King standard slimes; the deep bosses fragile SWARM bodies, killable inside an
// interactive beat). Summons are excluded from hearts/Fang (isSummoned) so add pressure
// never becomes a sustain farm. The point settles like every other spawn (body-clear +
// reachable — never inside a wall or a sealed cover pocket); a rim point with no valid
// neighborhood skips the add. Returns the add (interactive beats track ids), or null.
function spawnBossAdd(w: WorldState, e: Enemy, angle: number, ev: SimEvent[]): Enemy | null {
  const kin = BOSS_KIN[e.kind] ?? "slime";
  const mx = e.x + Math.cos(angle) * (e.radius + 20);
  const my = e.y + Math.sin(angle) * (e.radius + 20);
  if (!settleSpawnPoint(w, mx, my, ENEMY_ARCHETYPES[kin].radius)) {
    ev.push({ t: "bossAddSpawn", eid: e.id, x: e.x, y: e.y, mx: e.x, my: e.y, spawned: false });
    return null;
  }
  const add = createEnemy(kin, settlePoint.x, settlePoint.y, w.floor, w.rng, w.nextEnemyId++, {
    tier: e.kind === "boss" ? "standard" : "swarm", isSummoned: true, players: w.encounterPlayers,
  });
  w.enemies.push(add);
  ev.push({ t: "bossAddSpawn", eid: e.id, x: e.x, y: e.y, mx: add.x, my: add.y, spawned: true });
  return add;
}

// MARROW (spec §5b, calibrated like §5 to the same 30–45s TTK band at F10).
// A LINE boss: everything it does is an angle you read and step off, and its biggest
// opening is self-inflicted (the wall-crash stun). Phase changes ride damage events
// (checkBossTransition) exactly like the King; this machine owns the cadence:
//   P1 (100–65%): alternating line charge / 3-shard volley every 3.0s; husk adds on cadence.
//   P2 (65–30%):  2.6s cadence; 5-shard volley; a wall crash bursts a 6-shard ring.
//   P3 (30–0%):   2.2s cadence; 7 shards, 8-ring crash; every 3rd attack is the rotating
//                 spiral barrage; stalk +10%.
// Transitions (65%/30%) raise the SHIELD beat: reduction + floors + queued overflow, and
// two husks whose deaths break the shield early — read the beat, switch targets, profit.
function updateMarrow(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const boss = e.boss;
  if (!boss) return;
  const a = e.attack;

  // Add pacing pauses during the shield beat (the beat spawned its own marked husks).
  if (!boss.roar) {
    boss.addTimer -= dt;
    if (boss.addTimer <= 0) {
      boss.addTimer = MARROW.addInterval[boss.phase];
      const cap = MARROW.addCap[boss.phase];
      for (let i = 0; i < MARROW.addBatch[boss.phase]; i++) {
        if (countBossAdds(w) >= cap) break;
        spawnBossAdd(w, e, w.rng.next() * Math.PI * 2, ev);
      }
    }
  }

  if (a.phase === "windup") { marrowWindup(w, e, dt, ev); return; }
  if (a.phase === "active") { marrowActive(w, e, dt, ev); return; }
  if (a.phase === "recover") {
    a.time += dt;
    const recDur = a.move === "crash" ? MARROW.crashStun
      : a.move === "rush" ? MARROW.chargeRecover
      : a.move === "spin" ? MARROW.spinRecover
      : MARROW.volleyRecover;
    if (a.time >= recDur) enterIdle(e);
    return;
  }

  if (a.cooldown === 0 && e.spawnTimer === 0) { marrowBeginAttack(e, ev); return; }
  marrowChase(w, e, dt);
}

function marrowBeginAttack(e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  boss.attackCount++;
  e.attack.cooldown = MARROW.attackCd[boss.phase];
  // P3: every 3rd attack is the stationary spiral barrage (0.8s telegraph, 2.2s weave).
  if (boss.phase >= 3 && boss.attackCount % MARROW.spinEvery === 0) {
    beginWindup(e, "spin");
    ev.push({ t: "cue", name: "bossSpawn", x: e.x, y: e.y, rate: 0.9, gain: 0.7, trauma: 0.1 });
    return;
  }
  const isVolley = boss.isNextRadial;
  boss.isNextRadial = !boss.isNextRadial;
  beginWindup(e, isVolley ? "volley" : "rush");
  ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: isVolley ? 0.55 : 0.4, gain: 0.7, trauma: 0 });
}

function marrowWindup(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.move === "shield") {
    a.time += dt;
    a.windup = Math.min(1, a.time / MARROW.shieldDuration);
    // The interactive break: past the minimum readable beat, the shield holds only while
    // a marked husk still stands (or until its hard cap elapses).
    const isBreakable = a.time >= MARROW.shieldMinDuration;
    if (a.time >= MARROW.shieldDuration || (isBreakable && countLiveBeatAdds(w, e) === 0)) {
      e.boss!.beatAddIds.length = 0;
      enterIdle(e);
      endBossTransition(w, e, ev);
    }
    return;
  }
  if (a.move === "spin") {
    a.time += dt;
    a.windup = Math.min(1, a.time / MARROW.spinWindup);
    if (a.time >= MARROW.spinWindup) {
      // Anchor the spiral on the target's bearing at release, and flip its rotation
      // direction each barrage so the weave never becomes muscle memory.
      if (findTarget(w, e.x, e.y)) a.lockedAngle = Math.atan2(w.targetY - e.y, w.targetX - e.x);
      const boss = e.boss!;
      boss.spinCount = 0;
      boss.burstParity ^= 1;
      a.phase = "active"; a.time = 0; a.windup = 0;
      ev.push({ t: "radialBurst", x: e.x, y: e.y });
    }
    return;
  }
  if (a.move === "volley") {
    if (stepWindupTimer(w, e, dt, MARROW.volleyWindup, MARROW.volleyLock, false)) {
      marrowVolleyFire(w, e, ev);
      enterRecover(e);
    }
    return;
  }
  // rush
  if (stepWindupTimer(w, e, dt, MARROW.chargeWindup, MARROW.chargeLock, false)) {
    a.phase = "active"; a.time = 0; a.windup = 0;
    ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 0.55, gain: 0.9, trauma: 0.05 });
  }
}

function marrowActive(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  const boss = e.boss!;
  if (a.move === "spin") {
    a.time += dt;
    a.windup = Math.min(1, a.time / MARROW.spinDuration);
    const dir = boss.burstParity === 0 ? 1 : -1;
    // Deterministic pair emitter: shard pair k fires as elapsed time crosses k×interval.
    while (boss.spinCount < Math.floor(a.time / MARROW.spinInterval)) {
      const ang = a.lockedAngle + dir * boss.spinCount * MARROW.spinStep;
      spawnMarrowShard(w, e, ang);
      spawnMarrowShard(w, e, ang + Math.PI);
      boss.spinCount++;
    }
    if (a.time >= MARROW.spinDuration) enterRecover(e);
    return;
  }
  // rush
  a.time += dt;
  // A connect ends the rush BEFORE the next step (the contact pass already landed the
  // hit + shove last tick, while the rush was active) — hit-and-stop, never a drag.
  if (isTouchingAnyPlayer(w, e)) { enterRecover(e); return; }
  const step = MARROW.chargeSpeed * dt;
  const x0 = e.x, y0 = e.y;
  rushSmashEnvironment(w, e, ev); // the blind bull clears its furrow FIRST — no furniture wedge
  moveEnemyBy(w, e, Math.cos(a.lockedAngle) * step, Math.sin(a.lockedAngle) * step);
  ev.push({ t: "lungeTrail", x: e.x, y: e.y });
  const moved = Math.hypot(e.x - x0, e.y - y0);
  if (moved < step * chillMoveScale(e) * 0.5) {
    marrowCrash(w, e, ev);
    return;
  }
  if (a.time >= MARROW.chargeDur) enterRecover(e);
}

// The wall crash: MARROW's authored weakness. A long self-stun ("crash" recover), and
// from P2 the impact bursts a radial shard ring — punishing, but only around the crash point.
function marrowCrash(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack;
  const boss = e.boss!;
  const shards = MARROW.crashShards[boss.phase];
  for (let i = 0; i < shards; i++) spawnMarrowShard(w, e, (i / shards) * Math.PI * 2);
  a.move = "crash";
  enterRecover(e);
  ev.push({ t: "chargeCrash", x: e.x, y: e.y });
}

function marrowVolleyFire(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack;
  const boss = e.boss!;
  const n = MARROW.volleyShards[boss.phase];
  for (let i = 0; i < n; i++) {
    spawnMarrowShard(w, e, a.lockedAngle + (i - (n - 1) / 2) * MARROW.volleySpread);
  }
  ev.push({ t: "bossVolley", x: e.x + Math.cos(a.lockedAngle) * (e.radius + 6), y: e.y + Math.sin(a.lockedAngle) * (e.radius + 6) });
}

function spawnMarrowShard(w: WorldState, e: Enemy, angle: number): void {
  const mx = e.x + Math.cos(angle) * (e.radius + 6);
  const my = e.y + Math.sin(angle) * (e.radius + 6);
  spawnEnemyBullet(w, mx, my, angle, MARROW.shardSpeed, MARROW.shardRadius, MARROW.shardDamage, "#dceef5", MARROW.shardLife);
}

function countLiveBeatAdds(w: WorldState, e: Enemy): number {
  const ids = e.boss!.beatAddIds;
  if (ids.length === 0) return 0;
  let n = 0;
  for (const other of w.enemies) {
    if (!other.dead && ids.indexOf(other.id) !== -1) n++;
  }
  return n;
}

function marrowChase(w: WorldState, e: Enemy, dt: number): void {
  if (!findTarget(w, e.x, e.y)) return;
  const angle = Math.atan2(w.targetY - e.y, w.targetX - e.x);
  const mult = e.boss && e.boss.phase >= 3 ? MARROW.p3ChaseMult : 1;
  const step = e.speed * mult * dt;
  moveEnemyBy(w, e, Math.cos(angle) * step, Math.sin(angle) * step);
}

// THE HOLLOW CHOIR (spec §5c). The grieving ghost mass — the fight is about TRACKING and
// TURNING, never cover: its wails home (juke them on a curve), and on cadence it fades
// intangible and drifts through you before rematerializing into a burst + long recover
// (the punish window). Transition beats SPLIT it into three wisps: the boss is gone until
// they die or the cap elapses — your beat DPS goes into the wisps, by design.
//   P1 (100–65%): 2-wail volleys; every 3rd attack is the fade.
//   P2 (65–30%):  3 wails; the fade now rematerializes into an 8-shard ring.
//   P3 (30–0%):   2.4s cadence, 4 wails, 10-shard rematerialize ring.
function updateChoir(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const boss = e.boss;
  if (!boss) return;
  const a = e.attack;

  if (a.phase === "windup") { choirWindup(w, e, dt, ev); return; }
  if (a.phase === "active") { choirActive(w, e, dt, ev); return; }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= (a.move === "fade" ? CHOIR.fadeRecover : CHOIR.wailRecover)) enterIdle(e);
    return;
  }

  if (a.cooldown === 0 && e.spawnTimer === 0) { choirBeginAttack(e, ev); return; }
  // Idle drift toward the target (it floats through geometry like its kin).
  if (!findTarget(w, e.x, e.y)) return;
  const angle = Math.atan2(w.targetY - e.y, w.targetX - e.x);
  moveEnemyBy(w, e, Math.cos(angle) * e.speed * dt, Math.sin(angle) * e.speed * dt);
}

function choirBeginAttack(e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  boss.attackCount++;
  e.attack.cooldown = CHOIR.attackCd[boss.phase];
  if (boss.attackCount % CHOIR.fadeEvery === 0) {
    beginWindup(e, "fade");
    ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 1.6, gain: 0.5, trauma: 0 });
    return;
  }
  beginWindup(e, "wail");
  ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.5, gain: 0.7, trauma: 0 });
}

function choirWindup(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.move === "split") {
    // The split beat: the Choir is scattered into its wisps. Reforms when they all die
    // (past the minimum readable beat) or at the hard cap; the queued overflow lands then.
    a.time += dt;
    a.windup = Math.min(1, a.time / CHOIR.splitDuration);
    const isBreakable = a.time >= CHOIR.splitMinDuration;
    if (a.time >= CHOIR.splitDuration || (isBreakable && countLiveBeatAdds(w, e) === 0)) {
      e.boss!.beatAddIds.length = 0;
      enterIdle(e);
      endBossTransition(w, e, ev);
    }
    return;
  }
  if (a.move === "fade") {
    a.time += dt;
    a.windup = Math.min(1, a.time / CHOIR.fadeWindup);
    if (a.time >= CHOIR.fadeWindup) {
      a.phase = "active"; a.time = 0; a.windup = 0;
      ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 1.8, gain: 0.5, trauma: 0 });
    }
    return;
  }
  // wail
  if (stepWindupTimer(w, e, dt, CHOIR.wailWindup, CHOIR.wailLock, false)) {
    choirWailFire(w, e, ev);
    enterRecover(e);
  }
}

function choirActive(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  // The fade: intangible, drifting through the target's position — keep moving.
  a.time += dt;
  a.windup = Math.min(1, a.time / CHOIR.fadeDuration);
  if (findTarget(w, e.x, e.y)) {
    const angle = Math.atan2(w.targetY - e.y, w.targetX - e.x);
    const step = e.speed * CHOIR.fadeSpeedMult * dt;
    moveEnemyBy(w, e, Math.cos(angle) * step, Math.sin(angle) * step);
  }
  if (a.time >= CHOIR.fadeDuration) {
    choirRematerialize(w, e, ev);
    enterRecover(e);
  }
}

// Re-forming is loud: from P2 a ring of shards blooms out of the reassembly point.
function choirRematerialize(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  const n = CHOIR.burstShards[boss.phase];
  const base = (boss.burstParity ^= 1) ? Math.PI / Math.max(1, n) : 0;
  for (let i = 0; i < n; i++) {
    spawnEnemyBullet(w, e.x, e.y, base + (i / n) * Math.PI * 2, CHOIR.burstSpeed, CHOIR.shardRadius, CHOIR.shardDamage, "#bfe9ff", CHOIR.shardLife);
  }
  if (n > 0) ev.push({ t: "radialBurst", x: e.x, y: e.y });
  ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: 0.8, gain: 0.7, trauma: 0.08 });
}

// The wail volley: slow seekers with a capped turn rate, fanned around the locked bearing.
function choirWailFire(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack;
  const boss = e.boss!;
  const n = CHOIR.wailCount[boss.phase];
  for (let i = 0; i < n; i++) {
    const off = n === 1 ? 0 : (i / (n - 1) - 0.5) * CHOIR.wailSpread;
    const ang = a.lockedAngle + off;
    w.bullets.push({
      x: e.x + Math.cos(ang) * (e.radius + 6), y: e.y + Math.sin(ang) * (e.radius + 6),
      vx: Math.cos(ang) * CHOIR.wailSpeed, vy: Math.sin(ang) * CHOIR.wailSpeed,
      radius: CHOIR.wailRadius, life: CHOIR.wailLife, friendly: false, owner: null,
      damage: CHOIR.wailDamage, color: "#9fd8ff", pierce: 0, hitList: null, isCrit: false,
      homing: CHOIR.wailTurnRate,
    });
  }
  ev.push({ t: "bossVolley", x: e.x + Math.cos(a.lockedAngle) * (e.radius + 6), y: e.y + Math.sin(a.lockedAngle) * (e.radius + 6) });
}

// THE WEAVER (spec §5d). The duelist that fights the FLOOR: its webs are persistent
// slow-zones that shrink your dance space, and its pounce is a marked drop from above —
// airborne (untargetable) for a beat, center-heavy on the landing, a fresh web at the
// crater. Phase changes ride the shared beat plumbing (a fixed 0.8s molt that bursts into
// a web-bolt ring + two broodlings).
//   P1 (100–66%): alternating weave (3 webs) / single pounce every 3.0s.
//   P2 (66–33%):  2.7s cadence; the gate's 2-hit — a chained second leap, .45s land-to-land.
//   P3 (33–0%):   2.3s cadence; 4-web weave; one REAL pounce dressed with two afterimage feints.
function updateWeaver(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const boss = e.boss;
  if (!boss) return;
  const a = e.attack;

  if (a.phase === "windup") { weaverWindup(w, e, dt, ev); return; }
  if (a.phase === "active") { weaverActive(w, e, dt, ev); return; }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= (a.move === "pounce" ? WEAVER.pounceRecover : WEAVER.weaveRecover)) enterIdle(e);
    return;
  }

  if (a.cooldown === 0 && e.spawnTimer === 0) { weaverBeginAttack(e, ev); return; }
  if (!findTarget(w, e.x, e.y)) return;
  const angle = Math.atan2(w.targetY - e.y, w.targetX - e.x);
  moveEnemyBy(w, e, Math.cos(angle) * e.speed * dt, Math.sin(angle) * e.speed * dt);
}

function weaverBeginAttack(e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  boss.attackCount++;
  boss.spinCount = 0; // pounce-chain counter for this commitment
  e.attack.cooldown = WEAVER.attackCd[boss.phase];
  const isWeave = boss.isNextRadial;
  boss.isNextRadial = !boss.isNextRadial;
  beginWindup(e, isWeave ? "weave" : "pounce");
  ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: isWeave ? 0.7 : 0.45, gain: 0.65, trauma: 0 });
}

function weaverWindup(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.move === "roar") {
    // The molt: a fixed cocoon beat that bursts into a ring of web-bolts on exit.
    a.time += dt;
    a.windup = Math.min(1, a.time / WEAVER.moltDuration);
    if (a.time >= WEAVER.moltDuration) {
      for (let i = 0; i < WEAVER.moltBoltCount; i++) {
        spawnEnemyBullet(w, e.x, e.y, (i / WEAVER.moltBoltCount) * Math.PI * 2, WEAVER.moltBoltSpeed, WEAVER.shardRadius, WEAVER.shardDamage, "#c98bff", WEAVER.shardLife);
      }
      ev.push({ t: "radialBurst", x: e.x, y: e.y });
      enterIdle(e);
      endBossTransition(w, e, ev);
    }
    return;
  }
  if (a.move === "weave") {
    if (stepWindupTimer(w, e, dt, WEAVER.weaveWindup, WEAVER.weaveLock, true)) {
      weaverPlantWebs(w, e, ev);
      enterRecover(e);
    }
    return;
  }
  // pounce: the marker tracks then locks; chained pounces re-telegraph faster.
  const isChained = e.boss!.spinCount > 0;
  const windup = isChained ? WEAVER.pounceChainWindup : WEAVER.pounceWindup;
  const lockAt = isChained ? WEAVER.pounceChainLock : WEAVER.pounceLock;
  if (stepWindupTimer(w, e, dt, windup, lockAt, true)) {
    a.phase = "active"; a.time = 0; a.windup = 0;
    ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 1.1, gain: 0.8, trauma: 0.05 });
  }
}

function weaverActive(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  // Airborne: lerp to the locked mark exactly like the King's hop, but untargetable.
  a.time += dt;
  const prev = a.windup;
  a.windup = Math.min(1, a.time / WEAVER.pounceAir);
  const rem = 1 - prev;
  if (rem > 0.0001) {
    const f = Math.min(1, (a.windup - prev) / rem);
    e.x += (a.markX - e.x) * f;
    e.y += (a.markY - e.y) * f;
  }
  if (a.time >= WEAVER.pounceAir) {
    weaverLand(w, e, ev);
    const boss = e.boss!;
    boss.spinCount++;
    // P2+: chain straight into the next leap off the landing (shorter telegraph).
    if (boss.spinCount < WEAVER.pounceChains[boss.phase] + 1 && boss.phase >= 2) {
      beginWindup(e, "pounce");
      return;
    }
    a.move = "pounce";
    enterRecover(e);
  }
}

function weaverLand(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack;
  for (const p of w.players.values()) {
    if (isProtected(p) || p.isDown || p.hp <= 0) continue;
    const d = Math.hypot(p.x - a.markX, p.y - a.markY);
    if (d < WEAVER.pounceInnerRadius) damagePlayer(w, p, WEAVER.pounceCenterDamage, ev);
    else if (d < WEAVER.pounceRadius) damagePlayer(w, p, WEAVER.pounceOuterDamage, ev);
  }
  enemySmashEnvironment(w, a.markX, a.markY, WEAVER.pounceRadius, ev);
  plantWeb(w, a.markX, a.markY, WEAVER.pounceWebRadius, ev);
  ev.push({ t: "bossSlam", x: a.markX, y: a.markY });
}

// The weave: a locked pattern — one web ON the mark, the rest ringed around it across
// the likely escape lanes.
function weaverPlantWebs(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack;
  const boss = e.boss!;
  const n = WEAVER.webCount[boss.phase];
  plantWeb(w, a.markX, a.markY, WEAVER.webRadius, ev);
  for (let i = 1; i < n; i++) {
    const ang = a.lockedAngle + ((i - 1) / Math.max(1, n - 1)) * Math.PI * 2;
    plantWeb(w, a.markX + Math.cos(ang) * WEAVER.webRingDist, a.markY + Math.sin(ang) * WEAVER.webRingDist, WEAVER.webRadius, ev);
  }
}

function plantWeb(w: WorldState, x: number, y: number, radius: number, ev: SimEvent[]): void {
  if (w.hazards.length >= WEAVER.maxWebs) return; // hard cap: squeeze, never fill
  if (isWall(w, x, y)) return;
  w.hazards.push({ id: w.nextHazardId++, kind: "web", x, y, radius, life: WEAVER.webLife, maxLife: WEAVER.webLife });
  ev.push({ t: "webPlaced", x, y, r: radius });
}

// THE GILDED WARDEN (spec §5e). The armored tempo boss: the plate chips damage to 30%
// at all times EXCEPT the exposed recover after each committed quake/sweep (see
// isGildedExposed in the damage funnel) — you dodge the commitment, then unload.
//   P1 (100–70%): alternating anvil slam / gold sweep every 3.6s.
//   P2 (70–35%):  3.2s cadence (sanctify beats at 70%/35%, King-style fixed roars).
//   P3 (35–0%):   2.8s cadence; the sweep releases a second offset wave.
function updateGilded(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const boss = e.boss;
  if (!boss) return;
  const a = e.attack;

  if (a.phase === "windup") { gildedWindup(w, e, dt, ev); return; }
  if (a.phase === "active") { gildedActive(w, e, dt, ev); return; }
  if (a.phase === "recover") {
    a.time += dt;
    if (a.time >= (a.move === "slam" ? GILDED.slamRecover : GILDED.sweepRecover)) enterIdle(e);
    return;
  }

  if (a.cooldown === 0 && e.spawnTimer === 0) { gildedBeginAttack(e, ev); return; }
  // A stately advance — the Warden walks, it never chases.
  if (!findTarget(w, e.x, e.y)) return;
  const angle = Math.atan2(w.targetY - e.y, w.targetX - e.x);
  moveEnemyBy(w, e, Math.cos(angle) * e.speed * dt, Math.sin(angle) * e.speed * dt);
}

function gildedBeginAttack(e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  boss.attackCount++;
  boss.spinCount = 0; // sweep-wave counter
  e.attack.cooldown = GILDED.attackCd[boss.phase];
  const isSlam = !boss.isNextRadial;
  boss.isNextRadial = !boss.isNextRadial;
  beginWindup(e, isSlam ? "slam" : "sweep");
  ev.push({ t: "cue", name: "enemyHit", x: e.x, y: e.y, rate: isSlam ? 0.35 : 0.55, gain: 0.75, trauma: 0 });
}

function gildedWindup(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  if (a.move === "roar") {
    // Sanctify: the King's fixed transition-roar semantics in gold.
    a.time += dt;
    a.windup = Math.min(1, a.time / GILDED.sanctifyDuration);
    if (a.time >= GILDED.sanctifyDuration) {
      enterIdle(e);
      endBossTransition(w, e, ev);
    }
    return;
  }
  if (a.move === "slam") {
    // The quake is centered on the Warden itself — the mark is its own feet.
    a.time += dt;
    a.windup = Math.min(1, a.time / GILDED.slamWindup);
    a.markX = e.x; a.markY = e.y;
    if (!a.isAimLocked) {
      if (findTarget(w, e.x, e.y)) a.lockedAngle = Math.atan2(w.targetY - e.y, w.targetX - e.x);
      if (a.time >= GILDED.slamLock) a.isAimLocked = true;
    }
    if (a.time >= GILDED.slamWindup) {
      a.phase = "active"; a.time = 0; a.windup = 0;
      ev.push({ t: "cue", name: "dash", x: e.x, y: e.y, rate: 0.5, gain: 0.9, trauma: 0.05 });
    }
    return;
  }
  // sweep
  a.time += dt;
  a.windup = Math.min(1, a.time / GILDED.sweepWindup);
  if (a.time >= GILDED.sweepWindup) {
    a.phase = "active"; a.time = 0; a.windup = 0;
    gildedSweepWave(w, e, ev);
  }
}

function gildedActive(w: WorldState, e: Enemy, dt: number, ev: SimEvent[]): void {
  const a = e.attack;
  a.time += dt;
  if (a.move === "slam") {
    if (a.time >= GILDED.slamActive) {
      gildedSlamResolve(w, e, ev);
      enterRecover(e); // the plate hangs open — EXPOSED
    }
    return;
  }
  // sweep: wave one fired at release; P3's offset second wave follows after the gap.
  // spinCount counts the EXTRA waves already released this commitment.
  const boss = e.boss!;
  const extraWaves = GILDED.sweepWaves[boss.phase] - 1;
  if (boss.spinCount < extraWaves && a.time >= (boss.spinCount + 1) * GILDED.sweepWaveGap) {
    gildedSweepWave(w, e, ev);
    boss.spinCount++;
  }
  if (a.time >= extraWaves * GILDED.sweepWaveGap + 0.2) enterRecover(e); // EXPOSED
}

function gildedSlamResolve(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const a = e.attack;
  for (const p of w.players.values()) {
    if (isProtected(p) || p.isDown || p.hp <= 0) continue;
    const d = Math.hypot(p.x - a.markX, p.y - a.markY);
    if (d < GILDED.slamInnerRadius) damagePlayer(w, p, GILDED.slamCenterDamage, ev);
    else if (d < GILDED.slamRadius) damagePlayer(w, p, GILDED.slamOuterDamage, ev);
  }
  // The aftershock: a tight line of shards down the locked bearing.
  for (let i = 0; i < GILDED.slamLineShards; i++) {
    const off = (i - (GILDED.slamLineShards - 1) / 2) * GILDED.slamLineGap;
    spawnEnemyBullet(w, a.markX, a.markY, a.lockedAngle + off, GILDED.slamLineSpeed, GILDED.shardRadius, GILDED.shardDamage, "#ffd166", GILDED.shardLife);
  }
  enemySmashEnvironment(w, a.markX, a.markY, GILDED.slamRadius, ev);
  ev.push({ t: "bossSlam", x: a.markX, y: a.markY });
}

function gildedSweepWave(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  const boss = e.boss!;
  const base = (boss.burstParity ^= 1) ? Math.PI / GILDED.sweepCount : 0;
  for (let i = 0; i < GILDED.sweepCount; i++) {
    spawnEnemyBullet(w, e.x, e.y, base + (i / GILDED.sweepCount) * Math.PI * 2, GILDED.sweepSpeed, GILDED.shardRadius, GILDED.shardDamage, "#ffd166", GILDED.shardLife);
  }
  ev.push({ t: "radialBurst", x: e.x, y: e.y });
}

// ---- shared attack helpers ----

function findTarget(w: WorldState, x: number, y: number): boolean {
  let bestD = Infinity, found = false;
  for (const p of w.players.values()) {
    if (p.isDown || p.isAbsent || p.hp <= 0) continue;
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

function refreshNav(w: WorldState, dt: number): void {
  w.flowCd -= dt;
  const d = w.dungeon;
  // Retarget trigger keys off a combined hash of EVERY living source tile (players + legacy
  // remote targets), so ANY player crossing a tile refreshes multi-source paths — not only
  // the primary. The chase fields themselves rebuild LAZILY per clearance class (see
  // nav.ts) — this only records the target tiles and invalidates; obstacle-revision
  // invalidation (a prop broke) rides the same lazy path inside the field queries.
  let keyHash = 0;
  let anyUp = false;
  for (const pl of w.players.values()) {
    if (pl.isDown || pl.isAbsent || pl.hp <= 0) continue;
    anyUp = true;
    keyHash = (Math.imul(keyHash, 31) + Math.floor(pl.y / TILE) * d.w + Math.floor(pl.x / TILE)) | 0;
  }
  for (const r of w.remoteTargets) {
    if (r.isDown) continue;
    anyUp = true;
    keyHash = (Math.imul(keyHash, 31) + Math.floor(r.y / TILE) * d.w + Math.floor(r.x / TILE)) | 0;
  }
  const tileChanged = anyUp && keyHash !== w.flowKey;
  if (w.flowCd > 0 && !tileChanged) return;
  w.flowCd = C.FLOW_REBUILD;
  w.flowKey = keyHash;

  const srcs = w.flowSources;
  srcs.length = 0;
  for (const pl of w.players.values()) {
    if (pl.isDown || pl.isAbsent || pl.hp <= 0) continue;
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
  markNavTargets(w.nav, srcs);
}

// Does any live prop's collision ring cut the straight corridor from (x0,y0) to (x1,y1)
// for a body of radius `r`? The full radius sum keeps the same conservative margin the
// local steering uses, so "corridor clear" always means "actually walkable".
function propOnSegment(w: WorldState, x0: number, y0: number, x1: number, y1: number, r: number): boolean {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return false;
  const ux = dx / len, uy = dy / len;
  for (const p of w.props) {
    if (p.dead) continue;
    const rr = r + p.radius;
    const t = Math.max(0, Math.min(len, (p.x - x0) * ux + (p.y - y0) * uy));
    const cx = x0 + ux * t - p.x, cy = y0 + uy * t - p.y;
    if (cx * cx + cy * cy < rr * rr) return true;
  }
  return false;
}

// The chase heading: direct when the straight corridor is genuinely walkable (wall LOS
// AND no prop ring across it), otherwise the next waypoint of the prop-aware flow route
// for this body's clearance class. Close range always commits to the direct line — the
// finishing layer (avoidPropAhead + the stuck net in applyChaseStep) rounds a final
// single prop far better than tile-resolution routing, and contact must never stall on
// grid quantization. The route is what fixes the live wedge: rows, corners and concave
// pockets are simply not part of the field, so steering can no longer be lured into them.
function chaseAngle(w: WorldState, e: Enemy): number {
  const direct = Math.atan2(w.targetY - e.y, w.targetX - e.x);
  if (hasLineOfSight(w, e.x, e.y, w.targetX, w.targetY)) {
    const dx = w.targetX - e.x, dy = w.targetY - e.y;
    if (dx * dx + dy * dy <= C.NAV_DIRECT_RANGE * C.NAV_DIRECT_RANGE) return direct;
    if (!propOnSegment(w, e.x, e.y, w.targetX, w.targetY, e.radius)) return direct;
  }
  const field = chaseFieldFor(w, e.radius);
  if (navStepPoint(field, e.x, e.y)) return Math.atan2(navPoint.y - e.y, navPoint.x - e.x);
  return direct;
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

// ---- enemy -> environment destruction ----

// The authoritative environment-damage path for enemy commitments (charges, slams,
// pounces, eruptions — every caller is a fully telegraphed move, so the wreckage is
// as dodge-readable as the hit itself). Props splinter through the ordinary destroyProp
// pipeline WITHOUT an owner: chained explosive barrels hurt everything but their kills
// credit NO player (the departed-actor ownership contract), and crate/pot spills stay
// ordinary first-come world loot. Wood chests burst open and eject their contents away
// from the impact onto standable floor.
function enemySmashEnvironment(w: WorldState, x: number, y: number, radius: number, ev: SimEvent[]): void {
  for (const p of w.props) {
    if (p.breakT !== undefined || p.kind === "brazier") continue;
    if (Math.hypot(p.x - x, p.y - y) <= radius + p.radius) destroyProp(w, p, ev);
  }
  for (const c of w.chests) {
    if (c.opened || c.kind !== "wood") continue;
    if (Math.hypot(c.x - x, c.y - y) <= radius + c.radius) smashOpenChest(w, c, x, y, ev);
  }
}

// A rusher plows THROUGH the furniture: splinter everything at the body's leading edge,
// BEFORE the move resolves (called per active-rush tick — the lane telegraph already drew
// exactly this corridor). The pad must clear moveCircle's prop-collision ring
// (prop radius × 0.8 ≈ 12px), or the rush would wedge against the crate it was about to
// smash and read the stall as a wall crash.
const RUSH_SMASH_PAD = 16;
function rushSmashEnvironment(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  enemySmashEnvironment(w, e.x, e.y, e.radius + RUSH_SMASH_PAD, ev);
}

// ---- the F10 Miniboss Gauntlet (corrected gate §3, exact formula) ----
// A stage machine, not a boss: once the floor's living pressure, its summons AND its
// hazards are all cleared, the authored 5s intermission passes and the next CAPTAIN
// enters the arena — the Charger commander with simple adds, the Shielder elite with
// ranged adds, then the brute Burrower alone — strictly sequential, never simultaneous.
// Captains carry round10(.28/.32/.40 × calibrated Marrow HP), party-scaled independently
// at each spawn, and run two phases split at 50% with one 0.8s non-invulnerable
// transition (no floor, no overflow — see the captain check in updateEnemies). +1 heart
// drops only after round 2; the full clear drops the premium boss chest (P+1 weapon
// choices led by the gauntlet's signature + the rare blessing offer).

function updateGauntlet(w: WorldState, dt: number, ev: SimEvent[]): void {
  const g = w.gauntlet;
  if (!g || w.isRunOver || g.isRewarded) return;
  if (w.enemies.some((e) => !e.dead) || w.pendingSpawns.length > 0 || w.hazards.length > 0) {
    // The intermission runs only after R1/R2 (the first captain enters as soon as the
    // approach is down; the reward follows the final kill on the same beat).
    g.breath = g.stage > 0 && g.stage < GAUNTLET.rounds.length ? GAUNTLET.intermission : 0;
    return;
  }
  g.breath -= dt;
  if (g.breath > 0) return;
  if (g.stage < GAUNTLET.rounds.length) {
    spawnGauntletRound(w, GAUNTLET.rounds[g.stage], ev);
    g.stage++;
    // The gate's +1 heart lands only after round 2 clears — i.e. alongside R3's entrance.
    if (g.stage - 1 === GAUNTLET.heartAfterRound) {
      const arena = w.dungeon.rooms[w.dungeon.rooms.length - 1];
      w.pickups.push(makePickup(w, "heart", (arena.cx + 0.5) * TILE + 40, (arena.cy + 0.5) * TILE, ev));
    }
    return;
  }
  // Sequence complete: the premium reward stands where the last captain fell.
  g.isRewarded = true;
  const arena = w.dungeon.rooms[w.dungeon.rooms.length - 1];
  w.chests.push({
    id: w.nextChestId++, kind: "boss",
    x: (arena.cx + 0.5) * TILE, y: (arena.cy + 0.5) * TILE,
    radius: 18, opened: false, weapon: GAUNTLET.chestWeapon,
  });
  ev.push({ t: "cue", name: "bossSpawn", x: (arena.cx + 0.5) * TILE, y: (arena.cy + 0.5) * TILE, rate: 1.3, gain: 0.8, trauma: 0.1 });
}

function spawnGauntletRound(w: WorldState, round: (typeof GAUNTLET.rounds)[number], ev: SimEvent[]): void {
  const arena = w.dungeon.rooms[w.dungeon.rooms.length - 1];
  const cx = (arena.cx + 0.5) * TILE, cy = (arena.cy + 0.5) * TILE;
  const spawnAt = (kind: Enemy["kind"], tier: Enemy["tier"], x: number, y: number, isSummoned: boolean): Enemy | null => {
    if (!settleSpawnPoint(w, x, y, ENEMY_ARCHETYPES[kind].radius)) return null;
    const e = createEnemy(kind, settlePoint.x, settlePoint.y, w.floor, w.rng, w.nextEnemyId++, {
      tier, isSummoned, players: w.encounterPlayers,
    });
    w.enemies.push(e);
    ev.push({ t: "enemySpawn", eid: e.id, kind: e.kind, tier: e.tier, x: e.x, y: e.y });
    return e;
  };
  const captain = spawnAt(round.kind, round.tier, cx, cy, false);
  if (captain) {
    // Gate formula: round10(hpFrac × calibrated Marrow HP), party-scaled at THIS spawn.
    const hp = Math.round((gauntletCaptainHp(round) * coopBossHpMult(w.encounterPlayers)) / 10) * 10;
    captain.hp = captain.maxHp = hp;
    captain.captainPhase = 1;
    ev.push({ t: "cue", name: "bossSpawn", x: captain.x, y: captain.y, rate: 0.8, gain: 0.9, trauma: 0.15 });
  }
  for (let i = 0; i < round.addCount; i++) {
    const ang = (i / round.addCount) * Math.PI * 2;
    spawnAt(round.addKind ?? "slime", round.addTier, cx + Math.cos(ang) * 70, cy + Math.sin(ang) * 70, true);
  }
}

// The captain's two-phase contract: crossing 50% triggers ONE 0.8s stagger — the current
// windup drops and the next commitment waits — with no invulnerability, no damage
// reduction, and no HP floor (a big hit may carry straight through the threshold).
function tickCaptainPhase(w: WorldState, e: Enemy, ev: SimEvent[]): void {
  if (e.captainPhase !== 1 || e.dead || e.hp > e.maxHp * GAUNTLET.captainPhaseAt) return;
  e.captainPhase = 2;
  if (e.attack.phase === "windup") enterIdle(e);
  e.spawnTimer = Math.max(e.spawnTimer, GAUNTLET.captainTransition);
  e.attack.cooldown = Math.max(e.attack.cooldown, GAUNTLET.captainTransition);
  // The miniboss templates mirror the phase onto the aux channel (the client's marshal
  // shield render keys off it; captainPhase itself never travels the wire).
  if (isMinibossKind(e.kind)) e.aux = 2;
  // Per-template phase beat: the Root Marshal's shield shatters into destructible cover.
  if (e.kind === "marshal") marshalShatterShield(w, e, ev);
  ev.push({ t: "bossPhase", eid: e.id, x: e.x, y: e.y });
  ev.push({ t: "cue", name: "bossSpawn", x: e.x, y: e.y, rate: 1.1, gain: 0.7, trauma: 0.08 });
}

// ---- dynamic hazards (webs / cinders / volatile charges) ----

function webSlowMult(w: WorldState, x: number, y: number): number {
  for (const h of w.hazards) {
    if (h.kind !== "web") continue;
    if (Math.hypot(x - h.x, y - h.y) < h.radius) return WEAVER.webSlow;
  }
  return 1;
}

function updateHazards(w: WorldState, dt: number, ev: SimEvent[]): void {
  if (w.hazards.length === 0) return;
  for (const h of w.hazards) {
    h.life -= dt;
    // A volatile charge detonates the instant its fuse runs out — the delayed shared burst.
    if (h.kind === "charge" && h.life <= 0) detonateCharge(w, h, ev);
    // Cinders burn any player standing in them; post-hit protection self-limits the ticks.
    if (h.kind === "cinder") cinderBurn(w, h, ev);
  }
  w.hazards = w.hazards.filter((h) => h.life > 0);
}

function cinderBurn(w: WorldState, h: Hazard, ev: SimEvent[]): void {
  for (const p of w.players.values()) {
    if (isProtected(p) || p.isDown || p.isAbsent || p.hp <= 0 || w.pendingBlessings.has(p.id)) continue;
    if (Math.hypot(p.x - h.x, p.y - h.y) < h.radius) damagePlayer(w, p, 1, ev);
  }
}

// The volatile elite's fused charge: a SHARED-risk burst — players take 1 (their
// protection rules apply), enemies take more, cover splinters. Ownerless by design
// (nobody's kill credit): the corpse's spite, not anyone's weapon.
function detonateCharge(w: WorldState, h: Hazard, ev: SimEvent[]): void {
  ev.push({ t: "explosion", x: h.x, y: h.y, r: h.radius });
  for (const p of w.players.values()) {
    if (isProtected(p) || p.isDown || p.isAbsent || p.hp <= 0) continue;
    if (Math.hypot(p.x - h.x, p.y - h.y) <= h.radius) damagePlayer(w, p, ELITE_VOLATILE.playerDamage, ev);
  }
  for (const other of w.enemies) {
    if (other.dead || isUntargetable(other)) continue;
    if (Math.hypot(other.x - h.x, other.y - h.y) > h.radius + other.radius) continue;
    damageEnemy(w, null, other, ELITE_VOLATILE.enemyDamage, ev);
    ev.push({ t: "puff", x: other.x, y: other.y, n: 4, color: ENEMY_ARCHETYPES[other.kind].tint });
    if (other.hp <= 0 && !other.dead) killEnemy(w, null, other, ev);
  }
  enemySmashEnvironment(w, h.x, h.y, h.radius, ev);
}

// ---- the mob overlap arbiter (studio gate §2) ----
// "No two damage releases within 0.30s covering the same escape lane": before a REGULAR
// mob's committed windup may flip into its damage release, its release area must be clear
// of every release from the last 0.30s. Blocked commitments HOLD at full windup (telegraph
// stays up, no damage) and re-check each tick — the stagger is at most the window itself.
// Bosses are exempt: boss floors are authored end-to-end by their own §3 contracts.

const RELEASE_ARBITER_WINDOW = 0.30;
const RELEASE_LANE_CLEARANCE = 36; // a player body's diameter — the escape lane itself

function tickReleaseArbiter(w: WorldState, dt: number): void {
  if (w.recentReleases.length === 0) return;
  for (const r of w.recentReleases) r.t -= dt;
  w.recentReleases = w.recentReleases.filter((r) => r.t > 0);
}

function tryRelease(w: WorldState, x: number, y: number, radius: number): boolean {
  for (const r of w.recentReleases) {
    if (Math.hypot(x - r.x, y - r.y) < radius + r.radius + RELEASE_LANE_CLEARANCE) return false;
  }
  w.recentReleases.push({ x, y, radius, t: RELEASE_ARBITER_WINDOW });
  return true;
}

// The release area of a straight commitment (lunge/rush/bash): the swept lane,
// approximated as a circle over its middle.
function tryReleaseLane(w: WorldState, e: Enemy, angle: number, reach: number): boolean {
  const half = reach / 2;
  return tryRelease(w, e.x + Math.cos(angle) * half, e.y + Math.sin(angle) * half, half + e.radius);
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
      if (b.life <= 0) continue;
      if (!sweptBulletHit(b, p.x, p.y, b.radius + p.radius)) continue;
      if (!b.friendly) {
        // Standing props are COVER: enemy fire is stopped by them — and spends them.
        // Ducking behind a crate against a spitter volley is a real play, with a real
        // cost. An enemy-detonated explosive barrel credits no one (destroyProp rules).
        p.hp -= b.damage;
        ev.push({ t: "propHit", propId: p.id, kind: p.kind, x: sweptHit.x, y: sweptHit.y });
        b.life = 0;
        if (p.hp <= 0) { destroyProp(w, p, ev); break; }
        continue;
      }
      p.hp -= b.damage;
      ev.push({ t: "propHit", propId: p.id, kind: p.kind, x: sweptHit.x, y: sweptHit.y });
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
  // The blocking set changed: invalidate every navigation cache so routes flow through
  // the fresh gap on their next rebuild. Any future system that destroys cover (charges,
  // slams, environmental chains) goes through this same door and inherits the bump.
  w.obstacleRev++;
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
    if (e.dead || isUntargetable(e)) continue;
    if (Math.hypot(e.x - source.x, e.y - source.y) > r + e.radius) continue;
    damageEnemy(w, p ? p.id : null, e, C.BARREL_EXPLOSION_DAMAGE, ev);
    ev.push({ t: "flash", eid: e.id });
    ev.push({ t: "puff", x: e.x, y: e.y, n: 6, color: ENEMY_ARCHETYPES[e.kind].tint });
    applyBurn(e, C.BARREL_BURN_SECS, p ? p.id : null);
    if (e.hp <= 0 && !e.dead) killEnemy(w, p, e, ev);
  }
  for (const victim of w.players.values()) {
    if (!isProtected(victim) && !victim.isDown && !victim.isAbsent && victim.hp > 0
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
        if (!sweptBulletHit(b, c.x, c.y, b.radius + c.radius)) continue;
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
      if (!p.isDown && !p.isAbsent && p.hp > 0 && Math.hypot(p.x - c.x, p.y - c.y) < p.pr + c.radius) {
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
  // The full loot of the opening is decided first, then placed as ONE batch, so the fan
  // spreads coins, hearts and weapons together without stacking. Boss completion recovery
  // is the chest's +1 heart ONLY (no descent heal) plus the boss's authored SIGNATURE
  // weapon (see BOSS_SIGNATURE_WEAPON, baked at drop); its blessing offer is the floor's
  // reward — a Rare pick (see raiseBlessingOffer). Wood chests eject baked contents first
  // (the floor's weapon drop lives in this chest — see stockWeaponChests), then the
  // ordinary roll: the weapon replaces nothing, so the heart economy and pity behave
  // exactly as they always did per chest opened.
  const loot: ChestLoot[] = [];
  if (c.kind === "boss") {
    // Studio gate §4 boss weapon reward: P+1 DISTINCT personal choices (capped 5) — the
    // boss's authored signature weapon plus seeded distinct alternatives. Every player
    // claims exactly one (see updatePickups); a claim never removes a teammate's options.
    // (Only signature-bearing chests — every real boss drop — carry the choice set.)
    if (c.weapon !== undefined) {
      const choices: WeaponId[] = [c.weapon];
      while (choices.length < bossWeaponChoices(w.encounterPlayers)) {
        choices.push(rollDistinctWeapon(w.rng, choices));
      }
      for (const weapon of choices) loot.push({ kind: "weapon", weapon, isBossChoice: true });
    }
    loot.push({ kind: "heart" });
    for (let i = 0; i < 5; i++) loot.push({ kind: "coin" });
  } else {
    if (c.weapon !== undefined) loot.push({ kind: "weapon", weapon: c.weapon });
    loot.push(...rollWoodChest(w));
  }
  ejectChestLoot(w, c, loot, openerAngle(p, c), p.pr, ev);
  // The boss chest is the floor's reward for the WHOLE party: every member gets (and must
  // answer) their own Rare pick — never only whoever touched the chest first. Solo has one
  // player, so exactly one offer is raised, as before. (Absent bodies are skipped — their
  // pick can't be shown; the coherence system carries them to the next floor instead.)
  if (c.kind === "boss") {
    for (const member of w.players.values()) {
      if (!member.isAbsent) raiseBlessingOffer(w, member.id, true, ev);
    }
  }
}

// An enemy commitment bursts a wood chest open: the same deterministic contents, spilled
// through the same safe-spot fan but AWAY from the impact, with NO opener — everything it
// drops is ordinary first-come world loot, and no blessing machinery is touched (wood
// chests never carried one). Boss chests are the cleared floor's pedestal and are never
// smashable (see enemySmashEnvironment).
function smashOpenChest(w: WorldState, c: Chest, fromX: number, fromY: number, ev: SimEvent[]): void {
  c.opened = true;
  c.openT = 0;
  ev.push({ t: "chestOpen", kind: c.kind, x: c.x, y: c.y });
  const loot: ChestLoot[] = [];
  if (c.weapon !== undefined) loot.push({ kind: "weapon", weapon: c.weapon });
  loot.push(...rollWoodChest(w));
  const away = Math.atan2(c.y - fromY, c.x - fromX);
  ejectChestLoot(w, c, loot, away, 18, ev);
}

// The eject bearing for a player-opened chest: out toward the opener.
function openerAngle(p: PlayerSim, c: Chest): number {
  const dx = p.x - c.x, dy = p.y - c.y;
  return Math.hypot(dx, dy) > 1 ? Math.atan2(dy, dx) : C.HALF_PI;
}

type ChestLoot =
  | { kind: "coin" | "heart" }
  | { kind: "weapon"; weapon: WeaponId; isBossChoice?: boolean };

// Every drop a chest produces lands somewhere the collector can actually STAND — the old
// loose offsets (coins in a row, heart under the chest) could put loot inside a wall or
// a prop ring where the collect range never triggered: the unreachable coins of the
// playtest. Slots fan out from `base` (toward the opener, or away from whatever smashed
// the chest) so the batch reads as spilled loot. `pr` is the collector's clearance —
// the opener's own radius, or the standard 18px body for ownerless bursts.
function ejectChestLoot(w: WorldState, c: Chest, loot: ChestLoot[], base: number, pr: number, ev: SimEvent[]): void {
  const placed: { x: number; y: number }[] = [];
  for (let slot = 0; slot < loot.length; slot++) {
    const item = loot[slot];
    const [x, y] = chestLootSpot(w, c, base, slot, pr, placed);
    placed.push({ x, y });
    if (item.kind === "weapon") {
      w.pickups.push({ id: w.nextPickupId++, kind: "weapon", x, y, radius: 16, weapon: item.weapon, isBossChoice: item.isBossChoice });
      ev.push({ t: "lootDrop", x, y, color: "#ffb43b" });
    } else {
      w.pickups.push(makePickup(w, item.kind, x, y, ev));
    }
  }
}

function chestLootSpot(w: WorldState, c: Chest, base: number, slot: number, pr: number, placed: { x: number; y: number }[]): [number, number] {
  // Deterministic candidate scan for one drop. Each slot prefers its own direction in the
  // fan (slot i starts at angle i), then walks the fixed angle order and the radii
  // inner-to-outer, so the preferred point loses only to the NEAREST safe candidate. The
  // first pass demands spacing from already-placed drops; the second gives that up rather
  // than land anywhere unsafe. A candidate must also have a walkable straight path from
  // the chest — a spot past a wall or a prop ring would be visible yet uncollectible.
  const angles = C.CHEST_EJECT_ANGLES;
  for (const sep of [C.CHEST_LOOT_SEPARATION, 0]) {
    for (const radius of C.CHEST_EJECT_RADII) {
      for (let k = 0; k < angles.length; k++) {
        const a = base + angles[(slot + k) % angles.length];
        const x = c.x + Math.cos(a) * radius;
        const y = c.y + Math.sin(a) * radius;
        if (!isStandableSpot(w, x, y, pr)) continue;
        if (!isPathOpen(w, c.x, c.y, x, y, pr)) continue;
        if (sep > 0 && placed.some((q) => Math.hypot(x - q.x, y - q.y) < sep)) continue;
        return [x, y];
      }
    }
  }
  // Everything around is blocked (a chest boxed in by props/walls): fall back to the
  // source chest's own rim — outside its sprite, ignoring only ITS hide-exclusion — and
  // finally to the chest's own tile, which is open floor by construction (see chestTile)
  // and right under the opener, who collects the drop the same tick.
  for (let k = 0; k < angles.length; k++) {
    const a = base + angles[(slot + k) % angles.length];
    const x = c.x + Math.cos(a) * C.CHEST_EJECT_RIM;
    const y = c.y + Math.sin(a) * C.CHEST_EJECT_RIM;
    if (isStandableSpot(w, x, y, pr, c)) return [x, y];
  }
  return [c.x, c.y];
}

function isStandableSpot(w: WorldState, x: number, y: number, pr: number, ignoreChest?: Chest): boolean {
  // Whether a player of radius `pr` can physically stand at (x, y) — open floor with a
  // margin on all sides (so a loot sprite never clips into a wall) and outside every live
  // prop's collision ring. Chests don't block movement but a drop under one would hide
  // the sprite, so they're excluded too; `ignoreChest` lifts that for the already-opened
  // source chest on the rim fallback.
  const m = C.CHEST_LOOT_WALL_MARGIN;
  if (isWall(w, x, y) || isWall(w, x - m, y) || isWall(w, x + m, y) || isWall(w, x, y - m) || isWall(w, x, y + m)) return false;
  if (blockedByProp(w, x, y, pr)) return false;
  for (const c of w.chests) {
    if (c === ignoreChest) continue;
    if (Math.hypot(x - c.x, y - c.y) < c.radius + 16) return false;
  }
  return true;
}

function isPathOpen(w: WorldState, x0: number, y0: number, x1: number, y1: number, pr: number): boolean {
  // Can a player walk the straight segment from (x0,y0) to (x1,y1)? Sampled finely enough
  // that no wall tile or prop ring fits between consecutive samples at these distances.
  const d = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.ceil(d / 8);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    if (isWall(w, x, y) || blockedByProp(w, x, y, pr)) return false;
  }
  return true;
}

function rollWoodChest(w: WorldState): ChestLoot[] {
  // Wood chest table (§2/§6): heart 15%, weapon 7%, otherwise coins. Blessings no longer
  // drop from random chests — the reward cadence lives on descents and the boss chest.
  // The recovery pity, once armed, forces the heart. Decides WHAT drops only; placement
  // happens in ejectChestLoot, so the RNG stream stays exactly as it always was.
  if (w.isPityHeartArmed) {
    w.isPityHeartArmed = false;
    w.pityStreak = 0;
    return [{ kind: "heart" }];
  }
  const r = w.rng.next();
  const heartChance = SUSTAIN.woodChestHeart * coopHeartRateMult(w.encounterPlayers);
  if (r < heartChance) return [{ kind: "heart" }];
  // The ambient weapon window is IDENTICAL solo/co-op (gate §4: party quantity increases
  // options through the §4 counts only — never through drop rates).
  if (r < heartChance + SUSTAIN.woodChestWeapon) {
    return [{ kind: "weapon", weapon: PICKUP_WEAPONS[Math.floor(w.rng.next() * PICKUP_WEAPONS.length)] }];
  }
  const n = 3 + Math.floor(w.rng.next() * 4);
  const coins: ChestLoot[] = [];
  for (let i = 0; i < n; i++) coins.push({ kind: "coin" });
  return coins;
}

function updatePickups(w: WorldState, dt: number, ev: SimEvent[]): void {
  const remaining: Pickup[] = [];
  for (const p of w.pickups) {
    let collected = false;
    for (const player of w.players.values()) {
      if (player.isAbsent) continue; // a reserved body neither magnets nor collects loot
      if (player.mods.coinMagnet > 0 && p.kind === "coin" && !player.isDown) {
        const dx = player.x - p.x, dy = player.y - p.y;
        const d = Math.hypot(dx, dy);
        if (d > 0.5 && d < player.mods.coinMagnet) {
          // Each magnet step resolves per-axis against walls (like moveCircle) so a coin
          // slides along a wall toward its owner but can never be dragged THROUGH one
          // into a tile the player can't reach.
          const pull = Math.min(d, player.mods.coinMagnetPull * dt);
          const sx = (dx / d) * pull, sy = (dy / d) * pull;
          if (!isWall(w, p.x + sx, p.y)) p.x += sx;
          if (!isWall(w, p.x, p.y + sy)) p.y += sy;
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
        if (p.kind === "dealer_weapon") {
          // Gate §4: purchases are PERSONAL and never deplete the stock — an owner (or a
          // broke player) walks past; a buyer pays and the pedestal stays for teammates.
          if (p.weapon && !player.ownedWeapons.includes(p.weapon) && player.coins >= (p.value ?? 0)) {
            player.coins -= p.value ?? 0;
            acquireWeapon(player, p.weapon);
            ev.push({ t: "pickup", pid: player.id, kind: "weapon", x: p.x, y: p.y });
          }
          continue;
        }
        if (p.kind === "weapon" && p.weapon) {
          if (p.isBossChoice) {
            // Gate §4 boss reward: one personal CLAIM per player per boss chest. Claiming a
            // weapon the player already owns grants one seeded REROLL (never coins/raw
            // damage); the pedestal itself persists for teammates either way.
            if (player.hasClaimedBossChoice) continue;
            player.hasClaimedBossChoice = true;
            const grant = player.ownedWeapons.includes(p.weapon)
              ? rollDistinctWeapon(w.rng, player.ownedWeapons)
              : p.weapon;
            acquireWeapon(player, grant);
            ev.push({ t: "pickup", pid: player.id, kind: "weapon", x: p.x, y: p.y });
            continue;
          }
          if (!player.ownedWeapons.includes(p.weapon)) {
            acquireWeapon(player, p.weapon);
            ev.push({ t: "pickup", pid: player.id, kind: "weapon", x: p.x, y: p.y });
            collected = true; break;
          }
        }
      }
    }
    if (!collected) remaining.push(p);
  }
  w.pickups = remaining;
  // Boss-choice pedestals clear only once every living player has claimed — until then a
  // claim leaves every remaining option standing for the others.
  if (w.pickups.some((p) => p.isBossChoice)) {
    let allClaimed = true;
    for (const player of w.players.values()) {
      if (!player.isDown && player.hp > 0 && !player.hasClaimedBossChoice) { allClaimed = false; break; }
    }
    if (allClaimed) w.pickups = w.pickups.filter((p) => !p.isBossChoice);
  }
}

// Environmental hazards (depth escalation): advance the shared pulse clock, drag players
// caught by an active void rift toward its core, and land floor damage on any standing
// player over an active hazard tile. Fairness contract: every pulse hazard has already
// telegraphed (cycle math in hazards.ts), pools are permanently visible, damage is always
// 1, and both the dash iframe and post-hit protection gate it — the exact protection
// rules enemy contact obeys. Hazards never touch enemies: bodies are the encounter
// designer's pressure, the floor is the player's problem.
function updateFloorHazards(w: WorldState, dt: number, ev: SimEvent[]): void {
  w.floorHazardClock += dt;
  if (w.floorHazards.length === 0) return;
  for (const p of w.players.values()) {
    // A blessing-picking player is fully paused AND shielded (see stepPlayerPhase /
    // damagePlayer); the rift drag must respect the same freeze — nothing may move a
    // player who cannot answer.
    if (p.isDown || p.hp <= 0 || w.pendingBlessings.has(p.id)) continue;
    // Rift drag: escapable pressure (85px/s against a 200px/s walk), through the normal
    // wall-aware move so it can never push a player into geometry, and line-of-sight
    // gated so a rift never pulls through a wall.
    for (const h of w.floorHazards) {
      if (h.kind !== "void_rift" || floorHazardPhaseAt(h, w.floorHazardClock) !== "active") continue;
      const cx = (h.tx + 0.5) * TILE, cy = (h.ty + 0.5) * TILE;
      const dx = cx - p.x, dy = cy - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1 || dist > RIFT_PULL_RADIUS) continue;
      if (!hasLineOfSight(w, p.x, p.y, cx, cy)) continue;
      const step = Math.min(dist, RIFT_PULL_SPEED * dt);
      const [nx, ny] = moveCircle(w, p.x, p.y, p.pr, (dx / dist) * step, (dy / dist) * step);
      p.x = nx;
      p.y = ny;
    }
    if (isProtected(p)) continue;
    const tx = Math.floor(p.x / TILE), ty = Math.floor(p.y / TILE);
    for (const h of w.floorHazards) {
      if (h.tx !== tx || h.ty !== ty || !isFloorHazardDamaging(h, w.floorHazardClock)) continue;
      ev.push({ t: "hazardHit", pid: p.id, kind: h.kind, x: p.x, y: p.y });
      damagePlayer(w, p, FLOOR_HAZARD_DAMAGE, ev);
      break;
    }
  }
}

// Is there another player (or, on the legacy Convex co-op path, a remote target) still up who
// could revive `p`? Drives the authoritative down-vs-gameover decision. Network-absent bodies
// are EXCLUDED from the wipe calculus entirely (studio balance gate §6: "pending reconnect
// reservations do not block wipe"): an absent teammate can neither be counted dead (their
// disconnect never causes a wipe) nor counted standing (a reservation cannot keep a fully
// downed connected party alive — nobody absent can channel a revive).
function hasStandingAlly(w: WorldState, p: PlayerSim): boolean {
  for (const other of w.players.values()) {
    if (other === p || other.isAbsent) continue;
    if (!other.isDown && other.hp > 0) return true;
  }
  return w.isCoop && w.remoteTargets.some((r) => !r.isDown);
}

function damagePlayer(w: WorldState, p: PlayerSim, amount: number, ev: SimEvent[]): void {
  if (w.isGodMode) return; // dev god mode; never set outside the sandbox
  // A network-absent body is reserved, not playing: it cannot be hurt while its player has
  // no way to react (the reconnect-grace contract). Collision paths skip absent bodies too;
  // this is the belt-and-suspenders gate on the one damage funnel.
  if (p.isAbsent) return;
  // A player mid-blessing-pick cannot be hurt. Offers are only raised on the safe side of a
  // transition (cleared floor), but the shared world keeps ticking under the chooser's menu
  // online — this shield covers the residue (a stray in-flight glob, a chained barrel).
  if (w.pendingBlessings.has(p.id)) return;
  p.hp -= amount;
  p.invuln = PLAYER.postHitInvuln;
  // Damage to the CHANNELER cancels the revive it was powering (gate §6) — identity-exact:
  // a bystander inside the radius taking a hit resets nothing.
  cancelReviveChannelBy(w, p.id);
  ev.push({ t: "playerHurt", pid: p.id, x: p.x, y: p.y });
  if (p.hp <= 0) {
    p.hp = 0;
    if (w.isShared) {
      // Stage C (gate §6): going to 0 is always DOWN, never a direct cut — the wipe is the
      // held all-down beat in checkStrandedWipe (4.0s), which is also what lets a teammate's
      // last-moment revive (or a reconnect return) save the run. The per-floor down limit
      // is counted on the TRANSITION only (splash on an already-down body recounts nothing);
      // past the limit the player is OUT (unrevivable) until the descent rescue.
      if (!p.isDown) {
        p.isDown = true;
        p.reviveProgress = 0;
        p.reviveBy = null;
        p.downsThisFloor++;
      }
    } else if (hasStandingAlly(w, p)) {
      // Legacy local co-op: a teammate can still revive — go DOWN, not out.
      p.isDown = true;
      p.reviveProgress = 0;
      p.reviveBy = null;
    } else {
      // Solo death (local): end the run immediately, exactly as it always did. isRunOver
      // makes the terminal transition derivable from STATE, not only from the event.
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

// The wipe (studio balance gate §6): the run ends only after EVERY connected player has
// been down SIMULTANEOUSLY for the full 4.0s hold — a beat where a last-tick revive
// completion (updateRevives runs first) or a reconnect return can still save the run.
// Anyone standing resets the hold. Network-absent bodies are excluded from the calculus
// entirely (gate §6): a reservation neither blocks a wipe (an absent ally cannot be waited
// on while the whole CONNECTED party lies downed) nor causes one (a body that merely
// disconnected is not "down" — with every connected player absent and nobody downed, the
// world simply idles until the seats resolve). Solo-local keeps its classic instant game
// over in damagePlayer; this gate is shared-world only.
function checkStrandedWipe(w: WorldState, dt: number, ev: SimEvent[]): void {
  if (!w.isShared || w.isRunOver || w.players.size === 0) { w.wipeTimer = 0; return; }
  let anyUp = false;
  let anyDown = false;
  for (const p of w.players.values()) {
    if (p.isAbsent) continue;
    if (!p.isDown && p.hp > 0) anyUp = true;
    else anyDown = true;
  }
  if (anyUp || !anyDown) { w.wipeTimer = 0; return; }
  w.wipeTimer += dt;
  if (w.wipeTimer >= WIPE_HOLD_SECONDS) endRun(w, ev);
}

// Authoritative revive (studio balance gate §6): ONE living teammate HOLDS the interact
// key (isInteracting, the consumed input's explicit intent) within REVIVE.radius for the
// full 1.5s channel, UNINTERRUPTED. Any break — the channeler taking damage, dashing,
// attacking (all three cancel at their sites via cancelReviveChannelBy), releasing the
// key, or leaving the radius — resets the channel to zero; a different teammate taking
// over starts fresh, and extra revivers never accelerate (the identity in reviveBy is the
// single channel). A player past the floor's down limit is OUT: unrevivable until the
// descent rescue. The revived player returns at 2 HP with 1.0s protection and a 0.35s
// attack lockout. The server validates everything from ITS OWN state — a tampered client
// can flip an input bit, never conjure proximity or skip the channel. Solo never has a
// downed player with a standing ally, so this no-ops there.
function updateRevives(w: WorldState, dt: number, ev: SimEvent[]): void {
  for (const downed of w.players.values()) {
    if (!downed.isDown) { downed.reviveBy = null; continue; }
    if (downed.downsThisFloor > REVIVE.downsPerFloor) {
      downed.reviveBy = null;
      downed.reviveProgress = 0;
      continue;
    }
    const current = downed.reviveBy !== null ? w.players.get(downed.reviveBy) : undefined;
    let reviver = current !== undefined && isValidReviver(current, downed) ? current : undefined;
    if (reviver === undefined) {
      // The running channel broke (or none existed): zero it, then let the first valid
      // candidate in stable map order open a FRESH one.
      downed.reviveProgress = 0;
      for (const other of w.players.values()) {
        if (other !== downed && isValidReviver(other, downed)) { reviver = other; break; }
      }
      downed.reviveBy = reviver !== undefined ? reviver.id : null;
    }
    if (reviver === undefined) continue;
    downed.reviveProgress += dt;
    if (downed.reviveProgress >= REVIVE.channel) {
      downed.isDown = false;
      downed.hp = Math.min(downed.maxHp, REVIVE.hp);
      downed.invuln = Math.max(downed.invuln, REVIVE.invuln);
      downed.fireCd = Math.max(downed.fireCd, REVIVE.fireLockout);
      downed.reviveProgress = 0;
      ev.push({ t: "revive", pid: downed.id, by: reviver.id, x: downed.x, y: downed.y });
      downed.reviveBy = null;
    }
  }
}

// Past the floor's down limit (gate §1: Standard 3/player/floor): OUT — down and
// unrevivable until the descent rescue. Both wires carry this derived bit so every client
// can stop offering a revive that the sim would refuse.
export function isPlayerOut(p: PlayerSim): boolean {
  return p.isDown && p.downsThisFloor > REVIVE.downsPerFloor;
}

function isValidReviver(other: PlayerSim, downed: PlayerSim): boolean {
  // An absent body cannot channel a revive; an absent DOWNED body can still be revived
  // (a kindness that survives the reconnect — they resume upright).
  if (other.isDown || other.isAbsent || other.hp <= 0 || !other.isInteracting) return false;
  if (other.dashTime > 0) return false; // mid-dash is a movement commitment, not a channel
  return Math.hypot(other.x - downed.x, other.y - downed.y) <= REVIVE.radius;
}

// Reset any revive channel POWERED BY this player (gate §6: the reviver's damage, dash, or
// attack cancels the whole channel — no partial credit).
function cancelReviveChannelBy(w: WorldState, pid: PlayerId): void {
  for (const downed of w.players.values()) {
    if (downed.reviveBy !== pid) continue;
    downed.reviveBy = null;
    downed.reviveProgress = 0;
  }
}

// ---- exit / descend ----

// The living players currently standing at the cleared exit — THE party-descend readiness
// predicate. One function backs the authoritative gate (updateExit) AND the wire readout
// (snapshot `exr`), so what the UI shows can never drift from what the gate requires.
// Downed players are never listed (they aren't required at the stairs; the descend rescues
// them), network-absent bodies are excluded on BOTH sides of the gate (they can neither
// hold the party hostage nor stand in as a phantom "player at the exit" — the descend
// carries them along), and an uncleared floor has no usable exit, so it reads nobody-ready.
export function playersAtExit(w: WorldState): PlayerId[] {
  if (w.isSandbox || !isFloorCleared(w)) return [];
  const d = w.dungeon;
  const ex = d.exit.x * TILE + TILE / 2, ey = d.exit.y * TILE + TILE / 2;
  const out: PlayerId[] = [];
  for (const p of w.players.values()) {
    if (p.isDown || p.isAbsent || p.hp <= 0) continue;
    if (Math.hypot(p.x - ex, p.y - ey) < TILE) out.push(p.id);
  }
  return out;
}

function updateExit(w: WorldState, ev: SimEvent[]): void {
  if (w.isSandbox) return;
  if (!isFloorCleared(w)) return;
  // Party-wide gate: descend only when EVERY living (up) player stands at the exit. Solo has one
  // player, so this is identical to the old single-player check. The authoritative server owns
  // this decision entirely off server positions — no client triggers the transition.
  // Network-absent bodies are excluded on BOTH sides of the gate (see playersAtExit): they
  // can neither hold the party hostage for the whole grace window nor stand in as a phantom
  // "player at the exit". At least one PRESENT living player must be at the exit, so an
  // all-absent world never descends by itself; a reserved body is carried down with the
  // party (descend repositions every player) and resumes on the new floor.
  let living = 0;
  for (const p of w.players.values()) {
    if (!p.isDown && !p.isAbsent && p.hp > 0) living++;
  }
  if (living === 0 || playersAtExit(w).length < living) return;
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
    // No offer for a network-absent body: it cannot answer, and its pending entry would hold
    // the party's descend for the full offer TTL. The trade (documented) is that a player
    // absent across the exit gate misses that floor's pick.
    for (const p of w.players.values()) if (!p.isAbsent) raiseBlessingOffer(w, p.id, false, ev);
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
    // Descending rescues downed members — OUT (down-limit) members included: the living
    // party reaching the stairs pulls them through at the same partial HP a revive grants
    // (never at 0 — a "living" player with an empty bar must not exist). They land under
    // the spawn-grace shield like everyone, and the floor's down count starts over.
    if (p.isDown) p.hp = Math.max(p.hp, REVIVE.hp);
    p.isDown = false;
    p.reviveProgress = 0;
    p.reviveBy = null;
    p.downsThisFloor = 0;
    if (SUSTAIN.descentHeal > 0) p.hp = Math.min(p.maxHp, p.hp + SUSTAIN.descentHeal);
  }
  ev.push({ t: "descend", toFloor: nextFloor });
  loadFloorIntoWorld(w, nextFloor);
  if (isOfferDue) {
    for (const p of w.players.values()) if (!p.isAbsent) raiseBlessingOffer(w, p.id, false, ev);
  }
}

// ---- the step ----

// Advance ONE player for one input over dt: aim, movement/dash/collision, shooting, and the
// melee-swing timer. This is the per-player half of stepWorld, factored out so the
// authoritative server and client prediction can step ONLY the local player at an arbitrary
// dt (each InputCmd carries its own frame dt) while the world half runs once per fixed tick.
// stepWorld itself calls this, so solo behavior is unchanged.
export function stepPlayerPhase(w: WorldState, p: PlayerSim, input: InputCmd, dt: number, ev: SimEvent[]): void {
  // A player with a blessing offer open is paused: no aim, movement, fire, or revive
  // channel. Their client freezes under the overlay and sends nothing anyway; the guard
  // makes a tampered client equally inert (it can't kite, shoot, or channel from inside
  // the damage-shielded pick window).
  if (w.pendingBlessings.has(p.id)) {
    p.isInteracting = false;
    return;
  }
  p.aimAngle = input.aim;
  // The revive-channel intent, held only by a living player (a downed body can't revive).
  p.isInteracting = input.interact === true && !p.isDown && p.hp > 0;
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
  updateGauntlet(w, dt, ev);
  updateHazards(w, dt, ev);
  updateProps(w, dt, ev);
  updateChests(w, dt, ev);
  updateFloorHazards(w, dt, ev);
  updatePickups(w, dt, ev);
  updateRevives(w, dt, ev);
  checkStrandedWipe(w, dt, ev);
  tickPendingBlessings(w, dt, ev);
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
export function devSpawnProp(w: WorldState, kind: Prop["kind"], x: number, y: number): Prop {
  const p: Prop = { id: w.nextPropId++, kind, x, y, radius: C.PROP_RADIUS, hp: C.PROP_HP[kind], dead: false };
  w.props.push(p);
  w.obstacleRev++;
  return p;
}
export function devSpawnChest(w: WorldState, x: number, y: number): void {
  w.chests.push({ id: w.nextChestId++, kind: "wood", x, y, radius: 16, opened: false });
}

// Dev flow inspector: the standard-class prop-aware chase field, lazily built off the
// current targets. Diagnostics only — reading it never changes game outcomes (the same
// cached build would happen on the next enemy query anyway).
export function navDebugField(w: WorldState): FlowField {
  return chaseFieldFor(w, ENEMY_ARCHETYPES.slime.radius);
}
