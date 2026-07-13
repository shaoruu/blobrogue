// PVP arena HUD derivation suite: the PURE wire->presentation math that the arena HUD renders
// from the authoritative match block. This is the layer the shipped bug lacked entirely (the
// client never converted the match state into a HUD readout), so these lock every branch:
//   - the id-sorted frag scoreboard (deterministic order, self flag, alive flag, self frags),
//   - the live match timer + the pre-fight countdown seconds (ceil, floored at 0),
//   - the win/lose resolution vs the local id,
//   - the objective-lane copy per phase (never the co-op FLOOR/GO-DOWN string),
//   - the big center countdown/result readout,
//   - the heart-vs-bar HP selector.
//
// Run: npm run test:matchhud

import {
  buildMatchHud, matchLaneCopy, matchCenter, hpReadout, fmtMatchClock, ticksLeftSeconds,
} from "../src/game/matchHud.js";
import { FIXED_DT, type MatchWire } from "../src/net/protocol.js";
import type { HpDisplay } from "../src/game/settings.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

function mw(over: Partial<MatchWire> = {}): MatchWire {
  return { ph: "live", end: 0, sc: [], win: null, ...over };
}

// A stable name resolver for the pure tests: self reads YOU, others read their id upper-cased.
const nameOf = (id: string, isSelf: boolean): string => (isSelf ? "YOU" : id.toUpperCase());

function ticksTests(): void {
  section("ticksLeftSeconds: ceil math, floored at 0 (matches the audio observer's countdown)");
  // The whole suite's timing assumes the shipped 20Hz authoritative step; assert it so a tick-rate
  // change surfaces here loudly instead of silently skewing the timer/countdown expectations.
  check("the authoritative step is 20Hz (FIXED_DT = 0.05s)", FIXED_DT === 0.05, `FIXED_DT=${FIXED_DT}`);
  check("a full 60-tick gap reads 3s", ticksLeftSeconds(60, 0) === 3, String(ticksLeftSeconds(60, 0)));
  check("a 20-tick gap reads 1s", ticksLeftSeconds(120, 100) === 1);
  check("a single remaining tick still reads 1s (never a flashed 0)", ticksLeftSeconds(101, 100) === 1);
  check("exactly at the end reads 0s", ticksLeftSeconds(100, 100) === 0);
  check("past the end floors at 0 (never negative)", ticksLeftSeconds(90, 100) === 0);

  section("fmtMatchClock: mm:ss");
  check("90s -> 1:30", fmtMatchClock(90) === "1:30", fmtMatchClock(90));
  check("5s zero-pads the seconds", fmtMatchClock(5) === "0:05", fmtMatchClock(5));
  check("125s -> 2:05", fmtMatchClock(125) === "2:05", fmtMatchClock(125));
  check("negative floors at 0:00", fmtMatchClock(-3) === "0:00");
}

function scoreboardTests(): void {
  section("buildMatchHud: the scoreboard is id-sorted (deterministic on every client)");
  const match = mw({
    ph: "live", end: 120, sc: [
      { id: "p3", f: 5, a: true },
      { id: "p1", f: 2, a: false },
      { id: "p2", f: 9, a: true },
    ],
  });
  const hud = buildMatchHud(match, { selfId: "p2", tick: 60, nameOf });
  check("rows sort by id regardless of wire order", hud.scores.map((r) => r.id).join(",") === "p1,p2,p3", hud.scores.map((r) => r.id).join(","));
  check("frags ride each row", hud.scores.map((r) => r.frags).join(",") === "2,9,5");
  check("alive flags ride each row", hud.scores.map((r) => (r.isAlive ? 1 : 0)).join(",") === "0,1,1");

  section("buildMatchHud: the self row is flagged and named YOU");
  check("exactly one row is flagged self", hud.scores.filter((r) => r.isSelf).length === 1);
  const self = hud.scores.find((r) => r.isSelf)!;
  check("the self flag lands on the local id", self.id === "p2");
  check("the self row resolves to YOU via nameOf", self.name === "YOU");
  check("an opponent row resolves to its name", hud.scores.find((r) => r.id === "p1")!.name === "P1");
  check("selfFrags mirrors the self row", hud.selfFrags === 9, String(hud.selfFrags));

  section("buildMatchHud: a spectator/unknown self id yields no self row");
  const none = buildMatchHud(match, { selfId: null, tick: 60, nameOf });
  check("no row is flagged self when selfId is null", none.scores.every((r) => !r.isSelf));
  check("selfFrags is 0 with no self row", none.selfFrags === 0);
}

function phaseTests(): void {
  section("buildMatchHud: timer only during live, countdown only during countdown");
  const live = buildMatchHud(mw({ ph: "live", end: 120, sc: [] }), { selfId: "p1", tick: 60, nameOf });
  check("live carries the timer (60 ticks -> 3s)", live.timeLeft === 3 && live.countdown === 0, `t=${live.timeLeft} c=${live.countdown}`);
  const cd = buildMatchHud(mw({ ph: "countdown", end: 60, sc: [] }), { selfId: "p1", tick: 0, nameOf });
  check("countdown carries the countdown (60 ticks -> 3s), no timer", cd.countdown === 3 && cd.timeLeft === 0, `t=${cd.timeLeft} c=${cd.countdown}`);
  const lobby = buildMatchHud(mw({ ph: "lobby", end: 0, sc: [] }), { selfId: "p1", tick: 0, nameOf });
  check("lobby has neither a timer nor a countdown", lobby.timeLeft === 0 && lobby.countdown === 0);
  check("phase rides through untouched", live.phase === "live" && cd.phase === "countdown" && lobby.phase === "lobby");

  section("buildMatchHud: the winner resolves against the local id, only when over");
  const win = buildMatchHud(mw({ ph: "over", end: 0, win: "p1", sc: [{ id: "p1", f: 3, a: true }] }), { selfId: "p1", tick: 0, nameOf });
  check("the local player winning reads isSelfWinner true", win.isSelfWinner === true);
  const lose = buildMatchHud(mw({ ph: "over", end: 0, win: "p2", sc: [{ id: "p1", f: 1, a: true }] }), { selfId: "p1", tick: 0, nameOf });
  check("another player winning reads isSelfWinner false", lose.isSelfWinner === false);
  check("outside 'over' the winner is null (live)", live.isSelfWinner === null && cd.isSelfWinner === null && lobby.isSelfWinner === null);
  const noSelfWin = buildMatchHud(mw({ ph: "over", end: 0, win: "p1", sc: [] }), { selfId: null, tick: 0, nameOf });
  check("a null self id never claims the win", noSelfWin.isSelfWinner === false);
}

function laneCopyTests(): void {
  section("matchLaneCopy: the arena lane readout REPLACES the co-op FLOOR/GO-DOWN copy per phase");
  const at = (over: Partial<MatchWire>, tick = 0) => matchLaneCopy(buildMatchHud(mw(over), { selfId: "p1", tick, nameOf }));
  check("lobby waits for players", at({ ph: "lobby" }) === "ARENA \u00b7 WAITING FOR PLAYERS");
  check("countdown reads GET READY", at({ ph: "countdown", end: 60 }) === "ARENA \u00b7 GET READY");
  check("live reads the clock + the local frag count",
    at({ ph: "live", end: 1800, sc: [{ id: "p1", f: 4, a: true }] }) === "ARENA \u00b7 1:30 \u00b7 4 FRAGS");
  check("a single frag is singular", at({ ph: "live", end: 20, sc: [{ id: "p1", f: 1, a: true }] }) === "ARENA \u00b7 0:01 \u00b7 1 FRAG");
  check("zero frags is plural", at({ ph: "live", end: 20, sc: [{ id: "p1", f: 0, a: true }] }) === "ARENA \u00b7 0:01 \u00b7 0 FRAGS");
  check("over reads MATCH OVER", at({ ph: "over" }) === "ARENA \u00b7 MATCH OVER");
  // The load-bearing regression guard: the arena lane must NEVER emit the co-op objective words.
  const everyPhase = (["lobby", "countdown", "live", "over"] as const).map((ph) => at({ ph, end: 40, sc: [{ id: "p1", f: 0, a: true }] }));
  check("no arena lane copy ever says FLOOR / GO DOWN / CLEAR (the shipped-bug symptom)",
    everyPhase.every((s) => !/FLOOR|GO DOWN|CLEAR/.test(s)), everyPhase.join(" | "));
}

function centerTests(): void {
  section("matchCenter: the big center countdown -> FIGHT, and the win/lose result");
  const c = (over: Partial<MatchWire>, tick = 0, selfId: string | null = "p1") => matchCenter(buildMatchHud(mw(over), { selfId, tick, nameOf }));
  check("countdown shows the whole-second number", c({ ph: "countdown", end: 60 }, 0)?.text === "3" && c({ ph: "countdown", end: 60 }, 0)?.kind === "countdown");
  check("countdown at 2s reads 2", c({ ph: "countdown", end: 60 }, 20)?.text === "2");
  check("the final tick flips to FIGHT", (() => { const r = c({ ph: "countdown", end: 60 }, 60); return r?.text === "FIGHT" && r.kind === "fight"; })());
  check("live has no center readout (the lane + scoreboard carry it)", c({ ph: "live", end: 100 }, 0) === null);
  check("lobby has no center readout", c({ ph: "lobby" }) === null);
  check("winning shows VICTORY", (() => { const r = c({ ph: "over", win: "p1" }); return r?.text === "VICTORY" && r.kind === "win"; })());
  check("losing shows DEFEATED", (() => { const r = c({ ph: "over", win: "p2" }); return r?.text === "DEFEATED" && r.kind === "lose"; })());
}

function hpReadoutTests(): void {
  section("hpReadout: PVP forces a single HP bar; co-op passes the player's setting through");
  check("pvp always resolves to the bar (never 100 hearts)",
    (["hearts", "both", "number"] as HpDisplay[]).every((m) => hpReadout(true, m) === "bar"));
  check("co-op keeps hearts", hpReadout(false, "hearts") === "hearts");
  check("co-op keeps both", hpReadout(false, "both") === "both");
  check("co-op keeps number-only", hpReadout(false, "number") === "number");
}

function main(): void {
  ticksTests();
  scoreboardTests();
  phaseTests();
  laneCopyTests();
  centerTests();
  hpReadoutTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll PVP match-HUD derivation assertions passed.\n");
}

main();
