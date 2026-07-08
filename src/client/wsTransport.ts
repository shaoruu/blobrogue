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
import { createWorld, stepPlayerPhase, loadFloorIntoWorld } from "../sim/world.js";
import type { WorldState, PlayerSim } from "../sim/world.js";
import type { SimEvent } from "../sim/events.js";
import type { InputCmd, PlayerId } from "../sim/input.js";
import { LOCAL_ID } from "../sim/input.js";
import type { RemotePlayer, WeaponId } from "../sim/types.js";
import { RemoteInterp } from "../net/interp.js";
import {
  jsonCodec, applySelfWire, enemyFromWire, bulletFromWire,
  propFromWire, pickupFromWire, chestFromWire,
  STAGE_B_SEED, STAGE_B_FLOOR, PROTOCOL_VERSION, FIXED_DT,
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
  cmd: InputCmd;   // applied at the FIXED step (the server tick owns time; no per-input dt)
  sentAt: number;  // local time the command was sent (for RTT = ack time - sentAt)
}

// Cap fixed steps simulated in one frame so a long stall (tab backgrounded) can't spiral.
const MAX_STEPS_PER_FRAME = 5;

// Adaptive interpolation delay bounds (ms). Floor keeps ~2 snapshot intervals so two keyframes
// almost always straddle the render clock; ceiling caps how laggy remotes get under bad jitter.
const INTERP_MIN_MS = 90;
const INTERP_MAX_MS = 300;
const SNAP_INTERVAL_MS = 50; // 20Hz authoritative snapshot cadence

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
  private lastStatAt = 0;

  // Fixed-timestep prediction (matches the server tick): accumulate real frame time and step the
  // predicted local player exactly FIXED_DT per step, sampling+sending one input command per step.
  // This makes input cadence frame-rate independent (a 240Hz client sends the same ~20 cmds/s as a
  // 30Hz client) and carries NO client dt (the server tick owns simulation time).
  private accumulator = 0;
  // Render extrapolation: the predicted position before + after the latest fixed step, so the
  // local player renders smoothly between 20Hz steps (extrapolate by the leftover accumulator).
  private prevPredX = 0;
  private prevPredY = 0;

  // Reliable-event channel: the highest event id processed (dedupe: ignore ids <= this; ack: send
  // this back so the server stops resending). Defends against backpressure-dropped snapshots.
  private lastEventId = 0;
  private lastOfferId = 0;      // dedupe repeated (resent) offers
  private lastSnapTick = -1;    // reject stale / out-of-order snapshots (H4)

  // Authoritative shared-world tracking: the client rebuilds the identical dungeon geometry when
  // the server's seed/floor changes (party-wide descend), so movement prediction collides with
  // the same walls the server does.
  private curSeed = -1;
  private curFloor = -1;
  // A server-decided blessing offer waiting to be shown (consumed by the game each frame).
  private pendingOffer: string[] | null = null;

  // observability for the harness / HUD
  bytesRecv = 0;
  snapsRecv = 0;
  lastError: string | null = null;

  // ---- adaptive netcode telemetry (Stage C) ----
  private rttMs = 0;                 // measured input->ack round trip (EWMA)
  private jitterMs = 0;              // EWMA deviation of snapshot inter-arrival from the cadence
  private lastSnapAtForJitter = 0;
  private clockOffsetMs = 0;         // serverTime - localTime estimate (from ping.time)
  private reconcileCount = 0;        // corrections applied beyond a sub-pixel threshold
  private correctionEwmaPx = 0;      // smoothed correction magnitude
  private correctionMaxPx = 0;       // worst correction seen

  constructor(opts: WSTransportOptions) {
    this.opts = opts;
    this.now = opts.now ?? nowMs;
  }

  start(): void {
    // The server owns the world; the passed args (a random solo seed) are ignored. Build a
    // placeholder real-dungeon world for pre-join prediction; the first snapshot's seed/floor
    // rebuilds it to match the authoritative geometry (see maybeRebuildWorld).
    this.curSeed = STAGE_B_SEED;
    this.curFloor = STAGE_B_FLOOR;
    this.predState = createWorld(STAGE_B_SEED, STAGE_B_FLOOR, {});
    this.renderState = createWorld(STAGE_B_SEED, STAGE_B_FLOOR, {});
    this.pendingOffer = null;
    this.pending = [];
    this.nextInput = null;
    this.seq = 0;
    this.latestSnap = null;
    this.selfServerId = null;
    this.events = [];
    this.smoothX = 0;
    this.smoothY = 0;
    this.rttMs = 0;
    this.jitterMs = 0;
    this.lastSnapAtForJitter = 0;
    this.clockOffsetMs = 0;
    this.reconcileCount = 0;
    this.correctionEwmaPx = 0;
    this.correctionMaxPx = 0;
    this.lastStatAt = 0;
    this.accumulator = 0;
    this.lastEventId = 0;
    this.lastOfferId = 0;
    this.lastSnapTick = -1;
    const lp = this.predState.players.get(LOCAL_ID)!;
    this.prevPredX = lp.x; this.prevPredY = lp.y;
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
      // Clock sync: the server stamps its wall clock; offset ~= serverTime - localRecvTime (the
      // one-way latency is folded in, but half-RTT is small and this only drives HUD/metrics —
      // interpolation itself keys off local receive time, so it never needs a synced clock).
      const off = msg.time - this.now();
      this.clockOffsetMs = this.clockOffsetMs === 0 ? off : this.clockOffsetMs * 0.9 + off * 0.1;
      return;
    }
    if (msg.t === "error") {
      this.lastError = `${msg.code}: ${msg.msg}`;
      return;
    }
    if (msg.t === "offer") {
      // Idempotent: the server resends an offer (bounded) until the pick arrives; show each id
      // only once so resends never re-prompt.
      if (msg.id > this.lastOfferId) {
        this.lastOfferId = msg.id;
        this.pendingOffer = msg.choices.slice();
      }
      return;
    }
    this.ingestSnapshot(msg);
  }

  // Rebuild the client's predicted + render dungeon geometry to match the authoritative seed +
  // floor (initial join and every party-wide descend). Enemies/bullets/props ride the snapshot,
  // so only the walls + a local player need to exist; the next reconcile snaps self to truth.
  private maybeRebuildWorld(seed: number, floor: number): void {
    if (seed === this.curSeed && floor === this.curFloor) return;
    this.curSeed = seed;
    this.curFloor = floor;
    this.predState.seed = seed;
    this.renderState.seed = seed;
    loadFloorIntoWorld(this.predState, floor);
    loadFloorIntoWorld(this.renderState, floor);
    // A fresh floor is a hard teleport for every remote entity; drop stale interp history so
    // nothing slides across the new map for one render delay.
    this.interp = new RemoteInterp();
    this.smoothX = 0;
    this.smoothY = 0;
  }

  private ingestSnapshot(snap: Extract<ServerMsg, { t: "snap" }>): void {
    // Reject stale / out-of-order snapshots (H4): a full (join) snapshot always resyncs; otherwise
    // ignore any tick <= the last one processed (defends against reordering under the adversity
    // shim; on real ordered TCP this is a cheap belt-and-suspenders).
    if (!snap.full && snap.tick <= this.lastSnapTick) return;
    this.lastSnapTick = snap.tick;
    this.maybeRebuildWorld(snap.seed, snap.floor);
    this.latestSnap = snap;
    const prevSnapAt = this.lastSnapAtForJitter;
    this.snapRecvAt = this.now();
    this.snapsRecv++;
    if (snap.selfId) this.selfServerId = snap.selfId;

    // Jitter = EWMA deviation of snapshot inter-arrival from the 50ms cadence. Size the interp
    // delay adaptively: calmer link -> tighter (snappier remotes); jittery link -> wider buffer
    // so a late/dropped snapshot is covered by interpolation rather than a visible stall.
    if (prevSnapAt > 0) {
      const gap = this.snapRecvAt - prevSnapAt;
      const dev = Math.abs(gap - SNAP_INTERVAL_MS);
      this.jitterMs = this.jitterMs === 0 ? dev : this.jitterMs * 0.8 + dev * 0.2;
      const delay = Math.max(INTERP_MIN_MS, Math.min(INTERP_MAX_MS, 2 * SNAP_INTERVAL_MS + this.jitterMs * 2));
      this.interp.setRenderDelay(delay);
    }
    this.lastSnapAtForJitter = this.snapRecvAt;

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

    // Reliable event channel: events are id-tagged. Dedupe (skip ids already processed — a resent
    // event after a dropped snapshot arrives again) and advance the ack high-water mark. Keep only
    // global (enemy/world) events + this client's own player events.
    for (const w of snap.events) {
      if (w.id <= this.lastEventId) continue; // already processed (resend) — dedupe
      this.lastEventId = w.id;
      const e = w.e;
      const pid = pidOf(e);
      if (pid === undefined || pid === this.selfServerId) this.events.push(e);
    }
  }

  // Snap the predicted local player to authoritative truth, drop acked inputs, replay the rest.
  private reconcile(snap: Extract<ServerMsg, { t: "snap" }>): void {
    const p = this.predState.players.get(LOCAL_ID)!;
    const beforeX = p.x, beforeY = p.y;
    // RTT = time between sending the acked input and this snapshot confirming it.
    const acked = this.pending.find((i) => i.seq === snap.ackSeq);
    if (acked) {
      const sample = this.snapRecvAt - acked.sentAt;
      if (sample >= 0 && sample < 5000) this.rttMs = this.rttMs === 0 ? sample : this.rttMs * 0.8 + sample * 0.2;
    }
    applySelfWire(p, snap.self!);
    this.pending = this.pending.filter((i) => i.seq > snap.ackSeq);
    // Replay unacked commands at the SAME fixed step the server uses — deterministic replay is
    // what makes reconciliation converge exactly.
    const scratch: SimEvent[] = [];
    for (const inp of this.pending) stepPlayerPhase(this.predState, p, inp.cmd, FIXED_DT, scratch);
    // Fold the correction into the smoothing offset so it glides instead of snapping — unless
    // it is large (a real server-side displacement), which we let snap.
    const errX = beforeX - p.x, errY = beforeY - p.y;
    const errMag = Math.hypot(errX, errY);
    // Correction telemetry: count only meaningful (non-sub-pixel) reconciliations.
    if (errMag > 0.5) {
      this.reconcileCount++;
      this.correctionEwmaPx = this.correctionEwmaPx === 0 ? errMag : this.correctionEwmaPx * 0.8 + errMag * 0.2;
      if (errMag > this.correctionMaxPx) this.correctionMaxPx = errMag;
    }
    if (errMag <= SMOOTH_MAX_PX) {
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
    // connected but not yet acknowledged (no snapshot), resend the join periodically.
    const sock = this.socket;
    if (sock && sock.readyState === SOCKET_OPEN && !this.isReady() && this.now() - this.lastJoinAt > 500) {
      this.sendJoin();
    }

    // FIXED-TIMESTEP prediction: accumulate real frame time and step the predicted local player
    // EXACTLY FIXED_DT per step, sampling+sending one input command per step. Frame-rate
    // independent (a 240Hz client produces the same command cadence as a 30Hz one) and carries no
    // client dt — the server tick owns simulation time.
    const p = this.predState.players.get(LOCAL_ID)!;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      this.accumulator -= FIXED_DT;
      steps++;
      this.prevPredX = p.x; this.prevPredY = p.y;
      const cmd = this.nextInput ?? { seq: 0, moveX: 0, moveY: 0, aim: p.aimAngle, firing: false, dash: false };
      const scratch: SimEvent[] = [];
      if (this.isReady()) {
        const seq = ++this.seq;
        const stamped: InputCmd = { ...cmd, seq };
        this.pending.push({ seq, cmd: stamped, sentAt: this.now() });
        while (this.pending.length > MAX_PENDING) this.pending.shift();
        this.sendMsg({ t: "input", seq, mx: cmd.moveX, my: cmd.moveY, aim: cmd.aim, fire: cmd.firing, dash: cmd.dash, ackEv: this.lastEventId });
        stepPlayerPhase(this.predState, p, stamped, FIXED_DT, scratch);
      } else {
        // Pre-join: predict locally for instant feel; don't send before the join is acknowledged.
        stepPlayerPhase(this.predState, p, cmd, FIXED_DT, scratch);
      }
    }
    if (this.accumulator > FIXED_DT) this.accumulator = FIXED_DT; // clamp after a long stall
    // Periodic telemetry uplink (observability only): report client-side netcode signals the
    // server can't measure so /metrics can surface RTT/jitter/reconciliations/correction.
    if (this.isReady() && this.now() - this.lastStatAt > 2000) {
      this.lastStatAt = this.now();
      this.sendMsg({ t: "stat", rtt: Math.round(this.rttMs), jit: Math.round(this.jitterMs), rec: this.reconcileCount, corr: Math.round(this.correctionMaxPx) });
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
    // Render-extrapolate the local player between 20Hz fixed steps so movement stays smooth at any
    // FPS: advance from the last fixed position toward the current one by the leftover accumulator
    // fraction. Extrapolation naturally rests when the player stops (prev == cur). Any small
    // overshoot is corrected on the next fixed step.
    const frac = FIXED_DT > 0 ? Math.min(1, this.accumulator / FIXED_DT) : 0;
    rp.x = pp.x + (pp.x - this.prevPredX) * frac + this.smoothX;
    rp.y = pp.y + (pp.y - this.prevPredY) * frac + this.smoothY;

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

  // ---- authoritative gameplay actions (inputs only; the server owns every outcome) ----

  // Request an authoritative weapon switch. The server equips only if the id is actually owned;
  // the result returns via SelfWire (wpn/fireCd). Predicting the equip locally would fight the
  // reconcile on an invalid switch, so we let the snapshot confirm it (switches aren't
  // latency-critical). No-op if the weapon isn't in the last authoritative inventory.
  sendSwitch(weapon: WeaponId): void {
    const self = this.latestSnap?.self;
    if (self && !self.wpns.includes(weapon)) return;
    this.sendMsg({ t: "switch", weapon });
  }

  // Reply to a server blessing offer. The server validates the id against what it offered this
  // player and applies it authoritatively (mods flow back via SelfWire).
  sendPickBlessing(itemId: string): void {
    this.sendMsg({ t: "pickBlessing", itemId });
  }

  // Consume a pending server-decided blessing offer (choice ids), or null if none. The game shows
  // it once, then replies via sendPickBlessing.
  consumePendingOffer(): string[] | null {
    const o = this.pendingOffer;
    this.pendingOffer = null;
    return o;
  }

  // Non-destructive read of the pending offer (harness/tests inspect without consuming).
  getPendingOfferPeek(): string[] | null {
    return this.pendingOffer;
  }

  // Authoritative floor-cleared / exit-open flag (global objective state; survives interest
  // filtering, unlike deriving it from the possibly-filtered enemy list).
  isFloorCleared(): boolean {
    return this.latestSnap?.cleared ?? false;
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

  // Adaptive netcode telemetry (HUD / harness / metrics). All measured client-side from the
  // input->ack round trip and snapshot arrival cadence.
  getNetStats(): {
    rttMs: number; jitterMs: number; interpDelayMs: number; clockOffsetMs: number;
    reconciliations: number; correctionAvgPx: number; correctionMaxPx: number;
  } {
    return {
      rttMs: this.rttMs,
      jitterMs: this.jitterMs,
      interpDelayMs: this.interp.getRenderDelay(),
      clockOffsetMs: this.clockOffsetMs,
      reconciliations: this.reconcileCount,
      correctionAvgPx: this.correctionEwmaPx,
      correctionMaxPx: this.correctionMaxPx,
    };
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
