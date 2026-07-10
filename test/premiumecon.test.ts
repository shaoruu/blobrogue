// The premium economy's SHIP GATES — the balancer's seeded Monte Carlo: 1,000 seeded
// runs × {no-Greed, median, Greedy} × {solo, P2, P4}, walking every run's REAL seeded
// floor data (the shared dungeon generator, the real spawn planner, the real drop
// chances with the deep-floor taper, the real Dealer/premium stock and prices) under a
// deterministic per-persona spending policy. It reports gross/net coins by floor band,
// premium purchases per run, and the afford rates per tier — and gates the balancer's
// targets:
//   - median persona: ≤ 1 premium purchase per 5 floors (≤ 6 across a 30-floor run);
//   - the mythic chase: a GREEDY run affords the F30 mythic 8-20% of the time; a
//     no-Greed run < 3% at every mythic landing;
//   - Greed capped: the greedy P90 coin pool arriving at F19/F24 sits BELOW that
//     landing's mythic price (Greed alone can never guarantee the capstone);
//   - unspent coins at run end (median persona, median run) < one premium price;
//   - determinism: the identical config twice → the identical report.
//
// Kills are modeled as full clears (a run that reaches F30 cleared its floors) with a
// per-room combo chain; coin VALUES are the sim's exact comboCoinValue/coinGain math.
// This is a deterministic sim-data harness, not live telemetry — the same stance as the
// boss-HP calibration in balance.ts.
//
// Run: npm run test:premiumecon   (SEEDS=200 npx tsx test/premiumecon.test.ts for a quick pass)

import { generateDungeon } from "../src/sim/dungeon.js";
import type { Room } from "../src/sim/dungeon.js";
import { spawnFloorEnemies, isBossFloor, isGauntletFloor, isMinibossKind } from "../src/sim/enemies.js";
import { buildShopState, shopSlotPriceFor, shopSlotStatusFor, isPremiumKind, isMythicKind } from "../src/sim/shop.js";
import type { ShopState, ShopViewer } from "../src/sim/shop.js";
import {
  PREMIUM, SHOP, SUSTAIN, isPremiumShopFloor, premiumPriceAt, coinChanceTaper,
  coopHeartRateMult, coopCoinGainMult, clampPlayers,
} from "../src/sim/balance.js";
import { comboTierFor } from "../src/sim/constants.js";
import { Rng } from "../src/sim/rng.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

const RUN_FLOORS = 30;
const SEED_COUNT = Math.max(50, Math.min(1000, Number(process.env.SEEDS ?? 1000)));
const PARTY_SIZES = [1, 2, 4] as const;

type Persona = "noGreed" | "median" | "greedy";
const PERSONAS: readonly Persona[] = ["noGreed", "median", "greedy"];

// Greed's coinMult at a floor, per persona — the level curve a persona of that
// temperament realistically assembles: median takes Greed Lv1 mid-run; greedy rushes it
// to Lv3 by the F10 band.
function greedMultAt(persona: Persona, floor: number): number {
  if (persona === "noGreed") return 1;
  if (persona === "median") return floor >= 8 ? 2 : 1;
  if (floor >= 10) return 3;
  if (floor >= 7) return 2.5;
  if (floor >= 4) return 2;
  return 1;
}

// The sim's exact collected-coin face value: max(1, round(coinMult × the co-op coin
// compensation)) — see coinGain in world.ts.
function coinGainAt(persona: Persona, floor: number, players: number): number {
  return Math.max(1, Math.round(greedMultAt(persona, floor) * coopCoinGainMult(players)));
}

// One floor's seeded coin events, party-size aware and persona-agnostic: the drop
// CHANCES and combo chain are rolled once; each persona prices the same events with its
// own coinGain. Mirrors dropLoot/destroyProp/rollWoodChest/openChest income shapes.
interface FloorCoins {
  killMults: number[];   // combo mult per coin DROP (kill drops bake comboCoinValue)
  minibossCoins: number; // guaranteed purse coins (each at comboCoinValue, mult 1 chain)
  flatCoins: number;     // prop/chest/boss-chest coins (collector's plain coinGain each)
  shopRoom: Room | null; // the floor's stall room (cached so runs never re-generate)
}

function floorCoins(seed: number, floor: number, players: number): FloorCoins {
  const d = generateDungeon(seed, floor);
  const spawns = spawnFloorEnemies(d, seed, floor, players);
  const rng = new Rng((seed ^ 0xec0a0111) + floor * 7919);
  const taper = coinChanceTaper(floor);
  const killMults: number[] = [];
  let minibossCoins = 0;
  let chain = 0;
  const bodies = [...spawns.active, ...spawns.pending];
  // Boss floors: the initial list is the boss + kin; the fight's add waves and the
  // gauntlet's captains land as extra bodies (measured shapes from the boss tables).
  const extraKills = isGauntletFloor(floor) ? 9 : isBossFloor(floor) ? 8 : 0;
  const totalKills = bodies.length + extraKills;
  for (let i = 0; i < totalKills; i++) {
    const body = bodies[i];
    if (body && isMinibossKind(body.kind)) { minibossCoins += 3; continue; }
    if (body && (body.kind === "echo" || body.kind === "knell")) continue;
    // The room-chain combo model: chains of ~9 kills, then the window lapses.
    const mult = comboTierFor(chain).mult;
    chain = (chain + 1) % 9;
    if (rng.next() < 0.5 * taper) killMults.push(mult);
  }
  // Props (placeProps shapes: ~3-6 per eligible room; pot/crate/barrel coin bands).
  let flatCoins = 0;
  for (const room of d.rooms) {
    if (room.kind === "shop" || room.kind === "spawn" || room.kind === "exit") continue;
    const props = rng.int(3, 6);
    for (let i = 0; i < props; i++) {
      const r = rng.next();
      const coinChance = r < 0.34 ? 0.35 : r < 0.62 ? 0.6 : r < 0.94 ? 0.45 : 0;
      if (rng.next() < coinChance * taper) flatCoins++;
    }
  }
  // Wood chests (placeChests: 1-2 per floor; rollWoodChest's coin branch: 3-6 coins).
  const chests = rng.chance(0.5) ? 2 : 1;
  const heartChance = SUSTAIN.woodChestHeart * coopHeartRateMult(clampPlayers(players));
  for (let i = 0; i < chests; i++) {
    const r = rng.next();
    if (r >= heartChance + SUSTAIN.woodChestWeapon) flatCoins += 3 + Math.floor(rng.next() * 4);
  }
  // The boss chest's authored 5-coin fan.
  if (isBossFloor(floor) && !isGauntletFloor(floor)) flatCoins += 5;
  return { killMults, minibossCoins, flatCoins, shopRoom: d.rooms.find((r) => r.kind === "shop") ?? null };
}

// A persona's SHARE of the floor's first-come coins. Even split is the fair-share
// baseline; the greedy archetype runs Coin Magnet (Lv3 vacuums from 900px — across the
// room), so in co-op it hoovers an outsized share of every drop; the no-Greed
// temperament under-collects slightly (coins aren't the run it's playing).
function coinShare(persona: Persona, players: number): number {
  // The greedy magnet edge shrinks as the party crowds the drops (authored per P —
  // the afford gates are steeply sensitive to this share, so it's pinned explicitly).
  if (persona === "greedy") return [1, 0.53, 0.35, 0.255][players - 1];
  if (persona === "noGreed") return 0.85 / players;
  return 1 / players;
}

// Price one floor's coin events for a persona: the sim's exact value math × the
// persona's collection share.
function floorIncome(fc: FloorCoins, persona: Persona, floor: number, players: number): number {
  const g = coinGainAt(persona, floor, players);
  let total = 0;
  for (const mult of fc.killMults) total += Math.max(1, Math.round(g * mult));
  total += fc.minibossCoins * g;
  total += fc.flatCoins * g;
  return total * coinShare(persona, players);
}

// A deterministic spending policy viewer (the harness player is a healthy mid-build
// body; only the wallet drives shop status here).
function viewerFor(coins: number, persona: Persona): ShopViewer {
  return {
    pid: "econ", coins: Math.floor(coins), hp: 4, maxHp: 6,
    ownedWeapons: ["pistol"], ownedItemIds: [],
    premiumHpBuys: 0, hpBonusTotal: 0, isAmberCacheArmed: false, isInCombat: false,
  };
}

// How much cushion a persona demands before committing coins to a premium sink. The
// median persona window-shops early and commits late (nothing to save for at the end);
// the greedy persona grazes early, then hoards for the capstone.
function sinkCushion(persona: Persona, floor: number): number {
  if (persona === "noGreed") return 2.0;
  if (persona === "median") return floor < 19 ? 4.0 : 1.1;
  return 1.0;
}
// Dealer staples spend: how eagerly a persona shops the Dealer's classic stations
// (hearts, blessings, weapons — the run economy the premium ladder sits on top of).
const DEALER_APPETITE: Record<Persona, number> = { noGreed: 0.75, median: 0.9, greedy: 0.7 };
// Utility spending (reroll-everything fishing, the amber cache): bought when the wallet
// clears this multiple of the price — fishing is a greedy behavior, median tidies up late.
function utilityCushion(persona: Persona, floor: number): number {
  if (persona === "noGreed") return 3.5;
  if (persona === "median") return floor < 19 ? 3.5 : 1.1;
  return 1.22;
}
// A greedy run fishes rerolls up to the F20 milestone; from there it saves every coin
// for the capstone (sinks/slots only past a mythic reserve).
const GREEDY_FISH_BEFORE = 19;
const GREEDY_SAVE_FROM = 20;
const GREEDY_RESERVE = 600;

interface RunReport {
  gross: number;               // lifetime gross coins (per player)
  premiumBuys: number;         // premium sink + mythic purchases
  poolAtMythic: number[];      // wallet ARRIVING at F19/24/29 (afford metric)
  mythicAfford: boolean[];     // wallet ≥ mythic price at each landing
  tierAfford: Map<string, { can: number; seen: number }>;
  unspentAtEnd: number;
  grossByBand: number[];       // gross per 5-floor band (report)
}

function simulateRun(seed: number, persona: Persona, players: number, floors: FloorCoins[]): RunReport {
  const rng = new Rng((seed ^ 0x9010c1) + (persona === "noGreed" ? 1 : persona === "median" ? 2 : 3) * 7717 + players * 131);
  let wallet = 0;
  let gross = 0;
  let premiumBuys = 0;
  const poolAtMythic: number[] = [];
  const mythicAfford: boolean[] = [];
  const tierAfford = new Map<string, { can: number; seen: number }>();
  const grossByBand = [0, 0, 0, 0, 0, 0];
  for (let floor = 1; floor <= RUN_FLOORS; floor++) {
    const income = floorIncome(floors[floor - 1], persona, floor, players);
    wallet += income;
    gross += income;
    grossByBand[Math.min(5, Math.floor((floor - 1) / 5))] += income;
    const room = floors[floor - 1].shopRoom;
    if (!room) continue;
    const shop = buildShopState(seed, floor, room, players);
    if (isPremiumShopFloor(floor)) {
      wallet = shopPremium(shop, floor, persona, wallet, rng, (kind, canAfford) => {
        const t = tierAfford.get(kind) ?? { can: 0, seen: 0 };
        t.seen++;
        if (canAfford) t.can++;
        tierAfford.set(kind, t);
      }, (isMythic) => {
        premiumBuys++;
        void isMythic;
      }, (pool, afford) => {
        poolAtMythic.push(pool);
        mythicAfford.push(afford);
      });
    } else {
      wallet = shopDealer(shop, floor, persona, wallet, rng, () => premiumBuys++);
    }
  }
  return { gross, premiumBuys, poolAtMythic, mythicAfford, tierAfford, unspentAtEnd: wallet, grossByBand };
}

// The Dealer visit: staples per appetite (a heart when worn, the blessing when flush),
// then the premium slot under the persona's cushion.
function shopDealer(shop: ShopState, floor: number, persona: Persona, wallet: number, rng: Rng, onPremium: () => void): number {
  if (rng.chance(DEALER_APPETITE[persona])) {
    if (wallet >= SHOP.heartPrice + 6) wallet -= SHOP.heartPrice;
  }
  if (rng.chance(DEALER_APPETITE[persona])) {
    const blessing = shop.slots.find((s) => s.kind === "blessing");
    if (blessing && wallet >= blessing.price * 1.6) wallet -= blessing.price;
  }
  if (rng.chance(DEALER_APPETITE[persona])) {
    const weapon = shop.slots.find((s) => s.kind === "weapon");
    if (weapon && wallet >= weapon.price * 1.6) wallet -= weapon.price;
  }
  const premium = shop.slots.find((s) => isPremiumKind(s.kind));
  if (premium) {
    const viewer = viewerFor(wallet, persona);
    const price = shopSlotPriceFor(shop, premium, viewer);
    const reserve = persona === "greedy" && floor >= GREEDY_SAVE_FROM ? GREEDY_RESERVE : 0;
    if (wallet >= price * sinkCushion(persona, floor) + reserve && shopSlotStatusFor(shop, premium, viewer) === "buy") {
      wallet -= price;
      onPremium();
    }
  }
  return wallet;
}

// The premium landing: record afford truth for every offered tier, then spend under the
// persona's discipline — the mythic first for a flush greedy run, else the best
// affordable sink (ONE per shop: the lock).
function shopPremium(
  shop: ShopState, floor: number, persona: Persona, wallet: number, rng: Rng,
  recordTier: (kind: string, canAfford: boolean) => void,
  recordBuy: (isMythic: boolean) => void,
  recordMythic: (pool: number, afford: boolean) => void,
): number {
  const viewer = viewerFor(wallet, persona);
  const mythic = shop.slots.find((s) => isMythicKind(s.kind));
  for (const slot of shop.slots) {
    recordTier(isMythicKind(slot.kind) ? "mythic" : slot.kind, wallet >= shopSlotPriceFor(shop, slot, viewer));
  }
  if (floor >= PREMIUM.mythicFromFloor) {
    const price = premiumPriceAt("mythic", floor);
    recordMythic(wallet, wallet >= price);
    if (mythic && wallet >= price && persona !== "noGreed") {
      recordBuy(true);
      return wallet - price;
    }
  }
  // The sinks, priciest-first (the chase mentality), under the persona's cushion; the
  // no-Greed persona also simply skips half its opportunities (spending temperament),
  // and a greedy run past F20 SAVES for the capstone instead of grazing.
  if (persona === "noGreed" && rng.chance(0.5)) return wallet;
  const reserve = persona === "greedy" && floor >= GREEDY_SAVE_FROM ? GREEDY_RESERVE : 0;
  const sinks = shop.slots
    .filter((s) => isPremiumKind(s.kind) && !isMythicKind(s.kind) && s.kind !== "reroll_all" && s.kind !== "amber_cache")
    .sort((a, b) => b.price - a.price);
  for (const slot of sinks) {
    const price = shopSlotPriceFor(shop, slot, viewer);
    if (wallet >= price * sinkCushion(persona, floor) + reserve) {
      recordBuy(false);
      wallet -= price;
      break;
    }
  }
  // The utility posts stay outside the one-power-buy lock: reroll-everything fishing
  // (five uses at most — the ×1.5 escalation is the brake; a greedy run only fishes in
  // the shallow bands, every coin past F19 belongs to the capstone) and the amber cache.
  const isFishing = persona !== "greedy" || floor < GREEDY_FISH_BEFORE;
  const rerollPost = shop.slots.find((s) => s.kind === "reroll_all");
  for (let uses = 0; isFishing && rerollPost && uses < 5; uses++) {
    const price = shopSlotPriceFor({ ...shop, rerollsUsed: shop.rerollsUsed + uses }, rerollPost, viewerFor(wallet, persona));
    if (wallet < price * utilityCushion(persona, floor) + reserve) break;
    recordBuy(false);
    wallet -= price;
  }
  const cache = shop.slots.find((s) => s.kind === "amber_cache");
  if (cache && wallet >= cache.price * utilityCushion(persona, floor) + reserve) {
    recordBuy(false);
    wallet -= cache.price;
  }
  return wallet;
}

function percentile(values: number[], p: number): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

interface ConfigReport {
  persona: Persona;
  players: number;
  runs: RunReport[];
}

function main(): void {
  process.stdout.write(`premium economy Monte Carlo: ${SEED_COUNT} seeds × ${PERSONAS.length} personas × P{1,2,4} × F1-${RUN_FLOORS}\n`);
  const t0 = Date.now();
  const reports: ConfigReport[] = [];
  for (const players of PARTY_SIZES) {
    // Floor data is persona-agnostic: rolled once per (seed, floor, P), priced per persona.
    const floorCache: FloorCoins[][] = [];
    for (let s = 0; s < SEED_COUNT; s++) {
      const seed = 0x000a11ce + s * 2654435761;
      const floors: FloorCoins[] = [];
      for (let f = 1; f <= RUN_FLOORS; f++) floors.push(floorCoins(seed, f, players));
      floorCache.push(floors);
    }
    for (const persona of PERSONAS) {
      const runs: RunReport[] = [];
      for (let s = 0; s < SEED_COUNT; s++) {
        const seed = 0x000a11ce + s * 2654435761;
        runs.push(simulateRun(seed, persona, players, floorCache[s]));
      }
      reports.push({ persona, players, runs });
    }
  }
  process.stdout.write(`simulated in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  section("report: gross coins per player by 5-floor band (median run)");
  for (const r of reports) {
    const bands = [0, 1, 2, 3, 4, 5].map((b) => Math.round(percentile(r.runs.map((x) => x.grossByBand[b]), 0.5)));
    const gross = Math.round(percentile(r.runs.map((x) => x.gross), 0.5));
    process.stdout.write(`  ${r.persona.padEnd(7)} P${r.players}: bands ${bands.join("/")} · lifetime ${gross}\n`);
  }

  section("report: premium purchases per run / unspent at end / mythic pools");
  for (const r of reports) {
    const buys = percentile(r.runs.map((x) => x.premiumBuys), 0.5);
    const buysP90 = percentile(r.runs.map((x) => x.premiumBuys), 0.9);
    const unspent = Math.round(percentile(r.runs.map((x) => x.unspentAtEnd), 0.5));
    const pools = [0, 1, 2].map((i) => Math.round(percentile(r.runs.map((x) => x.poolAtMythic[i] ?? 0), 0.9)));
    const afford = [0, 1, 2].map((i) => Math.round(100 * r.runs.filter((x) => x.mythicAfford[i]).length / r.runs.length));
    process.stdout.write(`  ${r.persona.padEnd(7)} P${r.players}: buys p50 ${buys} p90 ${buysP90} · unspent p50 ${unspent} · mythic pool p90 ${pools.join("/")} · afford ${afford.join("/")}%\n`);
  }

  section("gates: the balancer's ship targets");
  const of = (persona: Persona, players: number): ConfigReport => reports.find((r) => r.persona === persona && r.players === players)!;
  for (const players of PARTY_SIZES) {
    const median = of("median", players);
    const buysP50 = percentile(median.runs.map((x) => x.premiumBuys), 0.5);
    check(`P${players} median persona: ≤ 1 premium buy per 5 floors (p50 ≤ ${RUN_FLOORS / 5})`,
      buysP50 <= RUN_FLOORS / 5, `p50=${buysP50}`);
    const greedy = of("greedy", players);
    const buysP90 = percentile(greedy.runs.map((x) => x.premiumBuys), 0.9);
    check(`P${players} greedy top-decile: ≤ 2 premium buys per 5 floors (p90 ≤ ${(RUN_FLOORS / 5) * 2})`,
      buysP90 <= (RUN_FLOORS / 5) * 2, `p90=${buysP90}`);

    // The F30 capstone IS the aspiration ("spend everything at the end"): 8-20% of
    // greedy runs arrive at the final landing holding the 600. The F20/25 landings are
    // separately capped by the P90-pool gates below.
    const affordF30 = greedy.runs.filter((x) => x.mythicAfford[2]).length / greedy.runs.length;
    check(`P${players} greedy F30 mythic afford in the 8-20% aspiration band`,
      affordF30 >= 0.08 && affordF30 <= 0.20, `${(affordF30 * 100).toFixed(1)}%`);
    const noGreed = of("noGreed", players);
    const affordNoGreed = noGreed.runs.filter((x) => x.mythicAfford.some((a) => a)).length / noGreed.runs.length;
    check(`P${players} no-Greed mythic afford < 3% at every landing`, affordNoGreed < 0.03, `${(affordNoGreed * 100).toFixed(1)}%`);

    const poolP90F19 = percentile(greedy.runs.map((x) => x.poolAtMythic[0] ?? 0), 0.9);
    const poolP90F24 = percentile(greedy.runs.map((x) => x.poolAtMythic[1] ?? 0), 0.9);
    check(`P${players} greedy P90 pool < the mythic price at F20 (${premiumPriceAt("mythic", 19)})`,
      poolP90F19 < premiumPriceAt("mythic", 19), `p90=${Math.round(poolP90F19)}`);
    check(`P${players} greedy P90 pool < the mythic price at F25 (${premiumPriceAt("mythic", 24)})`,
      poolP90F24 < premiumPriceAt("mythic", 24), `p90=${Math.round(poolP90F24)}`);

    const unspentP50 = percentile(median.runs.map((x) => x.unspentAtEnd), 0.5);
    const cheapestPremiumAtEnd = premiumPriceAt("full_heal", 29);
    check(`P${players} median unspent at run end < one premium price (${cheapestPremiumAtEnd})`,
      unspentP50 < cheapestPremiumAtEnd, `p50=${Math.round(unspentP50)}`);
  }

  section("gates: determinism (identical config → identical report)");
  {
    const seed = 0x000a11ce;
    const floors: FloorCoins[] = [];
    for (let f = 1; f <= RUN_FLOORS; f++) floors.push(floorCoins(seed, f, 2));
    const a = simulateRun(seed, "greedy", 2, floors);
    const floors2: FloorCoins[] = [];
    for (let f = 1; f <= RUN_FLOORS; f++) floors2.push(floorCoins(seed, f, 2));
    const b = simulateRun(seed, "greedy", 2, floors2);
    check("same seed + persona + party → byte-identical run report",
      JSON.stringify(a) === JSON.stringify(b));
  }

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nThe premium economy ship gates hold.\n");
}

main();
