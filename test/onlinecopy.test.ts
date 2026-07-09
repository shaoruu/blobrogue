// The UI Director's P0 copy contract, locked verbatim: HUD label shape, the reconnect
// overlay's calm->detailed state machine (0-3s / 3s+), the exact mismatch / run-ended /
// toast strings, the exit notes, and the hold-to-START-ANYWAY labels. Every string a player
// sees for online connection states comes from src/ui/onlineCopy.ts — this suite is the
// drift tripwire.
// Run: npm run test:onlinecopy

import {
  onlineHudLabel, netDetailsLine, reconnectOverlayCopy, exitNoteFor, startAnywayHoldLabel,
  WORLD_MISMATCH_NOTE, RUN_ENDED_AWAY_NOTE, BACK_ONLINE_TOAST, CONNECT_CANCEL_HINT,
  READY_LABEL, NOT_READY_LABEL, START_ANYWAY_IDLE, START_ANYWAY_HOLD_MS,
} from "../src/ui/onlineCopy.js";
import type { ReconnectInfo } from "../src/client/wsTransport.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

function info(startedAtMs: number, attempt: number, graceEndsAtMs: number): ReconnectInfo {
  return { isReconnecting: true, attempt, startedAtMs, graceEndsAtMs };
}

function main(): void {
  section("normal HUD: CONNECTED · ROOM CODE · N PLAYERS");
  check("the contract's exact shape",
    onlineHudLabel({ phase: "connected", roomCode: "ABCD", worldId: "room:ABCD", connected: 3, away: 0 }) === "CONNECTED \u00b7 ABCD \u00b7 3 PLAYERS");
  check("singular player",
    onlineHudLabel({ phase: "connected", roomCode: "ABCD", worldId: "room:ABCD", connected: 1, away: 0 }) === "CONNECTED \u00b7 ABCD \u00b7 1 PLAYER");
  check("mid-outage members appended explicitly",
    onlineHudLabel({ phase: "connected", roomCode: "ABCD", worldId: "room:ABCD", connected: 2, away: 1 }) === "CONNECTED \u00b7 ABCD \u00b7 2 PLAYERS \u00b7 1 RECONNECTING");
  check("dev joins fall back to the world id",
    onlineHudLabel({ phase: "connected", roomCode: null, worldId: "arena-1", connected: 2, away: 0 }) === "CONNECTED \u00b7 arena-1 \u00b7 2 PLAYERS");
  check("transitional phases swap the verb",
    onlineHudLabel({ phase: "connecting", roomCode: "ABCD", worldId: null, connected: 0, away: 0 }) === "CONNECTING \u00b7 ABCD"
    && onlineHudLabel({ phase: "reconnecting", roomCode: "ABCD", worldId: "room:ABCD", connected: 1, away: 1 }).startsWith("RECONNECTING")
    && onlineHudLabel({ phase: "waiting", roomCode: "ABCD", worldId: "room:ABCD", connected: 1, away: 0 }).startsWith("WAITING FOR PARTY"));
  check("teammates mid-pick append the held-gate explanation",
    onlineHudLabel({ phase: "connected", roomCode: "ABCD", worldId: null, connected: 2, away: 0, waitingPicks: 1 }) === "CONNECTED \u00b7 ABCD \u00b7 2 PLAYERS \u00b7 WAITING ON 1 PICK"
    && onlineHudLabel({ phase: "connected", roomCode: "ABCD", worldId: null, connected: 3, away: 0, waitingPicks: 2 }).endsWith("WAITING ON 2 PICKS"));
  check("details panel line carries world/rev/version", netDetailsLine("room:ABCD", 3, 4) === "world room:ABCD \u00b7 rev 3 \u00b7 protocol v4");
  check("details panel line degrades before the first snapshot", netDetailsLine(null, null, 4) === "world \u2014 \u00b7 rev \u2014 \u00b7 protocol v4");

  section("reconnect overlay state machine: calm 0-3s, detailed 3s+");
  const t0 = 100_000;
  const calm = reconnectOverlayCopy(t0 + 2999, info(t0, 3, t0 + 90000));
  check("0-3s: CONNECTION LOST title", calm.title === "CONNECTION LOST");
  check("0-3s: plain Reconnecting… (no attempt counter, no scary numbers)", calm.line === "Reconnecting\u2026" && calm.hint === null);
  const detailed = reconnectOverlayCopy(t0 + 3000, info(t0, 4, t0 + 90000));
  check("3s+: attempt counter appears", detailed.line === "Reconnecting\u2026 (attempt 4)", detailed.line);
  check("3s+: cancel affordance + seat-grace countdown", detailed.hint === `${CONNECT_CANCEL_HINT} \u00b7 your blob is safe for another 87s`, detailed.hint ?? "");
  const lateGrace = reconnectOverlayCopy(t0 + 89000, info(t0, 9, t0 + 90000));
  check("countdown floors at the remaining grace", (lateGrace.hint ?? "").endsWith("for another 1s"));

  section("exact one-off strings");
  check("world mismatch", WORLD_MISMATCH_NOTE === "World mismatch \u2014 rejoining the party\u2026");
  check("run ended while away", RUN_ENDED_AWAY_NOTE === "RUN ENDED WHILE AWAY");
  check("back online toast", BACK_ONLINE_TOAST === "BACK ONLINE");
  check("ready labels", READY_LABEL === "READY" && NOT_READY_LABEL === "NOT READY");

  section("exit notes route the exact copy");
  check("world_mismatch note IS the contract string", exitNoteFor("world_mismatch") === WORLD_MISMATCH_NOTE);
  check("run_ended_away note IS the contract string", exitNoteFor("run_ended_away") === RUN_ENDED_AWAY_NOTE);
  check("connection_lost offers REJOIN", exitNoteFor("connection_lost").includes("REJOIN RUN"));
  check("a plain quit adds no note", exitNoteFor("quit") === "" && exitNoteFor(undefined) === "");

  section("START ANYWAY is a 3s hold");
  check("hold duration is exactly 3s", START_ANYWAY_HOLD_MS === 3000);
  check("idle label says so", START_ANYWAY_IDLE === "START ANYWAY \u2014 hold 3s");
  check("holding counts down and offers the out", startAnywayHoldLabel(0) === "STARTING IN 3\u2026 release to cancel"
    && startAnywayHoldLabel(2100) === "STARTING IN 1\u2026 release to cancel");

  section("neutral prompts only: controller glyphs wait for real controller support");
  {
    // Enclosed-letter button art (Ⓐ…Ⓩ, 🅐…, 🅰…) and "(A)"-style prompts are banned until a
    // controller actually exists; prompts stay key names + plain verbs.
    const GLYPH_RE = /[\u24B6-\u24CF\u{1F150}-\u{1F169}\u{1F170}-\u{1F189}]|\((?:A|B|X|Y)\)/u;
    const allCopy = [
      WORLD_MISMATCH_NOTE, RUN_ENDED_AWAY_NOTE, BACK_ONLINE_TOAST, CONNECT_CANCEL_HINT,
      READY_LABEL, NOT_READY_LABEL, START_ANYWAY_IDLE, startAnywayHoldLabel(0),
      onlineHudLabel({ phase: "connected", roomCode: "ABCD", worldId: null, connected: 2, away: 1 }),
      reconnectOverlayCopy(t0 + 5000, info(t0, 2, t0 + 90000)).hint ?? "",
      exitNoteFor("connection_lost"), exitNoteFor("world_mismatch"), exitNoteFor("party_incomplete", "Bob"),
      exitNoteFor("superseded"), exitNoteFor("connect_failed"), exitNoteFor("run_ended_away"),
    ];
    check("every contract string is controller-glyph free", allCopy.every((s) => !GLYPH_RE.test(s)));
    check("the cancel prompt names the key, not a pad button", CONNECT_CANCEL_HINT === "ESC \u2014 cancel");
  }

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll UI copy contract assertions passed.\n");
}

main();
