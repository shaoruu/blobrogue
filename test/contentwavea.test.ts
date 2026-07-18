import {
  acquireWeaponInWorld,
  applyItemToWorld,
  createWorld,
  devSpawnEnemy,
  devSpawnProp,
  removePlayerFromWorld,
  spawnPlayerInWorld,
  stepWorld,
  switchWeaponInWorld,
  effectiveReviveChannelSeconds,
  effectiveReviveRadius,
  grapplePreview,
  isPavedAt,
  loadFloorIntoWorld,
  rollBlessingChoicesInWorld,
  resetRunInWorld,
  setPlayerKit,
} from "../src/sim/world.js";
import type { PlayerSim, WorldState } from "../src/sim/world.js";
import type { InputCmd, PlayerId } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { Bullet, HazardKind, WeaponId } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import { WEAPONS, PICKUP_WEAPONS } from "../src/sim/weapons.js";
import { ARSENAL } from "../src/sim/arsenal.js";
import { PLAYER, REVIVE, WEAPON_RESONANCE } from "../src/sim/balance.js";
import {
  FIRE_KNOCKBACK, MAX_PAVE_ZONE_EFFECTS, MAX_PAVE_ZONES_PER_OWNER,
  MAX_ZONE_EFFECTS, WEAPON_KB,
} from "../src/sim/constants.js";
import {
  ITEMS,
  createMods,
  itemById,
  recomputeMods,
} from "../src/sim/items.js";
import type { PlayerMods } from "../src/sim/items.js";
import { isPvpBlessingId } from "../src/sim/items.js";
import { isPvpWeaponSupported, pvpUnsupportedWeaponIds } from "../src/sim/pvp.js";
import { applyPlayerSnapshot, projectPlayer } from "../src/net/playerSnapshot.js";
import {
  buildSnapshot, jsonCodec, selfWireFromSnapshot, snapshotFromSelfWire, validateSnap,
} from "../src/net/protocol.js";
import { heldWeaponSrc, weaponIconSrc } from "../src/game/assets.js";
import { createWeaponBag, drawWeaponFromBag } from "../src/sim/weaponBag.js";
import type { WeaponBag } from "../src/sim/weaponBag.js";
import {
  LEGACY_CONTENT_CATALOG_VERSION,
  WAVE_A_CONTENT_CATALOG_VERSION,
  WAVE_B_CONTENT_CATALOG_VERSION,
  WAVE_C_CONTENT_CATALOG_VERSION,
  MELEE_BLESSING_CONTENT_CATALOG_VERSION,
  contentCatalogFor,
} from "../src/sim/contentCatalog.js";
import { readFileSync } from "node:fs";
import "./harness/domShim.js";

const DT = 1 / 60;
const WAVE_A_WEAPONS: readonly WeaponId[] = [
  "mooring_nail",
  "sluicegate",
  "oddsmaker",
  "pathmaker",
];
const WAVE_A_BLESSINGS = [
  "hold_fast",
  "nothing_wasted",
  "second_breath_muddy",
  "on_the_beat",
  "shared_rope",
] as const;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, isPassing: boolean, detail = ""): void {
  if (isPassing) {
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

function input(seq: number, overrides: Partial<InputCmd> = {}): InputCmd {
  return {
    seq,
    moveX: 0,
    moveY: 0,
    aim: 0,
    firing: false,
    dash: false,
    ...overrides,
  };
}

function arena(seed: number): { world: WorldState; player: PlayerSim } {
  const world = createWorld(seed, 1, { isSandbox: true });
  world.isGodMode = true;
  world.enemies = [];
  world.pendingSpawns = [];
  const player = world.players.get(LOCAL_ID)!;
  player.invuln = 0;
  player.x = 300;
  player.y = 600;
  return { world, player };
}

function fireOnce(world: WorldState, player: PlayerSim, aim = 0): Bullet[] {
  player.fireCd = 0;
  stepWorld(world, new Map([[player.id, input(world.tick + 1, { aim, firing: true })]]), DT);
  return world.bullets.filter((bullet) => bullet.owner === player.id);
}

function applyLevel(world: WorldState, player: PlayerSim, id: string, level: number): void {
  const item = itemById(id)!;
  for (let pick = 0; pick < level; pick++) applyItemToWorld(world, player.id, item);
}

function modsAt(id: string, level: number): PlayerMods {
  const mods = createMods();
  recomputeMods(mods, Array.from({ length: level }, () => id));
  return mods;
}

section("catalog and typed hooks");
{
  for (const id of WAVE_A_WEAPONS) {
    check(`${id} is a pickup weapon`, WEAPONS[id] !== undefined && PICKUP_WEAPONS.includes(id));
    check(`${id} has arsenal, resonance, and force records`,
      ARSENAL[id] !== undefined
      && WEAPON_RESONANCE[id] !== undefined
      && Number.isFinite(WEAPON_KB[id])
      && Number.isFinite(FIRE_KNOCKBACK[id]));
    check(`${id} has typed held and pickup asset hooks`,
      heldWeaponSrc(id) === `/sprites/held_${id}.png`
      && weaponIconSrc(id) === `/sprites/weapon_${id}.png`);
  }
  for (const id of WAVE_A_BLESSINGS) {
    const item = itemById(id);
    check(`${id} is a three-level normal blessing`,
      item !== undefined && item.isPremiumOnly !== true && item.descs.length === 3);
  }
  check("Wave A additions produce the locked catalog totals",
    contentCatalogFor(WAVE_A_CONTENT_CATALOG_VERSION).pickupWeapons.length === 41
    && contentCatalogFor(WAVE_A_CONTENT_CATALOG_VERSION).normalBlessingIds.length === 35
    && WAVE_A_WEAPONS.every((id) => contentCatalogFor(WAVE_A_CONTENT_CATALOG_VERSION).pickupWeapons.includes(id)));
}

section("canonical roadmap and additive catalog migration");
{
  const roadmap = readFileSync(new URL("../docs/specs/blobrogue_CONTENT_WAVE_A.md", import.meta.url), "utf8");
  check("tests cite the owner-ratified Wave A roadmap",
    ["MOORING NAIL", "ANCHOR / GRAPPLE", "SLUICEGATE", "MODESHIFT", "ODDSMAKER", "GAMBLE",
      "PATHMAKER", "CLEANSE / PAVE", "HOLD FAST", "NOTHING WASTED", "SECOND BREATH MUDDY",
      "ON THE BEAT", "SHARED ROPE"].every((token) => roadmap.includes(token)));
  const gameSource = readFileSync(new URL("../src/game/game.ts", import.meta.url), "utf8");
  check("Shared Rope prompt/ring/proximity UI consumes the authority radius helper only",
    !gameSource.includes("REVIVE.radius")
    && (gameSource.match(/effectiveReviveRadius\(this\.p\)/g)?.length ?? 0) >= 3);

  const fixture = JSON.parse(readFileSync(
    new URL("./fixtures/content_catalog.fixtures.json", import.meta.url), "utf8",
  )) as {
    seed: number;
    legacy: { catalogVersion: 0; pickupCount: number; firstPass: WeaponId[] };
    waveA: { catalogVersion: 1; pickupCount: number; firstPass: WeaponId[] };
    waveB: { catalogVersion: 2; pickupCount: number; firstPass: WeaponId[] };
    waveC: { catalogVersion: 3; pickupCount: number; firstPass: WeaponId[] };
  };
  const deal = (version: 0 | 1 | 2 | 3): WeaponId[] => {
    const bag = createWeaponBag(fixture.seed, version);
    return contentCatalogFor(version).pickupWeapons
      .map(() => drawWeaponFromBag(bag, new Set()));
  };
  check("legacy catalog bytes and first bag pass remain frozen",
    contentCatalogFor(LEGACY_CONTENT_CATALOG_VERSION).pickupWeapons.length === fixture.legacy.pickupCount
    && JSON.stringify(deal(LEGACY_CONTENT_CATALOG_VERSION)) === JSON.stringify(fixture.legacy.firstPass));
  const waveADeal = deal(WAVE_A_CONTENT_CATALOG_VERSION);
  check("Wave A catalog golden is deterministic and includes every addition",
    contentCatalogFor(WAVE_A_CONTENT_CATALOG_VERSION).pickupWeapons.length === fixture.waveA.pickupCount
    && JSON.stringify(waveADeal) === JSON.stringify(fixture.waveA.firstPass)
    && WAVE_A_WEAPONS.every((id) => waveADeal.includes(id)));
  const waveBDeal = deal(WAVE_B_CONTENT_CATALOG_VERSION);
  check("Wave B catalog golden is deterministic and includes every addition",
    contentCatalogFor(WAVE_B_CONTENT_CATALOG_VERSION).pickupWeapons.length === fixture.waveB.pickupCount
    && JSON.stringify(waveBDeal) === JSON.stringify(fixture.waveB.firstPass)
    && fixture.waveB.catalogVersion === 2);
  const waveCDeal = deal(WAVE_C_CONTENT_CATALOG_VERSION);
  check("Wave C catalog golden is deterministic and includes every addition",
    contentCatalogFor(WAVE_C_CONTENT_CATALOG_VERSION).pickupWeapons.length === fixture.waveC.pickupCount
    && JSON.stringify(waveCDeal) === JSON.stringify(fixture.waveC.firstPass)
    && fixture.waveC.catalogVersion === 3);
  for (const version of [0, 1, 2, 3] as const) {
    const bag = createWeaponBag(0xCA7105, version);
    for (let draw = 0; draw < 9; draw++) drawWeaponFromBag(bag, new Set());
    const restored = JSON.parse(JSON.stringify(bag)) as WeaponBag;
    check(`catalog ${version}: replay serialization preserves exact bag/version/order`,
      restored.catalogVersion === version
      && drawWeaponFromBag(restored, new Set()) === drawWeaponFromBag(bag, new Set()));
  }

  const legacyWorld = createWorld(0xCA7106, 1, {
    catalogVersion: LEGACY_CONTENT_CATALOG_VERSION,
  });
  const legacyBagOrder = legacyWorld.weaponBag.order.join(",");
  resetRunInWorld(legacyWorld, 0xCA7107);
  check("fresh-run reset atomically keeps the authority-selected catalog and rebuilds its bag",
    legacyWorld.catalogVersion === LEGACY_CONTENT_CATALOG_VERSION
    && legacyWorld.weaponBag.catalogVersion === LEGACY_CONTENT_CATALOG_VERSION
    && legacyWorld.weaponBag.order.join(",") !== legacyBagOrder
    && legacyWorld.weaponBag.order.every((id) => !WAVE_A_WEAPONS.includes(id)));
  check("genuinely fresh production worlds select the melee blessing catalog",
    createWorld(0xCA7108, 1).catalogVersion === MELEE_BLESSING_CONTENT_CATALOG_VERSION);

  const snap = buildSnapshot(createWorld(0xCA7109, 1, {
    catalogVersion: WAVE_A_CONTENT_CATALOG_VERSION,
  }), LOCAL_ID, 0, [], 0, false, {
    worldId: "catalog-v1",
  });
  check("catalog version rides the authoritative compact snapshot", snap.cat === 1);
  const oldWire = JSON.parse(JSON.stringify(snap)) as ReturnType<typeof buildSnapshot> & { cat?: number };
  delete oldWire.cat;
  check("old snapshots missing catalog decode legacy, never current", validateSnap(oldWire).cat === 0);
  let isUnknownRejected = false;
  try { validateSnap({ ...snap, cat: 5 }); } catch { isUnknownRejected = true; }
  check("unsupported future catalog versions fail closed", isUnknownRejected);

  let isForgedClientFieldRejected = false;
  try {
    jsonCodec.decodeClient(JSON.stringify({
      t: "input", seq: 1, mx: 0, my: 0, aim: 0, fire: false, dash: false,
      act: false, ult: false, pulse: false, pet: false, ackEv: 0, ackSnap: 0, catalogVersion: 0,
    }));
  } catch {
    isForgedClientFieldRejected = true;
  }
  check("browser input cannot author or downgrade catalog version", isForgedClientFieldRejected);

  for (const version of [
    LEGACY_CONTENT_CATALOG_VERSION,
    WAVE_A_CONTENT_CATALOG_VERSION,
  ] as const) {
    const allowedWeapons = new Set(contentCatalogFor(version).pickupWeapons);
    const allowedBlessings = new Set(contentCatalogFor(version).normalBlessingIds);
    const sourceWorld = createWorld(0xCA7200 + version, 3, {
      isShared: true, skipLocalPlayer: true, catalogVersion: version,
    });
    const sourcePlayer = spawnPlayerInWorld(sourceWorld, "viewer", "stable-viewer");
    loadFloorIntoWorld(sourceWorld, 3);
    const freeWeapons = sourceWorld.chests
      .map((chest) => chest.weapon)
      .filter((weapon): weapon is WeaponId => weapon !== undefined);
    const dealerWeapons = (sourceWorld.shop?.slots ?? [])
      .map((slot) => slot.weapon)
      .filter((weapon): weapon is WeaponId => weapon !== null);
    const dealerBlessings = (sourceWorld.shop?.slots ?? [])
      .map((slot) => slot.itemId)
      .filter((item): item is string => item !== null);
    const offer = rollBlessingChoicesInWorld(sourceWorld, sourcePlayer.id, false);
    check(`catalog ${version}: floor, Dealer, and blessing sources stay in one run lane`,
      freeWeapons.every((weapon) => allowedWeapons.has(weapon))
      && dealerWeapons.every((weapon) => allowedWeapons.has(weapon))
      && dealerBlessings.every((item) =>
        allowedBlessings.has(item) || item.startsWith("core_"))
      && offer.every((item) => allowedBlessings.has(item.id)));

    const premiumWorld = createWorld(0xCA7300 + version, 29, {
      isShared: true, skipLocalPlayer: true, catalogVersion: version,
    });
    spawnPlayerInWorld(premiumWorld, "viewer", "stable-viewer");
    loadFloorIntoWorld(premiumWorld, 29);
    const premiumWeapons = (premiumWorld.shop?.slots ?? [])
      .map((slot) => slot.weapon)
      .filter((weapon): weapon is WeaponId => weapon !== null);
    const premiumBlessings = (premiumWorld.shop?.slots ?? [])
      .map((slot) => slot.itemId)
      .filter((item): item is string => item !== null && !item.startsWith("core_"));
    check(`catalog ${version}: Premium and climax alternatives stay in the same lane`,
      premiumWeapons.every((weapon) => allowedWeapons.has(weapon))
      && premiumBlessings.every((item) => allowedBlessings.has(item)));
  }
}

section("MOORING NAIL — ANCHOR / GRAPPLE");
{
  const { world, player } = arena(0xA001);
  player.x = 5 * TILE;
  player.y = 12 * TILE;
  acquireWeaponInWorld(world, player.id, "mooring_nail");
  const startX = player.x;
  const preview = grapplePreview(world, player, Math.PI);
  const grappleEvents: Array<Extract<ReturnType<typeof stepWorld>[number], { t: "grappleResolved" }>> = [];
  fireOnce(world, player, Math.PI);
  for (let tick = 0; tick < 90; tick++) {
    const events = stepWorld(world, new Map([[player.id, input(world.tick + 1, { aim: Math.PI })]]), DT);
    for (const event of events) if (event.t === "grappleResolved") grappleEvents.push(event);
  }
  check("a wall hit grapples the owner toward the anchor", player.x < startX - 80,
    `${startX.toFixed(0)} -> ${player.x.toFixed(0)}`);
  check("the pre-fire wall/destination preview equals the authoritative swept result",
    preview !== null && grappleEvents.length === 1
    && Math.abs(preview.anchorX - grappleEvents[0].tx) < 2.1
    && Math.abs(preview.anchorY - grappleEvents[0].ty) < 2.1
    && Math.abs(preview.destinationX - grappleEvents[0].dx) < 2.1
    && Math.abs(preview.destinationY - grappleEvents[0].dy) < 2.1);

  const maxPellet = arena(0xA0015);
  maxPellet.player.x = 5 * TILE;
  maxPellet.player.y = 12 * TILE;
  maxPellet.player.mods.extraPellets = 7;
  acquireWeaponInWorld(maxPellet.world, maxPellet.player.id, "mooring_nail");
  const mooringVolley = fireOnce(maxPellet.world, maxPellet.player, Math.PI);
  const relativeAngles = mooringVolley.slice(1)
    .map((bullet) => {
      let angle = Math.atan2(bullet.vy, bullet.vx) - Math.PI;
      while (angle > Math.PI) angle -= Math.PI * 2;
      while (angle < -Math.PI) angle += Math.PI * 2;
      return angle;
    })
    .sort((left, right) => left - right);
  check("pellet0 is the sole centered anchor and non-anchor pellets fan symmetrically",
    Math.abs(Math.atan2(mooringVolley[0].vy, mooringVolley[0].vx) - Math.PI) < 1e-9
    && mooringVolley.filter((bullet) => bullet.grapplePull !== undefined).length === 1
    && relativeAngles.every((angle, index) =>
      Math.abs(angle + relativeAngles[relativeAngles.length - 1 - index]) < 1e-9));
  let maxPelletGrapples = 0;
  for (let tick = 0; tick < 90; tick++) {
    const events = stepWorld(
      maxPellet.world,
      new Map([[maxPellet.player.id, input(maxPellet.world.tick + 1, { aim: Math.PI })]]),
      DT,
    );
    maxPelletGrapples += events.filter((event) => event.t === "grappleResolved").length;
  }
  check("+7 projectiles still admit exactly one grapple displacement per committed shot",
    maxPelletGrapples === 1);

  const geometry = arena(0xA0016);
  geometry.player.x = 5 * TILE;
  geometry.player.y = 12 * TILE;
  devSpawnProp(geometry.world, "crate", geometry.player.x - 70, geometry.player.y);
  const propBlocked = grapplePreview(geometry.world, geometry.player, Math.PI);
  check("grapple sweep stops at the last legal point before a prop",
    propBlocked !== null && propBlocked.destinationX > geometry.player.x - 55);
  geometry.world.props = [];
  const pitTx = Math.floor((geometry.player.x - 70) / TILE);
  const pitTy = Math.floor(geometry.player.y / TILE);
  geometry.world.dungeon.tiles[pitTy * geometry.world.dungeon.w + pitTx] = 2;
  const pitBlocked = grapplePreview(geometry.world, geometry.player, Math.PI);
  check("grapple sweep never lands in or chains through a lethal pit tile",
    pitBlocked !== null
    && geometry.world.dungeon.tiles[
      Math.floor(pitBlocked.destinationY / TILE) * geometry.world.dungeon.w
      + Math.floor(pitBlocked.destinationX / TILE)
    ] === 0);

  const diagonal = arena(0xA0017);
  diagonal.player.x = 9 * TILE;
  diagonal.player.y = 9 * TILE;
  const diagonalPreview = grapplePreview(diagonal.world, diagonal.player, -3 * Math.PI / 4);
  check("diagonal/concave traversal returns one collision-safe vector destination",
    diagonalPreview !== null
    && Number.isFinite(diagonalPreview.destinationX)
    && Number.isFinite(diagonalPreview.destinationY));

  const shared = createWorld(0xA002, 1, { isShared: true, skipLocalPlayer: true, isSandbox: true });
  shared.isGodMode = true;
  const owner = spawnPlayerInWorld(shared, "owner");
  const teammate = spawnPlayerInWorld(shared, "teammate");
  owner.x = 5 * TILE;
  owner.y = teammate.y = 12 * TILE;
  teammate.x = owner.x - 100;
  acquireWeaponInWorld(shared, owner.id, "mooring_nail");
  fireOnce(shared, owner, Math.PI);
  const teammateX = teammate.x;
  const occupiedPreview = grapplePreview(shared, owner, Math.PI);
  check("occupied co-op space clamps the owner before the teammate body",
    occupiedPreview !== null
    && Math.hypot(occupiedPreview.destinationX - teammate.x, occupiedPreview.destinationY - teammate.y)
      >= owner.pr + teammate.pr);
  removePlayerFromWorld(shared, owner.id);
  for (let tick = 0; tick < 90; tick++) {
    stepWorld(shared, new Map([[teammate.id, input(shared.tick + 1)]]), DT);
  }
  check("a departed owner's grapple never moves or reattributes to a teammate", teammate.x === teammateX);
}

section("SLUICEGATE — MODESHIFT");
{
  const { world, player } = arena(0xA101);
  acquireWeaponInWorld(world, player.id, "sluicegate");
  const flood = fireOnce(world, player);
  world.bullets = [];
  const drain = fireOnce(world, player);
  check("the first beat is a five-round FLOOD fan",
    flood.length === 5 && new Set(flood.map((bullet) => Math.round(Math.atan2(bullet.vy, bullet.vx) * 100))).size > 1);
  check("the second beat is one long piercing DRAIN lance",
    drain.length === 1 && drain[0].pierce >= 2 && Math.hypot(drain[0].vx, drain[0].vy) > 800);
  check("every pellet carries the one authoritative mode decision for its shot",
    flood.every((bullet) => bullet.sluiceMode === "flood")
    && drain.every((bullet) => bullet.sluiceMode === "drain"));
  check("the authoritative cycle advances once per committed shot",
    player.weaponCycles.sluicegate === 2);
  const cycleBeforeRefusal = player.weaponCycles.sluicegate;
  player.fireCd = 1;
  player.weaponFireCooldowns.sluicegate = 1;
  stepWorld(world, new Map([[player.id, input(world.tick + 1, { firing: true })]]), DT);
  check("a cooldown-refused trigger does not advance or flip the next mode",
    player.weaponCycles.sluicegate === cycleBeforeRefusal);
  acquireWeaponInWorld(world, player.id, "pistol");
  switchWeaponInWorld(world, player.id, "sluicegate");
  check("equip and swap preserve the authoritative next mode",
    player.weaponCycles.sluicegate % 2 === cycleBeforeRefusal % 2);

  const observed = createWorld(0xA102, 1, { isShared: true, skipLocalPlayer: true, isSandbox: true });
  const shooter = spawnPlayerInWorld(observed, "shooter");
  spawnPlayerInWorld(observed, "viewer");
  acquireWeaponInWorld(observed, shooter.id, "sluicegate");
  shooter.weaponCycles.sluicegate = 1;
  const observedSnap = buildSnapshot(observed, "viewer", 0, [], 0, false, {
    worldId: "sluice-observer",
  });
  check("a 4P-capable observer snapshot exposes DRAIN before the next pull",
    observedSnap.players.find((remote) => remote.id === shooter.id)?.isDrain === true);
  fireOnce(observed, shooter);
  const firedSnap = buildSnapshot(observed, "viewer", 0, [], 0, false, {
    worldId: "sluice-observer",
  });
  check("observer bullet wire stamps the fired DRAIN mode while next mode flips to FLOOD",
    firedSnap.bullets.length === 1
    && firedSnap.bullets[0].sm === "drain"
    && firedSnap.players.find((remote) => remote.id === shooter.id)?.isDrain === false);
}

section("ODDSMAKER — GAMBLE");
{
  const { world, player } = arena(0xA201);
  acquireWeaponInWorld(world, player.id, "oddsmaker");
  const outcomes = new Set<string>();
  const outcomeSequence: string[] = [];
  for (let shot = 0; shot < 64; shot++) {
    world.bullets = [];
    const bullet = fireOnce(world, player)[0];
    const outcome =
      bullet.bounce !== undefined ? "ricochet"
        : bullet.homing !== undefined ? "seeker"
          : bullet.blast !== undefined ? "blast"
            : bullet.pierce >= 2 ? "pierce"
              : "plain";
    outcomes.add(outcome);
    outcomeSequence.push(outcome);
  }
  check("the deterministic gamble reaches all four authored payload verbs",
    outcomes.size === 4 && !outcomes.has("plain"), [...outcomes].sort().join(","));
  check("independent gambles permit consecutive repeats",
    outcomeSequence.some((outcome, index) => index > 0 && outcome === outcomeSequence[index - 1]));
  check("owner copy states the exact repeat-possible contract",
    ARSENAL.oddsmaker.weakness.includes("No outcome can be demanded; repeats are possible")
    && WEAPONS.oddsmaker.special?.includes("repeats are possible") === true);
  player.weaponCycles.oddsmaker = 0x0ffffffe;
  fireOnce(world, player);
  check("the gamble reaches its maximum legal cycle value",
    player.weaponCycles.oddsmaker === 0x0fffffff);
  fireOnce(world, player);
  check("the gamble cycle wraps 0x0ffffffe → 0x0fffffff → 0",
    player.weaponCycles.oddsmaker === 0);

  const splitWorld = arena(0xA2015);
  splitWorld.player.mods.extraPellets = 7;
  acquireWeaponInWorld(splitWorld.world, splitWorld.player.id, "oddsmaker");
  const splitVolley = fireOnce(splitWorld.world, splitWorld.player);
  check("+7 projectiles share exactly one Oddsmaker payload decision",
    splitVolley.length === 8
    && new Set(splitVolley.map((bullet) => bullet.oddsmakerOutcome)).size === 1);
  const oddWire = buildSnapshot(
    splitWorld.world, splitWorld.player.id, 0, [], 0, false,
    { worldId: "oddsmaker-outcome" },
  );
  check("Oddsmaker outcome enum survives bullet wire for observer classification",
    oddWire.bullets.length === 8
    && new Set(oddWire.bullets.map((bullet) => bullet.go)).size === 1
    && oddWire.bullets[0].go !== null);

  const sequence = (order: readonly PlayerId[]): string => {
    const candidate = createWorld(0xA202, 1, { isShared: true, skipLocalPlayer: true, isSandbox: true });
    candidate.isGodMode = true;
    for (const id of order) {
      const member = spawnPlayerInWorld(candidate, id);
      acquireWeaponInWorld(candidate, id, "oddsmaker");
      member.mods.critChance = 0;
    }
    const actor = candidate.players.get("pA")!;
    const other = candidate.players.get("pB")!;
    const signatures: string[] = [];
    for (let shot = 0; shot < 16; shot++) {
      candidate.bullets = [];
      actor.fireCd = 0;
      other.fireCd = 0;
      stepWorld(candidate, new Map([
        [other.id, input(candidate.tick + 1, { firing: true })],
        [actor.id, input(candidate.tick + 1, { firing: true })],
      ]), DT);
      const bullet = candidate.bullets.find((entry) => entry.owner === actor.id)!;
      signatures.push(`${bullet.bounce ?? 0}/${bullet.homing ?? 0}/${bullet.blast ?? 0}/${bullet.pierce}`);
    }
    return signatures.join(",");
  };
  check("teammate insertion and firing order cannot perturb another player's gamble",
    sequence(["pA", "pB"]) === sequence(["pB", "pA"]));
}

section("PATHMAKER — CLEANSE / PAVE");
{
  const firstPaveCenter = (seed: number): { x: number; y: number } => {
    const probe = arena(seed);
    acquireWeaponInWorld(probe.world, probe.player.id, "pathmaker");
    fireOnce(probe.world, probe.player);
    for (let tick = 0; tick < 30; tick++) {
      stepWorld(probe.world, new Map([[probe.player.id, input(probe.world.tick + 1)]]), DT);
      const zone = probe.world.effects.find((effect) => effect.kind === "zone" && effect.isPaved);
      if (zone) return { x: zone.x, y: zone.y };
    }
    throw new Error("pathmaker produced no paving");
  };

  for (const [index, kind] of (["web", "cinder", "corrupt"] as HazardKind[]).entries()) {
    const seed = 0xA301 + index;
    const center = firstPaveCenter(seed);
    const run = arena(seed);
    acquireWeaponInWorld(run.world, run.player.id, "pathmaker");
    const hazards = [
      { label: "full", x: center.x, radius: 6 },
      { label: "partial", x: center.x + 22, radius: 6 },
      { label: "tangent", x: center.x + 33, radius: 6 },
      { label: "center-only-large", x: center.x, radius: 28 },
    ];
    for (const hazard of hazards) {
      run.world.hazards.push({
        id: run.world.nextHazardId++, kind, x: hazard.x, y: center.y,
        radius: hazard.radius, life: 10, maxLife: 10,
      });
    }
    fireOnce(run.world, run.player);
    for (let tick = 0; tick < 30; tick++) {
      stepWorld(run.world, new Map([[run.player.id, input(run.world.tick + 1)]]), DT);
      if (run.world.effects.some((effect) => effect.kind === "zone" && effect.isPaved)) {
        for (const bullet of run.world.bullets) bullet.life = 0;
        break;
      }
    }
    check(`${kind}: only a fully contained authoritative footprint is cleansed`,
      run.world.hazards.length === 3
      && run.world.hazards.every((hazard) => hazard.id !== 0)
      && run.world.hazards.some((hazard) => Math.abs(hazard.x - (center.x + 22)) < 0.1)
      && run.world.hazards.some((hazard) => Math.abs(hazard.x - (center.x + 33)) < 0.1)
      && run.world.hazards.some((hazard) => hazard.radius === 28));
    const zone = run.world.effects.find((effect) => effect.kind === "zone" && effect.isPaved)!;
    const postPaintHazardId = run.world.nextHazardId++;
    run.world.hazards.push({
      id: postPaintHazardId, kind, x: zone.x, y: zone.y, radius: 4, life: 10, maxLife: 10,
    });
    stepWorld(run.world, new Map([[run.player.id, input(run.world.tick + 1)]]), DT);
    check(`${kind}: live zone ticks never re-proc cleanse`,
      run.world.hazards.some((hazard) => hazard.id === postPaintHazardId));
  }

  const safety = arena(0xA30F);
  safety.world.isGodMode = false;
  acquireWeaponInWorld(safety.world, safety.player.id, "pathmaker");
  fireOnce(safety.world, safety.player);
  for (let tick = 0; tick < 30; tick++) {
    stepWorld(safety.world, new Map([[safety.player.id, input(safety.world.tick + 1)]]), DT);
    if (safety.world.effects.some((effect) => effect.kind === "zone" && effect.isPaved)) break;
  }
  const paving = safety.world.effects.find((effect) => effect.kind === "zone" && effect.isPaved)!;
  safety.player.pr = 40;
  safety.player.x = paving.x + paving.radius - 1;
  safety.player.y = paving.y;
  safety.world.floorHazards = [{
    id: 0, kind: "toxic_pool",
    tx: Math.floor(safety.player.x / TILE), ty: Math.floor(safety.player.y / TILE),
    phase: 0, group: 0,
  }];
  safety.player.invuln = 0;
  const safeHp = safety.player.hp;
  stepWorld(safety.world, new Map([[safety.player.id, input(safety.world.tick + 1)]]), DT);
  check("player-center-inside grants safety even when a large body extends outside",
    safety.player.hp === safeHp && isPavedAt(safety.world, safety.player.x, safety.player.y));
  safety.player.x = paving.x + paving.radius + 1;
  safety.world.floorHazards[0].tx = Math.floor(safety.player.x / TILE);
  safety.player.invuln = 0;
  stepWorld(safety.world, new Map([[safety.player.id, input(safety.world.tick + 1)]]), DT);
  check("large player radius grants no edge immunity when center is outside",
    safety.player.hp < safeHp && !isPavedAt(safety.world, safety.player.x, safety.player.y));
  const damagedHp = safety.player.hp;
  safety.player.x = paving.x;
  safety.player.y = paving.y;
  safety.world.floorHazards[0].tx = Math.floor(safety.player.x / TILE);
  for (const effect of safety.world.effects) {
    if (effect.kind === "zone" && effect.isPaved) effect.life = 0;
  }
  safety.player.invuln = 0;
  stepWorld(safety.world, new Map([[safety.player.id, input(safety.world.tick + 1)]]), DT);
  check("expiry restores surviving underlying floor danger without resurrecting cleansed hazards",
    safety.player.hp < damagedHp);

  const silkRoute = arena(0xA310);
  silkRoute.world.effects.push({
    id: silkRoute.world.nextEffectId++, kind: "zone", owner: silkRoute.player.id,
    fx: "pathmaker", x: 420, y: 600, life: 3, maxLife: 3,
    radius: 27, chillRate: 0, isPaved: true,
  });
  silkRoute.world.hazards.push({
    id: silkRoute.world.nextHazardId++, kind: "web", x: 420, y: 600,
    radius: 60, life: 10, maxLife: 10,
  });
  silkRoute.player.x = 420;
  silkRoute.player.y = 600;
  stepWorld(
    silkRoute.world,
    new Map([[silkRoute.player.id, input(1, { moveX: 1 })]]),
    DT,
  );
  const pavedMove = silkRoute.player.x - 420;
  silkRoute.player.x = 448;
  stepWorld(
    silkRoute.world,
    new Map([[silkRoute.player.id, input(2, { moveX: 1 })]]),
    DT,
  );
  const webMove = silkRoute.player.x - 448;
  check("fresh silk cannot slow a player center inside live pave, but slows outside",
    Math.abs(pavedMove - PLAYER.moveSpeed * DT) < 1e-6
    && webMove < pavedMove * 0.75);
}

section("PATHMAKER party route budgets");
{
  const singleShot = arena(0xA3EF);
  singleShot.player.mods.extraPellets = 7;
  acquireWeaponInWorld(singleShot.world, singleShot.player.id, "pathmaker");
  fireOnce(singleShot.world, singleShot.player);
  for (let tick = 0; tick < 90; tick++) {
    stepWorld(
      singleShot.world,
      new Map([[singleShot.player.id, input(singleShot.world.tick + 1)]]),
      DT,
    );
  }
  check("+7 pellets share one eight-zone paving budget per committed shot",
    singleShot.world.effects.filter((effect) =>
      effect.kind === "zone" && effect.isPaved).length <= 8);

  const world = createWorld(0xA3F0, 1, {
    isShared: true, skipLocalPlayer: true, isSandbox: true,
  });
  world.isGodMode = true;
  const players = ["p1", "p2", "p3", "p4"].map((id, index) => {
    const player = spawnPlayerInWorld(world, id);
    player.x = 300;
    player.y = 520 + index * 54;
    player.mods.extraPellets = 7;
    return player;
  });
  acquireWeaponInWorld(world, players[0].id, "frostline");
  for (let tick = 0; tick < 90; tick++) {
    stepWorld(world, new Map(players.map((player) => [
      player.id,
      input(world.tick + 1, { firing: player === players[0] }),
    ])), DT);
  }
  const frostBefore = world.effects.filter(
    (effect) => effect.kind === "zone" && !effect.isPaved && effect.life > 0,
  ).length;
  for (const player of players) acquireWeaponInWorld(world, player.id, "pathmaker");
  for (let tick = 0; tick < 120; tick++) {
    stepWorld(world, new Map(players.map((player) => [
      player.id,
      input(world.tick + 1, { firing: true }),
    ])), DT);
  }
  const liveZones = world.effects.filter(
    (effect) => effect.kind === "zone" && effect.life > 0,
  );
  const paves = liveZones.filter((effect) => effect.isPaved);
  check("4P +7-pellet held fire stays inside total48/path16 budgets",
    liveZones.length <= MAX_ZONE_EFFECTS && paves.length <= MAX_PAVE_ZONE_EFFECTS);
  check("fair owner admission caps every route owner at 8 zones",
    players.every((player) =>
      paves.filter((effect) => effect.owner === player.id).length <= MAX_PAVE_ZONES_PER_OWNER));
  check("maximum simultaneous paved area is bounded per owner and party",
    Math.round(MAX_PAVE_ZONES_PER_OWNER * Math.PI * 27 * 27) === 18322
    && Math.round(MAX_PAVE_ZONE_EFFECTS * Math.PI * 27 * 27) === 36644);
  check("Pathmaker admission never evicts the separate Frostline family",
    frostBefore > 0
    && liveZones.some((effect) => !effect.isPaved && effect.fx === "frostline"));
  const absentOwner = players[3];
  absentOwner.isAbsent = true;
  stepWorld(world, new Map(players.slice(0, 3).map((player) => [
    player.id, input(world.tick + 1),
  ])), DT);
  check("a disconnected owner's route expires without deleting teammate routes",
    !world.effects.some((effect) =>
      effect.kind === "zone" && effect.isPaved && effect.life > 0 && effect.owner === absentOwner.id)
    && world.effects.some((effect) =>
      effect.kind === "zone" && effect.isPaved && effect.life > 0 && effect.owner !== absentOwner.id));
}

section("blessing L1/L2/L3 deltas");
{
  check("HOLD FAST deltas are exact",
    [0.70, 0.55, 0.40].every((value, index) => modsAt("hold_fast", index + 1).selfKnockbackMult === value));
  check("NOTHING WASTED deltas are exact",
    [0.35, 0.50, 0.65].every((value, index) => modsAt("nothing_wasted", index + 1).reclaimedBounceDamage === value));
  check("SECOND BREATH MUDDY deltas are exact",
    [0.20, 0.35, 0.50].every((value, index) => modsAt("second_breath_muddy", index + 1).muddyDashRefund === value));
  check("ON THE BEAT deltas are exact",
    [0.5, 0.8, 1.1].every((value, index) => modsAt("on_the_beat", index + 1).comboWindowBonus === value)
    && [0.04, 0.06, 0.08].every((value, index) => modsAt("on_the_beat", index + 1).beatFireRatePerTier === value));
  check("SHARED ROPE deltas are exact",
    [12, 20, 28].every((value, index) => modsAt("shared_rope", index + 1).reviveRadiusBonus === value)
    && [1.15, 1.25, 1.35].every((value, index) => modsAt("shared_rope", index + 1).reviveSpeedMult === value));
}

section("blessing mechanics and interactions");
{
  const kickDistance = (isBlessed: boolean): number => {
    const { world, player } = arena(isBlessed ? 0xB001 : 0xB002);
    acquireWeaponInWorld(world, player.id, "cannon");
    if (isBlessed) applyLevel(world, player, "hold_fast", 3);
    const startX = player.x;
    fireOnce(world, player);
    return startX - player.x;
  };
  const baseKick = kickDistance(false);
  const heldKick = kickDistance(true);
  check("HOLD FAST reduces real authoritative weapon displacement by 60%",
    Math.abs(heldKick - baseKick * 0.4) < 1e-6, `${baseKick.toFixed(2)} -> ${heldKick.toFixed(2)}`);
  const holdFeedback = arena(0xB003);
  acquireWeaponInWorld(holdFeedback.world, holdFeedback.player.id, "cannon");
  applyLevel(holdFeedback.world, holdFeedback.player, "hold_fast", 3);
  const holdEvents = stepWorld(
    holdFeedback.world,
    new Map([[holdFeedback.player.id, input(1, { firing: true })]]),
    DT,
  );
  check("HOLD FAST stabilization feedback fires once at the collision-clamped recoil result",
    holdEvents.filter((event) =>
      event.t === "blessingProc" && event.item === "hold_fast").length === 1);
  const spearKick = (isBlessed: boolean): { distance: number; procCount: number } => {
    const sample = arena(isBlessed ? 0xB004 : 0xB005);
    acquireWeaponInWorld(sample.world, sample.player.id, "spear");
    if (isBlessed) applyLevel(sample.world, sample.player, "hold_fast", 3);
    const startX = sample.player.x;
    sample.player.fireCd = 0;
    const events = stepWorld(
      sample.world,
      new Map([[sample.player.id, input(1, { firing: true })]]),
      DT,
    );
    return {
      distance: startX - sample.player.x,
      procCount: events.filter((event) =>
        event.t === "blessingProc" && event.item === "hold_fast").length,
    };
  };
  const plainSpear = spearKick(false);
  const heldSpear = spearKick(true);
  check("HOLD FAST is gun-only — melee kick keeps full authored FIRE_KNOCKBACK",
    Math.abs(heldSpear.distance - plainSpear.distance) < 1e-6
    && heldSpear.procCount === 0
    && plainSpear.distance > 0);

  const { world: reclaimWorld, player: reclaimPlayer } = arena(0xB101);
  reclaimPlayer.x = 5 * TILE;
  reclaimPlayer.y = 12 * TILE;
  applyLevel(reclaimWorld, reclaimPlayer, "nothing_wasted", 1);
  reclaimPlayer.mods.pierce = 3;
  reclaimPlayer.mods.critChance = 1;
  reclaimPlayer.mods.burnChance = 1;
  const reboundTarget = devSpawnEnemy(reclaimWorld, "slime", reclaimPlayer.x + 80, reclaimPlayer.y);
  reboundTarget.spawnTimer = 0;
  reboundTarget.speed = 0;
  reboundTarget.hp = reboundTarget.maxHp = 50;
  fireOnce(reclaimWorld, reclaimPlayer, Math.PI);
  let reclaimed: Bullet | undefined;
  let reclaimProcCount = 0;
  let reclaimBounceCount = 0;
  for (let tick = 0; tick < 120; tick++) {
    const events = stepWorld(reclaimWorld, new Map([[reclaimPlayer.id, input(reclaimWorld.tick + 1, { aim: Math.PI })]]), DT);
    if (events.some((event) => event.t === "bulletBounce")) reclaimed = reclaimWorld.bullets[0];
    reclaimBounceCount += events.filter((event) => event.t === "bulletBounce").length;
    reclaimProcCount += events.filter((event) =>
      event.t === "blessingProc" && event.item === "nothing_wasted").length;
  }
  check("NOTHING WASTED reclaims one missed plain round from the wall",
    reclaimed !== undefined && Math.abs(reclaimed.damage - WEAPONS.pistol.damage * 2 * 0.35) < 1e-6);
  check("the reclaimed crit/status/pierce round can hit an enemy exactly once after the wall",
    reboundTarget.hp < 50 && reboundTarget.burn > 0
    && reclaimBounceCount === 1 && reclaimProcCount === 1);

  const enemyFirst = arena(0xB102);
  enemyFirst.player.x = 5 * TILE;
  enemyFirst.player.y = 12 * TILE;
  applyLevel(enemyFirst.world, enemyFirst.player, "nothing_wasted", 3);
  enemyFirst.player.mods.pierce = 3;
  const firstBody = devSpawnEnemy(
    enemyFirst.world, "slime", enemyFirst.player.x - 55, enemyFirst.player.y,
  );
  firstBody.spawnTimer = 0;
  firstBody.speed = 0;
  firstBody.hp = firstBody.maxHp = 50;
  fireOnce(enemyFirst.world, enemyFirst.player, Math.PI);
  let enemyFirstBounces = 0;
  for (let tick = 0; tick < 90; tick++) {
    const events = stepWorld(
      enemyFirst.world,
      new Map([[enemyFirst.player.id, input(enemyFirst.world.tick + 1, { aim: Math.PI })]]),
      DT,
    );
    enemyFirstBounces += events.filter((event) => event.t === "bulletBounce").length;
  }
  check("an enemy hit before wall contact cancels miss recovery even with extra pierce",
    firstBody.hp < 50 && enemyFirstBounces === 0);

  const { world: muddyWorld, player: muddyPlayer } = arena(0xB201);
  applyLevel(muddyWorld, muddyPlayer, "second_breath_muddy", 3);
  for (let web = 0; web < 3; web++) {
    muddyWorld.hazards.push({
      id: muddyWorld.nextHazardId++,
      kind: "web",
      x: muddyPlayer.x + 20,
      y: muddyPlayer.y + web * 2,
      radius: 24,
      life: 10,
      maxLife: 10,
    });
  }
  const muddyStartEvents = stepWorld(
    muddyWorld,
    new Map([[muddyPlayer.id, input(1, { moveX: 1, dash: true })]]),
    DT,
  );
  check("SECOND BREATH MUDDY refunds exactly once after a dash clears silk",
    muddyPlayer.isMuddyRefundSpent && muddyPlayer.dashCd > 0 && muddyPlayer.dashCd < 0.5
    && muddyStartEvents.filter((event) =>
      event.t === "blessingProc" && event.item === "second_breath_muddy").length === 1);
  const afterRefund = muddyPlayer.dashCd;
  muddyWorld.hazards.push({
    id: muddyWorld.nextHazardId++, kind: "web", x: muddyPlayer.x, y: muddyPlayer.y,
    radius: 24, life: 10, maxLife: 10,
  });
  const laterDashEvents = stepWorld(
    muddyWorld,
    new Map([[muddyPlayer.id, input(2, { moveX: 1 })]]),
    DT,
  );
  check("the muddy refund cannot recurse on later dash ticks",
    Math.abs(muddyPlayer.dashCd - (afterRefund - DT)) < 1e-6
    && !laterDashEvents.some((event) =>
      event.t === "blessingProc" && event.item === "second_breath_muddy"));
  muddyPlayer.dashTime = 0;
  muddyPlayer.dashCd = 0;
  muddyPlayer.weaponFireCooldowns = {};
  muddyWorld.hazards.push({
    id: muddyWorld.nextHazardId++, kind: "web", x: muddyPlayer.x + 20, y: muddyPlayer.y,
    radius: 24, life: 10, maxLife: 10,
  });
  const newDashEvents = stepWorld(
    muddyWorld,
    new Map([[muddyPlayer.id, input(3, { moveX: 1, dash: true })]]),
    DT,
  );
  check("a new dash owns a fresh single Muddy refund",
    newDashEvents.filter((event) =>
      event.t === "blessingProc" && event.item === "second_breath_muddy").length === 1);

  const { world: beatWorld, player: beatPlayer } = arena(0xB301);
  applyLevel(beatWorld, beatPlayer, "on_the_beat", 3);
  beatPlayer.combo = 5;
  fireOnce(beatWorld, beatPlayer);
  check("ON THE BEAT routes active combo tempo through the raw fire-rate cap",
    Math.abs(beatPlayer.fireCd - WEAPONS.pistol.fireCd / 1.08) < 1e-6);
  const target = devSpawnEnemy(beatWorld, "slime", beatPlayer.x + 45, beatPlayer.y);
  target.spawnTimer = 0;
  target.speed = 0;
  target.hp = 1;
  beatPlayer.combo = 4;
  beatPlayer.fireCd = 0;
  let beatTierUpEvents = 0;
  for (let tick = 0; tick < 20 && !target.dead; tick++) {
    const events = stepWorld(beatWorld, new Map([[beatPlayer.id, input(beatWorld.tick + 1, { firing: true })]]), DT);
    beatTierUpEvents += events.filter((event) =>
      event.t === "blessingProc" && event.item === "on_the_beat" && event.phase === "tierUp").length;
  }
  check("ON THE BEAT tier-up feedback fires once and extends the kill window by 1.1s",
    beatPlayer.comboTimer > 3.9 && beatTierUpEvents === 1);
  let beatExpiryEvents = 0;
  for (let tick = 0; tick < 260; tick++) {
    const events = stepWorld(beatWorld, new Map([[beatPlayer.id, input(beatWorld.tick + 1)]]), DT);
    beatExpiryEvents += events.filter((event) =>
      event.t === "blessingProc" && event.item === "on_the_beat" && event.phase === "expired").length;
  }
  check("ON THE BEAT expiry feedback fires once and clears the tier",
    beatExpiryEvents === 1 && beatPlayer.combo === 0);

  const ropeRates = [1, 2, 3].map((level) => {
    const sample = arena(0xB400 + level);
    applyLevel(sample.world, sample.player, "shared_rope", level);
    return {
      radius: effectiveReviveRadius(sample.player),
      channel: effectiveReviveChannelSeconds(sample.player),
    };
  });
  check("SHARED ROPE effective radii are exactly 58/66/74",
    ropeRates.map((sample) => sample.radius).join(",") === "58,66,74");
  check("SHARED ROPE channels are exactly 1.304/1.2/1.111 seconds",
    Math.abs(ropeRates[0].channel - 1.5 / 1.15) < 0.001
    && Math.abs(ropeRates[1].channel - 1.2) < 0.001
    && Math.abs(ropeRates[2].channel - 1.5 / 1.35) < 0.001);
  const menderRope = arena(0xB404);
  setPlayerKit(menderRope.world, menderRope.player.id, "mender");
  applyLevel(menderRope.world, menderRope.player, "shared_rope", 3);
  check("Mender × Rope applies once and remains above the 0.714s channel floor",
    Math.abs(effectiveReviveChannelSeconds(menderRope.player) - 1.5 / (1.5 * 1.35)) < 0.001
    && effectiveReviveChannelSeconds(menderRope.player) >= 1.5 / 2.1);

  const ropeWorld = createWorld(0xB401, 1, { isShared: true, skipLocalPlayer: true, isSandbox: true });
  ropeWorld.isGodMode = true;
  const reviver = spawnPlayerInWorld(ropeWorld, "reviver");
  const downed = spawnPlayerInWorld(ropeWorld, "downed");
  reviver.x = 300;
  reviver.y = 600;
  downed.x = 300 + 46 + 24;
  downed.y = 600;
  downed.hp = 0;
  downed.isDown = true;
  applyLevel(ropeWorld, reviver, "shared_rope", 3);
  for (let tick = 0; tick < 72 && downed.isDown; tick++) {
    stepWorld(ropeWorld, new Map([
      [reviver.id, input(tick + 1, { interact: true })],
      [downed.id, input(tick + 1)],
    ]), DT);
  }
  check("SHARED ROPE revives from its +28px range in under 1.2 seconds", !downed.isDown);

  const handoff = createWorld(0xB405, 1, {
    isShared: true, skipLocalPlayer: true, isSandbox: true,
  });
  handoff.isGodMode = true;
  const down = spawnPlayerInWorld(handoff, "down");
  const plain = spawnPlayerInWorld(handoff, "z-plain");
  const blessed = spawnPlayerInWorld(handoff, "a-blessed");
  const helper = spawnPlayerInWorld(handoff, "m-helper");
  down.x = plain.x = blessed.x = helper.x = 300;
  down.y = plain.y = blessed.y = helper.y = 600;
  down.hp = 0;
  down.isDown = true;
  applyLevel(handoff, blessed, "shared_rope", 3);
  const allHolding = new Map([
    [down.id, input(1)],
    [plain.id, input(1, { interact: true })],
    [blessed.id, input(1, { interact: true })],
    [helper.id, input(1, { interact: true })],
  ]);
  const firstHandoff = stepWorld(handoff, allHolding, DT);
  check("4P simultaneous hold chooses exactly one stable-id reviver and one boosted handoff",
    down.reviveBy === blessed.id
    && firstHandoff.filter((event) =>
      event.t === "reviveHandoff" && event.to === blessed.id && event.isBoosted).length === 1);
  for (let tick = 0; tick < 10; tick++) {
    stepWorld(handoff, new Map([
      [down.id, input(tick + 2)],
      [plain.id, input(tick + 2, { interact: true })],
      [blessed.id, input(tick + 2, { interact: true })],
      [helper.id, input(tick + 2, { interact: true })],
    ]), DT);
  }
  const boostedProgress = down.reviveProgress;
  const handoffEvents = stepWorld(handoff, new Map([
    [down.id, input(20)],
    [plain.id, input(20, { interact: true })],
    [blessed.id, input(20)],
    [helper.id, input(20, { interact: true })],
  ]), DT);
  check("owner release causes a deterministic fresh plain handoff with no progress laundering",
    down.reviveBy === helper.id
    && down.reviveProgress < boostedProgress
    && handoffEvents.filter((event) =>
      event.t === "reviveHandoff" && event.from === blessed.id && event.to === helper.id).length === 1);
}

section("global weapon-switch cadence invariant");
{
  for (const id of [...WAVE_A_WEAPONS, "railgun", "rapid"] as WeaponId[]) {
    const sample = arena(0xD000 + WEAPONS[id].name.length);
    acquireWeaponInWorld(sample.world, sample.player.id, id);
    fireOnce(sample.world, sample.player);
    const remaining = sample.player.fireCd;
    acquireWeaponInWorld(sample.world, sample.player.id, "pistol");
    switchWeaponInWorld(sample.world, sample.player.id, id);
    check(`${id}: swap away/back never reduces its earned cooldown`,
      Math.abs(sample.player.fireCd - remaining) < 1e-9);
  }

  const spam = arena(0xD100);
  acquireWeaponInWorld(spam.world, spam.player.id, "mooring_nail");
  acquireWeaponInWorld(spam.world, spam.player.id, "pathmaker");
  const shots = new Map<WeaponId, number>();
  for (let tick = 0; tick < 120; tick++) {
    const weapon: WeaponId = tick % 2 === 0 ? "mooring_nail" : "pathmaker";
    switchWeaponInWorld(spam.world, spam.player.id, weapon);
    const events = stepWorld(
      spam.world,
      new Map([[spam.player.id, input(tick + 1, { firing: true })]]),
      DT,
    );
    for (const event of events) {
      if (event.t === "shot") shots.set(event.weapon, (shots.get(event.weapon) ?? 0) + 1);
    }
  }
  const duration = 120 * DT;
  const maxMooring = 1 + Math.floor(duration / WEAPONS.mooring_nail.fireCd);
  const maxPathmaker = 1 + Math.floor(duration / WEAPONS.pathmaker.fireCd);
  check("one-tick swap spam stays within each weapon's authored cadence envelope",
    (shots.get("mooring_nail") ?? 0) <= maxMooring
    && (shots.get("pathmaker") ?? 0) <= maxPathmaker,
    `mooring=${shots.get("mooring_nail") ?? 0}/${maxMooring} path=${shots.get("pathmaker") ?? 0}/${maxPathmaker}`);

  const spamDps = new Map<WeaponId, number>();
  for (const id of WAVE_A_WEAPONS) {
    const sample = arena(0xD200 + id.length);
    acquireWeaponInWorld(sample.world, sample.player.id, id);
    let committedShots = 0;
    const ticks = 120;
    for (let tick = 0; tick < ticks; tick++) {
      switchWeaponInWorld(sample.world, sample.player.id, id);
      const events = stepWorld(
        sample.world,
        new Map([[sample.player.id, input(tick + 1, { firing: true })]]),
        DT,
      );
      committedShots += events.filter((event) => event.t === "shot" && event.weapon === id).length;
      switchWeaponInWorld(sample.world, sample.player.id, "pistol");
    }
    const perShot = id === "sluicegate"
      ? (WEAPONS.sluicegate.damage * WEAPONS.sluicegate.pellets
        + WEAPONS.sluicegate.modeShift!.alternate.damage) / 2
      : WEAPONS[id].damage * WEAPONS[id].pellets;
    spamDps.set(id, committedShots * perShot / (ticks * DT));
    const authored = perShot / WEAPONS[id].fireCd;
    check(`${id}: rapid swap/fire DPS stays within cadence plus one initial-shot tolerance`,
      (spamDps.get(id) ?? Infinity) <= authored + perShot / (ticks * DT) + 1e-9,
      `${(spamDps.get(id) ?? 0).toFixed(2)} vs ${authored.toFixed(2)}`);
  }
}

section("snapshot, ownership, and PvP fail-closed policy");
{
  const { player } = arena(0xC001);
  player.weaponCycles.sluicegate = 17;
  player.weaponCycles.oddsmaker = 29;
  player.isMuddyRefundSpent = true;
  player.weaponFireCooldowns.pistol = 0.375;
  player.reviveBy = "p2";
  const copy = createWorld(0xC002, 1, { isSandbox: true }).players.get(LOCAL_ID)!;
  applyPlayerSnapshot(copy, projectPlayer(player));
  check("reconnect snapshots preserve weapon cycles and muddy refund state",
    copy.weaponCycles.sluicegate === 17
    && copy.weaponCycles.oddsmaker === 29
    && copy.isMuddyRefundSpent
    && copy.weaponFireCooldowns.pistol === 0.375
    && copy.reviveBy === "p2");
  const wireRoundTrip = snapshotFromSelfWire(selfWireFromSnapshot(projectPlayer(player)));
  check("the compact protocol preserves Wave A cycle and blessing-proc state",
    wireRoundTrip.weaponCycles.sluicegate === 17
    && wireRoundTrip.weaponCycles.oddsmaker === 29
    && wireRoundTrip.isMuddyRefundSpent
    && wireRoundTrip.weaponFireCooldowns.pistol === 0.375
    && wireRoundTrip.reviveBy === "p2");

  const pvp = createWorld(0xC101, 1, { mode: "pvp", isSandbox: true });
  const fighter = pvp.players.get(LOCAL_ID)!;
  for (const id of WAVE_A_WEAPONS) acquireWeaponInWorld(pvp, fighter.id, id);
  check("PvP acquisition fails closed for all unsupported Wave A weapons",
    WAVE_A_WEAPONS.every((id) => !fighter.ownedWeapons.includes(id))
    && WAVE_A_WEAPONS.every((id) => !isPvpWeaponSupported(id))
    && WAVE_A_WEAPONS.every((id) => pvpUnsupportedWeaponIds.includes(id)));
  fighter.ownedWeapons.push("oddsmaker");
  check("PvP equip also fails closed for a maliciously injected unsupported id",
    !switchWeaponInWorld(pvp, fighter.id, "oddsmaker") && fighter.weapon !== "oddsmaker");
  fighter.weapon = "oddsmaker";
  fighter.fireCd = 0;
  const oddCycleBefore = fighter.weaponCycles.oddsmaker;
  const bulletsBefore = pvp.bullets.length;
  stepWorld(pvp, new Map([[fighter.id, input(1, { firing: true })]]), DT);
  check("PvP fire guard rejects a malicious pre-owned/equipped Wave A weapon directly",
    pvp.bullets.length === bulletsBefore
    && fighter.weaponCycles.oddsmaker === oddCycleBefore);
  check("all five Wave A blessings stay outside the PvP draft pool",
    WAVE_A_BLESSINGS.every((id) => !isPvpBlessingId(id)));
}

process.stdout.write(`\ncontent Wave A: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const failure of failures) process.stdout.write(`  FAIL ${failure}\n`);
  process.exit(1);
}
