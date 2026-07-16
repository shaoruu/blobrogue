import {
  GENERATION_ADMISSION_TTL_MS,
  GENERATION_ADMISSION_VERSION,
  parseGenerationAdmissionDecision,
} from "../../src/net/generationAdmission.js";
import type {
  AdmissionJson,
  GenerationAdmissionPayload,
} from "../../src/net/generationAdmission.js";
import { verifyGenerationAdmissionProof } from "../../convex/generationAdmissionCore.js";
import {
  GenerationAdmissionClient,
  mintGenerationAdmissionProof,
} from "../src/generationAdmissionClient.js";
import { createLogger } from "../src/logger.js";
import { createServer } from "node:http";
import { Bot, idle, startTestServer, waitUntil } from "../harness/lib.js";
import { PRIVATE_DRAFT_PVP_POLICY } from "../../src/net/pvpPolicy.js";

let passed = 0;
let failed = 0;

function check(name: string, isPassing: boolean): void {
  if (isPassing) {
    passed++;
    process.stdout.write(`  PASS ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL ${name}\n`);
  }
}

const now = 1_760_000_000_000;
const secret = "generation-admission-secret";
const payload: GenerationAdmissionPayload = {
  version: GENERATION_ADMISSION_VERSION,
  jti: "0123456789abcdef0123456789abcdef0123456789abcdef",
  playerId: "player123",
  worldId: "room:ABCD:g3",
  roomCode: "ABCD",
  generation: 3,
  mode: "coop",
  pvpPolicy: null,
  kitId: "mender",
  petId: "doggie",
  isPetChoiceMade: true,
  issuedAt: now,
  expiresAt: now + GENERATION_ADMISSION_TTL_MS,
};

const proof = mintGenerationAdmissionProof(secret, payload);
check(
  "Convex verifies the game server admission proof",
  JSON.stringify(await verifyGenerationAdmissionProof(secret, proof, now)) === JSON.stringify(payload),
);
const parts = proof.split(".");
const decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as GenerationAdmissionPayload;
decoded.playerId = "other-player";
const tamperedBody = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
check(
  "tampered admission identity rejects",
  await verifyGenerationAdmissionProof(secret, `${parts[0]}.${tamperedBody}.${parts[2]}`, now) === null,
);
check(
  "expired admission proof rejects",
  await verifyGenerationAdmissionProof(secret, proof, payload.expiresAt + 1) === null,
);
const inheritedDecision = Object.create({
  isAllowed: true,
  code: "ok",
}) as AdmissionJson;
check("inherited/prototype admission fields reject",
  parseGenerationAdmissionDecision(inheritedDecision) === null);

const privatePayload: GenerationAdmissionPayload = {
  ...payload,
  worldId: "pvp:room:ABCD:g3",
  mode: "pvp",
  pvpPolicy: PRIVATE_DRAFT_PVP_POLICY,
};
const privateProof = mintGenerationAdmissionProof(secret, privatePayload);
check(
  "a2 proof binds the canonical private policy",
  JSON.stringify(await verifyGenerationAdmissionProof(secret, privateProof, now)) === JSON.stringify(privatePayload),
);
check(
  "co-op plus PVP policy is structurally rejected",
  (() => {
    try {
      mintGenerationAdmissionProof(secret, { ...payload, pvpPolicy: PRIVATE_DRAFT_PVP_POLICY });
      return false;
    } catch {
      return true;
    }
  })(),
);

const allowedClient = new GenerationAdmissionClient(
  "https://example.convex.site/gs/admission",
  secret,
  createLogger({ test: "admission" }, "error"),
  (async () => Response.json({ isAllowed: true, code: "ok" })) as typeof fetch,
);
check("admission client accepts only a positive durable decision", (await allowedClient.check(payload)).isAllowed);

const unavailableClient = new GenerationAdmissionClient(
  "https://example.convex.site/gs/admission",
  secret,
  createLogger({ test: "admission" }, "error"),
  (async () => { throw new Error("offline"); }) as typeof fetch,
);
const unavailable = await unavailableClient.check(payload);
check(
  "admission transport failure is bounded and fail closed",
  !unavailable.isAllowed && unavailable.code === "admission_unavailable",
);

const serverErrorClient = new GenerationAdmissionClient(
  "https://example.convex.site/gs/admission",
  secret,
  createLogger({ test: "admission" }, "error"),
  (async () => Response.json({ code: "internal" }, { status: 500 })) as typeof fetch,
);
check("admission 500 fails closed with stable code",
  (await serverErrorClient.check(payload)).code === "admission_unavailable");

const malformedClient = new GenerationAdmissionClient(
  "https://example.convex.site/gs/admission",
  secret,
  createLogger({ test: "admission" }, "error"),
  (async () => new Response("not-json", { status: 200 })) as typeof fetch,
);
check("malformed admission response fails closed",
  (await malformedClient.check(payload)).code === "admission_unavailable");

const verifiedProofs: GenerationAdmissionPayload[] = [];
const admissionServer = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { proof: string };
  const verified = await verifyGenerationAdmissionProof(secret, body.proof);
  if (verified !== null) verifiedProofs.push(verified);
  const isAllowed = verified?.generation === 2;
  response.writeHead(isAllowed ? 200 : 403, { "content-type": "application/json" });
  response.end(JSON.stringify({
    isAllowed,
    code: isAllowed ? "ok" : "generation_not_active",
  }));
});
await new Promise<void>((resolve) => admissionServer.listen(0, "127.0.0.1", resolve));
const admissionAddress = admissionServer.address();
if (!admissionAddress || typeof admissionAddress === "string") {
  throw new Error("admission test server did not bind");
}
const gameServer = await startTestServer({
  receiptSecret: secret,
  admissionEndpoint: `http://127.0.0.1:${admissionAddress.port}/gs/admission`,
  pvpPrivateEnabled: true,
});
try {
  const stale = new Bot({
    url: gameServer.url,
    secret: gameServer.secret,
    playerId: "stale-player",
    world: "room:AUTH:g1",
    kit: "gunner",
    masteryLevel: 1,
    isPetChoiceMade: true,
    script: () => idle(),
  });
  stale.start();
  await waitUntil(() => (stale.transport.lastError ?? "").includes("run_ended"), 3000);
  check("game server rejects a stale generation before creating its world",
    (stale.transport.lastError ?? "").includes("run_ended")
    && gameServer.server.getWorld("room:AUTH:g1") === undefined);
  const current = new Bot({
    url: gameServer.url,
    secret: gameServer.secret,
    playerId: "current-player",
    world: "room:AUTH:g2",
    kit: "gunner",
    masteryLevel: 1,
    isPetChoiceMade: true,
    script: () => idle(),
  });
  current.start();
  check("game server admits the current durable generation",
    await waitUntil(() => current.transport.isReady(), 3000));
  const privatePlayer = new Bot({
    url: gameServer.url,
    secret: gameServer.secret,
    playerId: "private-player",
    world: "pvp:room:PRIV:g2",
    kit: "gunner",
    masteryLevel: 1,
    isPetChoiceMade: true,
    script: () => idle(),
  });
  privatePlayer.start();
  check("test-config private flag admits the correctly policy-bound PVP generation",
    await waitUntil(() => privatePlayer.transport.isReady(), 3000));
  check("GS admission proof carries mode and exact immutable policy",
    verifiedProofs.some((candidate) =>
      candidate.worldId === "pvp:room:PRIV:g2"
      && candidate.mode === "pvp"
      && candidate.pvpPolicy === PRIVATE_DRAFT_PVP_POLICY
    ));
  stale.stop();
  current.stop();
  privatePlayer.stop();
} finally {
  await gameServer.close();
  await new Promise<void>((resolve) => admissionServer.close(() => resolve()));
}

let strictResponse = { status: 200, body: JSON.stringify({ isAllowed: true, code: "ok" }) };
const strictAdmissionServer = createServer(async (_request, response) => {
  response.writeHead(strictResponse.status, { "content-type": "application/json" });
  response.end(strictResponse.body);
});
await new Promise<void>((resolve) => strictAdmissionServer.listen(0, "127.0.0.1", resolve));
const strictAddress = strictAdmissionServer.address();
if (!strictAddress || typeof strictAddress === "string") {
  throw new Error("strict admission test server did not bind");
}
const strictGameServer = await startTestServer({
  receiptSecret: secret,
  admissionEndpoint: `http://127.0.0.1:${strictAddress.port}/gs/admission`,
});
try {
  const malformedCases = [
    ["allow missing code", 200, '{"isAllowed":true}'],
    ["allow null code", 200, '{"isAllowed":true,"code":null}'],
    ["allow unexpected code", 200, '{"isAllowed":true,"code":"unexpected"}'],
    ["array", 200, "[]"],
    ["null", 200, "null"],
    ["string", 200, '"ok"'],
    ["number", 200, "1"],
    ["allow extra key", 200, '{"isAllowed":true,"code":"ok","extra":1}'],
    ["deny missing code", 200, '{"isAllowed":false}'],
    ["malformed 403", 403, '{"isAllowed":false}'],
    ["403 allow mismatch", 403, '{"isAllowed":true,"code":"ok"}'],
    ["200 deny mismatch", 200, '{"isAllowed":false,"code":"membership_changed"}'],
    ["prototype key", 200, '{"isAllowed":true,"code":"ok","__proto__":{"polluted":true}}'],
    ["constructor key", 200, '{"isAllowed":true,"code":"ok","constructor":{"polluted":true}}'],
    ["invalid json", 200, "not-json"],
    ["malformed 500", 500, '{"isAllowed":true}'],
  ] as const;
  let index = 0;
  for (const [label, status, body] of malformedCases) {
    strictResponse = { status, body };
    const code = `M${String(index++).padStart(3, "0")}`;
    const worldId = `room:${code}:g1`;
    const bot = new Bot({
      url: strictGameServer.url,
      secret: strictGameServer.secret,
      playerId: `malformed-${code}`,
      world: worldId,
      kit: "gunner",
      masteryLevel: 1,
      isPetChoiceMade: true,
      script: () => idle(),
    });
    bot.start();
    const rejected = await waitUntil(
      () => (bot.transport.lastError ?? "").includes("admission_unavailable"),
      3_000,
    );
    check(`${label} fails closed before world creation`,
      rejected && strictGameServer.server.getWorld(worldId) === undefined);
    bot.stop();
  }

  strictResponse = {
    status: 403,
    body: JSON.stringify({ isAllowed: false, code: "membership_changed" }),
  };
  const denied = new Bot({
    url: strictGameServer.url,
    secret: strictGameServer.secret,
    playerId: "known-denial",
    world: "room:DENY:g1",
    kit: "gunner",
    masteryLevel: 1,
    isPetChoiceMade: true,
    script: () => idle(),
  });
  denied.start();
  check("exact 403 known denial preserves its stable code without creating a world",
    await waitUntil(() => (denied.transport.lastError ?? "").includes("membership_changed"), 3_000)
    && strictGameServer.server.getWorld("room:DENY:g1") === undefined);
  denied.stop();

  strictResponse = {
    status: 200,
    body: JSON.stringify({ isAllowed: true, code: "ok" }),
  };
  const allowed = new Bot({
    url: strictGameServer.url,
    secret: strictGameServer.secret,
    playerId: "strict-allow",
    world: "room:GOOD:g1",
    kit: "gunner",
    masteryLevel: 1,
    isPetChoiceMade: true,
    script: () => idle(),
  });
  allowed.start();
  check("exact 200 allow object is the sole positive shape",
    await waitUntil(() => allowed.transport.isReady(), 3_000)
    && strictGameServer.server.getWorld("room:GOOD:g1")?.playerCount === 1);
  allowed.stop();
  check("malformed admission responses increment the dedicated counter",
    strictGameServer.server.health().counters.admissionMalformedResponses === malformedCases.length);
} finally {
  await strictGameServer.close();
  await new Promise<void>((resolve) => strictAdmissionServer.close(() => resolve()));
}

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
