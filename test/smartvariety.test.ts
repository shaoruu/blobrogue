import {
  createBlessingOfferHistory,
  createWeaponOfferHistory,
  blessingHistoryWeight,
  recordBlessingOffer,
  recordWeaponOffer,
} from "../src/sim/offerHistory.js";
import {
  createWeaponBag,
  drawWeaponFromBag,
  rollWeaponOfferWithHistory,
} from "../src/sim/weaponBag.js";
import type { WeaponBag } from "../src/sim/weaponBag.js";
import {
  ITEMS, MAX_ITEM_LEVEL, itemMaxLevel, normalItemsForCatalog, rollItemChoicesWith,
} from "../src/sim/items.js";
import {
  createWorld,
  buyFromShopInWorld,
  loadFloorIntoWorld,
  resetRunInWorld,
  rollBlessingChoicesInWorld,
  spawnPlayerInWorld,
} from "../src/sim/world.js";
import type { PlayerSim, WorldState } from "../src/sim/world.js";
import {
  buildShopState,
  shopSlotForViewer,
} from "../src/sim/shop.js";
import type { ShopSlot } from "../src/sim/shop.js";
import { generateDungeon } from "../src/sim/dungeon.js";
import { PICKUP_WEAPONS, WEAPONS } from "../src/sim/weapons.js";
import { Rng } from "../src/sim/rng.js";
import type { WeaponId } from "../src/sim/types.js";
import {
  LEGACY_CONTENT_CATALOG_VERSION,
  WAVE_A_CONTENT_CATALOG_VERSION,
  contentCatalogFor,
} from "../src/sim/contentCatalog.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    process.stdout.write(`  PASS ${name}${detail ? ` — ${detail}` : ""}\n`);
    return;
  }
  failed++;
  failures.push(name);
  process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ""}\n`);
}

function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

function partyWorld(seed: number, floor: number, ids: readonly string[]): WorldState {
  const world = createWorld(seed, floor, { isShared: true, skipLocalPlayer: true });
  for (const id of ids) spawnPlayerInWorld(world, id);
  loadFloorIntoWorld(world, floor);
  return world;
}

function personalSlot(world: WorldState, player: PlayerSim, kind: ShopSlot["kind"]): ShopSlot | undefined {
  const slot = world.shop?.slots.find((candidate) => candidate.kind === kind);
  return slot && world.shop ? shopSlotForViewer(world.shop, slot, player.id) : undefined;
}

section("catalog contracts");
{
  const normal = ITEMS.filter((item) => item.isPremiumOnly !== true && item.isPvpOnly !== true);
  const premium = ITEMS.filter((item) => item.isPremiumOnly === true);
  const pvpOnly = ITEMS.filter((item) => item.isPvpOnly === true);
  const counts = {
    common: normal.filter((item) => item.rarity === "common").length,
    uncommon: normal.filter((item) => item.rarity === "uncommon").length,
    rare: normal.filter((item) => item.rarity === "rare").length,
  };
  check("50 weapons include the pistol and 49 are pickup offers",
    Object.keys(WEAPONS).length === 50
    && PICKUP_WEAPONS.length === 49
    && !PICKUP_WEAPONS.includes("pistol"));
  check("53 blessings split into 46 co-op normal, 4 premium cores, 3 pvp-only counters",
    ITEMS.length === 53 && normal.length === 46 && premium.length === 4 && pvpOnly.length === 3);
  check("normal blessing rarities are exactly 10 common, 21 uncommon, 15 rare",
    counts.common === 10 && counts.uncommon === 21 && counts.rare === 15,
    JSON.stringify(counts));
}

section("owner-accepted catalog rate drift");
{
  const weaponRates = (version: 0 | 1, isLegendaryOpen: boolean): [number, number, number] => {
    const pool = contentCatalogFor(version).pickupWeapons;
    const common = pool.filter((id) => WEAPONS[id].rarity === "common").length * 10;
    const rare = pool.filter((id) => WEAPONS[id].rarity === "rare").length * 5;
    const legendary = isLegendaryOpen
      ? pool.filter((id) => WEAPONS[id].rarity === "legendary").length
      : 0;
    const total = common + rare + legendary;
    return [common / total * 100, rare / total * 100, legendary / total * 100];
  };
  const blessingRates = (version: 0 | 1): [number, number, number] => {
    const pool = normalItemsForCatalog(version);
    const common = pool.filter((item) => item.rarity === "common").length * 10;
    const uncommon = pool.filter((item) => item.rarity === "uncommon").length * 6;
    const rare = pool.filter((item) => item.rarity === "rare").length * 3;
    const total = common + uncommon + rare;
    return [common / total * 100, uncommon / total * 100, rare / total * 100];
  };
  const near = (actual: number, expected: number): boolean => Math.abs(actual - expected) < 0.0006;
  const legacyOpen = weaponRates(LEGACY_CONTENT_CATALOG_VERSION, true);
  const waveAOpen = weaponRates(WAVE_A_CONTENT_CATALOG_VERSION, true);
  const legacyEarly = weaponRates(LEGACY_CONTENT_CATALOG_VERSION, false);
  const waveAEarly = weaponRates(WAVE_A_CONTENT_CATALOG_VERSION, false);
  const legacyBlessing = blessingRates(LEGACY_CONTENT_CATALOG_VERSION);
  const waveABlessing = blessingRates(WAVE_A_CONTENT_CATALOG_VERSION);
  check("open weapon C/R/L drift is exactly 47.393/49.763/2.844 → 47.414/49.569/3.017",
    [47.393, 49.763, 2.844].every((expected, index) => near(legacyOpen[index], expected))
    && [47.414, 49.569, 3.017].every((expected, index) => near(waveAOpen[index], expected)));
  check("pre-F4 weapon C/R drift is exactly 48.780/51.220 → 48.889/51.111",
    [48.780, 51.220].every((expected, index) => near(legacyEarly[index], expected))
    && [48.889, 51.111].every((expected, index) => near(waveAEarly[index], expected)));
  check("normal blessing C/U/R drift is exactly 36.842/50.526/12.632 → 40.000/48.000/12.000",
    [36.842, 50.526, 12.632].every((expected, index) => near(legacyBlessing[index], expected))
    && [40.000, 48.000, 12.000].every((expected, index) => near(waveABlessing[index], expected)));
}

section("weapon first pass and history-aware refills");
{
  const deal = (seed: number): WeaponId[] => {
    const bag = createWeaponBag(seed);
    return PICKUP_WEAPONS.map(() => drawWeaponFromBag(bag, new Set()));
  };
  const first = deal(0x51a7);
  check("the first free-bag pass remains a no-repeat permutation",
    new Set(first).size === PICKUP_WEAPONS.length
    && first.every((id) => PICKUP_WEAPONS.includes(id)));
  check("the first pass remains deterministic", first.join(",") === deal(0x51a7).join(","));

  const bag = createWeaponBag(0x80ff);
  bag.order = [];
  const draws: WeaponId[] = [];
  for (let i = 0; i < 80; i++) {
    const id = drawWeaponFromBag(bag, new Set(), "common");
    draws.push(id);
  }
  let isRecentClean = true;
  for (let i = 0; i < draws.length; i++) {
    if (draws.slice(Math.max(0, i - 8), i).includes(draws[i])) isRecentClean = false;
  }
  check("second-pass common offers never repeat inside the last eight while alternatives exist",
    isRecentClean);
  check("second-pass selection never flattens the requested rarity",
    draws.every((id) => WEAPONS[id].rarity === "common"));

  const saturated = createWeaponOfferHistory();
  const rare = PICKUP_WEAPONS.filter((id) => WEAPONS[id].rarity === "rare").slice(0, 2);
  for (const id of rare) recordWeaponOffer(saturated, id);
  const pickA = rollWeaponOfferWithHistory(rare, () => 0.25, saturated);
  const saturatedAgain = createWeaponOfferHistory();
  for (const id of rare) recordWeaponOffer(saturatedAgain, id);
  const pickB = rollWeaponOfferWithHistory(rare, () => 0.25, saturatedAgain);
  check("a saturated tier has a deterministic fallback", pickA === pickB && rare.includes(pickA));
}

section("weapon seen-count weights and owned exclusion");
{
  const candidates = PICKUP_WEAPONS.filter((id) => WEAPONS[id].rarity === "common").slice(0, 3);
  const counts = new Map<WeaponId, number>(candidates.map((id) => [id, 0]));
  for (let seed = 1; seed <= 12000; seed++) {
    const history = createWeaponOfferHistory();
    history.weaponSeenCounts[candidates[1]] = 1;
    history.weaponSeenCounts[candidates[2]] = 2;
    const rng = new Rng(seed * 7919);
    const pick = rollWeaponOfferWithHistory(candidates, () => rng.next(), history);
    counts.set(pick, (counts.get(pick) ?? 0) + 1);
  }
  const unseen = counts.get(candidates[0]) ?? 0;
  const once = counts.get(candidates[1]) ?? 0;
  const repeated = counts.get(candidates[2]) ?? 0;
  check("seeded weighted picks order unseen ×3 > seen once ×1 > seen 2+ ×0.25",
    unseen > once * 2.5 && once > repeated * 3,
    `${unseen}/${once}/${repeated}`);

  const history = createWeaponOfferHistory();
  for (const id of candidates) recordWeaponOffer(history, id);
  const onlyUnowned = candidates[1];
  const excluded = new Set(candidates.filter((id) => id !== onlyUnowned));
  const pick = rollWeaponOfferWithHistory(candidates, () => 0.99, history, excluded);
  check("owned weapons stay excluded while one requested-tier alternative remains",
    pick === onlyUnowned);
}

section("weapon history serialization");
{
  const bag = createWeaponBag(0x5e12);
  for (let i = 0; i < 41; i++) drawWeaponFromBag(bag, new Set(), i % 2 === 0 ? "common" : "rare");
  const saved = JSON.stringify(bag);
  const expected = drawWeaponFromBag(bag, new Set(), "rare");
  const restored = JSON.parse(saved) as WeaponBag;
  const actual = drawWeaponFromBag(restored, new Set(), "rare");
  check("restoring the plain bag/history reproduces the exact next offer", actual === expected);
}

section("independent weapon source streams");
{
  const seed = 0x51de;
  const room = generateDungeon(seed, 3).rooms.find((candidate) => candidate.kind === "shop")!;
  const historyA = createWeaponOfferHistory();
  const historyB = createWeaponOfferHistory();
  for (const id of PICKUP_WEAPONS.slice(0, 12)) {
    recordWeaponOffer(historyB, id);
    if (PICKUP_WEAPONS.indexOf(id) % 2 === 0) recordWeaponOffer(historyB, id);
  }
  const dealerA = buildShopState(seed, 3, room, [], 1, historyA);
  const dealerB = buildShopState(seed, 3, room, [], 1, historyB);
  const sourceFingerprint = (worldShop: NonNullable<WorldState["shop"]>): string =>
    JSON.stringify(worldShop.slots.map((slot) => ({
      kind: slot.kind,
      price: slot.price,
      rarity: slot.weapon === null ? null : WEAPONS[slot.weapon].rarity,
      isMystery: slot.isMystery,
      twist: slot.twist,
    })));
  check("Dealer history changes only identity choice, not cadence, rarity, price, or twist",
    sourceFingerprint(dealerA) === sourceFingerprint(dealerB));

  const bag = createWeaponBag(seed);
  const orderBefore = bag.order.join(",");
  const weightedDrawsBefore = bag.weightedDraws;
  buildShopState(seed, 3, room, [], 1, bag);
  check("Dealer consultation never advances the free-bag order or refill RNG ordinal",
    bag.order.join(",") === orderBefore && bag.weightedDraws === weightedDrawsBefore);

  const premiumWorld = createWorld(seed, 29, { isShared: true, skipLocalPlayer: true });
  const partyHistoryBefore = JSON.stringify(premiumWorld.weaponBag);
  const premiumPlayer = spawnPlayerInWorld(premiumWorld, "runtime-pid", "stable-account");
  check("personal Premium projection advances only personal history and ordinals",
    JSON.stringify(premiumWorld.weaponBag) === partyHistoryBefore
    && Object.keys(premiumPlayer.weaponOfferHistory.weaponSeenCounts).length > 0
    && premiumPlayer.shopWeaponOfferOrdinal > 0);
}

section("blessing history weights and complete-offer memory");
{
  const history = createBlessingOfferHistory();
  recordBlessingOffer(history, ["age4"]);
  recordBlessingOffer(history, ["age3"]);
  recordBlessingOffer(history, ["age2"]);
  recordBlessingOffer(history, ["latest"]);
  check("the immediately previous offer weighs ×0.10",
    blessingHistoryWeight(history, "latest") === 0.1);
  check("offers aged two through four weigh ×0.35",
    ["age2", "age3", "age4"].every((id) => blessingHistoryWeight(history, id) === 0.35));
  check("never-presented blessings weigh ×2 and older seen blessings weigh ×1",
    blessingHistoryWeight(history, "new") === 2
    && blessingHistoryWeight({
      blessingSeenCounts: { old: 1 },
      recentBlessingOffers: history.recentBlessingOffers,
    }, "old") === 1);
}

section("normal and rare blessing guarantees");
{
  const normal = ITEMS.filter((item) => item.isPremiumOnly !== true && item.isPvpOnly !== true);
  const history = createBlessingOfferHistory();
  const rng = new Rng(0xb1e55);
  let isPityHeld = true;
  let isConsecutiveClean = true;
  let previous: string[] = [];
  for (let offer = 0; offer < 20; offer++) {
    const unseenBefore = normal.filter((item) => (history.blessingSeenCounts[item.id] ?? 0) === 0);
    const choices = rollItemChoicesWith(3, () => rng.next(), [], { history });
    if (unseenBefore.length > 0 && !choices.some((item) => unseenBefore.some((unseen) => unseen.id === item.id))) {
      isPityHeld = false;
    }
    if (normal.length - previous.length >= 3 && choices.some((item) => previous.includes(item.id))) {
      isConsecutiveClean = false;
    }
    previous = choices.map((item) => item.id);
    recordBlessingOffer(history, previous);
  }
  check("every normal offer contains an unseen eligible blessing while one remains", isPityHeld);
  check("normal offers do not repeat the immediately previous cards before saturation",
    isConsecutiveClean);

  const rareDefs = normal.filter((item) => item.rarity === "rare");
  const rareOwned = rareDefs.flatMap((item) => Array(itemMaxLevel(item)).fill(item.id) as string[]);
  const noRares = rollItemChoicesWith(3, () => 0.5, rareOwned, {
    isRareOnly: true,
    history: createBlessingOfferHistory(),
  });
  check("an exhausted rare-only source never falls across rarity", noRares.length === 0);

  let isCoreFree = true;
  for (let seed = 0; seed < 500; seed++) {
    const localRng = new Rng(seed * 3571 + 1);
    const choices = rollItemChoicesWith(3, () => localRng.next(), [], {
      history: createBlessingOfferHistory(),
    });
    if (choices.some((item) => item.isPremiumOnly === true)) isCoreFree = false;
  }
  check("premium cores never leak into normal offers", isCoreFree);
}

section("upgrade cap and max-level exclusion");
{
  const history = createBlessingOfferHistory();
  const upgradeIds = ITEMS
    .filter((item) => item.isPremiumOnly !== true && item.isPvpOnly !== true)
    .slice(0, 12)
    .map((item) => item.id);
  const choices = rollItemChoicesWith(3, () => 0.99, upgradeIds, { history });
  check("at most one upgrade card appears while unseen eligible blessings remain",
    choices.filter((item) => upgradeIds.includes(item.id)).length <= 1);

  const nearSaturation = createBlessingOfferHistory();
  const normal = ITEMS.filter((item) => item.isPremiumOnly !== true && item.isPvpOnly !== true);
  const lastUnseen = normal[normal.length - 1];
  for (const item of normal) {
    if (item !== lastUnseen) nearSaturation.blessingSeenCounts[item.id] = 1;
  }
  const nearSaturationOwned = normal.slice(0, 6).map((item) => item.id);
  const fullOffer = rollItemChoicesWith(3, () => 0.5, nearSaturationOwned, {
    history: nearSaturation,
  });
  check("the final unseen card exhausts pity and the offer still fills all three cards",
    fullOffer.length === 3 && fullOffer.some((item) => item.id === lastUnseen.id));

  const fallbackPool = normal.slice(0, 5);
  const fallbackHistory = createBlessingOfferHistory();
  const previousIds = fallbackPool.slice(0, 2).map((item) => item.id);
  const fallbackUpgrades = fallbackPool.slice(2, 4).map((item) => item.id);
  for (const item of fallbackPool.slice(0, 4)) fallbackHistory.blessingSeenCounts[item.id] = 1;
  fallbackHistory.recentBlessingOffers.push(previousIds);
  const fallbackOffer = rollItemChoicesWith(
    3,
    () => 0.5,
    fallbackUpgrades,
    { history: fallbackHistory, eligibleItems: fallbackPool },
  );
  check("previous-offer cards provide the saturated fallback without adding a second upgrade",
    fallbackOffer.length === 3
    && fallbackOffer.filter((item) => fallbackUpgrades.includes(item.id)).length === 1
    && fallbackOffer.some((item) => previousIds.includes(item.id)));

  const maxed = ITEMS.find((item) => item.isPremiumOnly !== true)!;
  const owned = Array(MAX_ITEM_LEVEL).fill(maxed.id) as string[];
  const withoutMaxed = rollItemChoicesWith(30, () => 0.5, owned, {
    history: createBlessingOfferHistory(),
  });
  check("maxed Lv3 blessings never appear", withoutMaxed.every((item) => item.id !== maxed.id));
}

section("per-player offer streams and reconnect state");
{
  const build = (order: readonly string[]): WorldState => partyWorld(0x0ff3a, 2, order);
  const ab = build(["pA", "pB"]);
  const ba = build(["pB", "pA"]);
  const abA = rollBlessingChoicesInWorld(ab, "pA", false).map((item) => item.id);
  const abB = rollBlessingChoicesInWorld(ab, "pB", false).map((item) => item.id);
  const baB = rollBlessingChoicesInWorld(ba, "pB", false).map((item) => item.id);
  const baA = rollBlessingChoicesInWorld(ba, "pA", false).map((item) => item.id);
  check("teammate iteration order never changes either player's offer",
    abA.join(",") === baA.join(",") && abB.join(",") === baB.join(","));

  const stableA = createWorld(0x0ff3d, 2, { isShared: true, skipLocalPlayer: true });
  const stableB = createWorld(0x0ff3d, 2, { isShared: true, skipLocalPlayer: true });
  spawnPlayerInWorld(stableA, "p1", "account-42");
  spawnPlayerInWorld(stableB, "p99", "account-42");
  const stableOfferA = rollBlessingChoicesInWorld(stableA, "p1", false).map((item) => item.id);
  const stableOfferB = rollBlessingChoicesInWorld(stableB, "p99", false).map((item) => item.id);
  check("stable account identity, not transient runtime pid, keys personal offers",
    stableOfferA.join(",") === stableOfferB.join(","));

  const world = partyWorld(0x0ff3b, 4, ["stable-player"]);
  const player = world.players.get("stable-player")!;
  for (let i = 0; i < 6; i++) rollBlessingChoicesInWorld(world, player.id, false);
  const savedHistory = JSON.stringify(player.blessingOfferHistory);
  const savedOrdinal = player.blessingOfferOrdinal;
  const expected = rollBlessingChoicesInWorld(world, player.id, false).map((item) => item.id);
  const replay = partyWorld(0x0ff3b, 4, ["stable-player"]);
  const replayPlayer = replay.players.get("stable-player")!;
  replayPlayer.blessingOfferHistory = JSON.parse(savedHistory);
  replayPlayer.blessingOfferOrdinal = savedOrdinal;
  const actual = rollBlessingChoicesInWorld(replay, replayPlayer.id, false).map((item) => item.id);
  check("restored player history and ordinal reproduce the exact next offer",
    actual.join(",") === expected.join(","));

  player.isBlessingRerollArmed = true;
  resetRunInWorld(world, 0x0ff3c);
  check("a new run clears personal presentation histories and ordinals",
    player.blessingOfferHistory.recentBlessingOffers.length === 0
    && Object.keys(player.blessingOfferHistory.blessingSeenCounts).length === 0
    && player.weaponOfferHistory.recentWeaponOffers.length === 1
    && Object.values(player.weaponOfferHistory.weaponSeenCounts).reduce((sum, count) => sum + count, 0) === 1
    && player.blessingOfferOrdinal === 0
    && !player.isBlessingRerollArmed);
}

section("Dealer and Premium viewer projections");
{
  const first = partyWorld(0xdea1, 3, ["pA", "pB"]);
  const second = partyWorld(0xdea1, 3, ["pB", "pA"]);
  let isOrderStable = true;
  for (const id of ["pA", "pB"]) {
    const a = first.players.get(id)!;
    const b = second.players.get(id)!;
    const aSlot = personalSlot(first, a, "blessing");
    const bSlot = personalSlot(second, b, "blessing");
    if (aSlot?.itemId !== bSlot?.itemId) isOrderStable = false;
  }
  check("Dealer blessing projection is stable per viewer regardless of teammate order",
    isOrderStable);

  const stableShopA = createWorld(0xdea1, 3, { isShared: true, skipLocalPlayer: true });
  const stableShopB = createWorld(0xdea1, 3, { isShared: true, skipLocalPlayer: true });
  const stablePlayerA = spawnPlayerInWorld(stableShopA, "p1", "account-42");
  const stablePlayerB = spawnPlayerInWorld(stableShopB, "p99", "account-42");
  const stableCardA = personalSlot(stableShopA, stablePlayerA, "blessing");
  const stableCardB = personalSlot(stableShopB, stablePlayerB, "blessing");
  check("stable account identity also keys viewer-specific shop stock",
    stableCardA?.itemId === stableCardB?.itemId);

  const maxedWorld = createWorld(0xdea2, 3, { isShared: true, skipLocalPlayer: true });
  const maxedPlayer = spawnPlayerInWorld(maxedWorld, "viewer");
  const maxedIds = ITEMS.filter((item) => item.isPremiumOnly !== true && item.isPvpOnly !== true).slice(0, 10);
  for (const item of maxedIds) {
    for (let level = 0; level < itemMaxLevel(item); level++) maxedPlayer.ownedItemIds.push(item.id);
  }
  loadFloorIntoWorld(maxedWorld, 3);
  const dealerCard = personalSlot(maxedWorld, maxedPlayer, "blessing");
  check("Dealer never displays a maxed card to its viewer",
    dealerCard?.itemId !== null && !maxedIds.some((item) => item.id === dealerCard?.itemId));

  let premiumWorld: WorldState | null = null;
  for (let seed = 1; seed <= 200 && premiumWorld === null; seed++) {
    const candidate = partyWorld(seed, 9, ["viewer"]);
    if (candidate.shop?.slots.some((slot) => slot.kind === "rare_blessing")) premiumWorld = candidate;
  }
  const premiumPlayer = premiumWorld?.players.get("viewer");
  const premiumCard = premiumWorld && premiumPlayer
    ? personalSlot(premiumWorld, premiumPlayer, "rare_blessing")
    : undefined;
  check("Premium rare blessing projection stays inside the rare normal pool",
    premiumCard?.itemId !== null
    && ITEMS.some((item) =>
      item.id === premiumCard?.itemId
      && item.rarity === "rare"
      && item.isPremiumOnly !== true
    ));

  const bossWorld = partyWorld(0xb055, 5, ["viewer"]);
  const bossChoices = rollBlessingChoicesInWorld(bossWorld, "viewer", true);
  check("boss rare-only pity remains inside its eight-item rare pool",
    bossChoices.length === 3
    && bossChoices.every((item) => item.rarity === "rare" && item.isPremiumOnly !== true));

  const rerollWorld = partyWorld(0xdea3, 3, ["pA", "pB"]);
  const reroller = rerollWorld.players.get("pA")!;
  const reroll = rerollWorld.shop!.slots.find((slot) => slot.kind === "reroll")!;
  reroller.coins = reroll.price;
  reroller.x = reroll.x;
  reroller.y = reroll.y;
  const seenBefore = Object.values(reroller.weaponOfferHistory.weaponSeenCounts)
    .reduce((sum, count) => sum + count, 0);
  buyFromShopInWorld(rerollWorld, reroller.id, reroll.id, []);
  const seenAfter = Object.values(reroller.weaponOfferHistory.weaponSeenCounts)
    .reduce((sum, count) => sum + count, 0);
  check("shared Dealer rerolls enter every incumbent viewer's personal presentation memory",
    seenAfter > seenBefore);
}

process.stdout.write(`\nsmart variety: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const failure of failures) process.stdout.write(`  FAIL ${failure}\n`);
  process.exit(1);
}
