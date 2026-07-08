// State publication (SnapshotPublisher port): turns authoritative room state into per-client wire
// snapshots (interest-filtered) + a RELIABLE event stream, honoring output backpressure. Extracted
// from the socket server so publication isn't welded to the transport (a Colyseus schema/StateView
// delta publisher is a drop-in behind this port; see docs/adr/0001).
//
// Reliability: each event carries a monotonic id (assigned by the room). A per-tick snapshot
// includes every event newer than the client's ack (from the room's bounded ring), so a snapshot
// dropped by backpressure loses nothing — the events resend next tick until the client acks. The
// client dedupes by id, so delivery is effectively-once (no missing/double kill/loot/FX).

import { buildSnapshot, jsonCodec, type Codec } from "../../src/net/protocol.js";
import type { ServerConfig } from "./config.js";
import type { Metrics } from "./metrics.js";
import type { Conn } from "./connection.js";
import type { RoomRuntime, SnapshotPublisher } from "./ports.js";

export interface PublisherDeps {
  config: ServerConfig;
  metrics: Metrics;
  codec?: Codec;
  // Disconnect a hopelessly-slow client (sustained backpressure). Injected so the publisher does
  // not own connection lifecycle.
  kick: (conn: Conn, code: number, reason: string) => void;
}

export class WsSnapshotPublisher implements SnapshotPublisher {
  private codec: Codec;
  constructor(private deps: PublisherDeps) {
    this.codec = deps.codec ?? jsonCodec;
  }

  publish(room: RoomRuntime): void {
    for (const conn of room.conns.values()) {
      if (conn.playerId === null || conn.closing) continue;
      const buffered = conn.ws.bufferedAmount;
      // Output backpressure: NEVER block the tick on a slow socket. Skip this tick if backed up;
      // disconnect if hopelessly behind (they'd interpolate the gap; events resend once caught up).
      if (buffered > this.deps.config.slowClientKickBytes) { this.deps.kick(conn, 4005, "too slow"); continue; }
      if (buffered > this.deps.config.sendBufferLimit) {
        conn.droppedSnaps++;
        this.deps.metrics.counters.droppedSnaps++;
        continue;
      }
      const events = room.eventsSince(conn.ackedEventId);
      const msg = buildSnapshot(room.state, conn.playerId, conn.lastAppliedSeq, events, false, { interestRadius: this.deps.config.interestRadius });
      this.sendRaw(conn, this.codec.encodeServer(msg), false);
    }
  }

  sendFull(room: RoomRuntime, conn: Conn): void {
    // Start the reliable-event stream from "now": the full snapshot bootstraps state, so the client
    // shouldn't replay the pre-join event backlog. Future events flow from here.
    conn.ackedEventId = room.latestEventId();
    const msg = buildSnapshot(room.state, conn.playerId!, conn.lastAppliedSeq, [], true, { interestRadius: 0 });
    this.sendRaw(conn, this.codec.encodeServer(msg), true);
  }

  sendOffers(room: RoomRuntime): void {
    for (const conn of room.conns.values()) {
      if (conn.closing || !conn.pendingOffer || conn.offerResendsLeft <= 0) continue;
      conn.offerResendsLeft--;
      try { conn.ws.send(this.codec.encodeServer({ t: "offer", id: conn.offerId, choices: conn.pendingOffer })); } catch { /* closing */ }
    }
  }

  private sendRaw(conn: Conn, raw: string, full: boolean): void {
    try { conn.ws.send(raw); } catch { return; /* closing; close handler cleans up */ }
    const bytes = Buffer.byteLength(raw);
    conn.bytesSent += bytes;
    this.deps.metrics.counters.bytesOut += bytes;
    this.deps.metrics.counters.msgsOut++;
    if (!full) this.deps.metrics.recordSnapshotBytes(bytes);
  }
}
