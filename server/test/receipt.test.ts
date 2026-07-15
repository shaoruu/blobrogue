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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
} finally {
  rmSync(outboxDirectory, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
