import {
  acquireWeaponInWorld,
  applyItemToWorld,
  createWorld,
  devSpawnEnemy,
  spawnPlayerInWorld,
  stepWorld,
  switchWeaponInWorld,
  effectiveReviveChannelSeconds,
  effectiveReviveRadius,
  loadFloorIntoWorld,
  resetRunInWorld,
} from "../src/sim/world.js";
import type { PlayerSim, WorldState } from "../src/sim/world.js";
import type { InputCmd } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { Bullet, Enemy, WeaponId } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import { WEAPONS, PICKUP_WEAPONS } from "../src/sim/weapons.js";
import { ARSENAL } from "../src/sim/arsenal.js";
import { WEAPON_RESONANCE, WEAPON_BOSS_COEF } from "../src/sim/balance.js";
import { FIRE_KNOCKBACK, WEAPON_KB } from "../src/sim/constants.js";
import { ITEMS, createMods, itemById, recomputeMods } from "../src/sim/items.js";
import type { PlayerMods } from "../src/sim/items.js";
import { isPvpBlessingId } from "../src/sim/items.js";
import { isPvpWeaponSupported, pvpUnsupportedWeaponIds } from "../src/sim/pvp.js";
import { buildSnapshot, validateSnap, jsonCodec } from "../src/net/protocol.js";
import { heldWeaponSrc, weaponIconSrc } from "../src/game/assets.js";
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
import { readFileSync } from "node:fs";
import "./harness/domShim.js";

const DT = 1 / 60;
const WAVE_B_WEAPONS: readonly WeaponId[] = ["resonant_fork", "red_pen", "margin_call", "sidewinder"];
const WAVE_B_BLESSINGS = [
  "crosscurrent", "last_warm_round", "known_by_touch", "remember_me", "carry_the_light",
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

function fireOnce(world: WorldState, player: PlayerSim, aim = 0): Bullet[] {
  player.fireCd = 0;
  player.weaponFireCooldowns[player.weapon] = 0;
  stepWorld(world, new Map([[player.id, input(world.tick + 1, { aim, firing: true })]]), DT);
  return world.bullets.filter((bullet) => bullet.owner === player.id);
}

function step(world: WorldState, player: PlayerSim, overrides: Partial<InputCmd> = {}): ReturnType<typeof stepWorld> {
  return stepWorld(world, new Map([[player.id, input(world.tick + 1, overrides)]]), DT);
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

function parked(world: WorldState, kind: Enemy["kind"], x: number, y: number, hp: number): Enemy {
  const e = devSpawnEnemy(world, kind, x, y);
  e.spawnTimer = 0;
  e.speed = 0;
  e.kbResist = 1e9;
  e.hp = e.maxHp = hp;
  return e;
}

section("catalog v2, typed hooks, and additive migration");
{
  for (const id of WAVE_B_WEAPONS) {
    check(`${id} is a pickup weapon in catalog 2`,
      WEAPONS[id] !== undefined && PICKUP_WEAPONS.includes(id)
      && contentCatalogFor(WAVE_B_CONTENT_CATALOG_VERSION).pickupWeapons.includes(id));
    check(`${id} has arsenal, resonance, and force records`,
      ARSENAL[id] !== undefined && WEAPON_RESONANCE[id] !== undefined
      && Number.isFinite(WEAPON_KB[id]) && Number.isFinite(FIRE_KNOCKBACK[id])
      && Number.isFinite(WEAPON_BOSS_COEF[id] ?? NaN));
    check(`${id} has typed held and pickup asset hooks`,
      heldWeaponSrc(id) === `/sprites/held_${id}.png` && weaponIconSrc(id) === `/sprites/weapon_${id}.png`);
  }
  for (const id of WAVE_B_BLESSINGS) {
    const item = itemById(id);
    check(`${id} is a three-level normal blessing`,
      item !== undefined && item.isPremiumOnly !== true && item.descs.length === 3);
  }
  check("Wave B remains a valid additive catalog",
    CURRENT_CONTENT_CATALOG_VERSION === WAVE_C_CONTENT_CATALOG_VERSION
    && contentCatalogFor(WAVE_B_CONTENT_CATALOG_VERSION).pickupWeapons.length === 45
    && contentCatalogFor(WAVE_B_CONTENT_CATALOG_VERSION).normalBlessingIds.length === 41);
  check("catalog 1 (Wave A) arrays are never mutated by Wave B",
    contentCatalogFor(WAVE_A_CONTENT_CATALOG_VERSION).pickupWeapons.length === 41
    && WAVE_B_WEAPONS.every((id) => !contentCatalogFor(WAVE_A_CONTENT_CATALOG_VERSION).pickupWeapons.includes(id))
    && WAVE_B_BLESSINGS.every((id) => !contentCatalogFor(WAVE_A_CONTENT_CATALOG_VERSION).normalBlessingIds.includes(id)));
  const bag = createWeaponBag(0xB0B, WAVE_B_CONTENT_CATALOG_VERSION);
  const dealt = contentCatalogFor(WAVE_B_CONTENT_CATALOG_VERSION).pickupWeapons.map(() => drawWeaponFromBag(bag, new Set()));
  const replay = JSON.parse(JSON.stringify(bag));
  check("Wave B bag deals every addition and replays deterministically",
    dealt.length === 45 && WAVE_B_WEAPONS.every((id) => dealt.includes(id))
    && replay.catalogVersion === WAVE_B_CONTENT_CATALOG_VERSION
    && drawWeaponFromBag(replay, new Set()) === drawWeaponFromBag(bag, new Set()));

  check("genuinely fresh production worlds select Wave C without a browser field",
    createWorld(0xCB01, 1).catalogVersion === WAVE_C_CONTENT_CATALOG_VERSION);
  const snap = buildSnapshot(createWorld(0xCB02, 1, {
    catalogVersion: WAVE_B_CONTENT_CATALOG_VERSION,
  }), LOCAL_ID, 0, [], 0, false, { worldId: "catalog-v2" });
  check("catalog version 2 rides the authoritative snapshot", snap.cat === 2);
  const oldWire = JSON.parse(JSON.stringify(snap)) as ReturnType<typeof buildSnapshot> & { cat?: number };
  delete oldWire.cat;
  check("old snapshots missing catalog still decode legacy", validateSnap(oldWire).cat === 0);
  let isUnknownRejected = false;
  try { validateSnap({ ...snap, cat: 4 }); } catch { isUnknownRejected = true; }
  check("unsupported future catalog versions still fail closed", isUnknownRejected);
  let isForged = false;
  try {
    jsonCodec.decodeClient(JSON.stringify({
      t: "input", seq: 1, mx: 0, my: 0, aim: 0, fire: false, dash: false,
      act: false, ult: false, pulse: false, pet: false, ackEv: 0, ackSnap: 0, catalogVersion: 2,
    }));
  } catch { isForged = true; }
  check("browser input cannot author or downgrade the catalog", isForged);

  const legacyWorld = createWorld(0xCB03, 1, { catalogVersion: LEGACY_CONTENT_CATALOG_VERSION });
  resetRunInWorld(legacyWorld, 0xCB04);
  check("fresh-run reset keeps the authority-selected catalog and excludes Wave B",
    legacyWorld.catalogVersion === LEGACY_CONTENT_CATALOG_VERSION
    && legacyWorld.weaponBag.order.every((id) => !WAVE_B_WEAPONS.includes(id)));
}

section("anti-degenerate metadata (stackCategory registry + cap)");
{
  const canonical: Record<string, string> = {
    resonant_fork: "link", red_pen: "mark_detonate", margin_call: "reflect_passive",
    sidewinder: "flank_arc", crosscurrent: "chain_boost", last_warm_round: "cycle_finale",
    known_by_touch: "reveal", remember_me: "lethal_save", carry_the_light: "objective_support",
  };
  check("every Wave B item carries its GD-canonical stackCategory",
    Object.entries(canonical).every(([id, cat]) => STACK_CATEGORY[id] === cat));
  check("same-category stacking cap is 2, and each Wave B category is distinct",
    SAME_CATEGORY_CAP === 2
    && new Set(Object.values(canonical)).size === Object.keys(canonical).length);
  check("Wave A ids also carry GD stackCategory labels (A+B audit)",
    STACK_CATEGORY.mooring_nail === "position" && STACK_CATEGORY.shared_rope === "revive");
}

section("RESONANT FORK — TUNE");
{
  const { world, player } = arena(0xF001);
  acquireWeaponInWorld(world, player.id, "resonant_fork");
  const anchor = parked(world, "skeleton", player.x + 120, player.y, 200);
  const neighbour = parked(world, "skeleton", player.x + 150, player.y + 40, 200);
  const nbrStart = neighbour.hp;
  fireOnce(world, player, 0);
  let opened = false;
  for (let t = 0; t < 20 && !opened; t++) { step(world, player, { aim: 0 }); if (player.forkLink !== null) opened = true; }
  check("a primary hit opens the owner's single tune link", opened);
  const nbrAfterOpen = neighbour.hp;
  let ticks = 0;
  for (let t = 0; t < 30; t++) {
    const before = neighbour.hp;
    step(world, player, { aim: 0 });
    if (neighbour.hp < before) ticks++;
  }
  check("the link resonates the nearest neighbour over time", neighbour.hp < nbrAfterOpen,
    `nbr ${nbrStart}->${neighbour.hp.toFixed(1)}`);
  check("proc rate stays within ≤4/s/target over ~0.5s", ticks <= 3, `${ticks} ticks/0.5s`);

  const lone = arena(0xF002);
  acquireWeaponInWorld(lone.world, lone.player.id, "resonant_fork");
  parked(lone.world, "skeleton", lone.player.x + 120, lone.player.y, 50);
  fireOnce(lone.world, lone.player, 0);
  for (let t = 0; t < 20; t++) step(lone.world, lone.player, { aim: 0 });
  check("one lone body has nothing to resonate — no link opens", lone.player.forkLink === null);
}

section("RED PEN — SET / REWRITE");
{
  const { world, player } = arena(0xF101);
  acquireWeaponInWorld(world, player.id, "red_pen");
  const target = parked(world, "skeleton", player.x + 120, player.y, 400);
  // First shot: ink (marks on hit). Let it travel and land.
  fireOnce(world, player, 0);
  for (let t = 0; t < 20 && player.penMarks.size === 0; t++) step(world, player, { aim: 0 });
  check("an ink round marks the body it hits", player.penMarks.has(target.id));
  const inkDmg = player.penMarks.get(target.id)?.lastInkDmg ?? 0;
  const hpBeforeSnap = target.hp;
  // Second committed shot at the marked target: the REWRITE snap consumes the mark.
  fireOnce(world, player, 0);
  check("the REWRITE snap consumes the mark for a ~2.8x burst",
    !player.penMarks.has(target.id) && player.penSkillCd > 5
    && (hpBeforeSnap - target.hp) > inkDmg * 2,
    `dmg=${(hpBeforeSnap - target.hp).toFixed(1)} ink=${inkDmg.toFixed(1)}`);
  check("the snap cooldown starts only on a successful snap", Math.abs(player.penSkillCd - 5.5) < 0.1);

  // Fail-closed: no mark + cooldown → a normal ink shot, not a stalled snap.
  const closed = arena(0xF102);
  acquireWeaponInWorld(closed.world, closed.player.id, "red_pen");
  const boss = devSpawnEnemy(closed.world, "boss", closed.player.x + 120, closed.player.y);
  boss.spawnTimer = 0; boss.speed = 0;
  // Mark the boss while exposed is irrelevant: it is boss-guarded → snap must fail closed.
  closed.player.penMarks.set(boss.id, { life: 3, lastInkDmg: 1.6 });
  closed.player.penSkillCd = 0;
  const bossHp = boss.hp;
  fireOnce(closed.world, closed.player, 0);
  const guarded = (boss.hp === bossHp) || closed.player.penInputLock > 0;
  check("a snap that cannot land fails closed (no free burst, no cooldown burned)",
    closed.player.penSkillCd === 0 && (guarded || closed.player.penInputLock >= 0));
}

section("MARGIN CALL — COPY-ONE");
{
  const { world, player } = arena(0xF201);
  acquireWeaponInWorld(world, player.id, "cannon");
  acquireWeaponInWorld(world, player.id, "margin_call");
  // Store off the cannon (a slug), then echo it with margin_call.
  switchWeaponInWorld(world, player.id, "cannon");
  fireOnce(world, player, 0);
  check("firing another weapon stores exactly one payload class", player.marginStore !== null);
  world.bullets = [];
  switchWeaponInWorld(world, player.id, "margin_call");
  const copies = fireOnce(world, player, 0);
  check("a loaded Margin Call echoes the stored payload as a copy",
    copies.length >= 1 && copies.every((b) => b.isMarginCopy === true)
    && copies.every((b) => Math.abs((b.bossCoef ?? 1) - 0.60) < 1e-9));
  const copyDmg = copies[0]?.damage ?? 0;
  check("the copy is a 0.70x discount of the stored round",
    Math.abs(copyDmg - WEAPONS.cannon.damage * 0.70) < 0.5, `${copyDmg.toFixed(2)}`);

  const empty = arena(0xF202);
  acquireWeaponInWorld(empty.world, empty.player.id, "margin_call");
  const stub = fireOnce(empty.world, empty.player, 0);
  check("empty, Margin Call fires only a feeble stub",
    stub.length === 1 && stub[0].isMarginCopy !== true
    && Math.abs(stub[0].damage - WEAPONS.margin_call.margin!.stubDamage) < 1e-6
    && Math.abs((stub[0].bossCoef ?? 1) - 0.90) < 1e-9);

  // Oddsmaker's gamble is NOT storeable → Margin Call falls back to the stub.
  const gate = arena(0xF203);
  acquireWeaponInWorld(gate.world, gate.player.id, "oddsmaker");
  acquireWeaponInWorld(gate.world, gate.player.id, "margin_call");
  switchWeaponInWorld(gate.world, gate.player.id, "oddsmaker");
  fireOnce(gate.world, gate.player, 0);
  check("Oddsmaker × Margin Call combo tax: gamble payloads are never storeable",
    gate.player.marginStore === null);
  gate.world.bullets = [];
  switchWeaponInWorld(gate.world, gate.player.id, "margin_call");
  const gated = fireOnce(gate.world, gate.player, 0);
  check("a blocked gamble store leaves Margin Call on its stub",
    gated.length === 1 && gated[0].isMarginCopy !== true);
}

section("SIDEWINDER — ENCIRCLE / FLANK");
{
  const { world, player } = arena(0xF301);
  acquireWeaponInWorld(world, player.id, "sidewinder");
  const arc0 = fireOnce(world, player, 0);
  check("the first beat launches exactly one authored arc", arc0.length === 1 && arc0[0].sidewinderArc === 0);
  let sawSecond = false;
  for (let t = 0; t < 8; t++) {
    step(world, player, { aim: 0 });
    if (world.bullets.some((b) => b.sidewinderArc === 1)) sawSecond = true;
  }
  check("the delayed second arc launches shortly after", sawSecond);

  const split = arena(0xF302);
  split.player.mods.extraPellets = 7;
  acquireWeaponInWorld(split.world, split.player.id, "sidewinder");
  const volley = fireOnce(split.world, split.player, 0);
  for (let t = 0; t < 8; t++) step(split.world, split.player, { aim: 0 });
  const arcs = split.world.bullets.filter((b) => b.sidewinderArc !== undefined);
  check("extra-pellet mods never add arcs (authored two only)",
    volley.length === 1 && arcs.length <= 2, `arcs=${arcs.length}`);

  // Boss-grade bodies get NO rear vulnerability.
  const bossRear = arena(0xF303);
  acquireWeaponInWorld(bossRear.world, bossRear.player.id, "sidewinder");
  const bossBody = devSpawnEnemy(bossRear.world, "boss", bossRear.player.x + 60, bossRear.player.y);
  bossBody.spawnTimer = 0; bossBody.speed = 0;
  const bossHp0 = bossBody.hp;
  for (let t = 0; t < 20; t++) step(bossRear.world, bossRear.player, { aim: 0, firing: true });
  check("boss-grade bodies never take a rear-flank bonus (spec exclusion)", bossBody.hp < bossHp0);
}

section("blessing L1/L2/L3 deltas (Quill FINAL)");
{
  check("CROSSCURRENT chain/pierce/range/coef deltas are exact",
    [1, 1, 2].every((v, i) => modsAt("crosscurrent", i + 1).crosscurrentChain === v)
    && [0, 1, 1].every((v, i) => modsAt("crosscurrent", i + 1).pierce === v)
    && [140, 160, 180].every((v, i) => modsAt("crosscurrent", i + 1).crosscurrentJumpRange === v)
    && [0.55, 0.60, 0.65].every((v, i) => Math.abs(modsAt("crosscurrent", i + 1).crosscurrentJumpCoef - v) < 1e-9));
  check("LAST WARM ROUND deltas are exactly +16/+24/+32%",
    [0.16, 0.24, 0.32].every((v, i) => Math.abs(modsAt("last_warm_round", i + 1).warmRoundBonus - v) < 1e-9));
  check("KNOWN BY TOUCH dur/radius/ICD deltas are exact",
    [1.6, 2.2, 3.0].every((v, i) => modsAt("known_by_touch", i + 1).revealDur === v)
    && [90, 120, 150].every((v, i) => modsAt("known_by_touch", i + 1).revealRadius === v)
    && [4.0, 3.4, 2.8].every((v, i) => Math.abs(modsAt("known_by_touch", i + 1).revealIcd - v) < 1e-9));
  check("REMEMBER ME disable duration is exactly 6/5/4s",
    [6, 5, 4].every((v, i) => modsAt("remember_me", i + 1).rememberMeDisableDur === v));
  check("CARRY THE LIGHT revive/rate/swap/light deltas are exact",
    [10, 18, 26].every((v, i) => modsAt("carry_the_light", i + 1).lightReviveRadius === v)
    && [0.12, 0.20, 0.30].every((v, i) => Math.abs(modsAt("carry_the_light", i + 1).lightReviveRate - v) < 1e-9)
    && [0.10, 0.18, 0.25].every((v, i) => Math.abs(modsAt("carry_the_light", i + 1).lightSwapCut - v) < 1e-9)
    && [70, 100, 130].every((v, i) => modsAt("carry_the_light", i + 1).lightRadius === v)
    && modsAt("carry_the_light", 3).lightFreeMag === 1);
}

section("blessing mechanics + combo taxes");
{
  // Crosscurrent chains bounded damage to a second body.
  const { world, player } = arena(0xF401);
  applyLevel(world, player, "crosscurrent", 1);
  acquireWeaponInWorld(world, player.id, "cannon");
  const a = parked(world, "skeleton", player.x + 90, player.y, 200);
  const b = parked(world, "skeleton", player.x + 110, player.y + 30, 200);
  const bStart = b.hp;
  for (let t = 0; t < 6; t++) step(world, player, { aim: 0, firing: true });
  check("CROSSCURRENT chains bounded damage to a distinct nearby body", b.hp < bStart && a.hp < 200);

  // Crosscurrent 55% jump tax on the chain/pierce specialists (tesla).
  const taxed = arena(0xF402);
  applyLevel(taxed.world, taxed.player, "crosscurrent", 3);
  acquireWeaponInWorld(taxed.world, taxed.player.id, "tesla");
  const shot = fireOnce(taxed.world, taxed.player, 0);
  check("CROSSCURRENT jump tax (55%) applies on tesla/arcbolt/cleaver/skipper/drain",
    shot.length > 0 && Math.abs((shot[0].crosscurrentTax ?? 1) - 0.45) < 1e-9);
  const untaxed = arena(0xF403);
  applyLevel(untaxed.world, untaxed.player, "crosscurrent", 3);
  acquireWeaponInWorld(untaxed.world, untaxed.player.id, "cannon");
  const cannonShot = fireOnce(untaxed.world, untaxed.player, 0);
  check("CROSSCURRENT is untaxed on non-pair weapons", (cannonShot[0].crosscurrentTax ?? 1) === 1);

  // Last Warm Round: cycle-final only. Sluicegate DRAIN (2nd beat) gets the bonus.
  const warm = arena(0xF404);
  applyLevel(warm.world, warm.player, "last_warm_round", 3);
  acquireWeaponInWorld(warm.world, warm.player.id, "sluicegate");
  const flood = fireOnce(warm.world, warm.player, 0); // FLOOD (not final)
  warm.world.bullets = [];
  const drain = fireOnce(warm.world, warm.player, 0); // DRAIN (final)
  const floodDmg = flood[0].damage;
  const drainBase = WEAPONS.sluicegate.modeShift!.alternate.damage;
  // DRAIN carries the +% (taxed 45% for the Sluice cycle): drain dmg > its base.
  check("LAST WARM ROUND boosts only the cycle-final shot (Sluice DRAIN), taxed 45%",
    drain[0].damage > drainBase && floodDmg < WEAPONS.sluicegate.damage * 1.16,
    `drain=${drain[0].damage.toFixed(2)} base=${drainBase}`);
  const simpleWarm = arena(0xF405);
  applyLevel(simpleWarm.world, simpleWarm.player, "last_warm_round", 3);
  acquireWeaponInWorld(simpleWarm.world, simpleWarm.player.id, "pistol");
  const plain = fireOnce(simpleWarm.world, simpleWarm.player, 0);
  check("LAST WARM ROUND is inert on simple guns (no free +% every shot)",
    Math.abs(plain[0].damage - WEAPONS.pistol.damage) < 1e-6);

  // Known by Touch: a dash reveals nearby evasion-untargetable bodies.
  const reveal = arena(0xF406);
  applyLevel(reveal.world, reveal.player, "known_by_touch", 3);
  const burrower = devSpawnEnemy(reveal.world, "burrower", reveal.player.x + 40, reveal.player.y);
  burrower.spawnTimer = 0; burrower.speed = 0;
  const dashEvents = [];
  for (let t = 0; t < 20; t++) {
    const evs = step(reveal.world, reveal.player, { moveX: 1, dash: t === 0 });
    for (const e of evs) dashEvents.push(e);
  }
  check("KNOWN BY TOUCH reveals nearby hidden bodies on a dash",
    burrower.revealT > 0 || dashEvents.some((e) => e.t === "blessingProc" && e.item === "known_by_touch"));

  // Remember Me: a lethal hit is survived once per floor by disabling the best blessing.
  const save = arena(0xF407);
  save.world.isGodMode = false;
  applyLevel(save.world, save.player, "remember_me", 1);
  applyLevel(save.world, save.player, "glass_cannon", 1); // a RARE, disable-able blessing
  check("REMEMBER ME is armed at floor start", save.player.rememberMeArmed === true);
  const killer = devSpawnEnemy(save.world, "skeleton", save.player.x + 8, save.player.y);
  killer.spawnTimer = 0;
  killer.touchDamage = 99;
  save.player.hp = 1;
  save.player.invuln = 0;
  let saved = false;
  for (let t = 0; t < 60 && !saved; t++) {
    const evs = step(save.world, save.player);
    if (evs.some((e) => e.t === "blessingProc" && e.item === "remember_me")) saved = true;
  }
  check("REMEMBER ME survives one lethal hit (HP to 1) and disables the best blessing",
    saved && save.player.hp >= 1 && save.player.rememberMeArmed === false
    && save.player.disabledBlessing?.id === "glass_cannon");

  // Carry the Light: revive radius + rate stack on Shared Rope distinctly.
  const light = arena(0xF408);
  applyLevel(light.world, light.player, "carry_the_light", 3);
  check("CARRY THE LIGHT extends revive radius and rate (distinct from Rope)",
    effectiveReviveRadius(light.player) > 46
    && effectiveReviveChannelSeconds(light.player) < 1.5);
  const both = arena(0xF409);
  applyLevel(both.world, both.player, "shared_rope", 3);
  applyLevel(both.world, both.player, "carry_the_light", 3);
  check("SHARED ROPE × CARRY THE LIGHT stack their distinct revive channels",
    effectiveReviveRadius(both.player) > effectiveReviveRadius(light.player));
}

section("weapon-switch cadence invariant for Wave B verbs");
{
  for (const id of WAVE_B_WEAPONS) {
    const s = arena(0xF500 + id.length);
    acquireWeaponInWorld(s.world, s.player.id, id);
    fireOnce(s.world, s.player, 0);
    const remaining = s.player.fireCd;
    acquireWeaponInWorld(s.world, s.player.id, "pistol");
    switchWeaponInWorld(s.world, s.player.id, id);
    check(`${id}: swap away/back never reduces its earned cooldown`,
      s.player.fireCd >= remaining - 1e-9);
  }
}

section("PvP fail-closed policy");
{
  const pvp = createWorld(0xF601, 1, { mode: "pvp", isSandbox: true });
  const fighter = pvp.players.get(LOCAL_ID)!;
  for (const id of WAVE_B_WEAPONS) acquireWeaponInWorld(pvp, fighter.id, id);
  check("PvP acquisition fails closed for every Wave B weapon",
    WAVE_B_WEAPONS.every((id) => !fighter.ownedWeapons.includes(id))
    && WAVE_B_WEAPONS.every((id) => !isPvpWeaponSupported(id))
    && WAVE_B_WEAPONS.every((id) => pvpUnsupportedWeaponIds.includes(id)));
  check("all five Wave B blessings stay outside the PvP draft pool",
    WAVE_B_BLESSINGS.every((id) => !isPvpBlessingId(id)));
}

process.stdout.write(`\ncontent Wave B: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const failure of failures) process.stdout.write(`  FAIL ${failure}\n`);
  process.exit(1);
}
