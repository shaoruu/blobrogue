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
import type { WireEvent } from "../../src/net/protocol.js";
import type { Conn, InputIntent } from "./connection.js";
import type { ServerConfig } from "./config.js";

// The authoritative simulation runtime for ONE room/world. Owns the WorldState + its connected
// players and advances it one fixed tick. GameWorld implements it; a Colyseus Room could too.
export interface RoomRuntime {
  readonly id: string;
  readonly state: WorldState;
  readonly conns: Map<number, Conn>;
  readonly playerCount: number;

  addPlayer(pid: PlayerId): void;
  removePlayer(pid: PlayerId): void;

  // Advance one authoritative tick (fixed step; the room owns simulation time).
  step(cfg: ServerConfig): void;

  // Reliable-event channel: fetch id-tagged events newer than the client's ack (bounded ring).
  eventsSince(ackedId: number): WireEvent[];
  latestEventId(): number;

  // Authoritative gameplay actions (validated; inputs/intents only, never outcomes).
  queueInput(conn: Conn, cmd: InputIntent, maxQueue: number): void;
  trySwitchWeapon(pid: PlayerId, weapon: WeaponId): boolean;
  rollBlessingChoices(): string[];
  applyBlessing(pid: PlayerId, itemId: string): boolean;

  // Player ids whose run ended this tick (full wipe) — the server drives the leave lifecycle.
  gameOverPlayers(): PlayerId[];
  // Player ids offered a blessing this tick — the server turns each into a validated offer.
  offerPlayers(): PlayerId[];
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
  unbind(conn: Conn): void;
}

// State publication: turn authoritative room state into per-client wire snapshots (interest
// filtered) + reliable events, respecting output backpressure. A Colyseus schema/StateView delta
// publisher is a drop-in alternative behind this port.
export interface SnapshotPublisher {
  publish(room: RoomRuntime): void;                 // per-tick broadcast to all room clients
  sendFull(room: RoomRuntime, conn: Conn): void;    // initial full snapshot on join
  sendOffers(room: RoomRuntime): void;              // resend pending blessing offers (reliable)
}
