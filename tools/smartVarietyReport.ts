import {
  createBlessingOfferHistory,
  recordBlessingOffer,
} from "../src/sim/offerHistory.js";
import {
  createWeaponBag,
  drawWeaponFromBag,
} from "../src/sim/weaponBag.js";
import {
  ITEMS,
  itemLevelsOf,
  itemMaxLevel,
  rollItemChoicesWith,
} from "../src/sim/items.js";
import {
  PICKUP_WEAPONS,
  WEAPONS,
  rollWeaponRarity,
} from "../src/sim/weapons.js";
import { Rng } from "../src/sim/rng.js";
import type { ItemDef } from "../src/sim/items.js";
import type { WeaponId, WeaponRarity } from "../src/sim/types.js";

interface Report {
  seeds: number;
  weapon: {
    offers: number;
    unseenBeforeExhaustionRate: number;
    avoidableLastEightRepeats: number;
    lastEightRepeatRate: number;
    requestedRarity: Record<WeaponRarity, number>;
    selectedRarity: Record<WeaponRarity, number>;
    refillRequestedRarity: Record<WeaponRarity, number>;
    refillSelectedRarity: Record<WeaponRarity, number>;
  };
  blessing: {
    offers: number;
    unseenGuaranteeViolations: number;
    consecutiveViolations: number;
    upgradeCapViolations: number;
    maxedCardViolations: number;
    premiumCoreLeaks: number;
  };
}

function seedCount(): number {
  const raw = process.argv.find((arg) => arg.startsWith("--seeds="))?.slice("--seeds=".length);
  const parsed = raw === undefined ? 1000 : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1000;
}

function rarityCounts(): Record<WeaponRarity, number> {
  return { common: 0, rare: 0, legendary: 0 };
}

function eligibleBlessings(owned: readonly string[], isRareOnly: boolean): ItemDef[] {
  const levels = itemLevelsOf(owned);
  return ITEMS.filter((item) =>
    item.isPremiumOnly !== true
    && (!isRareOnly || item.rarity === "rare")
    && (levels.get(item.id) ?? 0) < itemMaxLevel(item)
  );
}

const seeds = seedCount();
const report: Report = {
  seeds,
  weapon: {
    offers: 0,
    unseenBeforeExhaustionRate: 0,
    avoidableLastEightRepeats: 0,
    lastEightRepeatRate: 0,
    requestedRarity: rarityCounts(),
    selectedRarity: rarityCounts(),
    refillRequestedRarity: rarityCounts(),
    refillSelectedRarity: rarityCounts(),
  },
  blessing: {
    offers: 0,
    unseenGuaranteeViolations: 0,
    consecutiveViolations: 0,
    upgradeCapViolations: 0,
    maxedCardViolations: 0,
    premiumCoreLeaks: 0,
  },
};

let unseenWeaponOpportunities = 0;
let unseenWeaponHits = 0;
let lastEightRepeats = 0;

for (let seedIndex = 0; seedIndex < seeds; seedIndex++) {
  const seed = (seedIndex + 1) * 7919;
  const weaponBag = createWeaponBag(seed);
  const weaponTierRng = new Rng(seed ^ 0x51ed270b);
  const weaponSeen = new Set<WeaponId>();
  const recentWeapons: WeaponId[] = [];

  for (let floor = 1; floor <= 80; floor++) {
    const requested = rollWeaponRarity(() => weaponTierRng.next(), floor);
    const selected = drawWeaponFromBag(weaponBag, new Set(), requested);
    report.weapon.offers++;
    report.weapon.requestedRarity[requested]++;
    report.weapon.selectedRarity[WEAPONS[selected].rarity]++;
    if (floor > PICKUP_WEAPONS.length) {
      report.weapon.refillRequestedRarity[requested]++;
      report.weapon.refillSelectedRarity[WEAPONS[selected].rarity]++;
    }
    if (weaponSeen.size < PICKUP_WEAPONS.length) {
      unseenWeaponOpportunities++;
      if (!weaponSeen.has(selected)) unseenWeaponHits++;
    }
    if (recentWeapons.includes(selected)) {
      lastEightRepeats++;
      const tierAlternatives = PICKUP_WEAPONS.filter((id) =>
        WEAPONS[id].rarity === WEAPONS[selected].rarity
        && !recentWeapons.includes(id)
      );
      if (tierAlternatives.length > 0) report.weapon.avoidableLastEightRepeats++;
    }
    weaponSeen.add(selected);
    recentWeapons.push(selected);
    if (recentWeapons.length > 8) recentWeapons.shift();
  }

  const blessingHistory = createBlessingOfferHistory();
  const blessingRng = new Rng(seed ^ 0x0b1e55);
  const ownedBlessings: string[] = [];
  let previousBlessings: string[] = [];

  for (let floor = 1; floor <= 80; floor++) {
    const isRareOnly = floor % 5 === 0;
    const eligible = eligibleBlessings(ownedBlessings, isRareOnly);
    if (eligible.length === 0) continue;
    const unseen = eligible.filter((item) =>
      (blessingHistory.blessingSeenCounts[item.id] ?? 0) === 0
    );
    const levels = itemLevelsOf(ownedBlessings);
    const choices = rollItemChoicesWith(
      3,
      () => blessingRng.next(),
      ownedBlessings,
      { isRareOnly, history: blessingHistory },
    );
    report.blessing.offers++;
    if (unseen.length > 0 && !choices.some((item) => unseen.includes(item))) {
      report.blessing.unseenGuaranteeViolations++;
    }
    const nonPrevious = eligible.filter((item) => !previousBlessings.includes(item.id));
    if (nonPrevious.length >= choices.length && choices.some((item) => previousBlessings.includes(item.id))) {
      report.blessing.consecutiveViolations++;
    }
    if (unseen.length > 0 && choices.filter((item) => levels.has(item.id)).length > 1) {
      report.blessing.upgradeCapViolations++;
    }
    if (choices.some((item) => (levels.get(item.id) ?? 0) >= itemMaxLevel(item))) {
      report.blessing.maxedCardViolations++;
    }
    if (choices.some((item) => item.isPremiumOnly === true)) {
      report.blessing.premiumCoreLeaks++;
    }
    previousBlessings = choices.map((item) => item.id);
    recordBlessingOffer(blessingHistory, previousBlessings);
    if (choices.length > 0) ownedBlessings.push(choices[0].id);
  }
}

report.weapon.unseenBeforeExhaustionRate = unseenWeaponOpportunities === 0
  ? 1
  : unseenWeaponHits / unseenWeaponOpportunities;
report.weapon.lastEightRepeatRate = report.weapon.offers === 0
  ? 0
  : lastEightRepeats / report.weapon.offers;

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

const isPassing =
  report.weapon.unseenBeforeExhaustionRate >= 0.85
  && report.weapon.avoidableLastEightRepeats === 0
  && report.weapon.lastEightRepeatRate < 0.15
  && (["common", "rare", "legendary"] as const).every((rarity) =>
    report.weapon.refillRequestedRarity[rarity] === report.weapon.refillSelectedRarity[rarity]
  )
  && report.blessing.unseenGuaranteeViolations === 0
  && report.blessing.consecutiveViolations === 0
  && report.blessing.upgradeCapViolations === 0
  && report.blessing.maxedCardViolations === 0
  && report.blessing.premiumCoreLeaks === 0;

if (!isPassing) process.exit(1);
