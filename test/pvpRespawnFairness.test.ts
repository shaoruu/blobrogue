import {
  createWorld,
  setPlayerAbsence,
  spawnPlayerInWorld,
  stepWorld,
} from "../src/sim/world.js";
import type { PlayerSim, WorldState } from "../src/sim/world.js";
import {
  PVP,
  pvpRespawnBaseScore,
  pvpRespawnIndex,
  pvpRespawnThreatFlags,
  pvpRespawnWaitSafeMaxTicks,
  pvpSpawnHardGraceTicks,
  pvpSpawnShieldTicks,
  PVP_RESPAWN_THREAT,
} from "../src/sim/pvp.js";
import type { PvpRespawnCandidate } from "../src/sim/pvp.js";
import type { Bullet, Vec2, WeaponId, WireEffect } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import type { InputCmd } from "../src/sim/input.js";

const DT = 1 / 20;
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
  failures.push(name + (detail ? ` — ${detail}` : ""));
  process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ""}\n`);
}

function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

function input(aim = 0): InputCmd {
  return { seq: 0, moveX: 0, moveY: 0, aim, firing: false, dash: false };
}

function clearProtection(player: PlayerSim): void {
  player.invuln = 0;
  player.spawnGraceT = 0;
  player.spawnShieldT = 0;
  player.spawnProtectionStartedTick = 0;
  player.spawnHardGraceEndsAtTick = 0;
  player.spawnShieldEndsAtTick = 0;
  player.isSpawnOffenseLatched = false;
}

function liveWorld(seed: number, count: number): WorldState {
  const world = createWorld(seed, 1, {
    mode: "pvp",
    isShared: true,
    skipLocalPlayer: true,
  });
  for (let i = 0; i < count; i++) spawnPlayerInWorld(world, `p${i + 1}`);
  let guard = 0;
  while (world.match?.phase !== "live" && guard++ < 200) stepWorld(world, new Map(), DT);
  for (const player of world.players.values()) clearProtection(player);
  return world;
}

function currentInputs(world: WorldState): Map<string, InputCmd> {
  return new Map([...world.players.values()].map((player) => [player.id, input(player.aimAngle)]));
}

function forceRespawn(world: WorldState, player: PlayerSim): number {
  player.hp = 0;
  player.respawnT = 1;
  clearProtection(player);
  let guard = 0;
  while (player.hp <= 0 && guard++ < pvpRespawnWaitSafeMaxTicks() + 3) {
    stepWorld(world, currentInputs(world), DT);
  }
  const spawns = world.match?.spawns ?? [];
  return spawns.findIndex((spawn) => spawn.x === player.x && spawn.y === player.y);
}

function candidate(index: number, score: number, over: Partial<PvpRespawnCandidate> = {}): PvpRespawnCandidate {
  return {
    index,
    minOpponentDistance: score,
    pitDistance: 0,
    losThreatCount: 0,
    isAimedAt: false,
    incomingThreatEtaSec: null,
    predictedIncomingDamage: 0,
    isCoveredFromNearest: false,
    isInwardExitWalkable: true,
    isCamped: false,
    isPitEligible: true,
    ...over,
  };
}

function setRespawnArena(world: WorldState, spawns: Vec2[]): void {
  if (world.match === null) throw new Error("missing PvP match");
  world.match.spawns = spawns;
  world.match.pits = [];
  world.bullets = [];
  world.effects = [];
  world.props = [];
}

function addIncomingBullet(
  world: WorldState,
  owner: PlayerSim,
  target: PlayerSim,
  spawn: Vec2,
  etaSec: number,
  weapon: WeaponId,
): void {
  const speed = 300;
  const radius = 4;
  const bullet: Bullet = {
    x: spawn.x - speed * (etaSec + DT) - target.pr - radius,
    y: spawn.y,
    vx: speed,
    vy: 0,
    radius,
    life: 4,
    friendly: true,
    owner: owner.id,
    damage: 5,
    color: "#fff",
    pierce: 0,
    hitList: null,
    isCrit: false,
    fx: weapon,
  };
  world.bullets.push(bullet);
}

function addImmediateThreats(world: WorldState, owner: PlayerSim, target: PlayerSim): void {
  const spawns = world.match?.spawns ?? [];
  const centerX = world.dungeon.spawn.x * TILE + TILE / 2;
  const centerY = world.dungeon.spawn.y * TILE + TILE / 2;
  const speed = 300;
  const radius = 4;
  for (const spawn of spawns) {
    const dx = spawn.x - centerX;
    const dy = spawn.y - centerY;
    const magnitude = Math.hypot(dx, dy) || 1;
    const ux = dx / magnitude;
    const uy = dy / magnitude;
    const travel = speed * (0.5 + DT) + target.pr + radius;
    world.bullets.push({
      x: spawn.x - ux * travel,
      y: spawn.y - uy * travel,
      vx: ux * speed,
      vy: uy * speed,
      radius,
      life: 2,
      friendly: true,
      owner: owner.id,
      damage: 5,
      color: "#fff",
      pierce: 0,
      hitList: null,
      isCrit: false,
      fx: "rapid",
    });
  }
}

section("pure scorer: exact penalties, anti-camp memory, and damage fallback");
{
  const scored = candidate(0, 500, {
    pitDistance: 200,
    losThreatCount: 2,
    isAimedAt: true,
    incomingThreatEtaSec: 1.5,
    isCoveredFromNearest: true,
  });
  check("score follows the named formula exactly",
    pvpRespawnBaseScore(scored)
      === 500 + 0.5 * 200 + PVP.respawnCoverBonus
      - PVP.respawnLosPenaltyCap - PVP.respawnAimPenalty - PVP.respawnProjectileNearPenalty);

  check("a camped candidate is ineligible when a non-camped candidate exists",
    pvpRespawnIndex([
      candidate(0, 1000, { isCamped: true }),
      candidate(1, 0),
    ]) === 1);
  check("recent spawn receives the 400 penalty",
    pvpRespawnIndex([candidate(0, 300), candidate(1, 250)], [0]) === 1);
  check("recent penalty is waived only for an alternative more than 800 points worse",
    pvpRespawnIndex([candidate(0, 1201), candidate(1, 300)], [0]) === 0);
  check("the same spawn cannot be selected a third time with two valid alternatives",
    pvpRespawnIndex([candidate(0, 1000), candidate(1, 300), candidate(2, 250)], [0, 0]) === 1);

  const fallback = pvpRespawnIndex([
    candidate(0, 1000, { losThreatCount: 1, predictedIncomingDamage: 30 }),
    candidate(1, 300, { incomingThreatEtaSec: 1, predictedIncomingDamage: 5 }),
  ], [], "timeout");
  check("all-threatened fallback minimizes predicted 1.5s incoming damage before score", fallback === 1);
  check("zero hard-projectile threat dominates an arbitrarily large distance score",
    pvpRespawnIndex([
      candidate(0, 100000, { incomingThreatEtaSec: 0.5 }),
      candidate(1, 192),
    ]) === 1);
  check("longer projectile ETA remains a soft score rather than a hard rejection",
    pvpRespawnIndex([
      candidate(0, 100000, { incomingThreatEtaSec: 2 }),
      candidate(1, 192),
    ]) === 0);
  check("plain LOS remains a soft score rather than an unconditional rejection",
    pvpRespawnIndex([
      candidate(0, 100000, { losThreatCount: 1 }),
      candidate(1, 192, { isCoveredFromNearest: true }),
    ]) === 0);
  const flags = pvpRespawnThreatFlags(candidate(0, 0, {
    losThreatCount: 1,
    isAimedAt: true,
    incomingThreatEtaSec: 0.5,
    isCamped: true,
    isPitEligible: false,
  }));
  check("threat telemetry flags LOS, aim, near projectile, camp, and pit independently",
    (flags & PVP_RESPAWN_THREAT.los) !== 0
    && (flags & PVP_RESPAWN_THREAT.aim) !== 0
    && (flags & PVP_RESPAWN_THREAT.projectileNear) !== 0
    && (flags & PVP_RESPAWN_THREAT.camp) !== 0
    && (flags & PVP_RESPAWN_THREAT.pit) !== 0);
  check("opponent proximity hard-rejects below 192px only when an alternative exists",
    pvpRespawnIndex([
      candidate(0, 0, { minOpponentDistance: 191, pitDistance: 10000 }),
      candidate(1, 0, { minOpponentDistance: 192 }),
    ]) === 1);
  check("all-close geometry remains rankable instead of starving the candidate set",
    pvpRespawnIndex([
      candidate(0, 0, { minOpponentDistance: 191, pitDistance: 10000 }),
      candidate(1, 0, { minOpponentDistance: 190 }),
    ]) === 0);
  check("aimed LOS rejects only when a non-LOS alternative exists",
    pvpRespawnIndex([
      candidate(0, 10000, { losThreatCount: 1, isAimedAt: true }),
      candidate(1, 192),
    ]) === 1
    && pvpRespawnIndex([
      candidate(0, 10000, { losThreatCount: 1, isAimedAt: true }),
      candidate(1, 192, { losThreatCount: 1, isAimedAt: true }),
    ]) === 0);
  check("projectile TTI at 0.75s is hard while 0.80s remains a soft ranking input",
    pvpRespawnIndex([
      candidate(0, 10000, { incomingThreatEtaSec: 0.75 }),
      candidate(1, 192),
    ]) === 1
    && pvpRespawnIndex([
      candidate(0, 10000, { incomingThreatEtaSec: 0.80 }),
      candidate(1, 192),
    ]) === 0);
}

section("all-eight unsafe candidates wait, poll, and time out deterministically");
{
  const opensWorld = liveWorld(40, 2);
  opensWorld.props = [];
  const opensVictim = opensWorld.players.get("p1")!;
  const opensOpponent = opensWorld.players.get("p2")!;
  opensOpponent.x = 456;
  opensOpponent.y = 456;
  clearProtection(opensOpponent);
  addImmediateThreats(opensWorld, opensOpponent, opensVictim);
  opensVictim.hp = 0;
  opensVictim.respawnT = 1;
  stepWorld(opensWorld, currentInputs(opensWorld), DT);
  check("all eight threatened candidates enter RESPAWN_WAIT_SAFE with UI respawn state intact",
    opensVictim.hp === 0
    && opensVictim.respawnT === 1
    && opensVictim.respawnWaitSafeT === pvpRespawnWaitSafeMaxTicks());
  opensWorld.bullets = [];
  stepWorld(opensWorld, currentInputs(opensWorld), DT);
  stepWorld(opensWorld, currentInputs(opensWorld), DT);
  check("a safe lane opening at the first 0.10s poll respawns immediately",
    opensVictim.hp === PVP.maxHp
    && opensVictim.respawnWaitSafeT === 0
    && opensVictim.spawnShieldT === pvpSpawnShieldTicks()
    && opensVictim.pvpRespawnTelemetry?.waitSafeMs === 100
    && !opensVictim.pvpRespawnTelemetry.isFallbackShield);

  const timeoutWorld = liveWorld(41, 9);
  timeoutWorld.props = [];
  const timeoutVictim = timeoutWorld.players.get("p1")!;
  const timeoutSpawns = timeoutWorld.match?.spawns ?? [];
  [...timeoutWorld.players.values()].filter((player) => player !== timeoutVictim)
    .forEach((opponent, index) => {
      opponent.x = timeoutSpawns[index].x;
      opponent.y = timeoutSpawns[index].y;
      clearProtection(opponent);
    });
  timeoutVictim.hp = 0;
  timeoutVictim.respawnT = 1;
  stepWorld(timeoutWorld, currentInputs(timeoutWorld), DT);
  for (let i = 0; i < pvpRespawnWaitSafeMaxTicks(); i++) {
    stepWorld(timeoutWorld, currentInputs(timeoutWorld), DT);
  }
  check("an arena that stays all-unsafe times out at exactly 0.75s with the full shield",
    timeoutVictim.hp === PVP.maxHp
    && timeoutVictim.spawnShieldT === 60
    && timeoutVictim.pvpRespawnTelemetry?.safeCount === 0
    && timeoutVictim.pvpRespawnTelemetry.waitSafeMs === 750
    && timeoutVictim.pvpRespawnTelemetry.isFallbackShield);
}

section("hard grace suppresses every shipped outgoing attack family");
{
  const weapons: WeaponId[] = [
    "pistol",
    "spear",
    "mortar",
    "frostline",
    "snapwire",
    "halo",
    "sentry",
    "crook",
  ];
  for (const weapon of weapons) {
    const world = liveWorld(50 + weapons.indexOf(weapon), 2);
    const actor = world.players.get("p1")!;
    actor.weapon = weapon;
    actor.ownedWeapons = [weapon];
    actor.spawnGraceT = pvpSpawnHardGraceTicks();
    actor.spawnShieldT = pvpSpawnShieldTicks();
    const shotSeq = actor.shotSeq;
    const events = stepWorld(world, new Map([
      [actor.id, {
        ...input(actor.aimAngle),
        firing: true,
        ult: true,
        pulse: true,
      }],
    ]), DT);
    check(`${weapon} creates no combat entity, damage, or attack event during hard grace`,
      actor.shotSeq === shotSeq
      && actor.meleeSwing === null
      && world.bullets.every((bullet) => bullet.owner !== actor.id)
      && world.effects.every((effect) => effect.owner !== actor.id)
      && !actor.isUltRequested
      && !actor.isPulseRequested
      && !events.some((event) =>
        event.t === "shot"
        || event.t === "wirePlanted"
        || event.t === "haloFlare"
        || event.t === "sentryPlaced"
        || event.t === "tetherLatch"
      ));
  }
}

section("actual walls and intact props provide cover; broken props do not");
{
  const spawns = [{ x: 300, y: 216 }, { x: 600, y: 216 }];
  const wallWorld = liveWorld(100, 2);
  setRespawnArena(wallWorld, spawns);
  const wallVictim = wallWorld.players.get("p1")!;
  const wallOpponent = wallWorld.players.get("p2")!;
  wallOpponent.x = 300;
  wallOpponent.y = 600;
  wallOpponent.aimAngle = 0;
  wallWorld.dungeon.tiles[8 * wallWorld.dungeon.w + 6] = 1;
  wallVictim.pvpRecentSpawnIndices = [];
  check("an actual wall-blocked spawn beats the exposed farther spawn",
    forceRespawn(wallWorld, wallVictim) === 0);

  const propWorld = liveWorld(101, 2);
  setRespawnArena(propWorld, spawns);
  const propVictim = propWorld.players.get("p1")!;
  const propOpponent = propWorld.players.get("p2")!;
  propOpponent.x = 300;
  propOpponent.y = 600;
  propOpponent.aimAngle = 0;
  propWorld.props = [{
    id: 900,
    kind: "crate",
    x: 300,
    y: 400,
    radius: 15,
    hp: 20,
    dead: false,
  }];
  propVictim.pvpRecentSpawnIndices = [];
  check("an intact prop blocks LOS and earns cover preference",
    forceRespawn(propWorld, propVictim) === 0);

  const brokenWorld = liveWorld(102, 2);
  setRespawnArena(brokenWorld, spawns);
  const brokenVictim = brokenWorld.players.get("p1")!;
  const brokenOpponent = brokenWorld.players.get("p2")!;
  brokenOpponent.x = 300;
  brokenOpponent.y = 600;
  brokenOpponent.aimAngle = 0;
  brokenWorld.props = [{
    id: 901,
    kind: "crate",
    x: 300,
    y: 400,
    radius: 15,
    hp: 0,
    dead: true,
    breakT: 0,
  }];
  brokenVictim.pvpRecentSpawnIndices = [];
  check("a broken prop no longer counts as LOS cover",
    forceRespawn(brokenWorld, brokenVictim) === 1);
}

section("swept projectile ETA and shipped ranged/trap threats");
{
  const spawns = [{ x: 840, y: 456 }, { x: 300, y: 216 }];
  for (const etaSec of [0.5, 1, 1.5, 2]) {
    const world = liveWorld(200 + Math.round(etaSec * 10), 2);
    setRespawnArena(world, spawns);
    const victim = world.players.get("p1")!;
    const owner = world.players.get("p2")!;
    owner.x = 300;
    owner.y = 600;
    owner.aimAngle = Math.PI;
    victim.pvpRecentSpawnIndices = [];
    addIncomingBullet(world, owner, victim, spawns[0], etaSec, "rapid");
    const selected = forceRespawn(world, victim);
    check(`rapid round at ETA ${etaSec}s ${etaSec <= 1.5 ? "avoids" : "soft-ranks"} its swept candidate`,
      selected === (etaSec <= 1.5 ? 1 : 0),
      `selected=${selected} bullet=${world.bullets.map((bullet) => `${bullet.x.toFixed(1)},${bullet.y.toFixed(1)},${bullet.life.toFixed(2)}`).join("|")}`);
  }

  const beamWorld = liveWorld(250, 2);
  setRespawnArena(beamWorld, spawns);
  const beamVictim = beamWorld.players.get("p1")!;
  const beamOwner = beamWorld.players.get("p2")!;
  beamOwner.x = 300;
  beamOwner.y = 600;
  beamOwner.aimAngle = Math.PI;
  addIncomingBullet(beamWorld, beamOwner, beamVictim, spawns[0], 1, "beam");
  check("beam trajectory is included in incoming threat prediction",
    forceRespawn(beamWorld, beamVictim) === 1);

  const homingWorld = liveWorld(2501, 2);
  setRespawnArena(homingWorld, spawns);
  const homingVictim = homingWorld.players.get("p1")!;
  const homingOwner = homingWorld.players.get("p2")!;
  homingOwner.x = 300;
  homingOwner.y = 600;
  homingOwner.aimAngle = Math.PI;
  homingWorld.bullets.push({
    x: spawns[0].x - 120,
    y: spawns[0].y - 100,
    vx: 300,
    vy: 0,
    radius: 4,
    life: 2,
    friendly: true,
    owner: homingOwner.id,
    damage: 3,
    color: "#fff",
    pierce: 0,
    hitList: null,
    isCrit: false,
    homing: 4,
    fx: "homing",
  });
  check("off-axis homing acquisition is included in candidate threat prediction",
    forceRespawn(homingWorld, homingVictim) === 1);

  const distantHomingWorld = liveWorld(2502, 2);
  setRespawnArena(distantHomingWorld, spawns);
  const distantVictim = distantHomingWorld.players.get("p1")!;
  const distantOwner = distantHomingWorld.players.get("p2")!;
  distantOwner.x = 300;
  distantOwner.y = 600;
  distantOwner.aimAngle = Math.PI;
  distantVictim.pvpRecentSpawnIndices = [];
  distantHomingWorld.bullets.push({
    x: 400,
    y: 700,
    vx: -300,
    vy: 0,
    radius: 4,
    life: 2,
    friendly: true,
    owner: distantOwner.id,
    damage: 3,
    color: "#fff",
    pierce: 0,
    hitList: null,
    isCrit: false,
    homing: 4,
    fx: "homing",
  });
  check("out-of-range homing moving away does not invent an acquisition threat",
    forceRespawn(distantHomingWorld, distantVictim) === 0);

  const mortarWorld = liveWorld(251, 2);
  setRespawnArena(mortarWorld, spawns);
  const mortarVictim = mortarWorld.players.get("p1")!;
  const mortarOwner = mortarWorld.players.get("p2")!;
  mortarOwner.x = 300;
  mortarOwner.y = 600;
  mortarOwner.aimAngle = Math.PI;
  const mortarSpeed = 300;
  mortarWorld.bullets.push({
    x: spawns[0].x - mortarSpeed * (1 + DT),
    y: spawns[0].y,
    vx: mortarSpeed,
    vy: 0,
    radius: 5,
    life: 1 + DT,
    friendly: true,
    owner: mortarOwner.id,
    damage: 9,
    color: "#fff",
    pierce: 0,
    hitList: null,
    isCrit: false,
    fx: "mortar",
    isLob: true,
    blast: 90,
  });
  check("mortar landing ETA is included in predicted incoming damage",
    forceRespawn(mortarWorld, mortarVictim) === 1);

  const wireWorld = liveWorld(252, 2);
  setRespawnArena(wireWorld, spawns);
  const wireVictim = wireWorld.players.get("p1")!;
  const wireOwner = wireWorld.players.get("p2")!;
  wireOwner.x = 300;
  wireOwner.y = 600;
  wireOwner.aimAngle = Math.PI;
  const wire: WireEffect = {
    id: 500,
    kind: "wire",
    owner: wireOwner.id,
    fx: "snapwire",
    x: spawns[0].x,
    y: spawns[0].y - 80,
    x2: spawns[0].x,
    y2: spawns[0].y + 80,
    width: 14,
    arm: 0,
    life: 10,
    maxLife: 10,
    damage: 9,
  };
  wireWorld.effects.push(wire);
  check("an armed trap excludes its threatened spawn when a safe candidate exists",
    forceRespawn(wireWorld, wireVictim) === 1);
}

section("absent, downed, and respawning bodies are not spawn threats");
{
  const world = liveWorld(300, 4);
  const spawns = [{ x: 300, y: 216 }, { x: 600, y: 216 }];
  setRespawnArena(world, spawns);
  const victim = world.players.get("p1")!;
  const absent = world.players.get("p2")!;
  const downed = world.players.get("p3")!;
  const respawning = world.players.get("p4")!;
  for (const player of [absent, downed, respawning]) {
    player.x = spawns[0].x;
    player.y = spawns[0].y;
    player.aimAngle = 0;
  }
  setPlayerAbsence(world, absent.id, true);
  downed.isDown = true;
  respawning.hp = 0;
  respawning.respawnT = 20;
  victim.pvpRecentSpawnIndices = [];
  check("non-live bodies cannot camp, aim, or contribute LOS",
    forceRespawn(world, victim) === 0);
}

section("protected bodies remain respawn occupancy while combat acquisition excludes them");
{
  const world = liveWorld(325, 2);
  const spawns = [{ x: 300, y: 216 }, { x: 600, y: 216 }];
  setRespawnArena(world, spawns);
  const victim = world.players.get("p1")!;
  const protectedOpponent = world.players.get("p2")!;
  protectedOpponent.x = spawns[0].x;
  protectedOpponent.y = spawns[0].y;
  protectedOpponent.spawnShieldT = pvpSpawnShieldTicks();
  victim.pvpRecentSpawnIndices = [];
  check("a shielded opponent still prevents spawning on top of their occupied lane",
    forceRespawn(world, victim) === 1);
}

section("live joins enter the same authoritative spawn-memory policy");
{
  const world = liveWorld(350, 2);
  const joined = spawnPlayerInWorld(world, "p3");
  check("a mid-match join records its selected spawn immediately",
    joined.pvpRecentSpawnIndices.length === 1
    && joined.pvpRecentSpawnIndices[0] >= 0);
}

section("2p/4p/6p cross-cover stress is deterministic and never starves");
{
  const simultaneousRespawns = (order: string[]): { digest: string; isDistinct: boolean } => {
    const world = createWorld(399, 1, {
      mode: "pvp",
      isShared: true,
      skipLocalPlayer: true,
    });
    for (const id of order) spawnPlayerInWorld(world, id);
    let guard = 0;
    while (world.match?.phase !== "live" && guard++ < 200) stepWorld(world, new Map(), DT);
    for (const id of ["p1", "p2"]) {
      const player = world.players.get(id)!;
      player.hp = 0;
      player.respawnT = 1;
      clearProtection(player);
    }
    stepWorld(world, currentInputs(world), DT);
    const players = ["p1", "p2"].map((id) => world.players.get(id)!);
    return {
      digest: players.map((player) => {
        return `${player.id}:${player.x},${player.y}:${player.pvpRecentSpawnIndices.join(".")}`;
      }).join("|"),
      isDistinct: players[0].x !== players[1].x || players[0].y !== players[1].y,
    };
  };
  const simultaneousForward = simultaneousRespawns(["p1", "p2", "p3"]);
  const simultaneousReversed = simultaneousRespawns(["p3", "p2", "p1"]);
  check("simultaneous respawns are map-order independent",
    simultaneousForward.digest === simultaneousReversed.digest);
  check("simultaneous respawns remain physically distinct",
    simultaneousForward.isDistinct && simultaneousReversed.isDistinct);

  const run = (seed: number, count: number): number[] => {
    const world = liveWorld(seed, count);
    const target = world.players.get("p1")!;
    const opponents = [...world.players.values()].filter((player) => player !== target);
    const cross = [
      { x: 456, y: 456 },
      { x: 466, y: 456 },
      { x: 456, y: 466 },
      { x: 446, y: 456 },
      { x: 456, y: 446 },
    ];
    opponents.forEach((player, index) => {
      player.x = cross[index].x;
      player.y = cross[index].y;
      player.aimAngle = index * Math.PI / 2;
      clearProtection(player);
    });
    target.pvpRecentSpawnIndices = [];
    const sequence: number[] = [];
    for (let i = 0; i < 16; i++) {
      world.bullets = [];
      world.effects = [];
      sequence.push(forceRespawn(world, target));
    }
    return sequence;
  };

  for (const count of [2, 4, 6]) {
    const a = run(400 + count, count);
    const b = run(400 + count, count);
    const isNeverTriple = a.every((index, i) =>
      i < 2 || index !== a[i - 1] || index !== a[i - 2]
    );
    check(`${count}p sequence is replay deterministic`,
      JSON.stringify(a) === JSON.stringify(b), a.join(","));
    check(`${count}p sequence always selects a spawn without triple-lane starvation`,
      a.every((index) => index >= 0) && isNeverTriple, a.join(","));
  }
}

section("reconnect preserves protection and spawn memory exactly");
{
  const world = liveWorld(500, 4);
  const player = world.players.get("p1")!;
  player.respawnT = 1;
  player.respawnWaitSafeT = 7;
  player.spawnGraceT = 13;
  player.spawnShieldT = 43;
  player.spawnProtectionStartedTick = world.tick;
  player.spawnHardGraceEndsAtTick = world.tick + 13;
  player.spawnShieldEndsAtTick = world.tick + 43;
  player.isSpawnOffenseLatched = true;
  player.pvpRecentSpawnIndices = [2, 5];
  const before = JSON.stringify({
    respawnT: player.respawnT,
    respawnWaitSafeT: player.respawnWaitSafeT,
    spawnGraceT: player.spawnGraceT,
    spawnShieldT: player.spawnShieldT,
    isSpawnOffenseLatched: player.isSpawnOffenseLatched,
    memory: player.pvpRecentSpawnIndices,
  });
  setPlayerAbsence(world, player.id, true);
  for (let i = 0; i < 10; i++) stepWorld(world, currentInputs(world), DT);
  setPlayerAbsence(world, player.id, false);
  const after = JSON.stringify({
    respawnT: player.respawnT,
    respawnWaitSafeT: player.respawnWaitSafeT,
    spawnGraceT: player.spawnGraceT,
    spawnShieldT: player.spawnShieldT,
    isSpawnOffenseLatched: player.isSpawnOffenseLatched,
    memory: player.pvpRecentSpawnIndices,
  });
  check("reserved-seat reconnect freezes and restores respawn state in a live 4p match", before === after);

  const protectedWorld = liveWorld(501, 4);
  const protectedPlayer = protectedWorld.players.get("p1")!;
  protectedPlayer.spawnGraceT = 0;
  protectedPlayer.spawnShieldT = 10;
  const activeTicks = protectedPlayer.pvpRespawnTelemetry?.activeTicks ?? -1;
  setPlayerAbsence(protectedWorld, protectedPlayer.id, true);
  for (let i = 0; i < 10; i++) stepWorld(protectedWorld, currentInputs(protectedWorld), DT);
  check("absence freezes both protection and active-life telemetry clocks",
    protectedPlayer.spawnShieldT === 10
    && protectedPlayer.pvpRespawnTelemetry?.activeTicks === activeTicks);
}

process.stdout.write(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(failures.map((failure) => `  - ${failure}`).join("\n") + "\n");
  process.exit(1);
}
