import type { ConvexClient } from "convex/browser";
import { api } from "./api.js";
import type { PresenceDoc, RoomStatus } from "./api.js";
import type { Session } from "./session.js";
import type { CoopBridge, LocalPlayerState } from "../game/coop.js";
import type { RemotePlayer, WeaponId } from "../game/types.js";
import { WEAPONS } from "../game/weapons.js";
import { RemoteInterp } from "./interp.js";

// Push cadence. We sync fast while a player is doing something the others need to see move
// smoothly (walking / aiming / firing / stat changes) and drop to a slow keepalive when idle,
// so we never spam Convex writes for a player standing still. The receiver smooths the gaps
// with entity interpolation (see interp.ts), so this rate only needs to keep the interpolation
// buffer fed -- it is not what makes motion look smooth.
const ACTIVE_INTERVAL_MS = 55;   // ~18 syncs/sec while moving / aiming / acting
const IDLE_REFRESH_MS = 1000;    // keepalive so the presence row never goes stale (12s cutoff)
const MOVE_EPS = 0.5;            // px of movement that counts as "still moving"
const AIM_EPS = 0.02;            // rad of aim change that counts as "still aiming"

// Snapshot of the last state we actually pushed, so publish() can tell whether anything
// meaningful changed. Mutated in place to keep the per-frame publish path allocation-free.
interface SentState {
  x: number; y: number; aim: number;
  hp: number; maxHp: number; weapon: WeaponId;
  floor: number; isDown: boolean; shotSeq: number; kills: number;
}

// Validate the networked weapon string against the real weapon table so any new
// weapon a teammate carries keeps its own shot SFX; unknown values fall back to pistol.
function asWeapon(s: string): WeaponId {
  return Object.hasOwn(WEAPONS, s) ? (s as WeaponId) : "pistol";
}

// Smallest absolute angle between two headings (both from atan2, so in [-PI, PI]).
function angleGap(a: number, b: number): number {
  return Math.abs(((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
}

// One co-op session, backed by Convex realtime subscriptions. Implements CoopBridge
// so the game can read/write shared state without knowing anything about Convex, and
// exposes lobby data (players, status, code) for the menu.
export class Multiplayer implements CoopBridge {
  private client: ConvexClient;
  private session: Session;

  private roomId = "";
  code = "";
  seed = 0;
  private floor = 1;
  status: RoomStatus = "lobby";
  hostPlayerId = "";

  private presenceRows: PresenceDoc[] = [];
  private unsubRoom: (() => void) | null = null;
  private unsubPresence: (() => void) | null = null;
  private listeners = new Set<() => void>();

  private lastPublish = 0;
  private lastSent: SentState | null = null;
  private interp = new RemoteInterp();
  private reviveQueue: number | null = null;
  private lastSelfReviveNonce = -1;

  constructor(client: ConvexClient, session: Session) {
    this.client = client;
    this.session = session;
  }

  private get selfPlayerId(): string {
    return this.session.playerId ?? "";
  }

  get selfId(): string { return this.selfPlayerId; }
  get roomCode(): string { return this.code; }
  get isHost(): boolean { return this.hostPlayerId === this.selfPlayerId; }

  async host(): Promise<void> {
    const playerId = this.requirePlayerId();
    const res = await this.client.mutation(api.rooms.create, { playerId });
    this.roomId = res.roomId;
    this.code = res.code;
    this.seed = res.seed;
    this.floor = res.floor;
    this.status = "lobby";
    this.hostPlayerId = playerId;
    this.subscribe();
  }

  async quickPlay(): Promise<void> {
    const playerId = this.requirePlayerId();
    const res = await this.client.mutation(api.rooms.quickPlay, { playerId });
    this.roomId = res.roomId;
    this.code = res.code;
    this.seed = res.seed;
    this.floor = res.floor;
    this.status = res.status;
    this.hostPlayerId = res.joined ? this.hostPlayerId : playerId;
    this.subscribe();
  }

  async join(code: string): Promise<void> {
    const playerId = this.requirePlayerId();
    const res = await this.client.mutation(api.rooms.join, { code: code.trim().toUpperCase(), playerId });
    this.roomId = res.roomId;
    this.code = res.code;
    this.seed = res.seed;
    this.floor = res.floor;
    this.status = res.status;
    this.subscribe();
  }

  private requirePlayerId(): string {
    const id = this.session.playerId;
    if (!id) throw new Error("sign in before hosting or joining");
    return id;
  }

  private subscribe() {
    const roomId = this.roomId;
    this.unsubRoom = this.client.onUpdate(api.rooms.get, { roomId }, (room) => {
      if (!room) return;
      this.seed = room.seed;
      this.floor = room.floor;
      this.status = room.status;
      this.hostPlayerId = room.hostPlayerId;
      this.emit();
    });
    this.unsubPresence = this.client.onUpdate(api.presence.list, { roomId }, (rows) => {
      this.presenceRows = rows;
      this.ingestRemotes(rows);
      this.detectRevive(rows);
      this.emit();
    });
  }

  // Push each teammate's freshest snapshot into the interpolation buffer, timestamped with
  // local receive time, and drop anyone who left so their buffer doesn't linger.
  private ingestRemotes(rows: PresenceDoc[]) {
    const now = Date.now();
    const self = this.selfPlayerId;
    const live = new Set<string>();
    for (const r of rows) {
      if (r.playerId === self) continue;
      live.add(r.playerId);
      this.interp.ingest(r.playerId, r.updatedAt, r.x, r.y, r.aimAngle, now);
    }
    this.interp.retain(live);
  }

  private detectRevive(rows: PresenceDoc[]) {
    const self = rows.find((r) => r.playerId === this.selfPlayerId);
    if (!self) return;
    if (this.lastSelfReviveNonce < 0) { this.lastSelfReviveNonce = self.reviveNonce; return; }
    if (self.reviveNonce > this.lastSelfReviveNonce) {
      this.reviveQueue = self.hp;
      this.lastSelfReviveNonce = self.reviveNonce;
    }
  }

  // ---- lobby-facing API (used by the menu) ----

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit() {
    for (const cb of this.listeners) cb();
  }

  lobbyPlayers(): Array<{ playerId: string; name: string; colorIndex: number; isHost: boolean }> {
    return this.presenceRows
      .slice()
      .sort((a, b) => a.colorIndex - b.colorIndex)
      .map((r) => ({ playerId: r.playerId, name: r.name, colorIndex: r.colorIndex, isHost: r.playerId === this.hostPlayerId }));
  }

  async startGame(): Promise<void> {
    const playerId = this.requirePlayerId();
    await this.client.mutation(api.rooms.start, { roomId: this.roomId, playerId });
  }

  // ---- CoopBridge (used by the game) ----

  getSeed(): number { return this.seed; }
  getFloor(): number { return this.floor; }

  requestDescend(nextFloor: number): void {
    this.client.mutation(api.rooms.descend, { roomId: this.roomId, floor: nextFloor }).catch(() => {});
  }

  publish(state: LocalPlayerState): void {
    const now = Date.now();
    const prev = this.lastSent;
    // Continuous changes (movement, aim) drive the fast cadence so teammates get a dense
    // stream to interpolate; discrete events (weapon swap, a shot, going down, floor change)
    // also count as active so they flush promptly. Otherwise we settle into a slow keepalive.
    const moved = !prev || Math.hypot(state.x - prev.x, state.y - prev.y) > MOVE_EPS;
    const aimed = !prev || angleGap(state.aimAngle, prev.aim) > AIM_EPS;
    const discrete = !prev
      || prev.hp !== state.hp || prev.maxHp !== state.maxHp
      || prev.weapon !== state.weapon || prev.floor !== state.floor
      || prev.isDown !== state.isDown || prev.shotSeq !== state.shotSeq
      || prev.kills !== state.kills;
    const interval = (moved || aimed || discrete) ? ACTIVE_INTERVAL_MS : IDLE_REFRESH_MS;
    if (now - this.lastPublish < interval) return;
    this.lastPublish = now;

    if (!prev) {
      this.lastSent = {
        x: state.x, y: state.y, aim: state.aimAngle,
        hp: state.hp, maxHp: state.maxHp, weapon: state.weapon,
        floor: state.floor, isDown: state.isDown, shotSeq: state.shotSeq, kills: state.kills,
      };
    } else {
      prev.x = state.x; prev.y = state.y; prev.aim = state.aimAngle;
      prev.hp = state.hp; prev.maxHp = state.maxHp; prev.weapon = state.weapon;
      prev.floor = state.floor; prev.isDown = state.isDown;
      prev.shotSeq = state.shotSeq; prev.kills = state.kills;
    }

    this.client.mutation(api.presence.update, {
      roomId: this.roomId,
      playerId: this.selfPlayerId,
      name: this.session.name || "blob",
      x: state.x, y: state.y, facing: state.facing,
      hp: state.hp, maxHp: state.maxHp, weapon: state.weapon,
      floor: state.floor, isDown: state.isDown, aimAngle: state.aimAngle,
      shotSeq: state.shotSeq, kills: state.kills,
    }).catch(() => {});
  }

  remotePlayers(): RemotePlayer[] {
    const now = Date.now();
    return this.presenceRows
      .filter((r) => r.playerId !== this.selfPlayerId)
      .map((r) => {
        // Render each teammate at the interpolated pose that trails real time by one sync
        // interval; fall back to the raw row on the very first frame before any samples land.
        const pose = this.interp.sample(r.playerId, now);
        return {
          playerId: r.playerId,
          name: r.name,
          x: pose ? pose.x : r.x,
          y: pose ? pose.y : r.y,
          facing: r.facing,
          hp: r.hp, maxHp: r.maxHp,
          weapon: asWeapon(r.weapon),
          floor: r.floor,
          isDown: r.isDown,
          aimAngle: pose ? pose.aimAngle : r.aimAngle,
          shotSeq: r.shotSeq,
          colorIndex: r.colorIndex,
          updatedAt: r.updatedAt,
        };
      });
  }

  selfColorIndex(): number {
    const self = this.presenceRows.find((r) => r.playerId === this.selfPlayerId);
    return self ? self.colorIndex : 0;
  }

  requestRevive(targetId: string): void {
    this.client.mutation(api.presence.revive, { roomId: this.roomId, targetPlayerId: targetId }).catch(() => {});
  }

  consumeRevive(): number | null {
    const v = this.reviveQueue;
    this.reviveQueue = null;
    return v;
  }

  leave(): void {
    const playerId = this.selfPlayerId;
    if (this.roomId && playerId) {
      this.client.mutation(api.rooms.leave, { roomId: this.roomId, playerId }).catch(() => {});
    }
    this.unsubRoom?.();
    this.unsubPresence?.();
    this.unsubRoom = null;
    this.unsubPresence = null;
    this.listeners.clear();
    this.roomId = "";
  }
}
