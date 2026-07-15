import {
  RUN_RECEIPT_PREFIX,
  isRunCompletionPayload,
} from "../src/net/runReceipt.js";
import type { RunCompletionPayload } from "../src/net/runReceipt.js";
import { verifyHmacEnvelope } from "./hmacEnvelopeCore.js";

export async function verifyRunCompletionReceipt(
  secret: string,
  receipt: string,
  nowMs = Date.now(),
): Promise<RunCompletionPayload | null> {
  const payloadBytes = await verifyHmacEnvelope(secret, receipt, RUN_RECEIPT_PREFIX);
  if (!payloadBytes) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as RunCompletionPayload;
    if (!isRunCompletionPayload(payload)) return null;
    if (payload.issuedAt > nowMs + 30_000 || payload.expiresAt < nowMs) return null;
    return payload;
  } catch {
    return null;
  }
}
