// Session / room lifecycle store (SessionStore port). Owns the Map<worldId, RoomRuntime> and the
// bind/unbind of connections to rooms. The room factory is injected so tests (or a future
// Colyseus/matchmaking backend) can supply a different RoomRuntime without touching the server.
// Multi-world from day one (production spec §5): v1 runs one room, but nothing here assumes it.

import type { Logger } from "./logger.js";
import type { RoomRuntime, SessionStore } from "./ports.js";
import type { Conn } from "./connection.js";

export type RoomFactory = (id: string) => RoomRuntime;

export class WorldRegistry implements SessionStore {
  private worlds = new Map<string, RoomRuntime>();

  constructor(private factory: RoomFactory, private log: Logger) {}

  ensureRoom(id: string): RoomRuntime {
    let room = this.worlds.get(id);
    if (!room) {
      room = this.factory(id);
      this.worlds.set(id, room);
      this.log.info("world created", { worldId: id });
    }
    return room;
  }

  room(id: string): RoomRuntime | undefined {
    return this.worlds.get(id);
  }

  rooms(): IterableIterator<RoomRuntime> {
    return this.worlds.values();
  }

  roomCount(): number {
    return this.worlds.size;
  }

  totalPlayers(): number {
    let n = 0;
    for (const w of this.worlds.values()) n += w.playerCount;
    return n;
  }

  // Bind a connection to a room: add its player + register the conn on the room.
  bind(conn: Conn, roomId: string): RoomRuntime {
    const room = this.ensureRoom(roomId);
    room.addPlayer(conn.playerId!, conn.kitId);
    room.conns.set(conn.id, conn);
    conn.worldId = room.id;
    return room;
  }

  // Register a RESUMED connection: the seat already owns the player body, so nothing spawns.
  attach(conn: Conn, room: RoomRuntime): void {
    room.conns.set(conn.id, conn);
    conn.worldId = room.id;
  }

  // Unbind on disconnect. An UNEXPECTED socket death passes `seat`: the body is reserved
  // (absent/paused) for the reconnect grace instead of removed, and the world stays resident
  // (a reserved body counts toward playerCount). A deliberate leave / game over / superseded
  // connection removes the player as before. When the LAST player leaves, reset the room to a
  // fresh run AND release it from the registry — runs are party-scoped (a new group must
  // never inherit a half-played dungeon), and with room-scoped worlds an emptied world must
  // not stay resident forever. ensureRoom recreates on the next join.
  unbind(conn: Conn, seat?: { nowMs: number; ttlMs: number }): void {
    if (!conn.worldId) return;
    const room = this.worlds.get(conn.worldId);
    if (!room) return;
    room.conns.delete(conn.id);
    if (conn.playerId) {
      if (seat) room.reserveSeat(conn, seat.nowMs, seat.ttlMs);
      else room.removePlayer(conn.playerId);
    }
    this.releaseIfEmpty(room);
  }

  // Expire overdue seats (the authoritative leave after the grace window) and release any
  // world that emptied because of it. Called every server tick — expiry is tick-precise.
  sweep(nowMs: number): number {
    let expired = 0;
    for (const room of [...this.worlds.values()]) {
      for (const seat of room.expireSeats(nowMs)) {
        expired++;
        this.log.info("seat expired (reconnect grace over) — authoritative leave", {
          worldId: room.id, authName: seat.authName, playerId: seat.pid, reservedMs: nowMs - seat.reservedAt,
        });
      }
      this.releaseIfEmpty(room);
    }
    return expired;
  }

  private releaseIfEmpty(room: RoomRuntime): void {
    if (room.playerCount !== 0 || room.conns.size !== 0) return;
    room.resetRun();
    this.worlds.delete(room.id);
    this.log.info("world released (room emptied)", { worldId: room.id });
  }
}
