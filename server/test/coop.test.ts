// Same-world co-op correctness over REAL sockets for THIS branch's semantics. (The full
// lobby-to-authoritative trust chain — world-id echo, readiness veil, resume — is the
// Sev-0 coherence system's own suite, PR #39; this file asserts the co-op EXPERIENCE
// features against real clients.) Two real WSTransport clients join through room-scoped
// tickets and the suite asserts:
//   1. identical world truth on both wires — seed, floor, rev, enemy ids/positions,
//      pickup ids/positions, chest ids/state — under production-default FULL snapshots
//   2. verified ticket colors/names reach the OTHER client's wire (remote tint sync)
//   3. the interact intent rides input frames into the sim, and a held E revives a downed
//      teammate end-to-end over the socket
//   4. the spec message sets the server-side spectate target (view centering) and is
//      ignored for junk targets
//   5. wipe -> replay rounds each host a FRESH shared world, and exit readiness (exr)
//      mirrors the descend gate identically for every client
//   6. coherent interest filtering when re-enabled: co-located clients agree on the nearby
//      set, far non-boss entities drop for both, and the party always rides the snapshot
// Run: npm run test:coop (in server/).

import { startTestServer, Bot, idle, waitUntil, sleep } from "../harness/lib.js";
import { TILE } from "../../src/sim/types.js";
import { REVIVE } from "../../src/sim/balance.js";
import { devSpawnEnemy } from "../../src/sim/world.js";
import type { InputCmd } from "../../src/sim/input.js";
import { GameWorld } from "../src/world.js";
import { loadConfig } from "../src/config.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`\n[${name}]\n`);
  try { await fn(); }
  catch (err) { failed++; failures.push(`${name} threw: ${String(err)}`); process.stdout.write(`  FAIL ${name} threw ${String(err)}\n`); }
}

const holdInteract = (): InputCmd => ({ seq: 0, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false, interact: true });

async function main(): Promise<void> {
  await test("online co-op preserves post-phase tick increment and tick-0 Lifebloom", async () => {
    const world = new GameWorld("room:TICK", 0x71c0, false, "coop");
    world.addPlayer("mender", "mender");
    const mender = world.state.players.get("mender")!;
    mender.maxHp = 6;
    mender.hp = 5;
    mender.passiveState = 1;
    mender.lastDamagedTick = -1000;
    mender.selfHealReadyTick = 0;
    world.step(loadConfig({}));
    check("tick-0 Lifebloom pays before the co-op post-phase increment",
      world.state.tick === 1 && mender.hp === 6 && mender.passiveState === 0,
      `tick=${world.state.tick} hp=${mender.hp} passive=${mender.passiveState}`);
  });

  await test("two real clients in one room agree on EVERYTHING (full snapshots, prod default)", async () => {
    const s = await startTestServer();
    try {
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "ian", world: "room:LOVE", name: "ian", colorIndex: 1, script: () => idle() });
      const b = new Bot({ url: s.url, secret: s.secret, playerId: "gf", world: "room:LOVE", name: "gf", colorIndex: 3, script: () => idle() });
      a.start(); b.start();
      await waitUntil(() => a.transport.isReady() && b.transport.isReady(), 3000);
      await sleep(400);
      const sa = a.transport.getLatestSnapshot()!;
      const sb = b.transport.getLatestSnapshot()!;

      check("both clients bound to the room's one world", s.server.getWorld("room:LOVE")?.playerCount === 2);
      check("same seed on both wires", sa.seed === sb.seed);
      check("same floor on both wires", sa.floor === sb.floor && sa.floor === 1);
      check("same world revision on both wires", sa.rev === sb.rev);

      const enemyIdsA = sa.enemies.map((e) => e.id).sort((x, y) => x - y).join(",");
      const enemyIdsB = sb.enemies.map((e) => e.id).sort((x, y) => x - y).join(",");
      check("identical enemy id sets", enemyIdsA === enemyIdsB && enemyIdsA.length > 0, `a=[${enemyIdsA}]`);
      const posB = new Map(sb.enemies.map((e) => [e.id, e]));
      let maxDelta = 0;
      for (const e of sa.enemies) {
        const o = posB.get(e.id);
        if (o) maxDelta = Math.max(maxDelta, Math.hypot(e.x - o.x, e.y - o.y));
      }
      check("enemy positions agree across wires (within a tick of drift)", maxDelta < 24, `maxDelta=${maxDelta.toFixed(1)}px`);

      check("identical pickup ids + positions",
        JSON.stringify(sa.pickups.map((p) => [p.id, p.kind, p.x, p.y])) === JSON.stringify(sb.pickups.map((p) => [p.id, p.kind, p.x, p.y])));
      check("identical chest ids + open state",
        JSON.stringify(sa.chests.map((c) => [c.id, c.kind, c.x, c.y, c.op])) === JSON.stringify(sb.chests.map((c) => [c.id, c.kind, c.x, c.y, c.op]))
        && sa.chests.length > 0, `chests=${sa.chests.length}`);
      check("identical prop sets", sa.props.length === sb.props.length && sa.props.length > 0);

      // Verified ticket identity lands on the OTHER client's wire (the remote-tint fix).
      const gfSeenByIan = sa.players.find((p) => p.id === b.serverId());
      const ianSeenByGf = sb.players.find((p) => p.id === a.serverId());
      check("gf's verified name+color reach ian's wire", gfSeenByIan?.nm === "gf" && gfSeenByIan?.cl === 3, `nm=${gfSeenByIan?.nm} cl=${gfSeenByIan?.cl}`);
      check("ian's verified name+color reach gf's wire", ianSeenByGf?.nm === "ian" && ianSeenByGf?.cl === 1, `nm=${ianSeenByGf?.nm} cl=${ianSeenByGf?.cl}`);
      check("remote renderer surfaces the color", b.transport.remotePlayers()[0]?.colorIndex === 1);

      a.stop(); b.stop();
    } finally { await s.close(); }
  });

  await test("held E revives a downed teammate END-TO-END over the socket", async () => {
    const s = await startTestServer();
    try {
      // Both bots spawn on the same tile; B's script holds the interact key the whole time.
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "downee", world: "room:REVI", script: () => idle() });
      const b = new Bot({ url: s.url, secret: s.secret, playerId: "medic", world: "room:REVI", script: () => holdInteract() });
      a.start(); b.start();
      await waitUntil(() => a.transport.isReady() && b.transport.isReady(), 3000);

      const world = s.server.getWorld("room:REVI")!;
      world.state.isGodMode = false;
      const aSim = world.state.players.get(a.serverId()!)!;
      const bSim = world.state.players.get(b.serverId()!)!;
      // Down A authoritatively (the sim path is covered by the pure suites; this test is
      // about the WIRE: the act bit -> isInteracting -> channel -> revive -> snapshots).
      aSim.isDown = true; aSim.hp = 0;

      const held = await waitUntil(() => bSim.isInteracting, 2000);
      check("the medic's held act bit reached the server sim", held);

      const revived = await waitUntil(() => !aSim.isDown && aSim.hp === REVIVE.hp, 4000);
      check("the downed teammate came back at the revive HP", revived, `isDown=${aSim.isDown} hp=${aSim.hp}`);
      check("channel progress cleared after the revive", aSim.reviveProgress === 0);

      // Both clients read the revive from their snapshots (down flag + hp).
      const seenUp = await waitUntil(() => {
        const snap = b.transport.getLatestSnapshot();
        const mate = snap?.players.find((p) => p.id === a.serverId());
        return mate !== undefined && !mate.down;
      }, 2000);
      check("the reviver's wire shows the teammate back up", seenUp);

      a.stop(); b.stop();
    } finally { await s.close(); }
  });

  await test("the spec message steers the server-side spectate target (and rejects junk)", async () => {
    const s = await startTestServer();
    try {
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "watcher", world: "room:SPEC", script: () => idle() });
      const b = new Bot({ url: s.url, secret: s.secret, playerId: "runner", world: "room:SPEC", script: () => idle() });
      a.start(); b.start();
      await waitUntil(() => a.transport.isReady() && b.transport.isReady(), 3000);

      const world = s.server.getWorld("room:SPEC")!;
      const connA = [...world.conns.values()].find((c) => c.playerId === a.serverId())!;
      a.transport.sendSpectate(b.serverId()!);
      const set = await waitUntil(() => connA.spectateTarget === b.serverId(), 2000);
      check("a valid spectate target lands on the connection", set, `target=${connA.spectateTarget}`);

      a.transport.sendSpectate("p999-not-here");
      const cleared = await waitUntil(() => connA.spectateTarget === null, 2000);
      check("a junk target clears the preference (publisher falls back to first living)", cleared);

      a.stop(); b.stop();
    } finally { await s.close(); }
  });

  await test("wipe -> replay: the room hosts a FRESH shared world every round, nobody stranded", async () => {
    const s = await startTestServer();
    try {
      const seeds: number[] = [];
      // Three rounds in the same room: the first run, the replay, and the replay's replay
      // (idempotence). Each round is a fresh pair of client connections — exactly what the
      // lobby's regroup-then-START produces.
      for (let round = 1; round <= 3; round++) {
        const a = new Bot({ url: s.url, secret: s.secret, playerId: `ian-r${round}`, world: "room:AGN", script: () => idle() });
        const b = new Bot({ url: s.url, secret: s.secret, playerId: `gf-r${round}`, world: "room:AGN", script: () => idle() });
        a.start(); b.start();
        const ready = await waitUntil(() => a.transport.isReady() && b.transport.isReady(), 3000);
        check(`round ${round}: both members joined the room's world (nobody stranded)`, ready);
        await sleep(250);
        const world = s.server.getWorld("room:AGN")!;
        seeds.push(world.state.seed);
        const sa = a.transport.getLatestSnapshot()!;
        const sb = b.transport.getLatestSnapshot()!;
        check(`round ${round}: a FRESH run (floor 1, not over) on both wires`,
          !sa.over && !sb.over && sa.floor === 1 && sb.floor === 1);
        check(`round ${round}: both wires carry the same seed/rev`,
          sa.seed === sb.seed && sa.seed === world.state.seed && sa.rev === sb.rev);
        check(`round ${round}: identical enemy sets`,
          sa.enemies.map((e) => e.id).sort((x, y) => x - y).join(",") === sb.enemies.map((e) => e.id).sort((x, y) => x - y).join(",")
          && sa.enemies.length > 0);

        // Wipe the party in one tick: both members die with no standing ally left.
        for (const bot of [a, b]) {
          const p = world.state.players.get(bot.serverId()!)!;
          p.hp = 1; p.invuln = 0; p.dashInvuln = 0;
          world.state.bullets.push({
            x: p.x, y: p.y, vx: 0, vy: 0, radius: 8, life: 1, friendly: false,
            owner: null, damage: 5, color: "#f00", pierce: 0, hitList: null, isCrit: false,
          });
        }
        // The wipe is the held 4.0s all-down beat (gate §6) before the terminal close.
        const ended = await waitUntil(() => a.transport.isRunOver() || a.transport.getStatus() === "closed", 8000);
        check(`round ${round}: clients observed the wipe (terminal snapshot or server close)`, ended);
        // The server closes every socket after the final snapshot and RELEASES the world —
        // the replay can never inherit the dead run.
        const released = await waitUntil(() => s.server.getWorld("room:AGN") === undefined, 3000);
        check(`round ${round}: old sockets closed + world released after the wipe`, released);
        a.stop(); b.stop();
      }
      check("every replay rolled its own fresh run seed", new Set(seeds).size === seeds.length, seeds.join(","));
    } finally { await s.close(); }
  });

  await test("exit readiness (exr) rides both wires identically and mirrors the descend gate", async () => {
    const s = await startTestServer();
    try {
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "stair-a", world: "room:EXIT", script: () => idle() });
      const b = new Bot({ url: s.url, secret: s.secret, playerId: "stair-b", world: "room:EXIT", script: () => idle() });
      a.start(); b.start();
      await waitUntil(() => a.transport.isReady() && b.transport.isReady(), 3000);
      const world = s.server.getWorld("room:EXIT")!;
      // Clear the floor authoritatively and stage A on the stairs; B stays at spawn.
      world.state.enemies = [];
      world.state.pendingSpawns = [];
      const ex = world.state.dungeon.exit.x * TILE + TILE / 2, ey = world.state.dungeon.exit.y * TILE + TILE / 2;
      const aSim = world.state.players.get(a.serverId()!)!;
      aSim.x = ex; aSim.y = ey;
      await waitUntil(() => (a.transport.getLatestSnapshot()?.exr.length ?? 0) === 1, 2000);
      const sa = a.transport.getLatestSnapshot()!;
      const sb = b.transport.getLatestSnapshot()!;
      check("both wires agree exactly one member is staged", sa.exr.length === 1 && sb.exr.length === 1);
      check("both wires agree on WHO is staged", sa.exr[0] === a.serverId() && sb.exr[0] === a.serverId());
      check("client transport surfaces the readiness set", a.transport.exitReadyParty().length === 1);
      check("no descend while the gate waits", sa.floor === 1 && world.state.floor === 1);

      // B stages too: the gate satisfies and immediately raises the party's blessing offers.
      const bSim = world.state.players.get(b.serverId()!)!;
      bSim.x = ex; bSim.y = ey;
      const offered = await waitUntil(() => (b.transport.getLatestSnapshot()?.wait.length ?? 0) === 2, 2000);
      check("all-at-exit flips straight into the party blessing gate (pnd on both wires)",
        offered && (a.transport.getLatestSnapshot()?.wait.length ?? 0) === 2);
      check("still floor 1 until the picks resolve", world.state.floor === 1);
      // The expiry countdown is AUTHORITATIVE state riding the wire: both clients read the
      // same seconds, and they fall with the server's sim clock — no client ever times out
      // a pick locally (resolution/expiry arrive as snapshots or not at all).
      const secondsOf = (bot: Bot): number[] => (bot.transport.getLatestSnapshot()?.wait ?? []).map((p) => p.s).sort();
      const t0 = secondsOf(a);
      check("both wires read the same authoritative countdown", t0.join(",") === secondsOf(b).join(",") && t0.every((s) => s > 0), t0.join(","));
      const isFalling = await waitUntil(() => {
        const now = secondsOf(a);
        return now.length === 2 && now[0] < t0[0];
      }, 3000);
      check("the countdown falls with the server clock on the wire", isFalling,
        `t0=${t0.join(",")} now=${secondsOf(a).join(",")}`);
      a.stop(); b.stop();
    } finally { await s.close(); }
  });

  await test("boss weapon choices END-TO-END: shared pedestals, personal claims, no depletion", async () => {
    const s = await startTestServer();
    try {
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "claim-a", world: "room:CLMS", script: () => idle() });
      const b = new Bot({ url: s.url, secret: s.secret, playerId: "claim-b", world: "room:CLMS", script: () => idle() });
      a.start(); b.start();
      await waitUntil(() => a.transport.isReady() && b.transport.isReady(), 3000);
      const world = s.server.getWorld("room:CLMS")!;
      world.state.enemies = [];
      world.state.pendingSpawns = [];
      // The encounter snapshot a boss floor would carry (P is snapshotted at floor build;
      // this harness world was built before the bots joined).
      world.state.encounterPlayers = 2;
      const aSim = world.state.players.get(a.serverId()!)!;
      const bSim = world.state.players.get(b.serverId()!)!;
      // A signature-bearing boss chest (every real boss drop carries one); opening it spills
      // the min(P+1,5) personal-choice pedestals through the production path.
      world.state.chests.push({ id: world.state.nextChestId++, kind: "boss", x: aSim.x + 40, y: aSim.y, radius: 18, opened: false, weapon: "mortar" });
      aSim.x += 40; // walk onto the chest: openChest runs on contact in updateChests
      const isSpilled = await waitUntil(() => (a.transport.getLatestSnapshot()?.pickups ?? []).filter((p) => p.bch).length === 3, 3000);
      const chA = (a.transport.getLatestSnapshot()?.pickups ?? []).filter((p) => p.bch).map((p) => `${p.id}:${p.wpn}`).sort();
      const chB = (b.transport.getLatestSnapshot()?.pickups ?? []).filter((p) => p.bch).map((p) => `${p.id}:${p.wpn}`).sort();
      check("both wires carry the SAME min(P+1,5) boss-choice pedestals (P2 -> 3)", isSpilled && chA.join(",") === chB.join(","), chA.join(","));

      // A claims by touch: the grant arrives via SelfWire.wpns and bcl flips — while every
      // pedestal PERSISTS for B (a claim never depletes a teammate's options).
      const first = (world.state.pickups.filter((p) => p.isBossChoice))[0];
      aSim.x = first.x; aSim.y = first.y;
      const isGranted = await waitUntil(() => a.transport.getLatestSnapshot()?.self?.bcl === true, 3000);
      check("A's personal claim granted (SelfWire.bcl, weapon in wpns)",
        isGranted && (a.transport.getLatestSnapshot()?.self?.wpns.length ?? 0) >= 2);
      check("every pedestal still stands for B after A's claim",
        world.state.pickups.filter((p) => p.isBossChoice).length === 3);

      // A cannot claim twice: standing on another pedestal grants nothing more.
      const owned = aSim.ownedWeapons.length;
      const second = world.state.pickups.filter((p) => p.isBossChoice)[1];
      aSim.x = second.x; aSim.y = second.y;
      await sleep(300);
      check("one personal claim per player (a second touch grants nothing)", aSim.ownedWeapons.length === owned);

      // B claims: with every living player claimed, the pedestals clear on both wires.
      const target = world.state.pickups.filter((p) => p.isBossChoice)[2];
      bSim.x = target.x; bSim.y = target.y;
      const isCleared = await waitUntil(() => (b.transport.getLatestSnapshot()?.pickups ?? []).filter((p) => p.bch).length === 0
        && (a.transport.getLatestSnapshot()?.pickups ?? []).filter((p) => p.bch).length === 0, 3000);
      check("all claimed -> the pedestals clear identically on both wires", isCleared && bSim.hasClaimedBossChoice);
      a.stop(); b.stop();
    } finally { await s.close(); }
  });

  await test("re-enabled interest filtering stays COHERENT: co-located clients agree; the party always ships", async () => {
    const s = await startTestServer({ interestRadius: 300 });
    try {
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "twin-a", world: "room:INTR", script: () => idle() });
      const b = new Bot({ url: s.url, secret: s.secret, playerId: "twin-b", world: "room:INTR", script: () => idle() });
      a.start(); b.start();
      await waitUntil(() => a.transport.isReady() && b.transport.isReady(), 3000);

      const world = s.server.getWorld("room:INTR")!;
      world.state.isGodMode = true;
      const sp = world.state.dungeon.spawn;
      const cx = sp.x * TILE + TILE / 2, cy = sp.y * TILE + TILE / 2;
      // A controlled cluster on the co-located pair + one far enemy that must drop for BOTH.
      for (let i = 0; i < 3; i++) devSpawnEnemy(world.state, "slime", cx + (i - 1) * 24, cy + 40);
      const farEnemy = devSpawnEnemy(world.state, "slime", cx + 2000, cy);
      await sleep(600);

      const sa = a.transport.getLatestSnapshot()!;
      const sb = b.transport.getLatestSnapshot()!;
      const idsA = sa.enemies.map((e) => e.id).sort((x, y) => x - y).join(",");
      const idsB = sb.enemies.map((e) => e.id).sort((x, y) => x - y).join(",");
      check("co-located clients agree on the filtered nearby set", idsA === idsB && idsA.length > 0, `a=[${idsA}] b=[${idsB}]`);
      check("the far non-boss enemy is filtered for BOTH (consistent, not divergent)",
        !sa.enemies.some((e) => e.id === farEnemy.id) && !sb.enemies.some((e) => e.id === farEnemy.id));
      check("the teammate still rides both snapshots (party never filtered)",
        sa.players.length === 1 && sb.players.length === 1);

      a.stop(); b.stop();
    } finally { await s.close(); }
  });

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll same-world co-op socket assertions passed.\n");
}

void main();
