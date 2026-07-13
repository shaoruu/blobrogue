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
import type { WorldState } from "../sim/world.js";
import type { WorldMode } from "../sim/pvp.js";
import type { SimEvent } from "../sim/events.js";
import type { InputCmd, PlayerId } from "../sim/input.js";
import { LOCAL_ID } from "../sim/input.js";
import type { RemotePlayer, WeaponId } from "../sim/types.js";
import { MAX_OWNED_WEAPONS } from "../sim/constants.js";
import { RemoteInterp } from "../net/interp.js";
import {
  effectFromWire,
  jsonCodec, applySelfWire, enemyFromWire, bulletFromWire,
  propFromWire, pickupFromWire, chestFromWire, hazardFromWire, shopFromWire,
  validateSnap,
  STAGE_B_SEED, STAGE_B_FLOOR, PROTOCOL_VERSION, FIXED_DT, RESUME_GRACE_MS, isPvpWorldId,
  type RosterWire, type ServerMsg, type SnapMsg, type WaitWire,
} from "../net/protocol.js";
import { applySnapshotDelta, snapshotToWire } from "../net/snapshotDelta.js";
import { applyPlayerSnapshot } from "../net/playerSnapshot.js";
import type { Enemy, Bullet, Prop, Pickup, Chest } from "../sim/types.js";

// A server blessing offer as surfaced to the game: the id must be echoed back with the choice
// so the server can validate the answer against exactly this offer.
export interface BlessingOffer { id: number; choices: string[] }

// Minimal socket surface (a subset shared by browser WebSocket and the `ws` package).
export interface SocketLike {
  send(data: string): void;
  close(): void;
  readyState: number;
  bufferedAmount: number;
  onopen: (() => void) | null;
  // The close event's code (when the implementation surfaces one) distinguishes the server's
  // deliberate lifecycle closes (game over, superseded) from network death.
  onclose: ((ev?: { code?: number }) => void) | null;
  onerror: ((err: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type ConnStatus = "connecting" | "open" | "reconnecting" | "closed" | "error";

// Why the transport reached a terminal state after having played — drives the game's exit:
//   game_over       — the server ended the run and closed the socket (the ONLY death path)
//   superseded      — another connection with this identity took the body over (second tab)
//   resume_rejected — the server refused our resume token (replay/forgery signal)
//   connection_lost — the reconnect window ran out or the seat was gone (grace expired /
//                     world released / server restarted): the run is unreachable, NOT a death
export type CloseKind = "game_over" | "superseded" | "resume_rejected" | "connection_lost";

export interface WSTransportOptions {
  url: string;
  getTicket: () => Promise<string>;
  // The world this connection is ALLOWED to play in (worldIdForRoomCode of the lobby's room
  // code). Every snapshot's authoritative `wid` is asserted against it: a mismatch closes
  // the socket before any state is accepted — the client must never play in a world it did
  // not expect (the Sev-0 failure mode). Omitted/null: no assertion (dev ?gs= direct joins).
  expectedWorldId?: string | null;
  socketFactory?: (url: string) => SocketLike;
  now?: () => number;
  onStatus?: (s: ConnStatus) => void;
  // Reconnect backoff tuning (tests tighten these; production keeps the defaults).
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  // How long the server holds our seat — the reconnect loop gives up (terminal
  // connection_lost) once this window plus slack is exhausted.
  resumeGraceMs?: number;
}

// A world-binding violation: the server bound this connection to a world other than the one
// the lobby promised. Terminal — the transport closes itself and never becomes ready.
export interface WorldMismatch {
  expected: string;
  got: string;
}

// Live reconnect readout for the CONNECTION LOST overlay: which attempt is in flight, when
// the outage began (the overlay's calm-then-detailed state machine), and when the
// server-side grace runs out (countdown display).
export interface ReconnectInfo {
  isReconnecting: boolean;
  attempt: number;
  startedAtMs: number;
  graceEndsAtMs: number;
}

const SOCKET_OPEN = 1;
// Reconnect backoff: 400ms, 800ms, 1.6s, 3.2s, then 5s steps — ~8 attempts inside the 25s
// server grace. Slack past the grace covers one final in-flight attempt against a seat that
// is already gone (it resolves as resume_expired, an explicit answer).
const RECONNECT_BASE_DELAY_MS = 400;
const RECONNECT_MAX_DELAY_MS = 5000;
const RECONNECT_GRACE_SLACK_MS = 3000;
// A correction smaller than this glides over a few frames (invisible); anything larger is a
// genuine divergence (knockback/teleport) and snaps immediately.
const SMOOTH_MAX_PX = 96;
// Fraction of the remaining smoothing error retired per second (higher = snappier).
const SMOOTH_RETIRE_PER_SEC = 12;
// Cap the unacked-input ring so a long stall can't grow it without bound.
const MAX_PENDING = 256;
// How many recent snapshots to retain as delta baselines. Comfortably exceeds the server's
// max delta lag (it re-keyframes past that), so a delta's named baseline is always still held
// even when our ack is in flight or our uplink is quiet.
const SNAP_BASELINE_RETAIN = 150;

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

// Player-scoped combat events every NEARBY client replays (v14) — not only the actor. Online
// MP has ONE authoritative event stream, so a teammate's shot/swing/hurt/heal/pickup must
// pass the client's self-gate to reach handleSimEvent (which then plays them positionally as
// a remote's, never with the local player's camera juice). Enemy/world events carry no pid
// and pass anyway; the local player's own copies still play exactly once (deduped by id).
const REMOTE_AUDIBLE_EVENTS: ReadonlySet<SimEvent["t"]> = new Set<SimEvent["t"]>([
  "shot", "meleeSwing", "playerHurt", "heal", "pickup",
]);

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

  private latestSnap: SnapMsg | null = null;
  // ---- snapshot delta baselines (v24) ----
  // Recent COMPLETE snapshots retained by sseq. A delta names the EXACT baseline it was diffed
  // from (its `b`), so we look that snapshot up here and reconstruct against it — never against a
  // single "current" baseline. This keeps a client whose uplink is quiet (it can't ack, so the
  // server keeps diffing against an older baseline) fully current: it still holds that baseline.
  private snapsBySseq = new Map<number, SnapMsg>();
  // Highest applied sseq: the delta ordering guard (drop q <= this) and the ack we report on
  // every input (the latest snapshot we hold, so the server can diff against it).
  private lastSnapSseq = -1;
  private snapRecvAt = 0;
  private selfServerId: PlayerId | null = null;
  private joinTicket: string | null = null;
  private lastJoinAt = 0;

  // ---- reconnect grace / session resume ----
  // The server's single-use seat token (from full snapshots). Presented on reconnect to
  // reclaim the same body; rotated by the server on every join.
  private resumeToken: string | null = null;
  private isReconnecting = false;
  private reconnectAttempt = 0;
  private reconnectStartedAt = 0;
  private graceEndsAt = 0;
  // The resume's first snapshot said the run was ALREADY over: the wipe happened while this
  // player was away. The game shows RUN ENDED WHILE AWAY — never a fabricated YOU DIED.
  private isResumedIntoOver = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isEverReady = false;        // auto-reconnect only after we actually had a world
  private closeKind: CloseKind | null = null;
  // Reject codes arrive as error FRAMES before the socket closes; latch them so the close
  // handler can route to the right terminal state.
  private rejectCode: string | null = null;

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
  private lastSnapTick = -1;    // reject stale / out-of-order snapshots
  private lastSnapRev = -1;     // reject snapshots from an older world revision
  private lastAckSeq = 0;       // the server ack never decreases (reorder guard)
  private cseq = 0;             // monotonic command sequence for inventory commands (equip/reorder/drop)

  // Authoritative shared-world tracking: the client rebuilds the identical dungeon geometry when
  // the server's seed/floor/revision changes (initial join + every party-wide descend), so
  // movement prediction collides with the same walls the server does. isWorldRebuilt latches for
  // the game to refresh its cosmetic floor state (biome/torches/music) off the new world.
  private curSeed = -1;
  private curFloor = -1;
  // The world MODE the local pred/render worlds are currently built in. Part of the authoritative
  // world IDENTITY (the pvp: prefix), so a pvp arena join builds the arena locally instead of a
  // co-op dungeon; re-derived from every snapshot's `wid` alongside seed/floor.
  private curMode: WorldMode = "coop";
  private isWorldRebuilt = false;
  // Terminal world-binding violation (expectedWorldId asserted against snapshot wid).
  private worldMismatch: WorldMismatch | null = null;
  // Whether a snapshot arrived on the CURRENT socket — drives the lost-join resend (the
  // handshake frame itself can be dropped under packet loss, on first join and on resume).
  private isSnapSeenOnSocket = false;
  // A server-decided blessing offer waiting to be shown (consumed by the game each frame).
  private pendingOffer: BlessingOffer | null = null;

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
    // placeholder world for pre-join prediction; the first snapshot's seed/floor/mode rebuilds
    // it to match the authoritative geometry (see maybeRebuildWorld). The MODE is part of the
    // world identity (the pvp: prefix): seed it from the lobby's expected world id so a pvp room
    // predicts against the arena from the first frame, and every snapshot's `wid` re-confirms it.
    const mode: WorldMode = this.opts.expectedWorldId != null && isPvpWorldId(this.opts.expectedWorldId) ? "pvp" : "coop";
    this.curMode = mode;
    this.curSeed = STAGE_B_SEED;
    this.curFloor = STAGE_B_FLOOR;
    this.predState = createWorld(STAGE_B_SEED, STAGE_B_FLOOR, { mode });
    this.renderState = createWorld(STAGE_B_SEED, STAGE_B_FLOOR, { mode });
    this.pendingOffer = null;
    this.pending = [];
    this.nextInput = null;
    this.seq = 0;
    this.latestSnap = null;
    this.snapsBySseq.clear();
    this.lastSnapSseq = -1;
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
    this.lastSnapRev = -1;
    this.lastAckSeq = 0;
    this.cseq = 0;
    this.isWorldRebuilt = false;
    this.worldMismatch = null;
    this.isSnapSeenOnSocket = false;
    this.resumeToken = null;
    this.isReconnecting = false;
    this.reconnectAttempt = 0;
    this.reconnectStartedAt = 0;
    this.graceEndsAt = 0;
    this.isEverReady = false;
    this.isResumedIntoOver = false;
    this.closeKind = null;
    this.rejectCode = null;
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const lp = this.predState.players.get(LOCAL_ID)!;
    this.prevPredX = lp.x; this.prevPredY = lp.y;
    this.stopped = false;
    // The browser announces returning connectivity — attempt a resume IMMEDIATELY instead of
    // waiting out the current backoff step (this is what makes a near-grace-length outage
    // still resume in time). No-op wherever the event never fires (Node harness).
    const g = globalThis as { addEventListener?: (type: string, cb: () => void) => void };
    g.addEventListener?.("online", this.onOnline);
    void this.connect();
  }

  private onOnline = (): void => {
    this.retryReconnectNow();
  };

  private async connect(): Promise<void> {
    this.setStatus(this.isReconnecting ? "reconnecting" : "connecting");
    let ticket: string;
    try {
      // Always a FRESH ticket (short TTL): a reconnect re-mints through the same trusted
      // path, so the identity/room proof is never stale even after a long outage.
      ticket = await this.opts.getTicket();
    } catch (err) {
      this.lastError = "ticket: " + String(err);
      if (this.stopped) return;
      // A mint hiccup during an outage IS the outage — count the attempt and keep trying.
      if (this.isReconnecting) { this.scheduleReconnect(); return; }
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
      if (this.isReconnecting) { this.scheduleReconnect(); return; }
      this.setStatus("error");
      return;
    }
    this.socket = sock;
    this.joinTicket = ticket;
    // Every handler is guarded against a STALE socket: a lingering previous socket that fires
    // late (a deliberate server close such as 4009 arriving on a link we already replaced)
    // must never tear down or contaminate the CURRENT connection.
    sock.onopen = () => {
      if (this.socket !== sock) return;
      if (!this.isReconnecting) this.setStatus("open");
      this.sendJoin();
    };
    sock.onmessage = (ev) => { if (this.socket === sock) this.onMessage(ev.data); };
    sock.onclose = (ev) => {
      if (this.socket !== sock) return;
      this.socket = null;
      this.onSocketGone(ev?.code);
    };
    sock.onerror = (err) => {
      if (this.socket !== sock) return;
      this.lastError = String(err);
      // Mid-outage errors resolve through onclose (the next attempt is already the answer);
      // a first-connect error stays terminal exactly as before.
      if (!this.isReconnecting && !this.isEverReady) this.setStatus("error");
    };
  }

  // The socket died. Deliberate lifecycle closes (game over, superseded) and terminal
  // rejects surface immediately; everything else after we had a world is a NETWORK ACCIDENT:
  // the server is holding our seat, so reconnect with backoff instead of declaring death.
  private onSocketGone(code?: number): void {
    if (this.stopped) { this.setStatus("closed"); return; }
    if (code === 4008 || this.latestSnap?.over === true) {
      this.closeKind = "game_over";
      this.setStatus("closed");
      return;
    }
    if (code === 4009) {
      this.closeKind = "superseded";
      this.lastError = "superseded: another session with this identity took over";
      this.setStatus("error");
      return;
    }
    if (this.rejectCode === "resume") {
      this.closeKind = "resume_rejected";
      this.setStatus("error");
      return;
    }
    if (this.rejectCode === "resume_expired") {
      this.closeKind = "connection_lost";
      this.setStatus("closed");
      return;
    }
    if (this.isEverReady) { this.scheduleReconnect(); return; }
    this.setStatus("closed");
  }

  // Exponential backoff toward the seat's grace deadline. The first drop anchors the grace
  // countdown; once the window (plus one-attempt slack) is spent, the run is unreachable and
  // the transport goes terminal — connection_lost, never a fabricated game over.
  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (!this.isReconnecting) {
      this.isReconnecting = true;
      this.reconnectAttempt = 0;
      this.reconnectStartedAt = this.now();
      this.graceEndsAt = this.reconnectStartedAt + (this.opts.resumeGraceMs ?? RESUME_GRACE_MS);
      console.warn("[net] connection lost — reconnecting with resume token", { graceMs: this.graceEndsAt - this.now() });
    }
    if (this.now() > this.graceEndsAt + RECONNECT_GRACE_SLACK_MS) {
      this.isReconnecting = false;
      this.closeKind = "connection_lost";
      this.lastError = "reconnect window exhausted";
      this.setStatus("closed");
      return;
    }
    const base = this.opts.reconnectBaseDelayMs ?? RECONNECT_BASE_DELAY_MS;
    const max = this.opts.reconnectMaxDelayMs ?? RECONNECT_MAX_DELAY_MS;
    const delay = Math.min(max, base * Math.pow(2, this.reconnectAttempt));
    this.reconnectAttempt++;
    this.setStatus("reconnecting");
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  // Connectivity just returned (the browser's `online` event, or a test's network restore):
  // skip the remaining backoff and attempt NOW. This is what lets an outage lasting almost
  // the whole grace window still resume in time — the retry cadence stops mattering the
  // moment the network is back.
  retryReconnectNow(): void {
    if (!this.isReconnecting || this.stopped || this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    void this.connect();
  }

  private setStatus(s: ConnStatus): void {
    // A world-binding mismatch is terminal: the socket close that follows it must not
    // soften the reported state from "error" back to a plain "closed".
    const status: ConnStatus = this.worldMismatch !== null ? "error" : s;
    this.status = status;
    this.opts.onStatus?.(status);
  }

  private sendJoin(): void {
    if (!this.joinTicket) return;
    this.lastJoinAt = this.now();
    // A fresh socket is a fresh server-side connection: inputs in flight on the dead socket
    // were lost (the seat preserved the server's ack watermark, so our seq counter keeps
    // counting), and preserved offers will be resent with ids that must re-prompt.
    this.isSnapSeenOnSocket = false;
    this.pending = [];
    this.lastOfferId = 0;
    // A fresh server-side connection restarts its snapshot sequence at 1, so drop every retained
    // delta baseline from the previous connection — the next keyframe re-anchors the set, and no
    // stale cross-connection sseq can ever be mistaken for a baseline.
    this.snapsBySseq.clear();
    this.lastSnapSseq = -1;
    if (this.resumeToken !== null) {
      this.sendMsg({ t: "join", ticket: this.joinTicket, protocol: PROTOCOL_VERSION, resume: this.resumeToken });
    } else {
      this.sendMsg({ t: "join", ticket: this.joinTicket, protocol: PROTOCOL_VERSION });
    }
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
      // Terminal join rejects (resume replay/forgery, expired seat) arrive as error frames
      // just before the server closes the socket — latch so the close routes correctly.
      if (msg.code === "resume" || msg.code === "resume_expired") this.rejectCode = msg.code;
      return;
    }
    if (msg.t === "offer") {
      // Idempotent: the server resends an offer (bounded) until the choice arrives; show each id
      // only once so resends never re-prompt.
      if (msg.id > this.lastOfferId) {
        this.lastOfferId = msg.id;
        this.pendingOffer = { id: msg.id, choices: msg.choices.slice() };
      }
      return;
    }
    if (msg.t === "snapd") {
      this.ingestDelta(msg);
      return;
    }
    this.ingestSnapshot(msg);
  }

  // Reconstruct a complete snapshot from a delta against the EXACT baseline it names, then apply
  // it through the SAME path a keyframe takes. Three guards keep it safe: a monotonic sseq drop
  // (stale/out-of-order deltas are never applied), a baseline lookup by the delta's `b` (if we no
  // longer hold that snapshot it is a gap — dropped, and a keyframe recovers), and full
  // validation of the reconstructed snapshot (a malformed reconstruction surfaces as a drop,
  // never NaN state).
  private ingestDelta(d: Extract<ServerMsg, { t: "snapd" }>): void {
    if (d.q <= this.lastSnapSseq) return;          // ordering guard
    const base = this.snapsBySseq.get(d.b);
    if (base === undefined) return;                // gap: baseline not held -> keyframe recovers
    let snap: SnapMsg;
    try {
      snap = validateSnap(applySnapshotDelta(snapshotToWire(base), d));
    } catch {
      return; // reconstruction/validation failed: keep our baselines, recover on the next frame
    }
    this.ingestSnapshot(snap);
  }

  // Drop retained baselines older than the retention window (bounded memory). Never touches
  // entries within the window, so the baseline any in-flight delta names is still present.
  private pruneSnapBaselines(): void {
    if (this.snapsBySseq.size <= SNAP_BASELINE_RETAIN) return;
    const cutoff = this.lastSnapSseq - SNAP_BASELINE_RETAIN;
    for (const sseq of this.snapsBySseq.keys()) if (sseq < cutoff) this.snapsBySseq.delete(sseq);
  }

  // Rebuild the client's predicted + render dungeon geometry to match the authoritative seed +
  // floor (initial join and every party-wide descend). Enemies/bullets/props ride the snapshot,
  // so only the walls + a local player need to exist; the next reconcile snaps self to truth.
  private maybeRebuildWorld(seed: number, floor: number, playerCountAtLock: number, mode: WorldMode): void {
    if (seed === this.curSeed && floor === this.curFloor && mode === this.curMode) return;
    this.curSeed = seed;
    this.curFloor = floor;
    this.curMode = mode;
    this.predState.seed = seed;
    this.renderState.seed = seed;
    // Carry the authoritative world MODE onto the local worlds so loadFloorIntoWorld builds the
    // SAME geometry the server did — the fixed pvp arena for a pvp world, the seeded dungeon for
    // co-op. Without it the client always rebuilt a co-op dungeon, so a pvp arena rendered as a
    // walk-through-walls co-op floor (the shipped PVP seam: the transport never learned the mode).
    this.predState.mode = mode;
    this.renderState.mode = mode;
    // Pass the AUTHORITATIVE floor-locked player count (SnapWire.pcl): the pred/render worlds
    // hold only the local seat, so without it they would resolve the floor descriptor at
    // playerCount=1 and derive the WRONG mutators/hazards/dash tuning for a multiplayer floor.
    loadFloorIntoWorld(this.predState, floor, playerCountAtLock);
    loadFloorIntoWorld(this.renderState, floor, playerCountAtLock);
    // A fresh floor is a hard teleport for every remote entity; drop stale interp history so
    // nothing slides across the new map for one render delay.
    this.interp = new RemoteInterp();
    this.smoothX = 0;
    this.smoothY = 0;
    // Re-anchor the between-steps render extrapolation at the repositioned player: a stale
    // anchor from the OLD world would otherwise leak a fraction of the whole old-to-new
    // displacement into the first rendered frame (a visible spawn-frame offset).
    const lp = this.predState.players.get(LOCAL_ID)!;
    this.prevPredX = lp.x;
    this.prevPredY = lp.y;
    this.isWorldRebuilt = true;
  }

  private ingestSnapshot(snap: Extract<ServerMsg, { t: "snap" }>): void {
    // World-binding assertion FIRST, before any state is accepted: the lobby promised a
    // specific room world, and if the server bound us anywhere else, playing would put this
    // player in a different run than their party (the Sev-0 bug). Close and never play.
    const expected = this.opts.expectedWorldId;
    if (expected != null && snap.wid !== expected) {
      this.worldMismatch = { expected, got: snap.wid };
      this.lastError = `world mismatch: expected ${expected}, got ${snap.wid}`;
      console.error(`[net] ${this.lastError} — closing the connection`);
      this.stop();
      this.setStatus("error");
      return;
    }
    // Reject stale / out-of-order snapshots: a full (join) snapshot always resyncs; otherwise
    // ignore anything from an older world revision or an older/duplicate tick (defends against
    // reordering under the adversity shim; on real ordered TCP this is belt-and-suspenders).
    if (!snap.full) {
      if (snap.rev < this.lastSnapRev) return;
      if (snap.rev === this.lastSnapRev && snap.tick <= this.lastSnapTick) return;
    }
    this.lastSnapRev = snap.rev;
    this.lastSnapTick = snap.tick;
    // Retain the applied snapshot as a delta baseline (a bootstrap keyframe re-anchors the whole
    // set; other keyframes + reconstructed deltas add to it). We ack the latest sseq on every
    // input so the server can diff against what we hold; the retained window covers the server's
    // max delta lag so a delta's named baseline is still present even if our ack is in flight.
    // Setting this past the stale/rev guard means a stale frame can never regress the baseline.
    if (snap.full) this.snapsBySseq.clear(); // a fresh connection restarts the sequence
    this.snapsBySseq.set(snap.sseq, snap);
    this.lastSnapSseq = snap.sseq;
    this.pruneSnapBaselines();
    // The world MODE rides the authoritative world id (isPvpWorldId(wid)) — the SAME predicate
    // the server's room factory keys off — so the client rebuilds the matching arena/dungeon.
    this.maybeRebuildWorld(snap.seed, snap.floor, snap.pcl, isPvpWorldId(snap.wid) ? "pvp" : "coop");
    this.latestSnap = snap;
    this.isEverReady = true;
    this.isSnapSeenOnSocket = true;
    // The seat token for the NEXT reconnect (single-use; the server rotates it every join).
    if (snap.tok !== undefined) this.resumeToken = snap.tok;
    if (this.isReconnecting) {
      this.isReconnecting = false;
      this.reconnectAttempt = 0;
      // The world we came back to may already be finished (the party wiped while we were
      // away) — a distinct, explicit state, never conflated with a live death.
      if (snap.over) this.isResumedIntoOver = true;
      console.info("[net] resumed into the authoritative world", { wid: snap.wid, selfId: snap.selfId, over: snap.over });
      this.setStatus("open");
    }
    // A FULL snapshot re-anchors offer state too: an offer held from before a reconnect may
    // have expired while we were away (its expiry event is pre-bootstrap backlog, skipped by
    // design), so it must not survive as a stale prompt — a still-live offer is re-sent by
    // the server within a tick.
    if (snap.full) this.pendingOffer = null;
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
      this.interp.ingest(key, snap.tick, p.x, p.y, p.aim, now, p.dti > 0);
    }
    this.interp.retain(live);

    // Props are near-static shared state; mirror them into the PREDICTED world so local movement
    // prediction collides with the same barrels/crates the server does (no rubber-band near
    // props). They only change on break, so rebuilding per snapshot is cheap. The obstacle
    // revision rides along so any local navigation cache (the dev flow inspector) never
    // reads routes through a stale prop set. Hazards mirror for the same reason: the
    // predicted walk must feel the web slow the server will apply.
    this.predState.props = snap.props.map(propFromWire);
    this.predState.obstacleRev++;
    this.predState.hazards = snap.hzds.map(hazardFromWire);

    // Reliable event channel: events are id-tagged. Dedupe (skip ids already processed — a resent
    // event after a dropped snapshot arrives again) and advance the ack high-water mark. Keep
    // global (enemy/world) events + this client's own player events — plus revive, whose moment
    // belongs to everyone standing at it (the reviver most of all; the FX are positional). evTo
    // advances the ack even when every pending event was interest-filtered away for this client,
    // so the server stops re-scanning them; critical transitions stay derivable from snapshot
    // STATE regardless.
    for (const w of snap.events) {
      if (w.id <= this.lastEventId) continue; // already processed (resend) — dedupe
      this.lastEventId = w.id;
      const e = w.e;
      const pid = pidOf(e);
      // Keep global/world events, this client's OWN player events, and the shared moments
      // that everyone standing at them must replay: revive, plus a NETWORKED player's combat
      // FX (shot/meleeSwing/playerHurt/heal/pickup — v14). Those now ride "pos" scope, so the
      // server delivers a teammate's actions to nearby clients; the client replays them
      // POSITIONALLY (handleSimEvent branches self vs remote), so a friend is audible to all.
      if (pid === undefined || pid === this.selfServerId || e.t === "revive" || REMOTE_AUDIBLE_EVENTS.has(e.t)) this.events.push(e);
    }
    if (snap.evTo > this.lastEventId) this.lastEventId = snap.evTo;
  }

  // Snap the predicted local player to authoritative truth, drop acked inputs, replay the rest.
  private reconcile(snap: Extract<ServerMsg, { t: "snap" }>): void {
    // The ack never decreases: a reordered/duplicated frame that slipped past the tick guard
    // (e.g. a full resync) must not resurrect already-consumed inputs into the replay set.
    if (snap.ackSeq < this.lastAckSeq) return;
    this.lastAckSeq = snap.ackSeq;
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
      // A hard snap must land EXACTLY: re-anchor the render extrapolation too, or the next
      // frame extrapolates along the correction and overshoots the true position by a step.
      this.prevPredX = p.x;
      this.prevPredY = p.y;
    }
  }

  sendInput(cmd: InputCmd): void {
    this.nextInput = cmd;
  }

  advance(dt: number): void {
    // A lost join handshake (packet loss on connect OR on a resume socket) would otherwise
    // strand the client. While connected but unacknowledged on THIS socket, resend the join.
    const sock = this.socket;
    if (sock && sock.readyState === SOCKET_OPEN && !this.isSnapSeenOnSocket && this.now() - this.lastJoinAt > 500) {
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
      // Inputs flow only once a snapshot arrived ON THIS SOCKET — never off stale readiness
      // from before a reconnect. This is both correctness (don't drive a world we haven't
      // resynced with) and the server's token-rotation receipt proof: snapshots carry the
      // rotated seat token, so our first input tells the server we hold the current one.
      if (this.isReady() && this.isSnapSeenOnSocket) {
        const seq = ++this.seq;
        const stamped: InputCmd = { ...cmd, seq };
        this.pending.push({ seq, cmd: stamped, sentAt: this.now() });
        while (this.pending.length > MAX_PENDING) this.pending.shift();
        this.sendMsg({ t: "input", seq, mx: cmd.moveX, my: cmd.moveY, aim: cmd.aim, fire: cmd.firing, dash: cmd.dash, act: cmd.interact === true, ult: cmd.ult === true, pulse: cmd.pulse === true, ackEv: this.lastEventId, ackSnap: Math.max(0, this.lastSnapSseq) });
        stepPlayerPhase(this.predState, p, stamped, FIXED_DT, scratch);
      } else {
        // Pre-join / mid-resume: predict locally for instant feel; don't send before the
        // (re)join is acknowledged by an authoritative snapshot.
        stepPlayerPhase(this.predState, p, cmd, FIXED_DT, scratch);
      }
    }
    if (this.accumulator > FIXED_DT) this.accumulator = FIXED_DT; // clamp after a long stall
    // Prediction only needs the fire COOLDOWN side effects of shooting; the spawned bullet
    // objects themselves are server-owned (rendered from snapshots) and predState never runs
    // the world phase that would expire them — drop them so replayed fire can't grow the
    // hidden prediction world without bound (TD audit).
    if (this.predState.bullets.length > 0) this.predState.bullets.length = 0;
    // Weapon effects are server-owned the same way: prediction only needs the trigger's
    // cooldown/charge side effects, never the entities a replayed press would author.
    if (this.predState.effects.length > 0) this.predState.effects.length = 0;
    // Periodic telemetry uplink (observability only): report client-side netcode signals the
    // server can't measure so /metrics can surface RTT/jitter/reconciliations/correction.
    if (this.isReady() && this.now() - this.lastStatAt > 2000) {
      this.lastStatAt = this.now();
      // dly = this client's ACTUAL adaptive interp delay, so the server's lag-comp rewind uses
      // the delay this client renders at (server-clamped to the adaptive [min,max] window).
      this.sendMsg({
        t: "stat", rtt: Math.round(this.rttMs), jit: Math.round(this.jitterMs),
        rec: this.reconcileCount, corr: Math.round(this.correctionMaxPx),
        dly: Math.round(this.interp.getRenderDelay()),
      });
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
    // Refresh the render player from the predicted one through the SAME exhaustive projection
    // boundary reconciliation uses (playerSnapshot.ts) — never a manual field list, so a new
    // server-owned field can't silently miss the render/HUD player — plus the render extras.
    // PlayerSim is structurally a superset of the snapshot, so the predicted player applies
    // directly (no per-frame intermediate projection object).
    applyPlayerSnapshot(rp, pp);
    rp.aimAngle = pp.aimAngle;
    rp.meleeSwing = pp.meleeSwing;
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
    this.renderState.obstacleRev++; // keep the dev flow inspector's clearance fresh
    this.renderState.pickups = this.composePickups();
    this.renderState.chests = this.composeChests();
    this.renderState.hazards = this.latestSnap ? this.latestSnap.hzds.map(hazardFromWire) : [];
    // Patch's stall: authoritative wire state only — the client never rolls or mutates
    // stock (its locally-rebuilt geometry still names the shop ROOM; the snapshot names
    // what is on the pedestals and who claimed what).
    this.renderState.shop = this.latestSnap?.shop ? shopFromWire(this.latestSnap.shop) : null;
    // Self-owned effects re-key to LOCAL_ID so the render/audio layers recognize the
    // local player's own ring/tether/charge exactly like solo (owner-anchored draws,
    // the halo loop, the chain pull loop).
    this.renderState.effects = this.latestSnap
      ? this.latestSnap.effs.map((e) => {
        const built = effectFromWire(e);
        if (built.owner !== null && built.owner === this.selfServerId) built.owner = LOCAL_ID;
        return built;
      })
      : [];
    this.renderState.floor = this.latestSnap ? this.latestSnap.floor : this.renderState.floor;
    // Hazard layout already lives in renderState (rebuilt from the authoritative seed);
    // the pulse clock is reconstructed from the authoritative tick — the server only ever
    // steps FIXED_DT per tick, so tick x FIXED_DT IS its hazardClock. The renderer smooths
    // the 20Hz quantization locally.
    if (this.latestSnap) this.renderState.floorHazardClock = this.latestSnap.tick * FIXED_DT;

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

  // Other players for the client's remote-player renderer (interpolated, never predicted).
  // Name + color come from each player's verified ticket identity when present (nm/cl on the
  // wire). A missing color claim stays null — the renderer shows a neutral placeholder; the
  // client NEVER invents a color for someone else (the stale-tint Sev).
  remotePlayers(): RemotePlayer[] {
    const snap = this.latestSnap;
    if (!snap) return [];
    const now = this.now();
    return snap.players.map((p) => {
      const pose = this.interp.sample("p" + p.id, now);
      return {
        playerId: p.id, name: p.nm,
        x: pose ? pose.x : p.x,
        y: pose ? pose.y : p.y,
        facing: p.fac,
        hp: p.hp, maxHp: p.mhp,
        weapon: p.wpn, floor: snap.floor,
        isDown: p.down,
        reviveProgress: p.rv,
        isOut: p.out,
        isAbsent: p.ab,
        // Dash keyed to the RENDERED pose (not the latest snapshot), so the FX play exactly
        // where/when the interpolated blob makes its crisp move.
        isDashing: pose ? pose.isDashing : p.dti > 0,
        dashDirX: p.ddx,
        dashDirY: p.ddy,
        invuln: p.inv,
        dashInvuln: p.dnv,
        aimAngle: pose ? pose.aimAngle : p.aim,
        shotSeq: 0,
        colorIndex: p.cl,
        hat: p.ht,
        face: p.fc,
        pet: p.pt,
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

  // Request an authoritative weapon equip. The server equips only if the id is actually owned;
  // the result returns via SelfWire (wpn/fireCd). Predicting the equip locally would fight the
  // reconcile on an invalid switch, so we let the snapshot confirm it (switches aren't
  // latency-critical). cseq makes the command idempotent server-side (stale/duplicate ignored).
  // No-op if the weapon isn't in the last authoritative inventory.
  sendEquip(weapon: WeaponId): void {
    const self = this.latestSnap?.self;
    if (self && !self.wpns.includes(weapon)) return;
    this.sendMsg({ t: "equip", weapon, cseq: ++this.cseq });
  }

  requestEquip(weapon: WeaponId): void {
    this.sendEquip(weapon);
  }

  // Request an authoritative inventory reorder. Like equip, never predicted locally: the
  // server validates both indices against the CURRENT inventory and the new order returns
  // via SelfWire.wpns (the HUD rebuilds from that one truth). Pre-filtered against the last
  // authoritative inventory so an obviously-stale drag is a client no-op, not a wire reject.
  requestReorder(from: number, to: number): void {
    const self = this.latestSnap?.self;
    if (self && (from < 0 || to < 0 || from >= self.wpns.length || to >= self.wpns.length)) return;
    if (from === to) return;
    this.sendMsg({ t: "reorder", from, to, cseq: ++this.cseq });
  }

  // Request an authoritative weapon drop (by id, never by index — a drop racing a reorder
  // can't discard the wrong weapon). The server owns every outcome: the ownership/state/
  // last-weapon checks, the safe spawn spot, and the resulting pickup + inventory, all of
  // which flow back via snapshot. cseq makes a resend idempotent (no duplicate pickups).
  requestDrop(weapon: WeaponId): void {
    const self = this.latestSnap?.self;
    if (self && (!self.wpns.includes(weapon) || self.wpns.length <= 1)) return;
    this.sendMsg({ t: "drop", weapon, cseq: ++this.cseq });
  }

  // Request an authoritative full-hotbar swap: trade the owned `drop` for the weapon
  // pickup `pickup`. Never predicted — the trade is atomic server-side and both the new
  // inventory and the replaced weapon's floor pickup flow back via snapshot. Pre-filtered
  // against the last authoritative state so an obviously-stale prompt click (pickup gone,
  // weapon no longer owned, hotbar no longer full) is a client no-op, not a wire reject.
  requestSwap(pickup: number, drop: WeaponId): void {
    const snap = this.latestSnap;
    if (snap) {
      const self = snap.self;
      if (self && (!self.wpns.includes(drop) || self.wpns.length < MAX_OWNED_WEAPONS + self.xsl)) return;
      if (!snap.pickups.some((p) => p.id === pickup && p.kind === "weapon")) return;
    }
    this.sendMsg({ t: "swap", pickup, drop, cseq: ++this.cseq });
  }

  // Answer a server blessing offer. The offerId names exactly which offer this choice answers;
  // the server validates it against the live pending offer (id + expiry) and the choice against
  // that offer's set, then applies the mods authoritatively (they flow back via SelfWire).
  sendChooseBlessing(offerId: number, choiceId: string): void {
    this.sendMsg({ t: "chooseBlessing", offerId, choiceId });
  }

  // Request an authoritative shop purchase (the panel's BUY). Never predicted: coins are
  // server-owned and the outcome (coins/stock/SOLD) flows back via snapshot — the panel
  // simply keeps rendering authoritative state, so a lost race shows an honest SOLD and
  // never a phantom grant. cseq makes a resend idempotent (no double charge).
  requestShopBuy(slot: number): void {
    if (!this.latestSnap?.shop?.slots.some((s) => s.id === slot)) return;
    this.sendMsg({ t: "shopBuy", slot, cseq: ++this.cseq });
  }

  // Name the teammate a downed local player is spectating, so the server centers this
  // client's interest view (and positional events) on them. Pure view preference.
  sendSpectate(target: PlayerId): void {
    this.sendMsg({ t: "spec", target });
  }

  // Consume a pending server-decided blessing offer, or null if none. The game shows it once,
  // then replies via sendChooseBlessing with the same offer id.
  consumePendingOffer(): BlessingOffer | null {
    const o = this.pendingOffer;
    this.pendingOffer = null;
    return o;
  }

  // Non-destructive read of the pending offer (harness/tests inspect without consuming).
  getPendingOfferPeek(): BlessingOffer | null {
    return this.pendingOffer;
  }

  // Authoritative floor-cleared / exit-open flag (global objective state; survives interest
  // filtering, unlike deriving it from the possibly-filtered enemy list).
  isFloorCleared(): boolean {
    return this.latestSnap?.cleared ?? false;
  }

  // Terminal run state from authoritative SNAPSHOT state (not just the transient gameOver
  // event) — a backpressure-dropped final snapshot can't strand the client mid-run.
  isRunOver(): boolean {
    return this.latestSnap?.over ?? false;
  }

  // Party members whose reward picks currently hold the descend gate (authoritative;
  // drives the "WAITING FOR …" readout).
  pendingBlessingParty(): PlayerId[] {
    return (this.latestSnap?.wait ?? []).map((p) => p.pid);
  }

  // The same pending set WITH the authoritative expiry countdown (seconds left before the
  // sim releases each hold). Pure snapshot state: the client never runs its own timer —
  // resolution, expiry, and every countdown step arrive as server truth or not at all.
  pendingPickWait(): { id: PlayerId; secondsLeft: number }[] {
    return (this.latestSnap?.wait ?? []).map((p) => ({ id: p.pid, secondsLeft: p.s }));
  }

  // Living party members standing at the cleared exit — the descend gate's own readiness
  // predicate on the wire (drives the "WAITING AT EXIT · N/M" coordination readout).
  exitReadyParty(): PlayerId[] {
    return this.latestSnap?.exr ?? [];
  }

  // Latch-consume the "world geometry was rebuilt" signal (initial join + every descend). The
  // game refreshes its cosmetic floor state (seed-keyed torches, biome, music) off it.
  consumeWorldRebuilt(): { seed: number; floor: number } | null {
    if (!this.isWorldRebuilt) return null;
    this.isWorldRebuilt = false;
    return { seed: this.curSeed, floor: this.curFloor };
  }

  // ---- read-only introspection (HUD / harness / tests) ----
  getSelfServerId(): PlayerId | null {
    return this.selfServerId;
  }
  // The authoritative world id this connection is bound to (from the latest snapshot).
  getWorldId(): string | null {
    return this.latestSnap?.wid ?? null;
  }
  // Everyone actually connected to this world (verified identities, interest-independent).
  // The readiness veil matches these against the lobby's expected roster; the HUD shows the
  // count.
  getWorldRoster(): readonly RosterWire[] {
    return this.latestSnap?.roster ?? [];
  }
  // Players still deciding a blessing offer (pid + authoritative seconds left) — identical
  // for every client, so the held descend gate is explicit and visibly bounded.
  getPartyWait(): readonly WaitWire[] {
    return this.latestSnap?.wait ?? [];
  }
  // Non-null after a terminal world-binding violation (see WSTransportOptions.expectedWorldId).
  getWorldMismatch(): WorldMismatch | null {
    return this.worldMismatch;
  }
  // Live reconnect state for the CONNECTION LOST overlay (attempt counter + grace countdown).
  getReconnectInfo(): ReconnectInfo {
    return { isReconnecting: this.isReconnecting, attempt: this.reconnectAttempt, startedAtMs: this.reconnectStartedAt, graceEndsAtMs: this.graceEndsAt };
  }
  // The resume landed in an already-finished run (the wipe happened while away).
  getIsResumedIntoOver(): boolean {
    return this.isResumedIntoOver;
  }
  // Why the transport went terminal after having played (null while healthy / pre-world).
  getCloseKind(): CloseKind | null {
    return this.closeKind;
  }
  // The current single-use seat token (tests assert rotation; the game never reads it).
  getResumeToken(): string | null {
    return this.resumeToken;
  }
  // The current predicted local-player position (true prediction, pre-smoothing).
  getPredictedSelf(): { x: number; y: number } {
    const p = this.predState.players.get(LOCAL_ID)!;
    return { x: p.x, y: p.y };
  }
  // Unacked-input ring depth / hidden prediction-world bullet count (bounded-memory
  // assertions in the soak tests).
  getPendingInputCount(): number {
    return this.pending.length;
  }
  getPredictedBulletCount(): number {
    return this.predState.bullets.length;
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
    const g = globalThis as { removeEventListener?: (type: string, cb: () => void) => void };
    g.removeEventListener?.("online", this.onOnline);
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.isReconnecting = false;
    const sock = this.socket;
    this.socket = null;
    if (sock) {
      // A deliberate goodbye: tell the server NOT to reserve a reconnect seat for this
      // close (quit to lobby / run end are not network accidents). Best-effort — if the
      // frame is lost the seat simply expires on its own.
      if (sock.readyState === SOCKET_OPEN) {
        try { sock.send(jsonCodec.encodeClient({ t: "leave" })); } catch { /* closing */ }
      }
      try { sock.close(); } catch { /* ignore */ }
    }
  }
}
