import {
  GENERATION_ADMISSION_PREFIX,
  isGenerationAdmissionPayload,
} from "../src/net/generationAdmission.js";
import type { GenerationAdmissionPayload } from "../src/net/generationAdmission.js";
import { isStrictJsonObject } from "../src/net/strictJson.js";
import { verifyHmacEnvelope } from "./hmacEnvelopeCore.js";

export async function verifyGenerationAdmissionProof(
  secret: string,
  proof: string,
  nowMs = Date.now(),
): Promise<GenerationAdmissionPayload | null> {
  const payloadBytes = await verifyHmacEnvelope(secret, proof, GENERATION_ADMISSION_PREFIX);
  if (!payloadBytes) return null;
  try {
    const payloadText = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
    if (!isStrictJsonObject(payloadText)) return null;
    const payload = JSON.parse(payloadText) as GenerationAdmissionPayload;
    if (!isGenerationAdmissionPayload(payload)) return null;
    if (payload.issuedAt > nowMs + 5_000 || payload.expiresAt < nowMs) return null;
    return payload;
  } catch {
    return null;
  }
}
