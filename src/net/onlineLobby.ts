import type { ConvexClient } from "convex/browser";
import { api } from "./api.js";
import type { PresenceDoc, RoomStatus } from "./api.js";
import type { Session } from "./session.js";

// One room session for AUTHORITATIVE online play. Convex hosts only the social handshake —
// the room code, who is in it (roster), and the lobby/playing status; ALL gameplay state
// lives on the game server. The bridge between the two is mintTicket(): a Convex-minted
// join ticket that embeds this room's world id after verifying membership, so everyone who
// entered through this lobby lands in the same isolated server world.
//
// Contrast with Multiplayer (multiplayer.ts): that is the classic peer-synced co-op session
// (kind "coop"), which stays fully intact on its own path. Rooms of the two kinds never
// cross-match (enforced in convex/rooms.ts).

const HEARTBEAT_MS = 5000; // presence rows go stale at 12s; keep the roster alive while we sit here

export interface LobbyPlayer {
  playerId: string;
  name: string;
  colorIndex: number;
  isHost: boolean;
}

export class OnlineLobby {
  private client: ConvexClient;
  private session: Session;

  private roomId = "";
  code = "";
  status: RoomStatus = "lobby";
  hostPlayerId = "";
  // Entered via quick play (public drop-in pool): no start gate, and game over offers
  // "play again" instead of a return to a private lobby.
  isQuickPlay = false;

  private presenceRows: PresenceDoc[] = [];
  private unsubRoom: (() => void) | null = null;
  private unsubPresence: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(client: ConvexClient, session: Session) {
    this.client = client;
    this.session = session;
  }

  private get selfPlayerId(): string {
    return this.session.playerId ?? "";
  }

  get selfId(): string { return this.selfPlayerId; }
  get isHost(): boolean { return this.hostPlayerId === this.selfPlayerId; }
  get isActive(): boolean { return this.roomId !== "" && this.status !== "ended"; }

  private requirePlayerId(): string {
    const id = this.session.playerId;
    if (!id) throw new Error("could not reach the server \u2014 try again");
    return id;
  }

  private colorArg(): { colorIndex: number } | Record<string, never> {
    return this.session.colorIndex !== null ? { colorIndex: this.session.colorIndex } : {};
  }

  // Ticket identity is read server-side from the persisted profile. Color picks persist in the
  // background, so a fast CREATE/JOIN -> START could mint before that write finished and other
  // clients would see the old/default tint. Flush identity before room/ticket operations.
  private async flushIdentity(): Promise<void> {
    await this.session.login(this.session.name || "blob");
  }

  // Create a private room and get a shareable code.
  async create(): Promise<void> {
    await this.flushIdentity();
    const playerId = this.requirePlayerId();
    const res = await this.client.mutation(api.rooms.create, { playerId, kind: "online", ...this.colorArg() });
    this.roomId = res.roomId;
    this.code = res.code;
    this.status = "lobby";
    this.hostPlayerId = playerId;
    this.isQuickPlay = false;
    this.subscribe();
  }

  // Join a friend's room by its code. If their run is already live, status arrives as
  // "playing" and the caller drops straight in.
  async join(code: string): Promise<void> {
    await this.flushIdentity();
    const playerId = this.requirePlayerId();
    const res = await this.client.mutation(api.rooms.join, {
      code: code.trim().toUpperCase(), playerId, kind: "online", ...this.colorArg(),
    });
    this.roomId = res.roomId;
    this.code = res.code;
    this.status = res.status;
    this.isQuickPlay = false;
    this.subscribe();
  }

  // Matchmake into the public pool: an open online room with space, or a fresh one (born
  // "playing" — the pool has no start gate; players drop in and out).
  async quickPlay(): Promise<void> {
    await this.flushIdentity();
    const playerId = this.requirePlayerId();
    const res = await this.client.mutation(api.rooms.quickPlay, { playerId, kind: "online", ...this.colorArg() });
    this.roomId = res.roomId;
    this.code = res.code;
    this.status = res.status;
    this.isQuickPlay = true;
    this.subscribe();
  }

  private subscribe(): void {
    const roomId = this.roomId;
    this.unsubRoom = this.client.onUpdate(api.rooms.get, { roomId }, (room) => {
      if (!room) return;
      this.status = room.status;
      this.hostPlayerId = room.hostPlayerId;
      this.emit();
    });
    this.unsubPresence = this.client.onUpdate(api.presence.list, { roomId }, (rows) => {
      this.presenceRows = rows;
      this.emit();
    });
    this.startHeartbeat();
  }

  // Keep our presence row + the room's activity fresh for the whole session (lobby AND the
  // run itself — online play has no gameplay presence sync, so this is the only keepalive).
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const beat = () => {
      if (!this.roomId || !this.selfPlayerId) return;
      this.client.mutation(api.rooms.heartbeat, { roomId: this.roomId, playerId: this.selfPlayerId }).catch(() => {});
    };
    this.heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
    beat();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  players(): LobbyPlayer[] {
    return this.presenceRows
      .slice()
      .sort((a, b) => (a.playerId === this.hostPlayerId ? -1 : b.playerId === this.hostPlayerId ? 1 : a.name.localeCompare(b.name)))
      .map((r) => ({ playerId: r.playerId, name: r.name, colorIndex: r.colorIndex, isHost: r.playerId === this.hostPlayerId }));
  }

  // Host flips the lobby live; every subscribed member sees status "playing" and connects.
  async start(): Promise<void> {
    const playerId = this.requirePlayerId();
    await this.client.mutation(api.rooms.start, { roomId: this.roomId, playerId });
  }

  // After a wipe the party regroups in the same room: playing -> lobby (idempotent).
  async reopen(): Promise<void> {
    const playerId = this.selfPlayerId;
    if (!this.roomId || !playerId) return;
    try {
      await this.client.mutation(api.rooms.reopen, { roomId: this.roomId, playerId });
    } catch {
      // A failed reopen only means the START button doesn't reappear; the lobby still shows.
    }
  }

  // The bridge to the authoritative server: a Convex-minted ticket that embeds THIS room's
  // world id (verified against membership server-side). Called by WSTransport at connect
  // time, so the short TTL is always fresh.
  async mintTicket(): Promise<string> {
    await this.flushIdentity();
    const res = await this.client.action(api.gsTicket.mint, { clientId: this.session.clientId, roomCode: this.code });
    return res.ticket;
  }

  leave(): void {
    const playerId = this.selfPlayerId;
    if (this.roomId && playerId) {
      this.client.mutation(api.rooms.leave, { roomId: this.roomId, playerId }).catch(() => {});
    }
    this.stopHeartbeat();
    this.unsubRoom?.();
    this.unsubPresence?.();
    this.unsubRoom = null;
    this.unsubPresence = null;
    this.listeners.clear();
    this.roomId = "";
    this.status = "ended";
  }
}
