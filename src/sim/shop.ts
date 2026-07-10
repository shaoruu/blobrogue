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
import type { WeaponId } from "./types.js";
import { TILE } from "./types.js";
import type { PlayerId } from "./input.js";
import { Rng } from "./rng.js";
import { SHOP } from "./balance.js";
import { isBossFloor } from "./enemies.js";
import { PICKUP_WEAPONS } from "./weapons.js";
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

// A pedestal weapon roll: distinct from the ids already stalled, and preferring a gun
// outside `exclude` (weapons the whole party already owns — the same anti-repeat
// discipline the free-drop bag applies, so Patch never stalls a gun nobody needs while
// unowned guns remain). Falls back to allowing an owned gun, then any gun, rather than
// ever failing to stock.
function rollDistinctShopWeapon(rng: Rng, taken: readonly (WeaponId | null)[], exclude: readonly WeaponId[]): WeaponId {
  const fresh = PICKUP_WEAPONS.filter((id) => !taken.includes(id) && !exclude.includes(id));
  if (fresh.length > 0) return rng.pick(fresh);
  const unstalled = PICKUP_WEAPONS.filter((id) => !taken.includes(id));
  return unstalled.length > 0 ? rng.pick(unstalled) : rng.pick(PICKUP_WEAPONS);
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
    const weapon = isWeapon ? rollDistinctShopWeapon(rng, weapons, exclude) : null;
    if (weapon) weapons.push(weapon);
    slots.push({
      id: i,
      kind: isWeapon ? "weapon" : "blessing",
      isShared: isWeapon,
      weapon,
      itemId: isWeapon ? null : rollShopBlessing(rng),
      price: SHOP.pedestalPrices[i],
      x: cx + (i - (SHOP.pedestalPrices.length - 1) / 2) * TILE * 2,
      y: midY,
      soldTo: null,
      buyers: [],
    });
  }
  slots.push({
    id: slots.length, kind: "heart", isShared: false, weapon: null, itemId: null,
    price: SHOP.heartPrice, x: cx - TILE * 3, y: backY, soldTo: null, buyers: [],
  });
  slots.push({
    id: slots.length, kind: "reroll", isShared: true, weapon: null, itemId: null,
    price: SHOP.rerollCost, x: cx + TILE * 3, y: backY, soldTo: null, buyers: [],
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
      slot.weapon = rollDistinctShopWeapon(rng, keptWeapons, exclude);
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
      if (slot.weapon !== null && viewer.ownedWeapons.includes(slot.weapon)) return "owned";
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
