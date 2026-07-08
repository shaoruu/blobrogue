// The authoritative game server: an HTTP server (/healthz, /metrics, and a local-only
// /dev-ticket) with a WebSocket endpoint on GS_WS_PATH, a Map<worldId, GameWorld> registry,
// and a drift-corrected fixed 20Hz tick loop that runs the SHARED stepWorld and streams
// per-client snapshots. Every production-essential-at-B property lives here: strict validated
// decoding in a per-connection try/catch, auth on join, per-connection rate limits, bounded
// input queues, heartbeat/timeout, output backpressure (never await a socket write), and
// structured logs — a malformed or flooding connection can never crash the tick loop.

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { WebSocketServer, type WebSocket } from "ws";

import { jsonCodec, buildSnapshot, TICK_HZ, FIXED_DT, PROTOCOL_VERSION, ProtocolError } from "../../src/net/protocol.js";
import { verifyTicket, mintTicket } from "./auth.js";
import type { ServerConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { GameWorld } from "./world.js";
import { inputToIntent, type Conn } from "./connection.js";
import { Rolling, newCounters, type Counters } from "./metrics.js";

const TICK_MS = 1000 / TICK_HZ;
const MAX_CATCHUP = 5; // if we fall this far behind, drop the backlog rather than spiral
const DEFAULT_WORLD_ID = "arena-1";
const MAX_MALFORMED = 3;

export interface HealthReport {
  status: string;
  uptimeSec: number;
  worlds: number;
  players: number;
  connections: number;
  tickMs_p50: number;
  tickMs_p95: number;
  tickMs_max: number;
  counters: Counters;
}

export class GameServer {
  private cfg: ServerConfig;
  private log: Logger;
  private http: HttpServer;
  private wss: WebSocketServer;

  private worlds = new Map<string, GameWorld>();
  private conns = new Map<number, Conn>();
  private connsPerIp = new Map<string, number>();
  private nextConnId = 1;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private nextTickAt = 0;
  private startedAt = 0;

  private tickMetric = new Rolling(1200); // ~60s at 20Hz
  private counters = newCounters();

  constructor(cfg: ServerConfig, log?: Logger) {
    this.cfg = cfg;
    this.log = log ?? createLogger({ app: "blobrogue-gs" });
    this.http = createServer((req, res) => this.onHttpRequest(req, res));
    this.wss = new WebSocketServer({ server: this.http, path: cfg.wsPath, maxPayload: 8 * 1024 });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
  }

  // Start listening + the tick + heartbeat loops. Resolves with the bound port (supports port
  // 0 for ephemeral test ports).
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.cfg.port, this.cfg.host, () => {
        const addr = this.http.address();
        const port = typeof addr === "object" && addr ? addr.port : this.cfg.port;
        this.startedAt = Date.now();
        this.nextTickAt = performance.now();
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

  // ---- tick loop (drift-corrected accumulator on a monotonic clock) ----

  private pump(): void {
    const now = performance.now();
    let steps = 0;
    while (now - this.nextTickAt >= 0 && steps < MAX_CATCHUP) {
      this.tickOnce();
      this.nextTickAt += TICK_MS;
      steps++;
    }
    if (steps >= MAX_CATCHUP) this.nextTickAt = now; // fell behind: resync, don't spiral
  }

  private tickOnce(): void {
    const t0 = performance.now();
    for (const world of this.worlds.values()) {
      try {
        world.step(this.cfg);
      } catch (err) {
        this.log.error("world step failed", { worldId: world.id, err: String(err) });
      }
    }
    for (const world of this.worlds.values()) this.broadcast(world);
    const dur = performance.now() - t0;
    this.tickMetric.push(dur);
    if (dur > TICK_MS) this.log.warn("tick over budget", { ms: Number(dur.toFixed(2)), budget: TICK_MS });
  }

  private broadcast(world: GameWorld): void {
    for (const conn of world.conns.values()) {
      if (conn.playerId === null || conn.closing) continue;
      this.sendSnapshot(conn, world, false);
    }
  }

  private sendSnapshot(conn: Conn, world: GameWorld, full: boolean): void {
    // Output backpressure: NEVER await/block on a slow client. Skip this tick if its buffer is
    // backed up; disconnect if it stays hopelessly behind (they'd interpolate the gap anyway).
    const buffered = conn.ws.bufferedAmount;
    if (buffered > this.cfg.slowClientKickBytes) {
      this.closeConn(conn, 4005, "too slow");
      return;
    }
    if (buffered > this.cfg.sendBufferLimit) {
      conn.droppedSnaps++;
      this.counters.droppedSnaps++;
      return;
    }
    const events = full ? [] : world.lastEvents;
    // Full snapshots (join) send everything to bootstrap; per-tick snapshots are interest-filtered.
    const interestRadius = full ? 0 : this.cfg.interestRadius;
    const msg = buildSnapshot(world.state, conn.playerId!, conn.lastAppliedSeq, events, full, { interestRadius });
    const raw = jsonCodec.encodeServer(msg);
    try {
      conn.ws.send(raw);
    } catch {
      return; // socket closing; the close handler will clean up
    }
    const bytes = Buffer.byteLength(raw);
    conn.bytesSent += bytes;
    this.counters.bytesOut += bytes;
    this.counters.msgsOut++;
  }

  // ---- heartbeat / timeout ----

  private heartbeat(): void {
    const now = Date.now();
    for (const conn of this.conns.values()) {
      if (conn.closing) continue;
      if (conn.awaitingPong) {
        conn.missedPings++;
        if (conn.missedPings >= this.cfg.heartbeatMisses) {
          this.closeConn(conn, 4002, "heartbeat timeout");
          continue;
        }
      }
      conn.awaitingPong = true;
      conn.lastPingSentAt = now;
      const world = conn.worldId ? this.worlds.get(conn.worldId) : null;
      const tick = world ? world.state.tick : 0;
      try {
        conn.ws.send(jsonCodec.encodeServer({ t: "ping", id: conn.nextPingId++, tick, time: now }));
      } catch { /* closing */ }
    }
  }

  // ---- connection lifecycle ----

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const ip = req.socket.remoteAddress ?? "unknown";
    const perIp = this.connsPerIp.get(ip) ?? 0;
    if (perIp >= this.cfg.maxConnsPerIp) {
      try { ws.close(4006, "too many connections"); } catch { /* ignore */ }
      this.log.warn("conn rejected: per-ip cap", { ip });
      return;
    }
    this.connsPerIp.set(ip, perIp + 1);

    const id = this.nextConnId++;
    const now = Date.now();
    const conn: Conn = {
      id, ws, ip, log: this.log.child({ connId: id }),
      authed: false, playerId: null, authName: null, worldId: null, malformed: 0,
      connectedAt: now, windowStart: now, windowCount: 0,
      queue: [], lastAppliedSeq: 0, lastInput: null, starveTicks: 0,
      lastPongAt: now, awaitingPong: false, missedPings: 0, nextPingId: 1,
      lastPingSentAt: 0, rttMs: 0,
      needsFullSnap: false, closing: false, bytesSent: 0, droppedSnaps: 0,
    };
    this.conns.set(id, conn);
    this.counters.connsOpened++;
    conn.log.info("conn open", { ip });

    // Must authenticate within the join window or get dropped (half-open / squatting sockets).
    const joinTimer = setTimeout(() => {
      if (!conn.authed) this.closeConn(conn, 4001, "join timeout");
    }, this.cfg.joinTimeoutMs);

    ws.on("message", (data: unknown, isBinary: boolean) => this.onMessage(conn, data, isBinary));
    ws.on("close", () => { clearTimeout(joinTimer); this.onClose(conn); });
    ws.on("error", (err) => conn.log.warn("ws error", { err: String(err) }));
  }

  private onMessage(conn: Conn, data: unknown, isBinary: boolean): void {
    if (conn.closing) return;
    // Rate limit BEFORE any parsing work (cheap sliding 1s window).
    const now = Date.now();
    if (now - conn.windowStart >= 1000) { conn.windowStart = now; conn.windowCount = 0; }
    conn.windowCount++;
    this.counters.msgsIn++;
    if (conn.windowCount > this.cfg.maxMsgsPerSec) {
      this.counters.rateLimited++;
      this.closeConn(conn, 4003, "rate limit");
      return;
    }
    // Everything below is wrapped so one connection's malformed/garbage input is ISOLATED —
    // it can never throw into the tick loop (production spec §2e).
    try {
      if (isBinary) throw new ProtocolError("binary frame");
      const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      const msg = jsonCodec.decodeClient(raw);
      switch (msg.t) {
        case "join": this.handleJoin(conn, msg.ticket, msg.protocol); break;
        case "input": this.handleInput(conn, msg); break;
        case "pong": this.handlePong(conn); break;
      }
    } catch (err) {
      if (err instanceof ProtocolError) {
        this.counters.malformed++;
        conn.malformed++;
        conn.log.debug("malformed message", { reason: err.message, count: conn.malformed });
        if (conn.malformed > MAX_MALFORMED) this.closeConn(conn, 4004, "malformed");
      } else {
        // An unexpected error handling ONE message must not take down the server.
        conn.log.error("message handler crashed (isolated)", { err: String(err) });
        this.closeConn(conn, 1011, "internal");
      }
    }
  }

  private handleJoin(conn: Conn, ticket: string, protocol: number): void {
    if (conn.authed) {
      try { conn.ws.send(jsonCodec.encodeServer({ t: "error", code: "already_joined", msg: "" })); } catch { /* ignore */ }
      return;
    }
    if (protocol !== 0 && protocol !== PROTOCOL_VERSION) {
      this.rejectJoin(conn, "protocol", `expected ${PROTOCOL_VERSION}`);
      return;
    }
    const auth = verifyTicket(this.cfg.auth, ticket);
    if (!auth.ok || !auth.playerId) {
      this.rejectJoin(conn, "auth", auth.reason ?? "unauthorized");
      return;
    }
    conn.authed = true;
    conn.authName = auth.playerId;
    conn.playerId = "p" + conn.id; // world id is per-connection; auth identity kept for logs
    const world = this.ensureWorld(DEFAULT_WORLD_ID);
    world.addPlayer(conn.playerId);
    world.conns.set(conn.id, conn);
    conn.worldId = world.id;
    conn.lastPongAt = Date.now();
    this.counters.joinsOk++;
    conn.log.info("join ok", { authName: conn.authName, playerId: conn.playerId, worldId: world.id });
    // Prompt initial FULL snapshot (carries selfId + authoritative spawn) — don't wait a tick.
    this.sendSnapshot(conn, world, true);
  }

  private rejectJoin(conn: Conn, code: string, reason: string): void {
    this.counters.joinsRejected++;
    conn.log.warn("join rejected", { code, reason });
    try { conn.ws.send(jsonCodec.encodeServer({ t: "error", code, msg: reason })); } catch { /* ignore */ }
    this.closeConn(conn, 4001, code);
  }

  private handleInput(conn: Conn, msg: { seq: number; dt: number; mx: number; my: number; aim: number; fire: boolean; dash: boolean }): void {
    // Drop inputs that arrive before the join is bound — under jitter an input can be reordered
    // ahead of the join, so this is expected and must NOT kill the connection (the join timeout
    // handles a client that never authenticates at all).
    if (!conn.authed) { this.counters.rejectedInputs++; return; }
    conn.queue.push(inputToIntent(msg));
    // Bounded queue (backpressure): drop OLDEST beyond the cap so a fast client can't flood the
    // tick loop or gain an advantage by piling up inputs.
    while (conn.queue.length > this.cfg.maxInputQueue) {
      conn.queue.shift();
      this.counters.rejectedInputs++;
    }
  }

  private handlePong(conn: Conn): void {
    conn.awaitingPong = false;
    conn.missedPings = 0;
    const now = Date.now();
    conn.lastPongAt = now;
    if (conn.lastPingSentAt > 0) {
      const sample = now - conn.lastPingSentAt;
      // EWMA so a single jittery sample doesn't swing the rewind; seed on first sample.
      conn.rttMs = conn.rttMs === 0 ? sample : conn.rttMs * 0.7 + sample * 0.3;
    }
  }

  private onClose(conn: Conn): void {
    this.closeConn(conn, 1000, "closed");
  }

  private closeConn(conn: Conn, code: number, reason: string): void {
    if (conn.closing) return;
    conn.closing = true;
    try { conn.ws.close(code, reason); } catch { /* already closing */ }
    if (conn.worldId) {
      const world = this.worlds.get(conn.worldId);
      if (world && conn.playerId) {
        world.removePlayer(conn.playerId);
        world.conns.delete(conn.id);
      }
    }
    this.conns.delete(conn.id);
    const perIp = this.connsPerIp.get(conn.ip);
    if (perIp !== undefined) {
      if (perIp <= 1) this.connsPerIp.delete(conn.ip);
      else this.connsPerIp.set(conn.ip, perIp - 1);
    }
    this.counters.connsClosed++;
    conn.log.info("conn close", { code, reason, bytesSent: conn.bytesSent, droppedSnaps: conn.droppedSnaps });
  }

  private ensureWorld(id: string): GameWorld {
    let world = this.worlds.get(id);
    if (!world) {
      world = new GameWorld(id);
      this.worlds.set(id, world);
      this.log.info("world created", { worldId: id });
    }
    return world;
  }

  // ---- HTTP endpoints (loopback only; never proxied publicly) ----

  private onHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET") { res.writeHead(405).end(); return; }
    if (url.pathname === "/healthz") {
      const body = JSON.stringify(this.health());
      res.writeHead(200, { "content-type": "application/json" }).end(body);
      return;
    }
    if (url.pathname === "/metrics") {
      const h = this.health();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...h.counters, ...{ tickMs_p50: h.tickMs_p50, tickMs_p95: h.tickMs_p95, tickMs_max: h.tickMs_max, worlds: h.worlds, players: h.players, connections: h.connections } }));
      return;
    }
    if (url.pathname === "/dev-ticket") {
      // Local-only convenience: mint a ticket for a browser tab so it can connect without a
      // Convex minter. Enabled ONLY when the dev bypass is on (never in production).
      if (!this.cfg.auth.allowDev) { res.writeHead(404).end(); return; }
      const playerId = (url.searchParams.get("playerId") ?? "guest-" + Math.random().toString(36).slice(2, 8)).slice(0, 48);
      const ticket = this.cfg.auth.secret ? mintTicket(this.cfg.auth.secret, playerId) : "dev:" + playerId;
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }).end(JSON.stringify({ ticket, playerId }));
      return;
    }
    res.writeHead(404).end();
  }

  health(): HealthReport {
    let players = 0;
    for (const w of this.worlds.values()) players += w.playerCount;
    return {
      status: "ok",
      uptimeSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      worlds: this.worlds.size,
      players,
      connections: this.conns.size,
      tickMs_p50: Number(this.tickMetric.percentile(50).toFixed(3)),
      tickMs_p95: Number(this.tickMetric.percentile(95).toFixed(3)),
      tickMs_max: Number(this.tickMetric.max().toFixed(3)),
      counters: { ...this.counters },
    };
  }

  // Test/introspection helpers.
  getWorld(id = DEFAULT_WORLD_ID): GameWorld | undefined {
    return this.worlds.get(id);
  }
  get fixedDt(): number {
    return FIXED_DT;
  }
}
