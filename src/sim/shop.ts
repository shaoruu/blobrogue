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
// The PREMIUM economy rides the same machinery — the approved vendor ecology
// (docs/specs/COIN_ECONOMY_AND_VENDORS.md), one stall per floor, mode on the wire:
//   - DEALER (every 3rd depth): the classic stations, a rarity ceiling that RISES by
//     region (Amberwild common → mid rare → F15+ a single guaranteed LEGENDARY slot on
//     the balancer's ladder), plus one premium slot from F6+;
//   - SPOILS (the floor after every boss): 1-3 premium items for the boss windfall —
//     never mid-fight, never on the boss floor itself. Where the cadence overlaps a
//     Dealer floor (6/21/…), the spoils slots stand ON the Dealer's stall;
//   - PREMIUM (milestone landings F9/14/19/24, then every 5 past F30): 2-3 seeded sinks
//     (max(2,P) in co-op) + the mythic capstone from F19;
//   - CLIMAX (F29, the F30 landing — always present): the GUARANTEED top-tier stock so
//     the save-for-it loop always pays off, plus the artifact devil deal and the mythic
//     tease. The one-power-buy lock does NOT apply here — the climax is the splurge.
//
// Ownership contract (explicit, never ambiguous):
//   - weapon pedestals are SHARED: one physical object each; the first validated buy
//     claims it and everyone else reads SOLD;
//   - the blessing pedestal and the heart station are FOR YOU: per-player instanced, one
//     buy each per player per shop — a teammate's purchase never depletes yours;
//   - premium sinks are FOR YOU too (personal + non-depleting in co-op), but one POWER
//     buy per shop per player outside the climax (buying one locks the rest — the
//     balancer's buy-rate discipline); the utility posts (reroll-everything, the amber
//     cache, the draught) stay outside the lock;
//   - the mythic capstone is ONE PER PARTY per shop: a shared claim, exactly like a
//     weapon pedestal — no 4× mythic stacking.

import type { Room } from "./dungeon.js";
import type { WeaponId, WeaponRarity, MysteryTwist } from "./types.js";
import { TILE } from "./types.js";
import type { PlayerId } from "./input.js";
import { Rng } from "./rng.js";
import {
  SHOP, SHOP_RARITY_PRICE_MULT, MYSTERY, LEGENDARY_MIN_FLOOR,
  PREMIUM, CAPS, isPremiumShopFloor, isSpoilsFloor, shopModeFor,
  premiumPriceAt, roundToPriceStep, clampPlayers,
} from "./balance.js";
import type { PremiumTier, ShopMode } from "./balance.js";
import { isBossFloor } from "./enemies.js";
import {
  WEAPONS,
  isSideChannelEligibleLoadout,
  rollWeaponRarity,
  rollMysteryTwist,
} from "./weapons.js";
import { MAX_OWNED_WEAPONS } from "./constants.js";
import {
  ITEMS, itemLevelsOf, itemMaxLevel, itemById, normalItemsForCatalog,
  rollItemChoicesWith, CORE_ITEM_IDS,
} from "./items.js";
import { rollWeaponOfferWithHistory } from "./weaponBag.js";
import {
  recordBlessingOffer,
  stablePlayerIdHash,
} from "./offerHistory.js";
import type {
  BlessingOfferHistory,
  WeaponOfferHistory,
} from "./offerHistory.js";
import {
  CURRENT_CONTENT_CATALOG_VERSION,
  contentCatalogFor,
} from "./contentCatalog.js";
import type { ContentCatalogVersion } from "./contentCatalog.js";

// The Dealer's cadence: every third depth — except boss floors (whose capstone owns the
// whole map) and premium landings (whose milestone stall displaces the waystation).
// Spoils floors that fall on the cadence (6/21/…) still count: the Dealer hosts them.
export function isShopFloor(floor: number): boolean {
  return floor % SHOP.floorInterval === 0 && !isBossFloor(floor) && !isPremiumShopFloor(floor);
}

// Any floor that hosts a stall room (the generator's one `shop` room): the Dealer
// cadence, a premium/climax landing, or a spoils floor.
export function hasShopRoomOnFloor(floor: number): boolean {
  return isShopFloor(floor) || isPremiumShopFloor(floor) || isSpoilsFloor(floor);
}

export type ShopSlotKind =
  | "weapon" | "blessing" | "heart" | "reroll"
  // The premium POWER sinks (personal; one power buy per shop outside the climax):
  | "mystery" | "legendary" | "rare_blessing" | "max_hp" | "full_heal"
  | "core_infusion" | "weapon_upgrade" | "revive_token" | "extra_slot"
  // The premium utilities (outside the lock):
  | "reroll_all" | "amber_cache" | "prospector"
  // The devil deal (climax only, paid in MAX HEARTS, cap 1/run):
  | "artifact"
  // The mythic capstone (one shared claim per party per shop; the kind IS the option):
  | "mythic_weapon" | "mythic_trio" | "mythic_amber";

// The premium sink kinds that participate in the one-power-buy-per-shop lock.
export const PREMIUM_LOCK_KINDS: ReadonlySet<ShopSlotKind> = new Set([
  "mystery", "legendary", "rare_blessing", "max_hp", "full_heal",
  "core_infusion", "weapon_upgrade", "revive_token", "extra_slot",
]);

// The event purchases (the designer's "big purchase" flourish + distinct glow): the
// climactic buys every client celebrates. Shared by the render layer and the buy FX.
export const PREMIUM_EVENT_KINDS: ReadonlySet<ShopSlotKind> = new Set([
  "legendary", "artifact", "mythic_weapon", "mythic_trio", "mythic_amber",
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
  itemId: string | null;   // kind === "blessing" | "rare_blessing" | "core_infusion"
  price: number;           // base price (successive-buy escalation applies per viewer/shop)
  x: number; y: number;    // station world position (the pedestal the player walks to)
  soldTo: PlayerId | null; // shared slots: the claiming buyer (null = still for sale)
  buyers: PlayerId[];      // personal slots: players who already bought here this floor
  // Mystery pedestal (kind "weapon"): `weapon` holds the ACTUAL identity sim-side but the
  // wire hides it (see toShopWire) — every client shows "???" until a buy reveals it. The
  // buy flips isMystery false so the SOLD pedestal wears its true face. The premium
  // "mystery" SINK is different machinery: personal, identity rolled per-buyer at the
  // buy, so `weapon` stays null there. Both fields are always present (false/null on
  // ordinary slots) so the wire round-trip stays 1:1.
  isMystery: boolean;
  twist: MysteryTwist | null;
}

export interface ShopState {
  catalogVersion: ContentCatalogVersion;
  mode: ShopMode;                   // which stall this floor hosts (wire: every client agrees)
  keeperX: number; keeperY: number; // Patch + stall anchor (back wall of the room)
  slots: ShopSlot[];
  viewerStock: Record<PlayerId, Record<number, ShopViewerStock>>;
  rerollsUsed: number; // Dealer reroll post AND the premium reroll-everything (one counter
                       // per shop — a stall only ever hosts one of the two)
}

export interface ShopViewerStock {
  weapon?: WeaponId | null;
  itemId?: string | null;
}

export function shopSlotForViewer(shop: ShopState, slot: ShopSlot, pid: PlayerId): ShopSlot {
  const stock = shop.viewerStock[pid]?.[slot.id];
  return stock === undefined ? slot : { ...slot, ...stock };
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

// ---- the Dealer's rising rarity ceiling (vendor ecology #1) ----
// Identified Dealer stock gets RICHER by region: Amberwild sells commons, the mid bands
// open the rare tier, and from the F15 band the SECOND pedestal becomes the guaranteed
// LEGENDARY showcase — priced on the balancer's legendary ladder, never the 12/18 one.
// The mystery gamble (pedestal 0 from F15, pedestal 1 below) stays the one sanctioned
// path past the ceiling.
export const DEALER_RARE_FROM_FLOOR = 6;
export const DEALER_LEGENDARY_FROM_FLOOR = 15;

export function dealerRarityCeiling(floor: number): WeaponRarity {
  return floor < DEALER_RARE_FROM_FLOOR ? "common" : "rare";
}

function dealerHasLegendarySlot(floor: number): boolean {
  return floor >= DEALER_LEGENDARY_FROM_FLOOR;
}

const RARITY_RANK: Record<WeaponRarity, number> = { common: 0, rare: 1, legendary: 2 };

// A pedestal weapon roll: rarity-tiered like every drop source (clamped to the region's
// ceiling — one rand() either way, so streams stay reproducible), distinct from the ids
// already stalled, and preferring a gun outside `exclude` (weapons the whole party
// already owns — the same anti-repeat discipline the free-drop bag applies, so Patch
// never stalls a gun nobody needs while unowned guns remain). The candidate ladder:
// the rolled tier's fresh guns, the tier's unstalled guns, then any fresh/unstalled/
// pooled gun — a stall never fails to stock. `forceTier` is the legendary showcase.
interface ShopWeaponRoll {
  weapon: WeaponId;
  isMystery: boolean;
  twist: MysteryTwist | null;
}

function rollShopWeapon(
  rng: Rng, floor: number, taken: readonly (WeaponId | null)[], exclude: readonly WeaponId[],
  mayBeMystery: boolean, catalogVersion: ContentCatalogVersion,
  forceTier?: WeaponRarity, history?: WeaponOfferHistory,
): ShopWeaponRoll {
  const isMystery = forceTier === undefined && mayBeMystery && floor >= MYSTERY.minFloor && rng.chance(MYSTERY.shopChance);
  const rolled = rollWeaponRarity(() => rng.next(), floor, { isMystery }, catalogVersion);
  const ceiling = dealerRarityCeiling(floor);
  const tier = forceTier ?? (isMystery || RARITY_RANK[rolled] <= RARITY_RANK[ceiling] ? rolled : ceiling);
  // Below the legendary floor gate an identified stall may never fall back into the
  // legendary tier either (the mystery gamble is the one sanctioned path past the gate).
  const pool = contentCatalogFor(catalogVersion).pickupWeapons.filter((id) =>
    isMystery || forceTier === "legendary" || floor >= LEGENDARY_MIN_FLOOR || WEAPONS[id].rarity !== "legendary");
  const inTier = pool.filter((id) => WEAPONS[id].rarity === tier);
  let weapon: WeaponId;
  if (history) {
    const blocked = new Set<WeaponId>(exclude);
    for (const id of taken) if (id !== null) blocked.add(id);
    weapon = rollWeaponOfferWithHistory(inTier, () => rng.next(), history, blocked);
  } else {
    const ladder: ReadonlyArray<readonly WeaponId[]> = [
      inTier.filter((id) => !taken.includes(id) && !exclude.includes(id)),
      inTier.filter((id) => !taken.includes(id)),
      pool.filter((id) => !taken.includes(id) && !exclude.includes(id)),
      pool.filter((id) => !taken.includes(id)),
      pool,
    ];
    const candidates = ladder.find((set) => set.length > 0)!;
    weapon = rng.pick(candidates);
  }
  return {
    weapon,
    isMystery,
    twist: isMystery ? rollMysteryTwist(() => rng.next()) : null,
  };
}

// Rarity-appropriate pricing: the ladder price is the COMMON price; rarer stock costs
// proportionally more. A mystery pedestal prices as a gamble — above common, well under
// a sure legendary. The legendary SHOWCASE never prices here — it rides the balancer's
// premium ladder (see buildShopState).
export function shopWeaponPrice(basePrice: number, weapon: WeaponId, isMystery: boolean): number {
  if (isMystery) return Math.round(basePrice * MYSTERY.shopPriceMult);
  return Math.round(basePrice * SHOP_RARITY_PRICE_MULT[WEAPONS[weapon].rarity]);
}

// The blessing pedestal holds ONE item everyone sees identically (per-player validity is
// read at buy time: a buyer at Lv3 reads MAX LV). Weighted by rarity off the full pool.
function rollShopBlessing(rng: Rng, catalogVersion: ContentCatalogVersion): string {
  const picks = rollItemChoicesWith(1, () => rng.next(), [], {
    eligibleItems: normalItemsForCatalog(catalogVersion),
  });
  return picks.length > 0 ? picks[0].id : ITEMS[0].id;
}

// The premium 1-of-1 rare blessing: rare pool only, viewer-independent stock.
function rollShopRareBlessing(rng: Rng, catalogVersion: ContentCatalogVersion): string {
  const picks = rollItemChoicesWith(1, () => rng.next(), [], {
    isRareOnly: true,
    eligibleItems: normalItemsForCatalog(catalogVersion),
  });
  return picks.length > 0 ? picks[0].id : ITEMS[0].id;
}

function makeSlot(id: number, kind: ShopSlotKind, isShared: boolean, price: number, x: number, y: number): ShopSlot {
  return {
    id, kind, isShared, weapon: null, itemId: null, price, x, y,
    soldTo: null, buyers: [], isMystery: false, twist: null,
  };
}

// Stock one premium slot's merchandise. Mystery/max_hp/full_heal/prospector/tokens carry
// none — their payload is the purchase itself (the premium mystery's identity is rolled
// per-buyer at the buy, deliberately not baked: each buyer draws their own fate).
// Identified legendaries obey the spec's "max 1/pool" through `taken`: within one stall
// the legendary showcase, the artifact, and the mythic arsenal never duplicate a gun.
function stockPremiumSlot(
  slot: ShopSlot,
  rng: Rng,
  exclude: readonly WeaponId[],
  taken: WeaponId[],
  catalogVersion: ContentCatalogVersion,
  history?: WeaponOfferHistory,
): void {
  if (slot.kind === "legendary" || slot.kind === "mythic_weapon" || slot.kind === "artifact") {
    const band = contentCatalogFor(catalogVersion).pickupWeapons
      .filter((id) => WEAPONS[id].rarity === "legendary");
    if (history) {
      slot.weapon = rollWeaponOfferWithHistory(
        band,
        () => rng.next(),
        history,
        new Set([...exclude, ...taken]),
      );
    } else {
      const unstalled = band.filter((id) => !taken.includes(id));
      const fresh = unstalled.filter((id) => !exclude.includes(id));
      const pool = fresh.length > 0 ? fresh : unstalled.length > 0 ? unstalled : band;
      slot.weapon = rng.pick(pool);
    }
    taken.push(slot.weapon);
  } else if (slot.kind === "rare_blessing") {
    slot.itemId = rollShopRareBlessing(rng, catalogVersion);
  } else if (slot.kind === "core_infusion") {
    slot.itemId = rng.pick(CORE_ITEM_IDS);
  }
}

const SINK_KIND_BY_TIER: Readonly<Partial<Record<PremiumTier, ShopSlotKind>>> = {
  mystery: "mystery", legendary: "legendary", rare_blessing: "rare_blessing",
  max_hp: "max_hp", full_heal: "full_heal", reroll_all: "reroll_all",
  amber_cache: "amber_cache", core_infusion: "core_infusion", prospector: "prospector",
  weapon_upgrade: "weapon_upgrade", revive_token: "revive_token", extra_slot: "extra_slot",
  artifact: "artifact",
};

// Depth-gate a stall's tier pool: legendary-grade offers join at the F15 band, the
// game-changer tokens at the F20 band (each also hard-capped 1/run at the buy).
function gateTiers(tiers: readonly PremiumTier[], floor: number): PremiumTier[] {
  return tiers.filter((tier) => {
    if (tier === "legendary" || tier === "weapon_upgrade") return floor >= PREMIUM.legendaryFromFloor;
    if (tier === "revive_token" || tier === "extra_slot") return floor >= PREMIUM.mythicFromFloor;
    return true;
  });
}

function pushSinkRow(
  slots: ShopSlot[], picked: readonly PremiumTier[], floor: number, rng: Rng,
  exclude: readonly WeaponId[], taken: WeaponId[], cx: number, y: number,
  catalogVersion: ContentCatalogVersion,
  sharedWeaponHistory?: WeaponOfferHistory,
): void {
  const start = slots.length;
  for (let i = 0; i < picked.length; i++) {
    const tier = picked[i];
    const slot = makeSlot(
      start + i, SINK_KIND_BY_TIER[tier]!, tier === "reroll_all",
      premiumPriceAt(tier, floor),
      cx + (i - (picked.length - 1) / 2) * TILE * 2, y,
    );
    stockPremiumSlot(
      slot, rng, exclude, taken, catalogVersion,
      slot.isShared ? sharedWeaponHistory : undefined,
    );
    slots.push(slot);
  }
}

function pushMythicSlot(
  slots: ShopSlot[],
  seed: number,
  floor: number,
  exclude: readonly WeaponId[],
  taken: WeaponId[],
  x: number,
  y: number,
  catalogVersion: ContentCatalogVersion,
  sharedWeaponHistory?: WeaponOfferHistory,
): void {
  // The mythic rides its own salted stream so the capstone's OPTION is identical across
  // party sizes for the same (seed, floor) — a mid-floor join can never shift what the
  // capstone IS. Its weapon stock additionally dedupes against the stall's other
  // legendaries (`taken`, the spec's max-1-per-pool), and — like all stock — every
  // client reads the authoritative build off the wire, so the stall is always one truth.
  const mythicRng = new Rng((seed ^ 0x3417c0de) + floor * 92821);
  const kind = mythicRng.pick(["mythic_weapon", "mythic_trio", "mythic_amber"] as const);
  const slot = makeSlot(slots.length, kind, true, premiumPriceAt("mythic", floor), x, y);
  stockPremiumSlot(slot, mythicRng, exclude, taken, catalogVersion, sharedWeaponHistory);
  slots.push(slot);
}

// The premium landing's stall: 2-3 seeded distinct sinks solo (max(2,P) in co-op — party
// size buys OPTIONS, never rarity/power; prices are P-invariant), plus the mythic
// capstone from the F20 band. The whole tier order is shuffled with a FIXED number of
// draws, so a bigger party's stock is always a strict superset of the identical solo
// stall for the same (seed, floor).
function buildPremiumShopState(
  rng: Rng,
  seed: number,
  floor: number,
  room: Room,
  exclude: readonly WeaponId[],
  players: number,
  catalogVersion: ContentCatalogVersion,
  sharedWeaponHistory?: WeaponOfferHistory,
): ShopState {
  const cx = (room.cx + 0.5) * TILE;
  const backY = (room.y + 1.5) * TILE;
  const midY = (room.cy + 0.5) * TILE;
  const tiers = gateTiers(PREMIUM.premiumTiers, floor);
  const count = Math.min(
    tiers.length,
    Math.max(PREMIUM.sinkSlotBase + (rng.chance(PREMIUM.sinkSlotBonusChance) ? 1 : 0), clampPlayers(players)),
  );
  for (let i = tiers.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const t = tiers[i]; tiers[i] = tiers[j]; tiers[j] = t;
  }
  const slots: ShopSlot[] = [];
  const taken: WeaponId[] = [];
  pushSinkRow(
    slots, tiers.slice(0, count), floor, rng, exclude, taken, cx, midY,
    catalogVersion, sharedWeaponHistory,
  );
  if (floor >= PREMIUM.mythicFromFloor) {
    pushMythicSlot(
      slots, seed, floor, exclude, taken, cx + TILE * 3, backY,
      catalogVersion, sharedWeaponHistory,
    );
  }
  return {
    catalogVersion, mode: "premium", keeperX: cx, keeperY: backY,
    slots, viewerStock: {}, rerollsUsed: 0,
  };
}

// The CLIMAX vendor (F29 — the F30 milestone's landing, always present): the designer's
// guaranteed top-tier stock in a fixed order, the artifact devil deal, and the mythic —
// at 600 vs a greedy pool of ~700 it doubles as the stall's almost-never-affordable
// TEASE for everyone else, greyed-but-visible so the goal forms floors earlier.
function buildClimaxShopState(
  seed: number,
  floor: number,
  room: Room,
  exclude: readonly WeaponId[],
  catalogVersion: ContentCatalogVersion,
  sharedWeaponHistory?: WeaponOfferHistory,
): ShopState {
  const rng = shopRng(seed, floor, 0);
  const cx = (room.cx + 0.5) * TILE;
  const backY = (room.y + 1.5) * TILE;
  const midY = (room.cy + 0.5) * TILE;
  const slots: ShopSlot[] = [];
  const taken: WeaponId[] = [];
  const row = PREMIUM.climaxTiers.slice(0, 5);
  const row2 = PREMIUM.climaxTiers.slice(5);
  pushSinkRow(
    slots, row, floor, rng, exclude, taken, cx, midY,
    catalogVersion, sharedWeaponHistory,
  );
  pushSinkRow(
    slots,
    row2,
    floor,
    rng,
    exclude,
    taken,
    cx - TILE * 2,
    (room.cy + 2.5) * TILE,
    catalogVersion,
    sharedWeaponHistory,
  );
  pushMythicSlot(
    slots, seed, floor, exclude, taken, cx + TILE * 3, backY,
    catalogVersion, sharedWeaponHistory,
  );
  return {
    catalogVersion, mode: "climax", keeperX: cx, keeperY: backY,
    slots, viewerStock: {}, rerollsUsed: 0,
  };
}

// The SPOILS row: 1-3 seeded premium items (the post-boss windfall's sink). Count and
// picks ride the stall stream; the row stands mid-room on a dedicated spoils floor, or
// fronts the Dealer's stall when the cadences overlap (6/21/…).
function spoilsPicks(rng: Rng, floor: number): PremiumTier[] {
  const tiers = gateTiers(PREMIUM.spoilsTiers, floor);
  const count = Math.min(tiers.length, PREMIUM.spoilsSlotBase + rng.int(0, PREMIUM.spoilsSlotMax - PREMIUM.spoilsSlotBase));
  const picked: PremiumTier[] = [];
  const pool = tiers.slice();
  for (let i = 0; i < count; i++) picked.push(pool.splice(Math.floor(rng.next() * pool.length), 1)[0]);
  return picked;
}

// Build the shop for a floor's shop room. The layout is authored off the room's geometry
// (the generator guarantees the room is at least 11x8 of clean rect floor): Patch's stall
// on the back wall, the item pedestals in a mid row with clear per-pedestal approach
// lanes, the utility stations flanking the stall. Deterministic from (seed, floor,
// exclude) — built once by the authority at floor load and shipped on the wire, so every
// client reads the identical shop. `exclude` is the guns the whole party already owns at
// build time; `players` is the SNAPSHOTTED encounter size (it grows the premium sink
// count only, and only upward from the identical solo prefix).
export function buildShopState(
  seed: number,
  floor: number,
  room: Room,
  exclude: readonly WeaponId[] = [],
  players = 1,
  sharedWeaponHistory?: WeaponOfferHistory,
  catalogVersion: ContentCatalogVersion = CURRENT_CONTENT_CATALOG_VERSION,
): ShopState {
  const mode = shopModeFor(floor);
  if (mode === "climax") {
    return buildClimaxShopState(
      seed, floor, room, exclude, catalogVersion, sharedWeaponHistory,
    );
  }
  const rng = shopRng(seed, floor, 0);
  if (mode === "premium") {
    return buildPremiumShopState(
      rng,
      seed,
      floor,
      room,
      exclude,
      players,
      catalogVersion,
      sharedWeaponHistory,
    );
  }
  const cx = (room.cx + 0.5) * TILE;
  const backY = (room.y + 1.5) * TILE;
  const midY = (room.cy + 0.5) * TILE;
  const slots: ShopSlot[] = [];
  const isDealer = isShopFloor(floor);
  if (isDealer) {
    const weapons: (WeaponId | null)[] = [];
    for (let i = 0; i < SHOP.pedestalPrices.length; i++) {
      const isWeapon = i < SHOP.weaponPedestals;
      // The rarity ceiling's showcase: from F15 the SECOND pedestal is the guaranteed
      // legendary (balancer-priced); the mystery gamble moves to the first. Below F15
      // the classic contract holds — only the LAST weapon pedestal may be a mystery, so
      // one honest identified option always stands beside the gamble.
      const isShowcase = isWeapon && dealerHasLegendarySlot(floor) && i === SHOP.weaponPedestals - 1;
      const mayBeMystery = isWeapon && (dealerHasLegendarySlot(floor) ? i === 0 : i === SHOP.weaponPedestals - 1);
      const roll = isWeapon
        ? rollShopWeapon(
          rng,
          floor,
          weapons,
          exclude,
          mayBeMystery,
          catalogVersion,
          isShowcase ? "legendary" : undefined,
          sharedWeaponHistory,
        )
        : null;
      if (roll) weapons.push(roll.weapon);
      slots.push({
        id: i,
        kind: isWeapon ? "weapon" : "blessing",
        isShared: isWeapon,
        weapon: roll ? roll.weapon : null,
        itemId: isWeapon ? null : rollShopBlessing(rng, catalogVersion),
        price: roll
          ? (isShowcase ? premiumPriceAt("legendary", floor) : shopWeaponPrice(SHOP.pedestalPrices[i], roll.weapon, roll.isMystery))
          : SHOP.pedestalPrices[i],
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
  }
  const taken: WeaponId[] = slots.map((s) => s.weapon).filter((id): id is WeaponId => id !== null);
  if (mode === "spoils") {
    // The spoils row: mid-room alone, or fronting the Dealer's stall on overlap floors.
    pushSinkRow(
      slots,
      spoilsPicks(rng, floor),
      floor,
      rng,
      exclude,
      taken,
      cx,
      isDealer ? (room.cy + 2.5) * TILE : midY,
      catalogVersion,
      sharedWeaponHistory,
    );
  } else if (floor >= PREMIUM.dealerSlotFromFloor) {
    // The Dealer's one premium slot (F6+): a small sink from the dealer pool, fronting
    // the stall. Drawn AFTER the classic stock so the staples' stream never shifts.
    const tier = rng.pick(gateTiers(PREMIUM.dealerTiers, floor));
    const slot = makeSlot(slots.length, SINK_KIND_BY_TIER[tier]!, false, premiumPriceAt(tier, floor), cx, (room.cy + 2.5) * TILE);
    stockPremiumSlot(
      slot, rng, exclude, taken, catalogVersion,
      slot.isShared ? sharedWeaponHistory : undefined,
    );
    slots.push(slot);
  }
  return {
    catalogVersion, mode, keeperX: cx, keeperY: backY,
    slots, viewerStock: {}, rerollsUsed: 0,
  };
}

export interface ShopStockViewerSource {
  id: PlayerId;
  offerIdentity: string;
  ownedWeapons: readonly WeaponId[];
  ownedItemIds: readonly string[];
  weaponOfferHistory: WeaponOfferHistory;
  blessingOfferHistory: BlessingOfferHistory;
  shopWeaponOfferOrdinal: number;
  shopBlessingOfferOrdinal: number;
}

function personalShopRng(
  seed: number,
  floor: number,
  rerollsUsed: number,
  slotId: number,
  playerId: PlayerId,
  ordinal: number,
  salt: number,
): Rng {
  return new Rng(
    (seed ^ 0x5a1e5b0b ^ salt)
    + floor * 92821
    + rerollsUsed * 31337
    + slotId * 977
    + stablePlayerIdHash(playerId)
    + ordinal * 0x6a09e667,
  );
}

function isPersonalWeaponStock(slot: ShopSlot): boolean {
  return !slot.isShared && (slot.kind === "legendary" || slot.kind === "artifact");
}

function isPersonalBlessingStock(slot: ShopSlot): boolean {
  return slot.kind === "blessing"
    || slot.kind === "rare_blessing"
    || slot.kind === "core_infusion";
}

export function stockShopForViewer(
  shop: ShopState,
  seed: number,
  floor: number,
  viewer: ShopStockViewerSource,
  refreshedSlotIds?: ReadonlySet<number>,
): void {
  const current = shop.viewerStock[viewer.id] ?? {};
  shop.viewerStock[viewer.id] = current;
  const targets = shop.slots
    .filter((slot) => isPersonalWeaponStock(slot) || isPersonalBlessingStock(slot))
    .filter((slot) => !slot.buyers.includes(viewer.id))
    .filter((slot) => refreshedSlotIds?.has(slot.id) ?? current[slot.id] === undefined)
    .sort((a, b) => a.id - b.id);
  const targetIds = new Set(targets.map((slot) => slot.id));
  const takenWeapons = new Set<WeaponId>();
  for (const slot of shop.slots) {
    if (targetIds.has(slot.id)) continue;
    const projected = shopSlotForViewer(shop, slot, viewer.id);
    if (projected.weapon !== null) takenWeapons.add(projected.weapon);
  }

  const excludedBlessings = new Set<string>();
  if (!isSideChannelEligibleLoadout(viewer.ownedWeapons)) {
    excludedBlessings.add("side_channel");
  }
  for (const slot of shop.slots) {
    if (targetIds.has(slot.id) || !isPersonalBlessingStock(slot)) continue;
    const itemId = shopSlotForViewer(shop, slot, viewer.id).itemId;
    if (itemId !== null) excludedBlessings.add(itemId);
  }
  for (const slot of targets) {
    if (isPersonalWeaponStock(slot)) {
      const rng = personalShopRng(
        seed,
        floor,
        shop.rerollsUsed,
        slot.id,
        viewer.offerIdentity,
        viewer.shopWeaponOfferOrdinal++,
        0x7765706e,
      );
      const blocked = new Set<WeaponId>(viewer.ownedWeapons);
      for (const id of takenWeapons) blocked.add(id);
      const weapon = rollWeaponOfferWithHistory(
        contentCatalogFor(shop.catalogVersion).pickupWeapons
          .filter((id) => WEAPONS[id].rarity === "legendary"),
        () => rng.next(),
        viewer.weaponOfferHistory,
        blocked,
      );
      current[slot.id] = { weapon };
      takenWeapons.add(weapon);
      continue;
    }

    const rng = personalShopRng(
      seed,
      floor,
      shop.rerollsUsed,
      slot.id,
      viewer.offerIdentity,
      viewer.shopBlessingOfferOrdinal++,
      0x626c7373,
    );
    const picks = rollItemChoicesWith(
      1,
      () => rng.next(),
      viewer.ownedItemIds,
      {
        isRareOnly: slot.kind === "rare_blessing",
        history: viewer.blessingOfferHistory,
        eligibleItems: slot.kind === "core_infusion"
          ? ITEMS.filter((item) => CORE_ITEM_IDS.includes(item.id))
          : normalItemsForCatalog(shop.catalogVersion),
        excludedIds: excludedBlessings,
        isPremiumAllowed: slot.kind === "core_infusion",
      },
    );
    const itemId = picks[0]?.id ?? null;
    current[slot.id] = { itemId };
    if (itemId !== null) {
      excludedBlessings.add(itemId);
      recordBlessingOffer(viewer.blessingOfferHistory, [itemId]);
    }
  }
}

// A pedestal the reroll may restock: an item pedestal nobody has committed coins to.
// Claimed weapons and personally-bought stock stay — a reroll can never take back a
// purchase, anyone's. The Dealer's cheap reroll post restocks the CLASSIC pedestals only
// (a premium sink never rerolls for 8 coins); the premium reroll-everything additionally
// restocks every unbought STOCKED premium slot except the mythic capstone.
function isPersonalStockRestockable(shop: ShopState, slot: ShopSlot): boolean {
  const viewers = Object.keys(shop.viewerStock);
  return viewers.length === 0
    ? slot.buyers.length === 0
    : viewers.some((pid) => !slot.buyers.includes(pid));
}

function isRestockable(shop: ShopState, slot: ShopSlot): boolean {
  if (slot.kind === "weapon") return slot.soldTo === null;
  return slot.kind === "blessing" && isPersonalStockRestockable(shop, slot);
}

function isPremiumRestockable(shop: ShopState, slot: ShopSlot): boolean {
  if (slot.soldTo !== null || !isPersonalStockRestockable(shop, slot)) return false;
  return slot.kind === "legendary" || slot.kind === "rare_blessing" || slot.kind === "core_infusion";
}

export function hasRestockableSlots(shop: ShopState, viewerId?: PlayerId): boolean {
  return shop.slots.some((slot) => {
    if (slot.kind === "weapon") return slot.soldTo === null;
    if (slot.kind !== "blessing") return false;
    return viewerId === undefined
      ? isPersonalStockRestockable(shop, slot)
      : !slot.buyers.includes(viewerId);
  });
}

// Reroll the unbought item pedestals in place (rerollsUsed must already be incremented by
// the caller — it keys the deterministic restock stream). Weapon rolls stay distinct from
// every pedestal weapon still standing, bought or not; the legendary showcase restocks
// WITHIN its tier. `all` is the premium reroll-everything.
export function restockShop(
  shop: ShopState,
  seed: number,
  floor: number,
  exclude: readonly WeaponId[] = [],
  isAll = false,
  sharedWeaponHistory?: WeaponOfferHistory,
): number[] {
  const rng = shopRng(seed, floor, shop.rerollsUsed);
  const keptWeapons = shop.slots.map((slot) => (isRestockable(shop, slot) ? null : slot.weapon));
  const restocked: number[] = [];
  for (const slot of shop.slots) {
    if (isRestockable(shop, slot)) {
      restocked.push(slot.id);
      if (slot.kind === "weapon") {
        const isShowcase = dealerHasLegendarySlot(floor) && slot.id === SHOP.weaponPedestals - 1;
        const mayBeMystery = dealerHasLegendarySlot(floor) ? slot.id === 0 : slot.id === SHOP.weaponPedestals - 1;
        const roll = rollShopWeapon(
          rng,
          floor,
          keptWeapons,
          exclude,
          mayBeMystery,
          shop.catalogVersion,
          isShowcase ? "legendary" : undefined,
          sharedWeaponHistory,
        );
        slot.weapon = roll.weapon;
        slot.isMystery = roll.isMystery;
        slot.twist = roll.twist;
        slot.price = isShowcase
          ? premiumPriceAt("legendary", floor)
          : shopWeaponPrice(SHOP.pedestalPrices[slot.id], roll.weapon, roll.isMystery);
        keptWeapons.push(slot.weapon);
      } else {
        slot.itemId = rollShopBlessing(rng, shop.catalogVersion);
      }
      continue;
    }
    if (isAll && isPremiumRestockable(shop, slot)) {
      restocked.push(slot.id);
      stockPremiumSlot(
        slot,
        rng,
        exclude,
        keptWeapons.filter((id): id is WeaponId => id !== null),
        shop.catalogVersion,
        slot.isShared ? sharedWeaponHistory : undefined,
      );
    }
  }
  return restocked;
}

// ---- the one status matrix (sim validation + every UI surface) ----

export type ShopSlotStatus =
  | "buy"        // affordable, valid — BUY · N COINS
  | "broke"      // NEED N MORE (visible-but-locked: the save-for-it read, never hidden)
  | "sold"       // shared: claimed by someone else; personal: this viewer already bought
  | "owned"      // weapon/token the viewer already owns (claimed-by-you resolves here too)
  | "full"       // weapon the viewer has no hotbar slot for (drop/swap first, then buy)
  | "maxLevel"   // blessing/core already at its level cap for the viewer
  | "fullHealth" // heart/full-heal at full HP
  | "exhausted"  // reroll limit spent, or nothing left to restock
  | "locked"     // premium sink: the viewer already made their one power buy this shop
  | "capped"     // +1 max heart at the +4 total cap; upgrade on a legendary-equipped gun
  | "inFight"    // full-heal / reroll-everything: living enemies too close to the buyer
  | "needHearts"; // artifact: not enough MAX hearts left to pay the tithe

export interface ShopViewer {
  pid: PlayerId;
  coins: number;
  hp: number;
  maxHp: number;
  equipped: WeaponId;         // the gun the upgrade station would reforge
  ownedWeapons: readonly WeaponId[];
  ownedItemIds: readonly string[];
  premiumHpBuys: number;      // successive +1-heart purchases this run (price escalation)
  hpBonusTotal: number;       // mods.maxHpBonus + premiumHpBuys — the shared +4 cap check
  isAmberCacheArmed: boolean; // the cache is a once-per-run switch
  reviveTokens: number;       // banked revive (cap 1)
  extraWeaponSlots: number;   // bought hotbar slots (cap 1)
  hpTithe: number;            // max hearts paid to the artifact (cap 1 deal per run)
  isInCombat: boolean;        // living enemies within the combat-lock radius of the viewer
}

// The viewer's hotbar capacity: the studio cap plus any bought extra slot.
export function weaponCapOf(viewer: { extraWeaponSlots: number }): number {
  return MAX_OWNED_WEAPONS + viewer.extraWeaponSlots;
}

// Whether the upgrade station has a legal target: the equipped gun's NEXT tier up.
export function upgradeTargetTier(equipped: WeaponId): WeaponRarity | null {
  const rarity = WEAPONS[equipped].rarity;
  if (rarity === "common") return "rare";
  if (rarity === "rare") return "legendary";
  return null;
}

// The viewer's EFFECTIVE price for a slot: base price plus the successive-buy escalation
// (+1 maxHp and each core level ×1.6 per prior buy; reroll-everything +50% per prior use
// this shop; the upgrade station prices by its TARGET tier). One function feeds the
// status check, every price the UI prints, and the authoritative deduction — they can
// never disagree. The artifact prices 0 COINS by construction (it is paid in max hearts).
export function shopSlotPriceFor(shop: ShopState, slot: ShopSlot, viewer: ShopViewer): number {
  if (slot.kind === "max_hp") return roundToPriceStep(slot.price * Math.pow(PREMIUM.hpPriceGrowth, viewer.premiumHpBuys));
  if (slot.kind === "core_infusion" && slot.itemId !== null) {
    const level = itemLevelsOf(viewer.ownedItemIds).get(slot.itemId) ?? 0;
    const dashMult = slot.itemId === "core_dash" ? PREMIUM.dashCorePriceMult : 1;
    return roundToPriceStep(slot.price * dashMult * Math.pow(PREMIUM.hpPriceGrowth, level));
  }
  if (slot.kind === "reroll_all") return roundToPriceStep(slot.price * Math.pow(PREMIUM.rerollPriceGrowth, shop.rerollsUsed));
  if (slot.kind === "weapon_upgrade") {
    return upgradeTargetTier(viewer.equipped) === "legendary"
      ? roundToPriceStep(slot.price * PREMIUM.upgradeLegendaryMult)
      : slot.price;
  }
  if (slot.kind === "artifact") return 0;
  return slot.price;
}

// Whether the viewer already spent their one premium POWER buy in this shop (the
// balancer's discount-lock: buying one sink locks the rest; utilities stay open). The
// CLIMAX vendor is deliberately lock-free — the endgame splurge is the point.
function hasSpentPremiumLock(shop: ShopState, viewer: ShopViewer): boolean {
  if (shop.mode === "climax") return false;
  return shop.slots.some((s) => PREMIUM_LOCK_KINDS.has(s.kind) && s.buyers.includes(viewer.pid));
}

// The per-viewer status of one slot. This IS the buy validation (world.ts buys only on
// "buy"), so a state the panel shows and a purchase the sim accepts can never disagree —
// the only race left is a teammate's concurrent claim, which resolves to exactly one
// winner and an honest SOLD for the loser. Order per slot: resolved states first
// (sold/owned/capped), then the lock, then live gates (combat), then affordability —
// an unaffordable premium item always renders VISIBLE with its price (broke), so the
// save-for-it goal can form floors before the wallet catches up.
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
      if (viewer.ownedWeapons.length >= weaponCapOf(viewer)) return "full";
      break;
    }
    case "blessing": {
      if (slot.buyers.includes(viewer.pid)) return "sold";
      if (slot.itemId === null) return "exhausted";
      const def = itemById(slot.itemId);
      if (def?.id === "side_channel" && !isSideChannelEligibleLoadout(viewer.ownedWeapons)) return "exhausted";
      if (def && (itemLevelsOf(viewer.ownedItemIds).get(def.id) ?? 0) >= itemMaxLevel(def)) return "maxLevel";
      break;
    }
    case "heart": {
      if (slot.buyers.includes(viewer.pid)) return "sold";
      if (viewer.hp >= viewer.maxHp) return "fullHealth";
      break;
    }
    case "reroll": {
      if (shop.rerollsUsed >= SHOP.rerollLimit || !hasRestockableSlots(shop, viewer.pid)) return "exhausted";
      break;
    }
    case "mystery": {
      if (slot.buyers.includes(viewer.pid)) return "sold";
      if (viewer.ownedWeapons.length >= weaponCapOf(viewer)) return "full";
      if (hasSpentPremiumLock(shop, viewer)) return "locked";
      break;
    }
    case "legendary": {
      if (slot.buyers.includes(viewer.pid)) return "sold";
      if (slot.weapon === null) return "exhausted";
      if (slot.weapon !== null && viewer.ownedWeapons.includes(slot.weapon)) return "owned";
      if (viewer.ownedWeapons.length >= weaponCapOf(viewer)) return "full";
      if (hasSpentPremiumLock(shop, viewer)) return "locked";
      break;
    }
    case "rare_blessing": {
      if (slot.buyers.includes(viewer.pid)) return "sold";
      if (slot.itemId === null) return "exhausted";
      const def = itemById(slot.itemId);
      if (def?.id === "side_channel" && !isSideChannelEligibleLoadout(viewer.ownedWeapons)) return "exhausted";
      if (def && (itemLevelsOf(viewer.ownedItemIds).get(def.id) ?? 0) >= itemMaxLevel(def)) return "maxLevel";
      if (hasSpentPremiumLock(shop, viewer)) return "locked";
      break;
    }
    case "max_hp": {
      if (slot.buyers.includes(viewer.pid)) return "sold";
      if (viewer.hpBonusTotal >= CAPS.maxHpBonus) return "capped";
      if (hasSpentPremiumLock(shop, viewer)) return "locked";
      break;
    }
    case "full_heal": {
      if (slot.buyers.includes(viewer.pid)) return "sold";
      if (viewer.hp >= viewer.maxHp) return "fullHealth";
      if (hasSpentPremiumLock(shop, viewer)) return "locked";
      if (viewer.isInCombat) return "inFight";
      break;
    }
    case "core_infusion": {
      if (slot.buyers.includes(viewer.pid)) return "sold";
      if (slot.itemId === null) return "exhausted";
      const def = itemById(slot.itemId ?? "");
      if (def && (itemLevelsOf(viewer.ownedItemIds).get(def.id) ?? 0) >= itemMaxLevel(def)) return "maxLevel";
      if (hasSpentPremiumLock(shop, viewer)) return "locked";
      break;
    }
    case "weapon_upgrade": {
      if (slot.buyers.includes(viewer.pid)) return "sold";
      if (upgradeTargetTier(viewer.equipped) === null) return "capped";
      if (hasSpentPremiumLock(shop, viewer)) return "locked";
      break;
    }
    case "revive_token": {
      if (slot.buyers.includes(viewer.pid) || viewer.reviveTokens > 0) return "owned";
      if (hasSpentPremiumLock(shop, viewer)) return "locked";
      break;
    }
    case "extra_slot": {
      if (slot.buyers.includes(viewer.pid) || viewer.extraWeaponSlots > 0) return "owned";
      if (hasSpentPremiumLock(shop, viewer)) return "locked";
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
    case "prospector": {
      if (slot.buyers.includes(viewer.pid)) return "sold";
      break;
    }
    case "artifact": {
      if (slot.buyers.includes(viewer.pid) || viewer.hpTithe > 0) return "owned";
      if (slot.weapon !== null && viewer.ownedWeapons.includes(slot.weapon)) return "owned";
      if (viewer.ownedWeapons.length >= weaponCapOf(viewer)) return "full";
      if (viewer.maxHp < PREMIUM.artifactHeartCost + PREMIUM.artifactMinHeartsLeft) return "needHearts";
      return "buy"; // paid in max hearts — the coin check below never applies
    }
    case "mythic_weapon": {
      if (slot.soldTo !== null && slot.soldTo !== viewer.pid) return "sold";
      if (slot.weapon !== null && viewer.ownedWeapons.includes(slot.weapon)) return "owned";
      if (viewer.ownedWeapons.length >= weaponCapOf(viewer)) return "full";
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
  weapon: WeaponId;
  ownedWeapons: readonly WeaponId[]; ownedItemIds: readonly string[];
  premiumHpBuys: number; isAmberCacheArmed: boolean;
  reviveTokens: number; extraWeaponSlots: number; hpTithe: number;
  mods: { maxHpBonus: number };
}

export function shopViewerOf(p: ShopViewerSource, isInCombat = false): ShopViewer {
  return {
    pid: p.id, coins: p.coins, hp: p.hp, maxHp: p.maxHp,
    equipped: p.weapon,
    ownedWeapons: p.ownedWeapons, ownedItemIds: p.ownedItemIds,
    premiumHpBuys: p.premiumHpBuys,
    hpBonusTotal: p.mods.maxHpBonus + p.premiumHpBuys,
    isAmberCacheArmed: p.isAmberCacheArmed,
    reviveTokens: p.reviveTokens,
    extraWeaponSlots: p.extraWeaponSlots,
    hpTithe: p.hpTithe,
    isInCombat,
  };
}
