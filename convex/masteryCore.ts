// Account MASTERY math for the Convex account authority — a self-contained MIRROR of the
// model in src/sim/kits.ts (the Convex bundle must stay import-free of app code, exactly like
// convex/gsTicketCore.ts mirrors the ticket byte-contract). The numbers here MUST match
// src/sim/kits.ts MASTERY: the game server re-gates the kit against the mastery level this
// module signs into the ticket, so a drift would let a validated pick fail the server gate.
//
// Mastery XP is an ACCESS track (KIT/XP spec §4): it gates WHICH kits may be selected, never a
// stat or a spendable balance. It is granted every run from run performance and is NOT a currency.

export type KitId = "none" | "gunner" | "mender" | "bulwark" | "phantom";

export const KIT_IDS: readonly Exclude<KitId, "none">[] = ["gunner", "mender", "bulwark", "phantom"];

export const XP_PER_FLOOR_CLEARED = 100;
export const XP_PER_BOSS_DEFEATED = 250;
export const XP_PER_DEPTH = 20;
export const XP_PER_LEVEL = 500;
export const UNLOCK_LEVEL: Record<Exclude<KitId, "none">, number> = { gunner: 1, mender: 1, bulwark: 3, phantom: 5 };

// Boss floors are every 5th depth (5, 10, 15, …).
const BOSS_FLOOR_INTERVAL = 5;

export function isKitId(v: unknown): v is KitId {
  return v === "none" || v === "gunner" || v === "mender" || v === "bulwark" || v === "phantom";
}

export function masteryLevelForXp(xp: number): number {
  if (!Number.isFinite(xp) || xp <= 0) return 1;
  return 1 + Math.floor(xp / XP_PER_LEVEL);
}

export function isKitUnlocked(kit: KitId, level: number): boolean {
  if (kit === "none") return true;
  if (!isKitId(kit)) return false;
  return level >= UNLOCK_LEVEL[kit];
}

export function unlockedKits(level: number): KitId[] {
  return KIT_IDS.filter((k) => isKitUnlocked(k, level));
}

// The run-end XP grant DERIVED from the deepest floor a run reached — no extra client payload
// needed: floorsCleared = reached-1, bossesDefeated = boss floors strictly below the reach,
// depth = the reach. Matches src/sim/kits.ts masteryXpForRun for the same derived stats.
export function masteryXpForReachedFloor(reachedFloor: number): number {
  const reached = Math.max(1, Math.floor(reachedFloor));
  const floorsCleared = Math.max(0, reached - 1);
  const bossesDefeated = Math.floor((reached - 1) / BOSS_FLOOR_INTERVAL);
  return floorsCleared * XP_PER_FLOOR_CLEARED + bossesDefeated * XP_PER_BOSS_DEFEATED + reached * XP_PER_DEPTH;
}
