// Authoritative run-result reporting: the server → Convex signed submission path. Boots the
// real GameServer + real WSTransport bots against a local HTTP stub standing in for the
// Convex inbox, and asserts: a death POSTs a signed "death" result built from SERVER sim
// state, a mid-run disconnect POSTs "abandon", nothing double-submits, connection blips are
// suppressed, the HMAC verifies with the shared-core verifier over the exact bytes using
// the DEDICATED results secret (never the ticket secret), and a reconnect reservation
// (isLeaveTerminal false) suppresses abandon reporting while game overs still report.
// Run: npm run test:report (in server/).

import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { startTestServer, Bot, waitUntil, sleep, TEST_SECRET, idle } from "../harness/lib.js";
import { RunReporter, buildRunReport, isReportWorthy } from "../src/runReport.js";
import type { RunReportPayload } from "../src/runReport.js";
import { verifyRunBody } from "../../convex/gsSignCore.js";
import { parseServerSubmission } from "../../convex/statsCore.js";
import type { ServerSubmission } from "../../convex/statsCore.js";
import { createLogger } from "../src/logger.js";
import { createWorld, spawnPlayerInWorld, stepWorldPhase } from "../../src/sim/world.js";

// A DIFFERENT secret from the join-ticket TEST_SECRET, proving the two channels are
// fully decoupled: tickets verify with one, run results sign/verify with the other.
const REPORT_SECRET = "harness-report-secret";

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

interface CapturedPost {
  body: string;
  signature: string;
  isVerified: boolean;
  sub: ServerSubmission | null;
}

// A stand-in Convex inbox: captures each POST, verifies the HMAC with the SAME shared core
// module the real deployment uses, and answers 200.
async function startInbox(secret: string): Promise<{ url: string; posts: CapturedPost[]; close: () => Promise<void>; server: HttpServer }> {
  const posts: CapturedPost[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    req.on("end", () => {
      void (async () => {
        const signature = String(req.headers["x-gs-signature"] ?? "");
        const isVerified = await verifyRunBody(secret, body, signature);
        const parsed = parseServerSubmission(body, Date.now());
        posts.push({ body, signature, isVerified, sub: parsed.ok ? parsed.sub : null });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/gs/run-result`,
    posts,
    server,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function main(): Promise<void> {
  await test("death: the server POSTs a signed, verifiable 'death' result from its own sim", async () => {
    const inbox = await startInbox(REPORT_SECRET);
    const s = await startTestServer({ runResultsUrl: inbox.url, runResultsSecret: REPORT_SECRET });
    try {
      const bot = new Bot({ url: s.url, secret: s.secret, playerId: "reporter-a", script: () => idle() });
      bot.start();
      await waitUntil(() => bot.transport.isReady(), 3000);
      const world = s.server.getWorld()!;
      const pid = bot.serverId()!;
      const p = world.state.players.get(pid)!;
      // Give the run something to report, then kill the player authoritatively.
      p.kills = 7;
      p.runStats.bestCombo = 4;
      p.runStats.damageDealt = 55;
      p.invuln = 0;
      p.dashInvuln = 0;
      p.hp = 1;
      world.state.bullets.push({
        x: p.x, y: p.y, vx: 0, vy: 0, radius: 8, life: 1, friendly: false,
        owner: null, damage: 5, color: "#f00", pierce: 0, hitList: null, isCrit: false,
      });
      const arrived = await waitUntil(() => inbox.posts.length >= 1, 5000);
      check("exactly one report arrived", arrived && inbox.posts.length === 1, `posts=${inbox.posts.length}`);
      const post = inbox.posts[0];
      check("HMAC verifies over the exact bytes (shared core)", post.isVerified);
      check("secrets are decoupled: the TICKET secret cannot verify a report",
        !(await verifyRunBody(TEST_SECRET, post.body, post.signature)));
      check("envelope parses through the Convex-side validator", post.sub !== null);
      if (post.sub) {
        check("result is death", post.sub.run.result === "death");
        check("identity is the VERIFIED ticket pid", post.sub.playerId === "reporter-a");
        check("server sim stats rode along", post.sub.run.kills === 7 && post.sub.run.bestCombo === 4
          && post.sub.run.damageDealt === 55, JSON.stringify({ k: post.sub.run.kills, c: post.sub.run.bestCombo }));
        check("difficulty defaults to standard (seam for the difficulty feature)", post.sub.run.difficulty === "standard");
        check("mode is online", post.sub.run.mode === "online");
        check("death cause named from the server sim", post.sub.run.deathCause === "shot",
          `cause=${post.sub.run.deathCause}`);
      }
      // The socket close that follows the game over must NOT produce a second submission.
      await sleep(400);
      check("no duplicate submission after the post-death socket close", inbox.posts.length === 1, `posts=${inbox.posts.length}`);
      bot.stop();
    } finally {
      await s.close();
      await inbox.close();
    }
  });

  await test("disconnect: leaving mid-run POSTs an 'abandon' with the stats so far", async () => {
    const inbox = await startInbox(REPORT_SECRET);
    const s = await startTestServer({ runResultsUrl: inbox.url, runResultsSecret: REPORT_SECRET });
    try {
      const bot = new Bot({ url: s.url, secret: s.secret, playerId: "reporter-b", script: () => idle() });
      bot.start();
      await waitUntil(() => bot.transport.isReady(), 3000);
      const world = s.server.getWorld()!;
      const p = world.state.players.get(bot.serverId()!)!;
      p.kills = 3; // enough to clear the blip filter
      bot.stop();
      const arrived = await waitUntil(() => inbox.posts.length >= 1, 5000);
      check("abandon report arrived", arrived, `posts=${inbox.posts.length}`);
      const sub = inbox.posts[0]?.sub ?? null;
      check("result is abandon with the partial stats", sub !== null && sub.run.result === "abandon" && sub.run.kills === 3);
    } finally {
      await s.close();
      await inbox.close();
    }
  });

  await test("blip suppression: an instant no-progress disconnect reports nothing", async () => {
    const inbox = await startInbox(REPORT_SECRET);
    const s = await startTestServer({ runResultsUrl: inbox.url, runResultsSecret: REPORT_SECRET });
    try {
      const bot = new Bot({ url: s.url, secret: s.secret, playerId: "reporter-c", script: () => idle() });
      bot.start();
      await waitUntil(() => bot.transport.isReady(), 3000);
      bot.stop();
      await sleep(500);
      check("no report for a zero-progress blip", inbox.posts.length === 0, `posts=${inbox.posts.length}`);
    } finally {
      await s.close();
      await inbox.close();
    }
  });

  await test("reconnect seam: a reserved (non-terminal) leave NEVER reports; a game over still does", async () => {
    const inbox = await startInbox(REPORT_SECRET);
    const s = await startTestServer({ runResultsUrl: inbox.url, runResultsSecret: REPORT_SECRET });
    try {
      const bot = new Bot({ url: s.url, secret: s.secret, playerId: "reporter-d", script: () => idle() });
      bot.start();
      await waitUntil(() => bot.transport.isReady(), 3000);
      const world = s.server.getWorld()!;
      const pid = bot.serverId()!;
      world.state.players.get(pid)!.kills = 9; // well past the blip filter
      // Stand in for the resume system: this player's slot is reserved for reconnect.
      world.isLeaveTerminal = (leavingPid) => leavingPid !== pid;
      bot.stop();
      await sleep(500);
      check("no abandon while the reservation holds", inbox.posts.length === 0, `posts=${inbox.posts.length}`);

      // A genuine game over is authoritative-terminal and reports even under a reservation.
      const bot2 = new Bot({ url: s.url, secret: s.secret, playerId: "reporter-e", script: () => idle() });
      bot2.start();
      await waitUntil(() => bot2.transport.isReady(), 3000);
      const world2 = s.server.getWorld()!;
      const pid2 = bot2.serverId()!;
      world2.isLeaveTerminal = () => false; // reserve everyone
      const p2 = world2.state.players.get(pid2)!;
      p2.kills = 3;
      p2.invuln = 0;
      p2.dashInvuln = 0;
      p2.hp = 1;
      world2.state.bullets.push({
        x: p2.x, y: p2.y, vx: 0, vy: 0, radius: 8, life: 1, friendly: false,
        owner: null, damage: 5, color: "#f00", pierce: 0, hitList: null, isCrit: false,
      });
      const arrived = await waitUntil(() => inbox.posts.length >= 1, 5000);
      check("authoritative death reports through the reservation", arrived
        && inbox.posts[0]?.sub?.run.result === "death", `posts=${inbox.posts.length}`);
      bot2.stop();
    } finally {
      await s.close();
      await inbox.close();
    }
  });

  await test("reporter unit: retries transient failures, gives up on 4xx, disabled without config", async () => {
    const log = createLogger({ app: "report-test" }, "error");
    const world = createWorld(7, 1, { isShared: true, skipLocalPlayer: true });
    const p = spawnPlayerInWorld(world, "pX");
    p.kills = 2;
    spawnPlayerInWorld(world, "pMate");
    stepWorldPhase(world, 1 / 20, []);
    const payload = buildRunReport(world, p, "players|abc", "room:TEST", "death", Date.now());
    check("buildRunReport carries identity + world + result", payload.playerId === "players|abc"
      && payload.worldId === "room:TEST" && payload.result === "death" && payload.kills === 2);
    check("party size reported from the sim's high-water mark", payload.partySize === 2,
      `party=${payload.partySize}`);
    check("submissionId minted per report", payload.submissionId.length >= 8
      && buildRunReport(world, p, "players|abc", "room:TEST", "death", Date.now()).submissionId !== payload.submissionId);

    // Transient 500s then success: retried to completion.
    let calls = 0;
    const flaky: typeof fetch = () => {
      calls++;
      return Promise.resolve(new Response("{}", { status: calls < 3 ? 500 : 200 }));
    };
    const retrying = new RunReporter({ url: "http://x/", secret: "s", log, fetchFn: flaky, maxAttempts: 3, backoffMs: 1 });
    retrying.submit(payload);
    await retrying.drain();
    check("500s retried until success", calls === 3, `calls=${calls}`);

    // 4xx is terminal: the same bytes can never become acceptable.
    let rejects = 0;
    const rejecting: typeof fetch = () => {
      rejects++;
      return Promise.resolve(new Response("{}", { status: 401 }));
    };
    const rejected = new RunReporter({ url: "http://x/", secret: "s", log, fetchFn: rejecting, maxAttempts: 3, backoffMs: 1 });
    rejected.submit(payload);
    await rejected.drain();
    check("4xx not retried", rejects === 1, `calls=${rejects}`);

    // Unconfigured -> disabled, and submit is a no-op.
    let disabledCalls = 0;
    const counting: typeof fetch = () => {
      disabledCalls++;
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const off = new RunReporter({ url: null, secret: "s", log, fetchFn: counting });
    check("no URL -> disabled", !off.isEnabled);
    off.submit(payload);
    await off.drain();
    const noSecret = new RunReporter({ url: "http://x/", secret: null, log, fetchFn: counting });
    check("no secret -> disabled", !noSecret.isEnabled);
    noSecret.submit(payload);
    await noSecret.drain();
    check("disabled reporters never fetch", disabledCalls === 0);
  });

  await test("worthiness: deaths always report; empty abandons don't", async () => {
    const world = createWorld(7, 1, { isShared: true, skipLocalPlayer: true });
    const p = spawnPlayerInWorld(world, "pY");
    const death = buildRunReport(world, p, "id", "w", "death", Date.now());
    check("fresh death is worthy", isReportWorthy(death));
    const blip = buildRunReport(world, p, "id", "w", "abandon", Date.now());
    check("zero-progress abandon is not", !isReportWorthy(blip));
    p.runStats.timeAliveSecs = 60;
    const seasoned: RunReportPayload = buildRunReport(world, p, "id", "w", "abandon", Date.now());
    check("a minute of play makes an abandon worthy", isReportWorthy(seasoned));
  });
}

await main();

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(failures.map((f) => "  FAILED: " + f).join("\n") + "\n");
  process.exit(1);
}
process.stdout.write("\nAll run-report assertions passed.\n");
