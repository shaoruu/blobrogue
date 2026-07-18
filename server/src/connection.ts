// Per-connection server state. A Conn starts unauthenticated and can do nothing but send a
// valid `join` (within joinTimeoutMs) before being bound to a world + playerId. Everything
// here is server-owned; a client only ever influences `queue` (its input intents), and only
// through the strict decoder + rate limiter.

import type { WebSocket } from "ws";
import type { PlayerId } from "../../src/sim/input.js";
import type { InterestView, SnapMsg } from "../../src/net/protocol.js";
import { createInterestView } from "../../src/net/protocol.js";
import type { KitId } from "../../src/sim/kits.js";

// The decoded, validated input INTENT (a ClientMsg "input" minus the tag). It carries NO dt: the
// server tick owns simulation time (one command = one fixed step). Purely what the player intends.
export interface InputIntent {
  seq: number;
  mx: number; my: number;
  aim: number;
  fire: boolean; dash: boolean;
  act: boolean; // interact key held (the revive channel); the sim validates everything else
  ult: boolean; // the "ult requested" intent; the server validates charge + the 8s lockout
  pulse: boolean; // the Mender heal-pulse intent; the server validates the pulse cooldown
  pet: boolean; // the pet-ability intent; the server validates mode/downed/cooldown + resolves
  ak: string; // PVP WAVE 3 arena ult kit CLAIM ("" = none); the server accepts it only off-live
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
  isAdmissionPending: boolean;
  playerId: PlayerId | null; // world-scoped id ("p<connId>"; a resume adopts the seat's id)
  authName: string | null;   // the verified identity from the ticket (for logs)
  worldId: string | null;
  // Verified cosmetic identity from the ticket (broadcast to other clients via PlayerWire):
  // the display name shown above this player's blob, their chosen blob color, and their
  // equipped visual-only cosmetics.
  displayName: string | null;
  colorIndex: number | null;
  hat: string | null;
  face: string | null;
  // The equipped visual-only companion pet id (META spec §3), broadcast via PlayerWire.pt.
  pet: string | null;
  // The VALIDATED kit this player joined with (spec §9.5): the ticket's requested kit re-gated
  // server-side against the account's Mastery level, downgraded to "gunner" on any mismatch —
  // never a raw client claim. Applied to the sim body at spawn (setPlayerKit).
  kitId: KitId;
  // Single-use seat token for THIS connection (minted at join, rotated at resume, delivered
  // on the full snapshot). If the socket dies unexpectedly it moves onto the reserved seat,
  // and presenting it with a fresh ticket reclaims the exact body.
  resumeToken: string | null;
  // The token the client PRESENTED to claim this connection's seat (null for a fresh join).
  // Rotation-ack ordering: the server rotates the token the moment a resume is processed, but
  // the client only learns the new one from a snapshot — if this socket dies inside that
  // window (the exact flaky-network race), the client's only credential is still this one.
  // It stays honored as a resume fallback until receipt of the rotated token is confirmed.
  presentedResumeToken: string | null;
  // The client has demonstrably RECEIVED this connection's rotated resume token: set on the
  // first input frame, which a conforming client sends only after ingesting a snapshot on
  // this socket (and every per-connection snapshot carries the token). Once confirmed, the
  // presented (previous) token is dead — replay protection is fully restored.
  isResumeTokenConfirmed: boolean;
  // The client said `leave` (deliberate goodbye): the close that follows must NOT reserve a
  // reconnect seat.
  isLeaving: boolean;
  malformed: number;         // count of malformed messages (kick threshold)

  connectedAt: number;
  // Wall-clock of the last inbound frame of ANY kind. Drives silent-drop detection (studio
  // balance gate §6): a link that goes quiet for absenceDetectMs marks the body absent/safe
  // long before the heartbeat timeout closes the socket, and the next frame restores it.
  lastInboundAt: number;
  // The body is currently soft-absent (silent link, socket still open). Distinct from a
  // reserved seat — the connection is alive and recovers by simply speaking again.
  isSoftAbsent: boolean;
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

  // ---- snapshot delta baseline (v24) ----
  // Per-connection monotonic snapshot sequence: the id assigned to each snapshot sent to this
  // client (the ack target + the delta baseline id).
  snapSseq: number;
  // The highest sseq the client has acknowledged (via input.ackSnap).
  ackedSnapSseq: number;
  // The COMPLETE snapshot the client last acknowledged — the exact baseline the next delta is
  // diffed against. null until the client acks its first keyframe (until then: send keyframes).
  snapBaseline: SnapMsg | null;
  // Sent-but-not-yet-promoted snapshots, keyed by sseq — the promotion candidates an ack
  // resolves into the new baseline. Bounded; a lagging client falls back to a keyframe.
  sentSnaps: Map<number, SnapMsg>;

  // Per-client interest view (enter/exit hysteresis over stable entity ids) + the derived
  // position events are filtered against.
  view: InterestView;
  // The teammate a DOWNED player is spectating (from the semantic `spec` message). View
  // preference only: the publisher centers this client's interest on that player while they
  // are down. Never touches the sim; invalid/absent falls back to the first living teammate.
  spectateTarget: PlayerId | null;

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
  "authed" | "isAdmissionPending" | "playerId" | "authName" | "worldId" | "displayName" | "colorIndex" | "hat" | "face" | "pet" | "kitId" | "resumeToken"
  | "presentedResumeToken" | "isResumeTokenConfirmed" | "isLeaving" | "malformed"
  | "connectedAt" | "lastInboundAt" | "isSoftAbsent" | "rate"
  | "queue" | "lastAppliedSeq" | "lastInput" | "starveTicks" | "ackedEventId" | "lastCseq"
  | "lastPongAt" | "awaitingPong" | "missedPings" | "nextPingId" | "lastPingSentAt" | "rttMs"
  | "closing" | "pendingOffer" | "offerId" | "offerResendsLeft" | "offerDeadline"
  | "gameOver"
  | "snapSseq" | "ackedSnapSseq" | "snapBaseline" | "sentSnaps"
  | "view" | "spectateTarget" | "bytesSent" | "droppedSnaps" | "cliRttMs" | "cliJitterMs" | "cliInterpDelayMs"
  | "cliReconciliations" | "cliCorrectionMaxPx"
> {
  return {
    authed: false, isAdmissionPending: false, playerId: null, authName: null, worldId: null, displayName: null, colorIndex: null, hat: null, face: null, pet: null,
    kitId: "none",
    resumeToken: null, presentedResumeToken: null, isResumeTokenConfirmed: false, isLeaving: false, malformed: 0,
    connectedAt: now, lastInboundAt: now, isSoftAbsent: false, rate: newRateWindows(now),
    queue: [], lastAppliedSeq: 0, lastInput: null, starveTicks: 0, ackedEventId: 0, lastCseq: 0,
    lastPongAt: now, awaitingPong: false, missedPings: 0, nextPingId: 1, lastPingSentAt: 0, rttMs: 0,
    closing: false, pendingOffer: null, offerId: 0, offerResendsLeft: 0, offerDeadline: 0,
    gameOver: false,
    snapSseq: 0, ackedSnapSseq: 0, snapBaseline: null, sentSnaps: new Map(),
    view: createInterestView(), spectateTarget: null,
    bytesSent: 0, droppedSnaps: 0,
    cliRttMs: 0, cliJitterMs: 0, cliInterpDelayMs: 0, cliReconciliations: 0, cliCorrectionMaxPx: 0,
  };
}

export function inputToIntent(m: { seq: number; mx: number; my: number; aim: number; fire: boolean; dash: boolean; act: boolean; ult: boolean; pulse: boolean; pet: boolean; ak: string }): InputIntent {
  return { seq: m.seq, mx: m.mx, my: m.my, aim: m.aim, fire: m.fire, dash: m.dash, act: m.act, ult: m.ult, pulse: m.pulse, pet: m.pet, ak: m.ak };
}
