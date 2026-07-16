// Client-message routing: strict decode at the boundary, then an EXHAUSTIVE discriminated-union
// dispatch. Extracted from the socket server and driven by an injected context (DI: clock, codec,
// auth, metrics, session store, publisher) so message handling is a small, testable unit — no god
// server. A malformed/garbage message is isolated per-connection (it can never reach the tick loop).
//
// Rate limiting is SEGMENTED here by message class (input/control/stat/pong — separate sliding
// windows per connection), so a flood in one class can neither starve nor kill the others, and a
// legitimate high-refresh client (whose input cadence is fixed-step ~20/s regardless of FPS)
// stays far below every cap.

import { jsonCodec, PROTOCOL_VERSION, ProtocolError, INTERP_DELAY_MIN_MS, INTERP_DELAY_MAX_MS, isPvpWorldId, type ClientMsg, type Codec } from "../../src/net/protocol.js";
import {
  PVP_DISABLED_MESSAGE,
  PVP_PRIVATE_DISABLED_CODE,
  PVP_PUBLIC_DISABLED_CODE,
} from "../../src/net/pvpFlag.js";
import { PVP_POLICY_MAX_PLAYERS, pvpPolicyAccess } from "../../src/net/pvpPolicy.js";
import { mintResumeToken, resumeTokensEqual, verifyTicket, type AuthResult } from "./auth.js";
import type { ServerConfig } from "./config.js";
import type { Clock } from "./clock.js";
import type { Metrics } from "./metrics.js";
import type { Conn } from "./connection.js";
import { inputToIntent } from "./connection.js";
import type { RoomRuntime, Seat, SessionStore, SnapshotPublisher } from "./ports.js";
import { isKitUnlocked } from "../../src/sim/kits.js";
import type { KitId } from "../../src/sim/kits.js";
import type { GenerationAdmissionDecision } from "../../src/net/generationAdmission.js";

const DEFAULT_WORLD_ID = "arena-1";
const OFFER_RESENDS = 40;
export const POLICY_AUTHORITY_ACK = {
  t: "authorityAck",
  depth: "policy_v2_parser",
  ticket: "v2",
  policy: "private_draft_v1",
} as const;
// The room code a world id was minted from (worldIdForRoomCode), or null for non-room worlds
// (the public default, dev worlds). Log/ops-facing only — binding always uses the full id.
export function roomCodeOfWorldId(worldId: string): string | null {
  const match = /^(?:pvp:)?room:([^:]+)(?::g\d+)?$/.exec(worldId);
  return match?.[1] ?? null;
}

function generationOfWorldId(worldId: string): number {
  const match = /:g(\d+)$/.exec(worldId);
  return match ? Number(match[1]) : 0;
}

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
  isAcceptingJoins?: () => boolean;
  authorizeJoin?: (auth: AuthResult) => Promise<GenerationAdmissionDecision>;
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
    case "leave":
    case "equip":
    case "reorder":
    case "drop":
    case "swap":
    case "shopBuy":
    case "chooseBlessing":
    case "spec":
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
      case "leave": this.onLeave(conn); return;
      case "input": this.onInput(conn, msg); return;
      case "pong": this.onPong(conn, msg); return;
      case "stat": this.onStat(conn, msg); return;
      case "equip": this.onEquip(conn, msg); return;
      case "reorder": this.onReorder(conn, msg); return;
      case "drop": this.onDrop(conn, msg); return;
      case "swap": this.onSwap(conn, msg); return;
      case "shopBuy": this.onShopBuy(conn, msg); return;
      case "chooseBlessing": this.onChooseBlessing(conn, msg); return;
      case "spec": this.onSpectate(conn, msg); return;
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
    if (conn.authed || conn.isAdmissionPending) {
      try { conn.ws.send(this.codec.encodeServer({ t: "error", code: "already_joined", msg: "" })); } catch { /* ignore */ }
      return;
    }
    if (this.ctx.isAcceptingJoins?.() === false) {
      this.ctx.reject(conn, "server_draining", "server update in progress");
      return;
    }
    // Strict version: must EQUAL the current protocol (no 0 / missing bypass).
    if (msg.protocol !== PROTOCOL_VERSION) { this.ctx.reject(conn, "protocol", `expected ${PROTOCOL_VERSION}`); return; }
    const auth = verifyTicket(this.ctx.config.auth, msg.ticket);
    if (!auth.ok || !auth.playerId) {
      const reason = auth.reason ?? "unauthorized";
      const code = reason === "policy_required" || reason === "policy_invalid" ? reason : "auth";
      if (code !== "auth") {
        conn.log.warn("policy ticket rejected", {
          code,
          worldId: auth.worldId ?? "",
          generation: auth.worldId ? generationOfWorldId(auth.worldId) : 0,
          pvpPolicy: auth.pvpPolicy ?? "",
        });
      }
      this.ctx.reject(conn, code, reason);
      return;
    }
    if (auth.isPolicyAuthorityProbe === true) {
      this.ctx.metrics.counters.policyAuthorityProbeOk++;
      conn.log.info("policy parser authority probe accepted", {
        depth: POLICY_AUTHORITY_ACK.depth,
        ticket: POLICY_AUTHORITY_ACK.ticket,
        pvpPolicy: POLICY_AUTHORITY_ACK.policy,
      });
      try { conn.ws.send(JSON.stringify(POLICY_AUTHORITY_ACK)); } catch { /* closing */ }
      this.ctx.close(conn, 4012, "authority probe complete");
      return;
    }
    const isGenerationWorld = auth.worldId !== undefined
      && /^(?:pvp:)?room:[A-Z0-9]+:g\d+$/.test(auth.worldId);
    const isPlayableKit = auth.kit !== undefined && auth.kit !== "none";
    if (!this.ctx.config.auth.allowDev
      && auth.isSyntheticVerify !== true
      && (!isGenerationWorld || !isPlayableKit || auth.masteryLevel === undefined || auth.isPetChoiceMade !== true)) {
      this.ctx.reject(conn, "loadout_required", "confirmed room loadout required");
      return;
    }
    const worldId = auth.worldId ?? DEFAULT_WORLD_ID;
    if (isPvpWorldId(worldId)) {
      if (auth.pvpPolicy === undefined) {
        this.rejectPolicy(conn, "policy_required", "PVP room policy required", auth, worldId);
        return;
      }
      const access = pvpPolicyAccess(auth.pvpPolicy);
      const isEnabled = access === "private"
        ? this.ctx.config.pvpPrivateEnabled
        : this.ctx.config.pvpPublicEnabled;
      if (!isEnabled) {
        this.rejectPolicy(
          conn,
          access === "private" ? PVP_PRIVATE_DISABLED_CODE : PVP_PUBLIC_DISABLED_CODE,
          PVP_DISABLED_MESSAGE,
          auth,
          worldId,
        );
        return;
      }
    } else if (auth.pvpPolicy !== undefined) {
      this.rejectPolicy(conn, "policy_invalid", "PVP policy cannot authorize a co-op world", auth, worldId);
      return;
    }
    if (this.ctx.sessions.isRetired(worldId)) {
      this.ctx.reject(conn, "run_ended", "this run generation has ended");
      return;
    }
    if (isGenerationWorld && this.ctx.authorizeJoin) {
      conn.isAdmissionPending = true;
      void this.ctx.authorizeJoin(auth).then((decision) => {
        conn.isAdmissionPending = false;
        if (conn.closing) return;
        if (this.ctx.isAcceptingJoins?.() === false) {
          this.ctx.reject(conn, "server_draining", "server update in progress");
          return;
        }
        if (!decision.isAllowed) {
          const isRunEnded = decision.code === "generation_not_active"
            || decision.code === "room_not_active";
          const stableCode = isRunEnded ? "run_ended" : decision.code;
          const reason = isRunEnded
            ? "this run generation has ended"
            : "room membership changed; return to the lobby";
          if (stableCode === "policy_required"
            || stableCode === "policy_invalid"
            || stableCode === "policy_mismatch"
            || stableCode === "private_disabled"
            || stableCode === "public_disabled"
            || stableCode === "room_full"
            || stableCode === "admission_unavailable") {
            this.rejectPolicy(conn, stableCode, reason, auth, worldId);
          } else {
            this.ctx.reject(conn, stableCode, reason);
          }
          return;
        }
        this.bindVerifiedJoin(conn, auth, worldId, msg.resume);
      }).catch(() => {
        conn.isAdmissionPending = false;
        if (!conn.closing) {
          this.rejectPolicy(
            conn,
            "admission_unavailable",
            "online authority unavailable; retry from the lobby",
            auth,
            worldId,
          );
        }
      });
      return;
    }
    this.bindVerifiedJoin(conn, auth, worldId, msg.resume);
  }

  private bindVerifiedJoin(
    conn: Conn,
    auth: AuthResult,
    worldId: string,
    resumeToken: string | undefined,
  ): void {
    conn.authed = true;
    conn.authName = auth.playerId ?? null;
    conn.displayName = auth.name ?? null;
    conn.colorIndex = auth.colorIndex ?? null;
    conn.hat = auth.hat ?? null;
    conn.face = auth.face ?? null;
    conn.pet = auth.pet ?? null;
    conn.kitId = isKitUnlocked((auth.kit ?? "none") as KitId, auth.masteryLevel ?? 1)
      ? ((auth.kit ?? "none") as KitId)
      : "gunner";
    if (resumeToken !== undefined) {
      this.onResume(conn, worldId, resumeToken, auth);
      return;
    }
    const existingRoom = this.ctx.sessions.room(worldId);
    const pvpPolicy = auth.pvpPolicy ?? null;
    if (existingRoom && existingRoom.pvpPolicy !== pvpPolicy) {
      this.rejectPolicy(conn, "policy_mismatch", "room policy changed", auth, worldId);
      return;
    }
    const isSeatReserved = existingRoom
      ? [...existingRoom.seats()].some((seat) => seat.authName === auth.playerId)
      : false;
    const isIdentityLive = existingRoom
      ? [...existingRoom.conns.values()].some((other) => !other.closing && other.authName === auth.playerId)
      : false;
    if (isSeatReserved || isIdentityLive) {
      this.ctx.reject(conn, "resume_required", "resume token required for this active run");
      return;
    }
    if (existingRoom && pvpPolicy !== null
      && existingRoom.playerCount >= PVP_POLICY_MAX_PLAYERS) {
      this.rejectPolicy(conn, "room_full", "that room is full", auth, worldId);
      return;
    }

    conn.playerId = "p" + conn.id; // world-scoped id; auth identity kept for logs
    const room = this.ctx.sessions.bind(conn, worldId, pvpPolicy);
    this.finishJoin(conn, room, auth, "join ok");
    this.supersedeDuplicateIdentity(room, conn);
  }

  // Shared join/resume tail: liveness stamp, a FRESH single-use resume token (delivered on
  // the full snapshot), the trust-chain log line, and the immediate full snapshot (carries
  // selfId + authoritative state) — don't wait a tick.
  private finishJoin(conn: Conn, room: RoomRuntime, auth: AuthResult, what: string): void {
    conn.lastPongAt = this.ctx.clock.now();
    conn.resumeToken = mintResumeToken();
    this.ctx.metrics.counters.joinsOk++;
    conn.log.info(what, {
      authName: conn.authName ?? "", playerId: conn.playerId ?? "", worldId: room.id,
      roomCode: roomCodeOfWorldId(room.id) ?? "", ticketWorld: auth.worldId ?? "",
      pvpPolicy: room.pvpPolicy ?? "",
      generation: generationOfWorldId(room.id),
      name: conn.displayName ?? "", worldPlayers: room.playerCount,
    });
    this.ctx.publisher.sendFull(room, conn);
  }

  // Reclaim a reserved seat (or take over a half-dead live connection) with the single-use
  // resume token. Every failure is EXPLICIT: a token mismatch on an existing seat/connection
  // is a hard reject (replay/forgery — never a silent fresh spawn), while a missing seat
  // (grace expired, world released, server restarted) rejects with `resume_expired` so the
  // client knows the run cannot be resumed and returns to the lobby.
  private onResume(conn: Conn, worldId: string, token: string, auth: AuthResult): void {
    const room = this.ctx.sessions.room(worldId);
    const authName = conn.authName ?? "";
    if (room) {
      if (room.pvpPolicy !== (auth.pvpPolicy ?? null)) {
        this.ctx.metrics.counters.resumesRejected++;
        this.rejectPolicy(conn, "policy_mismatch", "room policy changed", auth, worldId);
        return;
      }
      const taken = room.takeSeat(authName, token, this.ctx.clock.now());
      if (taken.ok) {
        this.adoptSeat(conn, taken.seat);
        conn.presentedResumeToken = token;
        this.ctx.sessions.attach(conn, room);
        this.ctx.metrics.counters.resumesOk++;
        if (taken.isViaPrevToken) {
          // The previous connection died inside the rotation-ack window (rotated token never
          // reached the client) — the armed previous token healed the resume. Counted so a
          // spike in unconfirmed rotations is visible in ops.
          this.ctx.metrics.counters.resumesPrevToken++;
        }
        conn.log.info("resume ok (seat reclaimed)", {
          authName, worldId: room.id, playerId: conn.playerId ?? "", viaPrevToken: taken.isViaPrevToken,
          awayMs: this.ctx.clock.now() - taken.seat.reservedAt, worldPlayers: room.playerCount,
        });
        this.finishJoin(conn, room, auth, "join ok (resumed)");
        return;
      }
      if (taken.reason === "token_mismatch") {
        this.ctx.metrics.counters.resumesRejected++;
        conn.log.warn("resume REJECTED (token mismatch — replay or forgery)", { authName, worldId });
        this.ctx.reject(conn, "resume", "invalid_resume");
        return;
      }
      // No seat — the connection may still be live (half-dead socket the server has not
      // noticed yet). A matching token takes the body over in place; a mismatch rejects.
      // The live connection's UNCONFIRMED presented token is honored exactly like a seat's
      // prevToken: the client may never have received the rotated one.
      for (const other of room.conns.values()) {
        if (other.id === conn.id || other.closing || other.authName !== authName) continue;
        const isCurrent = other.resumeToken !== null && resumeTokensEqual(other.resumeToken, token);
        const isPrev = !isCurrent && !other.isResumeTokenConfirmed
          && other.presentedResumeToken !== null && resumeTokensEqual(other.presentedResumeToken, token);
        if (isCurrent || isPrev) {
          this.adoptLiveConn(conn, other);
          conn.presentedResumeToken = token;
          this.ctx.sessions.attach(conn, room);
          this.ctx.metrics.counters.resumesOk++;
          if (isPrev) this.ctx.metrics.counters.resumesPrevToken++;
          conn.log.info("resume ok (live connection taken over)", { authName, worldId: room.id, playerId: conn.playerId ?? "", viaPrevToken: isPrev });
          this.ctx.close(other, 4009, "superseded");
          this.finishJoin(conn, room, auth, "join ok (resumed)");
          return;
        }
        this.ctx.metrics.counters.resumesRejected++;
        conn.log.warn("resume REJECTED (live connection holds a different token)", { authName, worldId });
        this.ctx.reject(conn, "resume", "invalid_resume");
        return;
      }
    }
    // Nothing to resume: the grace expired, the world was released, or the server restarted
    // (seats are in-memory by design — see MULTIPLAYER.md). The run is gone for this player.
    this.ctx.metrics.counters.resumesExpired++;
    conn.log.info("resume expired (no seat)", { authName, worldId });
    this.ctx.reject(conn, "resume_expired", "seat expired or server restarted");
  }

  private rejectPolicy(
    conn: Conn,
    code: string,
    reason: string,
    auth: AuthResult,
    worldId: string,
  ): void {
    conn.log.warn("policy join rejected", {
      code,
      worldId,
      generation: generationOfWorldId(worldId),
      pvpPolicy: auth.pvpPolicy ?? "",
    });
    this.ctx.reject(conn, code, reason);
  }

  // Continuity transfer: the resumed connection IS the old player. lastAppliedSeq/lastCseq
  // keep the client's monotonic input/command counters idempotent across the reconnect; the
  // pending blessing offer survives with a fresh resend budget so a pick made mid-outage is
  // still answerable.
  private adoptSeat(conn: Conn, seat: Seat): void {
    conn.playerId = seat.pid;
    conn.displayName = seat.displayName;
    conn.colorIndex = seat.colorIndex;
    conn.hat = seat.hat;
    conn.face = seat.face;
    conn.pet = seat.pet;
    conn.kitId = seat.kitId;
    conn.lastAppliedSeq = seat.lastAppliedSeq;
    conn.lastCseq = seat.lastCseq;
    conn.pendingOffer = seat.pendingOffer;
    conn.offerId = seat.offerId;
    conn.offerDeadline = seat.offerDeadline;
    conn.offerResendsLeft = seat.pendingOffer !== null ? OFFER_RESENDS : 0;
  }

  private adoptLiveConn(conn: Conn, other: Conn): void {
    conn.playerId = other.playerId;
    conn.displayName = other.displayName;
    conn.colorIndex = other.colorIndex;
    conn.hat = other.hat;
    conn.face = other.face;
    conn.pet = other.pet;
    conn.kitId = other.kitId;
    conn.lastAppliedSeq = other.lastAppliedSeq;
    conn.lastCseq = other.lastCseq;
    conn.pendingOffer = other.pendingOffer;
    conn.offerId = other.offerId;
    conn.offerDeadline = other.offerDeadline;
    conn.offerResendsLeft = other.pendingOffer !== null ? OFFER_RESENDS : 0;
    // The body now belongs to the new connection: the old one must neither remove the player
    // nor reserve a seat when it closes.
    other.playerId = null;
  }

  // A deliberate goodbye: the close that follows must NOT reserve a reconnect seat (quit to
  // lobby / run end are not network accidents).
  private onLeave(conn: Conn): void {
    conn.isLeaving = true;
    this.ctx.close(conn, 4010, "left");
  }

  // Two live connections with the SAME verified identity in the SAME world (two tabs, a
  // zombie socket after a refresh, a stolen guest id) must never coexist silently: they
  // would render as two blobs of one lobby member and desync every roster/readiness read.
  // Newest wins — the older connection is closed explicitly. Bind-then-kick order matters:
  // the room never empties in between, so the run is not reset by a tab takeover. (A
  // reconnect that still HOLDS its token instead takes the body over in onResume.)
  private supersedeDuplicateIdentity(room: RoomRuntime, conn: Conn): void {
    for (const other of room.conns.values()) {
      if (other.id === conn.id || other.closing || other.authName !== conn.authName) continue;
      this.ctx.metrics.counters.duplicateIdentityKicks++;
      other.log.warn("superseded by a newer connection with the same identity", {
        authName: other.authName ?? "", worldId: room.id, oldPlayerId: other.playerId ?? "", newPlayerId: conn.playerId ?? "",
      });
      this.ctx.close(other, 4009, "superseded");
    }
  }

  private onInput(conn: Conn, msg: Extract<ClientMsg, { t: "input" }>): void {
    // Inputs before the join binding are expected under reordering; drop (don't kill the conn).
    if (!conn.authed || !conn.worldId) { this.ctx.metrics.counters.rejectedInputs++; return; }
    // An input is the token-receipt proof: a conforming client sends inputs only after
    // ingesting a snapshot on this socket, and every per-connection snapshot carries the
    // rotated token. From here the previous token is dead (single-use fully restored).
    conn.isResumeTokenConfirmed = true;
    const room = this.ctx.sessions.room(conn.worldId);
    if (!room) return;
    room.queueInput(conn, inputToIntent(msg), this.ctx.config.maxInputQueue);
    // Reliable-event ack (monotonic): advance the client's acked event id so the publisher stops
    // resending delivered events.
    if (msg.ackEv > conn.ackedEventId) conn.ackedEventId = msg.ackEv;
    // Snapshot ack (v24): promote the delta baseline to the exact snapshot the client retained,
    // so the next delta is diffed against a baseline the client demonstrably holds.
    this.ctx.publisher.ackSnapshot(conn, msg.ackSnap);
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

  // Spectate is a pure VIEW preference: it names the teammate whose surroundings this
  // client's interest (and positional events) should follow while they are down. It never
  // touches the sim. Only a real player in this client's own world is accepted; anything
  // else clears the preference (the publisher then falls back to the first living teammate).
  private onSpectate(conn: Conn, msg: Extract<ClientMsg, { t: "spec" }>): void {
    if (!conn.authed || !conn.playerId || !conn.worldId) return;
    const room = this.ctx.sessions.room(conn.worldId);
    const isKnown = room !== undefined && msg.target !== conn.playerId && room.state.players.has(msg.target);
    conn.spectateTarget = isKnown ? msg.target : null;
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

  private onReorder(conn: Conn, msg: Extract<ClientMsg, { t: "reorder" }>): void {
    if (!conn.authed || !conn.playerId || !conn.worldId) return;
    // Same idempotency contract as equip: one monotonic cseq stream per connection covers
    // every inventory command, so a resent/reordered command can never re-apply.
    if (msg.cseq <= conn.lastCseq) return;
    conn.lastCseq = msg.cseq;
    const room = this.ctx.sessions.room(conn.worldId);
    if (room && !room.tryReorderWeapons(conn.playerId, msg.from, msg.to)) this.ctx.metrics.counters.rejectedInputs++;
  }

  private onDrop(conn: Conn, msg: Extract<ClientMsg, { t: "drop" }>): void {
    if (!conn.authed || !conn.playerId || !conn.worldId) return;
    if (msg.cseq <= conn.lastCseq) return;
    conn.lastCseq = msg.cseq;
    const room = this.ctx.sessions.room(conn.worldId);
    if (room && !room.tryDropWeapon(conn.playerId, msg.weapon)) this.ctx.metrics.counters.rejectedInputs++;
  }

  private onSwap(conn: Conn, msg: Extract<ClientMsg, { t: "swap" }>): void {
    if (!conn.authed || !conn.playerId || !conn.worldId) return;
    // Same cseq idempotency as equip/drop: a resent swap can never trade twice.
    if (msg.cseq <= conn.lastCseq) return;
    conn.lastCseq = msg.cseq;
    const room = this.ctx.sessions.room(conn.worldId);
    if (room && !room.trySwapWeapon(conn.playerId, msg.pickup, msg.drop)) this.ctx.metrics.counters.rejectedInputs++;
  }

  private onShopBuy(conn: Conn, msg: Extract<ClientMsg, { t: "shopBuy" }>): void {
    if (!conn.authed || !conn.playerId || !conn.worldId) return;
    // The shared cseq stream makes a resent BUY idempotent: a duplicate can never charge
    // twice, and the sim's own validation (buyFromShopInWorld) makes a stale one honest —
    // it resolves to the slot's post-purchase status and mutates nothing.
    if (msg.cseq <= conn.lastCseq) return;
    conn.lastCseq = msg.cseq;
    const room = this.ctx.sessions.room(conn.worldId);
    if (room && !room.tryShopBuy(conn.playerId, msg.slot)) this.ctx.metrics.counters.rejectedInputs++;
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
