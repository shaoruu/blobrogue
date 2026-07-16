import type { ConvexClient } from "convex/browser";
import { api } from "./api.js";
import type { PresenceDoc, RoomStatus, RoomMode } from "./api.js";
import type { Session } from "./session.js";
import { worldIdForRoomCode, pvpWorldIdForRoomCode } from "./worldId.js";
import type { PlayableKitId, RunLoadout } from "./kitSelection.js";
import { isKitId } from "../sim/kits.js";
import { assertPvpAccessAllowed } from "./pvpFlag.js";

// One room session for AUTHORITATIVE online play — the ONLY multiplayer product path.
// Convex hosts only the social handshake: the room code, who is EXPECTED in it (roster),
// and the lobby/playing status; ALL gameplay state lives on the game server. The bridge
// between the two is mintTicket(): a Convex-minted join ticket that embeds this room's
// world id after verifying membership, so everyone who entered through this lobby lands in
// the same isolated server world — and the client asserts the server honored it
// (expectedWorldId), while readiness keys on the server's own snapshot roster.
//
// The legacy peer-synced classic co-op client (kind "coop") was removed after the Sev-0
// room divergence; its Convex functions remain only so already-deployed clients keep
// working, and the two kinds never cross-match (enforced in convex/rooms.ts).

const HEARTBEAT_MS = 5000; // presence rows go stale at 12s; keep the roster alive while we sit here

export interface LobbyPlayer {
  playerId: string;
  name: string;
  colorIndex: number;
  isHost: boolean;
  // The authoritative world this member is actually connected to (mirrored from the game
  // server's snapshot; null while in the lobby). Drives the roster's readiness readout.
  gsWorldId: string | null;
  // The lobby READY toggle + the member's own heartbeat-measured ping (roster readout).
  isReady: boolean;
  pingMs: number | null;
  kitId: string | null;
  petId: string | null;
  isKitChoiceMade: boolean;
  isPetChoiceMade: boolean;
  isLoadoutConfirmed: boolean;
}

export class OnlineLobby {
  private client: ConvexClient;
  private session: Session;

  private roomId = "";
  code = "";
  status: RoomStatus = "lobby";
  // The room's match mode (co-op dungeon vs pvp arena). Drives expectedWorldId so the client
  // asserts + connects to the correct authoritative world; the room dictates it (a joiner adopts
  // whatever the room was created as).
  mode: RoomMode = "coop";
  loadoutGeneration = 1;
  hostPlayerId = "";
  // Entered via quick play (public drop-in pool): no start gate, and game over offers
  // "play again" instead of a return to a private lobby.
  isQuickPlay = false;

  private presenceRows: PresenceDoc[] = [];
  private unsubRoom: (() => void) | null = null;
  private unsubPresence: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPingMs: number | null = null;
  private confirmedLoadout: RunLoadout | null = null;
  private confirmedLoadoutGeneration: number | null = null;
  private loadoutEditRevision: number | null = null;
  private loadoutDraftError: string | null = null;
  private pendingLoadoutDraft: Promise<void> = Promise.resolve();

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
  get selfLoadout(): RunLoadout | null {
    const row = this.presenceRows.find((candidate) => candidate.playerId === this.selfPlayerId);
    if (row?.isLoadoutConfirmed
      && row.loadoutGeneration === this.loadoutGeneration
      && row.loadoutKitId
      && isKitId(row.loadoutKitId)
      && row.loadoutKitId !== "none") {
      return { kitId: row.loadoutKitId, petId: row.loadoutPetId };
    }
    return this.confirmedLoadoutGeneration === this.loadoutGeneration
      ? this.confirmedLoadout
      : null;
  }
  get selfPreselection(): RunLoadout | null {
    const row = this.presenceRows.find((candidate) => candidate.playerId === this.selfPlayerId);
    if (row?.loadoutKitId && isKitId(row.loadoutKitId) && row.loadoutKitId !== "none") {
      return { kitId: row.loadoutKitId, petId: row.loadoutPetId };
    }
    return this.selfLoadout;
  }

  private requirePlayerId(): string {
    const id = this.session.playerId;
    if (!id) throw new Error("could not reach the server \u2014 try again");
    return id;
  }

  // The EFFECTIVE identity color for the lobby roster row: the player's pick, else 0 — the
  // amber default look their own screen already shows. Always sent, so the roster dot can
  // never disagree with the ticket claim the game server will broadcast (which defaults the
  // same way in convex/gsTicket.ts), and Convex never has to invent a color.
  private colorArg(): { colorIndex: number } {
    return { colorIndex: this.session.colorIndex ?? 0 };
  }

  private callerArg() {
    return {
      clientId: this.session.clientId,
      ...this.session.guestCapabilityArgs,
    };
  }

  private loadoutArg(loadout: RunLoadout) {
    return {
      kitId: loadout.kitId,
      petId: loadout.petId,
      isKitChoiceMade: true,
      isPetChoiceMade: true,
    };
  }

  private acceptLoadout(kitId: string, petId: string | null): void {
    if (!isKitId(kitId) || kitId === "none") throw new Error("the server returned an invalid kit");
    this.confirmedLoadout = { kitId, petId };
    this.confirmedLoadoutGeneration = this.loadoutGeneration;
    this.session.acceptConfirmedRunLoadout(this.confirmedLoadout);
  }

  // Ticket identity is read server-side from the persisted profile. Color picks persist in the
  // background, so a fast CREATE/JOIN -> START could mint before that write finished and other
  // clients would see the old/default tint. Flush identity (awaiting any in-flight background
  // write first) before every room/ticket operation.
  private async flushIdentity(): Promise<void> {
    await this.session.flushIdentity();
  }

  // Create a private room and get a shareable code. `mode` selects co-op vs the pvp arena.
  async create(mode: RoomMode, loadout: RunLoadout): Promise<void> {
    // TEMP kill switch: refuse a pvp room before touching the backend — the typed pvp_disabled
    // error carries the clean copy. Co-op is untouched. (Convex enforces this independently.)
    assertPvpAccessAllowed(mode, "private");
    await this.flushIdentity();
    const playerId = this.requirePlayerId();
    const res = await this.client.mutation(api.rooms.create, {
      ...this.callerArg(), kind: "online", mode,
      ...this.colorArg(), ...this.loadoutArg(loadout),
    });
    this.roomId = res.roomId;
    this.code = res.code;
    this.mode = res.mode ?? mode;
    this.loadoutGeneration = res.loadoutGeneration;
    this.status = "lobby";
    this.hostPlayerId = playerId;
    this.isQuickPlay = false;
    this.acceptLoadout(res.kitId, res.petId);
    this.subscribe();
  }

  // Join a friend's room by its code. If their run is already live, status arrives as
  // "playing" and the caller drops straight in.
  async join(code: string, loadout: RunLoadout): Promise<void> {
    await this.flushIdentity();
    this.requirePlayerId();
    const res = await this.client.mutation(api.rooms.join, {
      code: code.trim().toUpperCase(), ...this.callerArg(), kind: "online",
      ...this.colorArg(), ...this.loadoutArg(loadout),
    });
    // TEMP kill switch: the room dictates the mode (the joiner adopts it), so a pvp room is
    // refused here too while disabled. Convex rejects the join independently — this guards the
    // stale-cache race where a client learns the mode only from the response. Co-op untouched.
    assertPvpAccessAllowed(res.mode ?? "coop", "private");
    this.roomId = res.roomId;
    this.code = res.code;
    this.mode = res.mode ?? "coop"; // the room dictates the mode; the joiner adopts it
    this.status = res.status;
    this.loadoutGeneration = res.loadoutGeneration;
    this.isQuickPlay = false;
    this.acceptLoadout(res.kitId, res.petId);
    this.subscribe();
  }

  // Matchmake into the public pool: an open online room with space, or a fresh one (born
  // "playing" — the pool has no start gate; players drop in and out).
  async quickPlay(mode: RoomMode, loadout: RunLoadout): Promise<void> {
    // TEMP kill switch: refuse the pvp public pool before any backend call. Co-op untouched.
    assertPvpAccessAllowed(mode, "public");
    await this.flushIdentity();
    this.requirePlayerId();
    const res = await this.client.mutation(api.rooms.quickPlay, {
      ...this.callerArg(), kind: "online", mode,
      ...this.colorArg(), ...this.loadoutArg(loadout),
    });
    this.roomId = res.roomId;
    this.code = res.code;
    this.mode = res.mode ?? mode;
    this.status = res.status;
    this.loadoutGeneration = res.loadoutGeneration;
    this.isQuickPlay = true;
    this.acceptLoadout(res.kitId, res.petId);
    this.subscribe();
  }

  private subscribe(): void {
    const roomId = this.roomId;
    this.unsubRoom = this.client.onUpdate(api.rooms.get, { roomId }, (room) => {
      if (!room) return;
      this.status = room.status;
      this.hostPlayerId = room.hostPlayerId;
      const generation = room.loadoutGeneration ?? 1;
      if (generation !== this.loadoutGeneration) {
        this.confirmedLoadout = null;
        this.confirmedLoadoutGeneration = null;
        this.loadoutEditRevision = null;
        this.loadoutDraftError = null;
      }
      this.loadoutGeneration = generation;
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
  // The beat carries the CURRENT identity, so a name/color changed while sitting in the
  // lobby reaches everyone's roster within one beat — the roster and the ticket identity
  // the next run mints can never disagree. Each beat is also timed: its round trip is the
  // member's lobby ping, published on the NEXT beat for the roster's ping readout.
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const beat = () => {
      if (!this.roomId || !this.selfPlayerId) return;
      const sentAt = Date.now();
      this.client.mutation(api.rooms.heartbeat, {
        roomId: this.roomId, ...this.callerArg(),
        ...(this.session.name ? { name: this.session.name } : {}),
        ...this.colorArg(),
        ...(this.lastPingMs !== null ? { pingMs: this.lastPingMs } : {}),
      }).then(() => { this.lastPingMs = Date.now() - sentAt; }).catch(() => {});
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
      .map((r) => ({
        playerId: r.playerId, name: r.name, colorIndex: r.colorIndex,
        isHost: r.playerId === this.hostPlayerId, gsWorldId: r.gsWorldId,
        isReady: r.isReady, pingMs: r.pingMs,
        kitId: r.loadoutKitId,
        petId: r.loadoutPetId,
        isKitChoiceMade: r.isKitChoiceMade,
        isPetChoiceMade: r.isPetChoiceMade,
        isLoadoutConfirmed: r.isLoadoutConfirmed
          && r.loadoutGeneration === this.loadoutGeneration,
      }));
  }

  get isSelfReady(): boolean {
    return this.presenceRows.find((r) => r.playerId === this.selfPlayerId)?.isReady ?? false;
  }

  get isSelfLoadoutConfirmed(): boolean {
    const row = this.presenceRows.find((candidate) => candidate.playerId === this.selfPlayerId);
    if (!row) return this.selfLoadout !== null;
    return row.isKitChoiceMade === true
      && row.isPetChoiceMade === true
      && row.isLoadoutConfirmed === true
      && row.loadoutGeneration === this.loadoutGeneration;
  }

  // Every active member, including the host, must be confirmed and ready.
  get isPartyReady(): boolean {
    const players = this.players();
    return players.some((player) => player.playerId === this.selfPlayerId)
      && players.every((player) => player.isLoadoutConfirmed && player.isReady);
  }

  // The lobby READY toggle. Optimistically reflected in the local roster so the button
  // flips instantly; the subscription confirms it a beat later.
  async setReady(isReady: boolean): Promise<string | null> {
    const playerId = this.selfPlayerId;
    if (!this.roomId || !playerId) return "You are no longer in this room";
    try {
      const result = await this.client.mutation(api.presence.setReady, {
        roomId: this.roomId, ...this.callerArg(), isReady,
      });
      if (!result.ok) return result.message ?? "Confirm KIT + PET before readying up";
      const row = this.presenceRows.find((candidate) => candidate.playerId === playerId);
      if (row) { row.isReady = isReady; this.emit(); }
      return null;
    } catch {
      return "Could not update ready state";
    }
  }

  // The one authoritative world this room's members are allowed to play in. Tickets are
  // minted with exactly this claim, and the client asserts every snapshot against it.
  expectedWorldId(): string {
    return this.mode === "pvp"
      ? pvpWorldIdForRoomCode(this.code, this.loadoutGeneration)
      : worldIdForRoomCode(this.code, this.loadoutGeneration);
  }

  // Mirror the game server's connection truth onto our presence row (worldId after a
  // verified world join, null on leaving), so the lobby roster's readiness readout works
  // for members who are still ON the lobby screen. Best-effort — readiness inside the run
  // always reads the server's snapshot roster directly.
  reportWorld(worldId: string | null, generation = this.loadoutGeneration): void {
    const playerId = this.selfPlayerId;
    if (!this.roomId || !playerId) return;
    this.client.mutation(api.presence.reportWorld, {
      roomId: this.roomId,
      ...this.callerArg(),
      generation,
      worldId,
    }).catch(() => {});
  }

  // Host flips the lobby live; every subscribed member sees status "playing" and connects.
  async start(): Promise<string | null> {
    this.requirePlayerId();
    try {
      const result = await this.client.mutation(api.rooms.start, {
        roomId: this.roomId, ...this.callerArg(),
      });
      return result.ok ? null : result.message ?? "The party cannot start yet";
    } catch {
      return "Could not start the run";
    }
  }

  async beginLoadoutEdit(generation = this.loadoutGeneration): Promise<string | null> {
    const playerId = this.requirePlayerId();
    try {
      await this.pendingLoadoutDraft;
      this.loadoutDraftError = null;
      const result = await this.client.mutation(api.rooms.beginLoadoutEdit, {
        roomId: this.roomId,
        ...this.callerArg(),
        generation,
      });
      if (!result.ok || result.editRevision === undefined) {
        return result.reason === "generation_changed"
          ? "The lobby changed — choose again"
          : "This run already started";
      }
      this.confirmedLoadout = null;
      this.confirmedLoadoutGeneration = null;
      this.loadoutEditRevision = result.editRevision;
      const row = this.presenceRows.find((candidate) => candidate.playerId === playerId);
      if (row) {
        row.isKitChoiceMade = false;
        row.isPetChoiceMade = false;
        row.isLoadoutConfirmed = false;
        row.isReady = false;
        row.loadoutGeneration = generation;
        this.emit();
      }
      return null;
    } catch {
      return "Could not open loadout editing";
    }
  }

  chooseDraftKit(kitId: PlayableKitId, generation = this.loadoutGeneration): void {
    const playerId = this.selfPlayerId;
    if (!this.roomId || !playerId) return;
    const row = this.presenceRows.find((candidate) => candidate.playerId === playerId);
    if (row) {
      row.loadoutKitId = kitId;
      row.isKitChoiceMade = true;
      row.isLoadoutConfirmed = false;
      row.isReady = false;
      row.loadoutGeneration = generation;
      this.emit();
    }
    const editRevision = this.loadoutEditRevision;
    if (editRevision === null) {
      this.loadoutDraftError = "Loadout editing expired — reopen it";
      return;
    }
    const roomId = this.roomId;
    this.pendingLoadoutDraft = this.pendingLoadoutDraft.then(async () => {
      const result = await this.client.mutation(api.rooms.chooseDraftKit, {
        roomId,
        ...this.callerArg(),
        generation,
        editRevision,
        kitId,
      });
      if (!result.ok) this.loadoutDraftError = "Could not save the kit draft";
    }).catch(() => { this.loadoutDraftError = "Could not save the kit draft"; });
  }

  chooseDraftPet(petId: string | null, generation = this.loadoutGeneration): void {
    const playerId = this.selfPlayerId;
    if (!this.roomId || !playerId) return;
    const row = this.presenceRows.find((candidate) => candidate.playerId === playerId);
    if (row) {
      row.loadoutPetId = petId;
      row.isPetChoiceMade = true;
      row.isLoadoutConfirmed = false;
      row.isReady = false;
      row.loadoutGeneration = generation;
      this.emit();
    }
    const editRevision = this.loadoutEditRevision;
    if (editRevision === null) {
      this.loadoutDraftError = "Loadout editing expired — reopen it";
      return;
    }
    const roomId = this.roomId;
    this.pendingLoadoutDraft = this.pendingLoadoutDraft.then(async () => {
      const result = await this.client.mutation(api.rooms.chooseDraftPet, {
        roomId,
        ...this.callerArg(),
        generation,
        editRevision,
        petId,
      });
      if (!result.ok) this.loadoutDraftError = "Could not save the pet draft";
    }).catch(() => { this.loadoutDraftError = "Could not save the pet draft"; });
  }

  async confirmLoadout(_loadout: RunLoadout, generation = this.loadoutGeneration): Promise<string | null> {
    const playerId = this.requirePlayerId();
    try {
      await this.pendingLoadoutDraft;
      if (this.loadoutDraftError) return this.loadoutDraftError;
      const editRevision = this.loadoutEditRevision;
      if (editRevision === null) return "Loadout editing expired — reopen it";
      const result = await this.client.mutation(api.rooms.confirmLoadout, {
        roomId: this.roomId,
        ...this.callerArg(),
        generation,
        editRevision,
      });
      if (!result.ok || result.kitId === undefined) {
        if (result.reason === "generation_changed") return "The lobby changed — choose again";
        if (result.reason === "edit_changed") return "Loadout editing changed — review again";
        if (result.reason === "run_locked") return "This run already started";
        if (result.reason === "kit_locked") return "That kit is locked at your account level";
        if (result.reason === "pet_unowned") return "Rescue that pet before choosing it";
        return "Could not confirm that loadout";
      }
      this.loadoutGeneration = result.generation ?? generation;
      this.acceptLoadout(result.kitId, result.petId ?? null);
      this.loadoutEditRevision = null;
      this.loadoutDraftError = null;
      const row = this.presenceRows.find((candidate) => candidate.playerId === playerId);
      if (row) {
        row.loadoutKitId = result.kitId;
        row.loadoutPetId = result.petId ?? null;
        row.isKitChoiceMade = true;
        row.isPetChoiceMade = true;
        row.isLoadoutConfirmed = true;
        row.loadoutGeneration = this.loadoutGeneration;
        row.isReady = false;
        this.emit();
      }
      return null;
    } catch {
      return "Could not confirm that loadout";
    }
  }

  // After a wipe the party regroups in the same room: playing -> lobby (idempotent).
  async reopen(): Promise<boolean> {
    const playerId = this.selfPlayerId;
    if (!this.roomId || !playerId) return false;
    try {
      let result: { loadoutGeneration: number; isReopened: boolean } | null = null;
      for (const delayMs of [0, 150, 400, 800, 1500]) {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        result = await this.client.mutation(api.rooms.reopen, {
          roomId: this.roomId,
          ...this.callerArg(),
          generation: this.loadoutGeneration,
        });
        if (result.isReopened) break;
      }
      if (!result?.isReopened) return false;
      this.loadoutGeneration = result.loadoutGeneration;
      this.confirmedLoadout = null;
      this.confirmedLoadoutGeneration = null;
      this.loadoutEditRevision = null;
      this.loadoutDraftError = null;
      for (const row of this.presenceRows) {
        row.isKitChoiceMade = false;
        row.isPetChoiceMade = false;
        row.isLoadoutConfirmed = false;
        row.isReady = false;
        row.loadoutGeneration = null;
      }
      this.emit();
      return true;
    } catch {
      // A failed reopen only means the START button doesn't reappear; the lobby still shows.
      return false;
    }
  }

  // The bridge to the authoritative server: a Convex-minted ticket that embeds THIS room's
  // world id (verified against membership server-side). Called by WSTransport at connect
  // time, so the short TTL is always fresh.
  async mintTicket(): Promise<string> {
    await this.flushIdentity();
    const res = await this.client.action(api.gsTicket.mint, {
      ...this.callerArg(),
      roomCode: this.code,
    });
    return res.ticket;
  }

  leave(): void {
    const playerId = this.selfPlayerId;
    if (this.roomId && playerId) {
      this.client.mutation(api.rooms.leave, {
        roomId: this.roomId, ...this.callerArg(),
      }).catch(() => {});
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
