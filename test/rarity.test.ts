// The weapon rarity + mystery suite: rarity tagging and weighting (legendaries are
// GENUINELY rarer and gated off the earliest floors), deterministic mystery reveals that
// never yield an invalid/empty weapon, each legendary's signature gimmick firing through
// the real sim, rarity-priced shop stock, the tooltip's rarity treatment, and co-op /
// authority determinism (identical rolls per seed, party-size-invariant tables, hidden
// identities on the wire).
//
// Run: npm run test:rarity

import { JSDOM } from "jsdom";
import {
  WEAPONS, PICKUP_WEAPONS, rollWeaponRarity, rollMysteryTwist, WEAPON_RARITY_COLOR,
} from "../src/sim/weapons.js";
import { createWeaponBag, drawWeaponFromBag } from "../src/sim/weaponBag.js";
import type { WeaponBag } from "../src/sim/weaponBag.js";
import {
  WEAPON_RARITY_WEIGHT, LEGENDARY_MIN_FLOOR, BOSS_CHEST_LEGENDARY_MULT, MYSTERY,
  SHOP_RARITY_PRICE_MULT, SHOP, SUSTAIN, BOSS_DPS_CEILING, WEAPON_BOSS_COEF,
} from "../src/sim/balance.js";
import {
  createWorld, stepWorld, descend, devSpawnEnemy, acquireWeaponInWorld, spawnPlayerInWorld,
  buyFromShopInWorld,
} from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { InputCmd, PlayerId } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { WeaponId, WeaponRarity, Pickup, Chest, Bullet } from "../src/sim/types.js";
import { weaponDisplayStats, lowHpFrac } from "../src/sim/weaponStats.js";
import { createMods } from "../src/sim/items.js";
import { buildShopState, shopWeaponPrice, shopSlotStatusFor } from "../src/sim/shop.js";
import { toPickupWire, pickupFromWire, toShopWire, jsonCodec, buildSnapshot } from "../src/net/protocol.js";
import { Rng } from "../src/sim/rng.js";
import * as C from "../src/sim/constants.js";

const DT = 1 / 60;
const LEGENDARIES: readonly WeaponId[] = ["reaper", "swarm", "midas", "phase", "vortex", "singularity", "oddsmaker", "margin_call"];

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

function idle(seq: number): InputCmd {
  return { seq, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };
}
function step(w: WorldState, cmd: InputCmd): SimEvent[] {
  return stepWorld(w, new Map([[LOCAL_ID, cmd]]), DT);
}
function stepFor(w: WorldState, seconds: number, ev?: SimEvent[]): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const out = step(w, idle(w.tick + 1));
    if (ev) ev.push(...out);
  }
}
function fireAt(w: WorldState, aim: number): SimEvent[] {
  return step(w, { seq: w.tick + 1, moveX: 0, moveY: 0, aim, firing: true, dash: false });
}

// ---- rarity tagging + the weighted, gated roll ----

function taggingGates(): void {
  section("rarity tagging: every weapon carries a tier; the legendary five are legendary");
  check("every WEAPONS entry has a valid rarity",
    (Object.keys(WEAPONS) as WeaponId[]).every((id) => ["common", "rare", "legendary"].includes(WEAPONS[id].rarity)));
  check("every canonical legendary is tagged legendary and sits in the pickup pool",
    LEGENDARIES.every((id) => WEAPONS[id].rarity === "legendary" && PICKUP_WEAPONS.includes(id)));
  check("no pre-existing weapon was promoted to legendary (the tier is the new content's)",
    (Object.keys(WEAPONS) as WeaponId[]).filter((id) => WEAPONS[id].rarity === "legendary").length === LEGENDARIES.length);
  check("the starter pistol is common", WEAPONS.pistol.rarity === "common");
  check("the weight ladder is strictly decreasing (common > rare > legendary)",
    WEAPON_RARITY_WEIGHT.common > WEAPON_RARITY_WEIGHT.rare && WEAPON_RARITY_WEIGHT.rare > WEAPON_RARITY_WEIGHT.legendary);
  check("every rarity has an accent swatch", (["common", "rare", "legendary"] as WeaponRarity[])
    .every((r) => WEAPON_RARITY_COLOR[r].startsWith("#")));
}

// The world's composition of tier roll + bag deal, replicated for statistical gates
// (rollBagWeapon is world-internal; this mirrors it exactly).
function drawTiered(bag: WeaponBag, rand: () => number, floor: number, opts: { isPremium?: boolean; isMystery?: boolean } = {}): WeaponId {
  const tier = rollWeaponRarity(rand, floor, opts);
  const exclude = new Set<WeaponId>();
  if (!(opts.isMystery === true || floor >= LEGENDARY_MIN_FLOOR)) {
    for (const id of LEGENDARIES) exclude.add(id);
  }
  return drawWeaponFromBag(bag, exclude, tier);
}

function weightingGates(): void {
  section("weighting: legendary TIERS are genuinely rarer, tracking the weighted table");
  const rng = new Rng(0xAABBA);
  const N = 20000;
  const counts: Record<WeaponRarity, number> = { common: 0, rare: 0, legendary: 0 };
  for (let i = 0; i < N; i++) counts[rollWeaponRarity(() => rng.next(), 6)]++;
  // Expected tier shares over the 22-weapon pickup pool: common 8x10, rare 9x5, legendary 5x1.
  const commons = PICKUP_WEAPONS.filter((id) => WEAPONS[id].rarity === "common").length;
  const rares = PICKUP_WEAPONS.filter((id) => WEAPONS[id].rarity === "rare").length;
  const total = commons * WEAPON_RARITY_WEIGHT.common + rares * WEAPON_RARITY_WEIGHT.rare + LEGENDARIES.length * WEAPON_RARITY_WEIGHT.legendary;
  const expectedLegendary = (LEGENDARIES.length * WEAPON_RARITY_WEIGHT.legendary) / total;
  check("legendary tier share is small and near its expected weight",
    counts.legendary / N > expectedLegendary * 0.6 && counts.legendary / N < expectedLegendary * 1.4,
    `${((counts.legendary / N) * 100).toFixed(1)}% vs expected ${(expectedLegendary * 100).toFixed(1)}%`);
  // Per-WEAPON frequency is the honest ordering claim (tier totals scale with pool size:
  // 17 rares collectively outdraw 7 commons, but each individual common outdraws each
  // individual rare, which outdraws each individual legendary).
  check("per-weapon drop frequency orders common > rare > legendary",
    counts.common / commons > counts.rare / rares && counts.rare / rares > counts.legendary / LEGENDARIES.length,
    `${(counts.common / commons).toFixed(0)}/${(counts.rare / rares).toFixed(0)}/${(counts.legendary / LEGENDARIES.length).toFixed(0)} per weapon`);

  section("weighting THROUGH the bag: dealt weapons stay legendary-scarce over whole runs");
  {
    // Many short runs (fresh bag each, a handful of draws like a real run's early floors):
    // the dealt legendary share must track the tier weighting, not the bag's flat 5/22.
    const rng5 = new Rng(0x9A6);
    let draws = 0, legendaries = 0;
    for (let s = 0; s < 800; s++) {
      const bag = createWeaponBag(0xB00 + s * 7919);
      for (let i = 0; i < 8; i++) {
        draws++;
        if (WEAPONS[drawTiered(bag, () => rng5.next(), 6)].rarity === "legendary") legendaries++;
      }
    }
    const share = legendaries / draws;
    check("dealt legendary share stays well under the flat-bag rate (weighting is real)",
      share > 0.005 && share < LEGENDARIES.length / PICKUP_WEAPONS.length * 0.7,
      `${(share * 100).toFixed(1)}% vs flat ${(LEGENDARIES.length / PICKUP_WEAPONS.length * 100).toFixed(1)}%`);
  }

  section("floor gate: no legendary from any identified deal before LEGENDARY_MIN_FLOOR");
  const rng2 = new Rng(0xF100);
  let earlyLegendary = 0;
  for (let s = 0; s < 300; s++) {
    const bag = createWeaponBag(0xF1 + s * 613);
    for (const floor of [1, 2, 3]) {
      for (let i = 0; i < 3; i++) {
        if (WEAPONS[drawTiered(bag, () => rng2.next(), floor)].rarity === "legendary") earlyLegendary++;
      }
    }
  }
  check("floors 1-3 never deal an identified legendary", earlyLegendary === 0 && LEGENDARY_MIN_FLOOR === 4);
  check("the tier roll itself never opens legendary below the gate",
    (() => { const r = new Rng(1); for (let i = 0; i < 5000; i++) { if (rollWeaponRarity(() => r.next(), 3) === "legendary") return false; } return true; })());
  let lateLegendary = 0;
  for (let i = 0; i < 5000; i++) {
    if (rollWeaponRarity(() => rng2.next(), LEGENDARY_MIN_FLOOR) === "legendary") lateLegendary++;
  }
  check("the gate floor itself CAN roll the legendary tier", lateLegendary > 0, `${lateLegendary}/5000`);

  section("premium (boss chest) rolls boost the legendary weight; mystery ignores the gate");
  const rng3 = new Rng(0xB0057);
  let plain = 0, premium = 0, mysteryEarly = 0;
  for (let i = 0; i < 20000; i++) {
    if (rollWeaponRarity(() => rng3.next(), 5) === "legendary") plain++;
    if (rollWeaponRarity(() => rng3.next(), 5, { isPremium: true }) === "legendary") premium++;
    if (rollWeaponRarity(() => rng3.next(), 1, { isMystery: true }) === "legendary") mysteryEarly++;
  }
  check(`premium legendary odds run ~${BOSS_CHEST_LEGENDARY_MULT}x the plain roll (weight-adjusted)`,
    premium > plain * 2.5 && premium < plain * (BOSS_CHEST_LEGENDARY_MULT + 1.2),
    `plain=${plain} premium=${premium}`);
  check("a floor-1 MYSTERY can gamble into the legendary tier (the identified gate does not apply)",
    mysteryEarly > 0, `${mysteryEarly}/20000`);

  section("the bag survives the tier request: variety + never-hangs contracts hold");
  {
    // A full pass of PLAIN draws still deals every pickup weapon exactly once (the
    // weaponbag suite's core contract, untouched by the rarity plumbing).
    const bag = createWeaponBag(0xA11CE);
    const dealt: WeaponId[] = [];
    for (let i = 0; i < PICKUP_WEAPONS.length; i++) dealt.push(drawWeaponFromBag(bag, new Set()));
    check("a plain full pass is still a permutation of the pool", new Set(dealt).size === PICKUP_WEAPONS.length);
  }
  {
    // A tier request for a SPENT tier falls through to the plain deal instead of hanging.
    const bag = createWeaponBag(0xF00D5);
    for (let i = 0; i < PICKUP_WEAPONS.length - 1; i++) drawWeaponFromBag(bag, new Set());
    const last = drawWeaponFromBag(bag, new Set(), "legendary");
    check("a spent-tier request still deals a valid weapon (statistical, never a hang)",
      PICKUP_WEAPONS.includes(last));
  }
}

// ---- world sources: pedestals, wood chests, boss chest ----

function sourceGates(): void {
  section("floor pedestals: gated off the early floors, mystery wraps appear at depth");
  {
    let earlyOk = true;
    for (let s = 0; s < 30; s++) {
      const w = createWorld(0x9E57 + s * 131, 1);
      descend(w, 2, []);
      for (const c of w.chests) {
        if (c.weapon !== undefined && (WEAPONS[c.weapon].rarity === "legendary" || c.isMystery)) earlyOk = false;
      }
    }
    check("floor 2 pedestals are never legendary and never mystery (30 seeds)", earlyOk);
  }
  {
    let sawMystery = false;
    let sawLegendary = false;
    let mysteryTwistOk = true;
    for (let s = 0; s < 120 && !(sawMystery && sawLegendary); s++) {
      const w = createWorld(0x3A9D + s * 977, 1);
      for (const floor of [4, 6, 7, 8]) {
        descend(w, floor, []);
        for (const c of w.chests) {
          if (c.weapon === undefined) continue;
          if (c.isMystery) {
            sawMystery = true;
            if (c.twist === undefined) mysteryTwistOk = false;
          } else if (WEAPONS[c.weapon].rarity === "legendary") sawLegendary = true;
        }
      }
    }
    check("deep floors stock mystery pedestals (twist baked at spawn)", sawMystery && mysteryTwistOk);
    check("deep floors can stock an identified legendary pedestal", sawLegendary);
  }

  section("boss chest: the choice set can carry a legendary (premium weighting)");
  {
    let sawLegendaryChoice = false;
    for (let s = 0; s < 40 && !sawLegendaryChoice; s++) {
      const w = createWorld(0xB0B5 + s * 419, 5, { isSandbox: true });
      w.isGodMode = true;
      const p = w.players.get(LOCAL_ID)!;
      w.encounterPlayers = 4; // 5 choices per chest — the widest legal set
      const boss = devSpawnEnemy(w, "boss", p.x + 150, p.y);
      for (let t = 1; t <= 60 * 20 && !boss.dead; t++) {
        w.bullets.push({
          x: boss.x, y: boss.y, vx: 1, vy: 0, radius: 30, life: 0.05, friendly: true,
          owner: LOCAL_ID, damage: 5000, color: "#fff", pierce: 0, hitList: null, isCrit: false,
        });
        step(w, idle(t));
      }
      const chest = w.chests.find((c) => c.kind === "boss")!;
      p.x = chest.x; p.y = chest.y;
      step(w, idle(9999));
      p.x = 40; p.y = 40;
      if (w.pickups.some((k) => k.isBossChoice && k.weapon !== null && WEAPONS[k.weapon].rarity === "legendary")) {
        sawLegendaryChoice = true;
      }
    }
    check("a boss chest choice set rolls a legendary within 40 seeds", sawLegendaryChoice);
  }

  section("wood chest ambient roll: the mystery band exists at depth, never on early floors");
  check("the mystery band is authored after the weapon band",
    SUSTAIN.woodChestMystery > 0 && MYSTERY.minFloor >= 2);
}

// ---- mystery: determinism, reveal validity, twists ----

function mysteryDeterminismGates(): void {
  section("mystery determinism: identical seeds bake identical contents + twists");
  const bake = (seed: number): string => {
    const w = createWorld(seed, 1);
    const out: string[] = [];
    for (const floor of [3, 4, 6, 7, 9]) {
      descend(w, floor, []);
      for (const c of w.chests) {
        if (c.weapon !== undefined) out.push(`${floor}:${c.weapon}:${c.isMystery ?? false}:${c.twist ?? "-"}`);
      }
      if (w.shop) for (const s of w.shop.slots) out.push(`${floor}:shop:${s.weapon}:${s.isMystery}:${s.twist}:${s.price}`);
    }
    return out.join("|");
  };
  check("two worlds from one seed bake byte-identical pedestal/shop stock", bake(0xD371) === bake(0xD371));
  check("a different seed bakes different stock", bake(0xD371) !== bake(0xD372));

  section("§4 invariance: party size buys quantity, never rarity");
  {
    // The tier roll is structurally party-blind (it takes no player count), and the P4
    // floor stocks MORE pedestals from the same seeded machinery — never a richer table.
    const stock = (players: number): Array<{ weapon: WeaponId; isMystery: boolean }> => {
      const w = createWorld(0x9AB7, 1, { skipLocalPlayer: true });
      for (let i = 0; i < players; i++) spawnPlayerInWorld(w, `p${i}`);
      descend(w, 6, []);
      return w.chests.filter((c) => c.weapon !== undefined)
        .map((c) => ({ weapon: c.weapon!, isMystery: c.isMystery === true }));
    };
    const p1 = stock(1);
    const p4 = stock(4);
    check("P1 stocks 1 pedestal, P4 stocks 2 (quantity), all from the shared pool",
      p1.length === 1 && p4.length === 2
      && [...p1, ...p4].every((k) => PICKUP_WEAPONS.includes(k.weapon)),
      `P1=${p1.map((k) => k.weapon).join(",")} P4=${p4.map((k) => k.weapon).join(",")}`);
  }

  section("mystery reveal: never empty/invalid, dupes reroll into something unowned");
  {
    const rng = new Rng(0x4E4EA1);
    let allValid = true;
    for (let s = 0; s < 250; s++) {
      const bag = createWeaponBag(0x4E4E + s * 971);
      for (let i = 0; i < 8; i++) {
        const id = drawTiered(bag, () => rng.next(), 1 + (i % 12), { isMystery: true });
        if (!PICKUP_WEAPONS.includes(id) || WEAPONS[id] === undefined) allValid = false;
        const twist = rollMysteryTwist(() => rng.next());
        if (!["plain", "blessed", "cursed"].includes(twist)) allValid = false;
      }
    }
    check("2000 mystery deals all yield a real, pickup-poolable weapon and a valid twist", allValid);
  }
  {
    const w = createWorld(0x4E4EA2, 1, { isSandbox: true });
    const p = w.players.get(LOCAL_ID)!;
    acquireWeaponInWorld(w, LOCAL_ID, "shotgun");
    const plant = (twist: "plain" | "blessed" | "cursed", weapon: WeaponId): SimEvent[] => {
      w.pickups.push({
        id: w.nextPickupId++, kind: "weapon", x: p.x, y: p.y, radius: 16,
        weapon, isMystery: true, twist,
      });
      return step(w, idle(w.tick + 1));
    };
    const ev1 = plant("plain", "railgun");
    const reveal1 = ev1.find((e) => e.t === "mysteryReveal");
    check("collection reveals + grants + equips the baked identity",
      reveal1 !== undefined && reveal1.t === "mysteryReveal" && reveal1.weapon === "railgun"
      && p.ownedWeapons.includes("railgun") && p.weapon === "railgun");

    const ownedBefore = p.ownedWeapons.length;
    const ev2 = plant("plain", "railgun"); // already owned: must reroll distinct
    const reveal2 = ev2.find((e) => e.t === "mysteryReveal");
    check("an already-owned reveal rerolls into a weapon the collector lacks (never dead)",
      reveal2 !== undefined && reveal2.t === "mysteryReveal" && reveal2.weapon !== "railgun"
      && p.ownedWeapons.length === ownedBefore + 1
      && new Set(p.ownedWeapons).size === p.ownedWeapons.length);

    p.hp = 3;
    const ev3 = plant("blessed", "rapid");
    check("a blessed reveal heals exactly 1 heart",
      p.hp === 4 && ev3.some((e) => e.t === "heal"));

    p.fireCd = 0;
    plant("cursed", "burst");
    check("a cursed reveal jams the trigger for the authored beat",
      p.fireCd >= MYSTERY.cursedJamSeconds - 1e-9 && p.ownedWeapons.includes("burst"),
      `fireCd=${p.fireCd}`);
  }
}

// ---- the legendary gimmicks, fired through the real sim ----

function reaperGates(): void {
  section("Reaper: kills burst into seeking shards that cascade");
  const w = createWorld(0x4EA9E4, 1, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  acquireWeaponInWorld(w, LOCAL_ID, "reaper");
  const victim = devSpawnEnemy(w, "slime", p.x + 120, p.y);
  victim.hp = 1;
  const bystander = devSpawnEnemy(w, "bat", p.x + 150, p.y + 40);
  bystander.hp = bystander.maxHp = 2;
  let shardsAtFirstKill = -1;
  let killsSeen = 0;
  for (let t = 0; t < 90; t++) {
    // Hold fire once the first kill lands — everything after is the shards' own work.
    const evs = killsSeen === 0
      ? fireAt(w, Math.atan2(victim.y - p.y, victim.x - p.x))
      : step(w, idle(w.tick + 1));
    killsSeen += evs.filter((e) => e.t === "enemyKill").length;
    if (killsSeen > 0 && shardsAtFirstKill < 0) {
      shardsAtFirstKill = w.bullets.filter((b) => b.friendly && b.homing === C.KILL_SHARD_HOMING).length;
    }
    if (killsSeen >= 2) break;
  }
  check("the kill released the authored shard fan", shardsAtFirstKill === WEAPONS.reaper.killShards, `shards=${shardsAtFirstKill}`);
  check("the seeking shards carried the cascade into the bystander (2 kills off ~1 trigger)",
    killsSeen >= 2 && bystander.dead, `kills=${killsSeen}`);
  check("cascade damage decays geometrically (bounded by construction)",
    C.KILL_SHARD_DMG_FRAC < 1 && WEAPONS.reaper.damage * C.KILL_SHARD_DMG_FRAC ** 3 < C.KILL_SHARD_MIN_DMG);
}

function swarmGates(): void {
  section("Hive: one slow trigger pull, five accelerating seekers");
  const w = createWorld(0x511A9, 1, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  acquireWeaponInWorld(w, LOCAL_ID, "swarm");
  fireAt(w, 0);
  const darts = w.bullets.filter((b) => b.friendly);
  check("one pull releases the full 5-dart volley, every dart seeking",
    darts.length === 5 && darts.every((b) => b.homing !== undefined && b.accel === WEAPONS.swarm.accel));
  check("the cycle is a real commitment (SLOW cadence)", WEAPONS.swarm.fireCd >= 1);
  const speed0 = Math.hypot(darts[0].vx, darts[0].vy);
  stepFor(w, 0.5);
  const speed1 = Math.hypot(darts[0].vx, darts[0].vy);
  check("darts accelerate in flight", speed1 > speed0 + WEAPONS.swarm.accel! * 0.5 * 0.9,
    `${speed0.toFixed(0)} -> ${speed1.toFixed(0)} px/s`);
}

function midasGates(): void {
  section("Midas: eats a coin per shot for double damage; fires weak when broke");
  const w = createWorld(0x1D0A5, 1, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  acquireWeaponInWorld(w, LOCAL_ID, "midas");
  p.coins = 2;
  fireAt(w, 0);
  const fed = w.bullets.find((b) => b.friendly)!;
  check("a FED shot eats exactly one coin and doubles the round",
    p.coins === 1 && fed.damage === WEAPONS.midas.damage * WEAPONS.midas.coinBoost!);
  w.bullets = [];
  p.coins = 0;
  p.fireCd = 0;
  fireAt(w, 0);
  const broke = w.bullets.find((b) => b.friendly)!;
  check("a BROKE shot still fires — at honest base damage (never a locked trigger)",
    p.coins === 0 && broke.damage === WEAPONS.midas.damage);
  check("the Midas carries a boss coefficient (envelope: fed hits never dominate the boss window)",
    (WEAPON_BOSS_COEF.midas ?? 1) < 1);
}

function phaseGates(): void {
  section("Umbra: rounds pass through walls; every other gun's rounds die there");
  const runThroughWall = (weapon: WeaponId): { crossed: boolean; struck: boolean } => {
    const w = createWorld(0x0A51D, 1, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    acquireWeaponInWorld(w, LOCAL_ID, weapon);
    // A wall column two tiles east of the player, with a target beyond it.
    const tx = Math.floor(p.x / 48) + 2;
    for (let ty = 0; ty < w.dungeon.h; ty++) w.dungeon.tiles[ty * w.dungeon.w + tx] = 1;
    const target = devSpawnEnemy(w, "slime", (tx + 3) * 48, p.y);
    target.hp = target.maxHp = 60;
    fireAt(w, 0);
    let crossed = false;
    for (let t = 0; t < 90; t++) {
      step(w, idle(w.tick + 1));
      if (w.bullets.some((b) => b.friendly && b.x > (tx + 1) * 48)) crossed = true;
    }
    return { crossed, struck: target.hp < target.maxHp };
  };
  const umbra = runThroughWall("phase");
  const pistol = runThroughWall("pistol");
  check("Umbra rounds cross the wall and strike the body behind it", umbra.crossed && umbra.struck);
  check("ordinary rounds die on the same wall", !pistol.crossed && !pistol.struck);
}

function vortexGates(): void {
  section("Lodestone: the implosion yanks the pack onto the impact point");
  const w = createWorld(0x70A7E4, 1, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  acquireWeaponInWorld(w, LOCAL_ID, "vortex");
  // A spread pack around the shot's landing zone (life 1.1 x speed 480 flies far; the
  // direct target sits 200px out so the round detonates ON it).
  const center = devSpawnEnemy(w, "slime", p.x + 200, p.y);
  const north = devSpawnEnemy(w, "slime", p.x + 200, p.y - 90);
  const south = devSpawnEnemy(w, "slime", p.x + 200, p.y + 90);
  for (const e of [center, north, south]) { e.hp = e.maxHp = 50; e.spawnTimer = 99; e.speed = 0; }
  const gapBefore = Math.abs(north.y - south.y);
  const ev: SimEvent[] = [];
  fireAt(w, 0);
  stepFor(w, 0.6, ev);
  const gapAfter = Math.abs(north.y - south.y);
  check("the implosion event fired", ev.some((e) => e.t === "implosion"));
  check("flanking bodies were dragged toward the impact point (the pack clumps)",
    gapAfter < gapBefore - 40, `gap ${gapBefore.toFixed(0)} -> ${gapAfter.toFixed(0)}px`);
  check("everything in the radius took the splash", [center, north, south].every((e) => e.hp < e.maxHp));
  check("the splash is modest (the pull is the payload)", C.IMPLODE_SPLASH_FRAC < 1);
}

// ---- balance envelope: the legendaries stay under the boss DPS ceilings ----
// The same practical estimator model the god-build gate sweeps (accuracy defaults for
// the new ids), pinned per legendary at FULL god mods so a new gun can never slip past
// the King's 53 ceiling by construction.

function envelopeGates(): void {
  section("balance envelope: per-legendary practical boss DPS under every ceiling");
  const godMods = createMods();
  godMods.damageMult = 2.25;
  godMods.fireRateMult = 1.8;
  godMods.critChance = 0.5;
  godMods.critMult = 3;
  godMods.extraPellets = 3;
  const kingCeiling = BOSS_DPS_CEILING.boss ?? 53;
  for (const id of LEGENDARIES) {
    const wep = WEAPONS[id];
    const pellets = wep.pellets + godMods.extraPellets;
    const effPellets = 1 + Math.max(0, wep.pellets - 1) * 0.75; // added pellets count 0 vs bosses
    const coef = WEAPON_BOSS_COEF[id] ?? 1;
    const vuln = (1 - godMods.critChance) + godMods.critChance * 1.35;
    const rate = (1 / wep.fireCd) * godMods.fireRateMult;
    // The Midas models its FED damage — the coin drain is not a boss-window brake.
    const damage = wep.damage * (wep.coinBoost ?? 1) * godMods.damageMult;
    const spread = pellets > 1 ? Math.max(wep.spread, 0.26) : wep.spread;
    const accuracy = 0.85 * Math.max(0.35, 1 - spread * 0.55) * Math.min(1, Math.max(0.6, wep.speed / 420));
    const dps = damage * effPellets * coef * rate * vuln * accuracy;
    check(`${id} god-mod practical boss DPS ${dps.toFixed(1)} <= King ceiling ${kingCeiling}`,
      dps <= kingCeiling);
  }
  section("balance envelope: every legendary carries a real tradeoff field");
  check("reaper pays in per-shot restraint (sub-8 base DPS)", WEAPONS.reaper.damage / WEAPONS.reaper.fireCd < 8);
  check("swarm pays in cycle time (>= 1s)", WEAPONS.swarm.fireCd >= 1);
  check("midas pays in coins (the boost never comes free)", WEAPONS.midas.coinBoost !== undefined);
  check("phase pays in cadence + zero pierce", WEAPONS.phase.fireCd >= 0.5 && (WEAPONS.phase.basePierce ?? 0) === 0);
  check("vortex pays in raw damage (the pull is the payload)", WEAPONS.vortex.damage <= 2.5);
  check("oddsmaker pays in outcome control (one authored verb per deterministic roll)",
    WEAPONS.oddsmaker.gamble?.outcomes.length === 4);
}

// ---- shop: rarity pricing, the mystery pedestal, hidden wire identity ----

function shopGates(): void {
  section("shop: rarity-appropriate pricing off the unchanged ladder base");
  check("price multipliers ladder common < rare < legendary",
    SHOP_RARITY_PRICE_MULT.common === 1 && SHOP_RARITY_PRICE_MULT.rare > 1
    && SHOP_RARITY_PRICE_MULT.legendary > SHOP_RARITY_PRICE_MULT.rare);
  check("shopWeaponPrice applies the tier (and the mystery gamble price)",
    shopWeaponPrice(12, "shotgun", false) === 12
    && shopWeaponPrice(12, "railgun", false) === 15
    && shopWeaponPrice(12, "reaper", false) === 24
    && shopWeaponPrice(12, "reaper", true) === Math.round(12 * MYSTERY.shopPriceMult));
  {
    let pricesOk = true;
    let sawMysterySlot = false;
    let hiddenOk = true;
    for (let s = 0; s < 60; s++) {
      const w = createWorld(0x5409 + s * 613, 1);
      descend(w, 6, []);
      if (!w.shop) continue;
      for (const slot of w.shop.slots) {
        if (slot.kind !== "weapon") continue;
        const expected = shopWeaponPrice(SHOP.pedestalPrices[slot.id], slot.weapon!, slot.isMystery);
        if (slot.price !== expected) pricesOk = false;
        if (slot.isMystery) {
          sawMysterySlot = true;
          if (slot.twist === null) hiddenOk = false;
          // The wire must hide the identity while the sim keeps it.
          const wire = toShopWire(w.shop);
          if (wire.slots[slot.id].wpn !== null || !wire.slots[slot.id].myst) hiddenOk = false;
        }
      }
    }
    check("every shop weapon pedestal wears its rarity/mystery price (60 seeds)", pricesOk);
    check("mystery pedestals appear, keep their twist sim-side, and HIDE the identity on the wire",
      sawMysterySlot && hiddenOk);
  }

  section("shop: buying a mystery pedestal reveals, grants, and flips the slot honest");
  {
    // Find a seed whose F6 shop stalls a mystery pedestal.
    let w: WorldState | null = null;
    for (let s = 0; s < 100 && !w; s++) {
      const cand = createWorld(0xCAFE + s * 337, 1);
      descend(cand, 6, []);
      if (cand.shop?.slots.some((sl) => sl.isMystery)) w = cand;
    }
    check("a mystery shop seed exists", w !== null);
    if (w) {
      w.pendingBlessings.clear();
      const slot = w.shop!.slots.find((sl) => sl.isMystery)!;
      const p = w.players.get(LOCAL_ID)!;
      const hidden = slot.weapon!;
      p.coins = slot.price + 5;
      p.x = slot.x; p.y = slot.y;
      const status = shopSlotStatusFor(w.shop!, slot, {
        pid: LOCAL_ID, coins: p.coins, hp: p.hp, maxHp: p.maxHp,
        ownedWeapons: [hidden], ownedItemIds: [],
      });
      check("a mystery slot never reads OWNED (nobody knows what it is)", status === "buy");
      const ev: SimEvent[] = [];
      const outcome = buyFromShopInWorld(w, LOCAL_ID, slot.id, ev);
      const reveal = ev.find((e) => e.t === "mysteryReveal");
      check("the buy reveals + grants the identity and claims the pedestal",
        outcome === "ok" && reveal !== undefined && reveal.t === "mysteryReveal"
        && p.ownedWeapons.includes(reveal.weapon) && slot.soldTo === LOCAL_ID);
      check("the SOLD pedestal shows its true face (isMystery flips off, weapon revealed)",
        !slot.isMystery && slot.weapon !== null && toShopWire(w.shop!).slots[slot.id].wpn === slot.weapon);
    }
  }
}

// ---- wire: mystery pickups hide their identity; snapshots round-trip ----

function wireGates(): void {
  section("wire: a mystery pickup's identity NEVER rides the snapshot");
  const pickup: Pickup = {
    id: 7, kind: "weapon", x: 100, y: 200, radius: 16,
    weapon: "reaper", isMystery: true, twist: "blessed",
  };
  const wire = toPickupWire(pickup);
  check("toPickupWire hides wpn and flags myst", wire.wpn === null && wire.myst);
  const back = pickupFromWire(wire);
  check("pickupFromWire keeps the mystery flag without fabricating an identity",
    back.isMystery === true && back.weapon === null && back.twist === undefined);
  const identified: Pickup = { id: 8, kind: "weapon", x: 1, y: 2, radius: 16, weapon: "reaper" };
  check("an identified legendary rides the wire openly", toPickupWire(identified).wpn === "reaper");

  section("wire: a full snapshot with legendaries + mysteries encodes/decodes cleanly");
  const w = createWorld(0x3A11, 1, { isSandbox: true });
  acquireWeaponInWorld(w, LOCAL_ID, "vortex");
  w.pickups.push(pickup, identified);
  const raw = jsonCodec.encodeServer(buildSnapshot(w, LOCAL_ID, 0, [], 0, true, { worldId: "room:RAR" }));
  const decoded = jsonCodec.decodeServer(raw);
  check("the decoded snapshot carries both pickups with the mystery still hidden",
    decoded.t === "snap" && decoded.pickups.length === 2
    && decoded.pickups.find((k) => k.id === 7)!.wpn === null
    && decoded.pickups.find((k) => k.id === 7)!.myst
    && decoded.pickups.find((k) => k.id === 8)!.wpn === "reaper"
    && decoded.self!.wpns.includes("vortex"));
}

// ---- co-op / authority determinism ----

function determinismGates(): void {
  section("determinism: identical seeds + inputs replay the whole rarity system bit-identically");
  const run = (): string => {
    const w = createWorld(0xDE7E4, 4, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    p.coins = 30;
    acquireWeaponInWorld(w, LOCAL_ID, "reaper");
    acquireWeaponInWorld(w, LOCAL_ID, "vortex");
    for (let i = 0; i < 8; i++) {
      const e = devSpawnEnemy(w, i % 2 === 0 ? "slime" : "bat", p.x + 120 + (i % 4) * 50, p.y + (i % 3) * 40 - 40);
      e.hp = 2;
    }
    w.pickups.push({ id: 900, kind: "weapon", x: p.x - 30, y: p.y, radius: 16, weapon: "midas", isMystery: true, twist: "cursed" });
    const trace: string[] = [];
    for (let t = 0; t < 240; t++) {
      const evs = stepWorld(w, new Map<PlayerId, InputCmd>([[LOCAL_ID, {
        seq: t, moveX: Math.sin(t / 30), moveY: 0, aim: t / 40, firing: t % 2 === 0, dash: false,
      }]]), DT);
      for (const e of evs) if (e.t === "enemyKill" || e.t === "mysteryReveal" || e.t === "implosion") trace.push(JSON.stringify(e));
    }
    trace.push(JSON.stringify(w.players.get(LOCAL_ID)!.ownedWeapons));
    trace.push(String(w.players.get(LOCAL_ID)!.coins));
    trace.push(JSON.stringify(w.bullets.map((b) => [b.x, b.y, b.damage])));
    return trace.join("\n");
  };
  const a = run();
  const b = run();
  check("two identical runs (kills, reveals, implosions, purse, in-flight rounds) match exactly", a === b);

  section("authority: the reveal is a sim outcome (a shared world resolves one winner)");
  {
    const w = createWorld(0xC0071, 1, { isShared: true, skipLocalPlayer: true });
    const pa = spawnPlayerInWorld(w, "pa");
    const pb = spawnPlayerInWorld(w, "pb");
    w.enemies = []; w.pendingSpawns = [];
    w.pickups.push({ id: 55, kind: "weapon", x: pa.x, y: pa.y, radius: 16, weapon: "swarm", isMystery: true, twist: "plain" });
    pb.x = pa.x; pb.y = pa.y; // both standing on it: exactly one may collect
    const evs = stepWorld(w, new Map(), DT);
    const reveals = evs.filter((e) => e.t === "mysteryReveal");
    const owners = [pa, pb].filter((p) => p.ownedWeapons.includes("swarm"));
    check("exactly ONE reveal fires and exactly ONE player owns the weapon",
      reveals.length === 1 && owners.length === 1 && !w.pickups.some((k) => k.id === 55));
  }
}

// ---- tooltip / display stats: the rarity treatment is honest ----

async function tooltipGates(): Promise<void> {
  section("display stats: rarity + gimmick lines derive from the canonical weapon data");
  const mods = createMods();
  check("weaponDisplayStats reports each weapon's true tier",
    (Object.keys(WEAPONS) as WeaponId[]).every((id) => weaponDisplayStats(id, mods, 0).rarity === WEAPONS[id].rarity));
  const roles: Array<[WeaponId, string]> = [
    ["reaper", "REAP THE PACK"], ["swarm", "UNLEASH THE SWARM"], ["midas", "SPEND COINS FOR POWER"],
    ["phase", "SHOOT THROUGH WALLS"], ["vortex", "DRAG THEM TOGETHER"],
  ];
  for (const [id, role] of roles) {
    check(`${id} role reads "${role}"`, weaponDisplayStats(id, mods, 0).role === role,
      weaponDisplayStats(id, mods, 0).role);
  }
  const tag = (id: WeaponId) => weaponDisplayStats(id, mods, 0).mechanics.map((m) => m.tag);
  check("each gimmick surfaces its mechanic line",
    tag("reaper").includes("REAP") && tag("swarm").includes("ACCEL") && tag("midas").includes("GILDED")
    && tag("phase").includes("PHASE") && tag("vortex").includes("IMPLODE"));

  section("tooltip DOM: the header wears the rarity badge in every tier");
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLImageElement: dom.window.HTMLImageElement,
  });
  const { renderTipInto } = await import("../src/game/hud.js");
  const tipFor = (id: WeaponId) => {
    const tip = dom.window.document.createElement("div");
    renderTipInto(tip, {
      id, name: WEAPONS[id].name, isCurrent: false,
      card: weaponDisplayStats(id, createMods(), lowHpFrac(6, 6)),
    }, null);
    return tip;
  };
  const legendary = tipFor("reaper");
  check("a legendary card badges LEGENDARY in the header",
    legendary.querySelector(".th .tw")?.textContent === "LEGENDARY"
    && legendary.querySelector(".th .tw")?.classList.contains("legendary") === true);
  check("a rare card badges RARE", tipFor("railgun").querySelector(".th .tw")?.textContent === "RARE");
  check("a common card badges COMMON (the line is always present, never a mystery)",
    tipFor("pistol").querySelector(".th .tw")?.textContent === "COMMON");
  check("the rarity line sits beside the name, above the role verb",
    legendary.querySelector(".th .tn")?.textContent === "REAPER"
    && legendary.querySelector(".tj")?.textContent === "REAP THE PACK");
}

async function main(): Promise<void> {
  taggingGates();
  weightingGates();
  sourceGates();
  mysteryDeterminismGates();
  reaperGates();
  swarmGates();
  midasGates();
  phaseGates();
  vortexGates();
  envelopeGates();
  shopGates();
  wireGates();
  determinismGates();
  await tooltipGates();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll rarity/mystery/legendary assertions hold.\n");
}

await main();
