// The per-run weapon DEAL (playtest: "I keep getting the same few guns before the slime
// boss"). Every free weapon source — floor pedestals, the boss chest's extra choices, the
// wood-chest ambient roll, the owned-duplicate claim reroll — draws from ONE seeded
// shuffled bag of PICKUP_WEAPONS instead of sampling uniform-with-replacement, so a run
// deals DISTINCT guns across the early floors and two runs on different seeds deal them
// in different orders. Pure data + pure functions: the bag lives in WorldState beside
// w.rng, is reset with the run (createWorld / resetRunInWorld — never per floor), and is
// only ever advanced by the one authority (LocalTransport solo, the server online), so
// same seed + same inputs -> same drops on every client.

import type { WeaponId, WeaponRarity } from "./types.js";
import { WEAPONS } from "./weapons.js";
import {
  CURRENT_CONTENT_CATALOG_VERSION,
  LEGACY_CONTENT_CATALOG_VERSION,
  contentCatalogFor,
} from "./contentCatalog.js";
import type { ContentCatalogVersion } from "./contentCatalog.js";
import { Rng } from "./rng.js";
import {
  createWeaponOfferHistory,
  recordWeaponOffer,
  weaponSeenWeight,
} from "./offerHistory.js";
import type { WeaponOfferHistory } from "./offerHistory.js";

export interface WeaponBag extends WeaponOfferHistory {
  seed: number;        // the run seed the shuffles derive from
  catalogVersion?: ContentCatalogVersion;
  order: WeaponId[];   // the undealt remainder of the current pass
  refills: number;     // completed passes
  weightedDraws: number;
}

// Own seed stream, like every placement system (props 0x2f6a35c1, pedestals 0x51ed270b, …):
// the bag can never perturb enemy/loot rolls, and vice versa.
const BAG_SALT = 0x3b9a5e17;

export function createWeaponBag(
  seed: number,
  catalogVersion: ContentCatalogVersion = CURRENT_CONTENT_CATALOG_VERSION,
): WeaponBag {
  const history = createWeaponOfferHistory();
  const bag: WeaponBag = {
    seed,
    catalogVersion,
    order: [],
    refills: 0,
    weightedDraws: 0,
    ...history,
  };
  refillBag(bag);
  return bag;
}

// Fisher-Yates over the full pickup pool, keyed by (run seed, pass index) — deterministic,
// and every pass reshuffles differently so a long run doesn't loop one fixed order.
function refillBag(bag: WeaponBag): void {
  const rng = new Rng((bag.seed ^ BAG_SALT) + bag.refills * 0x1f83d9ab);
  const order = [...contentCatalogFor(weaponBagCatalogVersion(bag)).pickupWeapons];
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [order[i], order[j]] = [order[j], order[i]];
  }
  bag.order = order;
  bag.refills++;
}

function takeAt(bag: WeaponBag, idx: number): WeaponId {
  const pick = bag.order.splice(idx, 1)[0];
  recordWeaponOffer(bag, pick);
  return pick;
}

export function rollWeaponOfferWithHistory(
  candidates: readonly WeaponId[],
  rand: () => number,
  history: WeaponOfferHistory,
  exclude: ReadonlySet<WeaponId> = new Set(),
): WeaponId {
  const unique = [...new Set(candidates)];
  if (unique.length === 0) throw new Error("weapon offer pool is empty");

  const unexcluded = unique.filter((id) => !exclude.has(id));
  let pool = unexcluded.length > 0 ? unexcluded : unique;
  const outsideRecent = pool.filter((id) => !history.recentWeaponOffers.includes(id));
  if (outsideRecent.length > 0) pool = outsideRecent;

  let total = 0;
  for (const id of pool) total += weaponSeenWeight(history, id);
  let roll = rand() * total;
  let pick = pool[pool.length - 1];
  for (const id of pool) {
    roll -= weaponSeenWeight(history, id);
    if (roll <= 0) {
      pick = id;
      break;
    }
  }
  recordWeaponOffer(history, pick);
  return pick;
}

// Deal the next weapon: the first undealt id not in `exclude` (weapons the drop would
// waste — owned by every player, or already in this batch), preferring one that also
// dodges the recent-drop history across a refill boundary. When everything undealt is
// excluded, the bag deals a fresh pass early (dealt-but-unowned guns come back into
// play); when the player owns the entire pool a duplicate is allowed — never an
// infinite loop, never a dead draw.
//
// `rarity` is the rarity system's tier REQUEST (see rollWeaponRarity): when the current
// pass still holds an undealt weapon of that tier, the deal comes from the tier; when the
// tier is spent (or fully excluded), the draw falls through to the plain deal below — the
// weighting is statistical, the deal's variety contract is absolute. Callers enforce the
// legendary floor gate through `exclude`, whose skip-while-others-remain semantics
// already guarantee a draw never hangs.
export function drawWeaponFromBag(bag: WeaponBag, exclude: ReadonlySet<WeaponId>, rarity?: WeaponRarity): WeaponId {
  const pickupWeapons = contentCatalogFor(weaponBagCatalogVersion(bag)).pickupWeapons;
  if (bag.order.length > 0 && rarity !== undefined) {
    const fitsTier = (id: WeaponId): boolean => WEAPONS[id].rarity === rarity && !exclude.has(id);
    let idx = bag.order.findIndex((id) => fitsTier(id) && !bag.recentWeaponOffers.includes(id));
    if (idx < 0) idx = bag.order.findIndex(fitsTier);
    if (idx >= 0) return takeAt(bag, idx);
  }
  if (bag.order.length > 0) {
    let idx = bag.order.findIndex((id) => !exclude.has(id) && !bag.recentWeaponOffers.includes(id));
    if (idx < 0) idx = bag.order.findIndex((id) => !exclude.has(id));
    if (idx >= 0) return takeAt(bag, idx);
    bag.order.length = 0;
  }

  const rng = new Rng(
    (bag.seed ^ BAG_SALT)
    + 0x1f83d9ab
    + bag.weightedDraws * 0x6a09e667,
  );
  bag.weightedDraws++;
  if ((bag.weightedDraws - 1) % pickupWeapons.length === 0) bag.refills++;
  const tierPool = rarity === undefined
    ? pickupWeapons
    : pickupWeapons.filter((id) => WEAPONS[id].rarity === rarity);
  return rollWeaponOfferWithHistory(tierPool, () => rng.next(), bag, exclude);
}

export function weaponBagCatalogVersion(bag: WeaponBag): ContentCatalogVersion {
  return bag.catalogVersion ?? LEGACY_CONTENT_CATALOG_VERSION;
}
