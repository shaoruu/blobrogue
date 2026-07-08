// State publication (SnapshotPublisher port): turns authoritative room state into per-client wire
// snapshots (interest-filtered with enter/exit hysteresis) + a RELIABLE event stream, honoring
// output backpressure. Extracted from the socket server so publication isn't welded to the
// transport (a Colyseus schema/StateView delta publisher is a drop-in behind this port; see
// docs/adr/0001).
//
// Reliability: each event carries a monotonic id (assigned by the room). A per-tick snapshot
// includes every event newer than the client's ack that is IN SCOPE for that client (pid-scoped
// events go only to their player; positional one-shot FX only to clients whose interest view
// covers them; global objective events to everyone), so a snapshot dropped by backpressure loses
// nothing — the events resend next tick until the client acks. The client dedupes by id and
// additionally advances its ack to the snapshot's evTo, so filtered-out ids never wedge the
// stream. Delivery is effectively-once (no missing, no double kill/loot/FX).

import { buildSnapshot, eventScope, jsonCodec, INTEREST_EXIT_FACTOR, type Codec, type WireEvent } from "../../src/net/protocol.js";
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
      const events = this.eventsFor(room, conn);
      const msg = buildSnapshot(room.state, conn.playerId, conn.lastAppliedSeq, events, room.latestEventId(), false, {
        interestRadius: this.deps.config.interestRadius,
        view: conn.view,
      });
      this.sendRaw(conn, this.codec.encodeServer(msg), false);
    }
  }

  // The reliable events newer than this client's ack, scoped to what this client should see:
  // its own pid events, global objective events, and positional FX within its (exit-hysteresis)
  // interest radius. Skipped ids are covered by the snapshot's evTo ack advance.
  private eventsFor(room: RoomRuntime, conn: Conn): WireEvent[] {
    const pending = room.eventsSince(conn.ackedEventId);
    if (pending.length === 0) return pending;
    const r = this.deps.config.interestRadius;
    if (r <= 0) return pending; // interest filtering disabled -> full stream
    const self = conn.playerId ? room.state.players.get(conn.playerId) : undefined;
    const rEvents = r * INTEREST_EXIT_FACTOR;
    const r2 = rEvents * rEvents;
    const out: WireEvent[] = [];
    for (const w of pending) {
      const scope = eventScope(w.e);
      if (scope.kind === "global") { out.push(w); continue; }
      if (scope.kind === "pid") { if (scope.pid === conn.playerId) out.push(w); continue; }
      if (!self) continue;
      const dx = scope.x - self.x, dy = scope.y - self.y;
      if (dx * dx + dy * dy <= r2) out.push(w);
    }
    return out;
  }

  sendFull(room: RoomRuntime, conn: Conn): void {
    // Start the reliable-event stream from "now": the full snapshot bootstraps state, so the client
    // shouldn't replay the pre-join event backlog. Future events flow from here.
    conn.ackedEventId = room.latestEventId();
    const msg = buildSnapshot(room.state, conn.playerId!, conn.lastAppliedSeq, [], room.latestEventId(), true, { interestRadius: 0 });
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
