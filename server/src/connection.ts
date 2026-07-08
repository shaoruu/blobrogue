// Per-connection server state. A Conn starts unauthenticated and can do nothing but send a
// valid `join` (within joinTimeoutMs) before being bound to a world + playerId. Everything
// here is server-owned; a client only ever influences `queue` (its input intents), and only
// through the strict decoder + rate limiter.

import type { WebSocket } from "ws";
import type { PlayerId } from "../../src/sim/input.js";

// The decoded, validated input INTENT (a ClientMsg "input" minus the tag). It carries NO dt: the
// server tick owns simulation time (one command = one fixed step). Purely what the player intends.
export interface InputIntent {
  seq: number;
  mx: number; my: number;
  aim: number;
  fire: boolean; dash: boolean;
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
  malformed: number;         // count of malformed messages (kick threshold)

  connectedAt: number;
  // inbound message rate limiting (sliding 1s window)
  windowStart: number;
  windowCount: number;

  // bounded per-player input queue, drained ONE command per tick in seq order (fixed timestep)
  queue: InputIntent[];
  lastAppliedSeq: number;
  lastInput: InputIntent | null;
  starveTicks: number;
  // reliable-event channel: the highest event id this client has acked (via input.ackEv). The
  // publisher resends only events newer than this from the room's bounded ring.
  ackedEventId: number;

  // heartbeat / timeout
  lastPongAt: number;
  awaitingPong: boolean;
  missedPings: number;
  nextPingId: number;
  // round-trip time (ms), measured from ping->pong and smoothed; drives lag-comp rewind.
  lastPingSentAt: number;
  rttMs: number;

  needsFullSnap: boolean;
  closing: boolean;
  // The set of blessing item ids the server last offered this player (authoritative pending
  // offer). A pickBlessing is validated against exactly this set, then it is cleared.
  pendingOffer: string[] | null;
  offerId: number;           // monotonic id of the current offer (client dedupes resends by it)
  offerResendsLeft: number;  // bounded resends of the pending offer (loss/backpressure recovery)
  // Set when this player's run ended (full wipe); the server sends the final snapshot then
  // deterministically closes the socket (no lingering post-game-over connection).
  gameOver: boolean;

  // observability
  bytesSent: number;
  droppedSnaps: number;
  // client-reported netcode telemetry (from "stat" uplink; observability only)
  cliRttMs: number;
  cliJitterMs: number;
  cliReconciliations: number;
  cliCorrectionMaxPx: number;
}

export function inputToIntent(m: { seq: number; mx: number; my: number; aim: number; fire: boolean; dash: boolean }): InputIntent {
  return { seq: m.seq, mx: m.mx, my: m.my, aim: m.aim, fire: m.fire, dash: m.dash };
}
