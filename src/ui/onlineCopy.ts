// The UI Director's P0 reconnect/readiness copy contract — every player-facing string for
// online connection states lives HERE, exactly as specced, so the game/menu/main surfaces
// can never drift apart and the copy itself is unit-testable (test/onlinecopy.test.ts).
//
// Input-prompt policy (coordinated with the input-context work): controller glyphs (A/B/X/Y
// button art) appear ONLY once real controller support exists. Until then every prompt uses
// neutral copy — key names (ESC) and plain verbs (hold, tap, release) — and the copy suite
// enforces glyph-free strings.

import type { ReconnectInfo } from "../client/wsTransport.js";

// ---- exact one-off strings ----

export const WORLD_MISMATCH_NOTE = "World mismatch \u2014 rejoining the party\u2026";
export const RUN_ENDED_AWAY_NOTE = "RUN ENDED WHILE AWAY";
export const BACK_ONLINE_TOAST = "BACK ONLINE";
export const CONNECT_CANCEL_HINT = "ESC \u2014 cancel";
export const READY_LABEL = "READY";
export const NOT_READY_LABEL = "NOT READY";

// The host's escape hatch when someone won't ready up: armed ONLY by a full 3s hold, so a
// party can never be yanked into a run by a slipped click.
export const START_ANYWAY_HOLD_MS = 3000;
export const START_ANYWAY_IDLE = "START ANYWAY \u2014 hold 3s";

export function startAnywayHoldLabel(heldMs: number): string {
  const left = Math.max(0, Math.ceil((START_ANYWAY_HOLD_MS - heldMs) / 1000));
  return `STARTING IN ${left}\u2026 release to cancel`;
}

// ---- HUD label (normal + transitional states) ----

export type OnlinePhase = "connecting" | "waiting" | "connected" | "reconnecting";

export interface OnlineHudState {
  phase: OnlinePhase;
  roomCode: string | null; // null: direct/dev join (fall back to the world id)
  worldId: string | null;
  connected: number;       // "on" seats on the server roster
  away: number;            // reserved/reconnecting seats
}

// Normal play reads `CONNECTED · ABCD · 3 PLAYERS` (the contract's exact shape); transitional
// phases swap the verb; mid-outage members append explicitly. Debug details (world id / rev /
// protocol) live in the hold-Tab details panel, not here.
export function onlineHudLabel(s: OnlineHudState): string {
  const verb = s.phase === "connected" ? "CONNECTED"
    : s.phase === "reconnecting" ? "RECONNECTING"
      : s.phase === "waiting" ? "WAITING FOR PARTY" : "CONNECTING";
  const where = s.roomCode ?? s.worldId;
  const players = s.connected > 0 ? ` \u00b7 ${s.connected} PLAYER${s.connected === 1 ? "" : "S"}` : "";
  const away = s.away > 0 ? ` \u00b7 ${s.away} RECONNECTING` : "";
  return `${verb}${where ? ` \u00b7 ${where}` : ""}${players}${away}`;
}

// The hold-Tab details panel line: authoritative world / revision / protocol version.
export function netDetailsLine(worldId: string | null, rev: number | null, protocolVersion: number): string {
  return `world ${worldId ?? "\u2014"} \u00b7 rev ${rev ?? "\u2014"} \u00b7 protocol v${protocolVersion}`;
}

// ---- reconnect overlay state machine ----
// 0-3s: a calm CONNECTION LOST / Reconnecting… (most blips end here — no scary counters).
// 3s+:  the attempt counter + the cancel affordance + the seat-grace countdown.

export interface ReconnectOverlayCopy {
  title: string;
  line: string;
  hint: string | null;
}

const RECONNECT_CALM_MS = 3000;

export function reconnectOverlayCopy(nowMs: number, info: ReconnectInfo): ReconnectOverlayCopy {
  const elapsed = nowMs - info.startedAtMs;
  if (elapsed < RECONNECT_CALM_MS) {
    return { title: "CONNECTION LOST", line: "Reconnecting\u2026", hint: null };
  }
  const graceLeft = Math.max(0, Math.ceil((info.graceEndsAtMs - nowMs) / 1000));
  return {
    title: "CONNECTION LOST",
    line: `Reconnecting\u2026 (attempt ${Math.max(1, info.attempt)})`,
    hint: `${CONNECT_CANCEL_HINT} \u00b7 your blob is safe for another ${graceLeft}s`,
  };
}

// ---- exit notes (the room-lobby status line after a run ends without a game over) ----

export type OnlineExitReason = "quit" | "connect_failed" | "world_mismatch" | "party_incomplete" | "connection_lost" | "superseded" | "run_ended_away";

export function exitNoteFor(reason: OnlineExitReason | undefined, detail?: string): string {
  switch (reason) {
    case "connect_failed": return "couldn't reach the game server \u2014 try again in a moment";
    case "world_mismatch": return WORLD_MISMATCH_NOTE;
    case "party_incomplete": return `the party never assembled${detail ? ` \u2014 still waiting on ${detail}` : ""} \u2014 regroup and start again`;
    case "connection_lost": return `connection lost and the reconnect window ran out${detail ? ` (${detail})` : ""} \u2014 REJOIN RUN if the party is still going`;
    case "superseded": return "another tab or device took over this player \u2014 this session stepped aside";
    case "run_ended_away": return RUN_ENDED_AWAY_NOTE;
    default: return "";
  }
}
