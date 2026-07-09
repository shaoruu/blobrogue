// The per-run weapon DEAL (playtest: "I keep getting the same few guns before the slime
// boss"). Every free weapon source — floor pedestals, the boss chest's extra choices, the
// wood-chest ambient roll, the owned-duplicate claim reroll — draws from ONE seeded
// shuffled bag of PICKUP_WEAPONS instead of sampling uniform-with-replacement, so a run
// deals DISTINCT guns across the early floors and two runs on different seeds deal them
// in different orders. Pure data + pure functions: the bag lives in WorldState beside
// w.rng, is reset with the run (createWorld / resetRunInWorld — never per floor), and is
// only ever advanced by the one authority (LocalTransport solo, the server online), so
// same seed + same inputs -> same drops on every client.

import type { WeaponId } from "./types.js";
import { PICKUP_WEAPONS } from "./weapons.js";
import { Rng } from "./rng.js";
import { WEAPON_VARIETY } from "./balance.js";

export interface WeaponBag {
  seed: number;        // the run seed the shuffles derive from
  order: WeaponId[];   // the undealt remainder of the current pass
  refills: number;     // completed shuffles — keys each pass to its own derived stream
  recent: WeaponId[];  // last few dealt ids, so a fresh pass never opens on a repeat
}

// Own seed stream, like every placement system (props 0x2f6a35c1, pedestals 0x51ed270b, …):
// the bag can never perturb enemy/loot rolls, and vice versa.
const BAG_SALT = 0x3b9a5e17;

export function createWeaponBag(seed: number): WeaponBag {
  const bag: WeaponBag = { seed, order: [], refills: 0, recent: [] };
  refillBag(bag);
  return bag;
}

// Fisher-Yates over the full pickup pool, keyed by (run seed, pass index) — deterministic,
// and every pass reshuffles differently so a long run doesn't loop one fixed order.
function refillBag(bag: WeaponBag): void {
  const rng = new Rng((bag.seed ^ BAG_SALT) + bag.refills * 0x1f83d9ab);
  const order = [...PICKUP_WEAPONS];
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [order[i], order[j]] = [order[j], order[i]];
  }
  bag.order = order;
  bag.refills++;
}

function takeAt(bag: WeaponBag, idx: number): WeaponId {
  const pick = bag.order.splice(idx, 1)[0];
  bag.recent.push(pick);
  if (bag.recent.length > WEAPON_VARIETY.recentDrops) bag.recent.shift();
  return pick;
}

// Deal the next weapon: the first undealt id not in `exclude` (weapons the drop would
// waste — owned by every player, or already in this batch), preferring one that also
// dodges the recent-drop history across a refill boundary. When everything undealt is
// excluded, the bag deals a fresh pass early (dealt-but-unowned guns come back into
// play); when the player owns the entire pool a duplicate is allowed — never an
// infinite loop, never a dead draw.
export function drawWeaponFromBag(bag: WeaponBag, exclude: ReadonlySet<WeaponId>): WeaponId {
  for (let pass = 0; pass < 2; pass++) {
    if (bag.order.length === 0) refillBag(bag);
    let idx = bag.order.findIndex((id) => !exclude.has(id) && !bag.recent.includes(id));
    if (idx < 0) idx = bag.order.findIndex((id) => !exclude.has(id));
    if (idx >= 0) return takeAt(bag, idx);
    bag.order.length = 0; // every undealt id is excluded: start the next pass early
  }
  refillBag(bag);
  return takeAt(bag, 0);
}
