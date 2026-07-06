import type { ConvexClient } from "convex/browser";
import { api } from "./api.js";
import type { PresenceDoc, RoomStatus } from "./api.js";
import type { Session } from "./session.js";
import type { CoopBridge, LocalPlayerState } from "../game/coop.js";
import type { RemotePlayer, WeaponId } from "../game/types.js";

const PUBLISH_INTERVAL_MS = 90; // ~11 syncs/sec

function asWeapon(s: string): WeaponId {
  return s === "shotgun" || s === "rapid" ? s : "pistol";
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
      this.detectRevive(rows);
      this.emit();
    });
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
    if (now - this.lastPublish < PUBLISH_INTERVAL_MS) return;
    this.lastPublish = now;
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
    return this.presenceRows
      .filter((r) => r.playerId !== this.selfPlayerId)
      .map((r) => ({
        playerId: r.playerId,
        name: r.name,
        x: r.x, y: r.y, facing: r.facing,
        hp: r.hp, maxHp: r.maxHp,
        weapon: asWeapon(r.weapon),
        floor: r.floor,
        isDown: r.isDown,
        aimAngle: r.aimAngle,
        shotSeq: r.shotSeq,
        colorIndex: r.colorIndex,
        updatedAt: r.updatedAt,
      }));
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
