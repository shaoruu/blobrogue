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
  { slot: "hat", label: "Hats", noneLabel: "No Hat (Cowboy)" },
  { slot: "face", label: "Glasses", noneLabel: "No Glasses" },
  { slot: "body", label: "Blob Color", noneLabel: "Amber (classic)" },
  { slot: "title", label: "Titles", noneLabel: "No Title" },
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
  // Overlay items (hat/face) only: the generated-asset key in the art pipeline — the base
  // name of the three oriented PNGs (see src/game/cosmeticSockets.ts COSMETIC_ASSET_SOURCES).
  // Every shipped overlay carries one; the sprite is the only art, so while a file is still
  // streaming the item renders nothing (never a fabricated placeholder).
  assetKey?: string;
}

export const COSMETICS: readonly CosmeticDef[] = [
  // body — the authored palette (slot 0 amber is the default/none look)
  { id: "body_cyan", slot: "body", name: "Cyan", unlock: "starter", paletteIndex: 1 },
  { id: "body_green", slot: "body", name: "Green", unlock: "starter", paletteIndex: 2 },
  { id: "body_pink", slot: "body", name: "Pink", unlock: "starter", paletteIndex: 3 },
  { id: "body_violet", slot: "body", name: "Violet", unlock: "starter", paletteIndex: 4 },
  { id: "body_orange", slot: "body", name: "Orange", unlock: "starter", paletteIndex: 5 },
  // hats — every entry hooks its generated sprite via assetKey (the base name shared by the
  // three oriented PNGs in public/sprites/cosmetics; see cosmeticSockets COSMETIC_ASSET_SOURCES).
  // The cowboy hat is a normal equippable layer that rides the bald base — the classic look
  // is the bare-headed default, and this lets a player re-pick it explicitly.
  { id: "cowboy_hat_classic", slot: "hat", name: "Cowboy Hat", unlock: "starter", assetKey: "cowboy_hat_classic" },
  { id: "hat_top", slot: "hat", name: "Top Hat", unlock: "starter", assetKey: "hat_top" },
  { id: "hat_beanie", slot: "hat", name: "Beanie", unlock: "starter", assetKey: "hat_beanie" },
  { id: "hat_chef", slot: "hat", name: "Chef's Hat", unlock: "starter", assetKey: "hat_chef" },
  { id: "hat_party", slot: "hat", name: "Party Cone", unlock: "starter", assetKey: "hat_party" },
  { id: "hat_flower", slot: "hat", name: "Flower", unlock: "earned", need: { deepestFloor: 5 }, hint: "reach floor 5", assetKey: "hat_flower" },
  { id: "hat_mushroom", slot: "hat", name: "Mushroom", unlock: "earned", need: { deepestFloor: 8 }, hint: "reach floor 8", assetKey: "hat_mushroom" },
  { id: "hat_crown", slot: "hat", name: "Crown", unlock: "earned", need: { deepestFloor: 10 }, hint: "reach floor 10", assetKey: "hat_crown" },
  { id: "hat_wizard", slot: "hat", name: "Wizard Hat", unlock: "earned", need: { deepestFloor: 15 }, hint: "reach floor 15", assetKey: "hat_wizard" },
  { id: "hat_halo", slot: "hat", name: "Halo", unlock: "earned", need: { deepestFloor: 20 }, hint: "reach floor 20", assetKey: "hat_halo" },
  { id: "hat_headphones", slot: "hat", name: "Headphones", unlock: "earned", need: { totalKills: 100 }, hint: "100 all-time kills", assetKey: "hat_headphones" },
  { id: "hat_helmet", slot: "hat", name: "Helmet", unlock: "earned", need: { totalKills: 250 }, hint: "250 all-time kills", assetKey: "hat_helmet" },
  { id: "hat_horns", slot: "hat", name: "Horns", unlock: "earned", need: { totalKills: 1000 }, hint: "1000 all-time kills", assetKey: "hat_horns" },
  // hats, pack #2 — a fresh mix of starters + earned (assetKey matches the file stem; the
  // sprite is the only art, so a still-streaming file renders nothing, never a placeholder).
  { id: "hat_beret", slot: "hat", name: "Beret", unlock: "starter", assetKey: "hat_beret" },
  { id: "hat_bow", slot: "hat", name: "Bow", unlock: "starter", assetKey: "hat_bow" },
  { id: "hat_bandana", slot: "hat", name: "Bandana", unlock: "starter", assetKey: "hat_bandana" },
  { id: "hat_propeller", slot: "hat", name: "Propeller Cap", unlock: "earned", need: { deepestFloor: 6 }, hint: "reach floor 6", assetKey: "hat_propeller" },
  { id: "hat_viking", slot: "hat", name: "Viking Helm", unlock: "earned", need: { deepestFloor: 18 }, hint: "reach floor 18", assetKey: "hat_viking" },
  { id: "hat_leaf", slot: "hat", name: "Leaf", unlock: "earned", need: { deepestFloor: 30 }, hint: "reach floor 30", assetKey: "hat_leaf" },
  { id: "hat_hardhat", slot: "hat", name: "Hard Hat", unlock: "earned", need: { totalKills: 150 }, hint: "150 all-time kills", assetKey: "hat_hardhat" },
  { id: "hat_space", slot: "hat", name: "Space Helmet", unlock: "earned", need: { totalKills: 400 }, hint: "400 all-time kills", assetKey: "hat_space" },
  // face
  { id: "face_round", slot: "face", name: "Round Specs", unlock: "starter", assetKey: "round_glasses" },
  { id: "face_shades", slot: "face", name: "Shades", unlock: "starter", assetKey: "face_shades" },
  { id: "face_eyepatch", slot: "face", name: "Eyepatch", unlock: "earned", need: { deepestFloor: 12 }, hint: "reach floor 12", assetKey: "face_eyepatch" },
  { id: "face_star_shades", slot: "face", name: "Star Shades", unlock: "earned", need: { totalKills: 750 }, hint: "750 all-time kills", assetKey: "face_star_shades" },
  { id: "face_3d_glasses", slot: "face", name: "3D Glasses", unlock: "earned", need: { deepestFloor: 25 }, hint: "reach floor 25", assetKey: "face_3d_glasses" },
  { id: "face_monocle", slot: "face", name: "Monocle", unlock: "earned", need: { totalKills: 500 }, hint: "500 all-time kills", assetKey: "face_monocle" },
  // faces, pack #2 — starters + earned (assetKey matches the file stem, like the hats above).
  { id: "face_goggles", slot: "face", name: "Goggles", unlock: "starter", assetKey: "face_goggles" },
  { id: "face_heart_shades", slot: "face", name: "Heart Shades", unlock: "starter", assetKey: "face_heart_shades" },
  { id: "face_visor", slot: "face", name: "Visor", unlock: "earned", need: { deepestFloor: 14 }, hint: "reach floor 14", assetKey: "face_visor" },
  { id: "face_bandage", slot: "face", name: "Bandage", unlock: "earned", need: { totalKills: 300 }, hint: "300 all-time kills", assetKey: "face_bandage" },
  { id: "face_snorkel", slot: "face", name: "Snorkel Mask", unlock: "earned", need: { deepestFloor: 28 }, hint: "reach floor 28", assetKey: "face_snorkel" },
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
