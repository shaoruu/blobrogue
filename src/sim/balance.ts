// The versioned BalanceDef — every gameplay-balance number from
// docs/specs/blobrogue_BALANCE_FINAL_impl.md, reconciled against the studio-wide
// docs/specs/blobrogue_STUDIO_BALANCE_GATE.md (Standard baseline), lives HERE, in one
// deterministic module the pure sim consumes (LocalTransport solo and the authoritative
// server run the same data).
// Design rule (spec §0): difficulty comes from techniques, telegraphed commitments, room
// composition, movement and scarcity — HP is a calibration output, never the difficulty lever.
//
// Engine-mechanical constants that are not balance (pathfinding cadence, knockback physics,
// status-system plumbing) stay in constants.ts.

import type { EnemyKind, WeaponId, WeaponRarity } from "./types.js";

export const BALANCE_VERSION = 4;

// ---- §1 player constants ----

export const PLAYER = {
  baseMaxHp: 6,
  moveSpeed: 200,
  postHitInvuln: 0.80,
  dashCooldown: 0.70,
  dashActive: 0.16,
  dashSpeed: 620,
  // Non-refreshing, non-overlapping dash iframe — a SEPARATE protection from the post-hit
  // invuln (0.80s), which must never extend it. At Second Wind Lv3 (CD 0.35s) the
  // theoretical uptime is 0.18/0.35 = 51.4%: excellent mobility, not immunity.
  dashIframe: 0.18,
} as const;

// ---- §2 sustain / heart economy (ambient healing roughly halved) ----

export const SUSTAIN = {
  enemyHeartDrop: 0.06,   // was 0.12
  crateHeartDrop: 0.06,   // was 0.15
  woodChestHeart: 0.15,   // was 0.20
  woodChestWeapon: 0.07,
  // The ambient MYSTERY band (unidentified weapon, MYSTERY.minFloor+ only): stacked after
  // the identified-weapon band, so hearts/weapons keep their exact rates.
  woodChestMystery: 0.04,
  descentHeal: 0,         // was +2 — the descent is pacing, not a free mistake reset
  fullHpHeartCoins: 2,    // a loose heart at full HP is consumed and converts to coins
  // Recovery pity: after this many consecutive non-boss floors that generated zero hearts
  // while the party entered below 50% HP, force one heart into the next wood chest.
  pityFloors: 2,
  pityLowHpFrac: 0.5,
} as const;

// The Dealer is Patch's authored SHOP ROOM (owner call: no loose priced pickups, no
// touch-to-buy — see docs/specs/blobrogue_STUDIO_COHERENCE_GATE.md "Dealer hook"). Every
// third depth (3/6/9, … — never a boss floor) is a secured relay niche hosting a dedicated
// safe `shop` room: Patch's stall, THREE item pedestals on the unchanged 12/18/24 ladder
// (slots 0-1 physical weapons, slot 2 a blessing), a heart station, and a reroll post.
// Every purchase is an EXPLICIT validated buy command (interact -> panel -> BUY) — walking
// over a station never spends a coin.
// Ownership is explicit, never ambiguous (studio UX call, supersedes the old §4
// personal-stall rule for the shop room):
//   - physical weapon pedestals are SHARED — one real object, first buy claims it (SOLD);
//   - the blessing pedestal and heart station are FOR YOU — per-player instanced, one buy
//     each per player per shop, so a teammate's purchase never depletes yours.
// Party scaling rides the personal slots (P players = P blessing + P heart opportunities,
// matching the old P-heart stock) — quantity buys options, never rarity (§4).
export const SHOP = {
  floorInterval: 3,
  pedestalPrices: [12, 18, 24] as readonly number[], // by pedestal slot (2 weapons, then the blessing)
  weaponPedestals: 2,
  heartPrice: 6,
  heartHeal: 1, // +1 HP, never a full heal (§2)
  rerollCost: 8,
  rerollLimit: 2, // per shop; restocks only pedestals nobody has bought
} as const;

// ---- the depth-scaling PREMIUM coin economy (the balancer's late-game sink ladder) ----
// Late-game coins need big things to chase ("need some super expensive stuff as we go
// on"), realized as the approved vendor ecology (docs/specs/COIN_ECONOMY_AND_VENDORS.md):
//   1. the Dealer's RARITY CEILING rises by region (Amberwild common → mid rare → late a
//      single guaranteed LEGENDARY slot, priced on the balancer's ladder);
//   2. the SPOILS vendor lands the floor after every boss (1-3 premium items — the
//      natural fat-wallet moment, never mid-fight, never on the boss floor itself);
//   3. the CLIMAX vendor holds the F30 milestone's landing (F29, always present) with
//      the guaranteed top-tier stock, so the save-for-it loop always pays off;
//   plus the premium shops on the other milestone landings and the Dealer's one premium
//   slot from F6+. Coins stay the TEMPORARY run currency — Amber is the persistent one —
//   and nothing here buys past a boss mechanic: no invulnerability, no phase skip, and
//   every purchased power obeys the existing caps (weapon envelope, blessing raw caps,
//   maxHp +4 total, permanent Foundation untouched by coins). Premium buys are a FASTER
//   route to a cap, never a higher cap.
//
// Placement: the balancer's milestones are F10/15/20/25/30, but those are exactly the
// boss/gauntlet floors and the hard rule is NEVER a boss-floor shop — so each milestone's
// premium shop is its LANDING, the floor before the capstone (F9/14/19/24/29, continuing
// every 5 past F30).

export type PremiumTier =
  | "mystery"        // unidentified gamble — the shared mystery roll, depth-boosted odds
  | "legendary"      // known, guaranteed top rarity (identity/mechanic, inside the envelope)
  | "rare_blessing"  // premium 1-of-1 rare (respects Lv1-3 + the raw caps)
  | "max_hp"         // +1 max heart, run-only, +4 TOTAL cap shared with Vitality
  | "full_heal"      // Panacea: to full, no protection frames, never past maxHp
  | "reroll_all"     // rerolls all unbought stock + the buyer's next blessing offer
  | "amber_cache"    // the ONLY route from leftover coins toward permanence (a trickle)
  | "core_infusion"  // single-stat bump toward a raw cap (a premium-only leveled core)
  | "prospector"     // Prospector's Draught: coins ×2 for the REST of this floor
  | "weapon_upgrade" // reforge the EQUIPPED gun one rarity tier up (loyalty, priced by target)
  | "revive_token"   // one banked get-back-up (cap 1; steep — see the difficulty flag)
  | "extra_slot"     // +1 hotbar slot past MAX_OWNED_WEAPONS (cap 1/run, very expensive)
  | "artifact"       // the devil deal: a legendary paid in MAX HEARTS, cap 1/run, climax only
  | "mythic";        // the F20+ capstone: one shared claim per party per shop

// The stall a floor hosts — one per floor, never two (the wire carries it so every
// client agrees on the room's read).
export type ShopMode = "dealer" | "premium" | "spoils" | "climax";

export const PREMIUM = {
  firstShopFloor: 9,        // the F10 milestone's landing (never a boss/gauntlet floor)
  shopEvery: 5,
  dealerSlotFromFloor: 6,   // the Dealer carries one premium slot from F6+
  legendaryFromFloor: 14,   // legendary-grade sinks join at the F15 milestone's landing
  mythicFromFloor: 19,      // the mythic capstone joins at the F20 milestone's landing
  climaxFloor: 29,          // the guaranteed pre-final-boss vendor (the F30 landing)
  // The balancer's EXACT anchor ladders: price at each milestone's premium shop, one
  // entry per band starting at the tier's intro. Between anchors (the Dealer slot, the
  // spoils vendors) and past the last one, price = anchor × depthMult with
  // depthMult = 1 + 0.09 × (floor − anchorFloor), rounded to 5. Tiers the balancer left
  // unanchored (cache/cores/draught/upgrade/token/slot) are authored under the same
  // curve and marked below.
  anchors: {
    mystery: [45, 70, 100, 135, 170],
    legendary: [130, 190, 260, 330],
    rare_blessing: [40, 60, 85, 110, 140],
    max_hp: [55, 80, 110, 145, 180],
    full_heal: [30, 45, 60, 80, 100],
    reroll_all: [35, 55, 75, 100, 125],
    amber_cache: [25, 40, 55, 75, 95],       // authored: under full_heal
    core_infusion: [50, 70, 95, 120, 150],   // authored: between rare_blessing and max_hp
    prospector: [20, 30, 45, 60, 75],        // authored: the cheap save-loop feeder
    weapon_upgrade: [45, 65, 90, 115, 145],  // authored: common→rare; ×1.8 for →legendary
    revive_token: [110, 150, 200, 250, 310], // authored STEEP (the difficulty flag below)
    extra_slot: [150, 200, 260, 330, 410],   // authored: very expensive, cap 1/run
    artifact: [0, 0, 0, 0, 0],               // paid in MAX HEARTS, never coins (see below)
    mythic: [300, 430, 600],
  } as Record<PremiumTier, readonly number[]>,
  depthRatePerFloor: 0.09,
  priceStep: 5,
  // Successive-buy escalation (hoarding needs a real target): +1 maxHp and each core
  // infusion level cost ×1.6 per prior buy of the same thing (run-wide);
  // reroll-everything costs +50% per prior use in the SAME shop.
  hpPriceGrowth: 1.6,
  rerollPriceGrowth: 1.5,
  // The dash-charge core prices above the stat cores (skill-expressive, cap 1).
  dashCorePriceMult: 1.5,
  // The weapon upgrade's →legendary target multiplier (loyalty still undercuts buying a
  // legendary outright: ×1.8 of the upgrade ladder ≈ 78% of the legendary anchor).
  upgradeLegendaryMult: 1.8,
  // The artifact devil deal: a legendary paid in MAX HEARTS (1-2 containers per the
  // spec; authored 2 — a real trade), requiring at least 2 max hearts left after paying.
  // Cap 1/run. Climax vendor only.
  artifactHeartCost: 2,
  artifactMinHeartsLeft: 2,
  // Amber conversion (the amber_cache purchase arms it): ≤ +2 Amber per 100 unspent coins
  // at run end, capped +5 per run. The mythic windfall option banks +8 outright. Coins
  // NEVER buy permanent power directly — Amber is the only permanent currency.
  amberPerHundredCoins: 2,
  amberRunCap: 5,
  mythicAmber: 8,
  // Prospector's Draught: collected-coin value multiplier for the rest of the floor.
  prospectorMult: 2,
  // Full-heal / reroll-everything are disabled mid-fight: any living enemy within this
  // radius of the buyer reads the station as IN COMBAT (both are also structurally never
  // on boss floors — no stall ever generates there).
  combatLockRadius: 300,
  // Premium sink stock: 2-3 seeded distinct sinks solo, growing to max(2, P) distinct in
  // co-op (party size buys OPTIONS, never rarity/power — prices are P-invariant).
  sinkSlotBase: 2,
  sinkSlotBonusChance: 0.5,
  // Spoils vendor stock: 1-3 seeded premium items (the boss windfall's sink).
  spoilsSlotBase: 1,
  spoilsSlotMax: 3,
  // The tier pools per stall. Draw order is fixed; deeper tiers gate by floor
  // (legendary/upgrade from the F15 band, revive/slot from the F20 band).
  dealerTiers: ["mystery", "rare_blessing", "max_hp", "full_heal", "prospector"] as readonly PremiumTier[],
  spoilsTiers: ["mystery", "rare_blessing", "max_hp", "full_heal", "prospector", "core_infusion", "legendary", "weapon_upgrade", "revive_token"] as readonly PremiumTier[],
  premiumTiers: ["mystery", "rare_blessing", "max_hp", "full_heal", "reroll_all", "amber_cache", "core_infusion", "prospector", "legendary", "weapon_upgrade", "revive_token", "extra_slot"] as readonly PremiumTier[],
  // The climax vendor's GUARANTEED stock (the designer's list + the cache and the mythic
  // tease), in pedestal order. Always present, never seeded away.
  climaxTiers: ["max_hp", "revive_token", "legendary", "mystery", "full_heal", "weapon_upgrade", "amber_cache", "artifact"] as readonly PremiumTier[],
  // Premium mystery slots gamble on the SHARED mystery roll (weapons.ts rollWeaponRarity)
  // with a legendary weight that climbs per milestone band — a deep mystery is a
  // genuinely better gamble (the base pedestal gamble stays MYSTERY.legendaryWeight).
  mysteryLegendaryWeightByBand: [2, 3, 4, 5, 6] as readonly number[],
} as const;

// DIFFICULTY FLAG (the designer's "keep it from flattening difficulty"): the revive
// token is deliberately priced at the top of the non-mythic ladder, capped at ONE banked
// at a time, revives at the standard REVIVE.hp with the standard non-stacking protection
// window, and never prevents the wipe clock in co-op — it is a second chance, not a
// second health bar. If live play still reads it as flattening, the balancer's next
// levers are (in order): raise the ladder, gate it to the climax vendor only, or convert
// it to co-op-only stock.

// Premium shop cadence: F9/14/19/24/29, … — every milestone's landing floor. The
// arithmetic itself guarantees "never a boss/gauntlet floor" (9 + 5k ≡ 4 mod 5, and
// boss/gauntlet floors are ≡ 0 mod 5).
export function isPremiumShopFloor(floor: number): boolean {
  return floor >= PREMIUM.firstShopFloor && (floor - PREMIUM.firstShopFloor) % PREMIUM.shopEvery === 0;
}

// The spoils vendor's cadence: the floor AFTER every boss/gauntlet capstone (6/11/16/
// 21/26/31, …) — it catches the boss coin windfall without ever selling mid-fight or on
// the boss floor itself.
export function isSpoilsFloor(floor: number): boolean {
  return floor > 1 && (floor - 1) % 5 === 0;
}

// Which stall a floor hosts (one per floor): the climax vendor owns its fixed landing,
// milestone landings host premium shops, post-boss floors host the spoils vendor, and
// the Dealer keeps every third depth in between. Spoils and premium can never collide
// (mod-5 arithmetic); a spoils floor that is also a Dealer floor (6/21/36, …) hosts the
// spoils stall ON the Dealer's stall — the classic stations plus the spoils slots.
export function shopModeFor(floor: number): ShopMode {
  if (floor === PREMIUM.climaxFloor) return "climax";
  if (isPremiumShopFloor(floor)) return "premium";
  if (isSpoilsFloor(floor)) return "spoils";
  return "dealer";
}

export function roundToPriceStep(v: number): number {
  return Math.max(PREMIUM.priceStep, Math.round(v / PREMIUM.priceStep) * PREMIUM.priceStep);
}

function premiumAnchorStart(tier: PremiumTier): number {
  if (tier === "legendary") return PREMIUM.legendaryFromFloor;
  if (tier === "mythic") return PREMIUM.mythicFromFloor;
  return PREMIUM.firstShopFloor;
}

// The one premium price function: the balancer's exact anchors AT the milestone shops,
// the depthMult curve everywhere between and beyond (the Dealer's premium slot, and the
// endless post-F30 bands, which keep climbing off the last anchor).
export function premiumPriceAt(tier: PremiumTier, floor: number): number {
  const anchors = PREMIUM.anchors[tier];
  const start = premiumAnchorStart(tier);
  const idx = Math.max(0, Math.min(anchors.length - 1, Math.floor((floor - start) / PREMIUM.shopEvery)));
  const anchorFloor = start + idx * PREMIUM.shopEvery;
  return roundToPriceStep(anchors[idx] * (1 + PREMIUM.depthRatePerFloor * (floor - anchorFloor)));
}

// Which milestone band a floor's premium offers price/roll against (0 = the F10 band).
export function premiumBandIndex(floor: number): number {
  return Math.max(0, Math.min(
    PREMIUM.mysteryLegendaryWeightByBand.length - 1,
    Math.floor((floor - PREMIUM.firstShopFloor) / PREMIUM.shopEvery),
  ));
}

// The premium mystery gamble's legendary tier weight at a floor — fed into the SHARED
// rarity roll (weapons.ts rollWeaponRarity), so the premium gamble and the base pedestal
// gamble read off one table, one code path.
export function premiumMysteryLegendaryWeight(floor: number): number {
  return PREMIUM.mysteryLegendaryWeightByBand[premiumBandIndex(floor)];
}

// End-of-run Amber from the premium economy: the armed cache converts unspent coins to a
// tiny trickle (≤ +2 per 100, capped +5/run) and the mythic windfall banks its flat grant.
// This is the ONLY coins→permanence route; there is deliberately no other.
export function amberForRun(unspentCoins: number, isCacheArmed: boolean, windfall: number): number {
  const cache = isCacheArmed
    ? Math.min(PREMIUM.amberRunCap, Math.floor((Math.max(0, unspentCoins) * PREMIUM.amberPerHundredCoins) / 100))
    : 0;
  return cache + Math.max(0, windfall);
}

// ---- WAVE 1 meta-progression: the WIDENED Amber earn (META spec §1 / PROGRESSION §4) ----
// Amber comes from PROGRESS — floors cleared, run depth, first boss kills — NEVER from trash
// mobs (the anti-grind hard rule). Every function here is PURE and DETERMINISTIC (same input
// -> same output) so the sim, the client's results-screen display, and the server-authoritative
// Convex bank all agree on the number. The leftover-coin cache trickle (amberForRun above)
// rides along inside the run pool as the "cash out your leftover coins" bridge. Amber is the
// ONE persistent currency: it buys pets/convenience/foundation, NEVER cosmetics (that hard line
// is the Wardrobe/cosmeticsCore contract).
export const AMBER_EARN = {
  // The reliable spine: every cleared floor pays a flat grant (depth = pay).
  perFloorCleared: 2,
  // A cumulative, per-run depth bonus keyed on the run's DEEPEST floor — deeper runs pay more.
  // Summed over every threshold reached (e.g. a floor-12 run banks the F5 + F10 tiers).
  depthMilestones: [
    { floor: 5, amber: 3 },
    { floor: 10, amber: 5 },
    { floor: 15, amber: 8 },
    { floor: 20, amber: 12 },
    { floor: 25, amber: 16 },
    { floor: 30, amber: 22 },
  ] as ReadonlyArray<{ floor: number; amber: number }>,
  // First time an account defeats a given boss: a one-time injection that funds early hub
  // unlocks. Banked immediately at full (exempt from the wipe cut — it is a first-clear bonus).
  firstBossKill: 25,
  // Banking rule (consequence without rage-loss): a return-to-camp banks the whole run pool,
  // a party wipe banks half of the unbanked pool. First-clear bonuses are always banked full.
  bankReturnFrac: 1.0,
  bankDeathFrac: 0.5,
} as const;

// The boss KINDS that qualify for the one-time first-kill grant (the authored boss roster).
// A pure string set so the meta layer (client + Convex bank) can validate reported kills
// WITHOUT importing the combat sim (world.ts isBossKind) — a client can never mint a
// first-boss grant for a non-boss kind.
export const BOSS_KINDS = [
  "boss", "marrow", "weaver", "gilded", "choir", "jet", "tithe", "quorum",
  "choirmaster",
  "undertow",
  "claimant",
  "wake",
] as const;

export function isBossKindId(kind: string): boolean {
  return (BOSS_KINDS as readonly string[]).includes(kind);
}

// The authoritative run facts the Amber bank is computed from (never a client-authored
// amber number). floorsCleared/deepestFloor/unspentCoins are sim truth; the two cache flags
// mirror the premium economy's armed cache + mythic windfall.
export interface AmberRunInput {
  floorsCleared: number;
  deepestFloor: number;
  unspentCoins: number;
  isCacheArmed: boolean;
  windfall: number;
}

// The cumulative depth bonus for a run that reached `deepestFloor` (0 below the first tier).
export function depthMilestoneAmber(deepestFloor: number): number {
  let sum = 0;
  for (const m of AMBER_EARN.depthMilestones) if (deepestFloor >= m.floor) sum += m.amber;
  return sum;
}

// The recurring run POOL (subject to the bank fraction): per-floor grants + the depth bonus +
// the leftover-coin cache trickle + the mythic windfall. First-boss bonuses are NOT here —
// they bank immediately at full via firstBossAmber.
export function amberRunPool(input: AmberRunInput): number {
  const floors = AMBER_EARN.perFloorCleared * Math.max(0, Math.floor(input.floorsCleared));
  const depth = depthMilestoneAmber(input.deepestFloor);
  const cache = amberForRun(input.unspentCoins, input.isCacheArmed, input.windfall);
  return floors + depth + cache;
}

// The banked recurring Amber for a run: 100% on a return-to-camp, 50% on a wipe (§1).
export function bankedRunAmber(input: AmberRunInput, isReturn: boolean): number {
  const frac = isReturn ? AMBER_EARN.bankReturnFrac : AMBER_EARN.bankDeathFrac;
  return Math.floor(amberRunPool(input) * frac);
}

// The one-time first-boss Amber for a set of NEWLY-defeated boss kinds (already filtered by
// the account's prior first-kills). Pure over the count of qualifying boss kinds.
export function firstBossAmber(newBossKinds: readonly string[]): number {
  let n = 0;
  for (const kind of newBossKinds) if (isBossKindId(kind)) n++;
  return n * AMBER_EARN.firstBossKill;
}

// ---- the depth coin taper (the premium ladder's pool calibration) ----
// The balancer's afford targets (mythic 8-20% for a greedy run, <3% without Greed; a
// greedy P90 pool below the F20/25 mythic price; a greedy F30 pool of ~700 chasing the
// 600 capstone) assume late pools that CHASE the ladder rather than trivialize it.
// Ambient coin CHANCES taper with depth: floor 1 is untouched, the ramp is gentle
// through the teaching floors, and the deep bands settle at the floor multiplier. Coin
// VALUES are untouched (Greed keeps its full ×2/2.5/3 identity, already capped at Lv3)
// and chest coin batches stay whole — only how often the world sheds loose coins thins.
// Calibrated against the seeded 1,000-run economy harness (test/premiumecon.test.ts).
// The taper is a VALLEY, not a cliff: it bottoms out through the mid bands (where the
// mythic gates demand lean pools) and RELEASES into the deep bands — the F20+ floors pay
// richer again, feeding the capstone chase the ladder prices for. Greed's multiplier and
// every coin's value are untouched throughout.
export const COIN_TAPER = {
  fromFloor: 2,
  perFloor: 0.125,
  floorMult: 0.27,       // the valley floor: never below 27% of the floor-1 chance
  releaseFromFloor: 20,  // the deep-band release begins with the F20 milestone
  releasePerFloor: 0.022,
  releaseMax: 0.43,      // deep floors climb back toward (never past) 40%
} as const;

export function coinChanceTaper(floor: number): number {
  if (floor < COIN_TAPER.fromFloor) return 1;
  if (floor >= COIN_TAPER.releaseFromFloor) {
    return Math.min(
      COIN_TAPER.releaseMax,
      COIN_TAPER.floorMult + COIN_TAPER.releasePerFloor * (floor - COIN_TAPER.releaseFromFloor + 1),
    );
  }
  return Math.max(COIN_TAPER.floorMult, 1 - COIN_TAPER.perFloor * (floor - COIN_TAPER.fromFloor + 1));
}

// ---- weapon rarity (drop quality tiers) ----
// The one weighted tier table every weapon roll reads. Free drops keep their variety
// through the per-run shuffled bag (weaponBag.ts): a roll first decides its TIER here
// (weighted, floor-gated, identical solo/co-op per §4), then deals the next undealt
// weapon OF that tier from the bag — rarity weighting and the anti-repeat deal compose
// instead of competing. Shop stock uses the same tier weights over its own pure stream.
export const WEAPON_RARITY_WEIGHT: Record<WeaponRarity, number> = {
  common: 10,
  rare: 5,
  legendary: 1,
};

// No legendary in any identified roll before this floor (the F1–3 curriculum teaches the
// base arsenal first). Boss floors (5, 10, …) and shops from F6 sit past the gate.
export const LEGENDARY_MIN_FLOOR = 4;

// Boss chests boost the legendary tier weight (1 -> 4) — the fight's reward is where the
// exciting roll lives.
export const BOSS_CHEST_LEGENDARY_MULT = 4;

// Rarity-appropriate shop pricing: the pedestal ladder price is the COMMON price; rarer
// stock costs proportionally more (rounded to whole coins).
export const SHOP_RARITY_PRICE_MULT: Record<WeaponRarity, number> = {
  common: 1,
  rare: 1.25,
  legendary: 2,
};

// ---- mystery (unidentified) weapons ----
// A "???" pickup whose actual weapon is baked at spawn (deterministic from the seed) but
// hidden from every client until the reveal on pickup/purchase. The reveal roll ignores
// the legendary floor gate at a boosted legendary weight — that is the gamble — and a
// light blessed/cursed twist rides along. Never a dead result: an already-owned reveal
// rerolls into a weapon the collector does not own.
export const MYSTERY = {
  minFloor: 3,           // no mystery pickups on the teach floors
  pedestalChance: 0.20,  // chance a stocked floor pedestal wraps its weapon as mystery
  shopChance: 0.35,      // chance the second shop weapon pedestal is a mystery pedestal
  legendaryWeight: 2,    // the reveal roll's legendary tier weight (double the open-floor 1)
  shopPriceMult: 1.25,   // mystery pedestal price = ladder base x this (cheaper than a sure legendary)
  blessedChance: 0.25,   // reveal heals 1 heart (full-HP collectors take the coin conversion)
  cursedChance: 0.25,    // reveal jams the trigger for a beat — a real but light drawback
  cursedJamSeconds: 1.5,
} as const;

// Studio gate §4 weapon-opportunity rules: party size buys OPTIONS, never rarity/power.
// Normal floor pedestal rolls (weapons stocked into the floor's chests): P1–2 roll 1,
// P3–4 roll 2, distinct IDs when the pool permits.
export function pedestalWeaponRolls(players: number): number {
  return Math.max(1, Math.ceil(clampPlayers(players) / 2));
}

// Boss weapon reward: P+1 distinct personal CHOICES, floored at 3 and capped 5. Each
// player claims one; a claim never removes a teammate's options. The floor is the
// early-variety fix: the gate's raw P+1 gave a solo player TWO options (the signature +
// one roll), so the post-boss gun was near-identical every run — three choices keep the
// pick a real decision without touching the P3-4 counts.
export function bossWeaponChoices(players: number): number {
  return Math.min(5, Math.max(WEAPON_VARIETY.bossChoiceMin, clampPlayers(players) + 1));
}

// The early-game weapon deal (playtest: "I keep getting the same few guns before the
// slime boss"). Free weapon sources draw from a per-run seeded SHUFFLED BAG of
// PICKUP_WEAPONS (see weaponBag.ts) instead of uniform-with-replacement, and every roll
// skips guns the drop would waste (owned by the whole party) while unowned guns remain.
export const WEAPON_VARIETY = {
  // Dealt-weapon history a freshly refilled bag avoids re-dealing immediately, so the
  // last gun of one pass never opens the next.
  recentDrops: 8,
  // Minimum boss-chest choice count (see bossWeaponChoices).
  bossChoiceMin: 3,
} as const;

// The Slime King's chest reward: mortar stays the PREFERRED signature (the zoning
// fight's area answer) but no longer a hard lock — the lead choice is a seeded weighted
// pick per (seed, floor), so the post-boss gun varies run to run. Every entry answers
// the King's zoning with an area/spread verb, and none duplicates another boss's
// signature (railgun/beam/tesla/cannon) or the gauntlet's burst. Deep bosses keep their
// single authored signatures — their identity is the reward.
export const KING_REWARD_TABLE: ReadonlyArray<{ weapon: WeaponId; weight: number }> = [
  { weapon: "mortar", weight: 3 },
  { weapon: "shotgun", weight: 1 },
  { weapon: "flamer", weight: 1 },
  { weapon: "sawnoff", weight: 1 },
];

// Revive (studio balance gate §6, Standard baseline): 1.5s UNINTERRUPTED channel — any
// reviver damage, dash, attack, or leaving the radius cancels the whole channel (hard
// reset, no partial credit). One reviver only; extra players never accelerate.
export const REVIVE = {
  radius: 46,
  channel: 1.5,
  hp: 2,
  invuln: 1.0,
  fireLockout: 0.35, // a revived player cannot attack for this long
  // Down limit per floor (gate §1, Standard): after this many downs on one floor the player
  // is OUT — unrevivable until the party's descent rescues them at the stairs.
  downsPerFloor: 3,
} as const;

// Wipe (gate §6): the run ends only after every connected player has been down
// SIMULTANEOUSLY for this long — a held beat, not an instant cut. Reconnect reservations
// neither block nor extend it (absent bodies are outside the calculus — the coherence
// system's rule). Solo-local keeps the classic instant game over.
export const WIPE_HOLD_SECONDS = 4.0;

// Vampire Fang: shared proc cooldown; boss-spawned/summoned adds are excluded from both
// Fang procs and natural heart drops (no farmable trivial sustain).
export const FANG_PROC_COOLDOWN = 1.25;

// ---- §3 regular enemy scaling (exact per-floor multiplier tables) ----

// Index 0 = floor 1; floors beyond 10 clamp to the last entry (the F1–10 envelope).
export const FLOOR_HP_MULT = [1.00, 1.25, 1.50, 1.72, 1.94, 2.12, 2.30, 2.47, 2.60, 2.71] as const;
export const FLOOR_SPEED_MULT = [1.00, 1.02, 1.04, 1.06, 1.07, 1.09, 1.11, 1.13, 1.14, 1.16] as const;

// Spec rounding: round-half-to-even reproduces every value in the §3 tables
// (bat F2 2.5→2, slime F3 4.5→4, skeleton F2 7.5→8).
export function roundHalfToEven(v: number): number {
  const floor = Math.floor(v);
  const frac = v - floor;
  if (frac > 0.5) return floor + 1;
  if (frac < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function floorIndex(floor: number): number {
  const f = Math.max(1, Math.floor(floor));
  return Math.min(f, FLOOR_HP_MULT.length) - 1;
}

export function floorHpMult(floor: number): number {
  return FLOOR_HP_MULT[floorIndex(floor)];
}

export function floorSpeedMult(floor: number): number {
  return FLOOR_SPEED_MULT[floorIndex(floor)];
}

// ---- §4 threat budget, density and variety tiers (difficulty ≠ HP) ----

export function floorThreat(floor: number): number {
  return Math.min(30, 6 + 2 * (Math.max(1, floor) - 1));
}

export function activeThreatCap(floor: number): number {
  return Math.min(16, 8 + Math.max(1, floor));
}

export type EnemyTier = "swarm" | "standard" | "brute" | "elite";

export interface TierDef {
  hpMult: number;
  speedMult: number;
  radiusMult: number;
  drawMult: number;
  threatCost: number;
  minFloor: number;
  attackCdMult: number; // elite: one affix + 20% shorter commit cooldowns
}

// Durability (the playtest pass): enemy toughness read as uniformly low — the big bodies
// died as fast as the chaff. The fix is TIER-SHAPED, never a blanket raise: swarm/standard
// keep their exact melt/beat numbers (fodder must stay deletable, the §7.1 early-melt
// gates are untouched), while the two VISUALLY tougher silhouettes demand sustained focus
// with a legible durability ladder — standard 1.0× << elite 2.6× < brute 3.8× (the brute's
// 1.35× draw is the biggest body, so it holds the most).
// Pricing follows the bestiary balance envelope's ladder (swarm 0.5 / brute 3 / elite 4,
// superseding the in-flight 0.55 / 2.2 / 2.8 AND the durability pass's interim 2.8 / 3.0):
// heavies price what they deny — the brute its HP wall, the elite its affix + tempo — so a
// budget buys readable pressure, never soup. Elite costs additionally clamp at
// ELITE_COST_CAP on complex chassis (see threatCostOf).
export const TIERS: Record<EnemyTier, TierDef> = {
  swarm: { hpMult: 0.55, speedMult: 1.15, radiusMult: 0.78, drawMult: 0.78, threatCost: 0.5, minFloor: 1, attackCdMult: 1 },
  standard: { hpMult: 1.00, speedMult: 1.00, radiusMult: 1.00, drawMult: 1.00, threatCost: 1.0, minFloor: 1, attackCdMult: 1 },
  // Brute: the slow anchor you must commit to — starter-pistol focused TTK ~3.2s at its
  // F4 debut (band measured in balance tests), roughly 4× a standard body and clearly
  // the toughest silhouette on the floor.
  brute: { hpMult: 3.80, speedMult: 0.82, radiusMult: 1.30, drawMult: 1.35, threatCost: 3.0, minFloor: 4, attackCdMult: 1 },
  // Elite: fast + affix, durable but always under the brute — the identity is still the
  // visible BRACE commitment (below), not an HP wall: focused ~2.8s at the F6 median
  // build (~3.4× a standard body), aggro→death ~3.6s (bands measured in balance tests).
  elite: { hpMult: 2.6, speedMult: 1.12, radiusMult: 1.08, drawMult: 1.12, threatCost: 4.0, minFloor: 6, attackCdMult: 0.8 },
};

// An elite on a complex/controller chassis never prices past this (envelope: "elite 4,
// + complex chassis ≤ 6") — the affix is one visible behavior, not a doubled tax.
export const ELITE_COST_CAP = 6;

// ---- the bestiary balance envelope (roster capacity, cadence, composition, pacing) ----
// The governance layer over ALL bestiary growth. Numbers here are the contract the
// planner enforces at build time and test/envelope.test.ts regresses seeded; the
// identity layer (roles, modules, acceptance manifests) lives in src/sim/bestiary.ts.

export const ENVELOPE = {
  // Roster capacity: how large the regular bestiary may ever grow — 8 simple bodies,
  // 10 complex families (ranged/complex/controller verbs), 6 biome specialists.
  capacity: { simple: 8, complexFamilies: 10, biomeSpecialists: 6 },
  // Intro cadence: at most this many TRULY NEW movement/attack modules per 5-floor
  // band, and a remix of an existing module only after a teaching floor. Band 1
  // (F1–5) is the shipped curriculum's teaching prologue and is grandfathered — it
  // deliberately front-loads the primer verbs per the corrected gate's cadence table.
  maxNewModulesPerBand: 2,
  firstEnvelopeBand: 1, // bands ≥ this index (F6+) obey the module cadence
  // Composition exposure caps (planner-enforced): distinct regular archetypes per
  // floor and per room, on top of the §4 complex/tier guards.
  floorArchetypeCap: 7,
  roomArchetypeCap: 4,
  roomControllerCap: 1,
  // Deck quota: at least this share of a floor's rooms stay simple/mastery (raised
  // from the interim 30%), with the existing ≤2-consecutive-complex rule unchanged.
  simpleRoomShare: 0.35,
  // The envelope's threat-cost ladder (documented here; the sim realizes it through
  // ENEMY_ARCHETYPES.threat × TIERS.threatCost + ELITE_COST_CAP + MINIBOSS.threatCost).
  // Hazard units are budgeted by the hazard system's own studio gate (tile budgets +
  // denial/simultaneity caps); the equivalent costs are recorded for composition math.
  threatCost: {
    swarm: 0.5, simple: 1.0, ranged: 1.5, complex: 2.0, controller: 2.25,
    brute: 3.0, elite: 4.0, eliteComplexCap: 6.0,
    minibossMin: 8, minibossMax: 12,
    hazardUnit: 1.5, hazardArena: 4.0,
  },
  // Room-clear P50 targets (seconds) for the band-median reference build, and the
  // pressure ceiling (simultaneous live enemy projectiles: sustained / hard).
  roomTtkP50: { early: [12, 22], mid: [18, 32], late: [24, 40] } as Record<string, readonly number[]>,
  pressure: { sustained: 50, hard: 60 },
  // Escalation regression: per-floor effective-HP growth ≤ +12% (the F1–4 teaching
  // ramp is steeper by authored design and grandfathered), damage taken ≤ +10%
  // (enemy damage never scales with floor at all — the spec's stronger rule).
  hpGrowthCapPerFloor: 0.12,
  hpGrowthCapFromFloor: 5,
  damageGrowthCapPerFloor: 0.10,
} as const;

// Live-simultaneity caps (envelope): enforced at the spawn split AND at every
// reinforcement release, per class, on top of the threat-based activeThreatCap.
// Summons count — a decoy or a ward occupies real live budget (its threat cost).
export const LIVE_CAPS = {
  bodies: 24,
  complexMovers: 2, // +1 at a full P4 party (see activeMoverCapFor)
  brutes: 2,
  elites: 2,
  controllers: 2,
} as const;

// Co-op: the extra threat budget buys MOSTLY SIMPLE BODIES (the heavy share of a floor
// is capped at the solo budget — see planFloorUnits), and the live complex-mover cap
// grows by exactly one only at a full four-player party.
export function activeMoverCapFor(players: number): number {
  return MAX_COMPLEX_MOVERS_ACTIVE + (clampPlayers(players) >= 4 ? 1 : 0);
}

// The elite's one visible affix COMMITMENT (balancer final): a braced defensive
// reposition — 0.9s slide away from the attacker at ≤25% damage reduction (never
// immunity), a ≥0.5s recover, and a cooldown that keeps the duty cycle ≤35%. Triggered
// the first time the elite is bloodied (and again off cooldown), so any elite that
// survives >1.5s shows its affix.
export const ELITE_BRACE = {
  triggerHpFrac: 0.85,
  duration: 1.1,
  recover: 0.5,
  cooldown: 4.0,
  damageReduction: 0.25,
  slideSpeed: 230,
} as const;

// ---- the behavior-elite affix set (bestiary wave) ----
// Each elite carries EXACTLY ONE affix, assigned deterministically BY KIND (see
// ELITE_AFFIXES in enemies.ts) so the read is learnable: "an elite slime is always a
// commander". No affix multiplies damage; each is a visible behavior with counterplay.

export type EliteAffix = "brace" | "commander" | "bulwark" | "volatile" | "echoed";

// Commander: a synchronized ONE commit — the rally. A fixed roar-grammar beat that
// orders every nearby ally into the existing pack-surge (speed, never damage, so the
// gate's release arbiter is untouched). Killing the commander PANICS the pack: nearby
// allies flee leaderless for panicDuration and start nothing from idle.
export const ELITE_COMMANDER = {
  rallyWindup: 0.8,       // the horn — a stationary fixed beat (roar semantics)
  rallyRadius: 260,
  rallyRecover: 0.5,
  rallyCooldown: 6.0,
  rallyTrigger: 420,      // target must be within this range to sound the horn
  surgeDelay: 0.35,       // the ordered surge lands a beat later (readable, dodgeable)
  panicRadius: 260,
  panicDuration: 1.4,
  panicSpeedMult: 0.85,   // a scattering pack, not a second charge
} as const;

// Bulwark: ONE directional breakable plate. Absorbs non-piercing bullets arriving inside
// its frontal arc until plateHp is spent, then shatters for good — never immunity, and
// never against melee/blasts/pierce. The plate tracks its target SLOWLY, so footwork
// beats it even solo.
export const ELITE_BULWARK = {
  arc: 2.0,             // radians of protected frontage (~115°)
  plateHp: 8,           // floor-1 baseline; scaled by floorHpMult at spawn
  turnRate: 1.6,        // rad/s the plate can track — a strafing player out-turns it
} as const;

// Volatile: a DELAYED shared burst. Death plants a fused charge (a visible hazard) that
// detonates after fuseSeconds — players take 1 inside the radius, enemies take more
// (shared risk: the burst is nobody's friend), props are destroyed. The delay is the
// counterplay: the kill itself is always safe, lingering on the corpse is not.
export const ELITE_VOLATILE = {
  fuseSeconds: 0.9,
  radius: 60,
  playerDamage: 1,
  enemyDamage: 4,
} as const;

// Echoed: the last ranged release REPEATS once after a delay, along the same locked
// bearing, from wherever the body now stands. Never simultaneous double damage — the
// offset IS the affix (you dodge the shot, then its echo).
export const ELITE_ECHOED = {
  delay: 0.6,
} as const;

// ---- the mid-band miniboss cadence (bestiary wave) ----
// Authored two-phase captains (the gauntlet's 50%-split contract: one short stagger,
// non-invulnerable, no HP floor) placed on the seeded mid-band floors between bosses:
// F13, F18, F23, F28, … (floor % 5 === firstFloor % 5, from firstFloor). The pick walks
// a seeded no-immediate-repeat ladder over the template roster, like the deep bosses.
// HP anchors to the same calibrated MARROW base the gauntlet captains use, ridden up the
// §3 floor curve and party-scaled at spawn.
export const MINIBOSS = {
  firstFloor: 13,
  // The captain's ENVELOPE threat cost (band 8–12): paid straight out of the floor's
  // budget, so a miniboss floor spends real pressure on its beat — never "a boss plus
  // a full mob". Max one per band by construction (the cadence is one floor per band).
  threatCost: 10,
  hpFrac: { marshal: 0.30, toll: 0.34 } as Readonly<Partial<Record<string, number>>>,
} as const;

// ---- ROOT MARSHAL (miniboss template: the formation fight) ----
// P1 (100–50%): a broad, slow-turning guard (the rootward's frontage, wider and deeper)
// and a live formation — it raises swarm rootwards to wall for it and rallies them.
// At 50%: the shield SHATTERS INTO DESTRUCTIBLE COVER — real crates on the field where
// the guard hung — and P2 trades the wall for tempo: ring sweeps alternating aimed fans.
export const MARSHAL = {
  guardArc: 2.6,
  guardReach: 22,        // px beyond the body the guard still eats bullets (formation cover)
  guardTurnRate: 1.1,    // rad/s — flanking is the whole P1 answer
  summonInterval: 5.0,
  summonCap: 2,          // live swarm rootwards it may field at once
  coverCount: 3,         // crates the shattering shield leaves behind
  coverDist: 64,
  sweepCooldown: 3.2,
  sweepWindup: 0.8,
  sweepCount: 8,
  sweepSpeed: 200,
  sweepRecover: 0.9,
  fanShots: 5,
  fanSpread: 0.24,
  fanSpeed: 280,
  shotRadius: 7,
  shotLife: 2.4,
} as const;

// ---- THE TOLL (miniboss template: the sound-lane fight) ----
// A near-stationary bell. P1: the knell — expanding sound rings, alternating with an
// aimed three-bolt peal down a locked lane (volley grammar). P2 (50%): every knell also
// plants a NOISE-LURE at the nearest player's feet — a 1-HP knell decoy that tolls its
// own ring when its fuse runs out. Shoot the noise or leave it; the lure is the fight.
export const TOLL = {
  ringCooldown: 3.4,
  ringWindup: 1.0,
  ringCount: 10,
  ringSpeed: 190,
  ringRecover: 0.8,
  pealWindup: 0.8,
  pealLock: 0.45,
  pealShots: 3,
  pealSpread: 0.14,
  pealSpeed: 280,
  pealRecover: 0.7,
  shotRadius: 7,
  shotLife: 2.6,
  lureLife: 2.2,      // knell decoy fuse (aux countdown)
  lureRingCount: 6,
  lureRingSpeed: 200,
} as const;

// Brute damage rule: only its authored, clearly telegraphed commitment (the skeleton lunge)
// deals 2 — ordinary contact stays 1. No tier ever blanket-multiplies damage.
export const BRUTE_HEAVY_DAMAGE = 2;

// Room-composition guards (§4): readable pressure, never soup.
export const MAX_COMPLEX_PER_ROOM = 2;
export const BRUTE_ELITE_COMBO_FLOOR = 8; // no brute+elite in one room before this floor
export const ELITE_SPLIT_COUNT = 2;       // the shipped elite affix: splits into swarm units

// ---- ROLLED elite affixes (Wave 1 randomness layer; see floorRolls.ts ELITE_AFFIX_POOL) ----
// Assigned to deep-floor (F31+) elites by ascending spawn ordinal from the frozen descriptor.
// Every affix is a visible behavior with counterplay; none multiplies damage. The tell is
// material (built into the body draw) and, where it warns of incoming damage, a fairness cue
// exempt from the Gate 2 telegraph cull.
export const ROLL_AFFIX = {
  // splits: on death the body cracks into `splitCount` swarm bodies (fragile, no rolled affix).
  splitCount: 2,
  splitHpFrac: 0.35,      // each shard's HP as a fraction of the parent's maxHp
  splitSpeedMult: 1.15,   // shards scatter a touch faster than the parent
  // shielded: an asymmetric crust slab (a directional breakable plate) that FALLS when spent —
  // reuses the bulwark plate law (frontal arc, non-piercing only, slow tracking) with its own
  // material read. plateHp is a floor-1 baseline, scaled by floorHpMult at spawn.
  slabArc: 2.1,
  slabHp: 10,
  slabTurnRate: 1.5,
  // hazardTrail: the body drips its element, planting a cinder every dripGap seconds it moves.
  dripGap: 0.5,
  dripLife: 1.4,
  dripRadius: 16,
  // reflect: a glassy amber facet. While ARMED (aux = armed seconds) a frontal player shot is
  // bounced back as a hostile round; the facet then CRACKS (disarmed) for crackCd seconds, then
  // re-arms. The armed facet is the fairness tell — bright while live, dark while cracked.
  reflectArc: 1.6,
  reflectArmed: 2.4,      // seconds a facet stays armed before it must re-arm
  reflectCrackCd: 1.6,    // seconds a cracked facet stays disarmed (safe to shoot the front)
  reflectBoltSpeed: 300,
  reflectBoltRadius: 6,
  reflectBoltDamage: 2,   // the bounced round is a fixed chip, never the player's full damage
  // enrage: dead-amber veins heat as HP drops; the body closes faster the more bloodied it is
  // (approach speed only — committed lethal dashes are untouched, so the read stays honest).
  enrageMaxSpeedBonus: 0.5, // +50% approach speed at 0 HP, scaling linearly from full HP.
} as const;

// ---- BOSS affixes (Wave 1; see floorRolls.ts BOSS_AFFIX_POOL) ----
// ONE extra telegraphed pattern layered onto a deep boss (F31+ boss floor). Each blooms the
// shared telegraphed "charge" detonation (a ≥0.6s arming fuse, walk-dodgeable) in a distinct
// spatial signature; the arming fuse is a fairness cue routed through the Gate 2 budget.
export const BOSS_AFFIX = {
  cooldown: 6.5,      // seconds between affix beats (idle, non-transition)
  fuse: 0.9,          // arming fuse (≥0.6s tell, walk-dodgeable)
  radius: 46,         // detonation reuses the shared "charge" hazard (a 1-HP walk-dodgeable chip)
  seamCount: 5,       // sundering: blooms along the arena-spanning fracture line
  seamSpacing: 78,
  rainCount: 4,       // amberrain: scattered blooms around the party
  rainSpread: 150,
} as const;

// Studio gate §1 (Standard): never more than 2 complex MOVERS live simultaneously — the
// charge/burrow verbs that deny standard answers. Enforced at the spawn split and again
// at every reinforcement release.
export const MAX_COMPLEX_MOVERS_ACTIVE = 2;
// Studio gate §2: max one burrower AND one shielder per room, and no flock pack may
// consume more than 35% of the room's threat spend.
export const MAX_BURROWERS_PER_ROOM = 1;
export const MAX_SHIELDERS_PER_ROOM = 1;
// The rootward is the same wall-verb readability problem as the shielder: one anchor per
// room keeps a formation a formation, never a bullet-proof hedge.
// The ecology gate: at most ONE topology worker (bailiff / keel / mason) per room —
// one persistent topology edit per room, by construction.
export const MAX_WORKERS_PER_ROOM = 1;
export const FLOCK_THREAT_SHARE_MAX = 0.35;

// Reinforcement release pacing: pending threat trickles in as waves whenever the living
// active threat drops below the cap, spaced by this stagger so waves read as waves.
export const REINFORCE_STAGGER = 0.9;

// Biome pressure (§4): bodies/hazard modifiers, never HP. Indexed by biomeIndexForFloor.
export interface BiomePressure {
  budgetMult: number;      // threat-budget multiplier
  packBias: number;        // extra swarm-pack likelihood (Amberwild +15% pack units)
  complexShare: number;    // ranged/kiter weight multiplier (Sunless 1.10×)
  hazardMult: number;      // explosive-prop bias (Deep 1.15×)
  reinforceRate: number;   // reinforcement release-rate multiplier (Emberreach 1.15×)
}

// ---- studio gate: difficulty modes (docs/specs/blobrogue_STUDIO_BALANCE_GATE.md §1) ----
// Standard is the authored experience; Casual is forgiveness, Brutal is pressure — never
// sponges, never shortened tells. Only the HAZARD rows are implemented here (the hazard
// system consumes them today, mode-parameterized and gate-tested); the combat rows
// (HP/threat/cooldown/heart multipliers) land with the difficulty system itself,
// extending this same table.

export type Difficulty = "casual" | "standard" | "brutal";

export interface HazardModeRules {
  budgetMult: number;         // scales the floor's hazard-unit budget (§1 hazard row)
  roomSimultaneousCap: number; // max hazard groups active at one instant in one room (§2)
  roomDenialCap: number;       // max fraction of a room's open floor claimed by hazards (§2)
}

export const HAZARD_DIFFICULTY: Record<Difficulty, HazardModeRules> = {
  casual: { budgetMult: 0.65, roomSimultaneousCap: 1, roomDenialCap: 0.25 },
  standard: { budgetMult: 1.00, roomSimultaneousCap: 2, roomDenialCap: 0.35 },
  brutal: { budgetMult: 1.30, roomSimultaneousCap: 3, roomDenialCap: 0.45 },
};

// Rows follow the canonical curriculum bands (blobrogue_ENCOUNTER_CURRICULUM_spec.md §0),
// plus the terminal post-F30 Null expansion band. Content's accepted values win where
// the two branches tuned the same region (Gilded Archive).
export const BIOME_PRESSURE: readonly BiomePressure[] = [
  { budgetMult: 1.00, packBias: 1.15, complexShare: 1.00, hazardMult: 1.00, reinforceRate: 1.00 }, // Amberwild
  { budgetMult: 1.00, packBias: 1.20, complexShare: 1.00, hazardMult: 1.00, reinforceRate: 1.05 }, // Rootbound Warrens (formation density)
  { budgetMult: 0.95, packBias: 1.00, complexShare: 1.10, hazardMult: 1.00, reinforceRate: 1.00 }, // Sunless Caves
  { budgetMult: 0.90, packBias: 1.00, complexShare: 1.00, hazardMult: 1.15, reinforceRate: 1.00 }, // The Deep
  { budgetMult: 0.95, packBias: 1.00, complexShare: 1.05, hazardMult: 1.00, reinforceRate: 1.00 }, // Gilded Archive (order/claimed space)
  { budgetMult: 1.05, packBias: 1.00, complexShare: 1.00, hazardMult: 1.00, reinforceRate: 1.15 }, // Emberreach
  // THE UNMAKING (post-F30) — pressure ramps region over region (each is its own biome band now).
  { budgetMult: 1.05, packBias: 1.10, complexShare: 1.10, hazardMult: 1.15, reinforceRate: 1.10 }, // The Sump
  { budgetMult: 1.08, packBias: 1.10, complexShare: 1.12, hazardMult: 1.18, reinforceRate: 1.12 }, // The Veinworks
  { budgetMult: 1.10, packBias: 1.05, complexShare: 1.14, hazardMult: 1.15, reinforceRate: 1.12 }, // The Pale
  { budgetMult: 1.12, packBias: 1.10, complexShare: 1.16, hazardMult: 1.20, reinforceRate: 1.15 }, // Null Core
];

// ---- §5 Slime King (studio gate §3: F5, 900 HP, median 35–50s, high-roll 20–25s) ----

export const BOSS = {
  // HP = max(round10(targetMedianBurn × medianPracticalDPS),
  //          ceil10((minLegalTTK − forcedTransitionTime) × P95LegalDPS))   [gate §3]
  // The gate's initial Standard-solo calibration is 900, but its own rule recalibrates HP
  // from measurement whenever the legal arsenal changes (this wave added Thumper/
  // Sunlance) — ours are deterministic sim-harness measurements, not live telemetry:
  // at 900 the fastest legal build (point-blank sawnoff + Deadeye Lv3 + Glass Cannon)
  // measures 19.0s — under the 20s high-roll floor. The anti-burst term lands 950:
  // median 48.2s ∈ 35–50, fastest legal high-roll 22.8s ∈ 20–25 (see balance tests).
  baseHp: 950,
  baseHpFloor: 5,             // the floor the 950 calibration belongs to
  contactDamage: 2,           // was 3 — collision hurts, but can't delete half a base bar
  entranceGrace: 1.2,
  attackCd: [0, 3.2, 2.7, 2.25] as readonly number[], // indexed by phase 1..3
  hopWindup: 0.65,
  hopLock: 0.32,
  hopAir: 0.45,
  hopRecover: 0.65,
  slamRadius: 90,
  slamInnerRadius: 55,
  slamCenterDamage: 2,
  slamOuterDamage: 1,
  globDamage: 1,
  radialWindup: 0.75,
  radialRecover: 0.60,
  radialCount: 10,            // 36° gaps
  packSurgeEvery: 2,          // every 2nd radial orders existing slimes into a delayed surge
  packSurgeDelay: 0.6,
  packSurgeDuration: 1.2,
  packSurgeSpeedMult: 1.6,
  // Phase thresholds, evaluated immediately after EVERY authoritative damage event.
  phaseAt: [0.70, 0.35] as readonly number[],
  phaseFloor: [0.62, 0.27] as readonly number[],
  roarDuration: 1.2,          // no invuln/reduction beat exceeds 1.2s; total forced 2.4s
  roarDamageReduction: 0.35,  // reduction, not immunity
  roarBulletClearRadius: 70,
  transitionAddCount: 2,      // two slimes at opposite marked edges
  addFirstAt: 4.5,
  addInterval: [0, 6.5, 6.5, 7.0] as readonly number[], // per phase 1..3
  addBatch: [0, 1, 1, 2] as readonly number[],
  addCap: [0, 5, 5, 7] as readonly number[],
  p3ChaseMult: 1.12,          // was 1.2
  squeezeEvery: 3,            // every 3rd P3 attack is the arena squeeze
  squeezeTelegraph: 1.0,
  squeezeDuration: 3.0,
  squeezeStartRadius: 340,    // safe radius shrinks toward the boss…
  squeezeEndRadius: 150,      // …forcing movement into the fight
  squeezeDamage: 1,
} as const;

// Should the King reappear past the authored ladder (seeded deep rotation, F30+), it
// scales off the same §3 HP curve, anchored at the F5 calibration; the curve clamps at
// F10 (≈1.40×), respecting the gate's ≤1.5× later-boss effective-health ceiling.
export function bossHpForFloor(floor: number): number {
  const scaled = BOSS.baseHp * (floorHpMult(floor) / floorHpMult(BOSS.baseHpFloor));
  return Math.round(scaled / 10) * 10;
}

// ---- EARNED WINDOWS (the deep-boss guarded/exposed contract) ----
// The designer's anti-stack model, one mechanism across the deep roster (MARROW, the
// Weaver, the Gilded Warden, the Hollow Choir — the Slime King stays the readable
// tutorial boss and the F10 gauntlet stays the deliberate DPS/execution contrast beat):
//  - GUARDED by default: incoming damage is chipped to guardMult (0.20–0.35 — reduction,
//    NEVER immunity; impatient chip still kills, it is just the slow way).
//  - Players FORCE the EXPOSED window by doing the phase's mechanic (break a lattice
//    knot, bait the pounce onto debris, silence the fragments, bait the wall crash):
//    full damage for a fixed 3–4s window. Windows are player-created, never timed gifts.
//  - Per-window damage BANK: a fresh window arms bankFrac × maxHp; once the window has
//    removed that much, it slams shut early (small final-hit overkill carries — the
//    hard phase-skip guard remains the transition floor + queued overflow). Firepower
//    converts a window harder and opens the next faster; it can't skip the mechanics.
//  - Co-op scales the MECHANIC, not just HP: task counts index the pull's snapshotted
//    player count (the *For tables below), on top of the unchanged sub-linear HP curve.
// TTK is gated in EXPOSED time (balance tests), not wall-clock.

export const EARNED_GUARD_MIN = 0.20; // guarded chip never below 20% (fairness floor)
export const EARNED_GUARD_MAX = 0.35;
export const EXPOSE_WINDOW_CAP = 8;   // combined exposure never exceeds this (stacked breaks)

// ---- KEEP THEM GUESSING (the fair-surprise layer) ----
// Randomize WHICH / WHERE / WHEN inside hard caps — NEVER whether a hit got a fair
// tell. Three levers, all seeded off the world RNG (deterministic across clients):
//  1. Add waves draw from a curated per-boss POOL (weighted, no immediate repeats, at
//     most one of each capped entry alive, complex movers under the live mover cap) —
//     every member is a known readable creature.
//  2. Reinforcements arrive as AMBUSHES: an OMEN tell (egg-sac bloom / burst web /
//     dust) marks the spot for a fixed beat BEFORE the body exists, the body then
//     keeps its ordinary spawn grace before it may attack, and no ambush is ever
//     placed inside a standing player's personal space — surprise in WHERE, never as
//     an instant hit.
//  3. Phase transitions RESHAPE the room (the Weaver re-strings its lanes, the Warden
//     reconfigures its cover) — muscle memory resets, always leaving a readable route
//     (webs only slow, cover is destructible and gapped, sites never rise on players).

export const AMBUSH = {
  tell: 0.7,        // omen seconds before the body exists (0.6–0.8 band)
  radius: 24,       // the omen's marked footprint
  playerClear: 140, // spawns land ≥140px from every player (approved spec §"guessing" 2)
} as const;

// ---- PARTY+GEAR-AWARE SCALING (the balancer's R framework) ----
// What makes a strong 4-stack actually sweat: boss encounters scale off the party's
// MEASURED power — headcount AND gear in one number — sampled once at the pull and
// never rescaled mid-fight. Server-authoritative, deterministic from seed+loadouts.
//
//   ExpectedDPS(player) = weapon base DPS × blessing mults (damage / fire rate / the
//     boss-capped crit expectation) × the boss-facing pellet/weapon coefficients ×
//     0.72 practical factor (the 12s-moving-target model the DPS ceilings use)
//   PartyDPS = Σ contributions;   R = clamp(PartyDPS / refDPS(floor), 1.0, 6.0)
//
// Guards: each contribution is floored at weakFloorFrac × refDPS / P (one weak or
// naked player can never drag the pull below baseline), and a SOLO player never
// scales past R = soloGearCap from gear alone — the strong solo build is the intended
// power fantasy (its ceiling is the DPS-model gate, never HP).
//
// EFFECTIVE HP is sublinear and hard-capped (never a sponge): HPfrac = 1 +
// hpPerR × (R − 1), clamped at hpFracCap. HP alone must never close the gap — the
// surplus (R − 1) buys MECHANICS: add pressure (cap up, interval down, hard clamps),
// the phase-timer soft-enrage (burn a phase faster than burnFrac × its R-scaled
// budget and the NEXT phase carries one authored extra PATTERN — never damage, never
// HP, never invuln), and pattern density in DISJOINT lanes only (the overlap arbiter
// is never relaxed). Downed/disconnected players never change R mid-fight.

export const POWER = {
  practicalFactor: 0.72,
  rMin: 1.0,
  rMax: 6.0,
  weakFloorFrac: 0.55,   // per-player contribution floor: 0.55 × refDPS / P
  soloGearCap: 1.15,     // a solo player's gear never scales R past this
  // Co-op FOCUS-FIRE premium (Wave 1 boss rework FIX1): a co-op party trains its whole
  // output on ONE target, so its real burst against a boss exceeds the paper sum of
  // moving-target sustained DPS. powerRatioFor lifts partyDps by focusFire × (P−1)
  // BEFORE the [1,6] clamp — a solo pull (P=1) is untouched (the direct fix for "two
  // players just spam them": the pull now measures the burst they actually bring).
  focusFire: 0.08,
  // Khp (Wave 1 boss rework FIX2): raised from 0.45 → 0.55 so co-op effective HP rides
  // higher on the sub-linear curve (2p good-gun TTK ≈ 0.86 → 0.92 of solo). Solo is
  // still ~unchanged: soloGearCap pins solo R ≤ 1.15, so its HPfrac only moves
  // 1.0675 → 1.0825 (~+1.4%, inside the ±3% solo gate). HP alone never closes the gap —
  // the surplus still routes to MECHANICS via the levers below.
  hpPerR: 0.55,          // HPfrac = 1 + hpPerR × (R − 1)…
  hpFracCap: 3.1,        // …clamped: never a sponge
  addCapPerR: 1.6,       // add cap = round(base + addCapPerR × (R − 1))…
  addCapMax: 8,          // …hard-clamped
  addIntervalPerR: 0.9,  // interval = max(min, base − addIntervalPerR × (R − 1))
  addIntervalMin: 3.0,
  phaseTimerPerR: 0.10,  // Tphase = base × (1 + phaseTimerPerR × (R − 1))
  burnFrac: 0.55,        // a phase burned faster than this × Tphase arms the soft-enrage
  // The surprise wave rides the SAME add budget (never on top), one per phase, only
  // at R ≥ surpriseMinR, with a longer tell and wider player clearance than the
  // ordinary ambush — and never during a forced transition.
  surpriseMinR: 3.0,
  surpriseTell: 0.9,
  surpriseClear: 140,
} as const;

// The balancer's per-floor reference DPS (the floor's median practical output). Boss
// floors between anchors ride the nearest band; deep floors hold the finale's.
export function refDpsForFloor(floor: number): number {
  if (floor <= 5) return 20.7;
  if (floor <= 15) return 36;
  if (floor <= 20) return 36;
  if (floor <= 25) return 43;
  // F30 and the Wave 1 deep bosses (F35 JET / F40 TITHE / F45 QUORUM) hold the finale
  // anchor of 46 (balancer FINAL). The deep bosses' anti-spam is the HARD guard gate + the
  // per-window bank, NOT HP scaling — so the anchor stays at the finale band and a co-op
  // party's surplus routes through the guard/bank/mechanic levers, not fatter HP.
  return 46;
}

// The pull's power ratio from per-player expected-DPS contributions (order-independent:
// the guard floors each contribution before the sum).
export function powerRatioFor(contributions: readonly number[], floor: number): number {
  const players = contributions.length;
  if (players === 0) return POWER.rMin;
  const ref = refDpsForFloor(floor);
  const perPlayerFloor = (POWER.weakFloorFrac * ref) / players;
  let partyDps = 0;
  for (const dps of contributions) partyDps += Math.max(dps, perPlayerFloor);
  // Co-op focus-fire premium (FIX1): a party's real single-target burst outstrips the
  // paper sum of moving-target sustained DPS. Applied BEFORE the clamp so a legal 2p
  // burst measures honestly (a solo pull, P=1, multiplies by 1 — unchanged).
  partyDps *= 1 + POWER.focusFire * (players - 1);
  let r = Math.max(POWER.rMin, Math.min(POWER.rMax, partyDps / ref));
  if (players === 1) r = Math.min(r, POWER.soloGearCap);
  return r;
}

export function bossHpFracFor(r: number): number {
  return Math.min(POWER.hpFracCap, 1 + POWER.hpPerR * (r - 1));
}

export function bossAddCapFor(baseCap: number, r: number): number {
  return Math.min(POWER.addCapMax, Math.round(baseCap + POWER.addCapPerR * (r - 1)));
}

export function bossAddIntervalFor(base: number, r: number): number {
  return Math.max(POWER.addIntervalMin, base - POWER.addIntervalPerR * (r - 1));
}

export function phaseTimerFor(base: number, r: number): number {
  return base * (1 + POWER.phaseTimerPerR * (r - 1));
}

// The authored expected phase duration per boss (the soft-enrage yardstick, ≈ the
// solo median wall-clock over its three phases).
export const PHASE_TIME_BASE: Readonly<Partial<Record<EnemyKind, number>>> = {
  boss: 16, marrow: 15, weaver: 13, gilded: 15, choir: 17,
  // Wave 1 deep bosses (balancer FINAL soft-enrage yardsticks). Quorum has one transition
  // (husks → merge), so its budget is the two-stage median rather than a three-phase one.
  jet: 16, tithe: 16, quorum: 14,
  // GORGE (F50 giant): a three-shell fight, so a longer per-phase budget than the lean roster
  // (each shell is its own mini earned-window fight). PROVISIONAL — the balancer tunes on build.
  gorge: 18,
  // PALE THRONE (F75 giant): the region cap — heavier shells (1.3× Gorge) + a tighter per-phase
  // window bank make each shell a touch longer than Gorge's. PROVISIONAL — the balancer tunes.
  pale: 20,
};

// One curated pool entry: a known readable creature at a tier, weighted for the draw.
// maxAlive caps entries that must stay singular (a second commander is noise, not
// pressure); complex movers additionally respect the live mover cap at spawn time.
export interface AddPoolEntry {
  kind: EnemyKind;
  tier: EnemyTier;
  weight: number;
  maxAlive: number; // 0 = uncapped
  count: number;    // bodies per draw (a "pair" wave is its own pool entry)
}

// ---- §5b MARROW (earned windows: F15, median 35–55s wall / exposed-gated) ----
// A LINE fight, not an area fight: sidestep the charge lanes, weave the volleys/spiral,
// and punish the wall crash. Its transition beat is a bone SHIELD instead of a roar:
// identical anti-burst plumbing (damage reduction + hard HP floor + queued overflow), but
// INTERACTIVE — killing both summoned husks drops the shield early (.9–2.6s at 35%).
// Earned window (light touch): MARROW is GUARDED (35% chip) at all times except after
// you BAIT it into a wall — the crash stun opens the exposed window. A rush that
// connects with a body recovers fast and opens nothing: the window is the dodge.

export const MARROW = {
  // Recalibrated on the EXPOSED-damage assumption (§3 rule, deterministic sim harness):
  // the old full-uptime 1,250 anchor assumed every second was damage time; under the
  // guarded/exposed contract the median build converts crash windows instead (see
  // balance tests for the measured wall-clock + exposed-time bands). The gauntlet's
  // captains deliberately do NOT ride this anchor (CAPTAIN_HP_BASE below): F10 stays
  // the full-uptime DPS/execution beat.
  baseHp: 730,
  baseHpFloor: 15,
  // Earned windows: guarded chip + the crash-bait window.
  guardMult: 0.20,      // GUARDED damage multiplier (reduction, never immunity — Wave 1 rework: 0.35 → 0.20)
  crashExpose: 3.5,     // seconds of EXPOSED opened by a baited wall crash
  windowBankFrac: 0.22, // per-window damage bank (the phase chunk — 0.40 → 0.22: a phase needs ≥2 windows)
  // Fair surprise: the cadence add is ONE omen-telegraphed ambush drawn from a curated
  // pool, so the fight never decays into pure charge-lane memorization.
  addPool: [
    { kind: "skeleton", tier: "swarm", weight: 4, maxAlive: 0, count: 1 },
    { kind: "skeleton", tier: "standard", weight: 3, maxAlive: 0, count: 1 },
    { kind: "bat", tier: "swarm", weight: 2, maxAlive: 0, count: 2 },      // a bat pair
    { kind: "charger", tier: "standard", weight: 1, maxAlive: 1, count: 1 }, // mover-capped lane bruiser
  ] as readonly AddPoolEntry[],
  contactDamage: 2,
  entranceGrace: 1.2,
  attackCd: [0, 3.0, 2.6, 2.2] as readonly number[], // indexed by phase 1..3
  // Line charge: long windup, long lane, and a wall crash that self-stuns (the punish window).
  chargeWindup: 0.9,
  chargeLock: 0.5,
  chargeSpeed: 520,
  chargeDur: 1.1,
  chargeRecover: 0.7,
  crashStun: 1.6,
  crashShards: [0, 0, 6, 8] as readonly number[],    // ring size on a wall crash, per phase
  // Bone-shard volley: an aimed fan that widens with the phase.
  volleyWindup: 0.7,
  volleyLock: 0.4,
  volleyRecover: 0.6,
  volleyShards: [0, 3, 5, 7] as readonly number[],   // fan size per phase 1..3
  volleySpread: 0.22,                                // radians between fan shards
  shardSpeed: 300,
  shardRadius: 7,
  shardDamage: 1,
  shardLife: 2.4,
  // P3 spiral barrage: every 3rd attack, a stationary rotating pair-emitter you weave through.
  spinEvery: 3,
  spinWindup: 0.8,
  spinDuration: 2.2,
  spinInterval: 0.22,   // seconds between shard pairs
  spinStep: 0.55,       // radians the spiral advances per pair
  spinRecover: 0.8,
  // Phase thresholds/floors (65/30, floors 57/22), evaluated after EVERY authoritative
  // damage event (like §5).
  phaseAt: [0.65, 0.30] as readonly number[],
  phaseFloor: [0.57, 0.22] as readonly number[],
  shieldDuration: 2.6,        // max beat length when the husks are ignored (attackable at 65%)
  shieldMinDuration: 0.9,     // the beat always reads, even if the husks die instantly
  shieldDamageReduction: 0.35, // reduction, not immunity — same principle as the roar
  shieldBulletClearRadius: 70,
  shieldHusks: 2,             // summoned at opposite marked edges; killing both breaks early
  addFirstAt: 5,
  addInterval: [0, 7, 7, 7] as readonly number[],
  addBatch: [0, 1, 1, 2] as readonly number[],
  addCap: [0, 4, 4, 6] as readonly number[],
  p3ChaseMult: 1.10,
} as const;

// Deep bosses ride the same clamped §3 curve off their own calibration anchor (beyond F10
// the envelope is flat, so deeper encounters stay at the anchor).
function anchoredBossHp(baseHp: number, anchorFloor: number, floor: number): number {
  return Math.round((baseHp * (floorHpMult(floor) / floorHpMult(anchorFloor))) / 10) * 10;
}

export function marrowHpForFloor(floor: number): number {
  return anchoredBossHp(MARROW.baseHp, MARROW.baseHpFloor, floor);
}

// The pre-earned-windows FULL-UPTIME calibration (MARROW's old 1,250 @F15). The F10
// gauntlet captains and the mid-band miniboss templates keep deriving from THIS anchor:
// they are the run's deliberate DPS/execution beats, never gained a guard, and must not
// shrink because the guarded bosses' anchors were recalibrated onto exposed damage.
export const CAPTAIN_HP_BASE = 1250;
export const CAPTAIN_HP_FLOOR = 15;

export function captainHpForFloor(floor: number): number {
  return anchoredBossHp(CAPTAIN_HP_BASE, CAPTAIN_HP_FLOOR, floor);
}

// ---- §5c THE HOLLOW CHOIR (corrected gate §3: F30 finale, median 40–58s, high-roll ≥22s) ----
// The grieving ghost mass: it does not zone you with bodies — it UNMAKES itself. On
// cadence it fades intangible and drifts through you (a breather you must keep moving
// through), then rematerializes into a burst; its volleys are slow HOMING wails you juke
// by turning, not by standing behind cover. Transition beats SPLIT it into three wisps —
// kill them to force it back together early (the wisps ARE the boss during the beat).

export const CHOIR = {
  // Recalibrated on the EXPOSED-damage assumption (earned windows): the Choir is
  // GUARDED until its FRAGMENTS are silenced (see below), so the old full-uptime 1,450
  // anchor would sponge — the anchor is re-measured in the balance tests.
  baseHp: 750,
  baseHpFloor: 30,
  contactDamage: 2,
  entranceGrace: 1.2,
  attackCd: [0, 3.2, 2.8, 2.4] as readonly number[],
  // Earned window: SILENCE THE CHOIR — it sings through summoned fragments (its ghost
  // kin, fragile swarm bodies). While any fragment of the current verse stands, the
  // Choir is GUARDED; killing every one opens the EXPOSED window, and the next verse
  // gathers a few seconds later. More players = a wider verse (more simultaneous
  // fragments), snapshotted at the pull.
  guardMult: 0.20,        // Wave 1 rework: 0.30 → 0.20 (reduction, never immunity)
  silenceExpose: 3.5,     // seconds of EXPOSED per fully-silenced verse
  windowBankFrac: 0.22,   // 0.40 → 0.22: crossing a phase needs ≥2 silenced verses
  fragmentFirstAt: 3.0,   // first verse gathers shortly after the entrance grace
  fragmentRespawn: 6.0,   // seconds after a window closes before the next verse
  fragmentsFor: [0, 2, 3, 4, 4] as readonly number[], // indexed by snapshotted players 1..4
  // Fair surprise: the verse arrives as an AMBUSH WAVE (omen tells at seeded anchors,
  // never on a player), and as it lands the Choir sings WITH it — a bounded
  // untargetable refrain (your DPS is redirected into the fragments, never idled).
  singDuration: 3.5,
  fragmentRingDist: 220,  // verse anchors ring the Choir at this reach
  // The fade: telegraph, then intangible drift toward the target, then a rematerialize
  // burst (P2+) into a long recover — the punish window for tracking it through the fade.
  fadeEvery: 3,
  fadeWindup: 0.6,
  fadeDuration: 1.8,
  fadeSpeedMult: 1.6,
  fadeRecover: 0.8,
  burstShards: [0, 0, 8, 10] as readonly number[], // rematerialize ring per phase
  burstSpeed: 240,
  // Homing wails: slow, readable seekers with a capped turn rate — orbit them off.
  wailWindup: 0.7,
  wailLock: 0.4,
  wailRecover: 0.6,
  wailCount: [0, 2, 3, 4] as readonly number[],
  wailSpread: 0.5,
  wailSpeed: 150,
  wailTurnRate: 2.4,
  wailRadius: 8,
  wailDamage: 1,
  wailLife: 2.6,
  shardRadius: 7,
  shardDamage: 1,
  shardLife: 2.6,
  // Transition beats: the Choir scatters into wisps (it is GONE — untargetable, but the
  // wisps ARE the active pressure) until they die or the cap elapses. Queued overflow
  // lands when it reforms, same §5 contract. Corrected: 65/30 thresholds, 57/22 floors,
  // split 1–3.2s.
  phaseAt: [0.65, 0.30] as readonly number[],
  phaseFloor: [0.57, 0.22] as readonly number[],
  splitDuration: 3.2,
  splitMinDuration: 1.0,
  splitWisps: 3,
  splitBulletClearRadius: 70,
  // Fair surprise §1 — the verse draws its VOICE from a curated pool. Instead of always
  // the ghost fragment, each gathering verse is a DIFFERENT readable spectral body
  // (drawn seeded + non-repeating via drawFromAddPool + lastAddPick, exactly like
  // Weaver/Marrow). The verse COUNT stays the co-op task (fragmentsFor, snapshotted at
  // the pull); only WHICH kin sings is the surprise. Every member is a known creature,
  // fragile at swarm tier, and a chaser/drifter (never a kiter) so the verse stays
  // silenceable — the window can always be earned, the guess is only who arrives.
  addPool: [
    { kind: "ghost", tier: "swarm", weight: 5, maxAlive: 0, count: 1 },    // the drifting revenant (the Choir's own kin)
    { kind: "skeleton", tier: "swarm", weight: 3, maxAlive: 0, count: 1 }, // the hollow dead, marching the verse in
    // The third voice (finale variety): grave-bats roused from the rafters — a wheeling
    // FLOCK swarm (a drifter, never a kiter/ranged) and the most fragile kin of the three
    // (hp4, ≤ the ghost), so the verse stays silenceable and the window is always earnable.
    // Lowest weight, so the ghost stays the primary kin and the bat is the rarest guess.
    { kind: "bat", tier: "swarm", weight: 2, maxAlive: 0, count: 1 },
  ] as readonly AddPoolEntry[],
  // Fair surprise §3 — the hall RESHAPES on every phase transition (the split beat): the
  // old resonant pillars crumble and a fresh seeded ring rises, so the room reads
  // differently each phase (the Warden cover / Weaver molt shape). Gaps are authored into
  // the ring by construction (every gapEvery-th site stays open → ≥1 readable route
  // always), pillars never rise on or beside a body, and every piece is ordinary
  // destructible cover — the reshape reorganizes the hall, it can never seal a route, and
  // (unlike a window) it NEVER touches the guard/exposed state.
  // The reshape VARIES BY PHASE (indexed by boss.phase): P1 is the entrance hall and is
  // never reshaped — the reshape fires on the P2 and P3 split beats, and each raises a
  // recognizably DIFFERENT hall (not the same ring re-spun). P2 CLOSES IN (a tight, dense
  // ring); P3 OPENS OUT (a wide, sparse ring). Every phase keeps ≥3 pillars and ≥3 authored
  // gaps — a readable route always survives — and choirReshape still holds every gated
  // safety invariant (never on/beside a body, opens no window, bumps obstacleRev).
  reshapeByPhase: [
    { ringDist: 210, sites: 12, gapEvery: 4 }, // phase 0 — placeholder (never reshaped)
    { ringDist: 210, sites: 12, gapEvery: 4 }, // P1 — the entrance hall (never reshaped)
    { ringDist: 180, sites: 12, gapEvery: 4 }, // P2 — CLOSES IN: a tight, dense ring (9 pillars / 3 gaps)
    { ringDist: 240, sites: 9, gapEvery: 3 },  // P3 — OPENS OUT: a wide, sparse ring (6 pillars / 3 gaps)
  ] as readonly { ringDist: number; sites: number; gapEvery: number }[],
  reshapePlayerClear: 70, // a pillar never rises within a player's personal space
} as const;

export function choirHpForFloor(floor: number): number {
  return anchoredBossHp(CHOIR.baseHp, CHOIR.baseHpFloor, floor);
}

// ---- §5d THE WEAVER (earned windows + fair surprise: F20 — read the weave, force it
// out, punish). GUARDED (30% chip) by default, highly mobile, and every window is
// PLAYER-CREATED per the designer's exact phase structure:
//   P1 READ THE WEAVE — the weave PARTITIONS the arena: silk LANES (rows of sticky
//     silk, move ×0.5, a dash clears the silk it crosses at the dash's own cost)
//     anchored on glowing KNOTS (never where you already stand), and its blink-strike
//     commits along a knot's thread. Shoot a knot → its lane section collapses →
//     EXPOSED 3s (simultaneous breaks combine); a knot shot out mid-blink SNAGS it.
//   P2 SHE CLIMBS — untargetable on the walls, dropping spiderling AMBUSHES (curated
//     pool, omen-telegraphed) and AIMED SILK volleys that web where they land. Your
//     DPS is redirected, never idle-punished: destroy every EGG-SAC (2 solo, +1 per
//     extra player) to FORCE HER DOWN → marked descent, crash stagger, EXPOSED 4s.
//     Ignore the sacs and she eventually descends on her own — with NO window.
//   P3 WALL-CRAWL DASH — she crawls to a lane's end and CHARGE-DASHES along the lanes
//     she built (the target lane's silk flares for the whole 0.7s locked tell). An
//     intact lane's knot brakes her at the far end (no window); a dash into a
//     broken/empty lane OVERSHOOTS into the wall → crash stagger + EXPOSED 4s. Break
//     the lane you stand in — before the dash or out from under it — and she pays.
// Phase transitions RESHAPE the weave: the molt crumbles every knot, lane and sac and
// re-strings a fresh seeded lattice, so lane memory resets each phase.

export const WEAVER = {
  // The approved spec opens the anchor at 1,500 but pins its own calibration rule
  // higher: "HP calibrated on EXPOSED time (median 20–30s exposed), not uptime."
  // Measured under the earned-windows contract (30% chip + banked windows + P2's
  // untargetable climb), 1,500 lands the median build at ≈112s wall / ≈54s exposed —
  // nearly double both bands — so the anchor is recalibrated down to the value the
  // deterministic harness measures IN-band (see balance tests: wall 38–55s, exposed
  // 20–30s). The 1,500 figure assumed full-uptime damage; exposed-time is the rule.
  baseHp: 590,
  baseHpFloor: 20,
  contactDamage: 2,
  entranceGrace: 1.2,
  attackCd: [0, 3.0, 2.7, 2.3] as readonly number[],
  // Earned windows.
  guardMult: 0.20,        // GUARDED damage multiplier (reduction, never immunity — Wave 1 rework: 0.30 → 0.20)
  knotBreakExpose: 3,     // P1: seconds of EXPOSED per broken lattice knot
  forcedownExpose: 4,     // P2: every egg-sac silenced -> she is forced down
  overshootExpose: 3.5,   // P3: a dash into a broken lane overshoots into the wall
  windowBankFrac: 0.22,   // per-window damage bank (0.40 → 0.22: a phase needs ≥2 windows)
  // THE LATTICE: knots anchor the silk lanes, ringed off the Weaver and never inside
  // knotPlayerClear of a standing player (the break forces a reposition). Each knot
  // casts 3 thread-lines; ONE is strung with sticky silk — the lane partition. A knot's
  // death (shot or expiry) crumbles its lane silk; a shot additionally leaves debris.
  knotsFor: [0, 1, 2, 3, 3] as readonly number[], // knots per lattice, by snapshotted players
  maxKnots: 3,
  knotRingDist: 170,
  knotPlayerClear: 110,
  knotLife: 22,           // lanes are the fight's geography — they persist
  knotDebrisRadius: 52,
  knotDebrisLife: 8,
  laneWebSpacing: 78,     // silk row spacing along a strung lane
  laneWebRadius: 44,
  laneHalf: 240,          // a lane runs this far past its knot (wall-clamped)
  // Sticky silk: move ×0.5 inside (designer number); a DASH through silk clears it —
  // the dash itself is the cost. Enemies are unaffected.
  webRadius: 62,
  webLife: 12,
  webSlow: 0.5,
  maxWebs: 20,            // hard cap over every silk source: sticky, never solid
  // Blink-strike (P1): the whole 0.7s tell is post-lock (the lane + arrival mark freeze
  // at windup start), then a 0.3s traverse along the committed thread and an arrival
  // strike. Snagging the lane's knot mid-blink crashes it out of the air.
  blinkWindup: 0.7,
  blinkAir: 0.3,
  blinkRecover: 0.55,
  blinkStrikeRadius: 52,
  blinkStrikeDamage: 1,
  snagStagger: 1.0,       // crash recover after a mid-blink snag
  // Weave: a self-cast re-stringing — fresh knots + their lanes (no aim, fixed tell).
  weaveWindup: 0.7,
  weaveRecover: 0.7,
  // P2 — the climb. Untargetable on the walls (bounded by climbMax), egg-sacs are the
  // forced-down switch, spiderlings + aimed silk are the pressure while she is up.
  climbAscend: 0.6,       // the readable scurry-to-the-wall tell (still targetable)
  climbMax: 9,            // she descends on her own past this (no window)
  sacsFor: [0, 2, 3, 4, 5] as readonly number[], // egg-sacs per climb: 2 solo, +1 per extra
  silkEvery: 3.0,         // aimed-silk cadence while climbing
  silkWindup: 0.7,        // the volley's charge tell (windup rides the wire)
  silkBolts: 3,
  silkSpread: 0.28,
  silkSpeed: 240,
  silkDamage: 1,
  silkLife: 2.2,
  silkWebRadius: 40,      // a silk bolt webs where it lands
  spiderlingEvery: 4.0,   // ambush pool drops while she is up (R tightens toward 3.0)
  spiderlingCapBase: 2,   // live spiderling budget at R1 (R lifts it, clamped at 8)
  sacRingDist: 200,       // the clutch blooms on this ring around her perch
  descendTell: 0.35,      // the marked drop's own tell before the air beat
  descendAir: 0.4,        // the marked drop (forced or voluntary)
  descendStagger: 1.2,    // forced-down crash (the window rides it)
  unforcedRecover: 0.7,   // voluntary descent: brief recover, NO window
  pounceRadius: 74,       // the descent landing (shared pounce read)
  pounceInnerRadius: 44,
  pounceCenterDamage: 2,
  pounceOuterDamage: 1,
  // P3 — the lane dash. She crawls to a lane entry, flares THAT lane for the whole
  // locked tell, then dashes it. The lane's live knot brakes her at the far end; a
  // broken lane can't — she overshoots into the wall.
  crawlNear: 46,          // close enough to a lane entry to commit the dash
  crawlSpeedMult: 1.5,    // the wall-crawl scurry between commitments
  dashFlare: 0.7,         // locked windup: the target lane's silk flares (≥0.6s tell)
  dashSpeed: 560,
  dashRecover: 0.55,      // intact lane: controlled brake, no window
  laneBrakeSilk: 2,       // live silk rows a lane needs to brake her (else: overshoot)
  dashStagger: 1.2,       // overshoot crash (the window rides it)
  // The spiderling pool (fair surprise §1): every entry is a known readable creature.
  addPool: [
    { kind: "bat", tier: "swarm", weight: 4, maxAlive: 0, count: 1 },     // a spiderling
    { kind: "bat", tier: "swarm", weight: 3, maxAlive: 0, count: 2 },     // a spiderling PAIR
    { kind: "bat", tier: "elite", weight: 1, maxAlive: 1, count: 1 },     // one Commander
    { kind: "charger", tier: "elite", weight: 1, maxAlive: 1, count: 1 }, // one Bulwark (mover-capped)
  ] as readonly AddPoolEntry[],
  // Molt beat: a fixed cocoon (roar semantics, ≤1.2s per the approved spec's forced-
  // transition guardrail) that bursts into a web-bolt ring + two broodlings, then
  // RESHAPES the weave (fresh lattice). Spec phase bands: P1 100–66, P2 66–33, P3 33–0.
  phaseAt: [0.66, 0.33] as readonly number[],
  phaseFloor: [0.58, 0.25] as readonly number[],
  moltDuration: 1.2,
  moltDamageReduction: 0.35,
  moltBoltCount: 8,
  moltBoltSpeed: 260,
  moltBulletClearRadius: 70,
  moltAdds: 2,
  shardRadius: 7,
  shardDamage: 1,
  shardLife: 2.6,
} as const;

export function weaverHpForFloor(floor: number): number {
  return anchoredBossHp(WEAVER.baseHp, WEAVER.baseHpFloor, floor);
}

// ---- §5e THE GILDED WARDEN (corrected gate §3: F25, median 40–58s, high-roll ≥22s) ----
// The armored tempo boss: its plate chips incoming damage to 30% at ALL times except the
// EXPOSED window — the long recover after each committed quake/sweep, when the plate
// hangs open. You do not out-DPS the Warden whenever you like; you dodge the commitment,
// then unload into the opening. Reduction, never immunity: impatient chip still works,
// it is just the slow way.
// The corrected gate lists 800 as the in-flight initial "valid only if its closed-armor/
// exposure cycle lands inside its gate" — at the F25 median build 800 burns in ≈26s,
// under the 40s floor, so the §3 recalibration formula lands 1,280 (measured in-band;
// see balance tests). Jet stays post-F30 expansion content; the Warden holds F25.

export const GILDED = {
  baseHp: 1280,
  baseHpFloor: 25,
  contactDamage: 2,
  entranceGrace: 1.2,
  attackCd: [0, 3.6, 3.2, 2.8] as readonly number[],
  // Earned windows: the Warden was the pattern's precedent, now routed through the
  // shared guarded/exposed plumbing — closed armor = GUARDED (30% chip), and each
  // committed quake/sweep OPENS its recover as the exposed window, bank-capped like
  // every other deep boss so a stacked party can't delete a phase through one opening.
  armorChip: 0.20,      // GUARDED (closed-plate) damage multiplier — never zero (Wave 1 rework: 0.30 → 0.20)
  windowBankFrac: 0.22, // 0.40 → 0.22: crossing a phase needs ≥2 punished commitments
  // Anvil slam: a marked in-place quake with a directional aftershock line, then the
  // exposed recover — the fight's core loop.
  slamWindup: 0.8,
  slamLock: 0.45,
  slamActive: 0.3,
  slamRecover: 2.2,     // the EXPOSED window
  slamRadius: 110,
  slamInnerRadius: 66,
  slamCenterDamage: 2,
  slamOuterDamage: 1,
  slamLineShards: 3,
  slamLineSpeed: 300,
  slamLineGap: 0.16,    // radians between aftershock shards
  // Gold sweep: slow, heavy rings you walk through; P3 releases two offset waves.
  sweepWindup: 0.75,
  sweepRecover: 2.0,    // also exposed
  sweepCount: 10,
  sweepSpeed: 190,
  sweepWaves: [0, 1, 1, 2] as readonly number[],
  sweepWaveGap: 0.4,
  shardRadius: 8,
  shardDamage: 1,
  shardLife: 3.0,
  // Sanctify beat: fixed-duration roar semantics — corrected contract 70/35 thresholds,
  // 62/27 floors, 1.2s transition at 35% reduction (the King's sturdier shape).
  phaseAt: [0.70, 0.35] as readonly number[],
  phaseFloor: [0.62, 0.27] as readonly number[],
  sanctifyDuration: 1.2,
  sanctifyDamageReduction: 0.35,
  sanctifyBulletClearRadius: 70,
  // Fair surprise §3 — the sanctify RESHAPES the archive: the old shelving crumbles and
  // a fresh seeded ring of destructible cover rises around the Warden while it roars
  // (the non-damaging beat IS the telegraph). Gaps are authored into the ring by
  // construction, sites never rise on or beside a standing player, and every piece is
  // breakable — the reconfiguration resets cover memory, never the escape.
  coverSites: 12,        // candidate sites on the ring
  coverGapEvery: 4,      // every Nth site stays open — ≥3 authored gaps per ring
  coverRingDist: 200,
  coverPlayerClear: 70,  // a site never rises within a player's personal space
} as const;

export function gildedHpForFloor(floor: number): number {
  return anchoredBossHp(GILDED.baseHp, GILDED.baseHpFloor, floor);
}

// ---- WAVE 1 DEEP BOSSES (THE UNMAKING / The Sump, F35–45) ----
// All three ride the same earned-window plumbing as the F15–30 roster: guarded body +
// a PLAYER-CREATED exposed window + telegraphed surprise (≥0.6s tell, walk-dodgeable,
// ≥0.30s post-lock, ≥0.35s recover), HP calibrated on EXPOSED time (never a sponge),
// and co-op scaling the TASK (not just HP). They slot onto the deep-floor progression
// to replace the "repeats at 35 are boring" problem with three fresh authored fights.

// The R-framework SURPLUS the three deep bosses route (balancer FINAL, per-boss curves on
// each boss's own constants above): JET tightens its salvo cadence + adds a sequential verb
// at high R; the TITHE spawns feed-channel chaser adds; QUORUM fires husk-add waves on break.
// All keyed off w.encounterPower via the shared scalers (bossAddIntervalFor for cadence, the
// per-P caps + activeThreatCap for counts, phaseTimerFor for the soft-enrage) exactly like
// updateWeaver/updateMarrow — surplus DPS at higher R converts to MORE mechanic pressure +
// faster cadence + soft-enrage, never to fatter HP alone (a SOLO pull, R≈1, adds nothing).

// ---- §5g JET (F35): the corrupted MIRROR of the party ----
// JET mirrors the ARCHETYPE of the party's weapons — never their live inventory. Its
// MIRROR POOL is a frozen set of "Resonance families" resolved once at the pull (like
// the R sample): distinct families present across the party, seeded-padded to a minimum,
// capped. Each family maps to ONE authored mirrored VERB (a bullet pattern JET performs).
// The fight window: survive a corrupted-Resonance salvo → JET is SPENT → its recover is
// the exposed window (the Gilded commitment-recover model). 3 phases swap the body
// (uncanny → out-of-sync canon → inverted/room-drain). Simultaneous verbs are capped to
// the telegraph budget (fewer at 4P), so co-op grows the POOL (task), never the soup.

// The authored Resonance families JET can mirror — the ARCHETYPE buckets, not weapons.
export type ResonanceFamily = "spread" | "rapid" | "lance" | "arc" | "lob" | "melee";

// The stable family order (determinism: the frozen loadout is built in this order).
export const RESONANCE_FAMILIES: readonly ResonanceFamily[] = ["spread", "rapid", "lance", "arc", "lob", "melee"];

// Weapon ARCHETYPE → Resonance family. JET reads a weapon's family, NEVER its identity or
// stats — two different weapons of the same family produce the SAME mirrored verb (the
// archetype-not-inventory contract, locked by test).
export const WEAPON_RESONANCE: Readonly<Record<WeaponId, ResonanceFamily>> = {
  pistol: "lance", shotgun: "spread", rapid: "rapid",
  smg: "rapid", cannon: "lob", burst: "spread", ricochet: "arc", homing: "arc", tesla: "arc",
  sawnoff: "spread", railgun: "lance", nailer: "rapid", flamer: "lance", mortar: "lob", beam: "lance",
  sword: "melee", longsword: "melee", spear: "melee",
  lastlight: "lance", breach: "lob", snapwire: "lob", frostline: "lob", halo: "lob", sentry: "lob", crook: "melee",
  reaper: "arc", swarm: "rapid", midas: "lance", phase: "lance", vortex: "lob",
  // Content wave archetypes: the Cleaver is a piercing lance, the Scrapper a rapid stream,
  // the Skipper a bouncing spread, the Arcbolt an arcing lance, the Cryobolt a rapid shard,
  // the Firebomb a lob, the Tracker an arcing seeker, the Singularity a collapsing lob.
  cleaver: "lance", scrapper: "rapid", skipper: "spread", arcbolt: "arc",
  cryobolt: "rapid", firebomb: "lob", tracker: "arc", singularity: "lob",
  mooring_nail: "lance", sluicegate: "spread", oddsmaker: "arc", pathmaker: "lob",
  resonant_fork: "spread", red_pen: "lance", margin_call: "rapid", sidewinder: "arc",
  hushiron: "lance", backtalk: "spread", lamplighter: "lance", faultlink: "rapid",
};

export function weaponResonanceFamily(id: WeaponId): ResonanceFamily {
  return WEAPON_RESONANCE[id];
}

// The per-family telegraph + mirrored-shard hue: JET's mirror copies must read as the
// COPIED weapon ("that's MY gun"), NOT as JET's own cold-indigo band — so each Resonance
// family gets a distinct off-JET hue (the SHAPE is authored per family in the renderer + the
// sim's emit; this is the shared color both sides key on). Used sim-side by jetEmitFamily to
// tint the mirrored shards, and client-side to draw the mirror telegraph in the same hue.
export const RESONANCE_TELEGRAPH_COLOR: Readonly<Record<ResonanceFamily, string>> = {
  lance: "#ff5a5f",  // red — the P3 signature beam
  spread: "#ffb43b", // amber
  rapid: "#3fbf5f",  // green
  lob: "#6ff0d8",    // teal
  arc: "#a24bff",    // purple
  melee: "#c9c9de",  // bone
};

export const JET = {
  // Calibrated on EXPOSED time like the deep roster (the spent-recover windows are the
  // only full-damage time). Anchored at F35; rides the clamped §3 curve above F35.
  baseHp: 760,
  baseHpFloor: 35,
  guardMult: 0.12,        // GUARDED between salvos — a near-HARD gate (balancer FINAL: 0.32 → 0.12; chip is not a path, play the mirror windows)
  spentExpose: 3.2,       // seconds of EXPOSED the "he's spent" recover opens (UNCHANGED — the bank is the lever)
  windowBankFrac: 0.20,   // per-window damage bank (0.40 → 0.20: a phase needs ≥2 spent windows — balancer tighten)
  contactDamage: 2,
  entranceGrace: 1.2,
  attackCd: [0, 3.0, 2.6, 2.2] as readonly number[], // between salvos, per phase
  // The corrupted-Resonance salvo: a telegraphed multi-verb barrage, then the spent recover.
  mirrorWindup: 0.75,     // the tell (≥0.6s)
  mirrorLock: 0.4,        // aim locks here — 0.75-0.4 = 0.35s post-lock dodge (≥0.30)
  mirrorActive: 0.35,     // the emission beat
  spentRecover: 3.2,      // the exposed window (= spentExpose)
  canonOffset: 0.16,      // P2 "out-of-sync canon": the staggered second verb's delay
  // R-framework SURPLUS (balancer FINAL). Higher R tightens the salvo cadence (more parry
  // attempts = more windows), and adds EXTRA verbs to the staggered sequence — the render cap
  // (simulCapFor) still bounds how many land at once (1 at 4p), so it's a faster sequence at
  // the same per-beat readability.
  // ⚠ BOSS-LOCAL salvo rate (NOT the generic addIntervalPerR 0.9, which is sized for 6–7s add
  // loops and would floor Jet's 2–3s salvo instantly): 0.12 per (R−1), floored at 1.8s.
  salvoIntervalPerR: 0.12,
  salvoIntervalFloor: 1.8,
  // Extra salvo verbs = min(bossAddCapFor(0, R), surplusVerbCap) → 0 solo / 2 at 2p+ (R-keyed).
  surplusVerbCap: 2,
  // The frozen mirror pool: distinct party families, padded up to verbMinSeeded with
  // seeded families, capped at verbMax. Bigger party = more distinct families = a bigger
  // pool cycled one salvo at a time (the co-op TASK grows, the per-salvo read does not).
  verbMax: 4,
  verbMinSeeded: 2,
  // Simultaneous verbs per salvo, clamped to the 4-player telegraph budget: solo/duo may
  // read 2 at once, trio/quad only 1 (readability over raw pressure at 4P).
  simulCapFor: [0, 2, 2, 1, 1] as readonly number[], // by snapshotted players 1..4
  phaseSimul: [0, 1, 2, 2] as readonly number[],      // the salvo's desire, per phase 1..3
  // The mirrored bullet verbs (shared shard kinematics; the PATTERN is the archetype tell).
  globSpeed: 250, globRadius: 8, globDamage: 1, globLife: 2.6,
  spreadCount: 5, spreadArc: 0.9,     // spread family: a wide fan
  rapidCount: 4, rapidGap: 0.06,      // rapid family: a fast aimed stream (staggered in active)
  lanceSpeed: 460,                    // lance family: a fast locked line
  arcCount: 10,                       // arc family: a full ring (the "bounce/chain/seek" mirror)
  lobRadius: 74,                      // lob family: a marked bloom (a telegraphed charge)
  meleeReach: 150, meleeDamage: 2,    // melee family: a lunge strike at the locked bearing
  // P3 room-drain: a scatter of telegraphed charge blooms (the shared walk-dodgeable hazard)
  // laid around the party as the room "drains" — layered on the inverted salvos.
  drainCount: 3, drainSpread: 150,
  // ---- WAVE 1 REWORK: the interleaved pressure moves (A2–A4 + P3), so JET is never one
  // spammable salvo. None open the exposed window (that stays the mirror's SPENT recover) —
  // they are read-the-boss pressure between salvos, each a distinct fair telegraph.
  // A2 TRACER SNAP (dash-punish): motes lock your position, hover, then SNAP to the mark
  // after tracerSnapDelay — you must dash LATE, after the snap tell, not on the lock.
  tracerWindup: 0.7, tracerLock: 0.35, tracerRecover: 0.6,
  // Mote count is R-keyed (balancer FINAL): round((R−1)/1.5), capped at tracerMoteCap →
  // solo 0 / 2p 1 / 3p 2 / 4p 3 (a co-op dash-punish; solo JET is mirror-focused).
  tracerMoteDivR: 1.5, tracerMoteCap: 3,
  tracerSnapDelay: 1.0, tracerSnapSpeed: 540, tracerRadius: 8, tracerDamage: 1, tracerLife: 1.4,
  // A3 RECOIL LINE (space-cover, P2+): JET recoils along an axis, laying an amber wall of
  // charge blooms that bisects the arena; the NEXT recoil lays the perpendicular = a cross.
  recoilWindup: 0.75, recoilDashSpeed: 620, recoilDashDur: 0.34, recoilRecover: 0.6,
  recoilWallSpan: 320, recoilWallStep: 58, // bloom spacing along the bisecting wall
  // A4 OVERCLOCK FEINT (P2+): a big beam corridor telegraph; 30% (seeded) FEINTS into a
  // burst offset to the beam's safe side, so a committed dash into the "safe" gap is punished.
  beamWindup: 0.8, beamLock: 0.45, beamActive: 0.3, beamRecover: 0.6,
  beamHalfWidth: 34, beamShards: 9, beamSpeed: 470, beamFeintChance: 0.30, beamFeintOffset: 0.5,
  // P3 CORRUPTION: the squad's biggest attack mirrored as a WIDE screen beam (longer tell,
  // wider corridor) — dodge THROUGH the corridor's authored gap to counter.
  corruptWindup: 0.95, corruptHalfWidth: 52, corruptShards: 15, corruptSpeed: 430, corruptGap: 0.55,
  phaseAt: [0.66, 0.33] as readonly number[],
  phaseFloor: [0.58, 0.25] as readonly number[],
  // Transition beat: a fixed roar (the amber-motif dead note), King/Gilded semantics.
  roarDuration: 1.2,
  roarDamageReduction: 0.35,
  roarBulletClearRadius: 70,
  shardRadius: 8,
  // ---- SURPRISE LAYER §5g B2: MIRROR-IMAGE ECHO AMBUSHES ----
  // A telegraphed jet-black reflection of a targeted player: it arrives on the shared
  // fair-ambush omen (0.7s pre-tell + ≥140px player-clear), fires ONE mirrored-school salvo
  // on its OWN readable windup, then dissolves into resin flecks. FRAGILE + BRIEF — "dodge
  // your own reflected aggression," never a second durable JET. It rides the shared add
  // density controller (bossAddCapFor / countBossAdds / pending omens) and is HARD-capped at
  // echoCap CONCURRENT echoes: ONE at a time (the deliberate default — the P3 "two sequential"
  // flourish is dropped so the 4p read never becomes a soup of reflections / a multi-Jet fight).
  echoCap: 1,
  echoRingDist: 190,          // where the reflection tries to arrive, off the mirrored player
  echoInterval: [0, 7.0, 6.0, 5.0] as readonly number[], // cadence per phase (R-scaled by bossAddIntervalFor)
  echoFirstAt: 3.0,           // first echo cadence beat after the pull settles
  echoWindup: 0.7,            // its salvo tell (≥0.6s, the shared readable-windup floor)
  echoLock: 0.35,             // aim locks here — 0.7-0.35 = 0.35s post-lock dodge (≥0.30)
  echoActive: 0.3,            // the single-salvo emission beat
  echoDissolve: 0.45,         // brief recover, then it dissolves into resin flecks (never lingers)
  // ---- SURPRISE LAYER §5g B3: PER-PHASE ARENA-CORRUPTION RESHAPE ("The Light Goes Out") ----
  // On each ≤1.2s non-invuln transition the arena degrades toward corruption as JET wins: the
  // previous corruption crumbles and a fresh, DENSER band of cold black-resin drain zones
  // creeps in from the room EDGES (P1 clean → P2 edges → P3 deep, safe pockets on the last
  // tiles). The reshape is pure zoning: it leaves ≥1 readable route (an authored corridor gap)
  // and NEVER touches guard/exposed (windows stay earned by the mirror-salvo spent-recover).
  corruptInsetTiles: [0, 0, 1, 3] as readonly number[], // how many tiles inward per phase (P1=0/none)
  corruptStepTiles: 2,       // patch spacing along the band (coarse grid — bounded wire/render count, not per-tile)
  corruptGapTiles: 3,        // width of the authored safe corridor left open through the corruption
  corruptRadius: 40,         // each drain patch's damage radius (covers the coarse-grid cell so the band reads continuous)
  corruptDrain: 1,           // drain damage while a player stands in it (protection-gated like cinder — zoning, not a DPS race)
  corruptLife: 999,          // effectively permanent within the phase (re-laid, not accumulated, each transition)
} as const;

export function jetHpForFloor(floor: number): number {
  return anchoredBossHp(JET.baseHp, JET.baseHpFloor, floor);
}

// A solo party is capped at soloGearCap R; a fixed simultaneous cap for the salvo. The
// clamp is a pure function of the SNAPSHOTTED player count (frozen at the pull) — never
// a per-draw player-count branch.
export function jetSimulCapFor(players: number): number {
  return JET.simulCapFor[Math.max(1, Math.min(4, players))];
}

// ---- §5h THE TITHE (F40): the armored FEEDER ----
// A heavy low-wide feeder gorged on the party's stolen amber. It BUILDS a feeding SLAB
// and RE-ARMORS behind it — GUARDED while it feeds. The window: destroy the slab before
// the re-armor channel closes → the feeder is EXPOSED. Missing it COSTS (no window, more
// pressure) but always LOOPS (it feeds again — never a dead end). Co-op = MORE / THICKER
// slabs (the task), never a shorter channel. The slab is a SEPARATE 2-state destructible.

export const TITHE = {
  // Heavier body than the lean roster, but calibrated on EXPOSED time: the windows are
  // gated behind slab-TTK, so the bar is not a sponge — the slab is the pacing.
  baseHp: 940,
  baseHpFloor: 40,
  guardMult: 0.0,         // ZERO to the body while armored/feeding — a TRUE hard gate (balancer FINAL: 0.30 → 0.0; the ONLY damage path is breaking the slab)
  slabExpose: 3.5,        // seconds of EXPOSED opened by breaking the slab in time (UNCHANGED — the bank is the lever)
  windowBankFrac: 0.20,   // 0.40 → 0.20: a phase needs ≥2 broken-slab windows (balancer tighten)
  contactDamage: 2,
  entranceGrace: 1.2,
  attackCd: [0, 3.2, 2.9, 2.5] as readonly number[],
  // The feed cycle: a build tell (amber ooze rising the seams), then the re-armor channel
  // behind the raised slab(s). Break every slab before the channel elapses for the window.
  feedEvery: [0, 2.0, 1.8, 1.6] as readonly number[], // cadence gap after a feed resolves
  buildWindup: 0.8,       // the ooze-rising tell (≥0.6s)
  rearmChannel: 3.0,      // seconds to re-armor — the slab must die inside ~60-70% of this
  slabsFor: [0, 1, 1, 2, 2] as readonly number[],       // slabs per feed by snapshotted players
  slabThickFor: [0, 1.0, 1.8, 2.0, 1.9] as readonly number[], // co-op = THICKER slabs (HP mult — balancer REVISED: holds slab-TTK ~1.6-2.0s P1-4 with repair-adds active; the old 2.4× at 4p overshot)
  // R-framework SURPLUS (balancer FINAL): the feed channel spawns simple CHASER adds, count =
  // min(bossAddCapFor(0, R), feedAddCap) → solo 0 / 2p 3 / 3p 4 / 4p 4 (R-keyed), gated by the
  // active-threat cap only. ⚠ rearmChannel stays FLAT 3.0 at ALL R (perR 0 — NEVER a shorter
  // timer): the task scales via slab HP/thickness + these adds. Soft-enrage adds +1 slab.
  feedAddCap: 4,          // hard readability cap on the feed-add count
  tributeRepairPerSec: 6, // an UNINTERCEPTED tribute at the slab repairs it 6 HP/s (the 4p divide-
                          // labor job — tuned so worked tributes don't outpace the break, ignored ones do)
  // Ring suppression (EXPLICIT — the generic overlap arbiter never gates a tribute against the
  // ring, since a tribute is a slab-REPAIR actor, not a damage release): while a GORGE SLAM ring
  // telegraphs/is live, at most this many tributes ACT (the rest hold), restoring to the full
  // feed-add count after the ring clears with re-activation staggered by tributeReactivateStagger.
  tributeActiveCapDuringRing: 2,
  tributeReactivateStagger: 0.18, // held tributes re-activate at 0 / 0.18 / 0.36s after the ring
  slabBaseHp: 84,         // slab HP anchor at F40 (per slab; balancer FINAL 46 → 84); scales on the floor curve
  slabHpFloor: 40,
  slabRingDist: 130,      // the slab raises between the feeder and the party at this reach
  slabOffset: 0.5,        // …offset off the direct axis (rad) so a line-of-sight lane always stays
  // Offense between feeds: a heavy amber ring, occasionally a denser double ring (P3).
  radialWindup: 0.8,
  radialRecover: 0.7,
  radialCount: 12,
  globSpeed: 230, globRadius: 8, globDamage: 1, globLife: 2.8,
  shardRadius: 8,
  // ---- WAVE 1 REWORK: the feeder's interleaved offense (never one spammable ring). The
  // feed loop stays the window; these are the space-covering pressure between feeds.
  // A1 GORGE SLAM (space-cover): rears, slams a 360° shockwave RING + debris blooms you
  // dash THROUGH on i-frames (or stand in a debris-shadow gap). P2 double-pulses.
  slamWindup: 0.9, slamRecover: 0.7,
  gorgeRingCount: 14, gorgeSpeed: 250, gorgeDebris: 4, gorgeDebrisDist: 120, gorgePulseGap: 0.45,
  // A3 SPEW ARC (multi-stage, P2+): amber globs arc into pools (charge blooms), THEN a 2nd
  // wave fills wave-1's GAPS — read both. Wave 2 is offset from wave 1 by half a step.
  spewWindup: 0.8, spewRecover: 0.7, spewStageGap: 0.55,
  spewCount: 5, spewRing: 150,
  // A4 SLAB HURL (P2+): the feeder throws a plate as a heavy line projectile; committing
  // to the throw leaves its side unarmored — the hurl's recover is a short exposed window.
  hurlWindup: 0.8, hurlLock: 0.4, hurlRecover: 0.6, hurlExpose: 2.0,
  hurlSpeed: 380, hurlRadius: 20, hurlDamage: 2, hurlLife: 2.2,
  // SIGNATURE (P3): rips its plating into a slow ROTATING BARRAGE wheel, then collapses
  // into a long exposed window (the memorable moment — a guaranteed P3 window, earned by
  // surviving the wheel). Fires once per P3 on a fixed cadence.
  wheelWindup: 0.9, wheelDuration: 2.0, wheelInterval: 0.18, wheelStep: 0.5, wheelSpeed: 230,
  collapseExpose: 4.5,
  phaseAt: [0.66, 0.33] as readonly number[],
  phaseFloor: [0.58, 0.25] as readonly number[],
  // Transition beat: a feeder bellow (roar semantics), no adds.
  roarDuration: 1.2,
  roarDamageReduction: 0.35,
  roarBulletClearRadius: 70,
} as const;

export function titheHpForFloor(floor: number): number {
  return anchoredBossHp(TITHE.baseHp, TITHE.baseHpFloor, floor);
}

// One slab's HP: the anchor ridden up the §3 curve, thickened by the snapshotted party.
export function titheSlabHpForFloor(floor: number, players: number): number {
  const thick = TITHE.slabThickFor[Math.max(1, Math.min(4, players))];
  return Math.max(1, Math.round(anchoredBossHp(TITHE.slabBaseHp, TITHE.slabHpFloor, floor) * thick));
}

// ---- §5i QUORUM (F45): three husks, ONE shared pool + ONE telegraph ----
// Three hollow bone husks (SHIELD / HEAL / DMG) share ONE HP pool (the boss bar) and ONE
// telegraph (the core drives it; the lead husk shows it). Roles are LOAD-BEARING so
// kill-order is real: while the SHIELD husk lives the pool is GUARDED (chip); while the
// HEAL husk lives the pool REGENERATES — so 4P crossfire that nukes the pool evenly makes
// no progress. Break a husk (focus its integrity) to end its role; the tether snaps + yanks.
// At the merge threshold a telegraphed 1.2s NON-invuln MERGE fuses the husks into the
// merge-form, which gets its OWN earned window with a widened ≥0.45s recover.

export const QUORUM = {
  baseHp: 800,            // the SHARED pool (calibrated on exposed time)
  baseHpFloor: 45,
  guardMult: 0.12,        // pool GUARDED (near-HARD gate) on a non-priority husk / merge-closed (balancer FINAL: 0.30 → 0.12; even-nuke can't skip the kill-order)
  windowBankFrac: 0.22,   // 0.40 → 0.22: the merge-form's windows already clear ≥2/phase, so it holds the default (only JET/TITHE needed the 0.20 tighten)
  contactDamage: 2,
  entranceGrace: 1.4,
  // Husks: 3 role bodies orbiting the core, sharing the pool.
  huskRingDist: 120,
  // Formation: the three husks hold assigned SLOTS 120° apart around the core (a readable
  // triangle), the whole trio orbiting slowly with a little per-husk sway — they steer to
  // their slot, never free-chase the player, so shield/heal/dmg stay visually distinct and
  // never collapse into one overlapping blob (Ian: "they just snuggle into one stacked boss").
  huskOrbitStep: 0.006,    // radians/tick the triangle orbits the core (~0.36 rad/s)
  huskSwayStep: 0.05,      // radians/tick of the per-husk lateral sway
  huskSway: 0.12,          // sway amplitude (rad) — a little life, never enough to overlap
  huskIntegrityFrac: 0.10, // each husk's break meter as a fraction of the pool max (balancer FINAL 0.20 → 0.10)
  healRegenPerSec: 14,     // the HEAL husk regenerates the pool while alive (undo lazy chip — balancer FINAL 10 → 14)
  huskReformDelay: 1.0,    // P1 LOOP: after the trio is cleared the pool is EXPOSED for this long
                           // (shoot the core), then the trio RE-FORMS (re-gates) — repeat until merge

  // R-framework SURPLUS (balancer FINAL): a husk-adds WAVE fires when a husk breaks, count =
  // min(bossAddCapFor(1, R), huskAddCap) → solo 1 / 2p 4 / 3p 5 / 4p 5 (R-keyed), gated by the
  // active-threat cap and paced by a wave interval that tightens 6.0s → 3.0s with R (the
  // generic bossAddIntervalFor 0.9 rate is fine here). The merge-form's continuous final window
  // is UNGATED by R — no adds attach to it.
  huskAddBase: 1,          // bossAddCapFor base for the break-wave count
  huskAddCap: 5,           // hard readability cap on the wave count
  huskAddInterval: 6.0,    // wave cadence base → bossAddIntervalFor (3.0s floor at high R)
  splinterHealPerSec: 4,   // a heal-role splinter trickle-heals the pool (weak vs the heal husk's 14)
  // The ONE shared telegraph (core-driven): a converging amber ring the lead husk shows.
  attackCd: [0, 2.8, 2.2] as readonly number[], // phase 1 (husks), phase 2 (merged)
  volleyWindup: 0.75,      // the shared tell (≥0.6s)
  volleyLock: 0.42,        // 0.75-0.42 = 0.33s post-lock (≥0.30)
  volleyRecover: 0.6,
  radialCount: 9,
  globSpeed: 220, globRadius: 8, globDamage: 1, globLife: 2.6,
  shardRadius: 8,
  // ---- WAVE 1 REWORK: the 3-husk geometry weaponized (never one spammable ring). None
  // open a window in the husk phase (kill-order IS the mechanic — focus the priority husk);
  // the merge-form's commitment recovers stay the earned windows.
  // A1 CROSSFIRE: converging beam CORRIDORS from the husk bearings — pick a pocket or dash
  // a lane. Lane count rides the live-husk count; shard density rides the 4p surplus.
  crossWindup: 0.75, crossLock: 0.4, crossActive: 0.3, crossRecover: 0.6,
  crossHalfWidth: 24, crossShards: 6, crossSpeed: 300, crossLaneSpread: 0.42,
  // A2 TETHER SNAP (shield husk alive): the shield-tether whips across as a moving WALL —
  // a dense arc of shards you dash under/over on i-frames.
  snapWindup: 0.7, snapLock: 0.38, snapRecover: 0.6, snapArc: 1.5, snapShards: 13, snapSpeed: 250,
  // A3 ROLE VOLLEY (combo): an aimed staggered burst (the dmg role) plus a knockback ring
  // pulse (the heal role) — read the sequence, not one tell.
  roleWindup: 0.7, roleLock: 0.4, roleRecover: 0.55, roleBurst: 3, roleGap: 0.13, roleSpeed: 310, rolePulseCount: 8, rolePulseSpeed: 190,
  // Merge: telegraphed 1.2s NON-invuln transition at the threshold.
  mergeThreshold: 0.45,    // pool fraction that triggers the merge beat
  mergeFloor: 0.40,        // the anti-burst floor (queued overflow lands after the merge)
  mergeDuration: 1.2,
  mergeDamageReduction: 0.0, // NON-invuln — keep damaging it through the merge
  mergeBulletClearRadius: 60,
  // Merge-form: faster commitment → widened recover window (≥0.45s), the merge-form's own
  // earned window. A radial commitment opens the exposed recover, bank-capped like the rest.
  mergeRadialWindup: 0.7,
  mergeRadialActive: 0.3,
  mergeRecover: 0.5,       // the EXPOSED window (widened ≥0.45)
  mergeRadialCount: 12,
  mergeSpeed: 250,
  phaseAt: [0.45] as readonly number[],  // one transition: husks → merge-form
  phaseFloor: [0.40] as readonly number[],
} as const;

export function quorumHpForFloor(floor: number): number {
  return anchoredBossHp(QUORUM.baseHp, QUORUM.baseHpFloor, floor);
}

// ---- THE GIANT GRAMMAR (shared tunable surface) ----
// GORGE (below) is the reference shape; every giant — GORGE (F50), PALE (F75), and the future
// F100 Unmaker — declares the SAME field set so ONE shared giant-encounter core (world.ts
// updateGiant) drives them all, parameterized only by this constants block + material/colors.
// The as-const literals are widened here (scalars → number, tuples → readonly number[]) so a
// tuned giant (PALE) is assignable alongside the reference (GORGE) without fighting the types.
//
// GIANT AXES + SIGNATURE (the "mechanics step" between giants): each deeper giant escalates NOT by
// tightening the base pattern but by adding ONE NEW READABLE AXIS per phase plus a cross-cutting
// regional SIGNATURE. These are OPTIONAL fields — ABSENT on Gorge (so Gorge plays exactly as
// shipped, byte-identical), PRESENT on Pale (its F75 axes below), and F100 adds its own. The
// shared giant core reads each `!== undefined` to switch the axis on. Gorge is the base fight;
// Pale is base + these axes; F100 will be base + compounded axes + a "subtraction" signature.
interface GiantAxes {
  // P1 SEQUENCING axis — a SECOND counter-offset ring (undefined = single ring, like Gorge).
  readonly ring2DelaySec?: number;        // the 2nd ring follows this long behind the 1st (the sequence read)
  readonly ring2GapOffsetSlots?: number;  // the 2nd ring's gap offset from the 1st, in ring slots (~half the ring)
  readonly seamBanksMinPlayers?: number;
  readonly seamBankMinSeparationRad?: number;
  // P2 POSITIONING-OVER-TIME axis — MIGRATING pools (undefined = static pools, like Gorge). Each
  // pool CREEPS outward from the giant (zoneSpreadTilesPerSec) AND new pools seed at the edge of
  // the nearest-to-expiring one (isZoneChurnEnabled) so the safe floor DRIFTS; the denial stays capped
  // (zoneCap ≤ ⅓ arena) so the pocket always survives.
  readonly zoneSpreadTilesPerSec?: number; // outward creep speed of each pool, in tiles/sec
  readonly isZoneChurnEnabled?: boolean;   // seed new pools at the edge of the nearest-to-expiring one (migrate, don't re-center)
  // P3 DUAL-READ axis — a COUNTER-ROTATING second sweep (undefined = single sweep, like Gorge).
  // spoke2Step counter-rotates (opposite sign, same magnitude); the safe spot is the drifting
  // INTERSECTION of the two wedges. spoke2Gap widens the 2nd sweep's gap when a full pair would
  // seal the intersection (the fairness escape hatch — pale.test.ts asserts it never fully closes).
  readonly spoke2Step?: number;       // the counter-sweep's per-emission rotation (opposite sign)
  readonly spoke2Gap?: number;        // the counter-sweep's gap in slots (>= spokeGap; wider = sparser = fairer)
  readonly spokeLife?: number;
  // The regional SIGNATURE — WARMTH-DRAIN (undefined = none, like Gorge). A per-player stillness
  // chill that punishes CAMPING: idle too long → move ×warmthDrainSlow, cleared by moving a real
  // distance, telegraphed by a ramping frost vignette. A SLOW, never damage; reuses CHILL_SLOW.
  readonly warmthDrainIdleSec?: number;        // stillness before the chill creeps in
  readonly warmthDrainMoveClearTiles?: number; // move at least this many tiles to clear the idle timer (thaw)
  readonly warmthDrainSlow?: number;           // the move-speed multiplier while chilled (= CHILL_SLOW 0.5)
}
export type GiantConst = {
  readonly [K in keyof typeof GORGE]: (typeof GORGE)[K] extends readonly number[] ? readonly number[] : number;
} & GiantAxes;

// ---- GORGE (F50 GIANT #1 — the Sump cap; the AD-LOCKED giant TEMPLATE for F75/F100) ----
// A colossal ~192px STATIONARY front-facing set-piece PINNED to floor 50 (never in the seeded
// deep rotation). It does not chase; its whole threat is SPACE-CONTROL (rings / zones / spokes)
// plus a MULTI-PHASE SHELL-PEEL task. Calibrated on EXPOSED time like the deep roster, but as a
// K=3 GIANT: each shell's HP is a FRACTION of a standard deep boss, so the TOTAL is ~1.5x a
// standard boss via PHASE COUNT — NEVER ~4x HP on one pool (the GIANT calibration HARD RULE; a
// naive one-pool 4x giant would be ~2360, the sponge this structure avoids). The peel VERB is
// destroying the shell's telegraphed tectonic WEAK-POINTS (gorge_seam); clearing a whole exposed
// set routes through the SHIPPED earned-window plumbing (openBossWindow → guard chip + PER-PHASE
// bank + calibration + determinism), and the body's HP chunk bleeds down across the exposed
// windows until the layer SLOUGHS at the phase transition (the punctuated crack-off that swaps
// the sprite rind → chitin → core and drops the shell as debris cover).
export const GORGE = {
  // PER-SHELL HP at F50 (the balancer's anchor), BACK-LOADED so the fight escalates INTO its
  // hardest/longest phase — the core reveal (never front-loaded, which would make the giant
  // easiest exactly when its scariest form appears). NAMED per-shell (rind/chitin/core), each
  // riding the §3 curve; total 930 = 1.5x a standard deep boss (~620) delivered across 3 GATED
  // phases (~9.2s / 10.2s / 13.5s exposed). NOT a single magic number — gorgeHpForFloor sums these.
  shellHp: [260, 290, 380] as readonly number[], // rind / chitin / core (F50)
  baseHpFloor: 50,
  // The shell SLOUGHS (phase transition) when its HP chunk is spent: phaseAt[k] = the cumulative-
  // from-full complement of shellHp = [1 - 260/930, 1 - 550/930] = [0.720, 0.409]. Kept in lockstep
  // with shellHp (gorge.test.ts asserts the two agree). phaseFloor = the anti-burst floor (queued
  // overflow lands after the crack-off), ~0.08 under each threshold.
  phaseAt: [0.7204, 0.4086] as readonly number[],
  phaseFloor: [0.64, 0.33] as readonly number[],
  // GUARDED behind the shell: ZERO body damage while sealed (a TRUE hard gate like the Tithe —
  // the ONLY damage path is peeling, i.e. the earned window). The shell IS the wall.
  guardMult: 0.0,
  // PER-PHASE anti-burst: a single earned window caps at 0.22 × the CURRENT SHELL's HP chunk
  // (~57 / 64 / 84 for rind/chitin/core), so each phase needs ~5 earned windows to clear and NO
  // phase can be one-burst even by a high-roll 4-stack — the phase-count structure enforces the
  // anti-burst without a fat pool (openBossWindow banks off the phase HP for gorge, not the pool).
  windowBankFrac: 0.22,
  peelExpose: 3.2,      // seconds of EXPOSED a full weak-point-set clear opens on the bared material
  contactDamage: 2,
  entranceGrace: 1.4,
  // Cadence between SPATIAL-PATTERN commitments, per phase (rings/zones/spokes). Damage never
  // scales with floor; only the pattern cadence differs per shell.
  attackCd: [0, 3.0, 2.8, 2.4] as readonly number[],
  // ---- the shell-peel TASK: the tectonic WEAK-POINTS (gorge_seam mechanic bodies) ----
  // N weak-points PER EXPOSURE, per shell (solo base) — RIND few (teaches the verb) / CHITIN more
  // (reposition around the 192px body) / CORE most (execution) — scaled by the SNAPSHOTTED party
  // (co-op = MORE seams = the TASK scales, NOT the HP), hard-capped for readability (disjoint lanes).
  seamBaseByShell: [2, 3, 4] as readonly number[], // rind / chitin / core (solo)
  seamPerPlayer: 1,        // +N seams per extra player (the co-op task scale)
  seamCap: 6,              // hard readability cap (seams ring the body in disjoint lanes)
  seamHp: 24,              // one weak-point's HP anchor (a mechanic body — a few focused rounds; floor-scaled)
  seamRingDist: 96,        // seams jut out at the shell's outer edge (well outside the ~60px body radius)
  // The seams jut out FACING the threatened player (the shell cracks toward the threat — always
  // reachable, clear line past each seam to the shell). The arc WIDENS per shell: RIND a tight
  // front cluster (teaches the verb) → CHITIN a wider spread (track + reposition along the front)
  // → CORE the widest, out to the giant's sides (±90°). Capped at π so every seam clears the body
  // from the front — never behind it (a full-orbit-behind would be unfair at giant scale).
  seamArcByShell: [Math.PI * 0.55, Math.PI * 0.85, Math.PI * 1.0] as readonly number[],
  seamExposeInterval: 1.4, // seconds sealed between exposures (the giant runs its pattern meanwhile)
  seamFirstAt: 2.0,        // first exposure after the pull settles
  // The exposure WINDOW (retract unspent if not cleared in time) — RIND long / CHITIN mid / CORE
  // SHORT (the execution test). Miss it → the shell re-seals (no window) → re-exposes (it LOOPS).
  seamLifeByShell: [11.0, 9.5, 8.0] as readonly number[],
  // ---- P1 RIND (dim) — RADIAL: expanding shockwave RING with an authored GAP + debris blooms ----
  // Problem = time the dash through the ring band, or stand in the gap (debris complicates the gap).
  ringWindup: 0.9,         // the RING_BAND lead (the shipped "Gorge" telegraph default)
  ringRecover: 0.7,
  ringCount: 16, ringGap: 3, ringSpeed: 240, // ring shards minus a `ringGap`-wide OPEN safe wedge
  ringDebris: 2, ringDebrisDist: 150,        // charge blooms near the gap (so the ring isn't the only read)
  globRadius: 8, globDamage: 1, globLife: 2.8,
  // ---- P2 CHITIN (warm) — ZONING: persistent SLAG pools that progressively DENY floor ----
  // Problem = positioning under area-denial (the danger STAYS + accumulates), a shrinking safe area.
  zoneWindup: 0.8,         // the IMPACT_DISCS lead (telegraph shows WHERE the pools land)
  zoneRecover: 0.7,
  zoneCount: 3, zoneRing: 150, // pools per commitment, ringed AROUND the party (so their current spot stays safe)
  zoneRadius: 30, zoneLife: 9.0, zoneCap: 10, // persistent (deny floor), hard-capped (shrinks the pocket, never seals the floor)
  // ---- P3 CORE (blazing) — CONVERGENT: rotating SPOKE-sweeps leaving ONE moving safe wedge ----
  // Problem = continuous movement reading a rotating safe lane (with P2 zones still live). Climax.
  spokeWindup: 0.9, spokeRecover: 0.6,
  spokeDuration: 3.0, spokeInterval: 0.16,   // the wheel fires a spoke set every interval for this long
  spokeCount: 9, spokeGap: 2,                // spokes minus a `spokeGap`-wide MOVING safe wedge
  spokeStep: 0.13, spokeSpeed: 250,          // radians the wheel advances per emission (the moving safe lane)
  // ---- the peel beat (the punctuated crack-off = the phase transition) ----
  debrisPerPeel: 2, debrisRingDist: 82,      // shell chunks dropped at the base per shell slough (material evidence + cover; just clear of the ~60px body)
  // Transition beat: the shell CRACKS OFF (roar semantics) — a big screen-punch, no adds.
  roarDuration: 1.2,
  roarDamageReduction: 0.35,
  roarBulletClearRadius: 80,
} as const;

export function gorgeHpForFloor(floor: number): number {
  // Sum the per-shell anchored HP (the balancer's back-loaded split — NOT one magic number); each
  // shell rides the §3 curve independently, anchored at F50 (260 + 290 + 380 = 930 at F50).
  let hp = 0;
  for (const shell of GORGE.shellHp) hp += anchoredBossHp(shell, GORGE.baseHpFloor, floor);
  return hp;
}

// The fraction of the giant's pool held by shell `phase` (1..3) — drives the PER-PHASE window
// bank (0.22 × this shell's HP chunk), so each phase self-gates against a one-burst regardless of
// the pool size (~5 windows/phase even for a high-roll 4-stack). Back-loaded: rind < chitin < core.
export function gorgeShellFracFor(phase: number): number {
  const total = GORGE.shellHp.reduce((a, b) => a + b, 0);
  return GORGE.shellHp[Math.max(0, Math.min(GORGE.shellHp.length - 1, phase - 1))] / total;
}

// One weak-point's HP at a floor (the peel-task pacing — a mechanic body scaled on the §3 curve
// like the Tithe slab; NEVER part of the giant's own pool). Anchored at F50.
export function gorgeSeamHpForFloor(floor: number): number {
  return Math.max(1, anchoredBossHp(GORGE.seamHp, GORGE.baseHpFloor, floor));
}

// N weak-points for a shell phase (1..3) at the snapshotted party size — the co-op TASK scale
// (more players = more seams = more repositioning, never fatter HP). Capped for readability.
export function gorgeSeamCountFor(phase: number, players: number): number {
  const base = GORGE.seamBaseByShell[Math.max(0, Math.min(GORGE.seamBaseByShell.length - 1, phase - 1))];
  const p = Math.max(1, Math.min(4, players));
  return Math.min(GORGE.seamCap, base + (p - 1) * GORGE.seamPerPlayer);
}

// ---- SEVER (F55 HUNT/INTERCEPT — WORLDSPLIT signature) ----
// Batch1 OWNER LOCK: true chase through connected rooms. Timings LOCKED at 20Hz:
//   1.5s plant/tell → 1.2s moving fracture → 3.0s reel-back punish (±1 tick).
// ONE isBossKind core; resin anchors are mechanic bodies (never boss kinds).
// Reuses Batch0 EncounterState (hunt) + RoomEdge flee graph. Escape never fails the run.
export const SEVER = {
  baseHp: 620,
  baseHpFloor: 55,
  phaseAt: [0.66, 0.33] as readonly number[],
  phaseFloor: [0.58, 0.25] as readonly number[],
  guardMult: 0.22,
  windowBankFrac: 0.28,
  contactDamage: 2,
  entranceGrace: 1.2,
  attackCd: [0, 2.6, 2.4, 2.2] as readonly number[],
  // WORLDSPLIT timings (seconds) — authoritative at TICK_HZ=20; tests allow ±1 tick.
  worldsplitPlant: 1.5,
  worldsplitFracture: 1.2,
  worldsplitPunish: 3.0,
  // Flee / intercept
  pressureRadius: 220,
  fleeSpeedMult: 1.35,
  escapeMeterMax: 3,          // escapes before route worsens (soft fail, never wipe)
  // Sev-0 fail-safe: the hunt can NEVER softlock a run. If the encounter stays active with ZERO
  // progress (no boss damage, no checkpoint, no open window) for this long, Sever slips away and
  // the floor opens (soft escape, no boss reward). Generous — only a genuinely stuck party hits it.
  stallFailoverSec: 75,
  anchorsPerCheckpoint: 2,    // trap both exits of a checkpoint room
  anchorHp: 28,
  interceptWindow: 3.0,       // earned damage window after both anchors break
  roarDuration: 1.0,
  roarDamageReduction: 0.35,
  roarBulletClearRadius: 64,
} as const;

export function severHpForFloor(floor: number): number {
  return anchoredBossHp(SEVER.baseHp, SEVER.baseHpFloor, floor);
}

export function severAnchorHpForFloor(floor: number): number {
  return Math.max(1, anchoredBossHp(SEVER.anchorHp, SEVER.baseHpFloor, floor));
}
// ---- HOLLOW CHOIRMASTER (F60 SPLIT/SILENCE — THE LAST NOTE signature) ----
// Batch2A OWNER LOCK: ONE multi-lobed super-room (structureKind 'split'). Timings LOCKED at 20Hz:
//   1.6s silent inhale/gesture → ~0.7s per linked sheet span → 4.0s voiceless punish (±1 tick).
// ONE isBossKind conductor; choir_pillar bodies are mechanic entities (never boss kinds).
// Success = silence FIRST live pillar before sheet reaches it → openBossWindow(4.0).
// Survival = acoustic shadow behind a previously broken pillar (no window). Failure soft, never wipe.
// Calibrated on EXPOSED time (silence-gated like Choir F30): deep-boss band between Sever F55 and
// Pale F75 — earned LAST NOTE windows are the pacing, not chip or sponge HP (Quill FINAL).
export const CHOIRMASTER = {
  baseHp: 860,
  baseHpFloor: 60,
  phaseAt: [0.66, 0.33] as readonly number[],
  phaseFloor: [0.58, 0.25] as readonly number[],
  guardMult: 0.20,        // silence-gated chip band (matches Choir deep earned-window hard-ish gate)
  windowBankFrac: 0.22,   // ≥2 silenced phrases per phase (matches deep roster Choir/Jet band)
  contactDamage: 2,
  entranceGrace: 1.4,
  attackCd: [0, 3.2, 2.9, 2.6] as readonly number[],
  // THE LAST NOTE timings (seconds) — authoritative at TICK_HZ=20; tests allow ±1 tick.
  lastNoteInhale: 1.6,
  lastNoteSpan: 0.7,
  lastNotePunish: 4.0,
  // Phrase / pillars
  pillarCount: 4,           // ≥3 lobes + one spare for acoustic-shadow survival
  pillarHp: 44,             // silence task readable at F60; not a second boss (Quill FINAL)
  phrasePillars: 3,         // silenced pillars to complete a phrase (checkpoint)
  pressureRadius: 260,      // activation / phrase pressure
  sheetHalfWidth: 16, // 2-tile directional sheet (half-width = 16px = 1 tile)
  sheetDamage: 2,           // soft pressure, never wipe (Quill FINAL)
  wrongPillarPressure: 1,   // soft escalate damage ping
  roarDuration: 1.0,
  roarDamageReduction: 0.35,
  roarBulletClearRadius: 72,
} as const;

export function choirmasterHpForFloor(floor: number): number {
  return anchoredBossHp(CHOIRMASTER.baseHp, CHOIRMASTER.baseHpFloor, floor);
}

export function choirPillarHpForFloor(floor: number): number {
  return Math.max(1, anchoredBossHp(CHOIRMASTER.pillarHp, CHOIRMASTER.baseHpFloor, floor));
}
// ---- UNDERTOW (F65 STEAL/ESCAPE — THE RIVER COMES BACK signature) ----
// Batch2B OWNER LOCK: reverse-floor pursuit (structureKind 'escape'). Timings LOCKED at 20Hz:
//   1.6s full-width flood tell → 1.2s advancing front through current room → 3.5s forced-manifestation punish (±1 tick).
// ONE isBossKind undertow when manifested; warm_pulse / relief_vent / flood front = mechanic entities.
// Success = deposit Warm Pulse in highlighted relief vent before front arrives → openBossWindow(3.5).
// Survival = drop Pulse + shelter in marked alcove (no window). Failure = capped hit+KB; never wipe.
// BLACK_TIDE retired — story name THE RIVER COMES BACK everywhere (wire: river_comes_back).
// Calibrated on EXPOSED time (deposit-gated like deep roster): deep-boss band between Choirmaster F60 and
// Pale F75 — earned RIVER COMES BACK windows are the pacing, not chip or sponge HP (Quill FINAL).
export const UNDERTOW = {
  baseHp: 940,
  baseHpFloor: 65,
  phaseAt: [0.66, 0.33] as readonly number[],
  phaseFloor: [0.58, 0.25] as readonly number[],
  guardMult: 0.20,        // deposit-gated chip band (matches Choir / Choirmaster deep earned-window gate)
  windowBankFrac: 0.22,   // ≥2 successful deposits per phase (matches deep roster Choir / Jet band)
  contactDamage: 2,
  entranceGrace: 1.4,
  attackCd: [0, 3.0, 2.7, 2.4] as readonly number[],
  // THE RIVER COMES BACK timings (seconds) — authoritative at TICK_HZ=20; tests allow ±1 tick.
  riverTell: 1.6,
  riverFront: 1.2,
  riverPunish: 3.5,
  // Escape / Pulse / vents
  pressureRadius: 240,
  floodSpeed: 140,          // front advance (px/s) along current room/edge
  pulsePickupGrace: 1.5,    // seconds after carrier leave before Pulse is world-pickup
  ventHp: 1,                // deposit target — contact/interact, not a DPS sponge
  pulseHp: 1,
  ventsPerRoute: 3,         // relief vents along reverse journey
  alcoveHalfWidth: 28,      // marked shelter radius for survival
  riverFrontDamage: 2,      // soft capped failure hit
  riverFrontKb: 180,
  roarDuration: 1.0,
  roarDamageReduction: 0.35,
  roarBulletClearRadius: 72,
  manifestHpFrac: 0.0,      // manifested body uses full undertow HP pool
} as const;

export function undertowHpForFloor(floor: number): number {
  return anchoredBossHp(UNDERTOW.baseHp, UNDERTOW.baseHpFloor, floor);
}

export function undertowVentHpForFloor(floor: number): number {
  return Math.max(1, anchoredBossHp(UNDERTOW.ventHp, UNDERTOW.baseHpFloor, floor));
}

// ---- CLAIMANT (F70 PASS-THE-CLAIM — ALL THINGS OWED signature) ----
// Batch3A OWNER LOCK: ONE compact coordination arena (structureKind 'arena'). Timings LOCKED
// at 20Hz: 1.4s angular crown/beam tell → aim locks at 0.84s (60% of tell) → 0.6s descent →
// 3.0s kneel punish (±1 tick). ONE isBossKind claimant; claim_token / claim_socket = mechanic
// entities. Verb PASS-THE-CLAIM: one player carries the claim-token (the marked target);
// carrier fire cannot break the guard (heavily reduced, NEVER immune), so the team must
// deliberately pass. Three correct passes / socket deposits bait an overcommit → ALL THINGS
// OWED. Success = deposit token into the lit socket after aim lock and before impact → the
// crown hits an empty socket, shatters → boss kneels → openBossWindow(3.0). Survival = carrier
// dashes perpendicular out of the crown-lane (keeps token, no window). Failure = capped hit+KB
// to the carrier; anti-one-shot holds; run remains winnable.
// CROWNFALL retired — story name ALL THINGS OWED everywhere (wire: all_things_owed).
// Calibrated on EXPOSED time (pass/deposit-gated like deep roster): deep-boss band between Undertow F65 and
// Pale F75 — earned ALL THINGS OWED windows are the pacing, not chip or sponge HP (Quill FINAL).
export const CLAIMANT = {
  baseHp: 1020,
  baseHpFloor: 70,
  phaseAt: [0.66, 0.33] as readonly number[],
  phaseFloor: [0.58, 0.25] as readonly number[],
  guardMult: 0.20,        // pass/deposit-gated chip band (matches Choir / Choirmaster / Undertow deep earned-window gate)
  carrierGuardMult: 0.08, // PASS-THE-CLAIM identity: carrier fire stays strongly below guardMult (chip, never immune)
  windowBankFrac: 0.22,   // ≥2 successful Owed deposits per phase (matches deep roster Choir / Jet band)
  contactDamage: 2,
  entranceGrace: 1.4,
  attackCd: [0, 3.0, 2.7, 2.4] as readonly number[],
  // ALL THINGS OWED timings (seconds) — authoritative at TICK_HZ=20; tests allow ±1 tick.
  owedTell: 1.4,
  owedLockFrac: 0.6,   // aim locks at 0.6 × 1.4 = 0.84s into the tell (≥0.30s reaction remains)
  owedDescent: 0.6,
  owedPunish: 3.0,
  // Coordination arena / token / sockets
  pressureRadius: 240,
  passesToOvercommit: 3,    // correct passes / socket deposits that bait the overcommit
  socketCount: 4,           // claim sockets around the arena (one lights during the Owed cast)
  laneHalfWidth: 46,        // crown-lane half-width; perpendicular dash beyond it = survival
  laneLength: 520,          // elongated crown-lane reach (not circular)
  // The token / sockets are indestructible coordination MARKERS (deposit points, never DPS
  // sponges): a high pool keeps incidental AoE / stray fire from removing them and soft-locking
  // the pass loop. They despawn with the Claimant on boss death (endBossDanger).
  tokenHp: 9999,
  socketHp: 9999,
  depositRadius: 40,        // carrier proximity to a socket that counts a deposit
  tokenPickupGrace: 1.2,    // seconds before an absent carrier's token becomes a world-pickup
  owedFailDamage: 2,        // soft capped failure hit to the carrier
  owedFailKb: 200,
  roarDuration: 1.0,
  roarDamageReduction: 0.35,
  roarBulletClearRadius: 72,
} as const;

export function claimantHpForFloor(floor: number): number {
  return anchoredBossHp(CLAIMANT.baseHp, CLAIMANT.baseHpFloor, floor);
}

// ---- THE WAKE (F80 PROTECT/ADVANCE — THE LAST PROCESSION signature) ----
// Batch3B OWNER LOCK: ONE cross-room escort/convoy (structureKind 'escort'). Timings LOCKED at
// 20Hz: 1.5s blackout/flood tell → a dark front follows the convoy to the threshold (moving-front)
// → 4.0s light-bound manifestation punish (±1 tick). ONE isBossKind wake (the shadow that
// manifests at thresholds); warm_bier / convoy_blocker / shadow_front = mechanic entities. Verb
// PROTECT/ADVANCE: an autonomous last-light convoy advances spawn→exit across ≥2 RoomEdges; the
// team escorts it inside a continuous warmth corridor (the convoy aura) and clears one highlighted
// blocker before each threshold while the dark front closes from behind. Success = stay in the
// aura AND clear the blocker before the threshold → the convoy crosses on-beat → the Wake is
// forced into light → openBossWindow(4.0); crossing the FINAL threshold custom-completes the floor.
// Survival = step to a side shelter outside the path → the convoy stalls (no window). Failure =
// bounded warmth/progress loss + a capped hit to players in the dark-front lane; anti-one-shot
// holds; never a wipe/soft-lock.
// NIGHTFALL_PROCESSION retired — story name THE LAST PROCESSION everywhere (wire: last_procession).
// Calibrated on EXPOSED time (procession-gated like deep roster): Claimant F70 FINAL 1020 + F70→F80 step —
// earned THE LAST PROCESSION windows are the pacing, not chip or sponge HP (Quill FINAL).
export const WAKE = {
  baseHp: 1140,
  baseHpFloor: 80,
  phaseAt: [0.66, 0.33] as readonly number[],
  phaseFloor: [0.58, 0.25] as readonly number[],
  guardMult: 0.20,        // procession-gated chip band (matches Choir / Undertow / Claimant deep earned-window gate)
  windowBankFrac: 0.22,   // ≥2 light windows per phase (matches deep roster Choir / Jet band)
  contactDamage: 2,
  entranceGrace: 1.5,
  attackCd: [0, 3.0, 2.7, 2.4] as readonly number[],
  // THE LAST PROCESSION timings (seconds) — authoritative at TICK_HZ=20; tests allow ±1 tick. The
  // FRONT is a moving-front (it follows the convoy to the threshold), bounded by frontMaxDuration.
  processionTell: 1.5,
  processionLockFrac: 0.6,   // aim locks at 0.6 × 1.5 = 0.90s into the tell (≥0.30s reaction remains)
  processionPunish: 4.0,
  frontMaxDuration: 2.0,     // moving-front cap — the dark front reaches the threshold within this
  // Escort / convoy
  pressureRadius: 240,
  thresholdCount: 2,         // thresholds the convoy crosses (≥2 RoomEdges spawn→exit)
  convoyAdvanceRate: 0.35,   // fraction of the current segment advanced per second (autonomous)
  convoyHoldFrac: 0.9,       // the convoy waits this far into a segment for the escort (crosses on success)
  processionTriggerFrac: 0.5,// convoy progress into a segment that baits THE LAST PROCESSION
  auraRadius: 130,           // continuous warmth-corridor radius around the bier (safe corridor)
  laneHalfWidth: 48,         // dark-front lane half-width; a side shelter beyond it = survival
  // The bier / shadow_front are indestructible MARKERS (a high pool keeps incidental AoE from
  // removing them and soft-locking the convoy). The convoy_blocker is the destructible peel target.
  bierHp: 9999,
  shadowFrontHp: 9999,
  blockerHp: 72,             // short burst peel at threshold, not free
  processionFailDamage: 2,   // soft capped failure hit to players caught in the dark-front lane
  processionFailKb: 200,
  warmthLossOnFailure: 0.2,  // bounded convoy-warmth loss on failure (never zeroes / soft-locks)
  roarDuration: 1.0,
  roarDamageReduction: 0.35,
  roarBulletClearRadius: 72,
} as const;

export function wakeHpForFloor(floor: number): number {
  return anchoredBossHp(WAKE.baseHp, WAKE.baseHpFloor, floor);
}

// ---- PALE THRONE (F75 GIANT #2 — the Pale region cap; the SECOND giant, reusing the AD-LOCKED
// Gorge shell-peel template EXACTLY via the shared giant-encounter core) ----
// A colossal ~192px STATIONARY front-facing set-piece PINNED to floor 75, mechanically IDENTICAL
// to Gorge (same 3-phase shell-peel, same weak-point peel verb, same rings/zones/spokes) — only
// the MATERIAL is COLD (warmth-drain, never amber; a client-render/telegraph swap, no sim impact)
// and the calibration is the region-cap step. PALE is Gorge's grammar with (a) the balancer's
// HP/bank calibration overridden and (b) the per-phase PATTERN params surfaced as explicit GD
// variant slots; the shared giant MACHINERY (guard, the roar crack-off transition, contact damage,
// entrance grace, seam durability, debris) is inherited by spread so it can never drift (and F100
// Unmaker slots in the same way).
//
// CALIBRATION (balancer, F75 EXPLICIT anchor — see paleHpForFloor for why NOT the §3 curve):
//   - total 1220 = a modest 1.3× Gorge's 930 (a felt PRESTIGE step for the region cap, NOT a
//     sponge; hard ceiling ~1.35× = 1260, never exceeded). The F50→F75 difficulty is carried by
//     MECHANICS (the tightened per-phase bank + the higher min-legal floor), not HP — because
//     player DPS is flat this deep, HP can't be the lever without sponging (which the giant rule
//     forbids).
//   - per-shell [340, 380, 500] (stone/cracked/core), still BACK-LOADED (rind<chitin<core) so the
//     fight escalates INTO the cold core reveal.
//   - windowBankFrac 0.20 (TIGHTER than Gorge's 0.22): a deep high-roll build sits at the top of
//     the flat DPS band, so the region-cap giant needs the full ~5 windows/phase with NO slack —
//     0.20 caps the core window at ~100 dmg (500/100 = 5 windows; rind 68, chitin 76 → 5 each).
export const PALE = {
  ...GORGE,
  shellHp: [340, 380, 500] as readonly number[], // stone / cracked / core (F75 explicit anchor)
  baseHpFloor: 75,
  // phaseAt[k] = the cumulative-from-full complement of shellHp = [1 - 340/1220, 1 - 720/1220] =
  // [0.7213, 0.4098] (kept in lockstep with shellHp; pale.test.ts asserts the two agree). phaseFloor
  // is the anti-burst floor (queued overflow lands after the crack-off), ~0.08 under each threshold.
  phaseAt: [0.7213, 0.4098] as readonly number[],
  phaseFloor: [0.64, 0.33] as readonly number[],
  windowBankFrac: 0.20,
  // ---- per-phase PATTERN + PEEL-TASK params (the GD's F75 variant slots) ----
  // For NOW these MIRROR Gorge (the encounter reuses the Gorge patterns — see the scaling gate's
  // exposed-efficiency check, which surfaces this as the sponge failure mode until the variants
  // land). The GD's F75 variants — tighter windows, denser telegraphs in disjoint lanes, a phase-3
  // wrinkle — drop in HERE, in one obvious place, without touching the shared giant core. Named
  // explicitly (overriding the spread) so a variant lands cleanly and the two giants' patterns
  // diverge independently. The scaling gate then proves F75's exposed-efficiency drops below F50's.
  //
  // Peel task + earned windows (tighter windows = shorter seamLife / peelExpose, denser = more/wider seams):
  peelExpose: 3.2,
  seamBaseByShell: [2, 3, 4] as readonly number[],       // seams per exposure, per shell (solo base)
  seamPerPlayer: 1,
  seamCap: 6,
  seamRingDist: 96,
  seamArcByShell: [Math.PI * 0.55, Math.PI * 0.85, Math.PI * 1.0] as readonly number[], // front-arc width per shell (disjoint lanes)
  seamExposeInterval: 1.4,
  seamFirstAt: 2.0,
  seamLifeByShell: [11.0, 9.5, 8.0] as readonly number[], // the exposure retract window, per shell (the "tighten" knob)
  attackCd: [0, 3.0, 2.8, 2.4] as readonly number[],      // spatial-pattern cadence, per phase
  // P1 RADIAL ring — KEEP Gorge's gap/count/speed (the 2nd ring is the difficulty, NOT a narrower
  // gap); TIGHTEN the windup 0.9→0.7 (>0.6 floor) + recover 0.7→0.5 (>0.35 floor).
  ringWindup: 0.7, ringRecover: 0.5, ringCount: 16, ringGap: 3, ringSpeed: 240, ringDebris: 2, ringDebrisDist: 150,
  // P2 ZONING slag pools — KEEP zoneCount 3 (the DRIFT is the difficulty, not more pools) + zoneCap
  // 10 (so it churns, never seals ≤ ⅓ arena); TIGHTEN windup 0.8→0.7 + recover 0.7→0.5.
  zoneWindup: 0.7, zoneRecover: 0.5, zoneCount: 3, zoneRing: 150, zoneRadius: 30, zoneLife: 9.0, zoneCap: 10,
  // P3 CONVERGENT spokes — the counter-rotation is the difficulty. The wider gaps and slower
  // angular step preserve a continuous walk-only route while warmth-drain is at its ×0.5 worst.
  spokeWindup: 0.7, spokeRecover: 0.4, spokeDuration: 3.0, spokeInterval: 0.2, spokeCount: 18, spokeGap: 12, spokeStep: 0.03, spokeSpeed: 250,
  // The shared projectile glob (shape across all three patterns):
  globRadius: 8, globDamage: 1, globLife: 2.8,
  // ---- THE F75 MECHANICS STEP: one NEW READABLE AXIS per phase + the PALE cross-cutting SIGNATURE
  // (GD doctrine — escalate by adding a second thing to READ, never by tightening the same pattern;
  // the shared giant core switches each axis on because these fields are present, absent on Gorge).
  // Each is chosen to lower exposed-efficiency (add read/motion load), the proof metric. ----
  // P1 SEQUENCING — ring 1 releases into an immediately armed exact ring-2 footprint. The next
  // gap shifts one slot around the rim and leaves enough time for the far edge of gap A to walk
  // into gap B with margin; dash remains a rescue, never the required answer.
  ring2DelaySec: 1.1,
  ring2GapOffsetSlots: 1,
  seamBanksMinPlayers: 2,
  seamBankMinSeparationRad: Math.PI / 2,
  // P2 POSITIONING-OVER-TIME — each pool CREEPS outward ~1 tile / 1.5s (0.67 tiles/s) AND new pools
  // seed at the edge of the nearest-to-expiring one (churn), so the safe floor MIGRATES; zoneCap 10
  // keeps total denial ≤ ⅓ arena (never seals the pocket — pale.test.ts asserts it).
  zoneSpreadTilesPerSec: 0.67,
  isZoneChurnEnabled: true,
  // P3 DUAL-READ — a counter-rotating second wheel with the same readable rate and widened gap.
  // The time-integrated navigation gate owns the physical proof over persistent projectiles,
  // pools, debris, walls, player radius, and worst-case warmth slow.
  spoke2Step: -0.03,
  spokeLife: 2.0,
  // THE PALE SIGNATURE — WARMTH-DRAIN (P3-ONLY, the prestige "the Pale turns on you" finale beat;
  // gated to the core-reveal phase in resolveWarmthDrain). Stay within ~½ tile for > warmthDrainIdleSec
  // → move ×warmthDrainSlow (the shipped CHILL_SLOW); clears the instant you move warmthDrainMoveClearTiles.
  // Punishes camping — coherent with the three motion axes. A slow, NEVER damage, never stacks into a
  // stun; telegraphed by a frost vignette ramping over the idle window. Per-player, deterministic.
  warmthDrainIdleSec: 1.5,
  warmthDrainMoveClearTiles: 1.0,
  warmthDrainSlow: 0.5,     // = CHILL_SLOW (constants.ts) — a single ×0.5, capped there
  // THE LAST LIGHT FALLS (OWNER LOCK signature ult — success counter, NOT warmth-drain):
  // 1.8s ceiling/meteor tell → three sequential scar relights (≥0.65s each, one active) →
  // 1.0s redirected fall → 4.0s core punish. Authoritative at TICK_HZ=20; tests allow ±1 tick.
  lastLightTell: 1.8,
  lastLightScarCommit: 0.65,
  lastLightScarCount: 3,
  lastLightFall: 1.0,
  lastLightPunish: 4.0,
  lastLightScarHp: 18,          // highlighted scar target HP (mechanic body)
  lastLightCadence: 14.0,       // seconds between signature commits (spatial patterns fill the rest)
} as const;

export function paleHpForFloor(): number {
  // F75 is a FRESH EXPLICIT anchor, deliberately NOT ridden up the §3 floor curve from Gorge's
  // F50. The FLOOR_HP_MULT curve CLAMPS flat past F10, so floorHpMult(75)/floorHpMult(50) === 1.00
  // — riding the curve would hand F75 the SAME 930 as F50 (no increase at all). refDpsForFloor
  // also clamps flat this deep, so players are NOT out-DPSing F50 at F75. HP therefore cannot be
  // the difficulty lever without pure sponge (the giant rule forbids it): the F50→F75 step lives
  // in MECHANICS (the tightened bank + the higher min-legal), with HP a modest 1.3× prestige bump.
  // So the giant's pool is the LITERAL per-shell F75 anchor, summed — floor-independent by design.
  let hp = 0;
  for (const shell of PALE.shellHp) hp += shell;
  return hp;
}

// The fraction of the giant's pool held by shell `phase` (1..3) — drives the PER-PHASE window bank
// (0.20 × this shell's HP chunk). Back-loaded: stone < cracked < core. Mirrors gorgeShellFracFor.
export function paleShellFracFor(phase: number): number {
  const total = PALE.shellHp.reduce((a, b) => a + b, 0);
  return PALE.shellHp[Math.max(0, Math.min(PALE.shellHp.length - 1, phase - 1))] / total;
}

// One weak-point's HP at a floor (the peel-task pacing — a mechanic body, NEVER part of the giant's
// own pool). Anchored at F75. Mirrors gorgeSeamHpForFloor.
export function paleSeamHpForFloor(floor: number): number {
  return Math.max(1, anchoredBossHp(PALE.seamHp, PALE.baseHpFloor, floor));
}

// N weak-points for a shell phase (1..3) at the snapshotted party size — the co-op TASK scale
// (more players = more seams, never fatter HP). Capped for readability. Mirrors gorgeSeamCountFor.
export function paleSeamCountFor(phase: number, players: number): number {
  const base = PALE.seamBaseByShell[Math.max(0, Math.min(PALE.seamBaseByShell.length - 1, phase - 1))];
  const p = Math.max(1, Math.min(4, players));
  return Math.min(PALE.seamCap, base + (p - 1) * PALE.seamPerPlayer);
}

// ---- §5f the F10 MINIBOSS GAUNTLET (corrected gate §3, exact formula) ----
// Three sequential CAPTAINS derived from calibrated Marrow HP — commander round10(.28×),
// elite round10(.32×), brute round10(.40×), total 1.00× — with 5s intermissions after
// rounds 1 and 2, never more than one captain alive, and the next spawn waiting until
// the prior captain, its summons AND its hazards are all dead/cleared. Round composition
// per the gate: R1 Charger commander + max 4 simple adds; R2 Shielder elite + max 3
// ranged adds; R3 brute Burrower alone. Each captain runs TWO phases split at 50% with
// one 0.8s NON-invulnerable transition and no phase floor. +1 heart drops only after R2;
// no blessing until the full clear (the premium chest carries the rare offer).

export interface GauntletRound {
  kind: EnemyKind;
  tier: EnemyTier;
  hpFrac: number;        // fraction of the calibrated Marrow HP (.28/.32/.40)
  addKind: EnemyKind | null;
  addTier: EnemyTier;
  addCount: number;
}

export const GAUNTLET = {
  floor: 10,
  intermission: 5,          // seconds after R1 and R2 before the next captain enters
  captainPhaseAt: 0.5,      // two phases split at 50%…
  captainTransition: 0.8,   // …one short stagger, non-invulnerable, no floor
  // Round threat stays inside the gate caps (≤8/≤8/≤6 counting the captain's elite/brute
  // pricing): R1 4.5 + 3×1.0 = 7.5, R2 4.5 + 3×0.825 ≈ 7.0, R3 4.2 alone.
  rounds: [
    { kind: "charger", tier: "elite", hpFrac: 0.28, addKind: "slime", addTier: "standard", addCount: 3 },
    { kind: "shielder", tier: "elite", hpFrac: 0.32, addKind: "spitter", addTier: "swarm", addCount: 3 },
    { kind: "burrower", tier: "brute", hpFrac: 0.40, addKind: null, addTier: "swarm", addCount: 0 },
  ] as readonly GauntletRound[],
  heartAfterRound: 2,       // +1 heart only after R2
  // The premium reward: the gauntlet's boss chest bakes the Burst rifle — Rootbound's
  // formation-fire signature (no full boss signature is duplicated).
  chestWeapon: "burst" as WeaponId,
} as const;

export function gauntletCaptainHp(round: GauntletRound): number {
  return Math.round((round.hpFrac * CAPTAIN_HP_BASE) / 10) * 10;
}

// ---- §3 the boss-facing damage model ("no legal build below high-roll minimum") ----
// The balancer's remediation path, implemented WITHOUT any runtime clamp: repeat-hit
// bugs are gone (the spent-round rule, regression-gated), raw caps hold across 100k
// generated builds, and the two offending interactions are re-coefficiented AGAINST
// BOSSES/CAPTAINS ONLY — room/multitarget power is untouched:
//   1. Boss VULNERABILITY is one capped channel and status amps are OUT of it: against
//      a boss-grade body, shock/frozen deal their utility (arcs, slow, DoT) but no
//      damage amplification, and the crit multiplier counts at most 1.35× — combined
//      vulnerability ≤1.35, non-multiplicative by construction. Rooms keep the full
//      multiplicative behavior (Deadeye Lv3 crits at 3.0×, statuses amplify).
//   2. Pellet boss coefficient: a big body soaking every stacked pellet was the
//      single-target exploit. Native pellets beyond the first count at 75% against
//      boss-grade bodies; ADDED pellets count 0 — they stay
//      full-power room tools. Rooms always take full pellet damage.
//   3. Per-family boss coefficients for the measured offenders (full-arsenal god-stack
//      sweep): the point-blank hoses (flamer, sawnoff), the sustained pin (beam), the
//      burst/cannon/railgun nukes and the melee blade loop — each sized so its 12-pick
//      god stack lands ≥ the minimum, with room damage untouched.
// The 100k practical-DPS estimator gate (balance tests) proves the strongest legal build
// stays under every per-boss DPS ceiling: King 53 / Marrow 68 / Weaver 87 / Warden 65 /
// Choir 65 — each ceiling = HP over (minimum TTK − forced transition time).

export const BOSS_MIN_LEGAL_TTK: Readonly<Partial<Record<EnemyKind, number>>> = {
  boss: 20, marrow: 20, weaver: 20, gilded: 22, choir: 22,
};

// Per-boss practical-DPS ceilings from the balancer (HP / (minTtk − forced downtime)).
export const BOSS_DPS_CEILING: Readonly<Partial<Record<EnemyKind, number>>> = {
  boss: 53, marrow: 68, weaver: 87, gilded: 65, choir: 65,
  // Wave-1 deep bosses (F35/40/45): PROVISIONAL backstop ceilings from the balancer — a
  // pure 100k-build expectedBossDps sweep tops out at 47.9 practical DPS, so 55 is a safe
  // "nothing may exceed this" guard (non-breaking today, catches any future build spike).
  // TIGHTEN to the measured design value when the multi-boss harness lands its per-boss bot.
  jet: 55, tithe: 55, quorum: 55,
  // GORGE (F50 giant): PROVISIONAL backstop ceiling in line with the deep roster (the 100k-build
  // sweep tops out ~47.9 practical DPS, so 55 is a safe non-breaking guard). The multi-boss health
  // gate CALIBRATES the giant's real bands (its per-shell HP + peel task pace the true TTK).
  gorge: 55,
  // PALE THRONE (F75 giant): PROVISIONAL backstop ceiling, same 55 as the deep roster / Gorge (the
  // giant's real bands are calibrated by the multi-boss health gate). Re-measure on build.
  pale: 55,
};

// ---- the balancer envelope's canonical unit ----
// 1 PU (Pistol Unit) = the pistol's practical single-target DPS: 2 dmg / 0.16s = 12.5.
// Every arsenal power band is stated in PU (test/arsenal.test.ts envelope gates):
// neutral boss sustained 0.85–1.15 PU, ideal specialist ≤1.35, 3s burst ≤1.60 (risk
// archetypes ≤1.75), passive/unattended sources ≤0.55.
export const PU_DPS = 12.5;

// Persistent party sources (turret bolts, trap snaps — output that keeps running while
// nobody aims it) may contribute at most this fraction of the party's practical boss
// DPS budget (partySize × PU_DPS) in any rolling one-second window. Overflow is
// deterministically truncated in strikeEnemy — a turret farm can never out-damage the
// players standing in the fight.
export const PERSISTENT_BOSS_DPS_FRAC = 0.25;

export const HOMING_SPLIT = {
  maxHomingPellets: 2,
  extraTurnRateMult: 0.4,
  extraDamageMult: 0.6,
} as const;

export const PHASE_NO_LOS_DAMAGE_MULT = 0.4;

// Boss-facing combat coefficients (rooms/multitarget are never touched).
export const BOSS_VULN_CAP = 1.35;           // the crit channel's cap vs boss-grade bodies
export const BOSS_NATIVE_PELLET_COEF = 0.75; // native pellets beyond the first
export const BOSS_EXTRA_PELLET_COEF = 0;     // added pellets: room tools, zero vs bosses
export const SIDE_CHANNEL = {
  normalDamageByLevel: [0.55, 0.65, 0.75] as const,
  bossDamageByLevel: [0.30, 0.34, 0.38] as const,
  armedWindowByLevel: [2.0, 2.3, 2.6] as const,
  icdByLevel: [1.20, 1.05, 0.90] as const,
  aimWindow: 0.40,
  aimDelta: Math.PI / 2,
  meaningfulAimDelta: 0.01,
} as const;
export const WEAPON_BOSS_COEF: Readonly<Partial<Record<WeaponId, number>>> = {
  beam: 0.78,     // sustained pin: 100% uptime on an arena-sized body (envelope: 0.86 PU)
  sawnoff: 0.5,   // point-blank full-fan burst
  flamer: 0.45,   // point-blank sustained hose (envelope: with the boss burn cap, a
                  // parked hose peaks ~1.26 PU — inside the 1.35 specialist ceiling)
  burst: 0.62,    // the fan volley is a ROOM tool: its boss coefficient is priced like
                  // the other pack weapons (all-rounder remediation — it held the boss,
                  // room and safety top quartiles at once at 0.75)
  cannon: 0.95,
  railgun: 0.9,
  sword: 0.55,    // the melee loop parks on the body with zero travel/spread loss
  longsword: 0.55,
  spear: 0.55,    // same parked-uptime pricing as the other blades
  // Effect wave. Lastlight's low-HP curve can be held at max indefinitely by a careful
  // player, so its boss coefficient prices the uptime; the parked/planted families
  // (sentry bolts, wire snaps, orbit contact) hit boss-grade bodies at room-tool rates.
  lastlight: 0.8,
  breach: 0.85,
  snapwire: 0.6,
  frostline: 0.6,
  halo: 0.48,
  sentry: 0.6,
  crook: 0.6,
  // Legendaries stay inside the envelope: the Midas' coin-fed hits would otherwise ride a
  // full x2 into the boss window (its coin drain is no brake on a stocked purse — the
  // envelope bands it FED, like the Lastlight is banded at risk), and the Umbra's
  // through-wall pin has zero exposure cost against an arena body.
  midas: 0.58,
  phase: 0.8,
  // Content wave. The pack/room tools are priced like the other pack weapons so their
  // multi-body room job never doubles as a boss melt; the Cleaver's deep pierce and the
  // Singularity's implosion+nova both land their full payload on multiple bodies, so both
  // are boss-coefficient priced. The single-target Arcbolt/Tracker keep the neutral 1.0.
  cleaver: 0.6, skipper: 0.55, firebomb: 0.6, singularity: 0.5,
  // The Arcbolt taxes a pack via shock (amp + arc) — a room verb, priced like the other pack
  // weapons vs a boss (its shock amplifies nothing on boss-grade bodies).
  arcbolt: 0.6,
  mooring_nail: 0.7,
  sluicegate: 0.65,
  oddsmaker: 0.75,
  pathmaker: 0.55,
  // Wave B (Quill FINAL): the fire-time base coefficient is the weapon's PRIMARY channel;
  // secondary channels (red_pen snap 0.65, margin copy 0.60) are re-priced in their own
  // fire paths in world.ts.
  resonant_fork: 0.7,
  red_pen: 0.85,
  margin_call: 0.9,
  sidewinder: 0.55,
  // Wave C (Quill FINAL): the fire-time base coefficient is the weapon's PRIMARY channel.
  // Backtalk's fire-time base is the STUB (0.90); its RETURN channel (0.65) is re-priced in
  // its own return path (like the red_pen snap). Faultlink echoes (room 0.25 / boss 0.15)
  // ride the primary coefficient's boss factor in their echo path.
  hushiron: 0.72,
  backtalk: 0.90,
  lamplighter: 0.65,
  faultlink: 0.70,
};

// ---- §6 power budget: raw caps (temporary per-run blessings) ----
// The 4–6× strong-run fantasy is EXPRESSIVE capability (pellets/pierce/status/crit/
// positioning), never a product of raw flat stats. Enforced in the authoritative sim
// after a full build recompute from item levels.

export const CAPS = {
  damageMult: 2.25,
  fireRateMult: 1.80,
  moveSpeedMult: 1.35,
  maxHpBonus: 4,
  pierce: 3,          // blessing-ADDED pierce (weapon-intrinsic pierce is separate)
  elementalChance: 0.5,
} as const;

// Permanent (Foundation) power: no permanent gear system exists in the runtime yet; when
// it lands, the strongest legal loadout advantage must stay under this ceiling (§6/§7 gate 8).
export const PERMANENT_ADVANTAGE_CEILING = 0.30;

// ---- §8 co-op scaling (Stage C authoritative combat) ----
// P = living players snapshotted at encounter creation (floor build), clamped 1–4; living
// enemies are never rescaled on disconnect/down.

export const COOP = {
  maxPlayers: 4,
  mobHpPerExtra: 0.55,    // 1.00 / 1.55 / 2.10 / 2.65
  bossHpPerExtra: 0.65,   // 1.00 / 1.65 / 2.30 / 2.95
  threatPerExtra: 0.35,   // 1.00 / 1.35 / 1.70 / 2.05
  kbResistPerExtra: 0.20,
  heartRatePerExtra: 0.30,
  // Coin income is PER-PLAYER (no shared wallet) and the premium ladder prices are
  // P-invariant, so each member's income must be roughly party-size-invariant too: floor
  // coins are first-come (a party SPLITS them ~P ways) while the threat budget only grows
  // ~2× by P4, so an uncompensated member would earn ~1/3 of solo. Collected coin VALUE
  // scales by this AUTHORED per-P table (calibrated by the premium economy harness so
  // each party size passes the balancer's pool gates — the table is authored rather than
  // linear because coinGain's integer rounding interacts with Greed's ×2/2.5/3 levels).
  // Values only — drop chances, the taper, and Greed's identity are untouched, and solo
  // (×1.00) is unchanged.
  coinGainMult: [1.0, 1.7, 2.4, 3.1] as readonly number[],
  // Enemy damage: unchanged P1–3; ×1.10 at P4 authored as explicit integers — every
  // current source is 1 or 2, and both round back to themselves, so damage stays as-is.
} as const;

export function clampPlayers(players: number): number {
  return Math.max(1, Math.min(COOP.maxPlayers, Math.floor(players)));
}

export function coopMobHpMult(players: number): number {
  return 1 + COOP.mobHpPerExtra * (clampPlayers(players) - 1);
}

// Headcount-only boss-grade scaling — the GAUNTLET CAPTAINS' and MINIBOSSES' curve.
// The five real bosses ride the R framework instead (bossHpFracFor over the measured
// party+gear ratio — headcount is inside R, never multiplied in separately).
export function coopBossHpMult(players: number): number {
  return 1 + COOP.bossHpPerExtra * (clampPlayers(players) - 1);
}

export function coopThreatMult(players: number): number {
  return 1 + COOP.threatPerExtra * (clampPlayers(players) - 1);
}

export function coopKbResistMult(players: number): number {
  return 1 + COOP.kbResistPerExtra * (clampPlayers(players) - 1);
}

export function coopHeartRateMult(players: number): number {
  return 1 + COOP.heartRatePerExtra * (clampPlayers(players) - 1);
}

export function coopCoinGainMult(players: number): number {
  return COOP.coinGainMult[clampPlayers(players) - 1];
}

// ---- §8b party weapon opportunities (studio balance gate §4 — Stage C shared worlds only) ----
// Quantity increases OPTIONS, never rarity or stats: weapon stats and roll pools are
// identical solo/co-op; only opportunity COUNTS follow the gate's exact formulas, and every
// count is deterministic per (seed, floor, P). The local solo economy is untouched
// (golden-locked); a shared world applies §4 at every P including 1.

export const WEAPON_ECONOMY = {
  // Boss reward choices are capped regardless of party size.
  bossChoiceCap: 5,
  // Boss weapon claims expire on the sim clock like blessing offers (the descend gate must
  // always drain); each claimant gets exactly one reroll, never coins/raw damage.
  claimTtl: 60,
  claimRerolls: 1,
  // Starvation guard (gate §4): no player goes more than this many consecutive non-boss
  // floors without a weapon opportunity — the next floor force-stocks a pedestal.
  maxDroughtFloors: 2,
} as const;

// Weapons per pedestal (gate: `max(1, ceil(P/2))` — P1–2: 1, P3–4: 2), distinct IDs when
// the pool permits. The pedestal COUNT per floor stays the solo cadence.
export function pedestalWeaponsFor(players: number): number {
  return Math.max(1, Math.ceil(clampPlayers(players) / 2));
}

// Boss weapon reward (gate: `P+1` distinct choices, capped 5): every member claims ONE
// personal choice from the shared set; claims never remove choices for teammates.
export function bossWeaponChoicesFor(players: number): number {
  return Math.min(clampPlayers(players) + 1, WEAPON_ECONOMY.bossChoiceCap);
}
