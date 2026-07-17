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
  cost: number;               // Amber cost (0 = free-unlocked / not amber-bought)
  prereqs: readonly string[]; // node ids that must already be owned
  desc: string;               // one player-facing line
  // companion nodes only: the pet id this node grants (the equippedPet value + wire label).
  pet?: string;
  // convenience only: extra coins the player starts a floor run with (no combat power).
  startCoins?: number;
  // RESCUED, never bought (studio hard line — pets must read clear of pay-for-advantage): the
  // node is granted like an achievement (server-side, see camp_nodes rescue helpers), and
  // canBuyNode refuses it. The Kennel adopts/equips it; it is never a shop item.
  rescue?: boolean;
  // rescue nodes only: the deepest floor a run must reach to earn this one-time rescue. The
  // server bank (recordRun) grants every rescue node whose milestone a run cleared; the Kennel
  // reads it to tell the player which floor brings each companion home.
  rescueFloor?: number;
}

// The camp hub itself: free-unlocked the first time a player banks any Amber (the loop's
// entry). Everything else prereqs on it.
export const CAMP_SHELL_ID = "camp_shell";

// Pet #1 — the doggie. It is RESCUED, not bought (studio hard line): granted like an
// achievement the first time a run reaches DOGGIE_RESCUE_FLOOR (reachable in the first few
// runs). The pet it grants is DOGGIE_PET_ID, which rides the wire as the equipped-pet label.
export const DOGGIE_NODE_ID = "pet_doggie";
export const DOGGIE_PET_ID = "doggie";
// The stray pup is found in the depths: the deepest floor a run must reach to rescue it. Kept
// shallow so the pet lands early (the loop's first emotional payoff), and it is one-time.
export const DOGGIE_RESCUE_FLOOR = 3;

// Pet #2 — the cat. Same RESCUE contract as the doggie, found DEEPER: a run must reach the
// cat's floor to bring it home. Never bought (canBuyNode refuses it).
export const CAT_NODE_ID = "pet_cat";
export const CAT_PET_ID = "cat";
export const CAT_RESCUE_FLOOR = 7;

// Pet #3 — the baby dragon. RESCUED deeper still (the pack's showpiece companion), never
// bought. Reaching its floor on any run grants it one time.
export const DRAGON_NODE_ID = "pet_dragon";
export const DRAGON_PET_ID = "dragon";
export const DRAGON_RESCUE_FLOOR = 12;

// Pet #4 — the baby slime, the DEEPEST rescue of the ORIGINAL pack (a blob befriending a baby
// blob). RESCUED like the rest, never bought — reaching its floor on any run grants it one time.
export const SLIME_NODE_ID = "pet_slime";
export const SLIME_PET_ID = "slime";
export const SLIME_RESCUE_FLOOR = 18;

// Pack #2 — four more RESCUED companions (never bought, canBuyNode refuses them). Provisional
// ids the parent may rename via follow-up; each is a pure cosmetic wire label like the pack
// above, granted the one-time a run reaches its floor. Their rescue floors INTERLEAVE with the
// original pack (the grant is data-driven off rescueFloor, never per-pet), so a deep run brings
// several companions home at once.
// #5 — the Ember Fox kit, an amber fox found in the shallow depths.
export const EMBERFOX_NODE_ID = "pet_emberfox";
export const EMBERFOX_PET_ID = "emberfox";
export const EMBERFOX_RESCUE_FLOOR = 5;
// #6 — the Hollow Owlet, a little owl roosting deeper down.
export const OWLET_NODE_ID = "pet_owlet";
export const OWLET_PET_ID = "owlet";
export const OWLET_RESCUE_FLOOR = 10;
// #7 — the Glow Mothling, a soft-lit moth fluttering in the dark.
export const MOTHLING_NODE_ID = "pet_mothling";
export const MOTHLING_PET_ID = "mothling";
export const MOTHLING_RESCUE_FLOOR = 15;
// #8 — Rolly, a curl-up pillbug from the deepest dark of this pack.
export const ROLLY_NODE_ID = "pet_rolly";
export const ROLLY_PET_ID = "rolly";
export const ROLLY_RESCUE_FLOOR = 22;

// Whether a run that reached `deepestFloorThisRun` earns the one-time doggie rescue. Pure so
// the server bank (recordRun) and any client hint agree.
export function isDoggieRescuedByRun(deepestFloorThisRun: number): boolean {
  return deepestFloorThisRun >= DOGGIE_RESCUE_FLOOR;
}

// The rescue-node ids a run that reached `deepestFloorThisRun` earns (deepest floor >= each
// node's rescueFloor). Pure + data-driven from CAMP_NODES so the server bank grants every
// companion a deep run cleared with no per-pet branching. A new rescue pet lands here for
// free the moment its node carries a rescueFloor.
export function rescueNodesForRun(deepestFloorThisRun: number): string[] {
  return CAMP_NODES
    .filter((n) => n.rescue && n.rescueFloor !== undefined && deepestFloorThisRun >= n.rescueFloor)
    .map((n) => n.id);
}

export const CAMP_NODES: readonly CampNodeDef[] = [
  {
    id: CAMP_SHELL_ID, name: "Amber Camp", category: "hub", cost: 0, prereqs: [],
    desc: "The camp stirs awake — free the first time you bank Amber.",
  },
  {
    id: DOGGIE_NODE_ID, name: "Doggie", category: "companion", cost: 0, prereqs: [],
    desc: "A stray pup rescued from the depths — adopt it at the Kennel and it trots along at your side, into the dungeon and all.",
    pet: DOGGIE_PET_ID, rescue: true, rescueFloor: DOGGIE_RESCUE_FLOOR,
  },
  {
    id: CAT_NODE_ID, name: "Cat", category: "companion", cost: 0, prereqs: [],
    desc: "A grey kitten stranded in the deeper dark — carry it home and it pads along at your side, sitting when you rest.",
    pet: CAT_PET_ID, rescue: true, rescueFloor: CAT_RESCUE_FLOOR,
  },
  {
    id: DRAGON_NODE_ID, name: "Baby Dragon", category: "companion", cost: 0, prereqs: [],
    desc: "A little amber dragon curled up in the depths — bring it back and it flutters after you, run after run.",
    pet: DRAGON_PET_ID, rescue: true, rescueFloor: DRAGON_RESCUE_FLOOR,
  },
  {
    id: SLIME_NODE_ID, name: "Baby Slime", category: "companion", cost: 0, prereqs: [],
    desc: "A wobbling baby blob from the deepest dark — one blob befriending another; carry it home and it bounces along at your side.",
    pet: SLIME_PET_ID, rescue: true, rescueFloor: SLIME_RESCUE_FLOOR,
  },
  {
    id: EMBERFOX_NODE_ID, name: "Ember Fox", category: "companion", cost: 0, prereqs: [],
    desc: "A tiny amber fox kit warming itself in the shallows — carry it home and it trots at your heels, tail flickering like a coal.",
    pet: EMBERFOX_PET_ID, rescue: true, rescueFloor: EMBERFOX_RESCUE_FLOOR,
  },
  {
    id: OWLET_NODE_ID, name: "Hollow Owlet", category: "companion", cost: 0, prereqs: [],
    desc: "A wide-eyed little owl roosting in the deeper dark — bring it back and it bobs along at your side, blinking at the gloom.",
    pet: OWLET_PET_ID, rescue: true, rescueFloor: OWLET_RESCUE_FLOOR,
  },
  {
    id: MOTHLING_NODE_ID, name: "Glow Mothling", category: "companion", cost: 0, prereqs: [],
    desc: "A soft-glowing moth drawn to your lantern in the dark — carry it home and it flutters after you, lighting the way a little.",
    pet: MOTHLING_PET_ID, rescue: true, rescueFloor: MOTHLING_RESCUE_FLOOR,
  },
  {
    id: ROLLY_NODE_ID, name: "Rolly", category: "companion", cost: 0, prereqs: [],
    desc: "A round little pillbug curled up in the deepest dark of the pack — carry it home and it ambles along beside you, ready to tuck into a ball.",
    pet: ROLLY_PET_ID, rescue: true, rescueFloor: ROLLY_RESCUE_FLOOR,
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

export type BuyReject = "unknown" | "owned" | "locked" | "insufficient" | "rescue";

export type BuyCheck = { ok: true; cost: number } | { ok: false; reason: BuyReject };

// The server-authoritative purchase gate (pure): the Convex buyNode mutation calls THIS with
// the row's real Amber + owned ids, so a client can never fake affordability or prereqs. A
// RESCUE node (a pet) is never for sale — Amber can never buy a pet (pay-for-advantage line).
export function canBuyNode(id: string, amber: number, owned: readonly string[]): BuyCheck {
  const node = campNodeById(id);
  if (!node) return { ok: false, reason: "unknown" };
  if (node.rescue) return { ok: false, reason: "rescue" };
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
