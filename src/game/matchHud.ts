// PVP arena match -> HUD presentation. The authoritative match block (MatchWire) rides every
// online PVP snapshot; this module turns it into the exact readouts the arena HUD renders — a
// deterministic (id-sorted) frag scoreboard, the live match timer, the pre-fight countdown, and
// the win/lose result. It is PURE and unit-tested (test/matchhud.test.ts): the Hud class only
// RENDERS the MatchHudState this produces, and game.ts only FEEDS it the authoritative snapshot.
// null in co-op, so the whole arena HUD path is inert there by construction.

import { FIXED_DT, type MatchWire } from "../net/protocol.js";
import type { MatchPhase } from "../sim/pvp.js";
import type { PlayerId } from "../sim/input.js";
import type { HpDisplay } from "./settings.js";

// One scoreboard row (already resolved for presentation: display name, self flag, alive flag).
export interface MatchScoreRow {
  id: PlayerId;
  name: string;     // display name (self resolves to "YOU" upstream); id is the last fallback
  frags: number;
  isAlive: boolean;
  isSelf: boolean;
}

// The presentation-ready match block the Hud renders. Everything the arena HUD needs, already
// derived from the wire — the renderer does no math and never sees a tick or an end-tick.
export interface MatchHudState {
  phase: MatchPhase;
  scores: MatchScoreRow[];      // id-sorted (identical ordering on every client)
  timeLeft: number;             // whole seconds left in the LIVE phase (0 otherwise / untimed)
  countdown: number;            // whole seconds left in the COUNTDOWN phase (0 otherwise)
  selfFrags: number;            // the local player's frag count (the lane readout convenience)
  isSelfWinner: boolean | null; // over: did the local player win? null until "over"
}

// Whole seconds remaining until an absolute end-tick, from the current tick. Ceil so the final
// second reads "1" for its whole duration and never flashes a premature 0 (the same math the
// PVP audio observer already uses for its countdown ticks).
export function ticksLeftSeconds(endTick: number, tick: number): number {
  return Math.max(0, Math.ceil((endTick - tick) * FIXED_DT));
}

export interface MatchHudContext {
  selfId: PlayerId | null;
  tick: number;
  // Resolve a player id to its display name; `isSelf` lets the caller answer "YOU" for the local
  // player without a second id compare.
  nameOf: (id: PlayerId, isSelf: boolean) => string;
}

// Wire -> presentation. Pure; the ONE place MatchWire is read for the HUD.
export function buildMatchHud(match: MatchWire, ctx: MatchHudContext): MatchHudState {
  const secs = ticksLeftSeconds(match.end, ctx.tick);
  const scores: MatchScoreRow[] = match.sc
    .map((s): MatchScoreRow => {
      const isSelf = ctx.selfId !== null && s.id === ctx.selfId;
      return { id: s.id, name: ctx.nameOf(s.id, isSelf), frags: s.f, isAlive: s.a, isSelf };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const self = scores.find((s) => s.isSelf) ?? null;
  return {
    phase: match.ph,
    scores,
    timeLeft: match.ph === "live" ? secs : 0,
    countdown: match.ph === "countdown" ? secs : 0,
    selfFrags: self ? self.frags : 0,
    isSelfWinner: match.ph === "over" ? ctx.selfId !== null && match.win === ctx.selfId : null,
  };
}

// mm:ss for the match timer.
export function fmtMatchClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// The top-center objective lane in a PVP arena: it REPLACES the co-op FLOOR/GO-DOWN copy with the
// match phase readout (never a dungeon objective). Live shows the clock + the local frag count.
export function matchLaneCopy(m: MatchHudState): string {
  if (m.phase === "countdown") return "ARENA \u00b7 GET READY";
  if (m.phase === "live") return `ARENA \u00b7 ${fmtMatchClock(m.timeLeft)} \u00b7 ${m.selfFrags} ${m.selfFrags === 1 ? "FRAG" : "FRAGS"}`;
  if (m.phase === "over") return "ARENA \u00b7 MATCH OVER";
  return "ARENA \u00b7 WAITING FOR PLAYERS"; // lobby
}

// The big center readout: the pre-fight countdown (3..2..1 then FIGHT) and the win/lose result.
// null while the center is quiet (lobby / live). `kind` drives the accent class.
export interface MatchCenter {
  text: string;
  kind: "countdown" | "fight" | "win" | "lose";
}
export function matchCenter(m: MatchHudState): MatchCenter | null {
  if (m.phase === "countdown") {
    return m.countdown > 0 ? { text: String(m.countdown), kind: "countdown" } : { text: "FIGHT", kind: "fight" };
  }
  if (m.phase === "over") {
    return m.isSelfWinner ? { text: "VICTORY", kind: "win" } : { text: "DEFEATED", kind: "lose" };
  }
  return null;
}

// PVP shows ONE continuous HP bar (a 100-HP pool, not a few hearts); co-op keeps the heart /
// number readout per the player's setting. The ONE selector both the HUD render and its test use.
export type HpReadout = HpDisplay | "bar";
export function hpReadout(isPvp: boolean, setting: HpDisplay): HpReadout {
  return isPvp ? "bar" : setting;
}
