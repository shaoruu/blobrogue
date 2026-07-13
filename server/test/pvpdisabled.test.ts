// TEMP PVP KILL SWITCH — game-server defense (layer 5).
//
// The last line of defense: if a stale or already-minted pvp ticket somehow reaches the game
// server while PVP is disabled, the join path must REJECT it — with the typed pvp_disabled code
// and the clean copy — rather than create/bind a pvp world, and NEVER fall back to co-op. This
// suite drives real join frames against an in-process server and asserts:
//   1. a signed ticket carrying a pvp world id is rejected with code "pvp_disabled"
//   2. no pvp world is created for it (the registry never spins one up)
//   3. it does NOT silently land in a co-op world (no co-op fallback)
//   4. a resume frame naming a pvp world is rejected the same way (the guard precedes resume)
//   5. CO-OP is byte-unchanged: a co-op room ticket still joins and binds its world
// Run: npm run test:pvpdisabled (in server/)

import { startTestServer, Bot, idle, waitUntil } from "../harness/lib.js";
import { mintTicket } from "../src/auth.js";
import { jsonCodec, PROTOCOL_VERSION, pvpWorldIdForRoomCode, worldIdForRoomCode } from "../../src/net/protocol.js";
import { PVP_PUBLIC_ENABLED, PVP_DISABLED_CODE, PVP_DISABLED_MESSAGE } from "../../src/net/pvpFlag.js";
import { WebSocket as WsClient } from "ws";

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

function rawSocket(url: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

interface ErrorFrame { t?: string; code?: string; msg?: string }

async function main(): Promise<void> {
  check("PVP is disabled in this build (the containment default)", PVP_PUBLIC_ENABLED === false);

  await test("a stale pvp ticket is REJECTED (pvp_disabled) — no pvp world created, no co-op fallback", async () => {
    const s = await startTestServer();
    try {
      const before = s.server.health().counters.joinsRejected;
      const ws = await rawSocket(s.url);
      let frame: ErrorFrame | null = null;
      let sawSnap = false;
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString("utf8")) as ErrorFrame & { t?: string };
        if (msg.t === "error") frame = msg;
        if (msg.t === "snap") sawSnap = true;
      });
      // A ticket minted for a pvp world (what a stale client / an older cached bundle would send).
      const ticket = mintTicket(s.secret, "stale-pvp", 120, Date.now(), { worldId: pvpWorldIdForRoomCode("AAAA") });
      ws.send(jsonCodec.encodeClient({ t: "join", ticket, protocol: PROTOCOL_VERSION }));
      await waitUntil(() => frame !== null, 2000);
      const err: ErrorFrame = frame ?? {};
      check("the join is rejected with the typed pvp_disabled code", err.code === PVP_DISABLED_CODE, JSON.stringify(err));
      check("the reject carries the clean player-facing copy", err.msg === PVP_DISABLED_MESSAGE, err.msg ?? "");
      check("the rejection is counted", s.server.health().counters.joinsRejected === before + 1);
      check("NO pvp world was created for it", s.server.getWorld(pvpWorldIdForRoomCode("AAAA")) === undefined);
      check("it did NOT silently land in a co-op world (no fallback)", s.server.getWorld(worldIdForRoomCode("AAAA")) === undefined);
      check("the registry stayed empty", s.server.health().worlds === 0, `worlds=${s.server.health().worlds}`);
      check("the client never received a spawn snapshot", !sawSnap);
    } finally { await s.close(); }
  });

  await test("a resume frame naming a pvp world is rejected too (the guard precedes resume)", async () => {
    const s = await startTestServer();
    try {
      const ws = await rawSocket(s.url);
      let frame: ErrorFrame | null = null;
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString("utf8")) as ErrorFrame & { t?: string };
        if (msg.t === "error") frame = msg;
      });
      const ticket = mintTicket(s.secret, "stale-pvp-resume", 120, Date.now(), { worldId: pvpWorldIdForRoomCode("BBBB") });
      ws.send(jsonCodec.encodeClient({ t: "join", ticket, protocol: PROTOCOL_VERSION, resume: "some-old-token" }));
      await waitUntil(() => frame !== null, 2000);
      const err: ErrorFrame = frame ?? {};
      check("a pvp resume is rejected with pvp_disabled", err.code === PVP_DISABLED_CODE, JSON.stringify(err));
      check("no pvp world was created by the resume attempt", s.server.getWorld(pvpWorldIdForRoomCode("BBBB")) === undefined);
    } finally { await s.close(); }
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

  // The public default (claimless) world is not a pvp world — it must be unaffected.
  await test("the claimless public default world is unaffected by the switch", async () => {
    const s = await startTestServer();
    try {
      const c = new Bot({ url: s.url, secret: s.secret, playerId: "pub-1", script: () => idle() });
      c.start();
      const ready = await waitUntil(() => c.transport.isReady(), 3000);
      check("a claimless ticket still joins the public default world", ready);
      c.stop();
    } finally { await s.close(); }
  });

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll PVP kill-switch game-server defense assertions passed.\n");
}

void main();
