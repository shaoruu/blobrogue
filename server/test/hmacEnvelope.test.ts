import { Buffer } from "node:buffer";
import {
  decodeCanonicalBase64Url,
  encodeBase64Url,
} from "../../src/net/base64url.js";
import {
  GENERATION_ADMISSION_TTL_MS,
  GENERATION_ADMISSION_VERSION,
  type GenerationAdmissionPayload,
} from "../../src/net/generationAdmission.js";
import {
  RUN_RECEIPT_VERSION,
  type RunCompletionPayload,
} from "../../src/net/runReceipt.js";
import { verifyGenerationAdmissionProof } from "../../convex/generationAdmissionCore.js";
import { verifyRunCompletionReceipt as verifyConvexReceipt } from "../../convex/runReceiptCore.js";
import {
  mintGenerationAdmissionProof,
} from "../src/generationAdmissionClient.js";
import {
  mintRunCompletionReceipt,
  verifyRunCompletionReceipt as verifyNodeReceipt,
} from "../src/runReceipt.js";

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

let passed = 0;
let failed = 0;

function check(name: string, isPassing: boolean, detail = ""): void {
  if (isPassing) {
    passed++;
    process.stdout.write(`  PASS ${name}${detail ? ` — ${detail}` : ""}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ""}\n`);
  }
}

function tailAliases(canonical: string): string[] {
  const bytes = Buffer.from(canonical, "base64url");
  const remainder = bytes.length % 3;
  if (remainder === 0 || canonical.length === 0) return [];
  const last = BASE64URL_ALPHABET.indexOf(canonical.at(-1)!);
  const lowBits = remainder === 1 ? 4 : 2;
  const lowMask = (1 << lowBits) - 1;
  const high = last & ~lowMask;
  const aliases: string[] = [];
  for (let low = 0; low <= lowMask; low++) {
    const candidate = `${canonical.slice(0, -1)}${BASE64URL_ALPHABET[high | low]}`;
    if (candidate !== canonical && Buffer.from(candidate, "base64url").equals(bytes)) {
      aliases.push(candidate);
    }
  }
  return aliases;
}

function receiptPayload(now: number, suffix: string): RunCompletionPayload {
  return {
    version: RUN_RECEIPT_VERSION,
    jti: "a".repeat(32),
    runId: `room:ABCD:g1:seed:${suffix}`,
    worldId: "room:ABCD:g1",
    roomCode: "ABCD",
    generation: 1,
    status: "completed",
    issuedAt: now,
    expiresAt: now + 60_000,
    isNoActiveSeat: true,
    participants: [{
      playerId: "player-1",
      floor: 2,
      kills: 3,
      coins: 4,
      floorsCleared: 1,
      bossKills: [],
      isCacheArmed: false,
      amberWindfall: 0,
      durationMs: 5_000,
      weapons: ["pistol"],
      items: [],
    }],
  };
}

function admissionPayload(now: number, suffix: string): GenerationAdmissionPayload {
  return {
    version: GENERATION_ADMISSION_VERSION,
    jti: `0123456789abcdef0123456789abcdef${suffix}`,
    playerId: "player-1",
    worldId: "room:ABCD:g1",
    roomCode: "ABCD",
    generation: 1,
    mode: "coop",
    pvpPolicy: null,
    kitId: "gunner",
    petId: null,
    isPetChoiceMade: true,
    issuedAt: now,
    expiresAt: now + GENERATION_ADMISSION_TTL_MS,
  };
}

function envelopeWithSegment(
  envelope: string,
  index: 1 | 2,
  replacement: string,
): string {
  const parts = envelope.split(".");
  parts[index] = replacement;
  return parts.join(".");
}

const oneByte = encodeBase64Url(new Uint8Array([0xff]));
const twoBytes = encodeBase64Url(new Uint8Array([0xff, 0xee]));
check("one-byte canonical base64url round-trips",
  decodeCanonicalBase64Url(oneByte, { maxEncodedLength: 8, isNonEmpty: true })?.[0] === 0xff);
check("every one-byte unused-tail alias rejects",
  tailAliases(oneByte).length === 15
  && tailAliases(oneByte).every((alias) =>
    decodeCanonicalBase64Url(alias, { maxEncodedLength: 8, isNonEmpty: true }) === null
  ));
check("two-byte canonical base64url round-trips",
  Buffer.from(decodeCanonicalBase64Url(twoBytes, {
    maxEncodedLength: 8,
    isNonEmpty: true,
  }) ?? []).equals(Buffer.from([0xff, 0xee])));
check("every two-byte unused-tail alias rejects",
  tailAliases(twoBytes).length === 3
  && tailAliases(twoBytes).every((alias) =>
    decodeCanonicalBase64Url(alias, { maxEncodedLength: 8, isNonEmpty: true }) === null
  ));

for (const [label, value] of [
  ["padding", "YQ="],
  ["standard plus", "Y+"],
  ["standard slash", "Y/"],
  ["space", "Y Q"],
  ["newline", "Y\nQ"],
  ["unicode", "Yé"],
  ["mod4 one", "A"],
] as const) {
  check(`${label} base64url rejects`,
    decodeCanonicalBase64Url(value, { maxEncodedLength: 16, isNonEmpty: true }) === null);
}

const now = 1_760_000_000_000;
const secret = "canonical-envelope-secret";
let receipt = "";
let receiptPayloadAliases: string[] = [];
for (let length = 1; length <= 32 && receiptPayloadAliases.length === 0; length++) {
  receipt = mintRunCompletionReceipt(secret, receiptPayload(now, "x".repeat(length)));
  receiptPayloadAliases = tailAliases(receipt.split(".")[1]);
}
const receiptParts = receipt.split(".");
const receiptSignatureAliases = tailAliases(receiptParts[2]);
check("canonical r1 passes Convex and Node verification",
  await verifyConvexReceipt(secret, receipt, now) !== null
  && verifyNodeReceipt(secret, receipt, now) !== null);
check("all r1 signature tail aliases reject identically",
  receiptSignatureAliases.length === 3
  && (await Promise.all(receiptSignatureAliases.map(async (alias) =>
    await verifyConvexReceipt(secret, envelopeWithSegment(receipt, 2, alias), now) === null
    && verifyNodeReceipt(secret, envelopeWithSegment(receipt, 2, alias), now) === null
  ))).every(Boolean));
check("all r1 payload tail aliases reject identically",
  receiptPayloadAliases.length > 0
  && (await Promise.all(receiptPayloadAliases.map(async (alias) =>
    await verifyConvexReceipt(secret, envelopeWithSegment(receipt, 1, alias), now) === null
    && verifyNodeReceipt(secret, envelopeWithSegment(receipt, 1, alias), now) === null
  ))).every(Boolean));

let admission = "";
let admissionPayloadAliases: string[] = [];
for (let length = 0; length <= 32 && admissionPayloadAliases.length === 0; length++) {
  admission = mintGenerationAdmissionProof(secret, admissionPayload(now, "a".repeat(length)));
  admissionPayloadAliases = tailAliases(admission.split(".")[1]);
}
const admissionParts = admission.split(".");
const admissionSignatureAliases = tailAliases(admissionParts[2]);
check("canonical a2 passes shared verification",
  await verifyGenerationAdmissionProof(secret, admission, now) !== null);
check("every a2 signature tail alias rejects",
  admissionSignatureAliases.length === 3
  && (await Promise.all(admissionSignatureAliases.map(async (alias) =>
    await verifyGenerationAdmissionProof(secret, envelopeWithSegment(admission, 2, alias), now) === null
  ))).every(Boolean));
check("every a2 payload tail alias rejects",
  admissionPayloadAliases.length > 0
  && (await Promise.all(admissionPayloadAliases.map(async (alias) =>
    await verifyGenerationAdmissionProof(secret, envelopeWithSegment(admission, 1, alias), now) === null
  ))).every(Boolean));

const malformedSignatures = [
  receiptParts[2].slice(0, 42),
  `${receiptParts[2]}A`,
  encodeBase64Url(new Uint8Array(31)),
  encodeBase64Url(new Uint8Array(33)),
  `${receiptParts[2]}=`,
  `+${receiptParts[2].slice(1)}`,
  `/${receiptParts[2].slice(1)}`,
  `${receiptParts[2].slice(0, 10)} ${receiptParts[2].slice(10)}`,
  `${receiptParts[2].slice(0, 10)}é${receiptParts[2].slice(11)}`,
];
check("r1 malformed signature classes reject identically",
  (await Promise.all(malformedSignatures.map(async (signature) =>
    await verifyConvexReceipt(secret, envelopeWithSegment(receipt, 2, signature), now) === null
    && verifyNodeReceipt(secret, envelopeWithSegment(receipt, 2, signature), now) === null
  ))).every(Boolean));
check("a2 malformed signature classes reject",
  (await Promise.all(malformedSignatures.map(async (signature) =>
    await verifyGenerationAdmissionProof(secret, envelopeWithSegment(admission, 2, signature), now) === null
  ))).every(Boolean));

const malformedPayloads = [
  `${receiptParts[1]}=`,
  `+${receiptParts[1].slice(1)}`,
  `/${receiptParts[1].slice(1)}`,
  `${receiptParts[1].slice(0, 10)} ${receiptParts[1].slice(10)}`,
  `${receiptParts[1].slice(0, 10)}é${receiptParts[1].slice(11)}`,
  "A",
];
check("r1 malformed payload classes reject identically",
  (await Promise.all(malformedPayloads.map(async (payloadSegment) =>
    await verifyConvexReceipt(secret, envelopeWithSegment(receipt, 1, payloadSegment), now) === null
    && verifyNodeReceipt(secret, envelopeWithSegment(receipt, 1, payloadSegment), now) === null
  ))).every(Boolean));
check("a2 malformed payload classes reject",
  (await Promise.all(malformedPayloads.map(async (payloadSegment) =>
    await verifyGenerationAdmissionProof(secret, envelopeWithSegment(admission, 1, payloadSegment), now) === null
  ))).every(Boolean));

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
