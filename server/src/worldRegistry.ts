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
    room.addPlayer(conn.playerId!);
    room.conns.set(conn.id, conn);
    conn.worldId = room.id;
    return room;
  }

  // Unbind on disconnect: remove the player + the conn from its room.
  unbind(conn: Conn): void {
    if (!conn.worldId) return;
    const room = this.worlds.get(conn.worldId);
    if (room && conn.playerId) {
      room.removePlayer(conn.playerId);
      room.conns.delete(conn.id);
    }
  }
}
