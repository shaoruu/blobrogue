// Patch's shop — the authored Dealer room. Owner call (studio coherence gate "Dealer
// hook" + live feedback): the Dealer is never loose priced pickups bought by walking over
// them. Instead, every third depth hosts a dedicated safe `shop` room (a secured relay
// niche) where Patch, the warm amber salvage-hauler, unfolds a stall: three item pedestals,
// a heart station, and a reroll post. This module is the PURE side of that system —
// deterministic layout + stock from (seed, floor), per-viewer slot status, and the one
// shared validation matrix both the buy command and every UI surface read, so the panel can
// never show BUY where the sim would refuse. All MUTATION (the buy itself) lives in
// world.ts beside the player it pays from.
//
// Ownership contract (explicit, never ambiguous):
//   - weapon pedestals are SHARED: one physical object each; the first validated buy
//     claims it and everyone else reads SOLD;
//   - the blessing pedestal and the heart station are FOR YOU: per-player instanced, one
//     buy each per player per shop — a teammate's purchase never depletes yours.

import type { Room } from "./dungeon.js";
import type { WeaponId, MysteryTwist } from "./types.js";
import { TILE } from "./types.js";
import type { PlayerId } from "./input.js";
import { Rng } from "./rng.js";
import { SHOP, SHOP_RARITY_PRICE_MULT, MYSTERY, LEGENDARY_MIN_FLOOR } from "./balance.js";
import { isBossFloor } from "./enemies.js";
import { PICKUP_WEAPONS, WEAPONS, rollWeaponRarity, rollMysteryTwist } from "./weapons.js";
import { MAX_OWNED_WEAPONS } from "./constants.js";
import { ITEMS, MAX_ITEM_LEVEL, itemLevelsOf, rollItemChoicesWith } from "./items.js";

// Every third depth is a secured relay niche — except boss floors, whose capstone owns
// the whole map (the old Dealer cadence, unchanged).
export function isShopFloor(floor: number): boolean {
  return floor % SHOP.floorInterval === 0 && !isBossFloor(floor);
}

export type ShopSlotKind = "weapon" | "blessing" | "heart" | "reroll";

export interface ShopSlot {
  id: number;              // stable per-shop slot id (wire identity + panel keying)
  kind: ShopSlotKind;
  isShared: boolean;       // shared: first buy claims; personal: per-player instanced
  weapon: WeaponId | null; // kind === "weapon"
  itemId: string | null;   // kind === "blessing"
  price: number;
  x: number; y: number;    // station world position (the pedestal the player walks to)
  soldTo: PlayerId | null; // shared slots: the claiming buyer (null = still for sale)
  buyers: PlayerId[];      // personal slots: players who already bought here this floor
  // Mystery pedestal: `weapon` holds the ACTUAL identity sim-side but the wire hides it
  // (see toShopWire) — every client shows "???" until a buy reveals it. The buy flips
  // isMystery false so the SOLD pedestal wears its true face. Both fields are always
  // present (false/null on ordinary slots) so the wire round-trip stays 1:1.
  isMystery: boolean;
  twist: MysteryTwist | null;
}

export interface ShopState {
  keeperX: number; keeperY: number; // Patch + stall anchor (back wall of the room)
  slots: ShopSlot[];
  rerollsUsed: number;
}

// How close a player must stand to a station for the highlight/interact affordance —
// and how far the authoritative buy validation allows (walking never buys; buying
// from across the map is rejected even by a tampered client).
export const SHOP_FOCUS_RANGE = 64;
export const SHOP_BUY_RANGE = 110;

// Seed stream salt for the shop's stock (own stream, like props/chests, so the shop can
// never perturb enemy/loot rolls). rerollsUsed folds in so each reroll is deterministic.
function shopRng(seed: number, floor: number, rerollsUsed: number): Rng {
  return new Rng((seed ^ 0x5a1e5b0b) + floor * 92821 + rerollsUsed * 31337);
}

// A pedestal weapon roll: rarity-tiered like every drop source, distinct from the ids
// already stalled, and preferring a gun outside `exclude` (weapons the whole party
// already owns — the same anti-repeat discipline the free-drop bag applies, so Patch
// never stalls a gun nobody needs while unowned guns remain). The candidate ladder:
// the rolled tier's fresh guns, the tier's unstalled guns, then any fresh/unstalled/
// pooled gun — a stall never fails to stock. The LAST weapon pedestal may roll as a
// MYSTERY (MYSTERY.minFloor+): identity hidden until purchase, gamble-weighted reveal
// pool. Fixed draw order (mystery decision, tier, pick, twist) keeps the stream
// reproducible per (seed, floor, rerolls, exclude).
interface ShopWeaponRoll {
  weapon: WeaponId;
  isMystery: boolean;
  twist: MysteryTwist | null;
}

function rollShopWeapon(rng: Rng, floor: number, taken: readonly (WeaponId | null)[], exclude: readonly WeaponId[], mayBeMystery: boolean): ShopWeaponRoll {
  const isMystery = mayBeMystery && floor >= MYSTERY.minFloor && rng.chance(MYSTERY.shopChance);
  const tier = rollWeaponRarity(() => rng.next(), floor, { isMystery });
  // Below the legendary floor gate an identified stall may never fall back into the
  // legendary tier either (the mystery gamble is the one sanctioned path past the gate).
  const pool = PICKUP_WEAPONS.filter((id) =>
    isMystery || floor >= LEGENDARY_MIN_FLOOR || WEAPONS[id].rarity !== "legendary");
  const inTier = pool.filter((id) => WEAPONS[id].rarity === tier);
  const ladder: ReadonlyArray<readonly WeaponId[]> = [
    inTier.filter((id) => !taken.includes(id) && !exclude.includes(id)),
    inTier.filter((id) => !taken.includes(id)),
    pool.filter((id) => !taken.includes(id) && !exclude.includes(id)),
    pool.filter((id) => !taken.includes(id)),
    pool,
  ];
  const candidates = ladder.find((set) => set.length > 0)!;
  return {
    weapon: rng.pick(candidates),
    isMystery,
    twist: isMystery ? rollMysteryTwist(() => rng.next()) : null,
  };
}

// Rarity-appropriate pricing: the ladder price is the COMMON price; rarer stock costs
// proportionally more. A mystery pedestal prices as a gamble — above common, well under
// a sure legendary.
export function shopWeaponPrice(basePrice: number, weapon: WeaponId, isMystery: boolean): number {
  if (isMystery) return Math.round(basePrice * MYSTERY.shopPriceMult);
  return Math.round(basePrice * SHOP_RARITY_PRICE_MULT[WEAPONS[weapon].rarity]);
}

// The blessing pedestal holds ONE item everyone sees identically (per-player validity is
// read at buy time: a buyer at Lv3 reads MAX LV). Weighted by rarity off the full pool.
function rollShopBlessing(rng: Rng): string {
  const picks = rollItemChoicesWith(1, () => rng.next());
  return picks.length > 0 ? picks[0].id : ITEMS[0].id;
}

// Build the shop for a floor's shop room. The layout is authored off the room's geometry
// (the generator guarantees the room is at least 11x8 of clean rect floor): Patch's stall
// on the back wall, the three item pedestals in a mid row with clear per-pedestal
// approach lanes, the heart station and reroll post flanking the stall. Deterministic
// from (seed, floor, exclude) — built once by the authority at floor load and shipped
// on the wire, so every client reads the identical shop. `exclude` is the guns the
// whole party already owns at build time (see rollDistinctShopWeapon).
export function buildShopState(seed: number, floor: number, room: Room, exclude: readonly WeaponId[] = []): ShopState {
  const rng = shopRng(seed, floor, 0);
  const cx = (room.cx + 0.5) * TILE;
  const backY = (room.y + 1.5) * TILE;
  const midY = (room.cy + 0.5) * TILE;
  const weapons: (WeaponId | null)[] = [];
  const slots: ShopSlot[] = [];
  for (let i = 0; i < SHOP.pedestalPrices.length; i++) {
    const isWeapon = i < SHOP.weaponPedestals;
    // Only the LAST weapon pedestal may be a mystery: one honest identified option always
    // stands beside the gamble.
    const roll = isWeapon ? rollShopWeapon(rng, floor, weapons, exclude, i === SHOP.weaponPedestals - 1) : null;
    if (roll) weapons.push(roll.weapon);
    slots.push({
      id: i,
      kind: isWeapon ? "weapon" : "blessing",
      isShared: isWeapon,
      weapon: roll ? roll.weapon : null,
      itemId: isWeapon ? null : rollShopBlessing(rng),
      price: roll ? shopWeaponPrice(SHOP.pedestalPrices[i], roll.weapon, roll.isMystery) : SHOP.pedestalPrices[i],
      x: cx + (i - (SHOP.pedestalPrices.length - 1) / 2) * TILE * 2,
      y: midY,
      soldTo: null,
      buyers: [],
      isMystery: roll ? roll.isMystery : false,
      twist: roll ? roll.twist : null,
    });
  }
  slots.push({
    id: slots.length, kind: "heart", isShared: false, weapon: null, itemId: null,
    price: SHOP.heartPrice, x: cx - TILE * 3, y: backY, soldTo: null, buyers: [],
    isMystery: false, twist: null,
  });
  slots.push({
    id: slots.length, kind: "reroll", isShared: true, weapon: null, itemId: null,
    price: SHOP.rerollCost, x: cx + TILE * 3, y: backY, soldTo: null, buyers: [],
    isMystery: false, twist: null,
  });
  return { keeperX: cx, keeperY: backY, slots, rerollsUsed: 0 };
}

// A pedestal the reroll may restock: an item pedestal nobody has committed coins to.
// Claimed weapons and personally-bought blessings stay — a reroll can never take back a
// purchase, anyone's.
function isRestockable(slot: ShopSlot): boolean {
  return (slot.kind === "weapon" || slot.kind === "blessing") && slot.soldTo === null && slot.buyers.length === 0;
}

export function hasRestockableSlots(shop: ShopState): boolean {
  return shop.slots.some(isRestockable);
}

// Reroll the unbought item pedestals in place (rerollsUsed must already be incremented by
// the caller — it keys the deterministic restock stream). Weapon rolls stay distinct from
// every pedestal weapon still standing, bought or not.
export function restockShop(shop: ShopState, seed: number, floor: number, exclude: readonly WeaponId[] = []): void {
  const rng = shopRng(seed, floor, shop.rerollsUsed);
  const keptWeapons = shop.slots.map((s) => (isRestockable(s) ? null : s.weapon));
  for (const slot of shop.slots) {
    if (!isRestockable(slot)) continue;
    if (slot.kind === "weapon") {
      const roll = rollShopWeapon(rng, floor, keptWeapons, exclude, slot.id === SHOP.weaponPedestals - 1);
      slot.weapon = roll.weapon;
      slot.isMystery = roll.isMystery;
      slot.twist = roll.twist;
      slot.price = shopWeaponPrice(SHOP.pedestalPrices[slot.id], roll.weapon, roll.isMystery);
      keptWeapons.push(slot.weapon);
    } else {
      slot.itemId = rollShopBlessing(rng);
    }
  }
}

// ---- the one status matrix (sim validation + every UI surface) ----

export type ShopSlotStatus =
  | "buy"        // affordable, valid — BUY · N COINS
  | "broke"      // NEED N MORE
  | "sold"       // shared: claimed by someone else; personal: this viewer already bought
  | "owned"      // weapon the viewer already owns (claimed-by-you resolves here too)
  | "full"       // weapon the viewer has no hotbar slot for (drop/swap first, then buy)
  | "maxLevel"   // blessing already at Lv3 for the viewer
  | "fullHealth" // heart at full HP
  | "exhausted"; // reroll limit spent, or nothing left to restock

export interface ShopViewer {
  pid: PlayerId;
  coins: number;
  hp: number;
  maxHp: number;
  ownedWeapons: readonly WeaponId[];
  ownedItemIds: readonly string[];
}

// The per-viewer status of one slot. This IS the buy validation (world.ts buys only on
// "buy"), so a state the panel shows and a purchase the sim accepts can never disagree —
// the only race left is a teammate's concurrent claim, which resolves to exactly one
// winner and an honest SOLD for the loser.
export function shopSlotStatusFor(shop: ShopState, slot: ShopSlot, viewer: ShopViewer): ShopSlotStatus {
  switch (slot.kind) {
    case "weapon": {
      if (slot.soldTo !== null && slot.soldTo !== viewer.pid) return "sold";
      // A mystery pedestal never reads OWNED — nobody knows what it is (the buy itself
      // rerolls an already-owned reveal into something the buyer lacks). Clients decode
      // it with weapon hidden, so skipping the check here keeps panel and sim agreeing.
      if (!slot.isMystery && slot.weapon !== null && viewer.ownedWeapons.includes(slot.weapon)) return "owned";
      // The hotbar cap gates the buy the same way it gates floor pickups: a full viewer
      // must free a slot (Q drop / swap) before the stall will take their coins.
      if (viewer.ownedWeapons.length >= MAX_OWNED_WEAPONS) return "full";
      break;
    }
    case "blessing": {
      if (slot.buyers.includes(viewer.pid)) return "sold";
      if (slot.itemId !== null && (itemLevelsOf(viewer.ownedItemIds).get(slot.itemId) ?? 0) >= MAX_ITEM_LEVEL) return "maxLevel";
      break;
    }
    case "heart": {
      if (slot.buyers.includes(viewer.pid)) return "sold";
      if (viewer.hp >= viewer.maxHp) return "fullHealth";
      break;
    }
    case "reroll": {
      if (shop.rerollsUsed >= SHOP.rerollLimit || !hasRestockableSlots(shop)) return "exhausted";
      break;
    }
  }
  return viewer.coins < slot.price ? "broke" : "buy";
}

export function shopViewerOf(p: { id: PlayerId; coins: number; hp: number; maxHp: number; ownedWeapons: readonly WeaponId[]; ownedItemIds: readonly string[] }): ShopViewer {
  return { pid: p.id, coins: p.coins, hp: p.hp, maxHp: p.maxHp, ownedWeapons: p.ownedWeapons, ownedItemIds: p.ownedItemIds };
}
