import { createHmac, randomBytes } from "node:crypto";
import {
  GENERATION_ADMISSION_PREFIX,
  isGenerationAdmissionPayload,
} from "../../src/net/generationAdmission.js";
import type {
  GenerationAdmissionDecision,
  GenerationAdmissionPayload,
} from "../../src/net/generationAdmission.js";
import type { Logger } from "./logger.js";

type Fetcher = typeof fetch;

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function newGenerationAdmissionJti(): string {
  return randomBytes(24).toString("hex");
}

export function mintGenerationAdmissionProof(
  secret: string,
  payload: GenerationAdmissionPayload,
): string {
  if (!isGenerationAdmissionPayload(payload)) throw new Error("invalid generation admission payload");
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const body = `${GENERATION_ADMISSION_PREFIX}.${encoded}`;
  return `${body}.${sign(secret, body)}`;
}

export class GenerationAdmissionClient {
  constructor(
    private endpoint: string | null,
    private secret: string | null,
    private log: Logger,
    private fetcher: Fetcher = fetch,
  ) {}

  async check(payload: GenerationAdmissionPayload): Promise<GenerationAdmissionDecision> {
    if (!this.endpoint || !this.secret) {
      return { isAllowed: false, code: "admission_unavailable" };
    }
    try {
      const proof = mintGenerationAdmissionProof(this.secret, payload);
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proof }),
        signal: AbortSignal.timeout(2_500),
      });
      const decision = await response.json() as GenerationAdmissionDecision;
      if (response.ok && decision.isAllowed === true) return decision;
      return {
        isAllowed: false,
        code: typeof decision.code === "string" ? decision.code : "admission_rejected",
      };
    } catch (error) {
      this.log.warn("generation admission check failed closed", {
        worldId: payload.worldId,
        playerId: payload.playerId,
        error: String(error),
      });
      return { isAllowed: false, code: "admission_unavailable" };
    }
  }
}
