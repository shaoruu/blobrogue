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
import { createHttpHandler, type WorldReport } from "./httpEndpoints.js";
import type { SessionStore, SnapshotPublisher, RoomRuntime } from "./ports.js";

const TICK_MS = 1000 / TICK_HZ;
// Catch-up bound for the drift-corrected pump: if the event loop stalls, run up to this many
// ticks in one pump to keep simulation time matched to real time (one input command is consumed
// per tick, so dropping ticks would slow movement). ~1s of catch-up tolerates GC/scheduling
// hitches (and in-process test contention) without a spiral of death.
const MAX_CATCHUP = 20;
const MAX_MALFORMED = 3;
// Close codes that are part of the deliberate lifecycle — never grounds for a reconnect seat:
// join rejects, game over, superseded connections, and explicit client leaves.
const SEATLESS_CLOSE_CODES: ReadonlySet<number> = new Set([4001, 4008, 4009, 4010]);

// Optional dependency overrides (DI) for tests / alternative backends. Anything omitted uses the
// production default.
export interface ServerDeps {
  logger?: Logger;
  clock?: Clock;
  sessions?: SessionStore;
  publisher?: SnapshotPublisher;
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
    // The room factory picks the world MODE from the world IDENTITY: a pvp world id (minted only
    // for a pvp room) spins up a deathmatch world, everything else stays co-op. The mode is part
    // of the id, so every joiner of the same room lands in the same kind of world.
    this.sessions = deps.sessions ?? new WorldRegistry((id) => new GameWorld(id, undefined, cfg.arena, isPvpWorldId(id) ? "pvp" : "coop"), this.log);
    this.publisher = deps.publisher ?? new WsSnapshotPublisher({
      config: cfg,
      metrics: this.metrics,
      codec: jsonCodec,
      kick: (conn, code, reason) => this.closeConn(conn, code, reason),
    });
    this.router = new MessageRouter({
      config: cfg, clock: this.clock, metrics: this.metrics,
      sessions: this.sessions, publisher: this.publisher, codec: jsonCodec,
      reject: (conn, code, reason) => this.rejectJoin(conn, code, reason),
      close: (conn, code, reason) => this.closeConn(conn, code, reason),
    });

    this.http = createServer(createHttpHandler({ config: cfg, health: () => this.health(), worlds: () => this.worldReports() }));
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
    for (const conn of this.conns.values()) {
      try { conn.ws.close(1001, "server shutdown"); } catch { /* already gone */ }
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    this.log.info("closed");
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
      try { room.step(this.cfg); } catch (err) { this.log.error("world step failed", { worldId: room.id, err: String(err) }); }
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
    for (const pid of room.gameOverPlayers()) {
      const conn = this.connForPlayer(room, pid);
      if (conn && !conn.closing) { conn.gameOver = true; this.closeConn(conn, 4008, "game over"); }
    }
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
      out.push({ id: room.id, players: room.playerCount, tick: room.state.tick, names, away });
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
