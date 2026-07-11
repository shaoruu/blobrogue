// Explicit ports (hexagonal seams) so the room simulation, session/lifecycle store, and state
// publication are NOT welded into the socket server. Concrete implementations (GameWorld,
// WorldRegistry, SnapshotPublisher) satisfy these; GameServer depends on the INTERFACES. This is
// exactly the boundary a future Colyseus adapter would slot behind (see docs/adr/0001): a
// Colyseus Room implements RoomRuntime, its matchmaking/reconnect implements SessionStore, and
// its schema/StateView delta implements SnapshotPublisher — while our custom prediction/
// reconciliation/interp/lag-comp stays untouched.

import type { WorldState } from "../../src/sim/world.js";
import type { WeaponId } from "../../src/sim/types.js";
import type { PlayerId } from "../../src/sim/input.js";
import type { KitId } from "../../src/sim/kits.js";
import type { WireEvent } from "../../src/net/protocol.js";
import type { Conn, InputIntent } from "./connection.js";
import type { ServerConfig } from "./config.js";

// A reserved reconnect seat: the continuity a dropped connection needs to come back as the
// SAME player. The body itself stays in the WorldState (absent/paused); the seat carries the
// single-use token that reclaims it plus the per-connection command/offer state that must
// stay idempotent across the reconnect.
export interface Seat {
  pid: PlayerId;
  authName: string;
  token: string;
  // The token the seat's client last DEMONSTRABLY held, when that differs from `token`: the
  // connection died between the server rotating the token and the client receiving it (the
  // token-rotation ack window), so the client's only credential is still the previous one.
  // null once receipt of `token` was confirmed — a confirmed-then-replayed token stays dead.
  prevToken: string | null;
  reservedAt: number;
  expiresAt: number;
  displayName: string | null;
  colorIndex: number | null;
  hat: string | null;
  face: string | null;
  pet: string | null;
  lastAppliedSeq: number;
  lastCseq: number;
  pendingOffer: string[] | null;
  offerId: number;
  offerDeadline: number;
}

export type TakeSeatResult =
  // isViaPrevToken: the claim matched the armed previous token (an unconfirmed rotation was
  // healed) rather than the current one — surfaced for the resumesPrevToken metric.
  | { ok: true; seat: Seat; isViaPrevToken: boolean }
  | { ok: false; reason: "none" | "expired" | "token_mismatch" };

// The authoritative simulation runtime for ONE room/world. Owns the WorldState + its connected
// players and advances it one fixed tick. GameWorld implements it; a Colyseus Room could too.
export interface RoomRuntime {
  readonly id: string;
  readonly state: WorldState;
  readonly conns: Map<number, Conn>;
  readonly playerCount: number;

  addPlayer(pid: PlayerId, kit?: KitId): void;
  removePlayer(pid: PlayerId): void;
  // Flip a player's network-absence (silent-link soft absence, seat reservation, resume).
  setPlayerAbsent(pid: PlayerId, isAbsent: boolean): void;

  // ---- reconnect seats (grace/resume) ----
  // Reserve the dropped connection's body + continuity state until expiresAt.
  reserveSeat(conn: Conn, nowMs: number, ttlMs: number): void;
  // Claim a seat with its single-use token: consumes the seat and returns the continuity
  // state, or the explicit reason it cannot be claimed (the router maps "token_mismatch" to
  // a hard reject and "none"/"expired" to the documented fresh-join guidance).
  takeSeat(authName: string, token: string, nowMs: number): TakeSeatResult;
  // A deliberate plain join by an identity that still holds a seat abandons it: the reserved
  // body is removed so the fresh spawn is never a duplicate. Returns whether one existed.
  discardSeat(authName: string): boolean;
  // Remove every seat past its deadline (authoritative leave lifecycle) and return them.
  expireSeats(nowMs: number): Seat[];
  seats(): IterableIterator<Seat>;

  // Reset to a fresh run (new seed, floor 1). The session store calls this when the room
  // empties, so runs are party-scoped: the next group never inherits a half-played dungeon.
  resetRun(): void;

  // Advance one authoritative tick (fixed step; the room owns simulation time).
  step(cfg: ServerConfig): void;

  // Reliable-event channel: fetch id-tagged events newer than the client's ack (bounded ring).
  eventsSince(ackedId: number): WireEvent[];
  latestEventId(): number;

  // Authoritative gameplay actions (validated; inputs/intents only, never outcomes).
  queueInput(conn: Conn, cmd: InputIntent, maxQueue: number): void;
  trySwitchWeapon(pid: PlayerId, weapon: WeaponId): boolean;
  // Inventory reorder (hotbar drag/drop): indices validated against the live inventory.
  tryReorderWeapons(pid: PlayerId, from: number, to: number): boolean;
  // Weapon drop: ownership + player-state + last-weapon rule validated; the room spawns the
  // shared pickup and emits the drop event through its reliable channel.
  tryDropWeapon(pid: PlayerId, weapon: WeaponId): boolean;
  // Full-hotbar swap: trade an owned weapon for a named live weapon pickup. The sim
  // validates fullness/ownership/pickup range and performs the trade atomically.
  trySwapWeapon(pid: PlayerId, pickup: number, drop: WeaponId): boolean;
  // Shop purchase (Patch's room): the sim validates everything — liveness, proximity to
  // the station, price, and the per-viewer status matrix (sold/owned/max/full/broke).
  // Exactly one concurrent buyer can win a shared slot; every rejection mutates nothing.
  tryShopBuy(pid: PlayerId, slot: number): boolean;
  // Rolls against the player's owned levels (maxed blessings leave the pool; new ones weigh
  // 3× an upgrade); rare = the boss-chest Rare-pool reward.
  rollBlessingChoices(pid: PlayerId, rare: boolean): string[];
  applyBlessing(pid: PlayerId, itemId: string): boolean;
  // Resolve a pending offer without a pick (the roll came up empty — every blessing maxed),
  // so the sim's pick-pause and descend gate don't wait out the offer TTL.
  dismissBlessing(pid: PlayerId): void;

  // Player ids whose run ended this tick (full wipe) — the server drives the leave lifecycle.
  gameOverPlayers(): PlayerId[];
  // Blessing offers raised this tick — the server turns each into a validated offer.
  offerPlayers(): BlessingOfferRequest[];
  // Offers whose TTL expired this tick (already resolved on both sides) — logging/metrics.
  expiredOfferPlayers(): PlayerId[];
}

// One sim-raised blessing offer (descend or boss chest) awaiting server-side rolling.
export interface BlessingOfferRequest {
  pid: PlayerId;
  rare: boolean;
}

// Session / lifecycle store: which room a connection belongs to, room creation + teardown. In
// memory now; a Colyseus/matchmaking backend or Convex-backed store slots behind this later.
export interface SessionStore {
  ensureRoom(id: string): RoomRuntime;
  room(id: string): RoomRuntime | undefined;
  rooms(): IterableIterator<RoomRuntime>;
  roomCount(): number;
  totalPlayers(): number;
  bind(conn: Conn, roomId: string): RoomRuntime;
  // Register a RESUMED connection on its room (the seat already owns the player body — no
  // spawn). The caller has adopted the seat's playerId onto the conn.
  attach(conn: Conn, room: RoomRuntime): void;
  // Unbind on disconnect. With `seat`, the player's body/state is reserved for the reconnect
  // grace instead of removed (unexpected socket death); without it, the authoritative leave
  // applies immediately (deliberate leave / game over / superseded).
  unbind(conn: Conn, seat?: { nowMs: number; ttlMs: number }): void;
  // Expire overdue seats everywhere and release worlds that emptied; returns how many seats
  // expired (metrics).
  sweep(nowMs: number): number;
}

// State publication: turn authoritative room state into per-client wire snapshots (interest
// filtered) + reliable events, respecting output backpressure. A Colyseus schema/StateView delta
// publisher is a drop-in alternative behind this port.
export interface SnapshotPublisher {
  publish(room: RoomRuntime): void;                 // per-tick broadcast to all room clients
  sendFull(room: RoomRuntime, conn: Conn): void;    // initial full snapshot on join
  sendOffers(room: RoomRuntime): void;              // resend pending blessing offers (reliable)
  // Promote this connection's delta baseline to the snapshot it just acknowledged (input.ackSnap).
  ackSnapshot(conn: Conn, sseq: number): void;
}
