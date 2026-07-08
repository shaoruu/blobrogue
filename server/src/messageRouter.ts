// Client-message routing: strict decode at the boundary, then an EXHAUSTIVE discriminated-union
// dispatch. Extracted from the socket server and driven by an injected context (DI: clock, codec,
// auth, metrics, session store, publisher) so message handling is a small, testable unit — no god
// server. A malformed/garbage message is isolated per-connection (it can never reach the tick loop).
//
// Rate limiting is SEGMENTED here by message class (input/control/stat/pong — separate sliding
// windows per connection), so a flood in one class can neither starve nor kill the others, and a
// legitimate high-refresh client (whose input cadence is fixed-step ~20/s regardless of FPS)
// stays far below every cap.

import { jsonCodec, PROTOCOL_VERSION, ProtocolError, INTERP_DELAY_MIN_MS, INTERP_DELAY_MAX_MS, type ClientMsg, type Codec } from "../../src/net/protocol.js";
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

type MsgClass = "input" | "control" | "stat" | "pong";

function classOf(t: ClientMsg["t"]): MsgClass {
  switch (t) {
    case "input": return "input";
    case "pong": return "pong";
    case "stat": return "stat";
    case "join":
    case "equip":
    case "chooseBlessing":
      return "control";
    default: return assertNever(t);
  }
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
    if (!this.admitClass(conn, classOf(msg.t))) return; // over a class cap -> connection closed
    switch (msg.t) {
      case "join": this.onJoin(conn, msg); return;
      case "input": this.onInput(conn, msg); return;
      case "pong": this.onPong(conn, msg); return;
      case "stat": this.onStat(conn, msg); return;
      case "equip": this.onEquip(conn, msg); return;
      case "chooseBlessing": this.onChooseBlessing(conn, msg); return;
      default: assertNever(msg); // exhaustive — a new variant won't compile until handled
    }
  }

  // Per-class sliding 1s windows. Exceeding a class cap disconnects: no legitimate client can
  // reach these rates (input is fixed-step ~20/s at ANY frame rate; control is user-paced).
  private admitClass(conn: Conn, cls: MsgClass): boolean {
    const now = this.ctx.clock.now();
    const r = conn.rate;
    if (now - r.start >= 1000) { r.start = now; r.input = 0; r.control = 0; r.stat = 0; r.pong = 0; }
    const cfg = this.ctx.config;
    const cap = cls === "input" ? cfg.maxInputPerSec
      : cls === "control" ? cfg.maxControlPerSec
      : cls === "stat" ? cfg.maxStatPerSec
      : cfg.maxPongPerSec;
    r[cls]++;
    if (r[cls] > cap) {
      this.ctx.metrics.counters.rateLimited++;
      this.ctx.close(conn, 4003, `rate limit (${cls})`);
      return false;
    }
    return true;
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

  private onPong(conn: Conn, msg: Extract<ClientMsg, { t: "pong" }>): void {
    // Only the OUTSTANDING ping's pong counts: a stale/unsolicited pong (id mismatch, or no ping
    // in flight) must neither reset liveness nor contaminate the RTT estimate (TD M16).
    const expected = conn.nextPingId - 1;
    if (!conn.awaitingPong || msg.id !== expected) return;
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
    // The client's reported render delay feeds lag comp, CLAMPED to the same adaptive window the
    // client's interpolation actually uses — a lie can only mis-rewind the sender's own shots
    // within [90,300]ms, and the sim additionally clamps total rewind to its history window.
    conn.cliInterpDelayMs = Math.min(INTERP_DELAY_MAX_MS, Math.max(INTERP_DELAY_MIN_MS, msg.dly));
  }

  private onEquip(conn: Conn, msg: Extract<ClientMsg, { t: "equip" }>): void {
    if (!conn.authed || !conn.playerId || !conn.worldId) return;
    // Idempotent semantic command: stale/duplicate cseq is dropped (a retry can never re-apply
    // over a newer choice); only strictly newer commands advance.
    if (msg.cseq <= conn.lastCseq) return;
    conn.lastCseq = msg.cseq;
    const room = this.ctx.sessions.room(conn.worldId);
    if (room && !room.trySwitchWeapon(conn.playerId, msg.weapon)) this.ctx.metrics.counters.rejectedInputs++;
  }

  private onChooseBlessing(conn: Conn, msg: Extract<ClientMsg, { t: "chooseBlessing" }>): void {
    if (!conn.authed || !conn.playerId || !conn.worldId) return;
    // Valid ONLY against the live pending offer: matching offer id, unexpired, and a choice the
    // server itself put in that offer's set (anti-cheat gate — the client can never mint items).
    if (!conn.pendingOffer || msg.offerId !== conn.offerId) { this.ctx.metrics.counters.rejectedInputs++; return; }
    if (this.ctx.clock.now() > conn.offerDeadline) {
      conn.pendingOffer = null;
      conn.offerResendsLeft = 0;
      this.ctx.metrics.counters.rejectedInputs++;
      return;
    }
    if (!conn.pendingOffer.includes(msg.choiceId)) { this.ctx.metrics.counters.rejectedInputs++; return; }
    const room = this.ctx.sessions.room(conn.worldId);
    if (!room) return;
    if (room.applyBlessing(conn.playerId, msg.choiceId)) { conn.pendingOffer = null; conn.offerResendsLeft = 0; }
    else this.ctx.metrics.counters.rejectedInputs++;
  }
}

export { DEFAULT_WORLD_ID, OFFER_RESENDS };
