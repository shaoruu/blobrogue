import {
  GENERATION_ADMISSION_TTL_MS,
  GENERATION_ADMISSION_VERSION,
} from "../../src/net/generationAdmission.js";
import type { GenerationAdmissionPayload } from "../../src/net/generationAdmission.js";
import { verifyGenerationAdmissionProof } from "../../convex/generationAdmissionCore.js";
import {
  GenerationAdmissionClient,
  mintGenerationAdmissionProof,
} from "../src/generationAdmissionClient.js";
import { createLogger } from "../src/logger.js";

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

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
