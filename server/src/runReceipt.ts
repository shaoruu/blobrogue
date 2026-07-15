import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  RUN_RECEIPT_PREFIX,
  isRunCompletionPayload,
} from "../../src/net/runReceipt.js";
import type { RunCompletionPayload } from "../../src/net/runReceipt.js";

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function newRunReceiptJti(): string {
  return randomBytes(24).toString("hex");
}

export function mintRunCompletionReceipt(
  secret: string,
  payload: RunCompletionPayload,
): string {
  if (!isRunCompletionPayload(payload)) throw new Error("invalid run receipt payload");
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const body = `${RUN_RECEIPT_PREFIX}.${encoded}`;
  return `${body}.${sign(secret, body)}`;
}

export function verifyRunCompletionReceipt(
  secret: string,
  receipt: string,
  nowMs = Date.now(),
): RunCompletionPayload | null {
  const parts = receipt.split(".");
  if (parts.length !== 3 || parts[0] !== RUN_RECEIPT_PREFIX) return null;
  const body = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(sign(secret, body));
  const actual = Buffer.from(parts[2]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as RunCompletionPayload;
    if (!isRunCompletionPayload(payload)) return null;
    if (payload.issuedAt > nowMs + 30_000 || payload.expiresAt < nowMs) return null;
    return payload;
  } catch {
    return null;
  }
}
