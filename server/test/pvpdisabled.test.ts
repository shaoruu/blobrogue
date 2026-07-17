// PVP ROLLOUT KILL SWITCH — game-server defense (layer 5), private-ON / public-OFF.
//
// After #164/#177 production policy is PRIVATE ON / PUBLIC OFF (src/net/pvpFlag.ts, mirrored by
// convex/pvpFlag.ts). The game server is the last line of defense: it must now let a signed,
// policy-bound PRIVATE arena ticket through (create/join/resume) while still failing CLOSED on
// any PUBLIC arena verdict, and it must NEVER touch the co-op path. This suite drives real join
// frames against an in-process server and asserts:
//   1. this build ships PRIVATE ON / PUBLIC OFF
//   2. a policy-bound private ticket JOINS and binds its pvp world (private path is live)
//   3. a private seat RESUMES the same body after a drop (the guard no longer pre-empts resume)
//   4. a PUBLIC arena verdict (durable authority denies public while it is dark) is rejected with
//      code "public_disabled" — no pvp world, no co-op fallback, the stable counter incremented
//   5. CO-OP is byte-unchanged: a co-op room ticket still joins and binds its world
// Run: npm run test:pvpdisabled (in server/)

import { startTestServer, Bot, idle, waitUntil } from "../harness/lib.js";
import { createServer } from "node:http";
import { pvpWorldIdForRoomCode, worldIdForRoomCode } from "../../src/net/protocol.js";
import {
  PVP_PRIVATE_ENABLED,
  PVP_PUBLIC_ENABLED,
  PVP_PUBLIC_DISABLED_CODE,
} from "../../src/net/pvpFlag.js";

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
  check("this build ships PRIVATE ON / PUBLIC OFF",
    PVP_PRIVATE_ENABLED === true && PVP_PUBLIC_ENABLED === false);

  await test("a policy-bound private ticket JOINS and binds its pvp world (the private path is live)", async () => {
    const s = await startTestServer();
    try {
      const world = pvpWorldIdForRoomCode("AAAA");
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "private-a", world, name: "Priv", colorIndex: 1, script: () => idle() });
      a.start();
      const ready = await waitUntil(() => a.transport.isReady(), 4000);
      check("the private pvp join is accepted (client ready)", ready);
      const gw = s.server.getWorld(world);
      check("the server spun the world up in pvp mode", gw?.state.mode === "pvp", `mode=${gw?.state.mode}`);
      check("the private seat is bound in that one pvp world", gw?.playerCount === 1, `players=${gw?.playerCount}`);
      check("no co-op world was created alongside it (no crossover)", s.server.getWorld(worldIdForRoomCode("AAAA")) === undefined);
      check("the private-disabled guard never fired", s.server.health().counters.privateDisabledRejected === 0);
      a.stop();
    } finally { await s.close(); }
  });

  await test("a private seat RESUMES the same body after a drop (the guard precedes but no longer blocks resume)", async () => {
    const s = await startTestServer({ resumeGraceMs: 4000 });
    try {
      const world = pvpWorldIdForRoomCode("BBBB");
      const a = new Bot({
        url: s.url, secret: s.secret, playerId: "resume-a", world, name: "Res", colorIndex: 2,
        script: () => idle(), reconnect: { baseDelayMs: 80, maxDelayMs: 250, graceMs: 4000 },
      });
      a.start();
      const ready = await waitUntil(() => a.transport.isReady(), 4000);
      const seatId = a.transport.getSelfServerId();
      check("the private pvp seat joined before the drop", ready && seatId !== null);
      const gw = s.server.getWorld(world);
      a.dropConnection(true);
      const isReserved = await waitUntil(() => seatId !== null && gw?.state.players.get(seatId)?.isAbsent === true, 3000);
      check("the dropped private seat is reserved (absent, body kept)", isReserved && gw?.playerCount === 1);
      a.restoreNetwork();
      const isResumed = await waitUntil(() => a.transport.isReady() && seatId !== null && gw?.state.players.get(seatId)?.isAbsent === false, 5000);
      check("the private pvp resume reclaims the same seat", isResumed && a.transport.getSelfServerId() === seatId);
      check("the private-disabled guard never fired across the resume", s.server.health().counters.privateDisabledRejected === 0);
      a.stop();
    } finally { await s.close(); }
  });

  await test("a PUBLIC arena verdict is rejected with public_disabled (fail closed, no world, no co-op fallback)", async () => {
    // The durable authority (Convex admission) is where a room's public/private nature is decided;
    // while public is dark it denies a public arena with the stable public_disabled code. The game
    // server must honor that verdict fail-closed. We stand up the real admission seam (as the
    // generation-admission suite does) and return that verdict for a generation-bound arena world.
    const admissionServer = createServer((_request, response) => {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ isAllowed: false, code: PVP_PUBLIC_DISABLED_CODE }));
    });
    await new Promise<void>((resolve) => admissionServer.listen(0, "127.0.0.1", resolve));
    const address = admissionServer.address();
    if (address === null || typeof address === "string") throw new Error("admission server did not bind");
    const s = await startTestServer({
      receiptSecret: "pvp-public-disabled-receipt-secret",
      admissionEndpoint: `http://127.0.0.1:${address.port}/gs/admission`,
    });
    try {
      const world = pvpWorldIdForRoomCode("PUB", 1);
      const c = new Bot({
        url: s.url, secret: s.secret, playerId: "public-1", world,
        kit: "gunner", masteryLevel: 1, isPetChoiceMade: true, script: () => idle(),
      });
      c.start();
      const rejected = await waitUntil(() => (c.transport.lastError ?? "").includes(PVP_PUBLIC_DISABLED_CODE), 4000);
      check("the public arena join is rejected with public_disabled", rejected, c.transport.lastError ?? "");
      check("NO pvp world was created for the public reject", s.server.getWorld(world) === undefined);
      check("it did NOT silently fall back to a co-op world", s.server.getWorld(worldIdForRoomCode("PUB", 1)) === undefined);
      check("the stable public-disabled counter is incremented", s.server.health().counters.publicDisabledRejected === 1);
      c.stop();
    } finally {
      await s.close();
      await new Promise<void>((resolve) => admissionServer.close(() => resolve()));
    }
  });

  await test("CO-OP is byte-unchanged: a co-op room ticket still joins and binds its world", async () => {
    const s = await startTestServer();
    try {
      const a = new Bot({ url: s.url, secret: s.secret, playerId: "coop-a", world: worldIdForRoomCode("CCCC"), name: "Ada", colorIndex: 2, script: () => idle() });
      a.start();
      const ready = await waitUntil(() => a.transport.isReady(), 3000);
      check("the co-op join succeeds (still ready)", ready);
      const world = s.server.getWorld(worldIdForRoomCode("CCCC"));
      check("the co-op world is bound with its single player", world?.playerCount === 1, `players=${world?.playerCount}`);
      check("no pvp world was ever created alongside it", s.server.getWorld(pvpWorldIdForRoomCode("CCCC")) === undefined);
      a.stop();
    } finally { await s.close(); }
  });

  // The claimless default world is co-op, not a pvp world — the rollout switch must not touch it.
  await test("the claimless co-op default world is unaffected by the switch", async () => {
    const s = await startTestServer();
    try {
      const c = new Bot({ url: s.url, secret: s.secret, playerId: "pub-1", script: () => idle() });
      c.start();
      const ready = await waitUntil(() => c.transport.isReady(), 3000);
      check("a claimless ticket still joins the default co-op world", ready);
      c.stop();
    } finally { await s.close(); }
  });

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll PVP rollout game-server defense assertions passed (private ON / public OFF).\n");
}

void main();
