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

import { buildSnapshot, eventScope, jsonCodec, INTEREST_EXIT_FACTOR, type Codec, type PlayerIdentity, type RosterWire, type WireEvent } from "../../src/net/protocol.js";
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
    const identities = this.identitiesFor(room);
    const roster = this.rosterFor(room);
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
      const center = this.viewCenterFor(room, conn);
      const events = this.eventsFor(room, conn, center);
      // The seat token rides EVERY per-connection snapshot, not only the join-time full one:
      // under packet loss the full snapshot can drop, and a client without its current token
      // would come back from the next outage as a stranger (fresh body) — the exact bug class
      // this system exists to kill. Snapshots are per-connection already; ~40 bytes.
      const msg = buildSnapshot(room.state, conn.playerId, conn.lastAppliedSeq, events, room.latestEventId(), false, {
        worldId: room.id,
        roster,
        resumeToken: conn.resumeToken ?? undefined,
        interestRadius: this.deps.config.interestRadius,
        view: conn.view,
        identities,
        ...(center !== null ? { viewCenter: center } : {}),
      });
      this.sendRaw(conn, this.codec.encodeServer(msg), false);
    }
  }

  // Where this client's interest view is centered when NOT on their own player: a downed
  // spectator follows the teammate they chose (the semantic `spec` message), else the first
  // living teammate — so their snapshots and positional events cover what their camera
  // actually shows. Living players (and downed players with nobody left standing) center on
  // themselves (null). View preference only; the sim never reads any of this.
  private viewCenterFor(room: RoomRuntime, conn: Conn): { x: number; y: number } | null {
    const st = room.state;
    const self = conn.playerId !== null ? st.players.get(conn.playerId) : undefined;
    if (!self || !self.isDown) return null;
    const chosen = conn.spectateTarget !== null ? st.players.get(conn.spectateTarget) : undefined;
    if (chosen && !chosen.isDown && chosen.hp > 0) return { x: chosen.x, y: chosen.y };
    for (const p of st.players.values()) {
      if (p.id !== conn.playerId && !p.isDown && p.hp > 0) return { x: p.x, y: p.y };
    }
    return null;
  }

  // The room's verified cosmetic identities (name/color from each join ticket), keyed by
  // world-scoped player id, so every client's snapshot can label the other players.
  private identitiesFor(room: RoomRuntime): Map<string, PlayerIdentity> {
    const out = new Map<string, PlayerIdentity>();
    for (const conn of room.conns.values()) {
      if (conn.playerId !== null) out.set(conn.playerId, { name: conn.displayName, colorIndex: conn.colorIndex });
    }
    return out;
  }

  // Every seat in this world with the verified ticket identity it joined as: live
  // connections ("on") plus bodies reserved for a reconnect ("away"). Interest-independent
  // by design: this is the readiness/roster truth the client veil and HUD key on — an
  // interest filter must never be able to hide a party member's presence, and a member
  // mid-outage must read as RECONNECTING, not as gone.
  private rosterFor(room: RoomRuntime): RosterWire[] {
    const out: RosterWire[] = [];
    for (const conn of room.conns.values()) {
      if (conn.playerId === null || conn.closing) continue;
      out.push({
        pid: conn.playerId,
        aid: conn.authName ?? conn.playerId,
        nm: conn.displayName ?? conn.playerId,
        cl: conn.colorIndex,
        // A silent-but-open link reads as away too: teammates should see RECONNECTING the
        // moment the body goes safe (3s), not only once the socket finally dies.
        st: conn.isSoftAbsent ? "away" : "on",
      });
    }
    for (const seat of room.seats()) {
      out.push({ pid: seat.pid, aid: seat.authName, nm: seat.displayName ?? seat.pid, cl: seat.colorIndex, st: "away" });
    }
    return out;
  }

  // The reliable events newer than this client's ack, scoped to what this client should see:
  // its own pid events, global objective events, and positional FX within its (exit-hysteresis)
  // interest radius — measured from the same view center the snapshot uses, so a spectator's
  // events follow the teammate they are watching. Skipped ids are covered by evTo.
  private eventsFor(room: RoomRuntime, conn: Conn, center: { x: number; y: number } | null): WireEvent[] {
    const pending = room.eventsSince(conn.ackedEventId);
    if (pending.length === 0) return pending;
    const r = this.deps.config.interestRadius;
    if (r <= 0) return pending; // interest filtering disabled -> full stream
    const self = conn.playerId ? room.state.players.get(conn.playerId) : undefined;
    const at = center ?? (self ? { x: self.x, y: self.y } : null);
    const rEvents = r * INTEREST_EXIT_FACTOR;
    const r2 = rEvents * rEvents;
    const out: WireEvent[] = [];
    for (const w of pending) {
      const scope = eventScope(w.e);
      if (scope.kind === "global") { out.push(w); continue; }
      if (scope.kind === "pid") { if (scope.pid === conn.playerId) out.push(w); continue; }
      if (at === null) continue;
      const dx = scope.x - at.x, dy = scope.y - at.y;
      if (dx * dx + dy * dy <= r2) out.push(w);
    }
    return out;
  }

  sendFull(room: RoomRuntime, conn: Conn): void {
    // Start the reliable-event stream from "now": the full snapshot bootstraps state, so the client
    // shouldn't replay the pre-join event backlog (on a resume that means the outage window's
    // one-shot FX are deliberately skipped, never replayed). Future events flow from here.
    conn.ackedEventId = room.latestEventId();
    const msg = buildSnapshot(room.state, conn.playerId!, conn.lastAppliedSeq, [], room.latestEventId(), true, {
      worldId: room.id,
      roster: this.rosterFor(room),
      resumeToken: conn.resumeToken ?? undefined,
      interestRadius: 0,
      identities: this.identitiesFor(room),
    });
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
