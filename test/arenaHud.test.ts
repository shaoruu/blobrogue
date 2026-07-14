import {
  arenaCenterCopy,
  arenaHpView,
  arenaLaneCopy,
  buildArenaMatchHud,
  formatArenaClock,
  ticksLeftSeconds,
} from "../src/game/arenaHud.js";
import type { MatchWire } from "../src/net/protocol.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, isPassing: boolean, detail = ""): void {
  if (isPassing) {
    passed++;
    process.stdout.write(`  PASS ${name}${detail ? ` \u2014 ${detail}` : ""}\n`);
    return;
  }
  failed++;
  failures.push(name + (detail ? ` \u2014 ${detail}` : ""));
  process.stdout.write(`  FAIL ${name}${detail ? ` \u2014 ${detail}` : ""}\n`);
}

function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

function build(match: MatchWire, args: { tick?: number; selfId?: string | null; respawnTicks?: number } = {}) {
  return buildArenaMatchHud({
    match,
    tick: args.tick ?? 100,
    selfId: args.selfId === undefined ? "p2" : args.selfId,
    respawnTicks: args.respawnTicks ?? 0,
    nameOf: (id, isSelf) => isSelf ? "YOU" : `Player ${id}`,
  });
}

const SCORES = [
  { id: "p3", f: 1, a: false },
  { id: "p1", f: 4, a: true },
  { id: "p2", f: 2, a: true },
];

section("authoritative match snapshot to stable presentation");
{
  const live = build({ ph: "live", end: 6080, sc: SCORES, win: null });
  check("scoreboard rows are stable by player id", live.scores.map((row) => row.id).join(",") === "p1,p2,p3");
  check("the local row is named and marked as self", live.scores[1].name === "YOU" && live.scores[1].isSelf);
  check("authoritative alive flags survive intact", live.scores[2].isAlive === false);
  check("the local frag count comes from the match score block", live.selfFrags === 2);
  check("the live timer derives from match.end minus snapshot.tick", live.secondsLeft === 299, `seconds=${live.secondsLeft}`);
  check("clock formatting is fixed-width", formatArenaClock(live.secondsLeft) === "4:59");
  check("live lane carries timer and frags", arenaLaneCopy(live) === "ARENA \u00b7 4:59 \u00b7 2 FRAGS");
}

section("countdown, result, and respawn states");
{
  const countdown = build({ ph: "countdown", end: 160, sc: SCORES, win: null });
  check("countdown uses ceil at the authoritative tick boundary", countdown.secondsLeft === 3);
  check("countdown center shows the current whole second",
    arenaCenterCopy(countdown)?.title === "3" && arenaCenterCopy(countdown)?.detail === "GET READY");
  check("named tick arguments cannot be swapped silently",
    ticksLeftSeconds({ endTick: 121, tick: 100 }) === 2);

  const won = build({ ph: "over", end: 0, sc: SCORES, win: "p2" });
  const lost = build({ ph: "over", end: 0, sc: SCORES, win: "p1" });
  check("result compares the authoritative winner with self",
    won.isSelfWinner === true && lost.isSelfWinner === false);
  check("winner and loser receive distinct result copy",
    arenaCenterCopy(won)?.title === "VICTORY" && arenaCenterCopy(lost)?.title === "DEFEAT");

  const respawning = build(
    { ph: "live", end: 6080, sc: SCORES, win: null },
    { respawnTicks: 41 },
  );
  const center = arenaCenterCopy(respawning);
  check("respawn seconds come from authoritative self.rsp ticks", respawning.respawnSeconds === 3);
  check("respawn overlay names the state and countdown",
    center?.title === "YOU WERE FRAGGED" && center.detail === "RESPAWNING IN 3");
}

section("arena copy cannot fall back to dungeon exit chrome");
{
  const states = [
    null,
    build({ ph: "lobby", end: 0, sc: SCORES, win: null }),
    build({ ph: "countdown", end: 160, sc: SCORES, win: null }),
    build({ ph: "live", end: 6080, sc: SCORES, win: null }),
    build({ ph: "over", end: 0, sc: SCORES, win: "p2" }),
  ];
  const copy = states.map(arenaLaneCopy).join("|");
  check("every phase is arena copy", states.every((state) => arenaLaneCopy(state).startsWith("ARENA")));
  check("no arena phase can emit FLOOR/CLEAR/GO DOWN",
    !/\bFLOOR\b|\bCLEAR\b|GO DOWN/.test(copy), copy);
}

section("continuous numeric HP view");
{
  const hp = arenaHpView({ hp: 74.2, maxHp: 100 });
  check("bar fill is the continuous HP fraction", Math.abs(hp.fill - 0.742) < 1e-9);
  check("numeric HP is concise and rounds remaining health up", hp.text === "75/100");
  const empty = arenaHpView({ hp: -5, maxHp: 0 });
  check("invalid lower bounds clamp safely", empty.fill === 0 && empty.text === "0/0");
}

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(`FAILURES:\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("\nAll arena HUD derivation assertions passed.\n");
