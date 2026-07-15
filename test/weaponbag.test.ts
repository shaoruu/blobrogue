// The early-game weapon-variety suite (playtest: "I keep getting the same few guns before
// the slime boss"). Locks the per-run shuffled weapon bag and every roll that rides it:
//   1. bag determinism — same seed -> same deal, different seed -> different deal, and a
//      full pass is a permutation of the pickup pool (distinct until exhausted);
//   2. anti-repeat — a refilled bag never opens on the guns it just dealt;
//   3. early-floor distinctness — a seeded solo run stocks a pedestal on EVERY floor
//      F1-4 (floor 1 included — the fix), all distinct, and different seeds deal
//      different sequences;
//   4. no wasted drops — pedestal, wood-chest and boss-choice rolls skip guns the whole
//      party owns while unowned guns remain, and allow a duplicate (never hang) once the
//      pool is fully owned;
//   5. boss reward variety — the King's chest weapon is a seeded pick from its authored
//      table that varies across seeds, fixed within one seed;
//   6. multiplayer determinism — two identically-driven shared worlds deal identical
//      weapons across descents.
//
// Run: npm run test:weaponbag

import {
  createWorld, loadFloorIntoWorld, spawnPlayerInWorld, stepWorldPhase, descend,
  bossChestWeaponFor,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import { createWeaponBag, drawWeaponFromBag } from "../src/sim/weaponBag.js";
import { PICKUP_WEAPONS, WEAPONS } from "../src/sim/weapons.js";
import { KING_REWARD_TABLE, WEAPON_VARIETY, bossWeaponChoices } from "../src/sim/balance.js";
import type { WeaponId } from "../src/sim/types.js";
import type { SimEvent } from "../src/sim/events.js";

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
const NONE: ReadonlySet<WeaponId> = new Set();

function soloWorld(seed: number, floor: number): { w: WorldState; p: PlayerSim } {
  const w = createWorld(seed, floor, { isShared: true, skipLocalPlayer: true });
  const p = spawnPlayerInWorld(w, "pA");
  loadFloorIntoWorld(w, floor);
  return { w, p };
}

function stockedKinds(w: WorldState): WeaponId[] {
  return w.chests.filter((c) => c.weapon !== undefined).map((c) => c.weapon!);
}

// ---- 1. bag determinism ----

section("bag: same seed -> same deal; a full pass is a permutation of the pickup pool");
{
  const deal = (seed: number, n: number): WeaponId[] => {
    const bag = createWeaponBag(seed);
    const out: WeaponId[] = [];
    for (let i = 0; i < n; i++) out.push(drawWeaponFromBag(bag, NONE));
    return out;
  };
  const a = deal(0xA11CE, PICKUP_WEAPONS.length);
  const b = deal(0xA11CE, PICKUP_WEAPONS.length);
  check("two bags from one seed deal the identical sequence", a.join(",") === b.join(","));
  check("one pass deals every pickup weapon exactly once",
    new Set(a).size === PICKUP_WEAPONS.length, `distinct=${new Set(a).size}/${PICKUP_WEAPONS.length}`);
  const seeds = [0xA11CE, 0xB0B, 0xC4A7, 0xD00D, 0x5EED];
  const prefixes = seeds.map((s) => deal(s, 6).join(","));
  check("five seeds deal five different openings", new Set(prefixes).size === seeds.length,
    prefixes.join(" | "));
}

section("bag: a refill never opens on the guns it just dealt (recent-drop history)");
{
  let openerRepeats = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const bag = createWeaponBag(seed);
    const dealt: WeaponId[] = [];
    for (let i = 0; i < PICKUP_WEAPONS.length; i++) dealt.push(drawWeaponFromBag(bag, NONE));
    const next = drawWeaponFromBag(bag, NONE); // first draw of the refilled pass
    if (dealt.slice(-WEAPON_VARIETY.recentDrops).includes(next)) openerRepeats++;
  }
  check("no refilled bag re-deals one of its last few guns first", openerRepeats === 0, `repeats=${openerRepeats}`);
}

section("bag: exclusion skips owned guns while any remain, then allows a dup (never hangs)");
{
  const bag = createWeaponBag(0xF00D);
  const unowned: WeaponId[] = ["spear", "beam"];
  const owned = new Set<WeaponId>(PICKUP_WEAPONS.filter((id) => !unowned.includes(id)));
  const first = drawWeaponFromBag(bag, owned);
  const second = drawWeaponFromBag(bag, owned);
  check("draws under heavy ownership deal exactly the unowned guns",
    unowned.includes(first) && unowned.includes(second) && first !== second, `${first},${second}`);
  const everything = new Set<WeaponId>(PICKUP_WEAPONS);
  const dup = drawWeaponFromBag(bag, everything);
  check("a fully-owned pool still yields a deterministic duplicate", PICKUP_WEAPONS.includes(dup), dup);
}

// ---- 2. early-floor distinctness across a run ----

section("run deal: floors 1-4 each stock a pedestal, all DISTINCT, sequences vary by seed");
{
  const runDeal = (seed: number): WeaponId[] => {
    const { w } = soloWorld(seed, 1);
    const dealt: WeaponId[] = [...stockedKinds(w)];
    for (let f = 2; f <= 4; f++) {
      descend(w, f, []);
      dealt.push(...stockedKinds(w));
    }
    return dealt;
  };
  const seeds = [0xA11CE, 0xB0B, 0xC4A7, 0xD00D];
  const deals = seeds.map(runDeal);
  for (let i = 0; i < seeds.length; i++) {
    check(`seed ${i}: four floors deal four distinct guns (floor 1 included)`,
      deals[i].length === 4 && new Set(deals[i]).size === 4, deals[i].join(","));
  }
  check("different seeds deal different early sequences",
    new Set(deals.map((d) => d.join(","))).size === seeds.length,
    deals.map((d) => d.join(",")).join(" | "));
  check("the same seed re-deals the identical run", runDeal(0xA11CE).join(",") === deals[0].join(","));
}

// ---- 3. no wasted owned-duplicate drops ----

section("pedestals: the stocked gun is never one the whole party owns while unowned guns remain");
{
  const { w, p } = soloWorld(0xBEEF, 2);
  const unowned: WeaponId[] = ["cannon", "tesla", "spear"];
  p.ownedWeapons = ["pistol", ...PICKUP_WEAPONS.filter((id) => !unowned.includes(id))];
  loadFloorIntoWorld(w, 2); // restock against the new inventory
  const stocked = stockedKinds(w);
  check("the pedestal deals one of the player's unowned guns",
    stocked.length === 1 && unowned.includes(stocked[0]), stocked.join(","));
  p.ownedWeapons = ["pistol", ...PICKUP_WEAPONS];
  loadFloorIntoWorld(w, 2);
  check("a fully-owned pool still stocks a pedestal (dup allowed, never a dead floor)",
    stockedKinds(w).length === 1, stockedKinds(w).join(","));
}

section("wood chests: the ambient weapon roll skips universally-owned guns");
{
  const { w, p } = soloWorld(0xCAFE, 2);
  w.enemies = []; w.pendingSpawns = [];
  const unowned: WeaponId[] = (["common", "rare", "legendary"] as const)
    .map((rarity) => PICKUP_WEAPONS.find((id) => WEAPONS[id].rarity === rarity)!);
  p.ownedWeapons = ["pistol", ...PICKUP_WEAPONS.filter((id) => !unowned.includes(id))];
  const dealt: WeaponId[] = [];
  for (let i = 0; i < 300 && dealt.length < 6; i++) {
    w.pickups = [];
    w.chests = [{ id: w.nextChestId++, kind: "wood", x: p.x + 1, y: p.y, radius: 16, opened: false }];
    stepWorldPhase(w, DT, []);
    for (const pk of w.pickups) if (pk.kind === "weapon" && pk.weapon) dealt.push(pk.weapon);
  }
  check("the 7% window fired across 300 chests", dealt.length > 0, `weapons=${dealt.length}`);
  check("every ambient gun dealt was unowned at roll time",
    dealt.every((id) => unowned.includes(id)), dealt.join(","));
}

section("boss chest: solo spills 3 distinct choices; alternates dodge owned guns");
{
  const { w, p } = soloWorld(0xB055, 3);
  w.enemies = []; w.pendingSpawns = [];
  const unowned: WeaponId[] = ["ricochet", "nailer"];
  p.ownedWeapons = ["pistol", ...PICKUP_WEAPONS.filter((id) => !unowned.includes(id))];
  w.chests.push({ id: w.nextChestId++, kind: "boss", x: p.x + 1, y: p.y, radius: 18, opened: false, weapon: "mortar" });
  const ev: SimEvent[] = [];
  stepWorldPhase(w, DT, ev);
  const choices = w.pickups.filter((pk) => pk.isBossChoice).map((pk) => pk.weapon!);
  check("solo boss chest spills bossWeaponChoices(1) = 3 distinct choices, signature first",
    bossWeaponChoices(1) === 3 && choices.length === 3 && new Set(choices).size === 3
    && choices.includes("mortar"), choices.join(","));
  check("both alternates are guns the player does NOT own",
    choices.filter((id) => id !== "mortar").every((id) => unowned.includes(id)), choices.join(","));
}

// ---- 4. boss reward variety ----

section("King reward: a seeded pick from the authored table — varies across seeds, fixed per seed");
{
  const seeds = Array.from({ length: 24 }, (_, i) => 0x1000 + i * 7919);
  const picks = seeds.map((s) => bossChestWeaponFor(s, 5, "boss")!);
  check("every pick lands inside KING_REWARD_TABLE",
    picks.every((id) => KING_REWARD_TABLE.some((row) => row.weapon === id)));
  check("the reward VARIES across seeds (no more mortar-every-run)",
    new Set(picks).size >= 2, [...new Set(picks)].join(","));
  check("mortar stays the weighted favourite",
    picks.filter((id) => id === "mortar").length >= picks.length / 4,
    `mortar=${picks.filter((id) => id === "mortar").length}/${picks.length}`);
  check("the pick is fixed per (seed, floor)",
    seeds.every((s) => bossChestWeaponFor(s, 5, "boss") === bossChestWeaponFor(s, 5, "boss")));
  check("deep bosses keep their single authored signature",
    seeds.every((s) => bossChestWeaponFor(s, 15, "marrow") === "railgun" && bossChestWeaponFor(s, 30, "choir") === "beam"));
}

// ---- 5. multiplayer determinism ----

section("shared worlds: two identically-driven parties deal identical weapons across descents");
{
  const build = (): WorldState => {
    const w = createWorld(0xD287, 1, { isShared: true, skipLocalPlayer: true });
    spawnPlayerInWorld(w, "pA");
    spawnPlayerInWorld(w, "pB");
    loadFloorIntoWorld(w, 1);
    return w;
  };
  const fingerprint = (w: WorldState): string =>
    JSON.stringify([w.floor, w.chests.map((c) => [c.x, c.y, c.weapon ?? null]),
      w.shop?.slots.map((s) => s.weapon ?? null) ?? null]);
  const w1 = build();
  const w2 = build();
  let isIdentical = fingerprint(w1) === fingerprint(w2);
  for (let f = 2; f <= 6 && isIdentical; f++) {
    descend(w1, f, []);
    descend(w2, f, []);
    isIdentical = fingerprint(w1) === fingerprint(w2);
  }
  check("chest stock + shop stock byte-identical on every floor F1-6", isIdentical);
}

process.stdout.write(`\nweaponbag: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(failures.map((f) => `  FAIL ${f}`).join("\n") + "\n");
  process.exit(1);
}
