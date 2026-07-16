import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  RUN_RECEIPT_PREFIX,
  isRunCompletionPayload,
} from "../../src/net/runReceipt.js";
import type { RunCompletionPayload } from "../../src/net/runReceipt.js";
import {
  decodeCanonicalBase64Url,
  encodeBase64Url,
} from "../../src/net/base64url.js";
import { isStrictJsonObject } from "../../src/net/strictJson.js";

function sign(secret: string, body: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

export function newRunReceiptJti(): string {
  return randomBytes(24).toString("hex");
}

export function mintRunCompletionReceipt(
  secret: string,
  payload: RunCompletionPayload,
): string {
  if (!isRunCompletionPayload(payload)) throw new Error("invalid run receipt payload");
  const encoded = encodeBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
  const body = `${RUN_RECEIPT_PREFIX}.${encoded}`;
  return `${body}.${encodeBase64Url(sign(secret, body))}`;
}

export function verifyRunCompletionReceipt(
  secret: string,
  receipt: string,
  nowMs = Date.now(),
): RunCompletionPayload | null {
  if (receipt.length === 0 || receipt.length > 16 * 1024) return null;
  const parts = receipt.split(".");
  if (parts.length !== 3 || parts[0] !== RUN_RECEIPT_PREFIX) return null;
  const body = `${parts[0]}.${parts[1]}`;
  const payloadBytes = decodeCanonicalBase64Url(parts[1], {
    maxEncodedLength: 12 * 1024,
    isNonEmpty: true,
  });
  const actual = decodeCanonicalBase64Url(parts[2], {
    maxEncodedLength: 43,
    isNonEmpty: true,
    exactEncodedLength: 43,
    exactDecodedLength: 32,
  });
  if (payloadBytes === null || actual === null) return null;
  const expected = sign(secret, body);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payloadText = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
    if (!isStrictJsonObject(payloadText)) return null;
    const payload = JSON.parse(payloadText) as RunCompletionPayload;
    if (!isRunCompletionPayload(payload)) return null;
    if (payload.issuedAt > nowMs + 30_000 || payload.expiresAt < nowMs) return null;
    return payload;
  } catch {
    return null;
  }
}
