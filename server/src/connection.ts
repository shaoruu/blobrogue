// Per-connection server state. A Conn starts unauthenticated and can do nothing but send a
// valid `join` (within joinTimeoutMs) before being bound to a world + playerId. Everything
// here is server-owned; a client only ever influences `queue` (its input intents), and only
// through the strict decoder + rate limiter.

import type { WebSocket } from "ws";
import type { PlayerId } from "../../src/sim/input.js";

// The decoded, validated input intent (a ClientMsg "input" minus the tag). dt is the client's
// frame duration; the server clamps it before integrating (anti speed-hack).
export interface InputIntent {
  seq: number;
  dt: number;
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

  // bounded per-player input queue, drained each tick in seq order
  queue: InputIntent[];
  lastAppliedSeq: number;
  lastInput: InputIntent | null;
  starveTicks: number;

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

  // observability
  bytesSent: number;
  droppedSnaps: number;
}

export function inputToIntent(m: { seq: number; dt: number; mx: number; my: number; aim: number; fire: boolean; dash: boolean }): InputIntent {
  return { seq: m.seq, dt: m.dt, mx: m.mx, my: m.my, aim: m.aim, fire: m.fire, dash: m.dash };
}
