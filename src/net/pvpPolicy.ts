import { PRIVATE_DRAFT_PVP_POLICY } from "../pvpPolicyId.js";
import type { PvpPolicyId } from "../pvpPolicyId.js";

export { PRIVATE_DRAFT_PVP_POLICY };
export type { PvpPolicyId };
export type PvpAccess = "private" | "public";

export const PVP_POLICY_MAX_PLAYERS = 4;

export interface PvpPolicyDefinition {
  id: PvpPolicyId;
  mode: "pvp";
  access: "private";
  isPublic: false;
  maxPlayers: typeof PVP_POLICY_MAX_PLAYERS;
}

const PRIVATE_DRAFT_POLICY: PvpPolicyDefinition = {
  id: PRIVATE_DRAFT_PVP_POLICY,
  mode: "pvp",
  access: "private",
  isPublic: false,
  maxPlayers: PVP_POLICY_MAX_PLAYERS,
};

export function isPvpPolicyId(value: string): value is PvpPolicyId {
  return value === PRIVATE_DRAFT_PVP_POLICY;
}

export function pvpPolicyDefinition(policy: PvpPolicyId): PvpPolicyDefinition {
  if (policy === PRIVATE_DRAFT_PVP_POLICY) return PRIVATE_DRAFT_POLICY;
  throw new Error(`unsupported PVP policy: ${String(policy)}`);
}

export function pvpPolicyAccess(policy: PvpPolicyId): PvpAccess {
  return pvpPolicyDefinition(policy).access;
}

export type PvpPolicyRejectCode =
  | "policy_required"
  | "policy_invalid"
  | "policy_mismatch";

export function validatePvpRoomPolicy(
  mode: "coop" | "pvp",
  isPublic: boolean,
  policy: string | null,
): PvpPolicyRejectCode | null {
  if (mode === "coop") return policy === null ? null : "policy_invalid";
  if (policy === null) return "policy_required";
  if (!isPvpPolicyId(policy)) return "policy_invalid";
  const definition = pvpPolicyDefinition(policy);
  return definition.isPublic === isPublic ? null : "policy_mismatch";
}
