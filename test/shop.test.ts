// Patch's shop — the authored Dealer room suite. Locks the whole contract the studio
// accepted when the loose touch-buy dealer pickups were removed:
//   1. placement — every eligible floor (3/6/9, … never boss) generates ONE dedicated
//      `shop` room, mid-journey (never spawn/exit), with deterministic stall + stock;
//   2. sanctuary — no enemies (active, pending, relocated), floor hazards, props, or
//      chests ever place inside the shop room, and every station is walkable + reachable;
//   3. NO TOUCH PURCHASE — the exact regression the old system died for: standing on
//      every station with a full purse forever buys nothing, consumes nothing;
//   4. the buy command — the one purchase path: state matrix (buy/broke/sold/owned/
//      maxLevel/fullHealth), proximity + liveness gates, idempotency, and the invariant
//      that every rejection mutates NOTHING;
//   5. ownership P1-P4 — shared weapon pedestals resolve concurrent buys to exactly one
//      winner (honest SOLD for the rest); personal blessing/heart slots instance per
//      player and never deplete for teammates;
//   6. reroll — authoritative cost/limit, deterministic restock of unbought pedestals
//      only, bought stock never rolled back;
//   7. flow — the shop never blocks floor clear / the exit gate, and the wire round-trip
//      (ShopWire on snapshots) is lossless so reconnecting clients see identical stalls.
//
// Run: npm run test:shop

import {
  createWorld, loadFloorIntoWorld, spawnPlayerInWorld, stepWorld, stepWorldPhase,
  buyFromShopInWorld, nearestShopSlot, isFloorCleared, descend,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim, ShopBuyOutcome } from "../src/sim/world.js";
import {
  isShopFloor, buildShopState, shopSlotStatusFor, shopViewerOf, SHOP_FOCUS_RANGE, SHOP_BUY_RANGE,
} from "../src/sim/shop.js";
import type { ShopSlot, ShopState } from "../src/sim/shop.js";
import { SHOP } from "../src/sim/balance.js";
import { generateDungeon } from "../src/sim/dungeon.js";
import type { Dungeon } from "../src/sim/dungeon.js";
import { isBossFloor } from "../src/sim/enemies.js";
import { itemById, itemLevelsOf, MAX_ITEM_LEVEL } from "../src/sim/items.js";
import { TILE } from "../src/sim/types.js";
import type { WeaponId } from "../src/sim/types.js";
import { MAX_OWNED_WEAPONS } from "../src/sim/constants.js";
import type { SimEvent } from "../src/sim/events.js";
import type { InputCmd, PlayerId } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import { buildSnapshot, jsonCodec, toShopWire, shopFromWire } from "../src/net/protocol.js";
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

const DT = 1 / 20;
const SEEDS = [0x1a2b3c, 0xbee5, 0x7777777, 0xdead10cc, 0x1359, 0xcafe42, 0x900d5eed, 0x31415926];
const SHOP_FLOORS = [3, 6, 9, 12, 18, 21, 24, 27];

function idle(seq: number): InputCmd {
  return { seq, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };
}

function partyWorld(seed: number, floor: number, size: number): { w: WorldState; ps: PlayerSim[] } {
  const w = createWorld(seed, floor, { isShared: true, skipLocalPlayer: true });
  const ps: PlayerSim[] = [];
  for (let i = 0; i < size; i++) ps.push(spawnPlayerInWorld(w, "p" + i));
  loadFloorIntoWorld(w, floor);
  return { w, ps };
}

function slotOf(w: WorldState, kind: ShopSlot["kind"], index = 0): ShopSlot {
  const found = w.shop!.slots.filter((s) => s.kind === kind);
  return found[index];
}

function buyAt(w: WorldState, p: PlayerSim, slot: ShopSlot, ev: SimEvent[] = []): ShopBuyOutcome {
  p.x = slot.x;
  p.y = slot.y;
  return buyFromShopInWorld(w, p.id, slot.id, ev);
}

function isInRoom(room: { x: number; y: number; w: number; h: number }, tx: number, ty: number): boolean {
  return tx >= room.x && tx < room.x + room.w && ty >= room.y && ty < room.y + room.h;
}

// BFS over open floor from the spawn (the depth suite's reachability primitive).
function reachableFrom(d: Dungeon, sx: number, sy: number): Set<number> {
  const seen = new Set<number>();
  const start = sy * d.w + sx;
  if (d.tiles[start] !== 0) return seen;
  seen.add(start);
  const queue = [start];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const cx = cur % d.w, cy = (cur / d.w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= d.w || ny >= d.h) continue;
      const ni = ny * d.w + nx;
      if (d.tiles[ni] !== 0 || seen.has(ni)) continue;
      seen.add(ni);
      queue.push(ni);
    }
  }
  return seen;
}

// ---- 1. deterministic placement ----

function placementTests(): void {
  section("placement: eligible floors host exactly one mid-journey shop room; others none");
  {
    let isCadenceRight = true;
    let isSingular = true;
    let isMidJourney = true;
    for (const seed of SEEDS) {
      for (let floor = 1; floor <= 30; floor++) {
        const d = generateDungeon(seed, floor);
        const shops = d.rooms.filter((r) => r.kind === "shop");
        if (isShopFloor(floor) !== (shops.length === 1)) isCadenceRight = false;
        if (shops.length > 1) isSingular = false;
        for (const s of shops) {
          if (s === d.rooms[0] || s === d.rooms[d.rooms.length - 1]) isMidJourney = false;
        }
      }
    }
    check("shop cadence = every 3rd floor, never boss floors, exactly one room", isCadenceRight && isSingular);
    check("the shop is never the spawn or the exit room", isMidJourney);
    check("isShopFloor: 3/6/9/12 yes; 15/30 (boss) no; 1/2/10 no",
      [3, 6, 9, 12].every(isShopFloor) && ![15, 30, 1, 2, 10].some(isShopFloor)
      && isBossFloor(15) && isBossFloor(30));
  }

  section("placement: the shop room is the dedicated LARGER kind with clean rect ground");
  {
    let isSized = true;
    for (const seed of SEEDS) {
      for (const floor of SHOP_FLOORS) {
        const room = generateDungeon(seed, floor).rooms.find((r) => r.kind === "shop")!;
        if (room.w < 11 || room.h < 8 || room.shape !== "rect") isSized = false;
      }
    }
    check("every shop room is >= 11x8 plain rect", isSized);
  }

  section("stock: deterministic, party-size-invariant, on the 12/18/24 ladder");
  {
    const build = (size: number): string => {
      const { w } = partyWorld(0xF100D, 3, size);
      return JSON.stringify(toShopWire(w.shop!));
    };
    check("rebuild is byte-identical (P1)", build(1) === build(1));
    check("P1 = P2 = P4 stall (a mid-floor join never shifts stock)", build(1) === build(2) && build(2) === build(4));
  }
  {
    const w = createWorld(0xDEA1, 3);
    const shop = w.shop!;
    const weapons = shop.slots.filter((s) => s.kind === "weapon");
    const blessings = shop.slots.filter((s) => s.kind === "blessing");
    const hearts = shop.slots.filter((s) => s.kind === "heart");
    const rerolls = shop.slots.filter((s) => s.kind === "reroll");
    check("three item pedestals: 2 weapons + 1 blessing", weapons.length === 2 && blessings.length === 1);
    check("one heart station + one reroll post", hearts.length === 1 && rerolls.length === 1);
    check("pedestal prices ride the unchanged 12/18/24 ladder",
      weapons[0].price === 12 && weapons[1].price === 18 && blessings[0].price === 24);
    check("heart 6 (never a full heal: +1 HP) and reroll 8",
      hearts[0].price === SHOP.heartPrice && SHOP.heartHeal === 1 && rerolls[0].price === SHOP.rerollCost);
    check("weapon pedestals are SHARED; blessing + heart are FOR YOU (personal)",
      weapons.every((s) => s.isShared) && !blessings[0].isShared && !hearts[0].isShared);
    check("weapon pedestals hold DISTINCT ids", weapons[0].weapon !== weapons[1].weapon);
    check("the blessing pedestal holds a real pool item", itemById(blessings[0].itemId ?? "") !== undefined);
  }
  {
    let isEverywhere = true;
    for (const seed of SEEDS) {
      for (const floor of SHOP_FLOORS) {
        const w = createWorld(seed, floor);
        if (!w.shop || w.shop.slots.length !== SHOP.pedestalPrices.length + 2) isEverywhere = false;
      }
    }
    check(`every (seed, shop floor) builds the full 5-station stall across ${SEEDS.length} seeds`, isEverywhere);
  }
}

// ---- 2. sanctuary ----

function sanctuaryTests(): void {
  section("sanctuary: no enemies/hazards/props/chests ever place in the shop room");
  let isEnemyFree = true;
  let isHazardFree = true;
  let isPropFree = true;
  let isChestFree = true;
  let isReachable = true;
  let isWalkable = true;
  for (const seed of SEEDS) {
    for (const floor of SHOP_FLOORS) {
      const { w } = partyWorld(seed, floor, 4); // the P4 build is the densest spawn set
      const room = w.dungeon.rooms.find((r) => r.kind === "shop")!;
      for (const e of [...w.enemies, ...w.pendingSpawns]) {
        if (isInRoom(room, Math.floor(e.x / TILE), Math.floor(e.y / TILE))) isEnemyFree = false;
      }
      for (const h of w.floorHazards) {
        if (isInRoom(room, h.tx, h.ty)) isHazardFree = false;
      }
      for (const p of w.props) {
        if (isInRoom(room, Math.floor(p.x / TILE), Math.floor(p.y / TILE))) isPropFree = false;
      }
      for (const c of w.chests) {
        if (isInRoom(room, Math.floor(c.x / TILE), Math.floor(c.y / TILE))) isChestFree = false;
      }
      const reach = reachableFrom(w.dungeon, w.dungeon.spawn.x, w.dungeon.spawn.y);
      for (const slot of w.shop!.slots) {
        const tx = Math.floor(slot.x / TILE), ty = Math.floor(slot.y / TILE);
        if (w.dungeon.tiles[ty * w.dungeon.w + tx] !== 0) isWalkable = false;
        if (!reach.has(ty * w.dungeon.w + tx)) isReachable = false;
      }
    }
  }
  check("no active or pending enemy spawns on shop ground (P4, all seeds x shop floors)", isEnemyFree);
  check("no floor hazards on shop ground", isHazardFree);
  check("no props on shop ground", isPropFree);
  check("no chests on shop ground", isChestFree);
  check("every station stands on open floor", isWalkable);
  check("every station is reachable from the spawn (walkable path)", isReachable);
}

// ---- 3. THE regression: touch never purchases ----

function noTouchPurchaseTests(): void {
  section("no-touch-purchase regression: standing on every station forever buys nothing");
  const w = createWorld(0xDEA1, 3);
  w.enemies = [];
  w.pendingSpawns = [];
  const p = w.players.get(LOCAL_ID)!;
  p.coins = 999;
  p.hp = 1; // a heart WOULD be valid — only the explicit command may grant it
  const before = JSON.stringify(toShopWire(w.shop!));
  for (const slot of w.shop!.slots) {
    p.x = slot.x;
    p.y = slot.y;
    for (let t = 0; t < 60; t++) stepWorld(w, new Map([[LOCAL_ID, idle(t)]]), DT);
  }
  check("coins untouched after standing on all 5 stations for 3s each", p.coins === 999, `coins=${p.coins}`);
  check("no weapon granted, no blessing applied, no heal",
    p.ownedWeapons.length === 1 && p.ownedItemIds.length === 0 && p.hp === 1);
  check("stock state byte-identical (nothing sold, nothing claimed)", JSON.stringify(toShopWire(w.shop!)) === before);
  check("no priced pickup kind exists anywhere in the world",
    w.pickups.every((k) => k.kind === "heart" || k.kind === "coin" || k.kind === "weapon"));
}

// ---- 4. the buy command ----

function buyCommandTests(): void {
  section("buy: the state matrix gates every purchase; rejections mutate nothing");
  {
    const w = createWorld(0xDEA1, 3);
    const p = w.players.get(LOCAL_ID)!;
    const weapon = slotOf(w, "weapon");

    p.coins = weapon.price - 1;
    check("broke: rejected as 'broke', coins/stock untouched",
      buyAt(w, p, weapon) === "broke" && p.coins === weapon.price - 1 && weapon.soldTo === null);

    p.coins = weapon.price;
    const ev: SimEvent[] = [];
    check("funded: 'ok' — exact price paid, weapon granted + equipped, slot claimed",
      buyAt(w, p, weapon, ev) === "ok" && p.coins === 0 && p.ownedWeapons.includes(weapon.weapon!)
      && p.weapon === weapon.weapon && weapon.soldTo === LOCAL_ID);
    check("the buy emits exactly one shopBuy event", ev.filter((e) => e.t === "shopBuy").length === 1);

    p.coins = 99;
    check("idempotent: rebuying your own claim resolves 'owned', consumes nothing",
      buyAt(w, p, weapon) === "owned" && p.coins === 99);

    const other = slotOf(w, "weapon", 1);
    p.ownedWeapons.push(other.weapon!);
    check("a weapon you already own reads 'owned' before any coin moves",
      buyAt(w, p, other) === "owned" && p.coins === 99 && other.soldTo === null);
  }
  {
    // The hotbar cap gates the stall exactly like floor pickups: a full buyer reads
    // HOTBAR FULL and no coin moves — freeing a slot (drop/swap) re-opens the buy.
    const w = createWorld(0xDEA1, 3);
    const p = w.players.get(LOCAL_ID)!;
    const weapon = slotOf(w, "weapon");
    const fillers: WeaponId[] = ["shotgun", "railgun", "tesla", "smg", "cannon", "rapid", "burst", "homing"];
    for (const id of fillers) {
      if (p.ownedWeapons.length >= MAX_OWNED_WEAPONS) break;
      if (id !== weapon.weapon && !p.ownedWeapons.includes(id)) p.ownedWeapons.push(id);
    }
    p.coins = 99;
    check("a full hotbar reads 'full', coins/stock untouched",
      buyAt(w, p, weapon) === "full" && p.coins === 99 && weapon.soldTo === null
      && p.ownedWeapons.length === MAX_OWNED_WEAPONS);
    p.ownedWeapons.pop();
    check("freeing a slot re-opens the same buy",
      buyAt(w, p, weapon) === "ok" && p.ownedWeapons.includes(weapon.weapon!) && p.ownedWeapons.length === MAX_OWNED_WEAPONS);
  }
  {
    const w = createWorld(0xDEA1, 3);
    const p = w.players.get(LOCAL_ID)!;
    const heart = slotOf(w, "heart");
    p.coins = 50;
    check("full health: rejected as 'fullHealth', nothing consumed",
      buyAt(w, p, heart) === "fullHealth" && p.coins === 50 && heart.buyers.length === 0);
    p.hp = 2;
    check("hurt + funded: 'ok' — +1 HP exactly, price paid, buyer recorded",
      buyAt(w, p, heart) === "ok" && p.hp === 3 && p.coins === 50 - heart.price && heart.buyers.includes(LOCAL_ID));
    check("one heart per player per shop: a second buy reads 'sold'",
      buyAt(w, p, heart) === "sold" && p.hp === 3 && p.coins === 50 - heart.price);
  }
  {
    const w = createWorld(0xDEA1, 3);
    const p = w.players.get(LOCAL_ID)!;
    const blessing = slotOf(w, "blessing");
    const itemId = blessing.itemId!;
    p.coins = 99;
    for (let i = 0; i < MAX_ITEM_LEVEL; i++) p.ownedItemIds.push(itemId);
    check("a maxed blessing reads 'maxLevel', consumes nothing",
      buyAt(w, p, blessing) === "maxLevel" && p.coins === 99);
    p.ownedItemIds.length = 0;
    check("a fresh blessing buy applies ONE pick (Lv1) at the pedestal price",
      buyAt(w, p, blessing) === "ok" && (itemLevelsOf(p.ownedItemIds).get(itemId) ?? 0) === 1
      && p.coins === 99 - blessing.price);
    check("your bought pedestal reads 'sold' for you (one buy per player per shop)",
      buyAt(w, p, blessing) === "sold" && (itemLevelsOf(p.ownedItemIds).get(itemId) ?? 0) === 1);
  }

  section("buy: liveness + proximity gates (a tampered client cannot remote-buy)");
  {
    const w = createWorld(0xDEA1, 3);
    const p = w.players.get(LOCAL_ID)!;
    const weapon = slotOf(w, "weapon");
    p.coins = 99;
    p.x = weapon.x + SHOP_BUY_RANGE + 40;
    p.y = weapon.y;
    check("buying from beyond SHOP_BUY_RANGE is 'invalid', consumes nothing",
      buyFromShopInWorld(w, LOCAL_ID, weapon.id, []) === "invalid" && p.coins === 99 && weapon.soldTo === null);
    p.x = weapon.x; p.y = weapon.y;
    p.isDown = true;
    check("a downed player cannot buy", buyFromShopInWorld(w, LOCAL_ID, weapon.id, []) === "invalid");
    p.isDown = false;
    p.isAbsent = true;
    check("a network-absent (reserved) body cannot buy", buyFromShopInWorld(w, LOCAL_ID, weapon.id, []) === "invalid");
    p.isAbsent = false;
    w.pendingBlessings.set(LOCAL_ID, 10);
    check("a player mid-blessing-pick cannot buy (they are paused)", buyFromShopInWorld(w, LOCAL_ID, weapon.id, []) === "invalid");
    w.pendingBlessings.delete(LOCAL_ID);
    check("a bogus slot id is 'invalid'", buyFromShopInWorld(w, LOCAL_ID, 99, []) === "invalid");
    check("a floor without a shop rejects every buy", buyFromShopInWorld(createWorld(0xDEA1, 4), LOCAL_ID, 0, []) === "invalid");
  }

  section("buy: the UI status matrix IS the sim validation (they can never disagree)");
  {
    const w = createWorld(0xDEA1, 3);
    const p = w.players.get(LOCAL_ID)!;
    p.hp = 2;
    for (const coins of [0, 5, 6, 11, 12, 24, 99]) {
      let isAgreeing = true;
      for (const slot of w.shop!.slots) {
        const probe = createWorld(0xDEA1, 3); // fresh world per probe: buys must not accumulate
        const pp = probe.players.get(LOCAL_ID)!;
        pp.hp = 2;
        pp.coins = coins;
        const status = shopSlotStatusFor(probe.shop!, probe.shop!.slots.find((s) => s.id === slot.id)!, shopViewerOf(pp));
        const outcome = buyAt(probe, pp, probe.shop!.slots.find((s) => s.id === slot.id)!);
        const expected = status === "buy" ? "ok" : status;
        if (outcome !== expected) isAgreeing = false;
      }
      check(`status == outcome for every slot at ${coins} coins`, isAgreeing);
    }
    check("nearestShopSlot focuses only within range",
      nearestShopSlot(w, w.shop!.slots[0].x, w.shop!.slots[0].y, SHOP_FOCUS_RANGE)?.id === w.shop!.slots[0].id
      && nearestShopSlot(w, 0, 0, SHOP_FOCUS_RANGE) === null);
    void p;
  }
}

// ---- 5. ownership P1-P4 ----

function ownershipTests(): void {
  section("shared weapon pedestal: concurrent buys resolve to exactly ONE winner");
  for (const size of [2, 3, 4]) {
    const { w, ps } = partyWorld(0xC0C0A, 3, size);
    const weapon = slotOf(w, "weapon");
    for (const p of ps) { p.coins = weapon.price; p.x = weapon.x; p.y = weapon.y; }
    const outcomes = ps.map((p) => buyFromShopInWorld(w, p.id, weapon.id, []));
    const winners = ps.filter((p) => p.ownedWeapons.includes(weapon.weapon!));
    check(`P${size}: exactly one winner; the rest read the honest 'sold'`,
      outcomes.filter((o) => o === "ok").length === 1
      && outcomes.filter((o) => o === "sold").length === size - 1
      && winners.length === 1 && weapon.soldTo === winners[0].id);
    check(`P${size}: losers' coins are untouched (an invalid purchase never consumes)`,
      ps.filter((p) => p !== winners[0]).every((p) => p.coins === weapon.price));
  }

  section("personal slots: FOR YOU — every player buys their own; nothing depletes");
  {
    const { w, ps } = partyWorld(0xC0C0B, 3, 4);
    const blessing = slotOf(w, "blessing");
    const heart = slotOf(w, "heart");
    for (const p of ps) { p.coins = 99; p.hp = 1; }
    const blessingOk = ps.every((p) => buyAt(w, p, blessing) === "ok");
    check("P4: all four buy the SAME blessing pedestal (instanced per player)",
      blessingOk && ps.every((p) => p.ownedItemIds.includes(blessing.itemId!)) && blessing.buyers.length === 4);
    const heartOk = ps.every((p) => buyAt(w, p, heart) === "ok");
    check("P4: all four buy their own heart (+1 HP each — the P-heart supply preserved)",
      heartOk && ps.every((p) => p.hp === 2) && heart.buyers.length === 4);
    check("personal rebuy reads 'sold' per buyer", ps.every((p) => buyAt(w, p, heart) === "sold"));
  }
}

// ---- 6. reroll ----

function rerollTests(): void {
  section("reroll: authoritative cost/limit; restocks only unbought pedestals, deterministically");
  {
    const { w, ps } = partyWorld(0x9E90, 3, 2);
    const [a, b] = ps;
    const reroll = slotOf(w, "reroll");
    const weapon0 = slotOf(w, "weapon", 0);

    a.coins = weapon0.price;
    check("A claims pedestal 0 first", buyAt(w, a, weapon0) === "ok");

    b.coins = SHOP.rerollCost - 1;
    check("a broke reroll is rejected, consumes nothing",
      buyAt(w, b, reroll) === "broke" && w.shop!.rerollsUsed === 0);

    const keptWeapon = weapon0.weapon;
    const beforeIds = w.shop!.slots.filter((s) => s.kind === "weapon" || s.kind === "blessing").map((s) => s.weapon ?? s.itemId);
    b.coins = SHOP.rerollCost * 3;
    check("a funded reroll pays the exact cost and bumps the shared counter",
      buyAt(w, b, reroll) === "ok" && b.coins === SHOP.rerollCost * 2 && w.shop!.rerollsUsed === 1);
    check("the CLAIMED pedestal is never rolled back (a purchase is forever)",
      weapon0.weapon === keptWeapon && weapon0.soldTo === a.id);
    const afterIds = w.shop!.slots.filter((s) => s.kind === "weapon" || s.kind === "blessing").map((s) => s.weapon ?? s.itemId);
    check("unbought pedestals restocked (stock actually changed)", JSON.stringify(beforeIds) !== JSON.stringify(afterIds));
    const weapons = w.shop!.slots.filter((s) => s.kind === "weapon");
    check("restocked weapons stay distinct", weapons[0].weapon !== weapons[1].weapon);

    check("the second (last) reroll works", buyAt(w, b, reroll) === "ok" && w.shop!.rerollsUsed === 2);
    check("past the limit the post reads 'exhausted', consumes nothing",
      buyAt(w, b, reroll) === "exhausted" && b.coins === SHOP.rerollCost);
  }
  {
    // Determinism: the same reroll sequence lands the same restock on a fresh world.
    const roll = (): string => {
      const { w, ps } = partyWorld(0x9E91, 3, 1);
      ps[0].coins = 99;
      buyAt(w, ps[0], slotOf(w, "reroll"));
      return JSON.stringify(toShopWire(w.shop!).slots.map((s) => s.wpn ?? s.it));
    };
    check("reroll restock is deterministic from (seed, floor, rerollsUsed)", roll() === roll());
  }
  {
    // Nothing left to restock: every pedestal bought -> the reroll is honest about it.
    const { w, ps } = partyWorld(0x9E92, 3, 1);
    const p = ps[0];
    p.coins = 999;
    buyAt(w, p, slotOf(w, "weapon", 0));
    buyAt(w, p, slotOf(w, "weapon", 1));
    buyAt(w, p, slotOf(w, "blessing"));
    check("with every pedestal bought the reroll reads 'exhausted' (never wastes coins)",
      buyAt(w, p, slotOf(w, "reroll")) === "exhausted" && w.shop!.rerollsUsed === 0);
  }
}

// ---- 7. flow: exit gate + wire round-trip ----

function flowAndWireTests(): void {
  section("flow: the shop never blocks floor clear or the descend gate");
  {
    const w = createWorld(0xF10, 3);
    w.enemies = [];
    w.pendingSpawns = [];
    check("floor clears with the whole stall unbought", isFloorCleared(w));
    const p = w.players.get(LOCAL_ID)!;
    p.x = w.dungeon.exit.x * TILE + TILE / 2;
    p.y = w.dungeon.exit.y * TILE + TILE / 2;
    const ev: SimEvent[] = [];
    stepWorldPhase(w, DT, ev);
    check("the exit gate raises the blessing offer as always (shop is optional, not a gate)",
      ev.some((e) => e.t === "offerBlessing"));
  }
  {
    const w = createWorld(0xF11, 3);
    descend(w, 4, []);
    check("descending off a shop floor clears the stall state", w.shop === null);
    descend(w, 6, []);
    check("the next shop floor builds a fresh stall", w.shop !== null && w.shop.rerollsUsed === 0);
  }

  section("wire: ShopWire round-trips losslessly (reconnect sees the identical stall)");
  {
    const { w, ps } = partyWorld(0xB1E, 3, 2);
    const [a, b] = ps;
    a.coins = 99; b.coins = 99; b.hp = 3;
    buyAt(w, a, slotOf(w, "weapon", 0));
    buyAt(w, b, slotOf(w, "heart"));
    const snap = buildSnapshot(w, a.id, 0, [], 0, true, { worldId: "room:TEST" });
    const decoded = jsonCodec.decodeServer(jsonCodec.encodeServer(snap)) as Extract<ServerMsg, { t: "snap" }>;
    check("the snapshot carries the stall", decoded.shop !== null);
    check("claim + buyer state survives encode/decode byte-for-byte",
      JSON.stringify(decoded.shop) === JSON.stringify(toShopWire(w.shop!)));
    const rebuilt = shopFromWire(decoded.shop!);
    check("shopFromWire(toShopWire(s)) is lossless",
      JSON.stringify(rebuilt) === JSON.stringify(w.shop));
    check("non-shop floors carry shop: null on the wire",
      (buildSnapshot(createWorld(0xB1E, 4), LOCAL_ID, 0, [], 0, true, { worldId: "room:TEST" }) as Extract<ServerMsg, { t: "snap" }>).shop === null);
  }

  section("wire: a per-viewer read of one shared wire agrees for every client");
  {
    const { w, ps } = partyWorld(0xB1F, 3, 2);
    const [a, b] = ps;
    a.coins = 99;
    const weapon = slotOf(w, "weapon", 0);
    buyAt(w, a, weapon);
    const wire = shopFromWire(toShopWire(w.shop!));
    const slot = wire.slots.find((s) => s.id === weapon.id)!;
    check("the winner reads OWNED, the teammate reads SOLD — one wire, honest per-viewer states",
      shopSlotStatusFor(wire, slot, shopViewerOf(a)) === "owned"
      && shopSlotStatusFor(wire, slot, shopViewerOf(b)) === "sold");
  }
}

// ---- 8. pure builder edge ----

function builderTests(): void {
  section("builder: buildShopState is a pure function of (seed, floor, room)");
  {
    const d = generateDungeon(0x5EED, 3);
    const room = d.rooms.find((r) => r.kind === "shop")!;
    const s1: ShopState = buildShopState(0x5EED, 3, room);
    const s2: ShopState = buildShopState(0x5EED, 3, room);
    check("identical inputs build identical shops", JSON.stringify(s1) === JSON.stringify(s2));
    check("all stations inside the room's walls",
      s1.slots.every((slot) => isInRoom(room, Math.floor(slot.x / TILE), Math.floor(slot.y / TILE)))
      && isInRoom(room, Math.floor(s1.keeperX / TILE), Math.floor(s1.keeperY / TILE)));
    const spacing = s1.slots.every((slot, i) =>
      s1.slots.every((o, j) => i === j || Math.hypot(slot.x - o.x, slot.y - o.y) >= TILE * 1.4));
    check("stations are spaced for unambiguous per-station focus (>= 1.4 tiles apart)", spacing);
  }
}

placementTests();
sanctuaryTests();
noTouchPurchaseTests();
buyCommandTests();
ownershipTests();
rerollTests();
flowAndWireTests();
builderTests();

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(failures.map((f) => `  FAILED: ${f}`).join("\n") + "\n");
  process.exit(1);
}
process.stdout.write("Patch's shop contracts hold (placement, sanctuary, explicit-buy-only, ownership, reroll, wire).\n");
