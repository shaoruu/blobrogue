// PVP room orchestration over REAL sockets: the P3 server wiring. Two clients join a pvp world
// (a pvp-prefixed world id minted only for a pvp room), and the suite asserts the server spins it
// up in pvp mode, seats both players with the FIXED symmetric loadout, runs the frag-limit match
// state machine to the live phase, and publishes the match block + FFA team on every wire. The
// kill/frag/respawn MECHANICS are exhaustively covered by the pure-sim suite (root test/pvp.test.ts);
// this proves the authoritative server plumbs the same sim end-to-end.
//
// Run: npm run test:pvp (in server/)

import { startTestServer, Bot, idle, waitUntil, sleep } from "../harness/lib.js";
import { PVP } from "../../src/sim/pvp.js";

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

async function main(): Promise<void> {
  await test("a pvp-prefixed world id spins up a deathmatch world and publishes the match block", async () => {
    const s = await startTestServer();
    try {
      const world = "pvp:room:ARENA";
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "a", world, name: "aaa", colorIndex: 1, script: () => idle() });
      const b = new Bot({ url: s.url, secret: s.secret, playerId: "b", world, name: "bbb", colorIndex: 3, script: () => idle() });
      a.start(); b.start();
      await waitUntil(() => a.transport.isReady() && b.transport.isReady(), 4000);
      await sleep(300);

      const gw = s.server.getWorld(world);
      check("the server created the world in pvp mode", gw?.state.mode === "pvp");
      check("both players are seated in the one pvp world", gw?.playerCount === 2);
      check("the sim built a match", gw?.state.match !== null);

      const sa = a.transport.getLatestSnapshot()!;
      check("the wire carries a non-null match block", sa.match !== null);
      check("every player gets the FIXED 100 HP pool", sa.self !== null && sa.self.mhp === PVP.maxHp, `mhp=${sa.self?.mhp}`);
      check("FFA team rides PlayerWire.tm", sa.players.every((p) => p.tm === 0));
      check("the scoreboard lists both seats", (sa.match?.sc.length ?? 0) === 2);

      // The tick-based match machine advances lobby -> countdown -> live over the wire.
      const reachedLive = await waitUntil(() => {
        const snap = a.transport.getLatestSnapshot();
        return snap?.match?.ph === "live";
      }, 6000);
      check("the match reaches the live phase (lobby -> countdown -> live)", reachedLive);
      check("no co-op wipe/game-over fires in a live deathmatch", a.transport.getLatestSnapshot()?.over === false);

      a.stop(); b.stop();
    } finally {
      await s.close();
    }
  });

  await test("a co-op room stays co-op (no match block) — the mode is the world identity", async () => {
    const s = await startTestServer();
    try {
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "c", world: "room:COOP", name: "ccc", colorIndex: 2, script: () => idle() });
      a.start();
      await waitUntil(() => a.transport.isReady(), 4000);
      await sleep(200);
      const gw = s.server.getWorld("room:COOP");
      check("a plain room id creates a co-op world", gw?.state.mode === "coop");
      check("co-op snapshot carries a null match block", a.transport.getLatestSnapshot()?.match === null);
      a.stop();
    } finally {
      await s.close();
    }
  });

  process.stdout.write(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(failures.map((f) => "  - " + f).join("\n") + "\n"); process.exit(1); }
}

void main();
