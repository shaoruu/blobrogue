import {
  RUN_RECEIPT_TTL_MS,
  RUN_RECEIPT_VERSION,
} from "../../src/net/runReceipt.js";
import type { RunCompletionPayload } from "../../src/net/runReceipt.js";
import { verifyRunCompletionReceipt as verifyConvexReceipt } from "../../convex/runReceiptCore.js";
import {
  mintRunCompletionReceipt,
  verifyRunCompletionReceipt,
} from "../src/runReceipt.js";
import { RunReceiptDispatcher } from "../src/runReceiptDispatcher.js";
import { createLogger } from "../src/logger.js";
import { GameWorld } from "../src/world.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Bot, idle, startTestServer, waitUntil } from "../harness/lib.js";

let passed = 0;
let failed = 0;

function check(name: string, isPassing: boolean, detail = ""): void {
  if (isPassing) {
    passed++;
    process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`);
  }
}

const now = 1_760_000_000_000;
const secret = "receipt-secret-distinct-from-ticket-secret";
const payload: RunCompletionPayload = {
  version: RUN_RECEIPT_VERSION,
  jti: "0123456789abcdef0123456789abcdef0123456789abcdef",
  runId: "room:ABCD:g3:seed-42:rev-7",
  worldId: "room:ABCD:g3",
  roomCode: "ABCD",
  generation: 3,
  status: "completed",
  issuedAt: now,
  expiresAt: now + RUN_RECEIPT_TTL_MS,
  isNoActiveSeat: true,
  participants: [{
    playerId: "player123",
    floor: 8,
    kills: 42,
    coins: 91,
    floorsCleared: 7,
    bossKills: ["boss"],
    isCacheArmed: true,
    amberWindfall: 8,
    durationMs: 123_456,
    weapons: ["pistol", "beam"],
    items: [{ id: "it_dmg", count: 2 }],
  }],
};

const receipt = mintRunCompletionReceipt(secret, payload);
const serverVerified = verifyRunCompletionReceipt(secret, receipt, now);
const convexVerified = await verifyConvexReceipt(secret, receipt, now);
check("server verifies its signed authoritative payload", JSON.stringify(serverVerified) === JSON.stringify(payload));
check("Convex verifier agrees byte-for-byte", JSON.stringify(convexVerified) === JSON.stringify(payload));
check("wrong receipt secret rejects", verifyRunCompletionReceipt("wrong", receipt, now) === null);
check("expired receipt rejects", verifyRunCompletionReceipt(secret, receipt, payload.expiresAt + 1) === null);

const parts = receipt.split(".");
const decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as RunCompletionPayload;
decoded.participants[0].coins = 9_999_999;
const tamperedBody = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
check("tampered authoritative rewards reject", verifyRunCompletionReceipt(secret, `${parts[0]}.${tamperedBody}.${parts[2]}`, now) === null);

const world = new GameWorld("room:ABCD:g3", 42);
world.addPlayer("p1", "mender", "player123");
const authoritative = world.state.players.get("p1")!;
authoritative.kills = 17;
authoritative.coins = 43;
authoritative.isAmberCacheArmed = true;
authoritative.amberWindfall = 8;
authoritative.ownedWeapons.push("beam");
authoritative.ownedItemIds.push("it_dmg", "it_dmg");
world.state.floor = 4;
world.state.tick = 200;
const participant = world.runReceiptParticipants()[0];
check("receipt participant stats come from authoritative world state",
  participant.playerId === "player123"
  && participant.floor === 4
  && participant.kills === 17
  && participant.coins === 43
  && participant.floorsCleared === 3
  && participant.isCacheArmed
  && participant.amberWindfall === 8
  && participant.weapons.includes("beam")
  && participant.items.find((item) => item.id === "it_dmg")?.count === 2);

const delivered: string[] = [];
const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as { receipt: string };
  delivered.push(body.receipt);
  return new Response("ok", { status: 200 });
}) as typeof fetch;
const dispatcher = new RunReceiptDispatcher(
  "https://example.convex.site/gs/run-completion",
  secret,
  createLogger({ test: "receipt" }, "error"),
  fetcher,
);
const dispatchNow = Date.now();
const dispatchPayload: RunCompletionPayload = {
  ...payload,
  jti: "abcdef0123456789abcdef0123456789abcdef0123456789",
  issuedAt: dispatchNow,
  expiresAt: dispatchNow + RUN_RECEIPT_TTL_MS,
};
dispatcher.submit(dispatchPayload);
await dispatcher.flush();
check("dispatcher posts exactly one signed receipt", delivered.length === 1);
check("dispatched receipt preserves the authoritative payload",
  JSON.stringify(verifyRunCompletionReceipt(secret, delivered[0], dispatchNow)) === JSON.stringify(dispatchPayload));

const outboxDirectory = mkdtempSync(join(tmpdir(), "blobrogue-receipt-outbox-"));
const outboxPath = join(outboxDirectory, "receipts.json");
try {
  const stalledFetch = (() => new Promise<Response>(() => {})) as typeof fetch;
  const firstDispatcher = new RunReceiptDispatcher(
    "https://example.convex.site/gs/run-completion",
    secret,
    createLogger({ test: "receipt-outbox-1" }, "error"),
    stalledFetch,
    outboxPath,
  );
  firstDispatcher.submit(dispatchPayload);
  check("pending receipt is discoverable during restart recovery",
    firstDispatcher.hasDeliverableWorld(dispatchPayload.worldId));
  const recovered: string[] = [];
  const recoveryFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { receipt: string };
    recovered.push(body.receipt);
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const restartedDispatcher = new RunReceiptDispatcher(
    "https://example.convex.site/gs/run-completion",
    secret,
    createLogger({ test: "receipt-outbox-2" }, "error"),
    recoveryFetch,
    outboxPath,
  );
  await restartedDispatcher.flush();
  check("durable outbox redelivers after dispatcher restart", recovered.length === 1);
  check("recovered outbox receipt remains valid",
    verifyRunCompletionReceipt(secret, recovered[0], dispatchNow)?.jti === dispatchPayload.jti);

  const rejectedPayload: RunCompletionPayload = {
    ...dispatchPayload,
    jti: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    runId: `${dispatchPayload.worldId}:rejected`,
  };
  const rejectedDispatcher = new RunReceiptDispatcher(
    "https://example.convex.site/gs/run-completion",
    secret,
    createLogger({ test: "receipt-outbox-rejected" }, "error"),
    (async () => new Response("unauthorized", { status: 401 })) as typeof fetch,
    outboxPath,
  );
  rejectedDispatcher.submit(rejectedPayload);
  await rejectedDispatcher.flush();
  const durableEntries = JSON.parse(readFileSync(outboxPath, "utf8")) as Array<{ payload: RunCompletionPayload; failedAt?: number }>;
  check("permanent delivery failure remains as a bounded durable dead letter",
    durableEntries.some((entry) => entry.payload.jti === rejectedPayload.jti && entry.failedAt !== undefined));
} finally {
  rmSync(outboxDirectory, { recursive: true, force: true });
}

const completionReceipts: string[] = [];
const receiptSink = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { receipt: string };
  completionReceipts.push(body.receipt);
  response.writeHead(200).end("ok");
});
await new Promise<void>((resolve) => receiptSink.listen(0, "127.0.0.1", resolve));
const sinkAddress = receiptSink.address();
if (!sinkAddress || typeof sinkAddress === "string") throw new Error("receipt sink did not bind");
const flushDirectory = mkdtempSync(join(tmpdir(), "blobrogue-flush-receipt-"));
const flushServer = await startTestServer({
  receiptSecret: secret,
  receiptEndpoint: `http://127.0.0.1:${sinkAddress.port}/gs/run-completion`,
  generationStatePath: join(flushDirectory, "admission.json"),
});
try {
  const bot = new Bot({
    url: flushServer.url,
    secret: flushServer.secret,
    playerId: "flush-player",
    world: "room:FLUS:g1",
    kit: "gunner",
    masteryLevel: 1,
    isPetChoiceMade: true,
    script: () => idle(),
  });
  bot.start();
  check("flush receipt path begins with a real admitted world",
    await waitUntil(() => bot.transport.isReady(), 3000));
  await fetch(`http://127.0.0.1:${flushServer.port}/admin/flush`, { method: "POST" });
  check("flush posts a signed terminal receipt over HTTP",
    await waitUntil(() => completionReceipts.length === 1, 3000));
  const flushed = verifyRunCompletionReceipt(secret, completionReceipts[0]);
  check("flush attests abandonment only after clearing every authoritative seat",
    flushed?.status === "abandoned"
    && flushed.isNoActiveSeat
    && flushed.participants.length === 0);
  check("flush durably retires and releases the world",
    await waitUntil(() => flushServer.server.getWorld("room:FLUS:g1") === undefined, 3000));
  bot.stop();
} finally {
  await flushServer.close();
  await new Promise<void>((resolve) => receiptSink.close(() => resolve()));
  rmSync(flushDirectory, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
