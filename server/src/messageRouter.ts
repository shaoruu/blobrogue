// Client-message routing: strict decode at the boundary, then an EXHAUSTIVE discriminated-union
// dispatch. Extracted from the socket server and driven by an injected context (DI: clock, codec,
// auth, metrics, session store, publisher) so message handling is a small, testable unit — no god
// server. A malformed/garbage message is isolated per-connection (it can never reach the tick loop).

import { jsonCodec, PROTOCOL_VERSION, ProtocolError, type ClientMsg, type Codec } from "../../src/net/protocol.js";
import type { WeaponId } from "../../src/sim/types.js";
import { verifyTicket } from "./auth.js";
import type { ServerConfig } from "./config.js";
import type { Clock } from "./clock.js";
import type { Metrics } from "./metrics.js";
import type { Conn } from "./connection.js";
import { inputToIntent } from "./connection.js";
import type { SessionStore, SnapshotPublisher } from "./ports.js";

const DEFAULT_WORLD_ID = "arena-1";
const OFFER_RESENDS = 40;

// assertNever makes the dispatch exhaustive: a new ClientMsg variant is a COMPILE error until it
// is handled here.
function assertNever(x: never): never {
  throw new ProtocolError(`unhandled message ${JSON.stringify(x)}`);
}

export interface RouterContext {
  config: ServerConfig;
  clock: Clock;
  metrics: Metrics;
  sessions: SessionStore;
  publisher: SnapshotPublisher;
  codec?: Codec;
  reject: (conn: Conn, code: string, reason: string) => void; // join reject (error + close)
  close: (conn: Conn, code: number, reason: string) => void;
}

export class MessageRouter {
  private codec: Codec;
  constructor(private ctx: RouterContext) {
    this.codec = ctx.codec ?? jsonCodec;
  }

  // Decode + dispatch one raw frame. Throws ProtocolError on malformed input (the caller isolates
  // it per-connection); never throws anything else out of a well-formed message.
  handle(conn: Conn, raw: string): void {
    const msg = this.codec.decodeClient(raw);
    switch (msg.t) {
      case "join": this.onJoin(conn, msg); return;
      case "input": this.onInput(conn, msg); return;
      case "pong": this.onPong(conn); return;
      case "stat": this.onStat(conn, msg); return;
      case "switch": this.onSwitch(conn, msg); return;
      case "pickBlessing": this.onPick(conn, msg); return;
      default: assertNever(msg); // exhaustive — a new variant won't compile until handled
    }
  }

  private onJoin(conn: Conn, msg: Extract<ClientMsg, { t: "join" }>): void {
    if (conn.authed) {
      try { conn.ws.send(this.codec.encodeServer({ t: "error", code: "already_joined", msg: "" })); } catch { /* ignore */ }
      return;
    }
    // Strict version: must EQUAL the current protocol (no 0 / missing bypass).
    if (msg.protocol !== PROTOCOL_VERSION) { this.ctx.reject(conn, "protocol", `expected ${PROTOCOL_VERSION}`); return; }
    const auth = verifyTicket(this.ctx.config.auth, msg.ticket);
    if (!auth.ok || !auth.playerId) { this.ctx.reject(conn, "auth", auth.reason ?? "unauthorized"); return; }
    conn.authed = true;
    conn.authName = auth.playerId;
    conn.playerId = "p" + conn.id; // world-scoped id; auth identity kept for logs
    const room = this.ctx.sessions.bind(conn, DEFAULT_WORLD_ID);
    conn.lastPongAt = this.ctx.clock.now();
    this.ctx.metrics.counters.joinsOk++;
    conn.log.info("join ok", { authName: conn.authName, playerId: conn.playerId, worldId: room.id });
    // Immediate FULL snapshot (carries selfId + authoritative spawn) — don't wait a tick.
    this.ctx.publisher.sendFull(room, conn);
  }

  private onInput(conn: Conn, msg: Extract<ClientMsg, { t: "input" }>): void {
    // Inputs before the join binding are expected under reordering; drop (don't kill the conn).
    if (!conn.authed || !conn.worldId) { this.ctx.metrics.counters.rejectedInputs++; return; }
    const room = this.ctx.sessions.room(conn.worldId);
    if (!room) return;
    room.queueInput(conn, inputToIntent(msg), this.ctx.config.maxInputQueue);
    // Reliable-event ack (monotonic): advance the client's acked event id so the publisher stops
    // resending delivered events.
    if (msg.ackEv > conn.ackedEventId) conn.ackedEventId = msg.ackEv;
  }

  private onPong(conn: Conn): void {
    conn.awaitingPong = false;
    conn.missedPings = 0;
    const now = this.ctx.clock.now();
    conn.lastPongAt = now;
    if (conn.lastPingSentAt > 0) {
      const sample = now - conn.lastPingSentAt;
      conn.rttMs = conn.rttMs === 0 ? sample : conn.rttMs * 0.7 + sample * 0.3; // EWMA
    }
  }

  private onStat(conn: Conn, msg: Extract<ClientMsg, { t: "stat" }>): void {
    conn.cliRttMs = msg.rtt;
    conn.cliJitterMs = msg.jit;
    conn.cliReconciliations = msg.rec;
    conn.cliCorrectionMaxPx = msg.corr;
  }

  private onSwitch(conn: Conn, msg: Extract<ClientMsg, { t: "switch" }>): void {
    if (!conn.authed || !conn.playerId || !conn.worldId) return;
    const room = this.ctx.sessions.room(conn.worldId);
    if (room && !room.trySwitchWeapon(conn.playerId, msg.weapon as WeaponId)) this.ctx.metrics.counters.rejectedInputs++;
  }

  private onPick(conn: Conn, msg: Extract<ClientMsg, { t: "pickBlessing" }>): void {
    if (!conn.authed || !conn.playerId || !conn.worldId) return;
    // Valid ONLY if it names one of the choices the server offered this player (anti-cheat gate).
    if (!conn.pendingOffer || !conn.pendingOffer.includes(msg.itemId)) { this.ctx.metrics.counters.rejectedInputs++; return; }
    const room = this.ctx.sessions.room(conn.worldId);
    if (!room) return;
    if (room.applyBlessing(conn.playerId, msg.itemId)) { conn.pendingOffer = null; conn.offerResendsLeft = 0; }
    else this.ctx.metrics.counters.rejectedInputs++;
  }
}

export { DEFAULT_WORLD_ID, OFFER_RESENDS };
