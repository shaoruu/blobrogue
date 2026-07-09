// The canonical cosmetics catalog, as a pure zero-dependency module (the gsTicketCore
// pattern) so ONE definition serves every layer that needs it:
//   - convex/players.ts   — validates loadout writes + grants earned unlocks on recordRun
//   - convex/gsTicket.ts  — embeds equipped overlay ids as verified ticket claims (ht/fc)
//   - server/src/auth.ts  — validates claim FORMAT only (idFormat below), never the catalog,
//                           so a server deploy never races a catalog addition
//   - src/game/*, src/ui/* — rendering, the wardrobe, ownership states
//
// The design contract: cosmetics are TROPHIES YOU WEAR — purely visual, unlocked by
// achievement, never currency, never power, never random drops. Nothing in src/sim may
// import this module (locked by test/cosmetics.test.ts); hat/face ids ride the wire only
// as PlayerWire.ht/fc labels, and no gameplay code branches on any of it. Hats/faces are
// drawn INSIDE the body sprite's 64px frame with the weapon and name label rendered on
// top, so they can never change a hitbox or hide facing/weapon/telegraph reads.
//
// Slot model (launch: hat, face, body, title — future slots extend SLOTS, and the UI only
// ever shows what ships here):
//   - hat / face — overlay art items.
//   - body — the AUTHORED body palette, itself catalog items. Deliberately separate from
//     the player's party color (players.colorIndex), which keeps owning the network
//     identity surfaces: name label, minimap dot, lobby roster. At launch the closet sets
//     both to the same pick, but the model keeps them apart so party-assigned colors can
//     ship later without touching cosmetics.
//   - title — a wearable text honor (profile + leaderboard surfaces; not on the wire).
//
// Ownership:
//   - "starter" items are owned by everyone from the first session — no fabricated inventory.
//   - "earned" items are granted ONLY by players.recordRun when the all-time stats meet
//     `need` — the single authoritative award path (same trust level as the stats
//     themselves). Locked items surface their exact configured condition via `hint`.
//   - The empty slot ("none") is not a catalog row; it is the absence of an equipped id.

export type CosmeticSlot = "hat" | "face" | "body" | "title";

// The player's equipped loadout: one optional id per shipped slot. Stored on the profile
// (players.cosmeticLoadout), snapshotted onto leaderboard rows, defaulted empty for every
// profile that predates it.
export interface CosmeticLoadout {
  hat: string | null;
  face: string | null;
  body: string | null;
  title: string | null;
}

export const EMPTY_LOADOUT: CosmeticLoadout = { hat: null, face: null, body: null, title: null };

// The shipped slots, in wardrobe display order. The UI iterates THIS — a future slot added
// to the type but not listed here never renders.
export interface CosmeticSlotDef {
  slot: CosmeticSlot;
  label: string;     // wardrobe section heading
  noneLabel: string; // the empty-slot tile (the classic look)
}

export const COSMETIC_SLOTS: readonly CosmeticSlotDef[] = [
  { slot: "body", label: "blob color", noneLabel: "Amber (classic)" },
  { slot: "hat", label: "hats", noneLabel: "Cowboy (classic)" },
  { slot: "face", label: "face", noneLabel: "None" },
  { slot: "title", label: "titles", noneLabel: "None" },
];

// All-time stats an earned unlock can key on (mirrors the players-row aggregates).
export interface CosmeticNeed {
  deepestFloor?: number;
  totalKills?: number;
}

export interface CosmeticDef {
  id: string; // stable id — the unlocks[] key and (hat/face) the wire label (idFormat charset)
  slot: CosmeticSlot;
  name: string;
  unlock: "starter" | "earned";
  // Earned items only: the grant criterion + the player-facing line on the locked tile.
  need?: CosmeticNeed;
  hint?: string;
  // Body items only: the authored palette slot this body color renders as.
  paletteIndex?: number;
}

export const COSMETICS: readonly CosmeticDef[] = [
  // body — the authored palette (slot 0 amber is the default/none look)
  { id: "body_cyan", slot: "body", name: "Cyan", unlock: "starter", paletteIndex: 1 },
  { id: "body_green", slot: "body", name: "Green", unlock: "starter", paletteIndex: 2 },
  { id: "body_pink", slot: "body", name: "Pink", unlock: "starter", paletteIndex: 3 },
  { id: "body_violet", slot: "body", name: "Violet", unlock: "starter", paletteIndex: 4 },
  { id: "body_orange", slot: "body", name: "Orange", unlock: "starter", paletteIndex: 5 },
  // hats
  { id: "hat_top", slot: "hat", name: "Top Hat", unlock: "starter" },
  { id: "hat_party", slot: "hat", name: "Party Cone", unlock: "starter" },
  { id: "hat_crown", slot: "hat", name: "Crown", unlock: "earned", need: { deepestFloor: 10 }, hint: "reach floor 10" },
  { id: "hat_halo", slot: "hat", name: "Halo", unlock: "earned", need: { deepestFloor: 20 }, hint: "reach floor 20" },
  // face
  { id: "face_round", slot: "face", name: "Round Specs", unlock: "starter" },
  { id: "face_shades", slot: "face", name: "Shades", unlock: "starter" },
  { id: "face_monocle", slot: "face", name: "Monocle", unlock: "earned", need: { totalKills: 500 }, hint: "500 all-time kills" },
  // titles — text honors, earned only (the empty slot is the default)
  { id: "title_depth_diver", slot: "title", name: "Depth Diver", unlock: "earned", need: { deepestFloor: 10 }, hint: "reach floor 10" },
  { id: "title_blob_slayer", slot: "title", name: "Blob Slayer", unlock: "earned", need: { totalKills: 500 }, hint: "500 all-time kills" },
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
// aggregates and unions the result into unlocks[] — the single authoritative award path.
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

// The body item matching an authored palette slot (the closet's swatch pick), or undefined
// for slot 0 / unknown — the classic amber, i.e. the empty body slot.
export function bodyItemForPaletteIndex(paletteIndex: number): CosmeticDef | undefined {
  return COSMETICS.find((c) => c.slot === "body" && c.paletteIndex === paletteIndex);
}

// The authored palette slot a loadout's body renders as, else the fallback (at launch the
// party color, so body and identity agree until authored divergence ships).
export function bodyPaletteIndex(body: string | null, fallback: number): number {
  if (body === null) return fallback;
  return cosmeticById(body)?.paletteIndex ?? fallback;
}
