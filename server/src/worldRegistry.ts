// Session / room lifecycle store (SessionStore port). Owns the Map<worldId, RoomRuntime> and the
// bind/unbind of connections to rooms. The room factory is injected so tests (or a future
// Colyseus/matchmaking backend) can supply a different RoomRuntime without touching the server.
// Multi-world from day one (production spec §5): v1 runs one room, but nothing here assumes it.

import type { Difficulty } from "../../src/sim/balance.js";
import type { Logger } from "./logger.js";
import type { RoomRuntime, SessionStore } from "./ports.js";
import type { Conn } from "./connection.js";

export type RoomFactory = (id: string, difficulty: Difficulty) => RoomRuntime;

export class WorldRegistry implements SessionStore {
  private worlds = new Map<string, RoomRuntime>();

  constructor(private factory: RoomFactory, private log: Logger) {}

  ensureRoom(id: string, difficulty: Difficulty): RoomRuntime {
    // Difficulty binds at world CREATION only: the first verified joiner's room claim sets
    // it (all members' tickets carry the same room state), and a live room never re-reads
    // it — a late/stale ticket can never flip a run in progress.
    let room = this.worlds.get(id);
    if (!room) {
      room = this.factory(id, difficulty);
      this.worlds.set(id, room);
      this.log.info("world created", { worldId: id, difficulty });
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
  bind(conn: Conn, roomId: string, difficulty: Difficulty): RoomRuntime {
    const room = this.ensureRoom(roomId, difficulty);
    room.addPlayer(conn.playerId!);
    room.conns.set(conn.id, conn);
    conn.worldId = room.id;
    return room;
  }

  // Unbind on disconnect: remove the player + the conn from its room. When the LAST player
  // leaves (wipe or exodus), reset the room to a fresh run AND release it from the registry —
  // runs are party-scoped (a new group must never inherit a half-played dungeon), and with
  // room-scoped worlds (one per lobby code) an emptied world must not stay resident forever.
  // ensureRoom recreates on the next join, so releasing is invisible to rejoining parties.
  unbind(conn: Conn): void {
    if (!conn.worldId) return;
    const room = this.worlds.get(conn.worldId);
    if (room && conn.playerId) {
      room.removePlayer(conn.playerId);
      room.conns.delete(conn.id);
      if (room.playerCount === 0) {
        room.resetRun();
        this.worlds.delete(room.id);
        this.log.info("world released (room emptied)", { worldId: room.id });
      }
    }
  }
}
