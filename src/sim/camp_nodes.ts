// WAVE 1 meta-progression: the Amber Camp node table (META spec §2/§4, PROGRESSION §4).
//
// This is a PURE, self-contained data module — it imports NOTHING, so it stays inside the
// src/sim purity gate (no cosmetics/convex imports) and is trivially safe to bundle on both
// sides of the wire: the client (src/ui, src/game) reads it to render the Camp + Kennel, and
// the Convex mutations import it to validate a purchase SERVER-SIDE (cost / prereqs /
// ownership). The two-currency law holds: Amber buys PETS, CONVENIENCE, and camp FOUNDATION
// only — NEVER cosmetics (that is the Wardrobe/cosmeticsCore hard line) and never a currency.
//
// Owned node ids live alongside cosmetic + boss-kill ids in players.unlocks[]; the
// camp_/pet_/stash_/coin_ prefixes keep the namespaces disjoint so nothing collides.

export type CampNodeCategory = "hub" | "companion" | "convenience";

export interface CampNodeDef {
  id: string;                 // owned-node id (stored in players.unlocks[])
  name: string;
  category: CampNodeCategory;
  cost: number;               // Amber cost (0 = free-unlocked)
  prereqs: readonly string[]; // node ids that must already be owned
  desc: string;               // one player-facing line
  // companion nodes only: the pet id this node grants (the equippedPet value + wire label).
  pet?: string;
  // convenience only: extra coins the player starts a floor run with (no combat power).
  startCoins?: number;
}

// The camp hub itself: free-unlocked the first time a player banks any Amber (the loop's
// entry). Everything else prereqs on it.
export const CAMP_SHELL_ID = "camp_shell";

// Pet #1 — the doggie. Its node is bought with Amber; the pet it grants is DOGGIE_PET_ID,
// which is what rides the wire as the equipped-pet label.
export const DOGGIE_NODE_ID = "pet_doggie";
export const DOGGIE_PET_ID = "doggie";

export const CAMP_NODES: readonly CampNodeDef[] = [
  {
    id: CAMP_SHELL_ID, name: "Amber Camp", category: "hub", cost: 0, prereqs: [],
    desc: "The camp stirs awake — free the first time you bank Amber.",
  },
  {
    id: DOGGIE_NODE_ID, name: "Doggie", category: "companion", cost: 30, prereqs: [CAMP_SHELL_ID],
    desc: "Adopt a loyal pup at the Kennel — it trots along at your side, into the dungeon and all.",
    pet: DOGGIE_PET_ID,
  },
  {
    id: "stash_slot_1", name: "Stash Slot", category: "convenience", cost: 25, prereqs: [CAMP_SHELL_ID],
    desc: "A little extra room to stow your finds.",
  },
  {
    id: "coin_pouch", name: "Coin Pouch", category: "convenience", cost: 20, prereqs: [CAMP_SHELL_ID],
    desc: "Start every run with +5 coins.",
    startCoins: 5,
  },
] as const;

export function campNodeById(id: string): CampNodeDef | undefined {
  return CAMP_NODES.find((n) => n.id === id);
}

export function isNodeOwned(id: string, owned: readonly string[]): boolean {
  return owned.includes(id);
}

export function prereqsMet(node: CampNodeDef, owned: readonly string[]): boolean {
  return node.prereqs.every((p) => owned.includes(p));
}

export type BuyReject = "unknown" | "owned" | "locked" | "insufficient";

export type BuyCheck = { ok: true; cost: number } | { ok: false; reason: BuyReject };

// The server-authoritative purchase gate (pure): the Convex buyNode mutation calls THIS with
// the row's real Amber + owned ids, so a client can never fake affordability or prereqs.
export function canBuyNode(id: string, amber: number, owned: readonly string[]): BuyCheck {
  const node = campNodeById(id);
  if (!node) return { ok: false, reason: "unknown" };
  if (isNodeOwned(id, owned)) return { ok: false, reason: "owned" };
  if (!prereqsMet(node, owned)) return { ok: false, reason: "locked" };
  if (amber < node.cost) return { ok: false, reason: "insufficient" };
  return { ok: true, cost: node.cost };
}

// The pet ids a player owns, derived from their owned companion nodes.
export function ownedPets(owned: readonly string[]): string[] {
  const pets: string[] = [];
  for (const n of CAMP_NODES) if (n.pet && owned.includes(n.id)) pets.push(n.pet);
  return pets;
}

export function isPetOwned(petId: string, owned: readonly string[]): boolean {
  return ownedPets(owned).includes(petId);
}

// Extra starting coins granted by owned convenience nodes (coin_pouch). Summed so more
// pouches can land later without touching call sites.
export function startCoinBonus(owned: readonly string[]): number {
  let sum = 0;
  for (const n of CAMP_NODES) if (n.startCoins && owned.includes(n.id)) sum += n.startCoins;
  return sum;
}
