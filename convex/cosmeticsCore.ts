// The canonical cosmetics catalog, as a pure zero-dependency module (the gsTicketCore
// pattern) so ONE definition serves every layer that needs it:
//   - convex/players.ts   — validates equip writes + grants earned unlocks on recordRun
//   - convex/gsTicket.ts  — embeds equipped ids as verified ticket claims (ht/gl)
//   - server/src/auth.ts  — validates claim FORMAT only (idFormat below), never the catalog,
//                           so a server deploy never races a catalog addition
//   - src/game/*, src/ui/* — rendering, the closet, ownership states
//
// Cosmetics are VISUAL-ONLY by construction: nothing in src/sim may import this module
// (locked by test/cosmetics.test.ts), the ids ride the wire only as PlayerWire.ht/gl labels,
// and no gameplay code branches on them.
//
// Ownership model (the launch slice):
//   - "starter" items are owned by everyone from the first session — no fabricated inventory.
//   - "earned" items are granted by players.recordRun when the all-time stats meet `need`
//     (the same trust level as the stats themselves). The `need` struct is the extensible
//     hook for future earned unlocks: add an entry here and recordRun grants it.
//   - The empty slot ("none") is not a catalog row; it is the absence of an equipped id.

export type CosmeticSlot = "hat" | "glasses";

// All-time stats an earned unlock can key on (mirrors the players-row aggregates).
export interface CosmeticNeed {
  deepestFloor?: number;
  totalKills?: number;
}

export interface CosmeticDef {
  id: string; // stable id — the unlocks[] key and the wire label (idFormat charset)
  slot: CosmeticSlot;
  name: string;
  unlock: "starter" | "earned";
  // Earned items only: the grant criterion + the player-facing line on the locked tile.
  need?: CosmeticNeed;
  hint?: string;
}

export const COSMETICS: readonly CosmeticDef[] = [
  { id: "hat_top", slot: "hat", name: "Top Hat", unlock: "starter" },
  { id: "hat_party", slot: "hat", name: "Party Cone", unlock: "starter" },
  { id: "hat_crown", slot: "hat", name: "Crown", unlock: "earned", need: { deepestFloor: 10 }, hint: "reach floor 10" },
  { id: "hat_halo", slot: "hat", name: "Halo", unlock: "earned", need: { deepestFloor: 20 }, hint: "reach floor 20" },
  { id: "glasses_round", slot: "glasses", name: "Round Specs", unlock: "starter" },
  { id: "glasses_shades", slot: "glasses", name: "Shades", unlock: "starter" },
  { id: "glasses_monocle", slot: "glasses", name: "Monocle", unlock: "earned", need: { totalKills: 500 }, hint: "500 all-time kills" },
];

// Wire/claim format gate for a cosmetic id: short lowercase token. The game server validates
// ONLY this (never the catalog), so unknown-but-well-formed ids pass through and render as
// nothing on old clients — the same defensive-decode posture as PlayerWire.cl.
export const COSMETIC_ID_MAX = 24;

export function isCosmeticIdFormat(id: string): boolean {
  return /^[a-z0-9_]{1,24}$/.test(id);
}

export function cosmeticById(id: string): CosmeticDef | undefined {
  return COSMETICS.find((c) => c.id === id);
}

export function cosmeticsForSlot(slot: CosmeticSlot): CosmeticDef[] {
  return COSMETICS.filter((c) => c.slot === slot);
}

// Ownership: starter items always, earned items only when granted into unlocks[].
export function isCosmeticOwned(def: CosmeticDef, unlocks: readonly string[]): boolean {
  return def.unlock === "starter" || unlocks.includes(def.id);
}

// The valid equip write for a slot: the id when it names an OWNED item of that slot,
// undefined otherwise (an unknown/locked/mis-slotted pick is ignored, never stored).
export function sanitizeEquip(slot: CosmeticSlot, id: string, unlocks: readonly string[]): string | undefined {
  const def = cosmeticById(id);
  if (!def || def.slot !== slot || !isCosmeticOwned(def, unlocks)) return undefined;
  return def.id;
}

// Earned ids satisfied by these all-time stats. recordRun calls this with the POST-fold
// aggregates and unions the result into unlocks[] — the single grant path.
export function earnedCosmeticsFor(stats: { deepestFloor: number; totalKills: number }): string[] {
  const out: string[] = [];
  for (const def of COSMETICS) {
    if (def.unlock !== "earned" || !def.need) continue;
    const needsFloor = def.need.deepestFloor !== undefined;
    const needsKills = def.need.totalKills !== undefined;
    const floorOk = !needsFloor || stats.deepestFloor >= (def.need.deepestFloor ?? 0);
    const killsOk = !needsKills || stats.totalKills >= (def.need.totalKills ?? 0);
    if (floorOk && killsOk) out.push(def.id);
  }
  return out;
}
