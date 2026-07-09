// Per-connection server state. A Conn starts unauthenticated and can do nothing but send a
// valid `join` (within joinTimeoutMs) before being bound to a world + playerId. Everything
// here is server-owned; a client only ever influences `queue` (its input intents), and only
// through the strict decoder + rate limiter.

import type { WebSocket } from "ws";
import type { PlayerId } from "../../src/sim/input.js";
import type { InterestView } from "../../src/net/protocol.js";
import { createInterestView } from "../../src/net/protocol.js";

// The decoded, validated input INTENT (a ClientMsg "input" minus the tag). It carries NO dt: the
// server tick owns simulation time (one command = one fixed step). Purely what the player intends.
export interface InputIntent {
  seq: number;
  mx: number; my: number;
  aim: number;
  fire: boolean; dash: boolean;
}

// Per-class inbound rate windows (sliding 1s). Segmenting the buckets means a high-refresh
// client's input stream, its telemetry, and its heartbeat replies are policed independently —
// one class flooding can neither exhaust nor kill the others (TD P0-5/B6).
export interface RateWindows {
  start: number;
  total: number;
  input: number;
  control: number;
  stat: number;
  pong: number;
}

export interface Conn {
  id: number;
  ws: WebSocket;
  ip: string;
  log: import("./logger.js").Logger;

  authed: boolean;
  playerId: PlayerId | null; // world-scoped id ("p<connId>"); unique per connection
  authName: string | null;   // the verified identity from the ticket (for logs)
  worldId: string | null;
  // Verified cosmetic identity from the ticket (broadcast to other clients via PlayerWire):
  // the display name shown above this player's blob, and their chosen blob color.
  displayName: string | null;
  colorIndex: number | null;
  malformed: number;         // count of malformed messages (kick threshold)

  connectedAt: number;
  // inbound message rate limiting (sliding 1s window, per class + aggregate)
  rate: RateWindows;

  // bounded per-player input queue, drained ONE command per tick in seq order (fixed timestep)
  queue: InputIntent[];
  lastAppliedSeq: number;
  lastInput: InputIntent | null;
  starveTicks: number;
  // reliable-event channel: the highest event id this client has acked (via input.ackEv). The
  // publisher resends only events newer than this from the room's bounded ring.
  ackedEventId: number;
  // monotonic semantic-command sequence (equip). Stale/duplicate commands are ignored so a
  // client-side retry can never double-apply or regress a newer choice.
  lastCseq: number;

  // heartbeat / timeout
  lastPongAt: number;
  awaitingPong: boolean;
  missedPings: number;
  nextPingId: number;
  // round-trip time (ms), measured from ping->pong and smoothed; drives lag-comp rewind.
  lastPingSentAt: number;
  rttMs: number;

  closing: boolean;
  // The authoritative pending blessing offer for this player: the choice ids, the offer's
  // monotonic id (the client must echo it), and its expiry deadline. A chooseBlessing is valid
  // ONLY against exactly this offer, then it is cleared.
  pendingOffer: string[] | null;
  offerId: number;           // monotonic id of the current offer (client dedupes resends by it)
  offerResendsLeft: number;  // bounded resends of the pending offer (loss/backpressure recovery)
  offerDeadline: number;     // wall-clock ms after which the pending offer expires
  // Set when this player's run ended (full wipe); the server sends the final snapshot then
  // deterministically closes the socket (no lingering post-game-over connection).
  gameOver: boolean;
  // Set once this connection's run result has been handed to the reporter, so the death
  // path (handleGameOver -> closeConn) can never double-submit with the disconnect path.
  isRunReported: boolean;

  // Per-client interest view (enter/exit hysteresis over stable entity ids) + the derived
  // position events are filtered against.
  view: InterestView;

  // observability
  bytesSent: number;
  droppedSnaps: number;
  // client-reported netcode telemetry (from "stat" uplink). dly additionally feeds the lag-comp
  // rewind (clamped server-side to the adaptive interp window, so it is bounded, not trusted).
  cliRttMs: number;
  cliJitterMs: number;
  cliInterpDelayMs: number;
  cliReconciliations: number;
  cliCorrectionMaxPx: number;
}

export function newRateWindows(now: number): RateWindows {
  return { start: now, total: 0, input: 0, control: 0, stat: 0, pong: 0 };
}

export function newConnState(now: number): Pick<Conn,
  "authed" | "playerId" | "authName" | "worldId" | "displayName" | "colorIndex" | "malformed"
  | "connectedAt" | "rate"
  | "queue" | "lastAppliedSeq" | "lastInput" | "starveTicks" | "ackedEventId" | "lastCseq"
  | "lastPongAt" | "awaitingPong" | "missedPings" | "nextPingId" | "lastPingSentAt" | "rttMs"
  | "closing" | "pendingOffer" | "offerId" | "offerResendsLeft" | "offerDeadline" | "gameOver"
  | "isRunReported"
  | "view" | "bytesSent" | "droppedSnaps" | "cliRttMs" | "cliJitterMs" | "cliInterpDelayMs"
  | "cliReconciliations" | "cliCorrectionMaxPx"
> {
  return {
    authed: false, playerId: null, authName: null, worldId: null, displayName: null, colorIndex: null, malformed: 0,
    connectedAt: now, rate: newRateWindows(now),
    queue: [], lastAppliedSeq: 0, lastInput: null, starveTicks: 0, ackedEventId: 0, lastCseq: 0,
    lastPongAt: now, awaitingPong: false, missedPings: 0, nextPingId: 1, lastPingSentAt: 0, rttMs: 0,
    closing: false, pendingOffer: null, offerId: 0, offerResendsLeft: 0, offerDeadline: 0, gameOver: false,
    isRunReported: false,
    view: createInterestView(),
    bytesSent: 0, droppedSnaps: 0,
    cliRttMs: 0, cliJitterMs: 0, cliInterpDelayMs: 0, cliReconciliations: 0, cliCorrectionMaxPx: 0,
  };
}

export function inputToIntent(m: { seq: number; mx: number; my: number; aim: number; fire: boolean; dash: boolean }): InputIntent {
  return { seq: m.seq, mx: m.mx, my: m.my, aim: m.aim, fire: m.fire, dash: m.dash };
}
