import {
  acquireWeaponInWorld,
  applyItemToWorld,
  createWorld,
  devSpawnEnemy,
  removePlayerFromWorld,
  spawnPlayerInWorld,
  stepWorld,
  switchWeaponInWorld,
} from "../src/sim/world.js";
import type { PlayerSim, WorldState } from "../src/sim/world.js";
import type { InputCmd, PlayerId } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { Bullet, WeaponId } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import { WEAPONS, PICKUP_WEAPONS } from "../src/sim/weapons.js";
import { ARSENAL } from "../src/sim/arsenal.js";
import { WEAPON_RESONANCE } from "../src/sim/balance.js";
import { FIRE_KNOCKBACK, WEAPON_KB } from "../src/sim/constants.js";
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
import { heldWeaponSrc, weaponIconSrc } from "../src/game/assets.js";
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
    PICKUP_WEAPONS.length === 41
    && ITEMS.filter((item) => item.isPremiumOnly !== true).length === 35);
}

section("MOORING NAIL — ANCHOR / GRAPPLE");
{
  const { world, player } = arena(0xA001);
  player.x = 5 * TILE;
  player.y = 12 * TILE;
  acquireWeaponInWorld(world, player.id, "mooring_nail");
  const startX = player.x;
  fireOnce(world, player, Math.PI);
  for (let tick = 0; tick < 90; tick++) {
    stepWorld(world, new Map([[player.id, input(world.tick + 1, { aim: Math.PI })]]), DT);
  }
  check("a wall hit grapples the owner toward the anchor", player.x < startX - 80,
    `${startX.toFixed(0)} -> ${player.x.toFixed(0)}`);

  const shared = createWorld(0xA002, 1, { isShared: true, skipLocalPlayer: true, isSandbox: true });
  shared.isGodMode = true;
  const owner = spawnPlayerInWorld(shared, "owner");
  const teammate = spawnPlayerInWorld(shared, "teammate");
  owner.x = 5 * TILE;
  owner.y = teammate.y = 12 * TILE;
  teammate.x = 8 * TILE;
  acquireWeaponInWorld(shared, owner.id, "mooring_nail");
  fireOnce(shared, owner, Math.PI);
  const teammateX = teammate.x;
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
  check("the authoritative cycle advances once per committed shot",
    player.weaponCycles.sluicegate === 2);
}

section("ODDSMAKER — GAMBLE");
{
  const { world, player } = arena(0xA201);
  acquireWeaponInWorld(world, player.id, "oddsmaker");
  const outcomes = new Set<string>();
  for (let shot = 0; shot < 64; shot++) {
    world.bullets = [];
    const bullet = fireOnce(world, player)[0];
    outcomes.add(
      bullet.bounce !== undefined ? "ricochet"
        : bullet.homing !== undefined ? "seeker"
          : bullet.blast !== undefined ? "blast"
            : bullet.pierce >= 2 ? "pierce"
              : "plain",
    );
  }
  check("the deterministic gamble reaches all four authored payload verbs",
    outcomes.size === 4 && !outcomes.has("plain"), [...outcomes].sort().join(","));
  player.weaponCycles.oddsmaker = 0x0fffffff;
  fireOnce(world, player);
  check("the gamble cycle wraps at its fixed safety bound", player.weaponCycles.oddsmaker === 0);

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
  const { world, player } = arena(0xA301);
  world.isGodMode = false;
  acquireWeaponInWorld(world, player.id, "pathmaker");
  world.hazards.push({
    id: world.nextHazardId++,
    kind: "web",
    x: player.x + 30,
    y: player.y,
    radius: 20,
    life: 10,
    maxLife: 10,
  });
  fireOnce(world, player);
  for (let tick = 0; tick < 12; tick++) {
    stepWorld(world, new Map([[player.id, input(world.tick + 1)]]), DT);
  }
  const paving = world.effects.find((effect) => effect.kind === "zone" && effect.isPaved);
  check("the bead paints an authoritative paved zone", paving !== undefined);
  check("paving cleanses overlapping hostile ground", world.hazards.every((hazard) => hazard.kind !== "web"));
  if (paving !== undefined) {
    player.x = paving.x;
    player.y = paving.y;
    const tx = Math.floor(player.x / TILE);
    const ty = Math.floor(player.y / TILE);
    world.floorHazards = [{ id: 0, kind: "toxic_pool", tx, ty, phase: 0, group: 0 }];
    player.invuln = 0;
    const safeHp = player.hp;
    stepWorld(world, new Map([[player.id, input(world.tick + 1)]]), DT);
    check("paved ground suppresses floor damage and rift pressure", player.hp === safeHp);
    for (const effect of world.effects) {
      if (effect.kind === "zone" && effect.isPaved) effect.life = 0;
    }
    player.invuln = 0;
    stepWorld(world, new Map([[player.id, input(world.tick + 1)]]), DT);
    check("the same floor hazard damages again after the paving expires", player.hp < safeHp);
  }
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

  const { world: reclaimWorld, player: reclaimPlayer } = arena(0xB101);
  reclaimPlayer.x = 5 * TILE;
  reclaimPlayer.y = 12 * TILE;
  applyLevel(reclaimWorld, reclaimPlayer, "nothing_wasted", 1);
  fireOnce(reclaimWorld, reclaimPlayer, Math.PI);
  let reclaimed: Bullet | undefined;
  for (let tick = 0; tick < 60 && reclaimed === undefined; tick++) {
    const events = stepWorld(reclaimWorld, new Map([[reclaimPlayer.id, input(reclaimWorld.tick + 1, { aim: Math.PI })]]), DT);
    if (events.some((event) => event.t === "bulletBounce")) reclaimed = reclaimWorld.bullets[0];
  }
  check("NOTHING WASTED reclaims one missed plain round from the wall",
    reclaimed !== undefined && Math.abs(reclaimed.damage - WEAPONS.pistol.damage * 0.35) < 1e-6);

  const { world: muddyWorld, player: muddyPlayer } = arena(0xB201);
  applyLevel(muddyWorld, muddyPlayer, "second_breath_muddy", 3);
  muddyWorld.hazards.push({
    id: muddyWorld.nextHazardId++,
    kind: "web",
    x: muddyPlayer.x + 20,
    y: muddyPlayer.y,
    radius: 24,
    life: 10,
    maxLife: 10,
  });
  stepWorld(muddyWorld, new Map([[muddyPlayer.id, input(1, { moveX: 1, dash: true })]]), DT);
  check("SECOND BREATH MUDDY refunds exactly once after a dash clears silk",
    muddyPlayer.isMuddyRefundSpent && muddyPlayer.dashCd > 0 && muddyPlayer.dashCd < 0.5);
  const afterRefund = muddyPlayer.dashCd;
  stepWorld(muddyWorld, new Map([[muddyPlayer.id, input(2, { moveX: 1 })]]), DT);
  check("the muddy refund cannot recurse on later dash ticks",
    Math.abs(muddyPlayer.dashCd - (afterRefund - DT)) < 1e-6);

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
  beatPlayer.fireCd = 0;
  for (let tick = 0; tick < 20 && !target.dead; tick++) {
    stepWorld(beatWorld, new Map([[beatPlayer.id, input(beatWorld.tick + 1, { firing: true })]]), DT);
  }
  check("ON THE BEAT extends the real kill-combo window by 1.1s", beatPlayer.comboTimer > 3.9);

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
}

section("snapshot, ownership, and PvP fail-closed policy");
{
  const { player } = arena(0xC001);
  player.weaponCycles.sluicegate = 17;
  player.weaponCycles.oddsmaker = 29;
  player.isMuddyRefundSpent = true;
  const copy = createWorld(0xC002, 1, { isSandbox: true }).players.get(LOCAL_ID)!;
  applyPlayerSnapshot(copy, projectPlayer(player));
  check("reconnect snapshots preserve weapon cycles and muddy refund state",
    copy.weaponCycles.sluicegate === 17
    && copy.weaponCycles.oddsmaker === 29
    && copy.isMuddyRefundSpent);

  const pvp = createWorld(0xC101, 1, { mode: "pvp", isSandbox: true });
  const fighter = pvp.players.get(LOCAL_ID)!;
  for (const id of WAVE_A_WEAPONS) acquireWeaponInWorld(pvp, fighter.id, id);
  check("PvP acquisition fails closed for all unsupported Wave A weapons",
    WAVE_A_WEAPONS.every((id) => !fighter.ownedWeapons.includes(id))
    && WAVE_A_WEAPONS.every((id) => !isPvpWeaponSupported(id))
    && pvpUnsupportedWeaponIds.length === WAVE_A_WEAPONS.length);
  fighter.ownedWeapons.push("oddsmaker");
  check("PvP equip also fails closed for a maliciously injected unsupported id",
    !switchWeaponInWorld(pvp, fighter.id, "oddsmaker") && fighter.weapon !== "oddsmaker");
  check("all five Wave A blessings stay outside the PvP draft pool",
    WAVE_A_BLESSINGS.every((id) => !isPvpBlessingId(id)));
}

process.stdout.write(`\ncontent Wave A: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const failure of failures) process.stdout.write(`  FAIL ${failure}\n`);
  process.exit(1);
}
