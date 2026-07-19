// The socket transport + lifecycle orchestrator. Deliberately THIN: it owns the WS server, the
// drift-corrected fixed tick loop, the heartbeat, and per-connection lifecycle — and delegates
// everything else to injected collaborators (SessionStore rooms, SnapshotPublisher publication,
// MessageRouter dispatch, Metrics observability, Clock time, HTTP endpoints). No god blob: each
// concern is a small typed module behind a port (see ports.ts + docs/adr/0001).

import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import { jsonCodec, TICK_HZ, FIXED_DT, ProtocolError, isPvpWorldId } from "../../src/net/protocol.js";
import type { ServerConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { GameWorld } from "./world.js";
import type { Conn } from "./connection.js";
import { newConnState } from "./connection.js";
import { Metrics, type HealthReport } from "./metrics.js";
import { systemClock, type Clock } from "./clock.js";
import { parseCidrList, clientIpFrom } from "./net.js";
import { WorldRegistry } from "./worldRegistry.js";
import { WsSnapshotPublisher } from "./snapshotPublisher.js";
import { MessageRouter, DEFAULT_WORLD_ID, OFFER_RESENDS } from "./messageRouter.js";
import {
  createHttpHandler,
  type ControlWorldActionResult,
  type WorldReport,
} from "./httpEndpoints.js";
import type { ControlWorldAction } from "./controlAuth.js";
import type { SessionStore, SnapshotPublisher, RoomRuntime } from "./ports.js";
import { RunReceiptDispatcher } from "./runReceiptDispatcher.js";
import { GenerationAdmissionStore } from "./generationAdmissionStore.js";
import {
  GENERATION_ADMISSION_TTL_MS,
  GENERATION_ADMISSION_VERSION,
} from "../../src/net/generationAdmission.js";
import type { GenerationAdmissionDecision } from "../../src/net/generationAdmission.js";
import {
  GenerationAdmissionClient,
  newGenerationAdmissionJti,
} from "./generationAdmissionClient.js";
import type { AuthResult } from "./auth.js";
import {
  RUN_RECEIPT_TTL_MS,
  RUN_RECEIPT_VERSION,
  parseGenerationWorldId,
} from "../../src/net/runReceipt.js";
import type {
  RunCompletionPayload,
  RunCompletionStatus,
  RunReceiptParticipant,
} from "../../src/net/runReceipt.js";
import { newRunReceiptJti } from "./runReceipt.js";
import { RunSnapshotStore } from "./runSnapshot.js";

const TICK_MS = 1000 / TICK_HZ;
// Catch-up bound for the drift-corrected pump: if the event loop stalls, run up to this many
// ticks in one pump to keep simulation time matched to real time (one input command is consumed
// per tick, so dropping ticks would slow movement). ~1s of catch-up tolerates GC/scheduling
// hitches (and in-process test contention) without a spiral of death.
const MAX_CATCHUP = 20;
const MAX_MALFORMED = 3;
// Close codes that are part of the deliberate lifecycle — never grounds for a reconnect seat:
// join rejects, game over, superseded connections, and explicit client leaves.
const SEATLESS_CLOSE_CODES: ReadonlySet<number> = new Set([4001, 4008, 4009, 4010, 4011, 4012]);

interface PendingCompletion {
  runId: string;
  status: "completed" | "abandoned";
  participants: RunReceiptParticipant[];
}

function isWorldSeatless(room: RoomRuntime): boolean {
  return room.playerCount === 0
    && room.conns.size === 0
    && [...room.seats()].length === 0;
}

// Optional dependency overrides (DI) for tests / alternative backends. Anything omitted uses the
// production default.
export interface ServerDeps {
  logger?: Logger;
  clock?: Clock;
  sessions?: SessionStore;
  publisher?: SnapshotPublisher;
  receiptDispatcher?: RunReceiptDispatcher;
  generationAdmissions?: GenerationAdmissionStore;
  admissionClient?: GenerationAdmissionClient;
  runSnapshots?: RunSnapshotStore;
}

export class GameServer {
  private cfg: ServerConfig;
  private log: Logger;
  private clock: Clock;
  private http: HttpServer;
  private wss: WebSocketServer;

  private sessions: SessionStore;
  private publisher: SnapshotPublisher;
  private router: MessageRouter;
  private metrics = new Metrics();
  private receiptDispatcher: RunReceiptDispatcher;
  private admissionClient: GenerationAdmissionClient;
  private runSnapshots: RunSnapshotStore;
  private restoredSnapshotWorldIds = new Set<string>();
  private completedWorlds = new Set<string>();
  private pendingCompletions = new Map<string, PendingCompletion>();
  private isAcceptingJoins = true;

  private conns = new Map<number, Conn>();
  private connsPerIp = new Map<string, number>();
  private trustedProxies: ReturnType<typeof parseCidrList>;
  private nextConnId = 1;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private nextTickAt = 0;
  private startedAt = 0;

  constructor(cfg: ServerConfig, deps: ServerDeps = {}) {
    this.cfg = cfg;
    this.log = deps.logger ?? createLogger({ app: "blobrogue-gs" });
    this.clock = deps.clock ?? systemClock;
    this.trustedProxies = parseCidrList(cfg.trustedProxies);
    this.runSnapshots = deps.runSnapshots ?? new RunSnapshotStore(cfg.runSnapshotDir);
    const savedRunSnapshots = this.runSnapshots.loadAll();
    const preservedWorldIds = new Set(savedRunSnapshots.map((snapshot) => snapshot.worldId));
    this.receiptDispatcher = deps.receiptDispatcher ?? new RunReceiptDispatcher(
      cfg.receiptEndpoint,
      cfg.receiptSecret,
      this.log,
      fetch,
      cfg.generationStatePath ? `${cfg.generationStatePath}.receipts` : null,
    );
    this.admissionClient = deps.admissionClient ?? new GenerationAdmissionClient(
      cfg.admissionEndpoint,
      cfg.receiptSecret,
      this.log,
      fetch,
      () => { this.metrics.counters.admissionMalformedResponses++; },
    );
    // The room factory picks the world MODE from the world IDENTITY: a pvp world id (minted only
    // for a pvp room) spins up a deathmatch world, everything else stays co-op. The mode is part
    // of the id, so every joiner of the same room lands in the same kind of world.
    this.sessions = deps.sessions ?? new WorldRegistry(
      (id, pvpPolicy, seed) => new GameWorld(
        id,
        seed,
        cfg.arena,
        isPvpWorldId(id) ? "pvp" : "coop",
        pvpPolicy,
      ),
      this.log,
      deps.generationAdmissions ?? new GenerationAdmissionStore(
        cfg.generationStatePath,
        this.clock.now(),
        preservedWorldIds,
      ),
      (room) => this.onWorldReleased(room),
    );
    for (const snapshot of savedRunSnapshots) {
      this.sessions.restoreRoom(snapshot, this.clock.now(), cfg.resumeGraceMs);
      this.restoredSnapshotWorldIds.add(snapshot.worldId);
    }
    for (const worldId of this.sessions.recoveredGenerationWorldIds?.() ?? []) {
      if (!this.receiptDispatcher.hasDeliverableWorld(worldId)) {
        this.submitCompletion(worldId, `${worldId}:restart`, "server_restart", [], true);
      }
    }
    this.publisher = deps.publisher ?? new WsSnapshotPublisher({
      config: cfg,
      metrics: this.metrics,
      codec: jsonCodec,
      kick: (conn, code, reason) => this.closeConn(conn, code, reason),
    });
    this.router = new MessageRouter({
      config: cfg, clock: this.clock, metrics: this.metrics,
      sessions: this.sessions, publisher: this.publisher, codec: jsonCodec,
      isAcceptingJoins: () => this.isAcceptingJoins,
      authorizeJoin: (auth) => this.authorizeJoin(auth),
      reject: (conn, code, reason) => this.rejectJoin(conn, code, reason),
      close: (conn, code, reason) => this.closeConn(conn, code, reason),
    });

    this.http = createServer(createHttpHandler({
      config: cfg,
      health: () => this.health(),
      worlds: () => this.worldReports(),
      lifecycle: (action) => this.applyLifecycle(action),
      controlWorld: (action) => this.applyControlWorldAction(action),
    }));
    this.wss = new WebSocketServer({ server: this.http, path: cfg.wsPath, maxPayload: 8 * 1024 });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.cfg.port, this.cfg.host, () => {
        const addr = this.http.address();
        const port = typeof addr === "object" && addr ? addr.port : this.cfg.port;
        this.startedAt = this.clock.now();
        this.nextTickAt = this.clock.mono();
        this.tickTimer = setInterval(() => this.pump(), 5);
        this.heartbeatTimer = setInterval(() => this.heartbeat(), this.cfg.heartbeatMs);
        this.log.info("listening", { host: this.cfg.host, port, wsPath: this.cfg.wsPath, prod: this.cfg.isProd });
        resolve(port);
      });
    });
  }

  async close(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.tickTimer = null;
    this.heartbeatTimer = null;
    for (const room of this.sessions.rooms()) this.refreshPreservedSnapshot(room);
    for (const conn of this.conns.values()) {
      try { conn.ws.close(1001, "server shutdown"); } catch { /* already gone */ }
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    await this.receiptDispatcher.flush();
    this.log.info("closed");
  }

  private applyLifecycle(action: "drain" | "flush" | "resume"): void {
    if (action === "drain") {
      this.isAcceptingJoins = false;
      return;
    }
    if (action === "resume") {
      this.isAcceptingJoins = true;
      return;
    }
    this.isAcceptingJoins = false;
    for (const room of [...this.sessions.rooms()]) {
      if (this.runSnapshots.has(room.id)) {
        this.refreshPreservedSnapshot(room);
        for (const conn of [...room.conns.values()]) {
          if (!conn.closing) this.closeConn(conn, 1012, "server update");
        }
        continue;
      }
      this.completedWorlds.add(room.id);
      const pending = this.pendingCompletions.get(room.id);
      this.pendingCompletions.delete(room.id);
      const runId = pending?.runId ?? room.runReceiptId();
      for (const conn of [...room.conns.values()]) {
        if (!conn.closing) this.closeConn(conn, 4011, "server update");
      }
      room.clearSeats();
      const isNoActiveSeat = isWorldSeatless(room);
      this.submitCompletion(
        room.id,
        runId,
        pending?.status ?? "abandoned",
        pending?.participants ?? [],
        isNoActiveSeat,
      );
    }
    this.sessions.sweep(this.clock.now());
  }

  private refreshPreservedSnapshot(room: RoomRuntime): void {
    if (!this.runSnapshots.has(room.id)) return;
    const snapshot = room.captureRunSnapshot(this.clock.now());
    if (snapshot === null) {
      this.log.error("preserved run could not be refreshed before reload", { worldId: room.id });
      return;
    }
    this.runSnapshots.save(snapshot);
  }

  private applyControlWorldAction(action: ControlWorldAction): ControlWorldActionResult {
    if (action.action === "restore") {
      if (!this.runSnapshots.isEnabled()) return { isApplied: false, reason: "unavailable" };
      const existing = this.sessions.room(action.worldId);
      if (existing !== undefined) {
        if (!this.restoredSnapshotWorldIds.has(action.worldId)) {
          return { isApplied: false, reason: "world_active" };
        }
        return this.worldActionSuccess(existing, this.runSnapshots.pathFor(action.worldId));
      }
      const snapshot = this.runSnapshots.load(action.worldId);
      if (snapshot === null) return { isApplied: false, reason: "snapshot_not_found" };
      const restored = this.sessions.restoreRoom(snapshot, this.clock.now(), this.cfg.resumeGraceMs);
      this.restoredSnapshotWorldIds.add(action.worldId);
      return this.worldActionSuccess(restored, this.runSnapshots.pathFor(action.worldId));
    }
    const room = this.sessions.room(action.worldId);
    if (room === undefined) return { isApplied: false, reason: "world_not_found" };
    if (action.action === "snapshot") {
      if (room.pvpPolicy !== null) return { isApplied: false, reason: "pvp_forbidden" };
      if (!this.runSnapshots.isEnabled()) return { isApplied: false, reason: "unavailable" };
      const snapshot = room.captureRunSnapshot(this.clock.now());
      if (snapshot === null) return { isApplied: false, reason: "snapshot_unavailable" };
      const path = this.runSnapshots.save(snapshot);
      return this.worldActionSuccess(room, path);
    }
    const isApplied = action.action === "warp"
      ? room.adminWarpToFloor(action.floor)
      : room.adminForceOpenExit();
    if (!isApplied) return { isApplied: false, reason: "pvp_forbidden" };
    return this.worldActionSuccess(room, null);
  }

  private worldActionSuccess(
    room: RoomRuntime,
    snapshotPath: string | null,
  ): Extract<ControlWorldActionResult, { isApplied: true }> {
    return {
      isApplied: true,
      worldId: room.id,
      floor: room.state.floor,
      players: room.playerCount,
      fidelity: snapshotPath === null ? undefined : "build+floor",
      snapshotPath: snapshotPath ?? undefined,
    };
  }

  // ---- fixed tick loop (drift-corrected accumulator on the monotonic clock) ----

  private pump(): void {
    const now = this.clock.mono();
    let steps = 0;
    while (now - this.nextTickAt >= 0 && steps < MAX_CATCHUP) {
      this.tickOnce();
      this.nextTickAt += TICK_MS;
      steps++;
    }
    if (steps >= MAX_CATCHUP) this.nextTickAt = now; // fell behind: resync, don't spiral
  }

  private tickOnce(): void {
    const t0 = this.clock.mono();
    // Reconnect-grace lifecycle first: overdue seats become authoritative leaves BEFORE this
    // tick simulates, so wipe/exit gates see the post-leave party the same tick it happens.
    this.metrics.counters.seatsExpired += this.sessions.sweep(this.clock.now());
    for (const room of this.sessions.rooms()) {
      this.detectSoftAbsence(room);
      try {
        room.step(this.cfg);
        this.recordPvpTelemetry(room);
      } catch (err) {
        this.log.error("world step failed", { worldId: room.id, err: String(err) });
      }
    }
    for (const room of this.sessions.rooms()) {
      this.applyOffers(room);
      this.handleExpiredOffers(room);
      this.publisher.sendOffers(room);
      this.publisher.publish(room);
      this.handleGameOver(room);
    }
    const dur = this.clock.mono() - t0;
    this.metrics.recordTick(dur);
    if (dur > TICK_MS) this.log.warn("tick over budget", { ms: Number(dur.toFixed(2)), budget: TICK_MS });
  }

  private recordPvpTelemetry(room: RoomRuntime): void {
    const events = room.pvpTelemetryEvents();
    if (events.length === 0 || room.pvpPolicy === null) return;
    this.log.info("pvp telemetry", {
      tick: room.state.tick,
      policy: room.pvpPolicy,
      count: events.length,
      payload: JSON.stringify(events),
    });
  }

  // Silent-drop detection (balance gate §6: bodies go invulnerable/non-targeting within 3s of
  // a disconnect, not only when the heartbeat finally closes the socket): a connection whose
  // link has delivered NOTHING for absenceDetectMs gets its body marked absent/safe while the
  // socket lingers; the very next inbound frame restores it. A healthy link can never trip
  // this — pongs alone arrive every heartbeatMs (< the window), even from a background tab.
  private detectSoftAbsence(room: RoomRuntime): void {
    const windowMs = this.cfg.absenceDetectMs;
    if (windowMs <= 0) return;
    const now = this.clock.now();
    for (const conn of room.conns.values()) {
      if (conn.closing || conn.playerId === null) continue;
      const isSilent = now - conn.lastInboundAt >= windowMs;
      if (isSilent === conn.isSoftAbsent) continue;
      conn.isSoftAbsent = isSilent;
      room.setPlayerAbsent(conn.playerId, isSilent);
      conn.log.info(isSilent ? "soft absence (silent link — body paused/safe)" : "soft absence lifted (traffic resumed)", {
        authName: conn.authName ?? "", worldId: room.id, silentMs: now - conn.lastInboundAt,
      });
    }
  }

  // Turn this tick's per-player offerBlessing events into server-decided, validated offers.
  // Each offer carries a monotonic id the client must echo, a bounded resend budget (loss/
  // backpressure recovery), and an expiry deadline — unanswered offers die instead of living as
  // forever-claimable server state.
  private applyOffers(room: RoomRuntime): void {
    for (const offer of room.offerPlayers()) {
      const conn = this.connForPlayer(room, offer.pid);
      if (!conn || conn.closing) continue;
      const choices = room.rollBlessingChoices(offer.pid, offer.rare);
      // Nothing left to offer (every blessing maxed): resolve the sim's pending offer right
      // away — an unanswerable empty offer must not pause the player until the TTL.
      if (choices.length === 0) { room.dismissBlessing(offer.pid); continue; }
      conn.pendingOffer = choices;
      conn.offerId++;
      conn.offerResendsLeft = OFFER_RESENDS;
      conn.offerDeadline = this.clock.now() + this.cfg.offerTtlMs;
      conn.queue.length = 0;
      conn.lastInput = null;
      conn.starveTicks = 0;
    }
  }

  // Blessing offers the room expired this tick (the room already cleared both the sim entry
  // and the conn/seat offers) — observability so a stuck-party report can be answered from
  // the logs, and a growing counter flags AFK-heavy or overlay-bug behavior.
  private handleExpiredOffers(room: RoomRuntime): void {
    for (const pid of room.expiredOfferPlayers()) {
      this.metrics.counters.offersExpired++;
      this.log.info("blessing offer expired unanswered (pick forfeited, gate released)", { worldId: room.id, playerId: pid });
    }
  }

  // Deterministic leave on game over: the final snapshot (carrying the gameOver event) has just
  // been sent, so close the socket now — no lingering post-run connection.
  private handleGameOver(room: RoomRuntime): void {
    const gameOverPlayers = room.gameOverPlayers();
    if (gameOverPlayers.length === 0) return;
    const participants = room.runReceiptParticipants();
    this.pendingCompletions.set(room.id, {
      runId: room.runReceiptId(),
      status: participants.length > 0 ? "completed" : "abandoned",
      participants,
    });
    for (const pid of gameOverPlayers) {
      const conn = this.connForPlayer(room, pid);
      if (conn && !conn.closing) { conn.gameOver = true; this.closeConn(conn, 4008, "game over"); }
    }
    if (isWorldSeatless(room)) {
      const pending = this.pendingCompletions.get(room.id);
      if (pending) {
        this.pendingCompletions.delete(room.id);
        this.completedWorlds.add(room.id);
        this.submitCompletion(room.id, pending.runId, pending.status, pending.participants, true);
        this.sessions.sweep(this.clock.now());
      }
    }
  }

  private onWorldReleased(room: RoomRuntime): void {
    this.runSnapshots.remove(room.id);
    this.restoredSnapshotWorldIds.delete(room.id);
    const pending = this.pendingCompletions.get(room.id);
    if (pending) {
      this.pendingCompletions.delete(room.id);
      this.submitCompletion(room.id, pending.runId, pending.status, pending.participants, true);
      return;
    }
    if (this.completedWorlds.delete(room.id)) return;
    this.submitCompletion(room.id, room.runReceiptId(), "abandoned", [], true);
  }

  private submitCompletion(
    worldId: string,
    runId: string,
    status: RunCompletionStatus,
    participants: RunReceiptParticipant[],
    isNoActiveSeat: boolean,
  ): void {
    const world = parseGenerationWorldId(worldId);
    if (!world || world.isPvp) return;
    if (!isNoActiveSeat) {
      this.log.error("run completion withheld while an authoritative seat remains", {
        worldId,
        status,
      });
      return;
    }
    const issuedAt = this.clock.now();
    const payload: RunCompletionPayload = {
      version: RUN_RECEIPT_VERSION,
      jti: newRunReceiptJti(),
      runId,
      worldId,
      roomCode: world.roomCode,
      generation: world.generation,
      status,
      issuedAt,
      expiresAt: issuedAt + RUN_RECEIPT_TTL_MS,
      isNoActiveSeat,
      participants,
    };
    this.receiptDispatcher.submit(payload);
  }

  private authorizeJoin(auth: AuthResult): Promise<GenerationAdmissionDecision> {
    const world = auth.worldId ? parseGenerationWorldId(auth.worldId) : null;
    if (!world) return Promise.resolve({ isAllowed: true, code: "not_generation_bound" });
    if (!this.cfg.admissionEndpoint && !this.cfg.isProd) {
      return Promise.resolve({ isAllowed: true, code: "development_bypass" });
    }
    if (!auth.playerId
      || !auth.worldId
      || !auth.kit
      || auth.isPetChoiceMade !== true) {
      return Promise.resolve({ isAllowed: false, code: "loadout_required" });
    }
    const issuedAt = this.clock.now();
    return this.admissionClient.check({
      version: GENERATION_ADMISSION_VERSION,
      jti: newGenerationAdmissionJti(),
      playerId: auth.playerId,
      worldId: auth.worldId,
      roomCode: world.roomCode,
      generation: world.generation,
      mode: world.isPvp ? "pvp" : "coop",
      pvpPolicy: auth.pvpPolicy ?? null,
      kitId: auth.kit,
      petId: auth.pet ?? null,
      isPetChoiceMade: true,
      issuedAt,
      expiresAt: issuedAt + GENERATION_ADMISSION_TTL_MS,
    });
  }

  private connForPlayer(room: RoomRuntime, pid: string): Conn | undefined {
    for (const conn of room.conns.values()) if (conn.playerId === pid) return conn;
    return undefined;
  }

  // ---- heartbeat / timeout (also stamps RTT via pong) ----

  private heartbeat(): void {
    const now = this.clock.now();
    for (const conn of this.conns.values()) {
      if (conn.closing) continue;
      if (conn.awaitingPong) {
        conn.missedPings++;
        if (conn.missedPings >= this.cfg.heartbeatMisses) { this.closeConn(conn, 4002, "heartbeat timeout"); continue; }
      }
      conn.awaitingPong = true;
      conn.lastPingSentAt = now;
      const room = conn.worldId ? this.sessions.room(conn.worldId) : undefined;
      const tick = room ? room.state.tick : 0;
      try { conn.ws.send(jsonCodec.encodeServer({ t: "ping", id: conn.nextPingId++, tick, time: now })); } catch { /* closing */ }
    }
  }

  // ---- connection lifecycle ----

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    // Per-IP cap keyed on the REAL client IP (trusted-proxy XFF parsing; loopback-only trust by
    // default) so nginx doesn't collapse every user into one loopback bucket (P0-4).
    const ip = clientIpFrom(req, this.trustedProxies);
    const perIp = this.connsPerIp.get(ip) ?? 0;
    if (perIp >= this.cfg.maxConnsPerIp) {
      try { ws.close(4006, "too many connections"); } catch { /* ignore */ }
      this.log.warn("conn rejected: per-ip cap", { ip });
      return;
    }
    this.connsPerIp.set(ip, perIp + 1);

    const id = this.nextConnId++;
    const now = this.clock.now();
    const conn: Conn = { id, ws, ip, log: this.log.child({ connId: id }), ...newConnState(now) };
    this.conns.set(id, conn);
    this.metrics.counters.connsOpened++;
    conn.log.info("conn open", { ip });

    const joinTimer = setTimeout(() => { if (!conn.authed) this.closeConn(conn, 4001, "join timeout"); }, this.cfg.joinTimeoutMs);
    ws.on("message", (data: unknown, isBinary: boolean) => this.onMessage(conn, data, isBinary));
    ws.on("close", () => { clearTimeout(joinTimer); this.closeConn(conn, 1000, "closed"); });
    ws.on("error", (err) => conn.log.warn("ws error", { err: String(err) }));
  }

  private onMessage(conn: Conn, data: unknown, isBinary: boolean): void {
    if (conn.closing) return;
    // Aggregate rate limit BEFORE parsing (cheap sliding 1s window); per-CLASS limits apply
    // after decode in the router (segmented buckets for input/control/stat/pong).
    const now = this.clock.now();
    conn.lastInboundAt = now; // any frame proves the link is alive (silent-drop detection)
    if (now - conn.rate.start >= 1000) { conn.rate.start = now; conn.rate.total = 0; conn.rate.input = 0; conn.rate.control = 0; conn.rate.stat = 0; conn.rate.pong = 0; }
    conn.rate.total++;
    this.metrics.counters.msgsIn++;
    if (conn.rate.total > this.cfg.maxMsgsPerSec) { this.metrics.counters.rateLimited++; this.closeConn(conn, 4003, "rate limit"); return; }
    // One connection's malformed/garbage input is ISOLATED — it can never throw into the tick loop.
    try {
      if (isBinary) throw new ProtocolError("binary frame");
      const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      this.router.handle(conn, raw);
    } catch (err) {
      if (err instanceof ProtocolError) {
        this.metrics.counters.malformed++;
        conn.malformed++;
        conn.log.debug("malformed message", { reason: err.message, count: conn.malformed });
        if (conn.malformed > MAX_MALFORMED) this.closeConn(conn, 4004, "malformed");
      } else {
        conn.log.error("message handler crashed (isolated)", { err: String(err) });
        this.closeConn(conn, 1011, "internal");
      }
    }
  }

  private rejectJoin(conn: Conn, code: string, reason: string): void {
    this.metrics.counters.joinsRejected++;
    if (code === "policy_required") this.metrics.counters.policyRequiredRejected++;
    else if (code === "policy_invalid") this.metrics.counters.policyInvalidRejected++;
    else if (code === "policy_mismatch") this.metrics.counters.policyMismatchRejected++;
    else if (code === "private_disabled") this.metrics.counters.privateDisabledRejected++;
    else if (code === "public_disabled") this.metrics.counters.publicDisabledRejected++;
    else if (code === "room_full") this.metrics.counters.roomFullRejected++;
    else if (code === "admission_unavailable") this.metrics.counters.admissionUnavailableRejected++;
    conn.log.warn("join rejected", { code, reason });
    try { conn.ws.send(jsonCodec.encodeServer({ t: "error", code, msg: reason })); } catch { /* ignore */ }
    this.closeConn(conn, 4001, code);
  }

  private closeConn(conn: Conn, code: number, reason: string): void {
    if (conn.closing) return;
    conn.closing = true;
    try { conn.ws.close(code, reason); } catch { /* already closing */ }
    // Unexpected closes (network death, heartbeat timeout, backpressure kick, peer vanishing)
    // reserve the player's body for the reconnect grace. Deliberate lifecycle closes never do:
    // join rejects (4001), game over (4008), superseded (4009), and a client `leave` (4010).
    const isDeliberate = SEATLESS_CLOSE_CODES.has(code) || conn.isLeaving || conn.gameOver;
    const isSeatReserved = !isDeliberate && conn.authed && conn.playerId !== null && conn.worldId !== null;
    this.sessions.unbind(conn, isSeatReserved ? { nowMs: this.clock.now(), ttlMs: this.cfg.resumeGraceMs } : undefined);
    if (isSeatReserved) {
      this.metrics.counters.seatsReserved++;
      conn.log.info("seat reserved (reconnect grace)", {
        authName: conn.authName ?? "", worldId: conn.worldId ?? "", playerId: conn.playerId ?? "", graceMs: this.cfg.resumeGraceMs,
      });
    }
    this.conns.delete(conn.id);
    const perIp = this.connsPerIp.get(conn.ip);
    if (perIp !== undefined) {
      if (perIp <= 1) this.connsPerIp.delete(conn.ip);
      else this.connsPerIp.set(conn.ip, perIp - 1);
    }
    this.metrics.counters.connsClosed++;
    conn.log.info("conn close", { code, reason, bytesSent: conn.bytesSent, droppedSnaps: conn.droppedSnaps });
  }

  health(): HealthReport {
    const nets = [...this.conns.values()].map((c) => ({
      rttMs: c.rttMs, cliJitterMs: c.cliJitterMs, cliReconciliations: c.cliReconciliations, cliCorrectionMaxPx: c.cliCorrectionMaxPx,
    }));
    return this.metrics.report(this.startedAt, this.clock.now(), this.sessions.roomCount(), this.sessions.totalPlayers(), this.conns.size, nets);
  }

  // Per-world occupancy for /worlds (control panel): which worlds exist, who is actually
  // connected to each, and whose seats are reserved for a reconnect — the ops answer to
  // "did the whole room land in one world?" and "who is mid-outage right now?".
  private worldReports(): WorldReport[] {
    const out: WorldReport[] = [];
    for (const room of this.sessions.rooms()) {
      const names: string[] = [];
      for (const conn of room.conns.values()) {
        if (!conn.closing && conn.playerId !== null) names.push(conn.displayName ?? conn.playerId);
      }
      const away: string[] = [];
      for (const seat of room.seats()) away.push(seat.displayName ?? seat.pid);
      out.push({
        id: room.id,
        players: room.playerCount,
        tick: room.state.tick,
        floor: room.state.floor,
        names,
        away,
      });
    }
    return out;
  }

  // Test/introspection helpers.
  getWorld(id = DEFAULT_WORLD_ID): RoomRuntime | undefined {
    return this.sessions.room(id);
  }
  get fixedDt(): number {
    return FIXED_DT;
  }
}
