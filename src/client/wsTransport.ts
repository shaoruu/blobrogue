// WSTransport: the multiplayer implementation of the same Transport seam LocalTransport
// implements (Stage A), so the client's frame loop is IDENTICAL for solo and online. It runs
// the SHARED stepPlayerPhase to PREDICT the local player at zero latency, RECONCILES against
// each authoritative snapshot (drop acked inputs, replay the rest), and renders remote
// entities (other players + all enemies + bullets) from snapshots — players/enemies through
// the shipped interp.ts buffer, bullets by short dead-reckoning.
//
// This module is environment-neutral (no DOM globals referenced by type) so the headless
// harness can drive the EXACT client netcode through an injected socket. The browser passes a
// native-WebSocket factory; the harness passes a `ws` (optionally latency-wrapped) one.

import type { Transport, PollResult } from "./transport.js";
import { createWorld, stepPlayerPhase } from "../sim/world.js";
import type { WorldState, PlayerSim } from "../sim/world.js";
import type { SimEvent } from "../sim/events.js";
import type { InputCmd, PlayerId } from "../sim/input.js";
import { LOCAL_ID } from "../sim/input.js";
import type { RemotePlayer } from "../sim/types.js";
import { RemoteInterp } from "../net/interp.js";
import {
  jsonCodec, applySelfWire, enemyFromWire, bulletFromWire,
  propFromWire, pickupFromWire, chestFromWire,
  STAGE_B_SEED, STAGE_B_FLOOR, PROTOCOL_VERSION,
  type ServerMsg,
} from "../net/protocol.js";
import type { Enemy, Bullet, Prop, Pickup, Chest } from "../sim/types.js";

// Minimal socket surface (a subset shared by browser WebSocket and the `ws` package).
export interface SocketLike {
  send(data: string): void;
  close(): void;
  readyState: number;
  bufferedAmount: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type ConnStatus = "connecting" | "open" | "closed" | "error";

export interface WSTransportOptions {
  url: string;
  getTicket: () => Promise<string>;
  socketFactory?: (url: string) => SocketLike;
  now?: () => number;
  onStatus?: (s: ConnStatus) => void;
}

const SOCKET_OPEN = 1;
// A correction smaller than this glides over a few frames (invisible); anything larger is a
// genuine divergence (knockback/teleport) and snaps immediately.
const SMOOTH_MAX_PX = 96;
// Fraction of the remaining smoothing error retired per second (higher = snappier).
const SMOOTH_RETIRE_PER_SEC = 12;
// Cap the unacked-input ring so a long stall can't grow it without bound.
const MAX_PENDING = 256;

interface PendingInput {
  seq: number;
  dt: number;
  cmd: InputCmd;
}

function defaultSocketFactory(url: string): SocketLike {
  const g = globalThis as { WebSocket?: new (url: string) => SocketLike };
  if (!g.WebSocket) throw new Error("no WebSocket implementation available");
  return new g.WebSocket(url);
}

function nowMs(): number {
  return Date.now();
}

// Player-scoped events carry a `pid`; enemy/world events do not.
function pidOf(e: SimEvent): PlayerId | undefined {
  return (e as { pid?: PlayerId }).pid;
}

// A stable palette slot from a "p<connId>" world id, so each remote blob keeps its color.
function colorIndexFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % 8;
}

export class WSTransport implements Transport {
  private opts: WSTransportOptions;
  private now: () => number;
  private socket: SocketLike | null = null;
  private status: ConnStatus = "closed";
  private stopped = false;

  // predState: the true predicted world (local player only) — target of prediction + replay.
  // renderState: what the game renders — local player = predicted + smoothing, remotes from snaps.
  private predState!: WorldState;
  private renderState!: WorldState;

  private pending: PendingInput[] = [];
  private nextInput: InputCmd | null = null;
  private seq = 0;

  private latestSnap: Extract<ServerMsg, { t: "snap" }> | null = null;
  private snapRecvAt = 0;
  private selfServerId: PlayerId | null = null;
  private joinTicket: string | null = null;
  private lastJoinAt = 0;

  private interp = new RemoteInterp();
  private events: SimEvent[] = [];
  private smoothX = 0;
  private smoothY = 0;

  // observability for the harness / HUD
  bytesRecv = 0;
  snapsRecv = 0;
  lastError: string | null = null;

  constructor(opts: WSTransportOptions) {
    this.opts = opts;
    this.now = opts.now ?? nowMs;
  }

  start(): void {
    // seed/floor are fixed by the protocol for the Stage-B arena; the passed args (a random
    // solo seed) are intentionally ignored — the server owns the world.
    this.predState = createWorld(STAGE_B_SEED, STAGE_B_FLOOR, { isSandbox: true });
    this.renderState = createWorld(STAGE_B_SEED, STAGE_B_FLOOR, { isSandbox: true });
    this.pending = [];
    this.nextInput = null;
    this.seq = 0;
    this.latestSnap = null;
    this.selfServerId = null;
    this.events = [];
    this.smoothX = 0;
    this.smoothY = 0;
    this.stopped = false;
    void this.connect();
  }

  private async connect(): Promise<void> {
    this.setStatus("connecting");
    let ticket: string;
    try {
      ticket = await this.opts.getTicket();
    } catch (err) {
      this.lastError = "ticket: " + String(err);
      this.setStatus("error");
      return;
    }
    if (this.stopped) return;
    const factory = this.opts.socketFactory ?? defaultSocketFactory;
    let sock: SocketLike;
    try {
      sock = factory(this.opts.url);
    } catch (err) {
      this.lastError = "socket: " + String(err);
      this.setStatus("error");
      return;
    }
    this.socket = sock;
    this.joinTicket = ticket;
    sock.onopen = () => {
      this.setStatus("open");
      this.sendJoin();
    };
    sock.onmessage = (ev) => this.onMessage(ev.data);
    sock.onclose = () => { this.socket = null; this.setStatus("closed"); };
    sock.onerror = (err) => { this.lastError = String(err); this.setStatus("error"); };
  }

  private setStatus(s: ConnStatus): void {
    this.status = s;
    this.opts.onStatus?.(s);
  }

  private sendJoin(): void {
    if (!this.joinTicket) return;
    this.lastJoinAt = this.now();
    this.sendMsg({ t: "join", ticket: this.joinTicket, protocol: PROTOCOL_VERSION });
  }

  private sendMsg(msg: Parameters<typeof jsonCodec.encodeClient>[0]): void {
    const sock = this.socket;
    if (!sock || sock.readyState !== SOCKET_OPEN) return;
    try {
      sock.send(jsonCodec.encodeClient(msg));
    } catch {
      /* socket closing; onclose will fire */
    }
  }

  private onMessage(data: unknown): void {
    const raw = typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : String(data);
    this.bytesRecv += raw.length;
    let msg: ServerMsg;
    try {
      msg = jsonCodec.decodeServer(raw);
    } catch {
      return; // corrupt frame; ignore (server is trusted, this is belt-and-suspenders)
    }
    if (msg.t === "ping") {
      this.sendMsg({ t: "pong", id: msg.id });
      return;
    }
    if (msg.t === "error") {
      this.lastError = `${msg.code}: ${msg.msg}`;
      return;
    }
    this.ingestSnapshot(msg);
  }

  private ingestSnapshot(snap: Extract<ServerMsg, { t: "snap" }>): void {
    this.latestSnap = snap;
    this.snapRecvAt = this.now();
    this.snapsRecv++;
    if (snap.selfId) this.selfServerId = snap.selfId;

    if (snap.self) this.reconcile(snap);

    // Feed remote entities into the interpolation buffer (positions only; the rest is discrete).
    const now = this.snapRecvAt;
    const live = new Set<string>();
    for (const e of snap.enemies) {
      const key = "e" + e.id;
      live.add(key);
      this.interp.ingest(key, snap.tick, e.x, e.y, 0, now);
    }
    for (const p of snap.players) {
      const key = "p" + p.id;
      live.add(key);
      this.interp.ingest(key, snap.tick, p.x, p.y, p.aim, now);
    }
    this.interp.retain(live);

    // Props are near-static shared state; mirror them into the PREDICTED world so local movement
    // prediction collides with the same barrels/crates the server does (no rubber-band near
    // props). They only change on break, so rebuilding per snapshot is cheap.
    this.predState.props = snap.props.map(propFromWire);

    // Queue juice: keep global (enemy/world) events + this client's own player events.
    for (const e of snap.events) {
      const pid = pidOf(e);
      if (pid === undefined || pid === this.selfServerId) this.events.push(e);
    }
  }

  // Snap the predicted local player to authoritative truth, drop acked inputs, replay the rest.
  private reconcile(snap: Extract<ServerMsg, { t: "snap" }>): void {
    const p = this.predState.players.get(LOCAL_ID)!;
    const beforeX = p.x, beforeY = p.y;
    applySelfWire(p, snap.self!);
    this.pending = this.pending.filter((i) => i.seq > snap.ackSeq);
    const scratch: SimEvent[] = [];
    for (const inp of this.pending) stepPlayerPhase(this.predState, p, inp.cmd, inp.dt, scratch);
    // Fold the correction into the smoothing offset so it glides instead of snapping — unless
    // it is large (a real server-side displacement), which we let snap.
    const errX = beforeX - p.x, errY = beforeY - p.y;
    if (Math.hypot(errX, errY) <= SMOOTH_MAX_PX) {
      this.smoothX += errX;
      this.smoothY += errY;
      if (Math.hypot(this.smoothX, this.smoothY) > SMOOTH_MAX_PX) { this.smoothX = 0; this.smoothY = 0; }
    } else {
      this.smoothX = 0;
      this.smoothY = 0;
    }
  }

  sendInput(cmd: InputCmd): void {
    this.nextInput = cmd;
  }

  advance(dt: number): void {
    // A lost join handshake (packet loss on connect) would otherwise strand the client. While
    // connected but not yet acknowledged (no snapshot), resend the join periodically. A
    // duplicate join after success is a harmless no-op server-side, and tick broadcasts heal a
    // lost initial full snapshot on their own.
    const sock = this.socket;
    if (sock && sock.readyState === SOCKET_OPEN && !this.isReady() && this.now() - this.lastJoinAt > 500) {
      this.sendJoin();
    }
    const cmd = this.nextInput;
    this.nextInput = null;
    if (cmd) {
      const p = this.predState.players.get(LOCAL_ID)!;
      const scratch: SimEvent[] = [];
      if (this.isReady()) {
        // Joined: stamp + ring + send for server reconciliation, then predict.
        const seq = ++this.seq;
        const stamped: InputCmd = { ...cmd, seq };
        this.pending.push({ seq, dt, cmd: stamped });
        while (this.pending.length > MAX_PENDING) this.pending.shift();
        this.sendMsg({ t: "input", seq, dt, mx: cmd.moveX, my: cmd.moveY, aim: cmd.aim, fire: cmd.firing, dash: cmd.dash });
        stepPlayerPhase(this.predState, p, stamped, dt, scratch);
      } else {
        // Pre-join: predict locally for instant feel, but don't send inputs before the join is
        // acknowledged (a reordered input arriving before the join would be dropped server-side).
        // The first snapshot snaps us to the authoritative spawn, discarding this transient.
        stepPlayerPhase(this.predState, p, cmd, dt, scratch);
      }
    }
    // Retire the smoothing error over a few frames.
    const k = Math.min(1, dt * SMOOTH_RETIRE_PER_SEC);
    this.smoothX -= this.smoothX * k;
    this.smoothY -= this.smoothY * k;
    if (Math.abs(this.smoothX) < 0.05) this.smoothX = 0;
    if (Math.abs(this.smoothY) < 0.05) this.smoothY = 0;
  }

  poll(): PollResult {
    const rp = this.renderState.players.get(LOCAL_ID)!;
    const pp = this.predState.players.get(LOCAL_ID)!;
    this.copyPlayer(rp, pp);
    rp.x = pp.x + this.smoothX;
    rp.y = pp.y + this.smoothY;

    this.renderState.enemies = this.composeEnemies();
    this.renderState.bullets = this.composeBullets();
    this.renderState.props = this.composeProps();
    this.renderState.pickups = this.composePickups();
    this.renderState.chests = this.composeChests();
    this.renderState.floor = this.latestSnap ? this.latestSnap.floor : this.renderState.floor;

    const events = this.events;
    this.events = [];
    return { state: this.renderState, events, ackSeq: this.latestSnap?.ackSeq ?? 0 };
  }

  private composeEnemies(): Enemy[] {
    const snap = this.latestSnap;
    if (!snap) return [];
    const now = this.now();
    const out: Enemy[] = [];
    for (const w of snap.enemies) {
      const pose = this.interp.sample("e" + w.id, now);
      out.push(enemyFromWire(w, pose ? pose.x : w.x, pose ? pose.y : w.y));
    }
    return out;
  }

  private composeBullets(): Bullet[] {
    const snap = this.latestSnap;
    if (!snap) return [];
    // Short dead-reckoning by velocity from the snapshot time keeps fast bullets smooth
    // between 20Hz updates without a per-bullet id/interp buffer.
    const age = Math.max(0, (this.now() - this.snapRecvAt) / 1000);
    const out: Bullet[] = [];
    for (const w of snap.bullets) {
      const b = bulletFromWire(w);
      b.x += b.vx * age;
      b.y += b.vy * age;
      out.push(b);
    }
    return out;
  }

  // Shared world content rebuilt from the authoritative snapshot (discrete state; rendered
  // directly, no interpolation — they only change on break/open/collect).
  private composeProps(): Prop[] {
    const snap = this.latestSnap;
    return snap ? snap.props.map(propFromWire) : [];
  }
  private composePickups(): Pickup[] {
    const snap = this.latestSnap;
    return snap ? snap.pickups.map(pickupFromWire) : [];
  }
  private composeChests(): Chest[] {
    const snap = this.latestSnap;
    return snap ? snap.chests.map(chestFromWire) : [];
  }

  private copyPlayer(dst: PlayerSim, src: PlayerSim): void {
    dst.hp = src.hp; dst.maxHp = src.maxHp; dst.invuln = src.invuln;
    dst.dashCd = src.dashCd; dst.dashTime = src.dashTime; dst.dashDx = src.dashDx; dst.dashDy = src.dashDy;
    dst.fireCd = src.fireCd; dst.facing = src.facing; dst.aimAngle = src.aimAngle;
    dst.weapon = src.weapon; dst.isDown = src.isDown;
    dst.coins = src.coins; dst.kills = src.kills; dst.combo = src.combo; dst.comboTimer = src.comboTimer;
    dst.meleeSwing = src.meleeSwing;
  }

  // Other players for the client's remote-player renderer (interpolated, never predicted).
  remotePlayers(): RemotePlayer[] {
    const snap = this.latestSnap;
    if (!snap) return [];
    const now = this.now();
    return snap.players.map((p) => {
      const pose = this.interp.sample("p" + p.id, now);
      return {
        playerId: p.id, name: p.id,
        x: pose ? pose.x : p.x,
        y: pose ? pose.y : p.y,
        facing: p.fac,
        hp: p.hp, maxHp: p.mhp,
        weapon: p.wpn, floor: STAGE_B_FLOOR,
        isDown: p.down,
        aimAngle: pose ? pose.aimAngle : p.aim,
        shotSeq: 0,
        colorIndex: colorIndexFor(p.id),
        updatedAt: now,
      };
    });
  }

  isReady(): boolean {
    return this.latestSnap !== null;
  }
  getStatus(): ConnStatus {
    return this.status;
  }

  // ---- read-only introspection (HUD / harness / tests) ----
  getSelfServerId(): PlayerId | null {
    return this.selfServerId;
  }
  // The current predicted local-player position (true prediction, pre-smoothing).
  getPredictedSelf(): { x: number; y: number } {
    const p = this.predState.players.get(LOCAL_ID)!;
    return { x: p.x, y: p.y };
  }
  // The latest authoritative snapshot, for adversity/measurement harnesses.
  getLatestSnapshot(): Extract<ServerMsg, { t: "snap" }> | null {
    return this.latestSnap;
  }

  stop(): void {
    this.stopped = true;
    const sock = this.socket;
    this.socket = null;
    if (sock) {
      try { sock.close(); } catch { /* ignore */ }
    }
  }
}
