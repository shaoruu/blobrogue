import {
  RUN_RECEIPT_PREFIX,
  isRunCompletionPayload,
} from "../src/net/runReceipt.js";
import type { RunCompletionPayload } from "../src/net/runReceipt.js";
import { isStrictJsonObject } from "../src/net/strictJson.js";
import { verifyHmacEnvelope } from "./hmacEnvelopeCore.js";

export async function verifyRunCompletionReceipt(
  secret: string,
  receipt: string,
  nowMs = Date.now(),
): Promise<RunCompletionPayload | null> {
  const payloadBytes = await verifyHmacEnvelope(secret, receipt, RUN_RECEIPT_PREFIX);
  if (!payloadBytes) return null;
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
