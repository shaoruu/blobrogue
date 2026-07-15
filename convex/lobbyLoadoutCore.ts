export interface LobbyStartMember {
  playerId: string;
  name: string;
  updatedAt: number;
  isReady?: boolean;
  isKitChoiceMade?: boolean;
  isPetChoiceMade?: boolean;
  isLoadoutConfirmed?: boolean;
  loadoutGeneration?: number;
  loadoutKitId?: string;
}

export type LobbyStartDecision =
  | { ok: true }
  | {
      ok: false;
      code: "kit_missing" | "pet_missing" | "loadout_missing" | "not_ready";
      playerName: string;
      message: string;
    };

export function loadoutBlockerForMember(
  member: LobbyStartMember,
  generation: number,
): Exclude<LobbyStartDecision, { ok: true }> | null {
  if (member.isKitChoiceMade !== true || member.loadoutKitId === undefined) {
    return {
      ok: false,
      code: "kit_missing",
      playerName: member.name,
      message: `${member.name} must choose a kit`,
    };
  }
  if (member.isPetChoiceMade !== true) {
    return {
      ok: false,
      code: "pet_missing",
      playerName: member.name,
      message: `${member.name} must choose a pet or No Pet`,
    };
  }
  if (member.isLoadoutConfirmed !== true || member.loadoutGeneration !== generation) {
    return {
      ok: false,
      code: "loadout_missing",
      playerName: member.name,
      message: `${member.name} must confirm loadout`,
    };
  }
  return null;
}

export function evaluateLobbyStart(
  members: readonly LobbyStartMember[],
  hostPlayerId: string,
  generation: number,
  now: number,
  activeMemberMs: number,
): LobbyStartDecision {
  const cutoff = now - activeMemberMs;
  const active = members.filter((member) => member.updatedAt >= cutoff);
  const host = active.find((member) => member.playerId === hostPlayerId);
  if (!host) {
    const hostName = members.find((member) => member.playerId === hostPlayerId)?.name ?? "HOST";
    return {
      ok: false,
      code: "loadout_missing",
      playerName: hostName,
      message: `${hostName} must reconnect and confirm KIT + PET`,
    };
  }
  for (const member of active) {
    const blocker = loadoutBlockerForMember(member, generation);
    if (blocker) return blocker;
  }
  for (const member of active) {
    if (member.isReady !== true) {
      return {
        ok: false,
        code: "not_ready",
        playerName: member.name,
        message: `${member.name} is not ready`,
      };
    }
  }
  return { ok: true };
}
