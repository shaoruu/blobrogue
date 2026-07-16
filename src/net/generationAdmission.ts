import { parseGenerationWorldId } from "./runReceipt.js";
import { validatePvpRoomPolicy, type PvpPolicyId } from "./pvpPolicy.js";

export const GENERATION_ADMISSION_VERSION = 2;
export const GENERATION_ADMISSION_PREFIX = "a2";
export const GENERATION_ADMISSION_TTL_MS = 5_000;

export interface GenerationAdmissionPayload {
  version: number;
  jti: string;
  playerId: string;
  worldId: string;
  roomCode: string;
  generation: number;
  mode: "coop" | "pvp";
  pvpPolicy: PvpPolicyId | null;
  kitId: string;
  petId: string | null;
  isPetChoiceMade: boolean;
  issuedAt: number;
  expiresAt: number;
}

export const GENERATION_ADMISSION_DENY_CODES = [
  "room_not_active",
  "generation_not_active",
  "player_missing",
  "membership_changed",
  "policy_required",
  "policy_invalid",
  "policy_mismatch",
  "private_disabled",
  "public_disabled",
  "room_full",
] as const;

export type GenerationAdmissionDenyCode = typeof GENERATION_ADMISSION_DENY_CODES[number];
export type GenerationAdmissionRemoteDecision =
  | { isAllowed: true; code: "ok" }
  | { isAllowed: false; code: GenerationAdmissionDenyCode };

export interface GenerationAdmissionDecision {
  isAllowed: boolean;
  code: string;
}

export type AdmissionJson =
  | null
  | boolean
  | number
  | string
  | AdmissionJson[]
  | { [key: string]: AdmissionJson };

const ADMISSION_DENY_CODE_SET = new Set<string>(GENERATION_ADMISSION_DENY_CODES);

export function parseGenerationAdmissionDecision(
  value: AdmissionJson,
): GenerationAdmissionRemoteDecision | null {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    return null;
  }
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("isAllowed") || !keys.includes("code")) return null;
  if (!Object.prototype.hasOwnProperty.call(value, "isAllowed")
    || !Object.prototype.hasOwnProperty.call(value, "code")) return null;
  const isAllowed = value.isAllowed;
  const code = value.code;
  if (isAllowed === true && code === "ok") return { isAllowed: true, code: "ok" };
  if (isAllowed === false && typeof code === "string" && ADMISSION_DENY_CODE_SET.has(code)) {
    return { isAllowed: false, code: code as GenerationAdmissionDenyCode };
  }
  return null;
}

export function isGenerationAdmissionPayload(payload: GenerationAdmissionPayload): boolean {
  const world = parseGenerationWorldId(payload.worldId);
  return world !== null
    && payload.version === GENERATION_ADMISSION_VERSION
    && /^[a-f0-9]{32,64}$/.test(payload.jti)
    && payload.playerId.length > 0
    && payload.playerId.length <= 64
    && payload.roomCode === world.roomCode
    && payload.generation === world.generation
    && payload.mode === (world.isPvp ? "pvp" : "coop")
    && validatePvpRoomPolicy(payload.mode, false, payload.pvpPolicy) === null
    && /^[a-z0-9_]{1,24}$/.test(payload.kitId)
    && (payload.petId === null || /^[a-z0-9_]{1,24}$/.test(payload.petId))
    && payload.isPetChoiceMade === true
    && Number.isSafeInteger(payload.issuedAt)
    && Number.isSafeInteger(payload.expiresAt)
    && payload.expiresAt > payload.issuedAt;
}
