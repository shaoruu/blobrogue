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
// The PREMIUM economy rides the same machinery: each milestone band's landing floor
// (F9/14/19/24/29, … — the F10/15/20/25/30 milestones land there because milestones are
// boss/gauntlet floors and shops NEVER generate on those) hosts a premium shop of
// depth-priced coin sinks instead of the Dealer's staples, and the Dealer itself carries
// ONE premium slot from F6+. Same room kind, same sanctuary contract, same buy command.
//
// Ownership contract (explicit, never ambiguous):
//   - weapon pedestals are SHARED: one physical object each; the first validated buy
//     claims it and everyone else reads SOLD;
//   - the blessing pedestal and the heart station are FOR YOU: per-player instanced, one
//     buy each per player per shop — a teammate's purchase never depletes yours;
//   - premium sinks are FOR YOU too (personal + non-depleting in co-op), but buying one
//     LOCKS the other premium sinks for that buyer this shop (the balancer's ≤1-premium-
//     per-shop discipline); the utility posts (reroll-everything) and the amber cache
//     stay outside the lock;
//   - the mythic capstone is ONE PER PARTY per shop: a shared claim, exactly like a
//     weapon pedestal — no 4× mythic stacking.

import type { Room } from "./dungeon.js";
import type { WeaponId } from "./types.js";
import { TILE } from "./types.js";
import type { PlayerId } from "./input.js";
import { Rng } from "./rng.js";
import { SHOP, PREMIUM, CAPS, isPremiumShopFloor, premiumPriceAt, roundToPriceStep, clampPlayers } from "./balance.js";
import type { PremiumTier } from "./balance.js";
import { isBossFloor } from "./enemies.js";
import { PICKUP_WEAPONS, rollWeaponOfRarity } from "./weapons.js";
import { ITEMS, MAX_ITEM_LEVEL, itemLevelsOf, rollItemChoicesWith } from "./items.js";

// Every third depth is a secured relay niche — except boss floors, whose capstone owns
// the whole map (the old Dealer cadence, unchanged), and premium floors, whose landing
// hosts the premium shop instead (one stall per floor, never two).
export function isShopFloor(floor: number): boolean {
  return floor % SHOP.floorInterval === 0 && !isBossFloor(floor) && !isPremiumShopFloor(floor);
}

// Any floor that hosts a stall room (the generator's one `shop` room): the Dealer cadence
// or a premium landing.
export function hasShopRoomOnFloor(floor: number): boolean {
  return isShopFloor(floor) || isPremiumShopFloor(floor);
}

export type ShopSlotKind =
  | "weapon" | "blessing" | "heart" | "reroll"
  // The premium sinks (personal, discount-locked to one power buy per shop):
  | "mystery" | "legendary" | "rare_blessing" | "max_hp" | "full_heal"
  // The premium utilities (outside the lock):
  | "reroll_all" | "amber_cache"
  // The mythic capstone (one shared claim per party per shop; the kind IS the option):
  | "mythic_weapon" | "mythic_trio" | "mythic_amber";

// The premium sink kinds that participate in the one-power-buy-per-shop lock.
const PREMIUM_LOCK_KINDS: ReadonlySet<ShopSlotKind> = new Set([
  "mystery", "legendary", "rare_blessing", "max_hp", "full_heal",
]);

export function isMythicKind(kind: ShopSlotKind): boolean {
  return kind === "mythic_weapon" || kind === "mythic_trio" || kind === "mythic_amber";
}

export function isPremiumKind(kind: ShopSlotKind): boolean {
  return kind !== "weapon" && kind !== "blessing" && kind !== "heart" && kind !== "reroll";
}

export interface ShopSlot {
  id: number;              // stable per-shop slot id (wire identity + panel keying)
  kind: ShopSlotKind;
  isShared: boolean;       // shared: first buy claims; personal: per-player instanced
  weapon: WeaponId | null; // kind === "weapon" | "legendary" | "mythic_weapon"
  itemId: string | null;   // kind === "blessing" | "rare_blessing"
  price: number;           // base price (successive-buy escalation applies per viewer/shop)
  x: number; y: number;    // station world position (the pedestal the player walks to)
  soldTo: PlayerId | null; // shared slots: the claiming buyer (null = still for sale)
  buyers: PlayerId[];      // personal slots: players who already bought here this floor
}

export interface ShopState {
  keeperX: number; keeperY: number; // Patch + stall anchor (back wall of the room)
  slots: ShopSlot[];
  rerollsUsed: number; // Dealer reroll post AND the premium reroll-everything (one counter
                       // per shop — a shop only ever hosts one of the two)
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

function rollDistinctShopWeapon(rng: Rng, taken: readonly (WeaponId | null)[]): WeaponId {
  let pick = rng.pick(PICKUP_WEAPONS);
  for (let i = 0; i < PICKUP_WEAPONS.length && taken.includes(pick); i++) pick = rng.pick(PICKUP_WEAPONS);
  return pick;
}

// The blessing pedestal holds ONE item everyone sees identically (per-player validity is
// read at buy time: a buyer at Lv3 reads MAX LV). Weighted by rarity off the full pool.
function rollShopBlessing(rng: Rng): string {
  const picks = rollItemChoicesWith(1, () => rng.next());
  return picks.length > 0 ? picks[0].id : ITEMS[0].id;
}

// The premium 1-of-1 rare blessing: rare pool only, viewer-independent stock.
function rollShopRareBlessing(rng: Rng): string {
  const picks = rollItemChoicesWith(1, () => rng.next(), [], { rareOnly: true });
  return picks.length > 0 ? picks[0].id : ITEMS[0].id;
}

function makeSlot(id: number, kind: ShopSlotKind, isShared: boolean, price: number, x: number, y: number): ShopSlot {
  return { id, kind, isShared, weapon: null, itemId: null, price, x, y, soldTo: null, buyers: [] };
}

// Stock one premium sink slot's merchandise (mystery/max_hp/full_heal/amber_cache carry
// none — their payload is the purchase itself; the mystery's weapon is deliberately
// UNKNOWN until bought).
function stockPremiumSlot(slot: ShopSlot, rng: Rng): void {
  if (slot.kind === "legendary" || slot.kind === "mythic_weapon") slot.weapon = rollWeaponOfRarity(rng, "legendary", []);
  else if (slot.kind === "rare_blessing") slot.itemId = rollShopRareBlessing(rng);
}

const SINK_KIND_BY_TIER: Readonly<Partial<Record<PremiumTier, ShopSlotKind>>> = {
  mystery: "mystery", legendary: "legendary", rare_blessing: "rare_blessing",
  max_hp: "max_hp", full_heal: "full_heal", reroll_all: "reroll_all", amber_cache: "amber_cache",
};

// The premium shop's stock: 2-3 seeded distinct sinks solo (max(2,P) in co-op — party
// size buys OPTIONS, never rarity/power; prices are P-invariant), plus the mythic
// capstone from the F20 band. The whole tier order is shuffled with a FIXED number of
// draws and the mythic rides its own salted stream, so a bigger party's stock (and the
// capstone) is always a strict superset of the identical solo stall for the same
// (seed, floor) — a mid-floor join can never shift what anyone already saw.
function buildPremiumShopState(rng: Rng, seed: number, floor: number, room: Room, players: number): ShopState {
  const cx = (room.cx + 0.5) * TILE;
  const backY = (room.y + 1.5) * TILE;
  const midY = (room.cy + 0.5) * TILE;
  const tiers: PremiumTier[] = ["mystery", "rare_blessing", "max_hp", "full_heal", "reroll_all", "amber_cache"];
  if (floor >= PREMIUM.legendaryFromFloor) tiers.splice(1, 0, "legendary");
  const count = Math.min(
    tiers.length,
    Math.max(PREMIUM.sinkSlotBase + (rng.chance(PREMIUM.sinkSlotBonusChance) ? 1 : 0), clampPlayers(players)),
  );
  for (let i = tiers.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const t = tiers[i]; tiers[i] = tiers[j]; tiers[j] = t;
  }
  const picked = tiers.slice(0, count);
  const slots: ShopSlot[] = [];
  for (let i = 0; i < picked.length; i++) {
    const tier = picked[i];
    const slot = makeSlot(
      slots.length, SINK_KIND_BY_TIER[tier]!, tier === "reroll_all",
      premiumPriceAt(tier, floor),
      cx + (i - (picked.length - 1) / 2) * TILE * 2, midY,
    );
    stockPremiumSlot(slot, rng);
    slots.push(slot);
  }
  if (floor >= PREMIUM.mythicFromFloor) {
    const mythicRng = new Rng((seed ^ 0x3417c0de) + floor * 92821);
    const kind = mythicRng.pick(["mythic_weapon", "mythic_trio", "mythic_amber"] as const);
    const slot = makeSlot(slots.length, kind, true, premiumPriceAt("mythic", floor), cx + TILE * 3, backY);
    stockPremiumSlot(slot, mythicRng);
    slots.push(slot);
  }
  return { keeperX: cx, keeperY: backY, slots, rerollsUsed: 0 };
}

// Build the shop for a floor's shop room. The layout is authored off the room's geometry
// (the generator guarantees the room is at least 11x8 of clean rect floor): Patch's stall
// on the back wall, the item pedestals in a mid row with clear per-pedestal approach
// lanes, the utility stations flanking the stall. Deterministic from (seed, floor) —
// every client and the server derive the identical shop. `players` is the encounter's
// snapshotted party size (floor build): it grows the PREMIUM sink count only, and only
// upward from the identical solo prefix, so stock never shifts under a mid-floor join.
export function buildShopState(seed: number, floor: number, room: Room, players = 1): ShopState {
  const rng = shopRng(seed, floor, 0);
  if (isPremiumShopFloor(floor)) return buildPremiumShopState(rng, seed, floor, room, players);
  const cx = (room.cx + 0.5) * TILE;
  const backY = (room.y + 1.5) * TILE;
  const midY = (room.cy + 0.5) * TILE;
  const weapons: (WeaponId | null)[] = [];
  const slots: ShopSlot[] = [];
  for (let i = 0; i < SHOP.pedestalPrices.length; i++) {
    const isWeapon = i < SHOP.weaponPedestals;
    const weapon = isWeapon ? rollDistinctShopWeapon(rng, weapons) : null;
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
  // The Dealer's premium slot (F6+): one depth-priced sink from the small-tier pool,
  // fronting the stall. Drawn AFTER the classic stock so the Dealer's staples are
  // byte-identical to the pre-premium ladder for the same (seed, floor).
  if (floor >= PREMIUM.dealerSlotFromFloor) {
    const tier = rng.pick(PREMIUM.dealerTiers);
    const slot = makeSlot(
      slots.length, SINK_KIND_BY_TIER[tier]!, false,
      premiumPriceAt(tier, floor), cx, (room.cy + 2.5) * TILE,
    );
    stockPremiumSlot(slot, rng);
    slots.push(slot);
  }
  return { keeperX: cx, keeperY: backY, slots, rerollsUsed: 0 };
}

// A pedestal the reroll may restock: an item pedestal nobody has committed coins to.
// Claimed weapons and personally-bought stock stay — a reroll can never take back a
// purchase, anyone's. The Dealer's cheap reroll post restocks the CLASSIC pedestals only
// (a premium sink never rerolls for 8 coins); the premium reroll-everything restocks
// every unbought stocked slot except the mythic capstone (the capstone is the capstone).
function isRestockable(slot: ShopSlot): boolean {
  return (slot.kind === "weapon" || slot.kind === "blessing") && slot.soldTo === null && slot.buyers.length === 0;
}

function isPremiumRestockable(slot: ShopSlot): boolean {
  if (slot.soldTo !== null || slot.buyers.length > 0) return false;
  return slot.kind === "legendary" || slot.kind === "rare_blessing";
}

export function hasRestockableSlots(shop: ShopState): boolean {
  return shop.slots.some(isRestockable);
}

// Reroll the unbought item pedestals in place (rerollsUsed must already be incremented by
// the caller — it keys the deterministic restock stream). Weapon rolls stay distinct from
// every pedestal weapon still standing, bought or not. `all` is the premium
// reroll-everything: it additionally restocks the unbought premium sinks' merchandise.
export function restockShop(shop: ShopState, seed: number, floor: number, all = false): void {
  const rng = shopRng(seed, floor, shop.rerollsUsed);
  const keptWeapons = shop.slots.map((s) => (isRestockable(s) ? null : s.weapon));
  for (const slot of shop.slots) {
    if (isRestockable(slot)) {
      if (slot.kind === "weapon") {
        slot.weapon = rollDistinctShopWeapon(rng, keptWeapons);
        keptWeapons.push(slot.weapon);
      } else {
        slot.itemId = rollShopBlessing(rng);
      }
      continue;
    }
    if (all && isPremiumRestockable(slot)) stockPremiumSlot(slot, rng);
  }
}

// ---- the one status matrix (sim validation + every UI surface) ----

export type ShopSlotStatus =
  | "buy"        // affordable, valid — BUY · N COINS
  | "broke"      // NEED N MORE
  | "sold"       // shared: claimed by someone else; personal: this viewer already bought
  | "owned"      // weapon the viewer already owns (claimed-by-you resolves here too)
  | "maxLevel"   // blessing already at Lv3 for the viewer
  | "fullHealth" // heart/full-heal at full HP
  | "exhausted"  // reroll limit spent, or nothing left to restock
  | "locked"     // premium sink: the viewer already made their one power buy this shop
  | "capped"     // +1 max heart: the +4 total bonus (incl. Vitality) is already reached
  | "inFight";   // full-heal / reroll-everything: living enemies too close to the buyer

export interface ShopViewer {
  pid: PlayerId;
  coins: number;
  hp: number;
  maxHp: number;
  ownedWeapons: readonly WeaponId[];
  ownedItemIds: readonly string[];
  premiumHpBuys: number;      // successive +1-heart purchases this run (price escalation)
  hpBonusTotal: number;       // mods.maxHpBonus + premiumHpBuys — the shared +4 cap check
  isAmberCacheArmed: boolean; // the cache is a once-per-run switch
  isInCombat: boolean;        // living enemies within the combat-lock radius of the viewer
}

// The viewer's EFFECTIVE price for a slot: base price plus the successive-buy escalation
// (+1 maxHp ×1.6 per prior premium heart, run-wide; reroll-everything +50% per prior use
// this shop). One function feeds the status check, every price the UI prints, and the
// authoritative deduction — they can never disagree.
export function shopSlotPriceFor(shop: ShopState, slot: ShopSlot, viewer: ShopViewer): number {
  if (slot.kind === "max_hp") return roundToPriceStep(slot.price * Math.pow(PREMIUM.hpPriceGrowth, viewer.premiumHpBuys));
  if (slot.kind === "reroll_all") return roundToPriceStep(slot.price * Math.pow(PREMIUM.rerollPriceGrowth, shop.rerollsUsed));
  return slot.price;
}

// Whether the viewer already spent their one premium POWER buy in this shop (the
// balancer's discount-lock: buying one sink locks the rest; utilities stay open).
function hasSpentPremiumLock(shop: ShopState, viewer: ShopViewer): boolean {
  return shop.slots.some((s) => PREMIUM_LOCK_KINDS.has(s.kind) && s.buyers.includes(viewer.pid));
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
    case "mystery": {
      if (slot.buyers.includes(viewer.pid)) return "sold";
      if (hasSpentPremiumLock(shop, viewer)) return "locked";
      if (PICKUP_WEAPONS.every((id) => viewer.ownedWeapons.includes(id))) return "owned";
      break;
    }
    case "legendary": {
      if (slot.buyers.includes(viewer.pid)) return "sold";
      if (hasSpentPremiumLock(shop, viewer)) return "locked";
      if (slot.weapon !== null && viewer.ownedWeapons.includes(slot.weapon)) return "owned";
      break;
    }
    case "rare_blessing": {
      if (slot.buyers.includes(viewer.pid)) return "sold";
      if (hasSpentPremiumLock(shop, viewer)) return "locked";
      if (slot.itemId !== null && (itemLevelsOf(viewer.ownedItemIds).get(slot.itemId) ?? 0) >= MAX_ITEM_LEVEL) return "maxLevel";
      break;
    }
    case "max_hp": {
      if (slot.buyers.includes(viewer.pid)) return "sold";
      if (hasSpentPremiumLock(shop, viewer)) return "locked";
      if (viewer.hpBonusTotal >= CAPS.maxHpBonus) return "capped";
      break;
    }
    case "full_heal": {
      if (slot.buyers.includes(viewer.pid)) return "sold";
      if (hasSpentPremiumLock(shop, viewer)) return "locked";
      if (viewer.hp >= viewer.maxHp) return "fullHealth";
      if (viewer.isInCombat) return "inFight";
      break;
    }
    case "reroll_all": {
      if (viewer.isInCombat) return "inFight";
      break;
    }
    case "amber_cache": {
      if (slot.buyers.includes(viewer.pid) || viewer.isAmberCacheArmed) return "owned";
      break;
    }
    case "mythic_weapon": {
      if (slot.soldTo !== null && slot.soldTo !== viewer.pid) return "sold";
      if (slot.weapon !== null && viewer.ownedWeapons.includes(slot.weapon)) return "owned";
      break;
    }
    case "mythic_trio":
    case "mythic_amber": {
      if (slot.soldTo !== null) return "sold";
      break;
    }
  }
  return viewer.coins < shopSlotPriceFor(shop, slot, viewer) ? "broke" : "buy";
}

export interface ShopViewerSource {
  id: PlayerId; coins: number; hp: number; maxHp: number;
  ownedWeapons: readonly WeaponId[]; ownedItemIds: readonly string[];
  premiumHpBuys: number; isAmberCacheArmed: boolean;
  mods: { maxHpBonus: number };
}

export function shopViewerOf(p: ShopViewerSource, isInCombat = false): ShopViewer {
  return {
    pid: p.id, coins: p.coins, hp: p.hp, maxHp: p.maxHp,
    ownedWeapons: p.ownedWeapons, ownedItemIds: p.ownedItemIds,
    premiumHpBuys: p.premiumHpBuys,
    hpBonusTotal: p.mods.maxHpBonus + p.premiumHpBuys,
    isAmberCacheArmed: p.isAmberCacheArmed,
    isInCombat,
  };
}
