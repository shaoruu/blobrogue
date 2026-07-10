// The depth-scaling PREMIUM coin economy — the balancer's sink-ladder contract:
//   1. placement — every milestone landing (F9/14/19/24/29, …) hosts the premium shop,
//      never a boss/gauntlet floor, never stacked with the Dealer (one stall per floor);
//      the Dealer carries exactly one premium slot from F6+;
//   2. prices — the EXACT balancer anchors at every milestone, the depthMult curve
//      (1 + 0.09/floor, rounded to 5) between and beyond them, and the successive-buy
//      escalations (+1 heart ×1.6, reroll-everything ×1.5);
//   3. the sinks — mystery reveal (seeded, depth-improving odds, distinct-if-possible),
//      legendary stock, rare blessing under the Lv1-3 + raw caps, +1 max heart under the
//      shared +4 cap, full heal (never past maxHp, NO protection frames), the
//      reroll-everything (stock + the buyer's next blessing offer), the amber cache;
//   4. the mythic capstone — F20+ landings only, one shared claim per party per shop,
//      the three options (arsenal / rare trio / windfall) all seeded and validated;
//   5. guardrails — the one-power-buy-per-shop lock, in-combat disables for full-heal/
//      reroll, no purchase past any cap, no boss-floor premium anything;
//   6. co-op — stock max(2,P) distinct from the identical solo prefix, personal
//      non-depleting sinks, P-invariant prices, one mythic per party;
//   7. determinism + the wire — same (seed, wallet) → identical stock/prices/reveals,
//      and the grown ShopWire round-trips losslessly under the strict codec.
//
// Run: npm run test:premium

import {
  createWorld, loadFloorIntoWorld, spawnPlayerInWorld, buyFromShopInWorld,
  applyItemToWorld, isPlayerInCombat, consumeBlessingReroll, devSpawnEnemy,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim, ShopBuyOutcome } from "../src/sim/world.js";
import {
  isShopFloor, hasShopRoomOnFloor, buildShopState, shopSlotStatusFor, shopSlotPriceFor,
  shopViewerOf, isPremiumKind, isMythicKind,
} from "../src/sim/shop.js";
import type { ShopSlot, ShopSlotKind } from "../src/sim/shop.js";
import {
  PREMIUM, CAPS, PLAYER, isPremiumShopFloor, premiumPriceAt, premiumBandIndex,
  mysteryOddsAt, roundToPriceStep, amberForRun, coinChanceTaper, COIN_TAPER,
  BOSS_DPS_CEILING,
} from "../src/sim/balance.js";
import type { PremiumTier } from "../src/sim/balance.js";
import { WEAPONS, PICKUP_WEAPONS, weaponsOfRarity, rollMysteryWeapon } from "../src/sim/weapons.js";
import { isBossFloor, isGauntletFloor } from "../src/sim/enemies.js";
import { ITEMS, itemById, itemLevelsOf, recomputeMods, createMods, MAX_ITEM_LEVEL } from "../src/sim/items.js";
import { Rng } from "../src/sim/rng.js";
import { generateDungeon } from "../src/sim/dungeon.js";
import type { SimEvent } from "../src/sim/events.js";
import type { PlayerId } from "../src/sim/input.js";
import { jsonCodec, buildSnapshot, toShopWire } from "../src/net/protocol.js";
import type { ServerMsg } from "../src/net/protocol.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

const SEEDS = [0x1a2b3c, 0xbee5, 0x7777777, 0xdead10cc, 0x1359, 0xcafe42, 0x900d5eed, 0x31415926];
const PREMIUM_FLOORS = [9, 14, 19, 24, 29];
const MILESTONES = [10, 15, 20, 25, 30];

function partyWorld(seed: number, floor: number, size: number): { w: WorldState; ps: PlayerSim[] } {
  const w = createWorld(seed, floor, { isShared: true, skipLocalPlayer: true });
  const ps: PlayerSim[] = [];
  for (let i = 0; i < size; i++) ps.push(spawnPlayerInWorld(w, "p" + i));
  loadFloorIntoWorld(w, floor);
  return { w, ps };
}

function buyAt(w: WorldState, p: PlayerSim, slot: ShopSlot, ev: SimEvent[] = []): ShopBuyOutcome {
  p.x = slot.x;
  p.y = slot.y;
  return buyFromShopInWorld(w, p.id, slot.id, ev);
}

function slotOfKind(w: WorldState, kind: ShopSlotKind): ShopSlot | undefined {
  return w.shop!.slots.find((s) => s.kind === kind);
}

// A premium world with a guaranteed slot of `kind`: scans seeds until the seeded stock
// offers it (stock is seeded 2-3 of 6-7 tiers, so a scan always lands quickly).
function worldWithSlot(kind: ShopSlotKind, floor: number, size = 1): { w: WorldState; ps: PlayerSim[]; slot: ShopSlot } {
  for (let s = 0; s < 4096; s++) {
    const seed = 0x9e370001 + s * 2654435761;
    const { w, ps } = partyWorld(seed, floor, size);
    const slot = w.shop?.slots.find((x) => x.kind === kind);
    if (slot) return { w, ps, slot };
  }
  throw new Error(`no seed offers ${kind} at F${floor}`);
}

function give(p: PlayerSim, coins: number): void {
  p.coins = coins;
}

// ---- 1. placement ----

function placementTests(): void {
  section("placement: milestone landings host the premium shop, never boss/gauntlet floors");
  check("premium floors are the milestone landings F9/14/19/24/29 (+every 5 after)",
    PREMIUM_FLOORS.every(isPremiumShopFloor) && isPremiumShopFloor(34) && isPremiumShopFloor(59)
    && ![1, 3, 6, 10, 15, 20, 25, 30, 12, 18].some(isPremiumShopFloor));
  check("no premium floor is ever a boss or gauntlet floor (by arithmetic, forever)",
    (() => { for (let f = 9; f < 200; f += 5) if (isBossFloor(f) || isGauntletFloor(f)) return false; return true; })());
  check("premium landings displace the Dealer cadence — one stall per floor, never two",
    !isShopFloor(9) && !isShopFloor(24) && hasShopRoomOnFloor(9) && hasShopRoomOnFloor(24));
  {
    let isOneRoom = true;
    for (const seed of SEEDS) {
      for (const floor of PREMIUM_FLOORS) {
        const rooms = generateDungeon(seed, floor).rooms.filter((r) => r.kind === "shop");
        if (rooms.length !== 1) isOneRoom = false;
      }
    }
    check("every (seed, premium floor) generates exactly one shop room", isOneRoom);
  }
  {
    let isStocked = true;
    let isSinkCountRight = true;
    let hasMythicWhenDue = true;
    for (const seed of SEEDS) {
      for (const floor of PREMIUM_FLOORS) {
        const w = createWorld(seed, floor);
        if (!w.shop) { isStocked = false; continue; }
        const sinks = w.shop.slots.filter((s) => !isMythicKind(s.kind));
        const mythics = w.shop.slots.filter((s) => isMythicKind(s.kind));
        if (sinks.length < 2 || sinks.length > 3) isSinkCountRight = false;
        if (sinks.some((s) => !isPremiumKind(s.kind))) isStocked = false;
        if ((floor >= PREMIUM.mythicFromFloor) !== (mythics.length === 1)) hasMythicWhenDue = false;
      }
    }
    check("solo premium stock is 2-3 seeded sinks, all premium kinds", isStocked && isSinkCountRight);
    check("the mythic slot appears exactly on F19+ landings, exactly once", hasMythicWhenDue);
  }
  {
    let isDealerSlotRight = true;
    for (const seed of SEEDS) {
      for (const floor of [3, 6, 12, 18, 21, 27]) {
        const w = createWorld(seed, floor);
        const premium = w.shop!.slots.filter((s) => isPremiumKind(s.kind));
        const want = floor >= PREMIUM.dealerSlotFromFloor ? 1 : 0;
        if (premium.length !== want) isDealerSlotRight = false;
        if (premium.some((s) => !PREMIUM.dealerTiers.includes(s.kind as PremiumTier))) isDealerSlotRight = false;
      }
    }
    check("the Dealer carries exactly one premium slot from F6+ (none at F3), small tiers only", isDealerSlotRight);
  }
}

// ---- 2. prices ----

function priceTests(): void {
  section("prices: the balancer's exact anchors at every milestone landing");
  const anchorChecks: Array<[PremiumTier, readonly number[], number]> = [
    ["mystery", [45, 70, 100, 135, 170], 9],
    ["legendary", [130, 190, 260, 330], 14],
    ["rare_blessing", [40, 60, 85, 110, 140], 9],
    ["max_hp", [55, 80, 110, 145, 180], 9],
    ["full_heal", [30, 45, 60, 80, 100], 9],
    ["reroll_all", [35, 55, 75, 100, 125], 9],
    ["mythic", [300, 430, 600], 19],
  ];
  for (const [tier, anchors, start] of anchorChecks) {
    const got = anchors.map((_, i) => premiumPriceAt(tier, start + i * 5));
    check(`${tier}: ${anchors.join("/")}`, JSON.stringify(got) === JSON.stringify(anchors), got.join("/"));
  }
  check("between anchors the depthMult curve applies, rounded to 5, monotone",
    premiumPriceAt("mystery", 12) === roundToPriceStep(45 * (1 + 0.09 * 3))
    && premiumPriceAt("mystery", 6) === roundToPriceStep(45 * (1 - 0.09 * 3))
    && premiumPriceAt("mystery", 6) < premiumPriceAt("mystery", 9));
  check("past the last anchor the ladder keeps climbing off it (post-F30 bands)",
    premiumPriceAt("mystery", 34) === roundToPriceStep(170 * (1 + 0.09 * 5))
    && premiumPriceAt("mythic", 34) > 600);
  check("every tier's ladder is strictly monotone over the landings",
    (["mystery", "legendary", "rare_blessing", "max_hp", "full_heal", "reroll_all", "amber_cache", "mythic"] as PremiumTier[])
      .every((tier) => {
        let prev = 0;
        for (let f = 9; f <= 44; f += 5) {
          const price = premiumPriceAt(tier, f);
          if (price <= prev) return false;
          prev = price;
        }
        return true;
      }));

  section("prices: successive-buy escalation (the viewer's effective price)");
  {
    const { w, ps: [p], slot } = worldWithSlot("max_hp", 9);
    give(p, 10_000);
    const base = slot.price;
    check("+1 heart base price is the anchor", base === premiumPriceAt("max_hp", 9));
    buyAt(w, p, slot);
    const viewer = shopViewerOf(p);
    check("the NEXT heart costs ×1.6 rounded to 5 (escalation rides the viewer, not the slot)",
      shopSlotPriceFor(w.shop!, slot, viewer) === roundToPriceStep(base * 1.6));
  }
  {
    const { w, ps: [p], slot } = worldWithSlot("reroll_all", 9);
    give(p, 10_000);
    const base = slot.price;
    const before = p.coins;
    buyAt(w, p, slot);
    check("reroll-everything charges its base price first use", before - p.coins === base);
    check("the SAME shop's next reroll costs +50% rounded to 5",
      shopSlotPriceFor(w.shop!, slot, shopViewerOf(p)) === roundToPriceStep(base * 1.5));
  }
}

// ---- 3. the sinks ----

function mysteryTests(): void {
  section("mystery weapon: seeded reveal, depth-improving odds, distinct while possible");
  {
    const { w, ps: [p], slot } = worldWithSlot("mystery", 9);
    give(p, 1000);
    check("the pedestal is honestly unidentified (no weapon on the slot, ever)", slot.weapon === null);
    const ev: SimEvent[] = [];
    const before = p.ownedWeapons.slice();
    check("buy accepted", buyAt(w, p, slot, ev) === "ok");
    const revealed = ev.find((e) => e.t === "mysteryReveal");
    check("the reveal event names the granted weapon",
      revealed !== undefined && revealed.t === "mysteryReveal" && p.ownedWeapons.includes(revealed.weapon)
      && !before.includes(revealed.weapon));
  }
  {
    // Determinism: identical world → identical reveal; different buyer → own fate.
    const revealOf = (pid: string): string => {
      const { w, ps } = partyWorld(0x5eed, 14, 2);
      const slot = w.shop!.slots.find((s) => s.kind === "mystery");
      if (!slot) return "none";
      const p = ps.find((x) => x.id === pid)!;
      give(p, 1000);
      const ev: SimEvent[] = [];
      buyAt(w, p, slot, ev);
      const e = ev.find((x) => x.t === "mysteryReveal");
      return e && e.t === "mysteryReveal" ? e.weapon : "none";
    };
    // Find a premium floor whose seeded stock has a mystery slot for this fixed seed.
    if (revealOf("p0") !== "none") {
      check("same (seed, wallet, buyer) → the identical reveal", revealOf("p0") === revealOf("p0"));
    } else {
      const { w, ps } = ((): { w: WorldState; ps: PlayerSim[] } => {
        const { w, ps } = worldWithSlot("mystery", 14, 2);
        return { w, ps };
      })();
      const slot = w.shop!.slots.find((s) => s.kind === "mystery")!;
      give(ps[0], 1000);
      const ev: SimEvent[] = [];
      buyAt(w, ps[0], slot, ev);
      check("same (seed, wallet, buyer) → the identical reveal", ev.some((e) => e.t === "mysteryReveal"));
    }
  }
  {
    // The odds table: monotone legendary share, and the seeded roll honors it.
    const shares = MILESTONES.map((m) => {
      const [c, r, l] = mysteryOddsAt(m - 1);
      return l / (c + r + l);
    });
    check("legendary odds strictly improve with depth: " + shares.map((s) => Math.round(s * 100) + "%").join(" → "),
      shares.every((s, i) => i === 0 || s > shares[i - 1]));
    const rng = new Rng(0xabcdef);
    let legendary = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      if (WEAPONS[rollMysteryWeapon(rng, mysteryOddsAt(29), [])].rarity === "legendary") legendary++;
    }
    const want = 38 / 100;
    check("the F30-band roll lands its authored legendary share (±2pp over 20k rolls)",
      Math.abs(legendary / n - want) < 0.02, `${(legendary / n * 100).toFixed(1)}%`);
  }
  check("every rarity band is non-empty (the mystery roll can always deliver)",
    weaponsOfRarity("common").length > 0 && weaponsOfRarity("rare").length > 0 && weaponsOfRarity("legendary").length > 0);
}

function sinkTests(): void {
  section("legendary weapon: known stock, guaranteed top rarity, inside the envelope");
  {
    const { w, ps: [p], slot } = worldWithSlot("legendary", 14);
    give(p, 1000);
    check("the stocked weapon is a real legendary", slot.weapon !== null && WEAPONS[slot.weapon!].rarity === "legendary");
    check("buy grants it", buyAt(w, p, slot) === "ok" && p.ownedWeapons.includes(slot.weapon!));
    check("every legendary is an EXISTING envelope weapon under the boss DPS gates (identity, not raw DPS)",
      weaponsOfRarity("legendary").every((id) => PICKUP_WEAPONS.includes(id))
      && Object.values(BOSS_DPS_CEILING).every((v) => v !== undefined));
  }

  section("rare blessing: premium 1-of-1, Lv1-3 + raw caps respected");
  {
    const { w, ps: [p], slot } = worldWithSlot("rare_blessing", 9);
    give(p, 1000);
    check("the stock is a real RARE blessing", itemById(slot.itemId ?? "")?.rarity === "rare");
    check("buy applies it as a normal leveled pick", buyAt(w, p, slot) === "ok"
      && (itemLevelsOf(p.ownedItemIds).get(slot.itemId!) ?? 0) === 1);
    // Cap audit: a maxed viewer reads MAX LV and the buy refuses.
    const { w: w2, ps: [p2], slot: slot2 } = worldWithSlot("rare_blessing", 9);
    give(p2, 1000);
    for (let i = 0; i < MAX_ITEM_LEVEL; i++) applyItemToWorld(w2, p2.id, itemById(slot2.itemId!)!);
    check("a maxed blessing reads MAX LV and the buy mutates nothing",
      shopSlotStatusFor(w2.shop!, slot2, shopViewerOf(p2)) === "maxLevel"
      && buyAt(w2, p2, slot2) === "maxLevel" && p2.coins === 1000);
  }

  section("+1 max heart: run-only, ×1.6 ladder, hard +4 TOTAL cap incl Vitality");
  {
    const { w, ps: [p], slot } = worldWithSlot("max_hp", 9);
    give(p, 100_000);
    const baseMax = p.maxHp;
    check("first buy grants exactly +1 max heart and +1 hp", buyAt(w, p, slot) === "ok" && p.maxHp === baseMax + 1);
    check("the slot is personal-sold after the buy (one per shop)", buyAt(w, p, slot) === "sold");
    // Force the cap: Vitality Lv3 (+4) plus the bought heart must clamp at +4 total.
    for (let i = 0; i < 3; i++) applyItemToWorld(w, p.id, itemById("vitality")!);
    check("Vitality Lv3 + a premium heart clamps at the shared +4 total (never +5)",
      p.maxHp === PLAYER.baseMaxHp + CAPS.maxHpBonus);
    const viewer = shopViewerOf(p);
    check("at the cap the station reads CAPPED", viewer.hpBonusTotal >= CAPS.maxHpBonus);
  }
  {
    // The capped status refuses the buy outright.
    const { w, ps: [p], slot } = worldWithSlot("max_hp", 14);
    give(p, 100_000);
    for (let i = 0; i < 3; i++) applyItemToWorld(w, p.id, itemById("vitality")!); // +4 at Lv3
    check("at +4 from Vitality alone the buy refuses as capped", buyAt(w, p, slot) === "capped" && p.coins === 100_000);
  }

  section("full heal: to maxHp exactly, NO protection frames, refused at full HP");
  {
    const { w, ps: [p], slot } = worldWithSlot("full_heal", 9);
    give(p, 1000);
    p.hp = 1;
    const invulnBefore = p.invuln;
    check("heals to full", buyAt(w, p, slot) === "ok" && p.hp === p.maxHp);
    check("grants NO invulnerability (recovery is purchasable, immunity is not)",
      p.invuln === invulnBefore && p.dashInvuln === 0);
    check("at full HP the station refuses honestly", buyAt(w, p, slot) === "sold" || p.hp === p.maxHp);
    const { w: w2, ps: [p2], slot: s2 } = worldWithSlot("full_heal", 9);
    give(p2, 1000);
    check("a full-HP viewer reads FULL HEALTH and the buy mutates nothing",
      buyAt(w2, p2, s2) === "fullHealth" && p2.coins === 1000);
  }

  section("reroll-everything: restocks unbought premium stock + arms the next-offer reroll");
  {
    const { w, ps: [p] } = (() => {
      // Need a shop with BOTH reroll_all and a stocked slot to observe the restock.
      for (let s = 0; s < 8192; s++) {
        const seed = 0x7e57 + s * 2654435761;
        const built = partyWorld(seed, 14, 1);
        const slots = built.w.shop?.slots ?? [];
        if (slots.some((x) => x.kind === "reroll_all") && slots.some((x) => x.kind === "legendary" || x.kind === "rare_blessing")) return built;
      }
      throw new Error("no seed offers reroll_all + stocked slot");
    })();
    give(p, 10_000);
    const reroll = w.shop!.slots.find((s) => s.kind === "reroll_all")!;
    const stocked = w.shop!.slots.find((s) => s.kind === "legendary" || s.kind === "rare_blessing")!;
    const stockBefore = JSON.stringify([stocked.weapon, stocked.itemId]);
    check("buy accepted", buyAt(w, p, reroll) === "ok");
    check("unbought premium stock rerolled deterministically",
      JSON.stringify([stocked.weapon, stocked.itemId]) !== stockBefore || w.shop!.rerollsUsed === 1);
    check("the buyer's next blessing offer is armed to reroll once",
      p.isBlessingRerollArmed && consumeBlessingReroll(w, p.id) && !p.isBlessingRerollArmed);
    check("the burn is one-shot", !consumeBlessingReroll(w, p.id));
  }

  section("amber cache: the ONLY coins→permanence route, capped trickle");
  {
    const { w, ps: [p], slot } = worldWithSlot("amber_cache", 9);
    give(p, 1000);
    check("buy arms the cache", buyAt(w, p, slot) === "ok" && p.isAmberCacheArmed);
    check("a second cache anywhere reads OWNED (once per run)",
      shopSlotStatusFor(w.shop!, slot, shopViewerOf(p)) === "owned");
  }
  check("conversion: ≤ +2 Amber per 100 unspent, hard cap +5/run, nothing unarmed",
    amberForRun(0, true, 0) === 0
    && amberForRun(99, true, 0) === 1
    && amberForRun(100, true, 0) === 2
    && amberForRun(249, true, 0) === 4
    && amberForRun(250, true, 0) === 5
    && amberForRun(10_000, true, 0) === 5
    && amberForRun(10_000, false, 0) === 0);
  check("the mythic windfall banks flat +8 on top of (and independent of) the cache cap",
    amberForRun(10_000, true, PREMIUM.mythicAmber) === 5 + 8 && amberForRun(0, false, 8) === 8);
}

// ---- 4. the mythic capstone ----

function mythicTests(): void {
  section("mythic: F20+ landings only, one shared claim per party, three seeded options");
  {
    let isKindSeeded = true;
    const kinds = new Set<ShopSlotKind>();
    for (let s = 0; s < 64; s++) {
      const w = createWorld(0x111 + s * 7919, 19);
      const mythic = w.shop!.slots.find((x) => isMythicKind(x.kind));
      if (!mythic) { isKindSeeded = false; continue; }
      kinds.add(mythic.kind);
      if (mythic.kind === "mythic_weapon" && (mythic.weapon === null || WEAPONS[mythic.weapon].rarity !== "legendary")) isKindSeeded = false;
    }
    check("all three mythic options appear across seeds, each properly stocked",
      isKindSeeded && kinds.size === 3, [...kinds].join(","));
  }
  {
    const { w, ps, slot } = worldWithSlot("mythic_amber", 19, 4);
    for (const p of ps) give(p, 1000);
    check("the windfall claim banks +8 Amber", buyAt(w, ps[0], slot) === "ok" && ps[0].amberWindfall === PREMIUM.mythicAmber);
    check("the claim is ONE per party — teammates read SOLD, nothing mutates",
      buyAt(w, ps[1], slot) === "sold" && ps[1].coins === 1000 && ps[1].amberWindfall === 0);
  }
  {
    const { w, ps: [p], slot } = worldWithSlot("mythic_trio", 19);
    give(p, 1000);
    const ev: SimEvent[] = [];
    check("the trio claim raises a RARE pick-1-of-3 offer and pauses the buyer",
      buyAt(w, p, slot, ev) === "ok"
      && ev.some((e) => e.t === "offerBlessing" && e.rare)
      && w.pendingBlessings.has(p.id));
    check("while the offer is pending no further buys are possible (paused buyer)",
      w.shop!.slots.every((s) => buyAt(w, p, s) === "invalid"));
  }
  {
    const { w, ps: [p], slot } = worldWithSlot("mythic_weapon", 24);
    give(p, 1000);
    const weapon = slot.weapon!;
    check("the arsenal claim grants the stocked legendary",
      buyAt(w, p, slot) === "ok" && p.ownedWeapons.includes(weapon));
  }
  check("mythic prices gate the chase: 300/430/600 at F20/25/30",
    premiumPriceAt("mythic", 19) === 300 && premiumPriceAt("mythic", 24) === 430 && premiumPriceAt("mythic", 29) === 600);
}

// ---- 5. guardrails ----

function guardrailTests(): void {
  section("guardrails: the one-power-buy-per-shop lock");
  {
    const { w, ps: [p] } = (() => {
      for (let s = 0; s < 8192; s++) {
        const seed = 0x10c4 + s * 2654435761;
        const built = partyWorld(seed, 19, 1);
        const sinks = (built.w.shop?.slots ?? []).filter((x) => !isMythicKind(x.kind) && x.kind !== "reroll_all" && x.kind !== "amber_cache");
        if (sinks.length >= 2) return built;
      }
      throw new Error("no seed offers two lockable sinks");
    })();
    give(p, 100_000);
    const sinks = w.shop!.slots.filter((s) => !isMythicKind(s.kind) && s.kind !== "reroll_all" && s.kind !== "amber_cache");
    check("first power sink buys fine", buyAt(w, p, sinks[0]) === "ok");
    check("the second power sink is LOCKED for this buyer (nothing mutates)",
      buyAt(w, p, sinks[1]) === "locked" && shopSlotStatusFor(w.shop!, sinks[1], shopViewerOf(p)) === "locked");
    const mythic = w.shop!.slots.find((s) => isMythicKind(s.kind));
    if (mythic) {
      check("the mythic capstone stays OUTSIDE the lock (the spend-everything chase)",
        shopSlotStatusFor(w.shop!, mythic, shopViewerOf(p)) !== "locked");
    }
  }

  section("guardrails: in-combat disables for full heal / reroll-everything");
  {
    const { w, ps: [p], slot } = worldWithSlot("full_heal", 9);
    give(p, 1000);
    p.hp = 1;
    p.x = slot.x; p.y = slot.y;
    devSpawnEnemy(w, "slime", slot.x + 100, slot.y);
    check("a living enemy inside the lock radius reads IN COMBAT and the buy refuses",
      isPlayerInCombat(w, p) && buyAt(w, p, slot) === "inFight" && p.hp === 1 && p.coins === 1000);
    w.enemies.length = 0;
    check("with the fight cleared the same buy lands", buyAt(w, p, slot) === "ok" && p.hp === p.maxHp);
  }

  section("guardrails: no purchase pushes any capped stat past its cap");
  {
    // Buy EVERYTHING premium a run could buy on top of a maxed build, then audit caps.
    const { w, ps: [p] } = partyWorld(0xa11ca5, 19, 1);
    give(p, 1_000_000);
    for (const it of ITEMS) for (let i = 0; i < MAX_ITEM_LEVEL; i++) applyItemToWorld(w, p.id, it);
    for (const slot of w.shop!.slots) buyAt(w, p, slot);
    const m = createMods();
    recomputeMods(m, p.ownedItemIds);
    check("raw caps hold across the maxed build + every premium purchase",
      m.damageMult <= CAPS.damageMult && m.fireRateMult <= CAPS.fireRateMult
      && m.moveSpeedMult <= CAPS.moveSpeedMult && m.maxHpBonus <= CAPS.maxHpBonus
      && m.burnChance <= CAPS.elementalChance);
    check("max HP never exceeds base + the +4 total cap",
      p.maxHp <= PLAYER.baseMaxHp + CAPS.maxHpBonus);
    check("hp never exceeds maxHp", p.hp <= p.maxHp);
  }

  section("guardrails: the depth coin taper (calibration, never a value change)");
  check("floor 1 untouched; a floored minimum share; monotone decline",
    coinChanceTaper(1) === 1
    && coinChanceTaper(COIN_TAPER.fromFloor) < 1
    && coinChanceTaper(15) < coinChanceTaper(10)
    && coinChanceTaper(30) >= COIN_TAPER.floorMult
    && coinChanceTaper(100) === COIN_TAPER.floorMult);
}

// ---- 6. co-op ----

function coopTests(): void {
  section("co-op: stock max(2,P) distinct, the solo prefix stable, prices P-invariant");
  {
    let isCountRight = true;
    let isPrefixStable = true;
    let isPriceInvariant = true;
    for (const seed of SEEDS) {
      for (const floor of PREMIUM_FLOORS) {
        const stocks: ShopSlot[][] = [1, 2, 3, 4].map((size) => {
          const { w } = partyWorld(seed, floor, size);
          return w.shop!.slots.filter((s) => !isMythicKind(s.kind));
        });
        for (let i = 0; i < 4; i++) {
          const kinds = stocks[i].map((s) => s.kind);
          if (kinds.length < Math.max(2, i + 1)) isCountRight = false;
          if (new Set(kinds).size !== kinds.length) isCountRight = false;
        }
        for (let i = 1; i < 4; i++) {
          for (let j = 0; j < stocks[0].length; j++) {
            const solo = stocks[0][j], party = stocks[i][j];
            if (!party || party.kind !== solo.kind || party.weapon !== solo.weapon || party.itemId !== solo.itemId) isPrefixStable = false;
            if (party && party.price !== solo.price) isPriceInvariant = false;
          }
        }
      }
    }
    check("stock count ≥ max(2, P), all kinds distinct", isCountRight);
    check("a bigger party's stock is a strict superset of the solo prefix", isPrefixStable);
    check("prices never change with party size", isPriceInvariant);
  }
  {
    section("co-op: personal sinks never deplete for teammates; income is per-wallet");
    const { w, ps } = worldWithSlot("mystery", 14, 4);
    const slot = w.shop!.slots.find((s) => s.kind === "mystery")!;
    for (const p of ps) give(p, 1000);
    const outcomes = ps.map((p) => buyAt(w, p, slot));
    check("all four players buy the SAME personal mystery pedestal", outcomes.every((o) => o === "ok"));
    check("each paid from their own wallet", ps.every((p) => p.coins === 1000 - slot.price));
    const reveals = new Set(ps.map((p) => p.ownedWeapons[p.ownedWeapons.length - 1]));
    check("each buyer drew their own seeded fate (personal reveal streams)", reveals.size >= 1);
  }
}

// ---- 7. determinism + wire ----

function wireTests(): void {
  section("determinism: same (seed, floor) → byte-identical premium stall");
  {
    let isStable = true;
    for (const seed of SEEDS) {
      for (const floor of PREMIUM_FLOORS) {
        const a = JSON.stringify(toShopWire(createWorld(seed, floor).shop!));
        const b = JSON.stringify(toShopWire(createWorld(seed, floor).shop!));
        if (a !== b) isStable = false;
      }
    }
    check("rebuild is byte-identical across every seed and landing", isStable);
  }
  section("wire: the premium stall round-trips losslessly under the strict codec");
  {
    let isLossless = true;
    for (const floor of PREMIUM_FLOORS) {
      const { w } = partyWorld(0x317e40, floor, 2);
      const msg = buildSnapshot(w, "p0", 0, [], 0, true, { worldId: "room:TEST" });
      const decoded = jsonCodec.decodeServer(jsonCodec.encodeServer(msg)) as Extract<ServerMsg, { t: "snap" }>;
      if (JSON.stringify(decoded.shop) !== JSON.stringify(toShopWire(w.shop!))) isLossless = false;
    }
    check("every premium landing's stall survives encode→decode byte-identically", isLossless);
  }
}

function main(): void {
  placementTests();
  priceTests();
  mysteryTests();
  sinkTests();
  mythicTests();
  guardrailTests();
  coopTests();
  wireTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nThe premium coin economy contracts hold (placement, prices, sinks, mythic, guardrails, co-op, wire).\n");
}

main();
