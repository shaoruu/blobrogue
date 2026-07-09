// Same-world co-op correctness over REAL sockets (the Sev-0 regression suite). The live
// incident: one player wasn't bound to the party's authoritative room and the two clients
// played visually-similar but SEPARATE simulations (different enemies, different drops).
// Two real WSTransport clients join through room-scoped tickets and the suite asserts:
//   1. identical world identity on both wires — wid, seed, floor, rev
//   2. identical entity truth on both wires — enemy ids/positions, pickup ids/positions,
//      chest ids/state — under production-default FULL snapshots (interest off)
//   3. verified ticket colors/names reach the OTHER client's wire (remote tint sync)
//   4. the interact intent rides input frames into the sim, and a held E revives a downed
//      teammate end-to-end over the socket
//   5. the spec message sets the server-side spectate target (view centering) and is
//      ignored for junk targets
//   6. coherent interest filtering when re-enabled: co-located clients agree on the nearby
//      set, far non-boss entities drop for both, and the party always rides the snapshot
// Run: npm run test:coop (in server/).

import { startTestServer, Bot, idle, waitUntil, sleep } from "../harness/lib.js";
import { TILE } from "../../src/sim/types.js";
import { REVIVE } from "../../src/sim/balance.js";
import { devSpawnEnemy } from "../../src/sim/world.js";
import type { InputCmd } from "../../src/sim/input.js";

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

      check("both wires name the SAME authoritative world", sa.wid === "room:LOVE" && sb.wid === "room:LOVE", `a=${sa.wid} b=${sb.wid}`);
      check("client transport surfaces the world id (HUD room-code source)", a.transport.worldId() === "room:LOVE");
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
      check("world identity rides filtered snapshots too", sa.wid === "room:INTR" && sb.wid === sa.wid);

      a.stop(); b.stop();
    } finally { await s.close(); }
  });

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll same-world co-op socket assertions passed.\n");
}

void main();
