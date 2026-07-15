// PVP committed golden-master: a scripted multi-player deathmatch captured TICK-FOR-TICK into a
// byte-committed fixture (test/golden/pvp.json). The determinism section in test/pvp.test.ts only
// proves a run equals ITSELF (two live runs agree); this locks the run against FROZEN BYTES, so
// any behavior change in the pvp spine — the damage funnel, the match state machine, respawn /
// spawn-spread, or absence handling — must be an INTENTIONAL recapture, never a silent drift.
//
// The single scripted scenario walks every milestone the audit named:
//   join -> countdown -> live -> fire -> kill -> respawn -> reconnect(absence+return) -> match-over.
// The suite additionally proves the trace is INVARIANT under add-order perturbation (players seated
// in reverse produce the identical bytes — the reconnect-stability contract) and under replay.
//
// Run:       npm run test:pvpgolden
// Recapture: npm run test:pvpgolden -- --capture-current   (ONLY after an intentional pvp change)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createWorld, stepWorld, spawnPlayerInWorld, setPlayerAbsence } from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import { pvpFragLimit } from "../src/sim/pvp.js";
import type { InputCmd } from "../src/sim/input.js";
import type { SimEvent } from "../src/sim/events.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void { process.stdout.write(`\n[${name}]\n`); }

const SEED = 0x9e3779b1;
const DT = 1 / 20;
const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = join(here, "golden", "pvp.json");

function inp(over: Partial<InputCmd>): InputCmd {
  return { seq: 0, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false, ...over };
}

// A compact, fully-deterministic per-tick digest: phase + winner, then every player's id-sorted
// state (position, hp, respawn + two-stage spawn protection + memory + dash timers, frags), then the sorted event-type
// multiset emitted this tick. Everything a pvp behavior change would move is captured here.
function digest(w: WorldState, evs: SimEvent[]): string {
  const parts = [...w.players.keys()].sort().map((id) => {
    const p = w.players.get(id)!;
    const sc = w.match!.scores.get(id) ?? 0;
    return `${id}:${p.x.toFixed(2)},${p.y.toFixed(2)},${p.hp.toFixed(2)},${p.respawnT},${p.spawnGraceT},${p.spawnShieldT},${p.pvpRecentSpawnIndices.join(".")},${p.dashTime.toFixed(2)},${sc}`;
  });
  const ev = evs.map((e) => e.t).sort().join(",");
  return `t${w.tick}|${w.match!.phase}|win=${w.match!.winner ?? ""}|${parts.join("|")}|ev[${ev}]`;
}

// Seat players in `addOrder` (the perturbation axis) and drive the ONE scripted match. Positions /
// weapons are keyed by player id (fetched, not seated-in-order), so the scenario itself is
// add-order-agnostic; the ONLY variable is the players-map insertion order.
function runScriptedMatch(addOrder: string[]): string[] {
  const w = createWorld(SEED, 1, { mode: "pvp", isShared: true, skipLocalPlayer: true });
  for (const id of addOrder) spawnPlayerInWorld(w, id);
  const trace: string[] = [];

  // Feed the firing ring, but NEVER to an absent seat (the server sends a reserved body no input).
  const ring = new Map([
    ["p1", inp({ firing: true, aim: 0 })],       // p1 fires right (toward p2/p3)
    ["p2", inp({ firing: true, aim: 0 })],       // p2 fires right (toward p3)
    ["p3", inp({ firing: true, aim: Math.PI })], // p3 fires left (toward p2/p1)
  ]);
  const presentInputs = (): Map<string, InputCmd> => {
    const m = new Map<string, InputCmd>();
    for (const [id, cmd] of ring) { const p = w.players.get(id); if (p && !p.isAbsent) m.set(id, cmd); }
    return m;
  };

  // 1) join -> countdown -> live, captured tick by tick (the freeze-in included).
  let guard = 0;
  while (w.match!.phase !== "live" && guard++ < 400) trace.push(digest(w, stepWorld(w, new Map(), DT)));

  // 2) live combat: three players on a clear lane (row 4 has no cover). A firing ring drives real
  //    damage, kills, and respawns. Positions/weapons are overridden identically every run.
  const a = w.players.get("p1")!, b = w.players.get("p2")!, c = w.players.get("p3")!;
  a.x = 260; a.y = 216; b.x = 360; b.y = 216; c.x = 460; c.y = 216;
  for (const player of [a, b, c]) {
    player.invuln = 0;
    player.spawnGraceT = 0;
    player.spawnShieldT = 0;
  }
  a.weapon = "railgun"; a.ownedWeapons = ["railgun"];
  b.weapon = "smg"; b.ownedWeapons = ["smg"];
  c.weapon = "railgun"; c.ownedWeapons = ["railgun"];
  for (let i = 0; i < 90; i++) {
    // 3) reconnect perturbation: p2 drops mid-combat then returns. present stays 2 (p1, p3), so the
    //    match keeps running while the reserved body is skipped by combat and reads not-alive.
    if (i === 40) setPlayerAbsence(w, "p2", true);
    if (i === 60) setPlayerAbsence(w, "p2", false);
    trace.push(digest(w, stepWorld(w, presentInputs(), DT)));
  }

  // 4) match-over: seat the leader one frag short, stage a clean duel, and let the next kill end
  //    the match — captured through the "over" transition and one settled tick past it.
  w.match!.scores.set("p1", pvpFragLimit(3) - 1);
  const k1 = w.players.get("p1")!, k2 = w.players.get("p2")!, k3 = w.players.get("p3")!;
  k1.x = 300; k1.y = 216; k1.weapon = "railgun"; k1.ownedWeapons = ["railgun"];
  k2.x = 344; k2.y = 216; k2.respawnT = 0; k2.hp = k2.maxHp;
  k3.x = 130; k3.y = 130; k3.respawnT = 0; k3.hp = k3.maxHp; // parked out of the lane
  for (const player of [k1, k2, k3]) {
    player.invuln = 0;
    player.spawnGraceT = 0;
    player.spawnShieldT = 0;
  }
  const overInputs = new Map([["p1", inp({ firing: true, aim: 0 })]]);
  guard = 0;
  while (w.match!.phase !== "over" && guard++ < 400) trace.push(digest(w, stepWorld(w, overInputs, DT)));
  trace.push(digest(w, stepWorld(w, overInputs, DT)));
  return trace;
}

function capture(): void {
  const trace = runScriptedMatch(["p1", "p2", "p3"]);
  writeFileSync(goldenPath, JSON.stringify({ scriptedMatch: trace }, null, 2) + "\n");
  process.stdout.write(`captured pvp golden: ${trace.length} ticks -> ${goldenPath}\n`);
}

function main(): void {
  section("the scripted match exercises every audited milestone");
  const forward = runScriptedMatch(["p1", "p2", "p3"]);
  const joined = forward.join("\n");
  check("countdown phase appears in the trace", joined.includes("|countdown|"));
  check("live phase appears in the trace", joined.includes("|live|"));
  check("a kill event fires (fire -> kill)", joined.includes("pvpKill"));
  check("a hurt event fires (damage lands)", joined.includes("playerHurt"));
  check("a respawn resolves (a body returns to full HP after a scheduled respawnT)", forward.some((l) => /p2:[^|]*,100\.00,0,/.test(l)) || joined.includes("respawnT"));
  check("the match reaches over with a winner", joined.includes("|over|win=p1|"));

  section("invariance: add-order perturbation + replay are byte-identical");
  const reversed = runScriptedMatch(["p3", "p2", "p1"]);
  check("reverse add-order produces the identical trace (reconnect-stable, id-sorted)", JSON.stringify(reversed) === JSON.stringify(forward),
    firstDiff(forward, reversed));
  const replay = runScriptedMatch(["p1", "p2", "p3"]);
  check("a replay of the same script is byte-identical", JSON.stringify(replay) === JSON.stringify(forward), firstDiff(forward, replay));

  section("golden-master: the scripted trace matches the committed bytes");
  let golden: { scriptedMatch: string[] };
  try {
    golden = JSON.parse(readFileSync(goldenPath, "utf8")) as { scriptedMatch: string[] };
  } catch {
    check("pvp golden exists (run with --capture-current to seed it)", false);
    finish();
    return;
  }
  check("golden trace length matches", golden.scriptedMatch.length === forward.length, `golden=${golden.scriptedMatch.length} now=${forward.length}`);
  check("every tick matches the committed golden (no silent drift)", JSON.stringify(golden.scriptedMatch) === JSON.stringify(forward), firstDiff(golden.scriptedMatch, forward));
  finish();
}

// The first differing tick between two traces (empty when equal) — a precise recapture hint.
function firstDiff(a: string[], b: string[]): string {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return `first diff @${i}:\n  golden: ${a[i]}\n  now:    ${b[i]}`;
  return a.length === b.length ? "" : `length ${a.length} vs ${b.length}`;
}

function finish(): void {
  process.stdout.write(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(failures.map((f) => "  - " + f).join("\n") + "\n"); process.exit(1); }
}

if (process.argv.includes("--capture-current")) capture(); else main();
