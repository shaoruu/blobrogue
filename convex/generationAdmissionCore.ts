import {
  GENERATION_ADMISSION_PREFIX,
  isGenerationAdmissionPayload,
} from "../src/net/generationAdmission.js";
import type { GenerationAdmissionPayload } from "../src/net/generationAdmission.js";
import { verifyHmacEnvelope } from "./hmacEnvelopeCore.js";

export async function verifyGenerationAdmissionProof(
  secret: string,
  proof: string,
  nowMs = Date.now(),
): Promise<GenerationAdmissionPayload | null> {
  const payloadBytes = await verifyHmacEnvelope(secret, proof, GENERATION_ADMISSION_PREFIX);
  if (!payloadBytes) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as GenerationAdmissionPayload;
    if (!isGenerationAdmissionPayload(payload)) return null;
    if (payload.issuedAt > nowMs + 5_000 || payload.expiresAt < nowMs) return null;
    return payload;
  } catch {
    return null;
  }
}
