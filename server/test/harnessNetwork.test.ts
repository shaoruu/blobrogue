import type { AddressInfo } from "node:net";
import { WebSocket as WsClient, WebSocketServer } from "ws";
import { Bot, idle, startTestServer, waitUntil } from "../harness/lib.js";
import { LatencySocket, PERFECT_NET } from "../harness/latencySocket.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, isCondition: boolean, detail = ""): void {
  if (isCondition) {
    passed++;
    process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`);
  } else {
    failed++;
    failures.push(name + (detail ? " — " + detail : ""));
    process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`);
  }
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`\n[${name}]\n`);
  try {
    await fn();
  } catch (error) {
    failed++;
    failures.push(`${name} threw: ${String(error)}`);
    process.stdout.write(`  FAIL ${name} threw ${String(error)}\n`);
  }
}

async function main(): Promise<void> {
  await test("network-condition switch drains only packets queued before the boundary", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    const received: string[] = [];
    server.on("connection", (peer) => {
      peer.on("message", (data) => received.push(data.toString()));
    });

    const socket = new LatencySocket(`ws://127.0.0.1:${address.port}`, {
      rttMs: 160,
      jitterMs: 0,
      loss: 0,
    });
    try {
      const isOpen = await waitUntil(() => socket.readyState === WsClient.OPEN, 1000);
      check("latency socket opened", isOpen, `readyState=${socket.readyState}`);

      socket.send("queued-before-switch");
      let isSwitchResolved = false;
      const switchPromise = socket.setNetworkConditions({ rttMs: 0, jitterMs: 0, loss: 1 })
        .then(() => { isSwitchResolved = true; });
      socket.send("sent-after-switch");

      await Promise.resolve();
      check("switch waits for the pre-switch queue", !isSwitchResolved && received.length === 0);

      const isBoundaryDrained = await waitUntil(
        () => isSwitchResolved && received.length === 1,
        1000,
      );
      await switchPromise;
      check(
        "pre-switch packet drains and post-switch packet uses new loss",
        isBoundaryDrained && received[0] === "queued-before-switch",
        `received=${JSON.stringify(received)}`,
      );

      await socket.setNetworkConditions(PERFECT_NET);
      socket.send("sent-after-restore");
      const isRestored = await waitUntil(() => received.length === 2, 1000);
      check(
        "restored conditions apply to subsequent packets without replaying dropped packets",
        isRestored && received.join(",") === "queued-before-switch,sent-after-restore",
        `received=${JSON.stringify(received)}`,
      );
    } finally {
      socket.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  await test("Bot changes network conditions only after ready", async () => {
    const server = await startTestServer();
    const bot = new Bot({
      url: server.url,
      secret: server.secret,
      playerId: "network-switch",
      script: () => idle(),
    });
    try {
      let isRejectedBeforeReady = false;
      try {
        await bot.setNetworkConditions(PERFECT_NET);
      } catch (error) {
        isRejectedBeforeReady = String(error).includes("require a ready bot");
      }
      check("pre-ready switch is rejected with a diagnostic", isRejectedBeforeReady);

      bot.start();
      const isJoined = await waitUntil(() => {
        const world = server.server.getWorld();
        const playerId = bot.serverId();
        return bot.transport.isReady()
          && world !== undefined
          && playerId !== null
          && world.state.players.has(playerId);
      }, 3000);
      check("bot reached ready world/player state", isJoined);

      await bot.setNetworkConditions({ rttMs: 60, jitterMs: 20, loss: 0.4 });
      check("post-ready switch completed", bot.transport.isReady());
    } finally {
      bot.stop();
      await server.close();
    }
  });

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) {
    process.stdout.write(`FAILURES:\n${failures.map((failure) => "  - " + failure).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("\nAll harness network-condition regressions passed.\n");
}

void main();
