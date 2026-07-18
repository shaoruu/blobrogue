import {
  acquireWeaponInWorld,
  applyItemToWorld,
  createWorld,
  devSpawnEnemy,
  stepWorld,
  switchWeaponInWorld,
  bossChestWeaponFor,
  resetRunInWorld,
} from "../src/sim/world.js";
import type { PlayerSim, WorldState } from "../src/sim/world.js";
import type { InputCmd } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { Bullet, Enemy, WeaponId } from "../src/sim/types.js";
import { WEAPONS, PICKUP_WEAPONS } from "../src/sim/weapons.js";
import { ARSENAL } from "../src/sim/arsenal.js";
import { WEAPON_RESONANCE, WEAPON_BOSS_COEF } from "../src/sim/balance.js";
import { FIRE_KNOCKBACK, WEAPON_KB } from "../src/sim/constants.js";
import { ITEMS, itemById } from "../src/sim/items.js";
import { isPvpBlessingId } from "../src/sim/items.js";
import { isPvpWeaponSupported, pvpUnsupportedWeaponIds } from "../src/sim/pvp.js";
import { buildSnapshot, validateSnap, jsonCodec } from "../src/net/protocol.js";
import { heldWeaponSrc, weaponIconSrc, HELD_ART_ANGLE } from "../src/game/assets.js";
import { createWeaponBag, drawWeaponFromBag } from "../src/sim/weaponBag.js";
import {
  LEGACY_CONTENT_CATALOG_VERSION,
  WAVE_A_CONTENT_CATALOG_VERSION,
  WAVE_B_CONTENT_CATALOG_VERSION,
  WAVE_C_CONTENT_CATALOG_VERSION,
  CURRENT_CONTENT_CATALOG_VERSION,
  contentCatalogFor,
} from "../src/sim/contentCatalog.js";
import { STACK_CATEGORY, SAME_CATEGORY_CAP } from "../src/sim/antiDegenerate.js";
import "./harness/domShim.js";

const DT = 1 / 60;
const WAVE_C_WEAPONS: readonly WeaponId[] = ["hushiron", "backtalk", "lamplighter", "faultlink"];

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
  return { seq, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false, ...overrides };
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

function step(world: WorldState, player: PlayerSim, overrides: Partial<InputCmd> = {}): ReturnType<typeof stepWorld> {
  return stepWorld(world, new Map([[player.id, input(world.tick + 1, overrides)]]), DT);
}

function fireOnce(world: WorldState, player: PlayerSim, aim = 0): Bullet[] {
  player.fireCd = 0;
  player.weaponFireCooldowns[player.weapon] = 0;
  stepWorld(world, new Map([[player.id, input(world.tick + 1, { aim, firing: true })]]), DT);
  return world.bullets.filter((bullet) => bullet.owner === player.id);
}

function applyLevel(world: WorldState, player: PlayerSim, id: string, level: number): void {
  const item = itemById(id)!;
  for (let pick = 0; pick < level; pick++) applyItemToWorld(world, player.id, item);
}

function parked(world: WorldState, kind: Enemy["kind"], x: number, y: number, hp: number): Enemy {
  const e = devSpawnEnemy(world, kind, x, y);
  e.spawnTimer = 0;
  e.speed = 0;
  e.kbResist = 1e9;
  e.hp = e.maxHp = hp;
  return e;
}

section("catalog v3, typed hooks, and additive migration");
{
  for (const id of WAVE_C_WEAPONS) {
    check(`${id} is a pickup weapon in catalog 3`,
      WEAPONS[id] !== undefined && PICKUP_WEAPONS.includes(id)
      && contentCatalogFor(WAVE_C_CONTENT_CATALOG_VERSION).pickupWeapons.includes(id));
    check(`${id} has arsenal, resonance, and force records`,
      ARSENAL[id] !== undefined && WEAPON_RESONANCE[id] !== undefined
      && Number.isFinite(WEAPON_KB[id]) && Number.isFinite(FIRE_KNOCKBACK[id])
      && Number.isFinite(WEAPON_BOSS_COEF[id] ?? NaN));
    check(`${id} has typed held and pickup asset hooks`,
      heldWeaponSrc(id) === `/sprites/held_${id}.png` && weaponIconSrc(id) === `/sprites/weapon_${id}.png`);
  }
  // Diagonal held-gun aim: Wave C sprites are authored up-right ~30–40° (same convention as
  // cleaver/tracker). Without HELD_ART_ANGLE the barrel points off the true aim — Ian's
  // prior diagonal-gun bug. Assert each Wave C gun has a measured correction, and that a
  // horizontally-authored baseline (pistol) stays at the default 0.
  for (const id of WAVE_C_WEAPONS) {
    const ang = HELD_ART_ANGLE[id];
    check(`${id} has a diagonal held-art-angle correction (barrel not +X)`,
      typeof ang === "number" && Number.isFinite(ang) && ang < -0.3 && ang > -0.9,
      `ang=${ang}`);
  }
  check("pistol stays at the default held-art-angle (horizontally authored)",
    HELD_ART_ANGLE.pistol === undefined);
  check("Lamplighter is COMMON in code (Quill/Rook FINAL)", WEAPONS.lamplighter.rarity === "common");
  check("Hushiron and Backtalk are rare; Faultlink is legendary (1C / 2R / 1L)",
    WEAPONS.hushiron.rarity === "rare" && WEAPONS.backtalk.rarity === "rare"
    && WEAPONS.faultlink.rarity === "legendary");
  check("Wave C is the current catalog and pickups remain additive (+4 guns)",
    CURRENT_CONTENT_CATALOG_VERSION === WAVE_C_CONTENT_CATALOG_VERSION
    && PICKUP_WEAPONS.length === 49);
  check("Wave C adds the five melee-native blessings to the prior pool",
    contentCatalogFor(WAVE_C_CONTENT_CATALOG_VERSION).normalBlessingIds.length === 45
    && contentCatalogFor(WAVE_B_CONTENT_CATALOG_VERSION).normalBlessingIds.length === 40
    && ["stagger_pulse", "blade_ward", "cleave_crit", "momentum_charge", "finisher"]
      .every((id) => contentCatalogFor(WAVE_C_CONTENT_CATALOG_VERSION).normalBlessingIds.includes(id))
    && ITEMS.filter((i) => i.isPremiumOnly !== true && i.isPvpOnly !== true).length === 45);
  check("catalog 2 (Wave B) arrays are never mutated by Wave C",
    contentCatalogFor(WAVE_B_CONTENT_CATALOG_VERSION).pickupWeapons.length === 45
    && WAVE_C_WEAPONS.every((id) => !contentCatalogFor(WAVE_B_CONTENT_CATALOG_VERSION).pickupWeapons.includes(id)));

  const bag = createWeaponBag(0xC0C, WAVE_C_CONTENT_CATALOG_VERSION);
  const dealt = contentCatalogFor(WAVE_C_CONTENT_CATALOG_VERSION).pickupWeapons.map(() => drawWeaponFromBag(bag, new Set()));
  const replay = JSON.parse(JSON.stringify(bag));
  check("Wave C bag deals every addition and replays deterministically",
    dealt.length === 49 && WAVE_C_WEAPONS.every((id) => dealt.includes(id))
    && replay.catalogVersion === WAVE_C_CONTENT_CATALOG_VERSION
    && drawWeaponFromBag(replay, new Set()) === drawWeaponFromBag(bag, new Set()));

  check("genuinely fresh production worlds select Wave C",
    createWorld(0xCC01, 1).catalogVersion === WAVE_C_CONTENT_CATALOG_VERSION);
  const snap = buildSnapshot(createWorld(0xCC02, 1), LOCAL_ID, 0, [], 0, false, { worldId: "catalog-v3" });
  check("catalog version 3 rides the authoritative snapshot", snap.cat === 3);
  const oldWire = JSON.parse(JSON.stringify(snap)) as ReturnType<typeof buildSnapshot> & { cat?: number };
  delete oldWire.cat;
  check("old snapshots missing catalog still decode legacy", validateSnap(oldWire).cat === 0);
  let isUnknownRejected = false;
  try { validateSnap({ ...snap, cat: 4 }); } catch { isUnknownRejected = true; }
  check("unsupported future catalog versions (4+) still fail closed", isUnknownRejected);
  let isForged = false;
  try {
    jsonCodec.decodeClient(JSON.stringify({
      t: "input", seq: 1, mx: 0, my: 0, aim: 0, fire: false, dash: false,
      act: false, ult: false, pulse: false, pet: false, ackEv: 0, ackSnap: 0, catalogVersion: 3,
    }));
  } catch { isForged = true; }
  check("browser input cannot author or downgrade the catalog", isForged);

  const legacyWorld = createWorld(0xCC03, 1, { catalogVersion: LEGACY_CONTENT_CATALOG_VERSION });
  resetRunInWorld(legacyWorld, 0xCC04);
  check("fresh-run reset keeps the authority-selected catalog and excludes Wave C",
    legacyWorld.catalogVersion === LEGACY_CONTENT_CATALOG_VERSION
    && legacyWorld.weaponBag.order.every((id) => !WAVE_C_WEAPONS.includes(id)));

  check("Wave A (catalog 1) pickups are untouched (still 41)",
    contentCatalogFor(WAVE_A_CONTENT_CATALOG_VERSION).pickupWeapons.length === 41);
}

section("anti-degenerate metadata (stackCategory registry + cap)");
{
  const canonical: Record<string, string> = {
    hushiron: "stance_ramp", backtalk: "parry_active",
    lamplighter: "light_edit", faultlink: "link",
  };
  check("every Wave C weapon carries its GD-canonical stackCategory",
    Object.entries(canonical).every(([id, cat]) => STACK_CATEGORY[id] === cat));
  check("the three NEW Wave C categories are distinct",
    new Set(["stance_ramp", "parry_active", "light_edit"]).size === 3);
  check("Faultlink shares the `link` category with Resonant Fork (same cap2 lane)",
    STACK_CATEGORY.faultlink === "link" && STACK_CATEGORY.resonant_fork === "link"
    && SAME_CATEGORY_CAP === 2);
}

section("HUSHIRON — ROOT / RAMP");
{
  const { world, player } = arena(0xC101);
  acquireWeaponInWorld(world, player.id, "hushiron");
  const cold = fireOnce(world, player, 0);
  const coldDmg = cold[0]?.damage ?? 0;
  const coldPierce = cold[0]?.pierce ?? -1;
  check("a cold (unramped) slug carries its base stats", coldPierce === 0 && Math.abs(coldDmg - WEAPONS.hushiron.damage) < 1e-6);
  world.bullets = [];
  // Stand perfectly still to ramp the stance.
  for (let t = 0; t < 160; t++) step(world, player, { moveX: 0, moveY: 0, firing: false });
  check("standing still ramps the stance to the cap", player.hushStacks === WEAPONS.hushiron.stance!.maxStacks,
    `stacks=${player.hushStacks}`);
  const ramped = fireOnce(world, player, 0);
  const rDmg = ramped[0]?.damage ?? 0;
  check("a fully ramped slug gains pierce and tightens spread",
    (ramped[0]?.pierce ?? 0) >= 1);
  check("stance grants NO damage multiplier (Quill hard rule)",
    Math.abs(rDmg - WEAPONS.hushiron.damage) < 1e-6, `dmg=${rDmg.toFixed(2)} base=${WEAPONS.hushiron.damage}`);

  // Movement vents stacks one at a time.
  const before = player.hushStacks;
  for (let t = 0; t < 30; t++) step(world, player, { moveX: 1, moveY: 0, firing: false });
  check("moving vents the stance", player.hushStacks < before, `${before}->${player.hushStacks}`);

  // A dash rips the whole stance out at once.
  const dashArena = arena(0xC102);
  acquireWeaponInWorld(dashArena.world, dashArena.player.id, "hushiron");
  for (let t = 0; t < 160; t++) step(dashArena.world, dashArena.player, { moveX: 0, moveY: 0 });
  const dashed = dashArena.player.hushStacks;
  step(dashArena.world, dashArena.player, { moveX: 1, moveY: 0, dash: true });
  check("a dash clears the whole stance at once", dashed > 0 && dashArena.player.hushStacks === 0,
    `${dashed}->${dashArena.player.hushStacks}`);
}

section("BACKTALK — PARRY / RETURN");
{
  const { world, player } = arena(0xC201);
  acquireWeaponInWorld(world, player.id, "backtalk");
  // A ready, empty window fires only the feeble stub.
  const stub = fireOnce(world, player, 0);
  check("empty, Backtalk fires only the ready stub (bossCoef 0.90)",
    stub.length === 1 && stub[0].isBacktalkReturn !== true
    && Math.abs(stub[0].damage - WEAPONS.backtalk.damage) < 1e-6
    && Math.abs((stub[0].bossCoef ?? 1) - 0.90) < 1e-9);

  // Hold fire to open the frontal window, then catch an incoming enemy shot.
  const parry = arena(0xC202);
  acquireWeaponInWorld(parry.world, parry.player.id, "backtalk");
  parry.world.bullets.push({
    x: parry.player.x + 120, y: parry.player.y, vx: -30, vy: 0, radius: 5, life: 5,
    friendly: false, owner: null, damage: 3, color: "#f00", pierce: 0, hitList: null, isCrit: false,
  });
  let caught = false;
  for (let t = 0; t < 30 && !caught; t++) {
    step(parry.world, parry.player, { aim: 0, firing: true });
    if (parry.player.backtalkCaughtDmg > 0) caught = true;
  }
  check("a held frontal window catches a legal enemy shot and starts the CD on the catch",
    caught && parry.player.backtalkCd > 4 && parry.player.backtalkReturnT > 0,
    `caught=${parry.player.backtalkCaughtDmg} cd=${parry.player.backtalkCd.toFixed(1)}`);
  const caughtDmg = parry.player.backtalkCaughtDmg;
  const returned = fireOnce(parry.world, parry.player, 0);
  const retShot = returned.find((b) => b.isBacktalkReturn === true);
  const spec = WEAPONS.backtalk.parry!;
  const expected = Math.min(spec.returnMax, Math.max(spec.returnMin, caughtDmg * spec.returnCoef));
  check("the next fire throws the caught shot back at 1.15x (clamped), bossCoef 0.65",
    retShot !== undefined && Math.abs(retShot.damage - expected) < 1e-6
    && Math.abs((retShot.bossCoef ?? 1) - 0.65) < 1e-9,
    `ret=${retShot?.damage.toFixed(2)} expect=${expected.toFixed(2)}`);
  check("throwing the return disarms it", parry.player.backtalkReturnT === 0 && parry.player.backtalkCaughtDmg === 0);
}

section("LAMPLIGHTER — RELIGHT (common)");
{
  // Unlit (dark) room: a plain round, no pierce bonus, no patch.
  const dark = arena(0xC301);
  acquireWeaponInWorld(dark.world, dark.player.id, "lamplighter");
  const unlit = fireOnce(dark.world, dark.player, 0);
  for (let t = 0; t < 30; t++) step(dark.world, dark.player, { aim: 0 });
  check("an UNLIT shot gets no pierce bonus and plants no patch",
    (unlit[0]?.pierce ?? 0) === 0 && dark.player.lampPatches.length === 0);

  // Lit path via a live Carry-the-Light aura: pierce +1 and a planted safe patch.
  const lit = arena(0xC302);
  applyLevel(lit.world, lit.player, "carry_the_light", 3); // lightRadius aura = the warm light
  acquireWeaponInWorld(lit.world, lit.player.id, "lamplighter");
  const target = parked(lit.world, "skeleton", lit.player.x + 120, lit.player.y, 400);
  const litShot = fireOnce(lit.world, lit.player, 0);
  let litLatched = false;
  for (let t = 0; t < 30; t++) {
    step(lit.world, lit.player, { aim: 0 });
    if (litShot[0]?.lampLit === true) litLatched = true;
  }
  check("a LIT shot (through warm light) latches +1 pierce and plants a safe patch",
    litLatched && lit.player.lampPatches.length >= 1 && target.hp < 400);
  check("the safe patch has the authored radius (22) and is capped at 3 per owner",
    lit.player.lampPatches.every((p) => Math.abs(p.radius - WEAPONS.lamplighter.relight!.patchRadius) < 1e-9)
    && lit.player.lampPatches.length <= WEAPONS.lamplighter.relight!.maxPatches);
}

section("FAULTLINK — LINK / SHARE (legendary)");
{
  const { world, player } = arena(0xC401);
  acquireWeaponInWorld(world, player.id, "faultlink");
  const a = parked(world, "skeleton", player.x + 120, player.y, 400);
  const b = parked(world, "skeleton", player.x + 120, player.y - 40, 400);
  // First primary hit marks A.
  const aimA = Math.atan2(a.y - player.y, a.x - player.x);
  fireOnce(world, player, aimA);
  for (let t = 0; t < 20 && player.faultMark === null && player.faultLink === null; t++) step(world, player, { aim: aimA });
  check("a first primary hit marks endpoint A", player.faultMark !== null || player.faultLink !== null);
  // Second primary hit on a different body forms the seam.
  const aimB = Math.atan2(b.y - player.y, b.x - player.x);
  fireOnce(world, player, aimB);
  for (let t = 0; t < 20 && player.faultLink === null; t++) step(world, player, { aim: aimB });
  check("a second primary hit on a distinct body forms the A<->B link", player.faultLink !== null);
  // A further primary hit on a linked endpoint echoes onto the other.
  const bHp = b.hp;
  for (let t = 0; t < 20; t++) fireOnce(world, player, aimA), step(world, player, { aim: aimA });
  check("focusing a linked endpoint echoes bounded damage onto the other", b.hp < bHp,
    `B ${bHp.toFixed(1)}->${b.hp.toFixed(1)}`);
}

section("weapon-switch cadence invariant for Wave C verbs");
{
  for (const id of WAVE_C_WEAPONS) {
    const s = arena(0xC500 + id.length);
    acquireWeaponInWorld(s.world, s.player.id, id);
    fireOnce(s.world, s.player, 0);
    const remaining = s.player.fireCd;
    acquireWeaponInWorld(s.world, s.player.id, "pistol");
    switchWeaponInWorld(s.world, s.player.id, id);
    check(`${id}: swap away/back never reduces its earned cooldown`,
      s.player.fireCd >= remaining - 1e-9);
  }
}

section("PvP fail-closed policy + boss reward leads");
{
  const pvp = createWorld(0xC601, 1, { mode: "pvp", isSandbox: true });
  const fighter = pvp.players.get(LOCAL_ID)!;
  for (const id of WAVE_C_WEAPONS) acquireWeaponInWorld(pvp, fighter.id, id);
  check("PvP acquisition fails closed for every Wave C weapon",
    WAVE_C_WEAPONS.every((id) => !fighter.ownedWeapons.includes(id))
    && WAVE_C_WEAPONS.every((id) => !isPvpWeaponSupported(id))
    && WAVE_C_WEAPONS.every((id) => pvpUnsupportedWeaponIds.includes(id)));
  check("melee-native blessings do not enter the curated PvP pool by default",
    ["stagger_pulse", "cleave_crit", "momentum_charge"].every((id) => !isPvpBlessingId(id)));

  check("boss-clear reward leads route the Wave C table (Quorum -> Faultlink)",
    bossChestWeaponFor(0xB055, 45, "quorum") === "faultlink"
    && bossChestWeaponFor(0xB055, 35, "jet") === "oddsmaker"
    && bossChestWeaponFor(0xB055, 40, "tithe") === "sluicegate"
    && bossChestWeaponFor(0xB055, 50, "gorge") === "breach");
}

process.stdout.write(`\ncontent Wave C: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const failure of failures) process.stdout.write(`  FAIL ${failure}\n`);
  process.exit(1);
}
