export const PRIVATE_DRAFT_PVP_POLICY = "private_draft_v1" as const;
export type PvpPolicyId = typeof PRIVATE_DRAFT_PVP_POLICY;
export type PvpAccess = "private" | "public";

export const PVP_POLICY_MAX_PLAYERS = 4;

export function isPvpPolicyId(value: string): value is PvpPolicyId {
  return value === PRIVATE_DRAFT_PVP_POLICY;
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
  return isPublic ? "policy_mismatch" : null;
}
