// PVP (free-for-all arena deathmatch) sim suite — the gate-able P1 core.
//
// Proves the four mode-gated concerns and the balancer's combat model, all in the PURE sim:
//   - DAMAGE TARGETING: an owned round/swing hits a NON-OWNER foe (co-op passes friendly through);
//     every hit routes through the ONE damagePlayer funnel with `by` attribution.
//   - NO AI / ARENA: the symmetric buildPvpArena() (fair, point-symmetric, spread spawns).
//   - SPAWNS: id-sorted spread placement + two-stage authoritative spawn protection.
//   - MATCH: the tick-based FRAG-LIMIT RESPAWN state machine (lobby->countdown->live->over),
//     deterministic + reconnect-stable winner, respawn (never elimination).
// Plus the balancer numbers (fixed 100 HP, global 1.78x + per-weapon outliers, 35% per-hit cap,
// per-weapon TTK band) and the NO-SNOWBALL guard (ults off, zero in-match power gain).
//
// Run: npm run test:pvp

import {
  createWorld, stepWorld, spawnPlayerInWorld, removePlayerFromWorld, setPlayerAbsence, isPvp,
  isFloorCleared, playersAtExit, applyItemToWorld,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import {
  PVP, buildPvpArena, pvpArenaRot90, pvpHitDamage, pvpPerHitCap, pvpFragLimit, farthestSpawnIndex, arePvpFoes,
  pvpRespawnDelayTicks, pvpCountdownTicks, pvpEnvKillCreditWindowTicks, pvpChainWindowTicks,
  pvpDraftEveryTicks, pvpDraftSeed, pvpBlessingBlacklist, pvpComebackTierBump,
  pvpPitEdgeDistance, pvpNearestPitEdgeDistance, pvpSingleDashDistance, pvpRespawnIndex,
  isPvpPitWarningTile, pvpSpawnHardGraceTicks, pvpSpawnShieldTicks, pvpSpawnFallbackShieldTicks,
  pvpRespawnWaitSafeMaxTicks, pvpDeathWithinSpawnTicks,
} from "../src/sim/pvp.js";
import type { PvpRespawnCandidate } from "../src/sim/pvp.js";
import type { Vec2, WireEffect } from "../src/sim/types.js";
import { WEAPONS } from "../src/sim/weapons.js";
import { ULT } from "../src/sim/kits.js";
import { TILE } from "../src/sim/types.js";
import { WEAPON_KB } from "../src/sim/constants.js";
import { CAPS, PLAYER } from "../src/sim/balance.js";
import type { InputCmd } from "../src/sim/input.js";
import type { SimEvent } from "../src/sim/events.js";
import { buildSnapshot, jsonCodec, validateSnap, PROTOCOL_VERSION } from "../src/net/protocol.js";
import type { ServerMsg } from "../src/net/protocol.js";
import { diffSnapshot, applySnapshotDelta, snapshotToWire } from "../src/net/snapshotDelta.js";
import { Rng } from "../src/sim/rng.js";
import {
  createMods, isPvpBlessingId, itemById, recomputeMods, rollPvpDraftChoicesWith,
} from "../src/sim/items.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void { process.stdout.write(`\n[${name}]\n`); }

const DT = 1 / 20;

function inp(over: Partial<InputCmd>): InputCmd {
  return { seq: 0, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false, ...over };
}

function pvpWorld(seed: number, ids: string[]): WorldState {
  const w = createWorld(seed, 1, { mode: "pvp", isShared: true, skipLocalPlayer: true });
  for (const id of ids) spawnPlayerInWorld(w, id);
  return w;
}

// Step until the match reaches the live phase (past lobby + countdown).
function advanceToLive(w: WorldState, inputs: Map<string, InputCmd> = new Map()): void {
  let guard = 0;
  while (w.match !== null && w.match.phase !== "live" && guard++ < 5000) stepWorld(w, inputs, DT);
  for (const player of w.players.values()) clearPvpProtection(player);
}

function stepN(w: WorldState, n: number, inputs: Map<string, InputCmd>): void {
  for (let i = 0; i < n; i++) stepWorld(w, inputs, DT);
}

// Step n ticks, collecting every SimEvent emitted (for the reliable pvp events).
function stepCollect(w: WorldState, n: number, inputs: Map<string, InputCmd>): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < n; i++) for (const e of stepWorld(w, inputs, DT)) out.push(e);
  return out;
}

function snapOf(w: WorldState, selfPid: string): Extract<ServerMsg, { t: "snap" }> {
  return buildSnapshot(w, selfPid, 0, [], 0, true, { worldId: "arena-1", sseq: 1 }) as Extract<ServerMsg, { t: "snap" }>;
}

function clearPvpProtection(player: PlayerSim): void {
  player.invuln = 0;
  player.spawnGraceT = 0;
  player.spawnShieldT = 0;
  player.spawnProtectionStartedTick = 0;
  player.spawnHardGraceEndsAtTick = 0;
  player.spawnShieldEndsAtTick = 0;
  player.isSpawnOffenseLatched = false;
}

// Drop two players next to each other on a CLEAR horizontal lane of the 19x19 arena (row 4 has
// no cover props), protection cleared, `a` facing `b` (straight right). Returns the aim angle.
function faceOff(a: PlayerSim, b: PlayerSim, gap: number): number {
  a.x = 300; a.y = 216; clearPvpProtection(a); // tile (6,4)
  b.x = 300 + gap; b.y = 216; clearPvpProtection(b);
  return 0;
}

// ---------------------------------------------------------------------------------------------
section("mode discriminant + fixed-HP loadout");
{
  const w = pvpWorld(1, ["p1", "p2"]);
  check("world mode is pvp", isPvp(w) && w.mode === "pvp");
  check("match state exists", w.match !== null);
  const p1 = w.players.get("p1")!;
  check("pvp player uses the FIXED 100 HP pool", p1.maxHp === PVP.maxHp && p1.hp === PVP.maxHp, `maxHp=${p1.maxHp}`);
  check("pvp loadout is the symmetric neutral kit", p1.kitId === PVP.kit);
  check("pvp loadout is the symmetric start weapon", p1.weapon === PVP.startWeapon && p1.ownedWeapons.length === 1);
  check("pvp team is 0 (FFA)", p1.team === 0);

  const coop = createWorld(1, 1, { isShared: true, skipLocalPlayer: true });
  spawnPlayerInWorld(coop, "c1");
  check("co-op keeps mode coop by default", !isPvp(coop) && coop.mode === "coop" && coop.match === null);
  check("co-op player keeps the PvE HP pool", coop.players.get("c1")!.maxHp === 6);
}

// ---------------------------------------------------------------------------------------------
section("damage model (balancer numbers)");
{
  check("fixed maxHp = 100", PVP.maxHp === 100);
  check("global dmgMult = 1.78", PVP.dmgMult === 1.78);
  check("per-hit cap = 35% of maxHp = 35", pvpPerHitCap() === 35);
  check("ults disabled flag", PVP.ultsEnabled === false);
  check("spawn hard grace = 0.75s", PVP.spawnHardGraceSec === 0.75 && pvpSpawnHardGraceTicks() === 15);
  check("normal spawn shield = 2.0s", PVP.spawnShieldSec === 2.0 && pvpSpawnShieldTicks() === 40);
  check("all-unsafe fallback shield = 3.0s",
    PVP.spawnFallbackShieldSec === 3.0 && pvpSpawnFallbackShieldTicks() === 60);
  check("death-within-spawn telemetry has an independent 3.0s threshold",
    PVP.deathWithinSpawnSec === 3.0 && pvpDeathWithinSpawnTicks() === 60);
  check("6p geometry proximity floor = 192px and LOS/aim range = 480px",
    PVP.spawnMinOpponentDist === 192 && PVP.spawnLosAimRange === 480);
  const tickZeroWorld = pvpWorld(1001, ["p1"]);
  const tickZeroPlayer = tickZeroWorld.players.get("p1")!;
  stepN(tickZeroWorld, 1, new Map());
  check("paused tick-zero protection preserves one shared 15/40 origin",
    tickZeroPlayer.spawnHardGraceEndsAtTick - tickZeroPlayer.spawnProtectionStartedTick === 15
    && tickZeroPlayer.spawnShieldEndsAtTick - tickZeroPlayer.spawnProtectionStartedTick === 40);
  check("player knockback constants are exact", PVP.kbScalar === 1.0 && PVP.kbMaxPerHit === 180 && PVP.kbSelfDuringIframe === 0);
  check("pit guardrail constants are exact", PVP.pitEdgeClearance === 200 && PVP.pitWarningBandTiles === 1);
  check("environmental credit window = 2.0s", PVP.envKillCreditWindowSec === 2.0);
  check("chain window = 5.0s", PVP.chainWindowSec === 5.0);
  check("mid-match draft defaults off for physics-only playtests", PVP.draftEnabled === false);
  check("draft cadence = 3 personal frags or 45s", PVP.draftEveryFrags === 3 && PVP.draftEverySec === 45);
  check("comeback tier bump = +1", PVP.comebackDraftTierBump === 1);
  check("sudden-death distance = 1 frag", PVP.suddenDeathFrags === 1);
  // pistol: 2 base * 1.78 (no outlier entry).
  check("pistol hit = base*dmgMult", Math.abs(pvpHitDamage("pistol", WEAPONS.pistol.damage) - WEAPONS.pistol.damage * PVP.dmgMult) < 1e-9);
  // outliers stack ON TOP of the global scalar.
  check("sawnoff outlier 0.45 stacks on the scalar", Math.abs(pvpHitDamage("sawnoff", WEAPONS.sawnoff.damage) - WEAPONS.sawnoff.damage * PVP.dmgMult * 0.45) < 1e-9);
  check("spear outlier 0.85 stacks on the scalar", Math.abs(pvpHitDamage("spear", WEAPONS.spear.damage) - WEAPONS.spear.damage * PVP.dmgMult * 0.85) < 1e-9);
  // Frag limit scales with the match-start player count: clamp(round(6+count), 8, 16).
  check("fragLimit scales 2->8,3->9,4->10,5->11,6->12", pvpFragLimit(2) === 8 && pvpFragLimit(3) === 9 && pvpFragLimit(4) === 10 && pvpFragLimit(5) === 11 && pvpFragLimit(6) === 12);
  check("fragLimit clamps to [8,16]", pvpFragLimit(1) === 8 && pvpFragLimit(20) === 16);
}

// ---------------------------------------------------------------------------------------------
section("DAMAGE TARGETING: owned round hits non-owner foe (attributed); co-op passes through");
{
  const w = pvpWorld(2, ["p1", "p2"]);
  advanceToLive(w);
  const shooter = w.players.get("p1")!;
  const victim = w.players.get("p2")!;
  const aim = faceOff(shooter, victim, 60);
  shooter.weapon = "pistol"; shooter.ownedWeapons = ["pistol"];
  const inputs = new Map([["p1", inp({ firing: true, aim })]]);
  const before = victim.hp;
  stepN(w, 8, inputs);
  check("pvp owned round damages a non-owner foe", victim.hp < before, `hp ${before}->${victim.hp}`);

  // Keep firing until a kill lands; assert the frag is attributed to the shooter via `by`.
  let guard = 0;
  while ((w.match!.scores.get("p1") ?? 0) < 1 && guard++ < 400) stepN(w, 1, inputs);
  check("kill attributed to `by` (bullet.owner) in the scoreboard", (w.match!.scores.get("p1") ?? 0) === 1);
  check("victim was killed, not merely hurt (respawn scheduled)", victim.respawnT > 0 || victim.hp === PVP.maxHp);

  // Co-op: a friendly round passes through a teammate harmlessly (no player damage path).
  const coop = createWorld(2, 1, { isShared: true, skipLocalPlayer: true });
  spawnPlayerInWorld(coop, "c1"); spawnPlayerInWorld(coop, "c2");
  const cs = coop.players.get("c1")!; const cv = coop.players.get("c2")!;
  const caim = faceOff(cs, cv, 60);
  cs.weapon = "pistol"; cs.ownedWeapons = ["pistol"];
  stepN(coop, 20, new Map([["c1", inp({ firing: true, aim: caim })]]));
  check("co-op friendly fire is harmless (no player-vs-player damage)", cv.hp === cv.maxHp, `hp=${cv.hp}`);
}

// ---------------------------------------------------------------------------------------------
section("NO-SNOWBALL: a kill grants the killer ZERO in-match power");
{
  const w = pvpWorld(3, ["p1", "p2"]);
  advanceToLive(w);
  const shooter = w.players.get("p1")!;
  const victim = w.players.get("p2")!;
  const aim = faceOff(shooter, victim, 60);
  shooter.weapon = "pistol"; shooter.ownedWeapons = ["pistol"];
  // Give the shooter a kit + full meter to PROVE none of it activates in pvp.
  shooter.kitId = "gunner";
  shooter.ultCharge = ULT.meterMax;
  const hpBefore = shooter.hp;
  const inputs = new Map([["p1", inp({ firing: true, aim, ult: true })]]);
  let guard = 0;
  while ((w.match!.scores.get("p1") ?? 0) < 1 && guard++ < 400) stepN(w, 1, inputs);
  check("no lifesteal/kill-heal on a pvp kill", shooter.hp <= hpBefore, `hp ${hpBefore}->${shooter.hp}`);
  check("no combo accrues in pvp", shooter.combo === 0);
  check("no gunner momentum accrues in pvp", shooter.passiveState === 0);
  check("ult never fires in pvp (no overdrive granted)", shooter.overdriveT === 0);
  check("ult meter never resets from a cast (updateUlts is gated off)", shooter.ultCharge === ULT.meterMax);
}

// ---------------------------------------------------------------------------------------------
section("ult meter does not charge in pvp");
{
  const w = pvpWorld(4, ["p1", "p2"]);
  advanceToLive(w);
  const p1 = w.players.get("p1")!;
  p1.kitId = "gunner"; // a real kit — its charge loop must STILL be inert in pvp
  p1.ultCharge = 0;
  stepN(w, 120, new Map());
  check("ult charge stays 0 across sustained pvp time", p1.ultCharge === 0);
}

// ---------------------------------------------------------------------------------------------
section("CHAIN FRAGS: deterministic juice with zero stat reward");
{
  const w = pvpWorld(65, ["p1", "p2"]);
  advanceToLive(w);
  const killer = w.players.get("p1")!;
  const victim = w.players.get("p2")!;
  killer.weapon = "railgun";
  killer.ownedWeapons = ["railgun"];
  const statsBefore = JSON.stringify({
    hp: killer.hp,
    maxHp: killer.maxHp,
    mods: killer.mods,
    weapon: killer.weapon,
    weapons: killer.ownedWeapons,
    ult: killer.ultCharge,
    combo: killer.combo,
  });
  const fragOnce = (): SimEvent[] => {
    w.bullets = [];
    killer.fireCd = 0;
    victim.hp = 1;
    victim.respawnT = 0;
    victim.invuln = 0;
    const aim = faceOff(killer, victim, 36);
    const events: SimEvent[] = [];
    let guard = 0;
    while (victim.respawnT === 0 && guard++ < 20) {
      events.push(...stepCollect(w, 1, new Map([["p1", inp({ firing: true, aim })]])));
    }
    return events;
  };
  const first = fragOnce();
  const second = fragOnce();
  check("first frag is not a chain", !first.some((event) => event.t === "pvpChainFrag"));
  const chain = second.find((event) => event.t === "pvpChainFrag");
  check("second frag inside 5.0s emits a chain callout event",
    chain?.t === "pvpChainFrag" && chain.by === "p1" && chain.chain === 2);
  const statsAfter = JSON.stringify({
    hp: killer.hp,
    maxHp: killer.maxHp,
    mods: killer.mods,
    weapon: killer.weapon,
    weapons: killer.ownedWeapons,
    ult: killer.ultCharge,
    combo: killer.combo,
  });
  check("chain frag grants zero stat or power reward", statsAfter === statsBefore);
  check("chain timing uses the exact 5.0s tick window", pvpChainWindowTicks() === 100);
}

// ---------------------------------------------------------------------------------------------
section("MID-MATCH DRAFT: safe pool, cadence, deterministic offers, comeback bump");
{
  const disabledWorld = pvpWorld(650, ["p1", "p2"]);
  advanceToLive(disabledWorld);
  for (const player of disabledWorld.players.values()) {
    player.pvpDraftFrags = PVP.draftEveryFrags;
    player.pvpNextDraftTick = disabledWorld.tick;
  }
  const disabledEvents = stepCollect(disabledWorld, 1, new Map());
  check("default-off draft emits no offers even when both cadences are due",
    !disabledEvents.some((event) => event.t === "offerBlessing")
    && disabledWorld.pendingBlessings.size === 0);

  const isDraftPreviouslyEnabled = PVP.draftEnabled;
  PVP.draftEnabled = true;
  check("every named PvP-blacklisted blessing is rejected",
    pvpBlessingBlacklist.every((id) => !isPvpBlessingId(id)));
  const rolledIds = new Set<string>();
  for (let seed = 0; seed < 512; seed++) {
    const rng = new Rng(seed);
    for (const item of rollPvpDraftChoicesWith(PVP.draftChoices, () => rng.next())) rolledIds.add(item.id);
  }
  check("the deterministic PvP offer pool never rolls a blacklisted id",
    pvpBlessingBlacklist.every((id) => !rolledIds.has(id)));
  check("the four shipped cores are legal PvP identity picks",
    ["core_damage", "core_fire", "core_move", "core_dash"].every((id) => rolledIds.has(id)));

  let isPoolSafe = true;
  for (const id of PVP.blessingPool) {
    const mods = createMods();
    recomputeMods(mods, [id]);
    if (mods.lifestealChance > 0 || mods.adrenaline > 0 || mods.berserk > 0
      || mods.maxHpBonus > 0 || mods.coinMult > 1 || mods.coinMagnet > 0) {
      isPoolSafe = false;
    }
  }
  check("PvP draft pool has no self-heal, low-HP, economy, or flat-EHP gain", isPoolSafe);

  const offerIds = (seed: number, pid: string, tick: number, ordinal: number, tierBump: number): string[] => {
    const rng = new Rng(pvpDraftSeed(seed, pid, tick, ordinal));
    return rollPvpDraftChoicesWith(
      PVP.draftChoices,
      () => rng.next(),
      [],
      { tierBump },
    ).map((item) => item.id);
  };
  const deterministicA = offerIds(12345, "p2", 900, 1, 1);
  const deterministicB = offerIds(12345, "p2", 900, 1, 1);
  check("draft offers are deterministic from seed + player + trigger tick + ordinal",
    deterministicA.join(",") === deterministicB.join(","));

  const scores = new Map([["p1", 6], ["p2", 3], ["p3", 1]]);
  check("only the bottom third receives the +1 comeback draft tier bump",
    pvpComebackTierBump(scores, ["p1", "p2", "p3"], "p3") === 1
    && pvpComebackTierBump(scores, ["p1", "p2", "p3"], "p1") === 0
    && pvpComebackTierBump(scores, ["p1", "p2", "p3"], "p2") === 0);
  let normalRare = 0;
  let comebackRare = 0;
  for (let seed = 0; seed < 512; seed++) {
    const normalRng = new Rng(seed);
    const comebackRng = new Rng(seed);
    normalRare += rollPvpDraftChoicesWith(3, () => normalRng.next(), [], { tierBump: 0 })
      .filter((item) => item.rarity === "rare").length;
    comebackRare += rollPvpDraftChoicesWith(3, () => comebackRng.next(), [], { tierBump: 1 })
      .filter((item) => item.rarity === "rare").length;
  }
  check("the comeback bump makes offers hotter without changing combat stats",
    comebackRare > normalRare,
    `rare ${normalRare}->${comebackRare}`);

  const timeWorld = pvpWorld(66, ["p1", "p2"]);
  advanceToLive(timeWorld);
  const timedEvents = stepCollect(timeWorld, pvpDraftEveryTicks() + 1, new Map());
  const timedOffers = timedEvents.filter((event) => event.t === "offerBlessing");
  check("45 authoritative seconds raises one personal offer per player",
    timedOffers.length === 2
    && timedOffers.some((event) => event.t === "offerBlessing" && event.pid === "p1")
    && timedOffers.some((event) => event.t === "offerBlessing" && event.pid === "p2"));

  const fragWorld = pvpWorld(67, ["p1", "p2"]);
  advanceToLive(fragWorld);
  const fragKiller = fragWorld.players.get("p1")!;
  const fragVictim = fragWorld.players.get("p2")!;
  fragKiller.weapon = "railgun";
  fragKiller.ownedWeapons = ["railgun"];
  fragKiller.pvpDraftFrags = PVP.draftEveryFrags - 1;
  fragVictim.hp = 1;
  fragVictim.invuln = 0;
  const fragAim = faceOff(fragKiller, fragVictim, 36);
  let fragEvents: SimEvent[] = [];
  let guard = 0;
  while (!fragEvents.some((event) => event.t === "offerBlessing") && guard++ < 20) {
    fragEvents = fragEvents.concat(stepCollect(fragWorld, 1, new Map([["p1", inp({ firing: true, aim: fragAim })]])));
  }
  check("third personal frag raises that player's draft before the clock",
    fragEvents.some((event) => event.t === "offerBlessing" && event.pid === "p1")
    && !fragEvents.some((event) => event.t === "offerBlessing" && event.pid === "p2"));
  PVP.draftEnabled = isDraftPreviouslyEnabled;
}

// ---------------------------------------------------------------------------------------------
section("SPAWNS: symmetric 19x19 arena + pits + spread + break-on-fire protection");
{
  const { dungeon, spawns, cover, pits, pitWarnings, centerPickup, forcedChokepoints } = buildPvpArena();
  check("arena is the authoritative 19x19 square", dungeon.w === 19 && dungeon.h === 19);
  check("arena has 8 spawn candidates (full FFA)", spawns.length === 8, `${spawns.length}`);
  check("arena restores all 16 breakable cover pieces", cover.length === 16, `${cover.length}`);
  check("arena has the 16 authoritative perimeter pit tiles", pits.length === 16, `${pits.length}`);
  check("eight two-tile pockets have unobstructed one-tile warning bands", pitWarnings.length === 80, `${pitWarnings.length}`);
  check("warning-band geometry is derived from the authoritative lethal tiles",
    pitWarnings.every((warning) =>
      isPvpPitWarningTile(dungeon, Math.floor(warning.x / TILE), Math.floor(warning.y / TILE))
    ));
  check("spawns are all distinct (maximally spread)", new Set(spawns.map((s) => `${s.x},${s.y}`)).size === spawns.length);

  // 4-fold rotational symmetry (provably fair): the wall grid, the spawn set, and the cover set
  // are each invariant under a 90 degree rotation.
  const key = (p: Vec2) => `${Math.round(p.x)},${Math.round(p.y)}`;
  const spawnSet = new Set(spawns.map(key));
  const coverSet = new Set(cover.map(key));
  const pitSet = new Set(pits.map(key));
  const warningSet = new Set(pitWarnings.map(key));
  const expectedPitTiles = new Set([
    "6,2", "6,3", "12,2", "12,3",
    "2,6", "3,6", "2,12", "3,12",
    "6,15", "6,16", "12,15", "12,16",
    "15,6", "16,6", "15,12", "16,12",
  ]);
  const actualPitTiles = new Set(pits.map((pit) =>
    `${Math.floor(pit.x / TILE)},${Math.floor(pit.y / TILE)}`
  ));
  check("PIT_TILES matches the game designer's table verbatim",
    actualPitTiles.size === expectedPitTiles.size
    && [...expectedPitTiles].every((pit) => actualPitTiles.has(pit)));
  const spawnsSymmetric = spawns.every((s) => spawnSet.has(key(pvpArenaRot90(s))));
  const coverSymmetric = cover.every((c) => coverSet.has(key(pvpArenaRot90(c))));
  const pitsSymmetric = pits.every((pit) => pitSet.has(key(pvpArenaRot90(pit))));
  const warningsSymmetric = pitWarnings.every((warning) => warningSet.has(key(pvpArenaRot90(warning))));
  check("spawns are invariant under 90 rotation", spawnsSymmetric);
  check("cover is invariant under 90 rotation", coverSymmetric);
  check("pits are invariant under 90 rotation", pitsSymmetric);
  check("pit warning bands are invariant under 90 rotation", warningsSymmetric);
  check("pits are disjoint from every spawn", pits.every((pit) => !spawnSet.has(key(pit))));
  check("pits are disjoint from cover and center",
    pits.every((pit) => !coverSet.has(key(pit)) && key(pit) !== key(centerPickup)));
  const clipWalls = new Set([
    "0,0", "1,0", "0,1", "17,0", "18,0", "18,1",
    "0,17", "0,18", "1,18", "18,17", "17,18", "18,18",
  ]);
  check("pits are disjoint from every clipped-corner wall",
    [...actualPitTiles].every((pit) => !clipWalls.has(pit)));
  check("warning bands are disjoint from spawns and cover",
    pitWarnings.every((warning) => !spawnSet.has(key(warning)) && !coverSet.has(key(warning))));
  check("every warning tile is exactly one tile from a lethal tile",
    pitWarnings.every((warning) =>
      pits.some((pit) => Math.max(Math.abs(warning.x - pit.x), Math.abs(warning.y - pit.y)) === TILE)
    ));
  const minSpawnChebyshev = Math.min(...pits.flatMap((pit) =>
    spawns.map((spawn) => Math.max(Math.abs(pit.x - spawn.x), Math.abs(pit.y - spawn.y)) / TILE)
  ));
  check("every pit is at least three Chebyshev tiles from every spawn",
    minSpawnChebyshev >= 3,
    `min=${minSpawnChebyshev.toFixed(2)} tiles`);
  const protectedPoints = [...spawns, centerPickup, ...forcedChokepoints];
  const minPitClearance = Math.min(...pits.flatMap((pit) =>
    protectedPoints.map((point) => pvpPitEdgeDistance(point, pit))
  ));
  check("designer layout records the live-gate delta from the 200px target",
    minPitClearance < PVP.pitEdgeClearance,
    `edge=${minPitClearance.toFixed(2)}px target=${PVP.pitEdgeClearance}px`);
  const minSpawnPitDistance = Math.min(...spawns.map((spawn) => pvpNearestPitEdgeDistance(spawn, pits)));
  check("no spawn candidate lies within one dash of a pit edge",
    minSpawnPitDistance > pvpSingleDashDistance(),
    `pit=${minSpawnPitDistance.toFixed(2)}px dash=${pvpSingleDashDistance().toFixed(2)}px`);
  let wallsSymmetric = true;
  for (let ty = 0; ty < dungeon.h; ty++) {
    for (let tx = 0; tx < dungeon.w; tx++) {
      const wall = dungeon.tiles[ty * dungeon.w + tx] === 1;
      const rot = pvpArenaRot90({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 });
      const rtx = Math.floor(rot.x / TILE), rty = Math.floor(rot.y / TILE);
      if ((dungeon.tiles[rty * dungeon.w + rtx] === 1) !== wall) wallsSymmetric = false;
    }
  }
  check("walls are invariant under 90 rotation (clipped corners + border)", wallsSymmetric);
  check("arena center is open", dungeon.tiles[9 * dungeon.w + 9] === 0);

  // HARD RULE (flankable cover): no cover piece is a wall you can fully hide behind — every
  // orthogonally-contiguous cover cluster is small (<= 2 props), so a foe can always come from
  // another angle. Keeps it a duel, not a camp.
  const coverKeys = new Set(cover.map((c) => `${Math.round((c.x - TILE / 2) / TILE)},${Math.round((c.y - TILE / 2) / TILE)}`));
  const seen = new Set<string>();
  let maxCluster = 0;
  for (const start of coverKeys) {
    if (seen.has(start)) continue;
    let size = 0;
    const stack = [start];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur); size++;
      const [cx, cy] = cur.split(",").map(Number);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nk = `${cx + dx},${cy + dy}`;
        if (coverKeys.has(nk) && !seen.has(nk)) stack.push(nk);
      }
    }
    maxCluster = Math.max(maxCluster, size);
  }
  check("cover is small + flankable (no cluster > 2 props to hide behind)", maxCluster <= 2, `maxCluster=${maxCluster}`);

  // Hard grace preserves control but suppresses every outgoing attack before entity creation.
  const w = pvpWorld(5, ["p1", "p2"]);
  advanceToLive(w);
  const p1 = w.players.get("p1")!;
  p1.x = 300;
  p1.y = 216;
  p1.spawnGraceT = pvpSpawnHardGraceTicks();
  p1.spawnShieldT = pvpSpawnShieldTicks();
  const protectedStartX = p1.x;
  const protectedShotSeq = p1.shotSeq;
  const graceEvents = stepCollect(
    w,
    pvpSpawnHardGraceTicks(),
    new Map([["p1", inp({ moveX: 1, aim: Math.PI / 2, firing: true, dash: true })]]),
  );
  check("hard grace grants move, aim, and dash control",
    p1.x > protectedStartX && p1.aimAngle === Math.PI / 2
    && graceEvents.some((event) => event.t === "dashStart"));
  check("hard grace suppresses bullets, effects, melee, and shot events",
    p1.shotSeq === protectedShotSeq
    && w.bullets.every((bullet) => bullet.owner !== "p1")
    && w.effects.every((effect) => effect.owner !== "p1")
    && !graceEvents.some((event) =>
      event.t === "shot" || event.t === "wirePlanted" || event.t === "haloFlare"
      || event.t === "sentryPlaced" || event.t === "tetherLatch"
    ));
  check("suppressed held offense emits one rate-limited arming pulse without dry-fire",
    graceEvents.filter((event) => event.t === "pvpSpawnAttackBlocked").length === 1);
  check("hard grace lasts exactly 15 authoritative ticks", p1.spawnGraceT === 0 && p1.spawnShieldT === 25);
  check("hard grace is nested inside one 2.0s shield from the same spawn origin",
    p1.spawnHardGraceEndsAtTick - p1.spawnProtectionStartedTick === 15
    && p1.spawnShieldEndsAtTick - p1.spawnProtectionStartedTick === 40);
  const heldAfterGrace = stepCollect(w, 1, new Map([["p1", inp({ firing: true, aim: 0 })]]));
  check("held fire does not auto-fire when hard grace ends",
    p1.shotSeq === protectedShotSeq
    && p1.spawnShieldT > 0
    && !heldAfterGrace.some((event) => event.t === "shot"));
  stepN(w, 1, new Map([["p1", inp({ firing: false, aim: 0 })]]));
  const legalAttack = stepCollect(w, 1, new Map([["p1", inp({ firing: true, aim: 0 })]]));
  const shieldBreakIndex = legalAttack.findIndex((event) => event.t === "pvpShieldBreak");
  const shotIndex = legalAttack.findIndex((event) => event.t === "shot");
  check("the first legal attack after grace spawns and breaks the remaining shield",
    p1.spawnShieldT === 0 && shotIndex >= 0);
  check("shield shatter is authoritative and ordered before the muzzle event",
    shieldBreakIndex >= 0 && shieldBreakIndex < shotIndex);
  const afterBreakEvents = stepCollect(w, 1, new Map([["p1", inp({ firing: true, aim: 0 })]]));
  check("the broken shield stays broken and cannot shatter twice",
    p1.spawnShieldT === 0 && !afterBreakEvents.some((event) => event.t === "pvpShieldBreak"));

  const refusedWorld = pvpWorld(501, ["p1", "p2"]);
  advanceToLive(refusedWorld);
  const refused = refusedWorld.players.get("p1")!;
  refused.x = TILE + 2;
  refused.y = 216;
  refused.weapon = "snapwire";
  refused.ownedWeapons = ["snapwire"];
  refused.spawnGraceT = 0;
  refused.spawnShieldT = pvpSpawnShieldTicks();
  const refusedEvents = stepCollect(
    refusedWorld,
    1,
    new Map([["p1", inp({ firing: true, aim: Math.PI })]]),
  );
  check("a refused deploy is not legal offense and keeps the spawn shield",
    refused.spawnShieldT > 0
    && refusedEvents.some((event) => event.t === "wireRefused")
    && !refusedEvents.some((event) => event.t === "pvpShieldBreak"));

  // Spawn protection blocks incoming damage and knockback, then expires without extension.
  const w2 = pvpWorld(6, ["p1", "p2"]);
  advanceToLive(w2);
  const s2 = w2.players.get("p1")!; const v2 = w2.players.get("p2")!;
  const aim2 = faceOff(s2, v2, 60);
  v2.spawnGraceT = pvpSpawnHardGraceTicks();
  v2.spawnShieldT = pvpSpawnShieldTicks();
  s2.weapon = "pistol"; s2.ownedWeapons = ["pistol"];
  const protectedX = v2.x;
  stepN(w2, pvpSpawnShieldTicks() - 1, new Map([["p1", inp({ firing: true, aim: aim2 })]]));
  check("incoming attacks deal zero damage and knockback through tick 59",
    v2.hp === PVP.maxHp && v2.x === protectedX && v2.spawnShieldT === 1,
    `hp=${v2.hp} shield=${v2.spawnShieldT}`);
  w2.bullets = [{
    x: v2.x,
    y: v2.y,
    vx: 0,
    vy: 0,
    radius: 4,
    life: 1,
    friendly: true,
    owner: s2.id,
    damage: WEAPONS.pistol.damage,
    color: "#fff",
    pierce: 0,
    hitList: null,
    isCrit: false,
    fx: "pistol",
  }];
  stepN(w2, 1, new Map([["p1", inp({ firing: true, aim: aim2 })]]));
  check("natural 2.0s expiry clears before same-tick hit resolution",
    v2.spawnShieldT === 0 && v2.hp < PVP.maxHp,
    `hp=${v2.hp} shield=${v2.spawnShieldT}`);

  // farthestSpawnIndex is deterministic and avoids an occupied spawn.
  const occupied = [spawns[0]];
  const idx = farthestSpawnIndex(spawns, occupied, pits);
  check("respawn picks a spawn away from occupants", idx !== 0);
  const safestPitDistance = Math.max(...spawns.map((spawn) => pvpNearestPitEdgeDistance(spawn, pits)));
  const pitWeightedStart = farthestSpawnIndex(spawns, [], pits);
  const pitCandidates: PvpRespawnCandidate[] = spawns.map((spawn, index) => {
    const pitDistance = pvpNearestPitEdgeDistance(spawn, pits);
    return {
      index,
      minOpponentDistance: 0,
      pitDistance,
      losThreatCount: 0,
      isAimedAt: false,
      incomingThreatEtaSec: null,
      predictedIncomingDamage: 0,
      isCoveredFromNearest: false,
      isInwardExitWalkable: true,
      isCamped: false,
      isPitEligible: pitDistance > pvpSingleDashDistance(),
    };
  });
  const pitWeightedRespawn = pvpRespawnIndex(pitCandidates);
  check("opening and respawn selection weight equally open choices away from pits",
    pvpNearestPitEdgeDistance(spawns[pitWeightedStart], pits) === safestPitDistance
    && pvpNearestPitEdgeDistance(spawns[pitWeightedRespawn], pits) === safestPitDistance);

  // Authoritative N-most-spread selection at match start (greedy, id-sorted). The tile a player
  // sits on is a spawn center: tile = round(worldX/TILE - 0.5). EDGE_MIDS are the 4 @2/3-R spawns;
  // anything else is a diagonal. Two tiles are "opposite" iff one is the rot180 of the other.
  const EDGE_MIDS = new Set(["9,3", "3,9", "9,15", "15,9"]);
  const startTiles = (n: number): string[] => {
    const w = pvpWorld(7, Array.from({ length: n }, (_, i) => `p${i + 1}`));
    advanceToLive(w);
    return [...w.players.values()].map((p) => `${Math.round(p.x / TILE - 0.5)},${Math.round(p.y / TILE - 0.5)}`);
  };
  const isOpposite = (a: string, b: string): boolean => {
    const [ax, ay] = a.split(",").map(Number);
    const [bx, by] = b.split(",").map(Number);
    return bx === 18 - ax && by === 18 - ay;
  };
  // 2 players -> two OPPOSITE edge-mids.
  const t2 = startTiles(2);
  check("2p spawns on two opposite edge-mids", t2.length === 2 && t2.every((t) => EDGE_MIDS.has(t)) && isOpposite(t2[0], t2[1]), t2.join(" "));
  // 4 players -> ALL four edge-mids.
  const t4 = startTiles(4);
  check("4p spawns on all four edge-mids", new Set(t4).size === 4 && t4.every((t) => EDGE_MIDS.has(t)), t4.join(" "));
  // 6 players -> four edge-mids + two OPPOSITE diagonals (max spread, not two adjacent ones).
  const t6 = startTiles(6);
  const diag6 = t6.filter((t) => !EDGE_MIDS.has(t));
  check("6p spawns on all four edge-mids + two diagonals", EDGE_MIDS.size === 4 && [...EDGE_MIDS].every((e) => t6.includes(e)) && diag6.length === 2, t6.join(" "));
  check("6p diagonals are point-opposite (max spread)", diag6.length === 2 && isOpposite(diag6[0], diag6[1]), diag6.join(" "));

  const inwardWorld = pvpWorld(71, ["p1", "p2", "p3", "p4"]);
  advanceToLive(inwardWorld);
  const center = {
    x: inwardWorld.dungeon.spawn.x * TILE + TILE / 2,
    y: inwardWorld.dungeon.spawn.y * TILE + TILE / 2,
  };
  check("every fresh spawn faces inward, away from the perimeter pockets",
    [...inwardWorld.players.values()].every((player) => {
      const dx = center.x - player.x;
      const dy = center.y - player.y;
      const length = Math.hypot(dx, dy) || 1;
      return (Math.cos(player.aimAngle) * dx + Math.sin(player.aimAngle) * dy) / length > 0.999;
    }));
  const inwardPlayer = inwardWorld.players.get("p1")!;
  const inwardBefore = Math.hypot(inwardPlayer.x - center.x, inwardPlayer.y - center.y);
  stepN(inwardWorld, 1, new Map([[
    "p1",
    inp({ moveX: Math.cos(inwardPlayer.aimAngle), moveY: Math.sin(inwardPlayer.aimAngle) }),
  ]]));
  check("walking forward from spawn moves toward center without entering a pit",
    Math.hypot(inwardPlayer.x - center.x, inwardPlayer.y - center.y) < inwardBefore
    && inwardPlayer.respawnT === 0);
}

// ---------------------------------------------------------------------------------------------
section("PLAYER KNOCKBACK: weapon impulse, hard clamp, and spawn-shield immunity");
{
  const w = pvpWorld(60, ["p1", "p2"]);
  advanceToLive(w);
  const shooter = w.players.get("p1")!;
  const victim = w.players.get("p2")!;
  const aim = faceOff(shooter, victim, 60);
  shooter.weapon = "pistol";
  shooter.ownedWeapons = ["pistol"];
  const startX = victim.x;
  let guard = 0;
  while (victim.hp === PVP.maxHp && guard++ < 20) {
    stepN(w, 1, new Map([["p1", inp({ firing: true, aim })]]));
  }
  const displacement = Math.hypot(victim.x - startX, victim.y - 216);
  check("a PvP hit applies the shipped per-weapon player impulse",
    Math.abs(displacement - WEAPON_KB.pistol * PVP.kbScalar) < 1e-9,
    `kb=${displacement.toFixed(2)}`);
  check("no PvP hit displaces a player past the 180px hard clamp",
    displacement <= PVP.kbMaxPerHit,
    `kb=${displacement.toFixed(2)}`);

  const originalKbScalar = PVP.kbScalar;
  let clampedDisplacement = Infinity;
  try {
    PVP.kbScalar = 100;
    const clampWorld = pvpWorld(601, ["p1", "p2"]);
    advanceToLive(clampWorld);
    const clampShooter = clampWorld.players.get("p1")!;
    const clampVictim = clampWorld.players.get("p2")!;
    const clampAim = faceOff(clampShooter, clampVictim, 60);
    clampShooter.weapon = "railgun";
    clampShooter.ownedWeapons = ["railgun"];
    const clampStartX = clampVictim.x;
    let clampGuard = 0;
    while (clampVictim.hp === PVP.maxHp && clampGuard++ < 20) {
      stepN(clampWorld, 1, new Map([["p1", inp({ firing: true, aim: clampAim })]]));
    }
    clampedDisplacement = Math.hypot(clampVictim.x - clampStartX, clampVictim.y - 216);
  } finally {
    PVP.kbScalar = originalKbScalar;
  }
  check("an over-limit real hit is clamped to exactly 180px",
    Math.abs(clampedDisplacement - PVP.kbMaxPerHit) < 1e-9,
    `kb=${clampedDisplacement.toFixed(2)}`);

  const guardrailWorld = pvpWorld(602, ["p1", "p2"]);
  advanceToLive(guardrailWorld);
  const guardrailShooter = guardrailWorld.players.get("p1")!;
  const guardrailVictim = guardrailWorld.players.get("p2")!;
  const guardrailPit = buildPvpArena().pits[0];
  guardrailVictim.x = guardrailPit.x + TILE / 2 + PVP.pitEdgeClearance;
  guardrailVictim.y = guardrailPit.y;
  guardrailVictim.invuln = 0;
  guardrailShooter.x = guardrailVictim.x + 100;
  guardrailShooter.y = guardrailVictim.y;
  guardrailShooter.invuln = 0;
  guardrailShooter.weapon = "railgun";
  guardrailShooter.ownedWeapons = ["railgun"];
  const guardrailStart = { x: guardrailVictim.x, y: guardrailVictim.y };
  const guardrailEvents: SimEvent[] = [];
  PVP.kbScalar = 100;
  try {
    let guardrailTicks = 0;
    while (guardrailVictim.hp === PVP.maxHp && guardrailTicks++ < 20) {
      guardrailEvents.push(...stepCollect(
        guardrailWorld,
        1,
        new Map([["p1", inp({ firing: true, aim: Math.PI })]]),
      ));
    }
  } finally {
    PVP.kbScalar = originalKbScalar;
  }
  const guardedKnockback = Math.hypot(
    guardrailVictim.x - guardrailStart.x,
    guardrailVictim.y - guardrailStart.y,
  );
  check("a max-clamped hit cannot ring out a player standing 200px from the pit edge",
    pvpPitEdgeDistance(guardrailStart, guardrailPit) >= PVP.pitEdgeClearance
    && guardedKnockback <= PVP.kbMaxPerHit + 1e-9
    && guardrailVictim.respawnT === 0
    && !guardrailEvents.some((event) => event.t === "pvpRingOut"),
    `clearance=${pvpPitEdgeDistance(guardrailStart, guardrailPit).toFixed(2)} kb=${guardedKnockback.toFixed(2)}`);

  const protectedWorld = pvpWorld(61, ["p1", "p2"]);
  advanceToLive(protectedWorld);
  const protectedShooter = protectedWorld.players.get("p1")!;
  const protectedVictim = protectedWorld.players.get("p2")!;
  const protectedAim = faceOff(protectedShooter, protectedVictim, 60);
  protectedShooter.weapon = "railgun";
  protectedShooter.ownedWeapons = ["railgun"];
  protectedVictim.spawnGraceT = pvpSpawnHardGraceTicks();
  protectedVictim.spawnShieldT = pvpSpawnShieldTicks();
  const protectedX = protectedVictim.x;
  const protectedY = protectedVictim.y;
  stepN(protectedWorld, 12, new Map([["p1", inp({ firing: true, aim: protectedAim })]]));
  check("spawn-shielded player takes zero knockback",
    protectedVictim.x === protectedX && protectedVictim.y === protectedY);
}

// ---------------------------------------------------------------------------------------------
section("PIT WARNING BAND: fastest drafted movement can dash clear");
{
  const arena = buildPvpArena();
  const warningWorld = pvpWorld(603, ["p1", "p2"]);
  advanceToLive(warningWorld);
  const dasher = warningWorld.players.get("p1")!;
  const pit = arena.pits[0];
  dasher.x = pit.x + TILE;
  dasher.y = pit.y;
  dasher.invuln = 0;
  recomputeMods(dasher.mods, [
    "swift_boots", "swift_boots", "swift_boots",
    "core_move", "core_move", "core_move",
    "featherweight", "featherweight", "featherweight",
    "core_dash",
  ]);
  const start = { x: dasher.x, y: dasher.y };
  let ticks = 0;
  do {
    stepN(warningWorld, 1, new Map([["p1", inp({ moveX: 1, dash: ticks === 0 })]]));
    ticks++;
  } while (dasher.dashTime > 0 && ticks < 10);
  const dashDistance = Math.hypot(dasher.x - start.x, dasher.y - start.y);
  const warningWidth = PVP.pitWarningBandTiles * TILE;
  check("dash-clear test runs at the maximum drafted move-speed cap",
    dasher.mods.moveSpeedMult === CAPS.moveSpeedMult,
    `move=${dasher.mods.moveSpeedMult.toFixed(2)}`);
  check("one warning tile is no wider than the authored single-dash distance",
    warningWidth <= pvpSingleDashDistance()
    && pvpSingleDashDistance() === PLAYER.dashSpeed * PLAYER.dashActive,
    `warning=${warningWidth}px dash=${pvpSingleDashDistance().toFixed(2)}px`);
  check("a player on the warning band can dash away without ringing out",
    dashDistance >= warningWidth
    && pvpNearestPitEdgeDistance(dasher, arena.pits) > warningWidth
    && dasher.respawnT === 0,
    `moved=${dashDistance.toFixed(2)}px edge=${pvpNearestPitEdgeDistance(dasher, arena.pits).toFixed(2)}px`);
}

// ---------------------------------------------------------------------------------------------
section("LETHAL PITS: ring-out, bounded credit, and spawn-shield safety");
{
  const pit = buildPvpArena().pits[0];

  const credited = pvpWorld(62, ["p1", "p2"]);
  advanceToLive(credited);
  const attacker = credited.players.get("p1")!;
  const victim = credited.players.get("p2")!;
  const aim = faceOff(attacker, victim, 60);
  attacker.weapon = "pistol";
  attacker.ownedWeapons = ["pistol"];
  let guard = 0;
  while (victim.lastPvpHitBy === null && guard++ < 20) {
    stepN(credited, 1, new Map([["p1", inp({ firing: true, aim })]]));
  }
  credited.bullets = [];
  victim.x = pit.x;
  victim.y = pit.y;
  const creditedEvents = stepCollect(credited, 1, new Map());
  const creditedRingOut = creditedEvents.find((event) => event.t === "pvpRingOut");
  check("pit within the 2.0s damage window credits the last attacker",
    creditedRingOut?.t === "pvpRingOut"
    && creditedRingOut.by === "p1"
    && (credited.match!.scores.get("p1") ?? 0) === 1);

  const sourceWorld = pvpWorld(621, ["p1", "p2", "p3"]);
  advanceToLive(sourceWorld);
  const knockbackSource = sourceWorld.players.get("p1")!;
  const sourceVictim = sourceWorld.players.get("p2")!;
  const laterDamager = sourceWorld.players.get("p3")!;
  const sourceAim = faceOff(knockbackSource, sourceVictim, 60);
  knockbackSource.weapon = "pistol";
  knockbackSource.ownedWeapons = ["pistol"];
  guard = 0;
  while (sourceVictim.lastPvpKnockbackBy === null && guard++ < 20) {
    stepN(sourceWorld, 1, new Map([["p1", inp({ firing: true, aim: sourceAim })]]));
  }
  sourceWorld.bullets = [];
  laterDamager.x = sourceVictim.x + 60;
  laterDamager.y = sourceVictim.y;
  laterDamager.invuln = 0;
  laterDamager.weapon = "pistol";
  laterDamager.ownedWeapons = ["pistol"];
  const sourceKbScalar = PVP.kbScalar;
  PVP.kbScalar = 0;
  try {
    guard = 0;
    while (sourceVictim.lastPvpHitBy !== "p3" && guard++ < 20) {
      stepN(sourceWorld, 1, new Map([["p3", inp({ firing: true, aim: Math.PI })]]));
    }
  } finally {
    PVP.kbScalar = sourceKbScalar;
  }
  sourceWorld.bullets = [];
  const lastHitBeforeFall = sourceVictim.lastPvpHitBy;
  const lastKnockbackBeforeFall = sourceVictim.lastPvpKnockbackBy;
  sourceVictim.x = pit.x;
  sourceVictim.y = pit.y;
  const sourceEvents = stepCollect(sourceWorld, 1, new Map());
  const sourceRingOut = sourceEvents.find((event) => event.t === "pvpRingOut");
  check("pit attribution follows the last knockback source, not a later zero-KB hit",
    lastHitBeforeFall === "p3"
    && lastKnockbackBeforeFall === "p1"
    && sourceRingOut?.t === "pvpRingOut"
    && sourceRingOut.by === "p1"
    && (sourceWorld.match!.scores.get("p1") ?? 0) === 1
    && (sourceWorld.match!.scores.get("p3") ?? 0) === 0);

  const expired = pvpWorld(63, ["p1", "p2"]);
  advanceToLive(expired);
  const oldAttacker = expired.players.get("p1")!;
  const oldVictim = expired.players.get("p2")!;
  const oldAim = faceOff(oldAttacker, oldVictim, 60);
  oldAttacker.weapon = "pistol";
  oldAttacker.ownedWeapons = ["pistol"];
  guard = 0;
  while (oldVictim.lastPvpHitBy === null && guard++ < 20) {
    stepN(expired, 1, new Map([["p1", inp({ firing: true, aim: oldAim })]]));
  }
  expired.bullets = [];
  stepN(expired, pvpEnvKillCreditWindowTicks() + 1, new Map());
  oldVictim.x = pit.x;
  oldVictim.y = pit.y;
  const expiredEvents = stepCollect(expired, 1, new Map());
  const neutralRingOut = expiredEvents.find((event) => event.t === "pvpRingOut");
  check("no environmental kill is credited outside 2.0s",
    neutralRingOut?.t === "pvpRingOut"
    && neutralRingOut.by === ""
    && [...expired.players.keys()].every((id) => (expired.match!.scores.get(id) ?? 0) === 0));

  const protectedWorld = pvpWorld(64, ["p1", "p2"]);
  advanceToLive(protectedWorld);
  const protectedPlayer = protectedWorld.players.get("p2")!;
  protectedPlayer.x = pit.x;
  protectedPlayer.y = pit.y;
  protectedPlayer.spawnGraceT = pvpSpawnHardGraceTicks();
  protectedPlayer.spawnShieldT = pvpSpawnShieldTicks();
  stepN(protectedWorld, 1, new Map());
  check("a spawn-shielded player standing over a pit is not spawn-locked",
    protectedPlayer.hp === PVP.maxHp && protectedPlayer.respawnT === 0);
  clearPvpProtection(protectedPlayer);
  const ringEvents = stepCollect(protectedWorld, 1, new Map());
  const walkedIn = ringEvents.find((event) => event.t === "pvpRingOut");
  check("the same pit kills immediately once protection ends",
    protectedPlayer.respawnT > 0 && walkedIn?.t === "pvpRingOut");
  check("a walked-in pit death with no recent PvP hit credits no frag",
    walkedIn?.t === "pvpRingOut"
    && walkedIn.by === ""
    && [...protectedWorld.players.keys()].every((id) => (protectedWorld.match!.scores.get(id) ?? 0) === 0));

  const fallWorld = pvpWorld(641, ["p1", "p2"]);
  advanceToLive(fallWorld);
  const fallShooter = fallWorld.players.get("p1")!;
  const falling = fallWorld.players.get("p2")!;
  fallShooter.x = pit.x + 90;
  fallShooter.y = pit.y;
  fallShooter.invuln = 0;
  fallShooter.weapon = "railgun";
  fallShooter.ownedWeapons = ["railgun"];
  falling.x = pit.x;
  falling.y = pit.y;
  falling.hp = 1;
  falling.invuln = 0;
  const fallEvents = stepCollect(
    fallWorld,
    1,
    new Map([["p1", inp({ firing: true, aim: Math.PI })]]),
  );
  check("a falling body resolves as a ring-out before incoming shot damage",
    fallEvents.some((event) => event.t === "pvpRingOut")
    && !fallEvents.some((event) => event.t === "pvpKill")
    && (fallWorld.match!.scores.get("p1") ?? 0) === 0);
}

section("RING-OUT CREDIT FAILS CLOSED FOR REMOVED OR ABSENT SOURCES");
{
  const pit = buildPvpArena().pits[0];

  const removedWorld = pvpWorld(731, ["p1", "p2", "p3"]);
  advanceToLive(removedWorld);
  const removedSource = removedWorld.players.get("p1")!;
  const removedVictim = removedWorld.players.get("p2")!;
  removedVictim.lastPvpHitBy = removedSource.id;
  removedVictim.lastPvpHitTick = removedWorld.tick;
  removedVictim.lastPvpKnockbackBy = removedSource.id;
  removedVictim.lastPvpKnockbackTick = removedWorld.tick;
  removedWorld.match!.lastFragTick.set(removedSource.id, removedWorld.tick);
  removedWorld.match!.fragChain.set(removedSource.id, 2);
  removePlayerFromWorld(removedWorld, removedSource.id);
  check("removal scrubs reverse hit/knockback refs and every match map entry",
    removedVictim.lastPvpHitBy === null
    && removedVictim.lastPvpHitTick === -1
    && removedVictim.lastPvpKnockbackBy === null
    && removedVictim.lastPvpKnockbackTick === -1
    && !removedWorld.match!.scores.has(removedSource.id)
    && !removedWorld.match!.dmgThisTick.has(removedSource.id)
    && !removedWorld.match!.lastFragTick.has(removedSource.id)
    && !removedWorld.match!.fragChain.has(removedSource.id)
    && !removedWorld.playerHist.has(removedSource.id));
  removedVictim.x = pit.x;
  removedVictim.y = pit.y;
  clearPvpProtection(removedVictim);
  const removedEvents = stepCollect(removedWorld, 1, new Map());
  const removedRingOut = removedEvents.find((event) =>
    event.t === "pvpRingOut" && event.victim === removedVictim.id
  );
  check("removed source cannot receive a ghost ring-out frag or recreate its score",
    removedRingOut?.t === "pvpRingOut"
    && removedRingOut.by === ""
    && !removedWorld.match!.scores.has(removedSource.id)
    && removedWorld.match!.phase === "live");

  const absentWorld = pvpWorld(732, ["p1", "p2", "p3"]);
  advanceToLive(absentWorld);
  const absentSource = absentWorld.players.get("p1")!;
  const absentVictim = absentWorld.players.get("p2")!;
  absentVictim.lastPvpHitBy = absentSource.id;
  absentVictim.lastPvpHitTick = absentWorld.tick;
  absentVictim.lastPvpKnockbackBy = absentSource.id;
  absentVictim.lastPvpKnockbackTick = absentWorld.tick;
  setPlayerAbsence(absentWorld, absentSource.id, true);
  absentVictim.x = pit.x;
  absentVictim.y = pit.y;
  clearPvpProtection(absentVictim);
  const absentEvents = stepCollect(absentWorld, 1, new Map());
  const absentRingOut = absentEvents.find((event) =>
    event.t === "pvpRingOut" && event.victim === absentVictim.id
  );
  check("absent source is neutral at award time while the 3p match stays live",
    absentRingOut?.t === "pvpRingOut"
    && absentRingOut.by === ""
    && (absentWorld.match!.scores.get(absentSource.id) ?? 0) === 0
    && absentWorld.match!.phase === "live");
}

section("DEATH-WITHIN-3S TELEMETRY USES ITS OWN INCLUSIVE 60-TICK BOUNDARY");
{
  const pit = buildPvpArena().pits[0];
  const deathWithinAt = (activeTicksAtDeath: number): boolean => {
    const w = pvpWorld(740 + activeTicksAtDeath, ["p1", "p2"]);
    advanceToLive(w);
    const victim = w.players.get("p2")!;
    if (victim.pvpRespawnTelemetry === null) throw new Error("missing respawn telemetry");
    victim.pvpRespawnTelemetry.activeTicks = activeTicksAtDeath - 1;
    victim.x = pit.x;
    victim.y = pit.y;
    clearPvpProtection(victim);
    stepN(w, 1, new Map());
    check(`elimination observes activeTicks=${activeTicksAtDeath}`,
      victim.pvpRespawnTelemetry.activeTicks === activeTicksAtDeath);
    return victim.pvpRespawnTelemetry.isDeathWithin3s;
  };
  check("active ticks 59 and 60 are within 3s; tick 61 is outside",
    deathWithinAt(59) && deathWithinAt(60) && !deathWithinAt(61));
}

// ---------------------------------------------------------------------------------------------
section("MATCH STATE MACHINE (frag-limit respawn, tick-based)");
{
  // lobby -> countdown at minPlayers; fun at 2 (never gated to >=3).
  const w = pvpWorld(7, ["p1", "p2"]);
  check("starts in lobby", w.match!.phase === "lobby");
  stepN(w, 1, new Map());
  check("2 players opens the countdown (fun at 2)", w.match!.phase === "countdown");
  stepN(w, pvpCountdownTicks() + 1, new Map());
  check("countdown -> live", w.match!.phase === "live");

  // A lone player never starts a match.
  const solo = pvpWorld(8, ["p1"]);
  stepN(solo, 50, new Map());
  check("1 player stays in lobby", solo.match!.phase === "lobby");

  // Frag limit (scaled by player count) is resolved at the whistle and ends the match.
  const fw = pvpWorld(9, ["p1", "p2"]);
  advanceToLive(fw);
  check("2p frag limit resolved to 8 at the whistle", fw.match!.fragLimit === pvpFragLimit(2) && fw.match!.fragLimit === 8);
  fw.match!.scores.set("p1", fw.match!.fragLimit);
  stepN(fw, 1, new Map());
  check("frag limit ends the match", fw.match!.phase === "over");
  check("winner is the frag leader", fw.match!.winner === "p1");

  // Time cap ends the match; winner = highest frags.
  const tw = pvpWorld(10, ["p1", "p2"]);
  advanceToLive(tw);
  tw.match!.scores.set("p2", 3);
  tw.match!.scores.set("p1", 1);
  tw.match!.phaseEndTick = tw.tick; // force the time cap
  stepN(tw, 1, new Map());
  check("time cap ends the match", tw.match!.phase === "over");
  check("time-cap winner is the highest frag count", tw.match!.winner === "p2");
}

// ---------------------------------------------------------------------------------------------
section("COMEBACK: leader stats stay flat; sudden death is juice only");
{
  const w = pvpWorld(68, ["p1", "p2", "p3"]);
  advanceToLive(w);
  w.match!.scores.set("p1", w.match!.fragLimit - PVP.suddenDeathFrags);
  w.match!.scores.set("p2", 2);
  w.match!.scores.set("p3", 0);
  const leader = w.players.get("p1")!;
  const trailer = w.players.get("p3")!;
  const before = JSON.stringify({
    leader: { hp: leader.hp, maxHp: leader.maxHp, mods: leader.mods },
    trailer: { hp: trailer.hp, maxHp: trailer.maxHp, mods: trailer.mods },
  });
  const first = stepCollect(w, 1, new Map());
  const second = stepCollect(w, 1, new Map());
  check("match point emits one sudden-death crescendo event",
    first.filter((event) => event.t === "pvpSuddenDeath").length === 1
    && !second.some((event) => event.t === "pvpSuddenDeath"));
  const after = JSON.stringify({
    leader: { hp: leader.hp, maxHp: leader.maxHp, mods: leader.mods },
    trailer: { hp: trailer.hp, maxHp: trailer.maxHp, mods: trailer.mods },
  });
  check("leader and trailer combat stats remain identical",
    JSON.stringify(leader.mods) === JSON.stringify(trailer.mods)
    && leader.maxHp === trailer.maxHp);
  check("sudden death changes no player stat", before === after);

  const clockWorld = pvpWorld(69, ["p1", "p2"]);
  advanceToLive(clockWorld);
  clockWorld.match!.phaseEndTick = clockWorld.tick + Math.round(PVP.suddenDeathFinalSec / DT);
  const clockEvents = stepCollect(clockWorld, 1, new Map());
  check("the final 30s also emits the juice-only crescendo",
    clockEvents.some((event) => event.t === "pvpSuddenDeath"));
}

// ---------------------------------------------------------------------------------------------
section("frag-limit RESPAWN (death schedules a respawn, never elimination)");
{
  const w = pvpWorld(11, ["p1", "p2"]);
  advanceToLive(w);
  const shooter = w.players.get("p1")!;
  const victim = w.players.get("p2")!;
  const aim = faceOff(shooter, victim, 60);
  shooter.weapon = "railgun"; shooter.ownedWeapons = ["railgun"]; // faster kill for the test
  const inputs = new Map([["p1", inp({ firing: true, aim })]]);
  let guard = 0;
  while (victim.respawnT === 0 && victim.hp > 0 && guard++ < 400) stepN(w, 1, inputs);
  check("a killed player is DEAD-awaiting-respawn (not removed)", w.players.has("p2") && victim.respawnT > 0);
  const respawnCd = victim.respawnT;
  stepN(w, respawnCd + pvpRespawnWaitSafeMaxTicks() + 2, new Map());
  check("the player respawns at full HP after the delay", victim.hp === PVP.maxHp && victim.respawnT === 0);
  check("respawn arms fresh nested spawn protection",
    victim.spawnShieldT > 0
    && victim.spawnHardGraceEndsAtTick - victim.spawnProtectionStartedTick === 15
    && victim.spawnShieldEndsAtTick - victim.spawnProtectionStartedTick === 40);
  check("materialization exposes full HP, ready dash, and ready weapon cadence",
    victim.hp === victim.maxHp && victim.dashCd === 0 && victim.fireCd === 0);
  check("respawn delay matches the named constant exactly", respawnCd === pvpRespawnDelayTicks());
}

// ---------------------------------------------------------------------------------------------
section("ANTI-ONE-SHOT: the per-tick cap holds");
{
  // Point-blank Boomstick (8 pellets one trigger): the worst-case single trigger stays <= cap.
  const w = pvpWorld(12, ["p1", "p2"]);
  advanceToLive(w);
  const s = w.players.get("p1")!; const v = w.players.get("p2")!;
  const aim = faceOff(s, v, 24); // point blank
  s.weapon = "sawnoff"; s.ownedWeapons = ["sawnoff"];
  let worstDrop = 0;
  const inputs = new Map([["p1", inp({ firing: true, aim })]]);
  for (let i = 0; i < 60; i++) {
    const before = v.hp;
    stepN(w, 1, inputs);
    if (v.hp > 0) worstDrop = Math.max(worstDrop, before - v.hp);
  }
  check("no single tick removes more than the per-hit cap", worstDrop <= pvpPerHitCap() + 1e-9, `worst=${worstDrop.toFixed(2)}`);

  // Two railguns landing the SAME tick clamp to exactly the cap (35). The shooters sit ABOVE and
  // BELOW the target (perpendicular converging fire) on a clear column so neither round passes
  // through the other shooter first. railgun pvp = 11*1.78 ~= 19.6 each; two = ~39 -> capped 35.
  const w2 = pvpWorld(13, ["p1", "p2", "p3"]);
  advanceToLive(w2);
  const a = w2.players.get("p1")!; const b = w2.players.get("p2")!; const target = w2.players.get("p3")!;
  target.x = 648; target.y = 216; target.invuln = 0; // tile (13,4), clear column
  a.x = 648; a.y = 140; a.invuln = 0; a.weapon = "railgun"; a.ownedWeapons = ["railgun"]; // above, fires down
  b.x = 648; b.y = 300; b.invuln = 0; b.weapon = "railgun"; b.ownedWeapons = ["railgun"]; // below, fires up
  const before = target.hp;
  stepN(w2, 1, new Map([["p1", inp({ firing: true, aim: Math.PI / 2 })], ["p2", inp({ firing: true, aim: -Math.PI / 2 })]]));
  const drop = before - target.hp;
  check("simultaneous over-cap hits clamp to exactly the cap", Math.abs(drop - pvpPerHitCap()) < 1e-9, `drop=${drop}`);
}

// ---------------------------------------------------------------------------------------------
section("PER-WEAPON TTK band (1v1 median 3-5s across the arsenal)");
{
  // Expected 1v1 TTK from the shipped model: pellets * per-pellet pvp damage / trigger, clamped
  // by the per-hit cap, against the fixed HP pool. This is the balancer ship-gate.
  const gateWeapons = ["pistol", "smg", "cannon", "railgun", "rapid", "sawnoff", "flamer", "burst", "spear", "beam"] as const;
  for (const id of gateWeapons) {
    const wep = WEAPONS[id];
    const perTrigger = Math.min(pvpPerHitCap(), wep.pellets * pvpHitDamage(id, wep.damage));
    const dps = perTrigger / wep.fireCd;
    const ttk = PVP.maxHp / dps;
    check(`TTK(${id}) in 3.5-5.5s band`, ttk >= 3.5 && ttk <= 5.5, `${ttk.toFixed(2)}s`);
  }
}

// ---------------------------------------------------------------------------------------------
section("FULL-DRAFT TTK: glass-cannon / deadeye / pierce stack stays in band");
{
  const draftedIds = ["glass_cannon", "deadeye", "full_metal", "core_damage"];
  const draftedTtks: number[] = [];
  for (let seed = 70; seed < 91; seed++) {
    const w = pvpWorld(seed, ["p1", "p2"]);
    advanceToLive(w);
    const shooter = w.players.get("p1")!;
    const victim = w.players.get("p2")!;
    for (const id of draftedIds) {
      const item = itemById(id);
      if (item !== undefined) applyItemToWorld(w, shooter.id, item);
    }
    shooter.weapon = "pistol";
    shooter.ownedWeapons = ["pistol"];
    const aim = faceOff(shooter, victim, 60);
    let ticks = 0;
    while (victim.respawnT === 0 && ticks++ < 400) {
      stepN(w, 1, new Map([["p1", inp({ firing: true, aim })]]));
    }
    draftedTtks.push(ticks * DT);
    check(`drafted build keeps fixed HP in replay seed ${seed}`, shooter.maxHp === PVP.maxHp);
  }
  draftedTtks.sort((a, b) => a - b);
  const median = draftedTtks[(draftedTtks.length - 1) >> 1];
  check("four-draft median TTK cannot fall below 3.5s",
    median >= PVP.ttkMinSec,
    `median=${median.toFixed(2)}s`);
  check("four-draft median TTK remains inside the 5.5s upper band",
    median <= PVP.ttkMaxSec,
    `median=${median.toFixed(2)}s`);

  const capWorld = pvpWorld(92, ["p1", "p2"]);
  advanceToLive(capWorld);
  const capShooter = capWorld.players.get("p1")!;
  const capVictim = capWorld.players.get("p2")!;
  for (const id of draftedIds) {
    const item = itemById(id);
    if (item !== undefined) applyItemToWorld(capWorld, capShooter.id, item);
  }
  const capAim = faceOff(capShooter, capVictim, 24);
  capShooter.weapon = "sawnoff";
  capShooter.ownedWeapons = ["sawnoff"];
  let worstDrop = 0;
  for (let tick = 0; tick < 60; tick++) {
    const before = capVictim.hp;
    stepN(capWorld, 1, new Map([["p1", inp({ firing: true, aim: capAim })]]));
    if (capVictim.hp > 0) worstDrop = Math.max(worstDrop, before - capVictim.hp);
  }
  check("35% non-environment damage cap still holds under a full draft",
    worstDrop <= pvpPerHitCap() + 1e-9,
    `worst=${worstDrop.toFixed(2)}`);
}

// ---------------------------------------------------------------------------------------------
section("DETERMINISM: identical inputs -> byte-identical, and reconnect-stable scoreboard");
{
  // A scripted 3p match: each player fires at a fixed aim; positions overridden identically.
  function digest(w: WorldState): string {
    const ids = [...w.players.keys()].sort();
    const parts = ids.map((id) => {
      const p = w.players.get(id)!;
      return `${id}:${p.x.toFixed(3)},${p.y.toFixed(3)},${p.hp.toFixed(3)},${p.respawnT},${p.respawnWaitSafeT},${p.spawnProtectionStartedTick},${p.spawnHardGraceEndsAtTick},${p.spawnShieldEndsAtTick},${p.spawnGraceT},${p.spawnShieldT},${p.isSpawnOffenseLatched ? 1 : 0},${p.pvpRecentSpawnIndices.join(".")}#${w.match!.scores.get(id) ?? 0}`;
    });
    return `t${w.tick}|${w.match!.phase}|${w.match!.winner}|${parts.join("|")}`;
  }
  function runScripted(seed: number): string {
    const w = pvpWorld(seed, ["p1", "p2", "p3"]);
    advanceToLive(w);
    // Deterministic ring: each shoots the next, all at close range.
    const ps = ["p1", "p2", "p3"].map((id) => w.players.get(id)!);
    ps[0].x = 300; ps[0].y = 216; ps[1].x = 360; ps[1].y = 216; ps[2].x = 420; ps[2].y = 216; // clear row 4
    for (const p of ps) { p.invuln = 0; p.weapon = "smg"; p.ownedWeapons = ["smg"]; }
    const inputs = new Map([
      ["p1", inp({ firing: true, aim: 0 })],
      ["p2", inp({ firing: true, aim: 0 })],
      ["p3", inp({ firing: true, aim: Math.PI })],
    ]);
    stepN(w, 200, inputs);
    return digest(w);
  }
  const a = runScripted(20);
  const b = runScripted(20);
  check("a scripted match replayed twice is byte-identical", a === b);

  const runWaveOneReplay = (addOrder: string[]): string => {
    const w = pvpWorld(93, addOrder);
    advanceToLive(w);
    const attacker = w.players.get("p1")!;
    const victim = w.players.get("p2")!;
    attacker.weapon = "pistol";
    attacker.ownedWeapons = ["pistol"];
    attacker.pvpDraftFrags = PVP.draftEveryFrags - 1;
    const aim = faceOff(attacker, victim, 60);
    const replayEvents: SimEvent[] = [];
    let guard = 0;
    while (victim.lastPvpHitBy === null && guard++ < 20) {
      replayEvents.push(...stepCollect(w, 1, new Map([["p1", inp({ firing: true, aim })]])));
    }
    const knockbackX = victim.x;
    w.bullets = [];
    const pit = buildPvpArena().pits[0];
    victim.x = pit.x;
    victim.y = pit.y;
    replayEvents.push(...stepCollect(w, 1, new Map()));
    const draftRng = new Rng(pvpDraftSeed(w.seed, attacker.id, attacker.pvpDraftTick, attacker.pvpDraftOrdinal));
    const choices = rollPvpDraftChoicesWith(
      PVP.draftChoices,
      () => draftRng.next(),
      attacker.ownedItemIds,
      { tierBump: attacker.pvpDraftTierBump },
    ).map((item) => item.id);
    return JSON.stringify({
      tick: w.tick,
      knockbackX,
      victimRespawn: victim.respawnT,
      score: w.match!.scores.get("p1") ?? 0,
      events: replayEvents.map((event) => event.t),
      choices,
    });
  };
  const isDraftPreviouslyEnabled = PVP.draftEnabled;
  PVP.draftEnabled = true;
  const waveForward = runWaveOneReplay(["p1", "p2"]);
  const waveReversed = runWaveOneReplay(["p2", "p1"]);
  PVP.draftEnabled = isDraftPreviouslyEnabled;
  check("draft offers, environmental attribution, and knockback replay identically",
    waveForward === waveReversed);

  // Reconnect-stable: a player going absent and returning keeps their PlayerId-keyed frags, and
  // the deathmatch never wipes the run (no all-down cut) while they are gone.
  const w = pvpWorld(21, ["p1", "p2"]);
  advanceToLive(w);
  const shooter = w.players.get("p1")!; const victim = w.players.get("p2")!;
  const aim = faceOff(shooter, victim, 40);
  shooter.weapon = "railgun"; shooter.ownedWeapons = ["railgun"];
  const inputs = new Map([["p1", inp({ firing: true, aim })]]);
  let guard = 0;
  while ((w.match!.scores.get("p1") ?? 0) < 2 && guard++ < 600) stepN(w, 1, inputs);
  const scoreBefore = w.match!.scores.get("p1") ?? 0;
  setPlayerAbsence(w, "p2", true);
  stepN(w, 80, inputs); // shooter keeps firing at an absent (safe) body
  check("no wipe/game-over in a deathmatch while a player is absent", !w.isRunOver && w.match!.phase === "live");
  check("an absent body cannot be farmed for frags", (w.match!.scores.get("p1") ?? 0) === scoreBefore);
  setPlayerAbsence(w, "p2", false);
  check("frags survive the reconnect (PlayerId-keyed scoreboard)", (w.match!.scores.get("p1") ?? 0) === scoreBefore);
}

// ---------------------------------------------------------------------------------------------
section("CAN-DAMAGE COMPLETENESS: AoE / chain / homing / deployables all hit foes");
{
  // Mortar (AoE blast): the shell detonates on/near the foe and the blast catches them — never a
  // silent pass-through (the exact failure the architecture scan warned about).
  {
    const w = pvpWorld(40, ["p1", "p2"]);
    advanceToLive(w);
    const s = w.players.get("p1")!; const v = w.players.get("p2")!;
    s.x = 300; s.y = 216; s.invuln = 0; s.weapon = "mortar"; s.ownedWeapons = ["mortar"];
    v.x = 500; v.y = 216; v.invuln = 0;
    stepN(w, 30, new Map([["p1", inp({ firing: true, aim: 0 })]]));
    check("mortar AoE damages a foe (blast, not silent pass-through)", v.hp < PVP.maxHp, `hp=${v.hp}`);
  }
  // Tesla (chain lightning): hitting foe A arcs to nearby foe B.
  {
    const w = pvpWorld(41, ["p1", "p2", "p3"]);
    advanceToLive(w);
    const s = w.players.get("p1")!; const a = w.players.get("p2")!; const b = w.players.get("p3")!;
    s.x = 300; s.y = 216; s.invuln = 0; s.weapon = "tesla"; s.ownedWeapons = ["tesla"];
    a.x = 360; a.y = 216; a.invuln = 0;
    b.x = 420; b.y = 216; b.invuln = 0;
    stepN(w, 6, new Map([["p1", inp({ firing: true, aim: 0 })]]));
    check("tesla hits the struck foe AND chains to a nearby foe", a.hp < PVP.maxHp && b.hp < PVP.maxHp, `a=${a.hp} b=${b.hp}`);
  }
  // Homing: a round fired OFF-axis seeks and curves onto the foe (a straight round would miss).
  {
    const w = pvpWorld(42, ["p1", "p2"]);
    advanceToLive(w);
    const s = w.players.get("p1")!; const v = w.players.get("p2")!;
    s.x = 300; s.y = 216; s.invuln = 0; s.weapon = "homing"; s.ownedWeapons = ["homing"];
    v.x = 450; v.y = 176; v.invuln = 0; // 40px off the aim=0 line
    stepN(w, 40, new Map([["p1", inp({ firing: true, aim: 0 })]]));
    check("homing rounds seek and hit a foe", v.hp < PVP.maxHp, `hp=${v.hp}`);
  }
  // Razor Halo (orbit blades): the ring strikes an adjacent foe (weapon held, no firing needed).
  {
    const w = pvpWorld(43, ["p1", "p2"]);
    advanceToLive(w);
    const s = w.players.get("p1")!; const v = w.players.get("p2")!;
    s.x = 300; s.y = 216; s.invuln = 0; s.weapon = "halo"; s.ownedWeapons = ["halo"];
    v.x = 340; v.y = 216; v.invuln = 0; // inside the 46px orbit ring
    stepN(w, 45, new Map([["p1", inp({ firing: false, aim: 0 })]]));
    check("orbit blades damage an adjacent foe", v.hp < PVP.maxHp, `hp=${v.hp}`);
  }
  // Prism Sentry (deployable): the turret acquires a foe in range + LOS and its bolts hit.
  {
    const w = pvpWorld(44, ["p1", "p2"]);
    advanceToLive(w);
    const s = w.players.get("p1")!; const v = w.players.get("p2")!;
    s.x = 300; s.y = 216; s.invuln = 0; s.weapon = "sentry"; s.ownedWeapons = ["sentry"];
    v.x = 470; v.y = 216; v.invuln = 0;
    stepN(w, 1, new Map([["p1", inp({ firing: true, aim: 0 })]])); // deploy the turret
    stepN(w, 45, new Map()); // owner idle; the sentry acquires + fires autonomously
    check("a deployed sentry fires at and damages a foe", v.hp < PVP.maxHp, `hp=${v.hp}`);
  }
}

section("PROTECTED TARGET EXCLUSION: homing and sentry cannot pre-stack on shields");
{
  const homingWorld = pvpWorld(45, ["p1", "p2", "p3"]);
  advanceToLive(homingWorld);
  const owner = homingWorld.players.get("p1")!;
  const protectedTarget = homingWorld.players.get("p2")!;
  const liveTarget = homingWorld.players.get("p3")!;
  owner.x = 300; owner.y = 216; clearPvpProtection(owner);
  protectedTarget.x = 350; protectedTarget.y = 190;
  protectedTarget.spawnShieldT = pvpSpawnShieldTicks();
  liveTarget.x = 380; liveTarget.y = 260; clearPvpProtection(liveTarget);
  homingWorld.bullets.push({
    x: owner.x,
    y: owner.y,
    vx: 300,
    vy: 0,
    radius: 4,
    life: 2,
    friendly: true,
    owner: owner.id,
    damage: 2,
    color: "#fff",
    pierce: 0,
    hitList: null,
    isCrit: false,
    homing: 4,
    fx: "homing",
  });
  stepN(homingWorld, 1, new Map());
  check("homing ignores the closer shielded player and turns toward the live foe",
    homingWorld.bullets[0]?.vy > 0);

  const sentryWorld = pvpWorld(46, ["p1", "p2"]);
  advanceToLive(sentryWorld);
  const sentryOwner = sentryWorld.players.get("p1")!;
  const sentryTarget = sentryWorld.players.get("p2")!;
  sentryOwner.x = 300; sentryOwner.y = 216; clearPvpProtection(sentryOwner);
  sentryOwner.weapon = "sentry"; sentryOwner.ownedWeapons = ["sentry"];
  sentryTarget.x = 470; sentryTarget.y = 216;
  sentryTarget.spawnShieldT = pvpSpawnShieldTicks();
  const protectedEvents = stepCollect(
    sentryWorld,
    20,
    new Map([["p1", inp({ firing: true, aim: 0 })]]),
  );
  check("auto-turret does not acquire or fire into a protected target",
    !protectedEvents.some((event) => event.t === "sentryAcquire" || event.t === "sentryShot")
    && sentryTarget.hp === PVP.maxHp);
  clearPvpProtection(sentryTarget);
  const liveEvents = stepCollect(sentryWorld, 20, new Map());
  check("auto-turret resumes ordinary acquisition after protection ends",
    liveEvents.some((event) => event.t === "sentryAcquire" || event.t === "sentryShot"));
}

// ---------------------------------------------------------------------------------------------
section("DETERMINISM EDGE-CASES: self-immune, same-tick order-stable, no shoot-from-shield");
{
  // SELF-IMMUNE: a player's OWN AoE deals 0 to themselves (decided once in canDamage), but the
  // same blast still hits a foe standing in it — proving the rule is self-scoped, not inert.
  {
    const w = pvpWorld(51, ["p1", "p2"]);
    advanceToLive(w);
    const s = w.players.get("p1")!; const foe = w.players.get("p2")!;
    s.x = 120; s.y = 216; s.invuln = 0; s.weapon = "mortar"; s.ownedWeapons = ["mortar"];
    foe.x = 120; foe.y = 240; foe.invuln = 0; // adjacent — both stand in the self-blast
    stepN(w, 12, new Map([["p1", inp({ firing: true, aim: Math.PI })]])); // mortar into the near wall
    check("own AoE is self-immune (mortar blast deals 0 to its owner)", s.hp === PVP.maxHp, `self=${s.hp}`);
    check("the same blast DOES hit a foe (self-scoped, not inert)", foe.hp < PVP.maxHp, `foe=${foe.hp}`);
  }

  // SAME-TICK ORDER-STABILITY: two sources finish a low-HP foe on the same tick. The frag is
  // credited deterministically (id-sorted resolve), INDEPENDENT of the players-map/add order (a
  // reconnect reorders the map). Same winner whether players were added forward or reversed.
  {
    const sameTickWinner = (addOrder: string[]): string | null => {
      const w = pvpWorld(50, addOrder);
      advanceToLive(w);
      const a = w.players.get("p1")!; const b = w.players.get("p3")!; const target = w.players.get("p2")!;
      target.x = 648; target.y = 216; target.invuln = 0; target.hp = 10; // this tick is lethal
      a.x = 648; a.y = 140; a.invuln = 0; a.weapon = "railgun"; a.ownedWeapons = ["railgun"];
      b.x = 648; b.y = 300; b.invuln = 0; b.weapon = "railgun"; b.ownedWeapons = ["railgun"];
      stepN(w, 1, new Map([["p1", inp({ firing: true, aim: Math.PI / 2 })], ["p3", inp({ firing: true, aim: -Math.PI / 2 })]]));
      if ((w.match!.scores.get("p1") ?? 0) === 1) return "p1";
      if ((w.match!.scores.get("p3") ?? 0) === 1) return "p3";
      return null;
    };
    const forward = sameTickWinner(["p1", "p2", "p3"]);
    const reversed = sameTickWinner(["p3", "p2", "p1"]);
    check("same-tick kill credits the id-sorted source (p1)", forward === "p1", `forward=${forward}`);
    check("same-tick attribution is map/add-order independent (reconnect-stable)", forward === reversed, `forward=${forward} reversed=${reversed}`);
  }

  // NO SHOOT-FROM-SHIELD: grace suppresses the trigger; the first legal shot drops the shield.
  {
    const w = pvpWorld(52, ["p1", "p2"]);
    advanceToLive(w);
    const s = w.players.get("p1")!; const foe = w.players.get("p2")!;
    s.x = 300; s.y = 216; s.weapon = "pistol"; s.ownedWeapons = ["pistol"];
    s.spawnGraceT = pvpSpawnHardGraceTicks();
    s.spawnShieldT = pvpSpawnShieldTicks();
    foe.x = 360; foe.y = 216; clearPvpProtection(foe); foe.weapon = "pistol"; foe.ownedWeapons = ["pistol"];
    stepN(w, 6, new Map([["p2", inp({ firing: true, aim: Math.PI })]])); // foe fires; s idle + protected
    check("spawn-shielded player takes no incoming damage", s.hp === PVP.maxHp && s.spawnShieldT > 0,
      `hp=${s.hp} shield=${s.spawnShieldT}`);
    const shotSeq = s.shotSeq;
    stepN(w, 1, new Map([["p1", inp({ firing: true, aim: 0 })], ["p2", inp({ firing: true, aim: Math.PI })]]));
    check("firing during hard grace is suppressed without breaking shield",
      s.shotSeq === shotSeq && s.spawnShieldT > 0);
    stepN(w, s.spawnGraceT, new Map([["p2", inp({ firing: true, aim: Math.PI })]]));
    stepN(w, 1, new Map([["p1", inp({ firing: true, aim: 0 })], ["p2", inp({ firing: true, aim: Math.PI })]]));
    check("the first legal shot drops the shield on its spawn tick",
      s.shotSeq === shotSeq + 1 && s.spawnShieldT === 0);
    const before = s.hp;
    stepN(w, 8, new Map([["p2", inp({ firing: true, aim: Math.PI })]]));
    check("after firing, the player is vulnerable (no shoot-from-invuln)", s.hp < before, `hp=${s.hp}`);
  }
}

// ---------------------------------------------------------------------------------------------
section("P2 WIRE: protocol v32, match block + spawn protection + reliable events");
{
  check("PROTOCOL_VERSION bumped to 32", PROTOCOL_VERSION === 32);

  // A pvp snapshot round-trips the match block, per-player team, and the local respawn field.
  const w = pvpWorld(30, ["p1", "p2"]);
  advanceToLive(w);
  w.match!.scores.set("p1", 4);
  w.match!.scores.set("p2", 2);
  w.players.get("p1")!.spawnGraceT = 12;
  w.players.get("p1")!.spawnShieldT = 42;
  w.players.get("p2")!.spawnGraceT = 7;
  w.players.get("p2")!.spawnShieldT = 31;
  for (const player of w.players.values()) {
    player.spawnProtectionStartedTick = w.tick;
    player.spawnHardGraceEndsAtTick = w.tick + pvpSpawnHardGraceTicks();
    player.spawnShieldEndsAtTick = w.tick + pvpSpawnShieldTicks();
  }
  w.players.get("p1")!.isSpawnOffenseLatched = true;
  const raw = jsonCodec.encodeServer(snapOf(w, "p1"));
  const dec = jsonCodec.decodeServer(raw);
  if (dec.t !== "snap") { check("snapshot decodes as a snap", false); }
  else {
    check("co-op-shaped wire carries a non-null match block in pvp", dec.match !== null);
    check("match phase rides the wire", dec.match!.ph === "live");
    check("match phase-timer rides as an absolute end tick", dec.match!.end > w.tick);
    const s1 = dec.match!.sc.find((s) => s.id === "p1");
    check("per-player frags ride the wire", (s1?.f ?? -1) === 4);
    check("per-player alive rides the wire", s1?.a === true);
    check("other player's FFA team rides PlayerWire.tm", dec.players.find((p) => p.id === "p2")?.tm === 0);
    check("local respawn countdown rides SelfWire.rsp", dec.self !== null && dec.self.rsp === 0);
    check("local authoritative grace/shield ticks ride SelfWire",
      dec.self?.sgr === 12 && dec.self.ssh === 42);
    check("local spawn origin and nested endpoints ride SelfWire",
      dec.self !== null
      && dec.self.sge - dec.self.spo === 15
      && dec.self.sse - dec.self.spo === 40
      && dec.self.sfl);
    const remote = dec.players.find((p) => p.id === "p2");
    check("remote authoritative grace/shield ticks ride PlayerWire",
      remote?.sgr === 7 && remote.ssh === 31);
    check("remote observes the same authoritative nested endpoints",
      remote !== undefined
      && remote.sge - remote.spo === 15
      && remote.sse - remote.spo === 40);
  }
  const waiting = w.players.get("p1")!;
  waiting.hp = 0;
  waiting.respawnT = 1;
  waiting.respawnWaitSafeT = 9;
  const waitingSnap = snapOf(w, "p1");
  check("RESPAWN_WAIT_SAFE remains the existing RESPawning wire/UI state",
    waitingSnap.self?.rsp === 1
    && waitingSnap.match?.sc.find((score) => score.id === "p1")?.a === false);
  waiting.hp = PVP.maxHp;
  waiting.respawnT = 0;
  waiting.respawnWaitSafeT = 0;

  // A co-op snapshot carries a null match block (mode selects meaning; no leak).
  const coop = createWorld(30, 1, { isShared: true, skipLocalPlayer: true });
  spawnPlayerInWorld(coop, "c1"); spawnPlayerInWorld(coop, "c2");
  const cdec = jsonCodec.decodeServer(jsonCodec.encodeServer(snapOf(coop, "c1")));
  check("co-op snapshot has a null match block", cdec.t === "snap" && cdec.match === null);

  // Delta round-trip: a kill changes the scoreboard; the delta reconstructs it exactly.
  const base = snapOf(w, "p1");
  w.match!.scores.set("p1", 5);
  const next = snapOf(w, "p1");
  const live = { enemies: new Set<number>(), players: new Set(["p1", "p2"]), props: new Set<number>(), pickups: new Set<number>(), chests: new Set<number>(), hzds: new Set<number>(), effs: new Set<number>() };
  const delta = diffSnapshot(snapshotToWire(base), snapshotToWire(next), 2, live);
  check("the match block delta-encodes as one whole object", delta.w !== undefined && "match" in delta.w);
  const rebuilt = validateSnap(applySnapshotDelta(snapshotToWire(base), delta));
  check("delta-reconstructed match matches source", rebuilt.match!.sc.find((s) => s.id === "p1")?.f === 5);

  // Reliable elimination + match-over events fire from the sim.
  const kw = pvpWorld(31, ["p1", "p2"]);
  advanceToLive(kw);
  const shooter = kw.players.get("p1")!; const victim = kw.players.get("p2")!;
  const aim = faceOff(shooter, victim, 40);
  shooter.weapon = "railgun"; shooter.ownedWeapons = ["railgun"];
  const inputs = new Map([["p1", inp({ firing: true, aim })]]);
  let kills: SimEvent[] = [];
  let guard = 0;
  while (kills.length === 0 && guard++ < 400) kills = stepCollect(kw, 1, inputs).filter((e) => e.t === "pvpKill");
  const kill = kills[0];
  check("pvpKill event fires with attribution", kill !== undefined && kill.t === "pvpKill" && kill.by === "p1" && kill.victim === "p2");

  const mw = pvpWorld(32, ["p1", "p2"]);
  advanceToLive(mw);
  mw.match!.scores.set("p1", mw.match!.fragLimit);
  const over = stepCollect(mw, 1, new Map()).filter((e) => e.t === "pvpMatchOver");
  check("pvpMatchOver event fires with the winner", over.length === 1 && over[0].t === "pvpMatchOver" && over[0].winner === "p1");

  const eventSnap = {
    ...snapOf(w, "p1"),
    events: [
      { id: 1, e: { t: "pvpRingOut", by: "", victim: "p2", x: 456, y: 360 } as const },
      { id: 2, e: { t: "pvpChainFrag", by: "p1", chain: 2, x: 456, y: 360 } as const },
      { id: 3, e: { t: "pvpShieldBreak", pid: "p1", x: 456, y: 360 } as const },
      { id: 4, e: { t: "pvpSpawnAttackBlocked", pid: "p1", x: 456, y: 360 } as const },
      { id: 5, e: { t: "pvpSuddenDeath", leader: "p1" } as const },
    ],
  };
  const eventRoundTrip = jsonCodec.decodeServer(jsonCodec.encodeServer(eventSnap));
  check("ring-out, chain, arming, shield-break, and crescendo events round-trip reliably",
    eventRoundTrip.t === "snap"
    && eventRoundTrip.events.map((entry) => entry.e.t).join(",")
      === "pvpRingOut,pvpChainFrag,pvpShieldBreak,pvpSpawnAttackBlocked,pvpSuddenDeath");
}

// ---------------------------------------------------------------------------------------------
section("B1: an absent body is non-collidable — a round passes THROUGH it to a live foe");
{
  // shooter -> absent body (directly in front) -> live foe (behind), all colinear on a clear lane.
  const w = pvpWorld(61, ["p1", "p2", "p3"]);
  advanceToLive(w);
  const shooter = w.players.get("p1")!; const absent = w.players.get("p2")!; const live = w.players.get("p3")!;
  shooter.x = 250; shooter.y = 216; shooter.invuln = 0; shooter.weapon = "railgun"; shooter.ownedWeapons = ["railgun"];
  absent.x = 340; absent.y = 216; absent.invuln = 0; // squarely between shooter and the live foe
  live.x = 440; live.y = 216; live.invuln = 0;
  setPlayerAbsence(w, "p2", true); // p2 becomes a reserved (non-collidable, non-damageable) body
  const liveBefore = live.hp;
  stepN(w, 20, new Map([["p1", inp({ firing: true, aim: 0 })]]));
  check("B1: the absent body in the line of fire takes NO damage (passes through)", absent.hp === PVP.maxHp, `absent=${absent.hp}`);
  check("B1: the round reaches and damages the live foe standing behind it", live.hp < liveBefore, `live=${live.hp}`);
}

// ---------------------------------------------------------------------------------------------
section("B2: a departed owner's round fizzles — no ghost damage/kill/frag");
{
  // 3 players so removing the owner keeps the match live (>= min present) — isolates the
  // shooter-validity check from the no-contest reset.
  const w = pvpWorld(62, ["p1", "p2", "p3"]);
  advanceToLive(w);
  const p1 = w.players.get("p1")!; const p2 = w.players.get("p2")!; const p3 = w.players.get("p3")!;
  p1.x = 300; p1.y = 216; p1.invuln = 0; p1.weapon = "pistol"; p1.ownedWeapons = ["pistol"];
  p2.x = 380; p2.y = 216; p2.invuln = 0;
  p3.x = 130; p3.y = 130; // parked out of the way
  stepN(w, 1, new Map([["p1", inp({ firing: true, aim: 0 })]])); // a REAL p1-owned round is now in flight
  const bullet = w.bullets.find((b) => b.owner === "p1" && b.friendly && b.life > 0);
  check("p1 launched a real owned round", bullet !== undefined);
  removePlayerFromWorld(w, "p1"); // the owner leaves the arena for good
  check("the owner is gone but the match stays live (2 present)", !w.players.has("p1") && w.match!.phase === "live");
  // Park the orphaned round squarely on p2 — it WOULD hit if a departed owner still counted.
  if (bullet) { bullet.x = p2.x; bullet.y = p2.y; bullet.prevX = p2.x; bullet.prevY = p2.y; }
  const hpBefore = p2.hp;
  const evs = stepCollect(w, 3, new Map());
  check("B2: the departed owner's round deals NO damage", p2.hp === hpBefore, `hp=${p2.hp}`);
  check("B2: no kill event is credited to the departed owner", !evs.some((e) => e.t === "pvpKill"));
  check("B2: no ghost frag is scored for the departed owner", (w.match!.scores.get("p1") ?? 0) === 0);
}

// ---------------------------------------------------------------------------------------------
section("B3: present-count gates start / countdown / live / final-removal");
{
  // Absent during lobby: 1 present < min never opens the match.
  const wl = pvpWorld(63, ["p1", "p2"]);
  setPlayerAbsence(wl, "p2", true);
  stepN(wl, 10, new Map());
  check("B3: an absent seat never opens the lobby (present < min)", wl.match!.phase === "lobby");
  setPlayerAbsence(wl, "p2", false);
  stepN(wl, 1, new Map());
  check("B3: the countdown opens once both are present", wl.match!.phase === "countdown");

  // Countdown abort: a seat dropping mid-countdown reverts to lobby.
  const wc = pvpWorld(64, ["p1", "p2"]);
  stepN(wc, 1, new Map());
  check("countdown opened", wc.match!.phase === "countdown");
  setPlayerAbsence(wc, "p2", true);
  stepN(wc, 1, new Map());
  check("B3: the countdown aborts to lobby when present < min", wc.match!.phase === "lobby");

  // Live grace pause: the clock FREEZES while a seat is absent, then resumes.
  const wp = pvpWorld(65, ["p1", "p2"]);
  advanceToLive(wp);
  const remainBefore = wp.match!.phaseEndTick - wp.tick;
  setPlayerAbsence(wp, "p2", true);
  stepN(wp, 25, new Map());
  check("B3: a live match with an absent seat stays live but PAUSES (phase unchanged)", wp.match!.phase === "live");
  check("B3: the match clock is frozen while paused (no wall-clock lost)", (wp.match!.phaseEndTick - wp.tick) === remainBefore, `remain=${wp.match!.phaseEndTick - wp.tick} want=${remainBefore}`);
  setPlayerAbsence(wp, "p2", false);
  stepN(wp, 1, new Map());
  check("B3: the match resumes when the seat returns", wp.match!.phase === "live");

  // Final removal below min: NO-CONTEST reset to lobby (no free win/frags).
  const wf = pvpWorld(66, ["p1", "p2"]);
  advanceToLive(wf);
  wf.match!.scores.set("p1", 3);
  removePlayerFromWorld(wf, "p2");
  check("B3: a final removal below min resets the match to lobby (no-contest)", wf.match!.phase === "lobby");
  check("B3: no-contest awards no winner and leaves no lingering frags", wf.match!.winner === null && (wf.match!.scores.get("p1") ?? 0) === 0);
}

// ---------------------------------------------------------------------------------------------
section("B4: nothing can be pre-deployed before (or lobbed after) the live phase");
{
  // Freeze: during the countdown freeze-in no input applies — no movement, round, deploy, or charge.
  const w = pvpWorld(67, ["p1", "p2"]);
  stepN(w, 1, new Map());
  check("in countdown", w.match!.phase === "countdown");
  const s = w.players.get("p1")!;
  s.weapon = "sentry"; s.ownedWeapons = ["sentry"];
  const startX = s.x; const startY = s.y;
  const countdownEvents = stepCollect(
    w,
    4,
    new Map([["p1", inp({ firing: true, aim: 0, moveX: 1, moveY: 0, dash: true })]]),
  );
  check("B4: no round spawns during the countdown freeze", w.bullets.length === 0);
  check("B4: no sentry/effect deploys during the countdown freeze", w.effects.length === 0);
  check("B4: the player cannot move during the countdown freeze", s.x === startX && s.y === startY);
  check("B4: no charge builds during the countdown freeze", s.chargeT === 0);
  check("B4: countdown input emits no premature arming feedback or latch",
    !s.isSpawnOffenseLatched
    && !countdownEvents.some((event) => event.t === "pvpSpawnAttackBlocked"));

  // Whistle-clear: even if owned entities somehow exist, the countdown->live whistle wipes them.
  const w2 = pvpWorld(68, ["p1", "p2"]);
  advanceToLive(w2);
  const s2 = w2.players.get("p1")!;
  s2.x = 300; s2.y = 216; s2.invuln = 0; s2.weapon = "sentry"; s2.ownedWeapons = ["sentry"];
  stepN(w2, 1, new Map([["p1", inp({ firing: true, aim: 0 })]])); // deploy a sentry + launch a round
  s2.chargeT = 0.5; // a held charge lingering into the next whistle
  check("live combat created owned entities", w2.bullets.length + w2.effects.length > 0);
  // Model a fresh whistle with those entities still present (a re-countdown / rematch).
  w2.match!.phase = "countdown";
  w2.match!.phaseEndTick = w2.tick + pvpCountdownTicks();
  stepN(w2, pvpCountdownTicks() + 1, new Map());
  check("re-reached live", w2.match!.phase === "live");
  check("B4: bullets/effects/charges do NOT persist across the whistle", w2.bullets.length === 0 && w2.effects.length === 0 && s2.chargeT === 0, `b=${w2.bullets.length} e=${w2.effects.length} c=${s2.chargeT}`);
}

// ---------------------------------------------------------------------------------------------
section("B5: a player killed mid-dash respawns stationary (dash never crosses a life)");
{
  const w = pvpWorld(69, ["p1", "p2"]);
  advanceToLive(w);
  const shooter = w.players.get("p1")!; const victim = w.players.get("p2")!;
  const aim = faceOff(shooter, victim, 40);
  shooter.weapon = "railgun"; shooter.ownedWeapons = ["railgun"];
  const inputs = new Map([["p1", inp({ firing: true, aim })]]);
  // Arm a live dash on the victim right before the lethal hit lands.
  let guard = 0;
  while (victim.respawnT === 0 && victim.hp > 0 && guard++ < 400) {
    victim.dashTime = 0.4; victim.dashDx = 1; victim.dashDy = 0; // re-armed each tick until death
    stepN(w, 1, inputs);
  }
  check("victim was killed while dashing", victim.respawnT > 0);
  check("B5: death clears the active dash (dashTime + velocity zeroed)", victim.dashTime === 0 && victim.dashDx === 0 && victim.dashDy === 0);
  stepN(w, victim.respawnT + pvpRespawnWaitSafeMaxTicks() + 2, new Map());
  check("victim respawned at full HP", victim.hp === PVP.maxHp && victim.respawnT === 0);
  check("B5: the respawn is stationary (dashTime 0)", victim.dashTime === 0);
  const rx = victim.x; const ry = victim.y;
  stepN(w, 3, new Map()); // idle — a leftover dash would slide the body
  check("B5: the respawned body does not slide", victim.x === rx && victim.y === ry, `dx=${(victim.x - rx).toFixed(3)}`);
}

section("RESPAWN ENGAGEMENT RESET: cadence, locks, statuses, and owned transients clear");
{
  const w = pvpWorld(690, ["p1", "p2"]);
  advanceToLive(w);
  const shooter = w.players.get("p1")!;
  const victim = w.players.get("p2")!;
  const aim = faceOff(shooter, victim, 40);
  shooter.weapon = "railgun";
  shooter.ownedWeapons = ["railgun"];
  victim.hp = 1;
  victim.fireCd = 1;
  victim.chargeT = 0.6;
  victim.combo = 4;
  victim.comboTimer = 2;
  victim.isUltRequested = true;
  victim.isPulseRequested = true;
  victim.ultCharge = 321;
  victim.pvpDraftOrdinal = 7;
  w.match!.lastFragTick.set(victim.id, w.tick);
  w.match!.fragChain.set(victim.id, 3);
  w.bullets.push({
    x: victim.x,
    y: victim.y,
    vx: 100,
    vy: 0,
    radius: 4,
    life: 3,
    friendly: true,
    owner: victim.id,
    damage: 2,
    color: "#fff",
    pierce: 0,
    hitList: null,
    isCrit: false,
    fx: "pistol",
  });
  const ownedWire: WireEffect = {
    id: w.nextEffectId++,
    kind: "wire",
    owner: victim.id,
    fx: "snapwire",
    x: victim.x - 40,
    y: victim.y,
    x2: victim.x + 40,
    y2: victim.y,
    width: 14,
    arm: 0,
    life: 8,
    maxLife: 8,
    damage: 9,
  };
  w.effects.push(ownedWire);
  let guard = 0;
  while (victim.respawnT === 0 && guard++ < 10) {
    stepN(w, 1, new Map([["p1", inp({ firing: true, aim })]]));
  }
  check("death clears every victim-owned bullet and deployed effect",
    w.bullets.every((bullet) => bullet.owner !== victim.id)
    && w.effects.every((effect) => effect.owner !== victim.id));
  check("death resets movement, cadence, charge, requests, and victim chain state",
    victim.dashTime === 0
    && victim.dashCd === 0
    && victim.fireCd === 0
    && victim.chargeT === 0
    && victim.combo === 0
    && victim.comboTimer === 0
    && !victim.isUltRequested
    && !victim.isPulseRequested
    && !w.match!.lastFragTick.has(victim.id)
    && !w.match!.fragChain.has(victim.id));
  check("engagement reset does not alter ult charge or draft progression",
    victim.ultCharge === 321 && victim.pvpDraftOrdinal === 7);

  const staleWorld = pvpWorld(691, ["p1", "p2"]);
  advanceToLive(staleWorld);
  const deadOwner = staleWorld.players.get("p1")!;
  const staleTarget = staleWorld.players.get("p2")!;
  deadOwner.hp = 0;
  deadOwner.respawnT = 20;
  staleWorld.props = [{
    id: 999,
    kind: "crate",
    x: 400,
    y: 216,
    radius: 15,
    hp: 20,
    dead: false,
  }];
  staleWorld.bullets = [{
    x: 400,
    y: 216,
    vx: 0,
    vy: 0,
    radius: 5,
    life: 2,
    friendly: true,
    owner: deadOwner.id,
    damage: 20,
    color: "#fff",
    pierce: 0,
    hitList: null,
    isCrit: false,
    paintSpacing: 10,
    paintDist: 10,
    paintRadius: 26,
    paintLife: 3,
    paintRate: 2,
    fx: "frostline",
  }];
  staleWorld.effects = [{
    id: 1000,
    kind: "wire",
    owner: deadOwner.id,
    fx: "snapwire",
    x: staleTarget.x - 30,
    y: staleTarget.y,
    x2: staleTarget.x + 30,
    y2: staleTarget.y,
    width: 14,
    arm: 0,
    life: 5,
    maxLife: 5,
    damage: 9,
  }];
  const staleHp = staleTarget.hp;
  stepN(staleWorld, 1, new Map());
  check("dead-owner entities are inert even if encountered during an active update pass",
    staleWorld.props[0].hp === 20
    && staleTarget.hp === staleHp
    && staleWorld.bullets.every((bullet) => bullet.owner !== deadOwner.id)
    && staleWorld.effects.every((effect) => effect.owner !== deadOwner.id));
}

// ---------------------------------------------------------------------------------------------
section("B6: a pvp snapshot forces cleared=false + no exit-ready; co-op is unchanged");
{
  const w = pvpWorld(70, ["p1", "p2"]);
  advanceToLive(w);
  check("the pvp arena has zero enemies (co-op would call this 'cleared')", w.enemies.length === 0 && w.pendingSpawns.length === 0);
  check("B6: isFloorCleared is false in pvp", !isFloorCleared(w));
  check("B6: playersAtExit is empty in pvp", playersAtExit(w).length === 0);
  const snap = snapOf(w, "p1");
  check("B6: the snapshot projects cleared=false in pvp", snap.cleared === false);
  check("B6: the snapshot projects exr=[] in pvp (no exit-ready leak)", snap.exr.length === 0);
  // A player parked exactly on the arena exit tile is STILL never exit-ready in pvp.
  const p1 = w.players.get("p1")!;
  p1.x = w.dungeon.exit.x * TILE + TILE / 2; p1.y = w.dungeon.exit.y * TILE + TILE / 2;
  check("B6: a player on the exit tile is still not exit-ready in pvp", playersAtExit(w).length === 0 && snapOf(w, "p1").exr.length === 0);

  // Co-op is untouched: a zero-enemy floor still reads cleared and lists players at the exit.
  const coop = createWorld(70, 1, { isShared: true, skipLocalPlayer: true });
  spawnPlayerInWorld(coop, "c1");
  coop.enemies.length = 0; coop.pendingSpawns.length = 0;
  check("B6: a co-op zero-enemy floor still reads cleared (unchanged)", isFloorCleared(coop));
  const c1 = coop.players.get("c1")!;
  c1.x = coop.dungeon.exit.x * TILE + TILE / 2; c1.y = coop.dungeon.exit.y * TILE + TILE / 2;
  check("B6: co-op still lists a player standing at the exit (unchanged)", playersAtExit(coop).length === 1);
}

// ---------------------------------------------------------------------------------------------
section("H1: an absent seat reads NOT alive on the wire scoreboard");
{
  const w = pvpWorld(71, ["p1", "p2", "p3"]);
  advanceToLive(w);
  setPlayerAbsence(w, "p2", true); // present stays 2 -> match live, isolates the projection
  const dec = jsonCodec.decodeServer(jsonCodec.encodeServer(snapOf(w, "p1")));
  if (dec.t !== "snap" || dec.match === null) { check("snapshot carries a match block", false); }
  else {
    check("H1: an absent seat is marked NOT alive", dec.match.sc.find((s) => s.id === "p2")?.a === false);
    check("H1: a present live seat is still marked alive", dec.match.sc.find((s) => s.id === "p3")?.a === true);
  }
}

// ---------------------------------------------------------------------------------------------
section("H2: a removed player leaves no stale scoreboard/history; a rejoin is fresh");
{
  const w = pvpWorld(72, ["p1", "p2", "p3"]);
  advanceToLive(w);
  w.match!.scores.set("p2", 5);
  check("p2 has frags + lag-comp history before leaving", (w.match!.scores.get("p2") ?? 0) === 5 && w.playerHist.has("p2"));
  removePlayerFromWorld(w, "p2"); // present stays 2 (p1,p3) -> match continues, isolating the cleanup
  check("H2: the match stays live (3p -> 2p, above min)", w.match!.phase === "live");
  check("H2: the removed player's frags are dropped from the scoreboard", !w.match!.scores.has("p2"));
  check("H2: the removed player's lag-comp history is dropped", !w.playerHist.has("p2"));
  spawnPlayerInWorld(w, "p2");
  check("H2: a rejoining player starts at zero frags (no stale restore)", (w.match!.scores.get("p2") ?? 0) === 0);
}

// ---------------------------------------------------------------------------------------------
section("FFA foe predicate");
{
  check("distinct FFA players (team 0) are foes", arePvpFoes({ team: 0, id: "a" }, { team: 0, id: "b" }));
  check("a player is never their own foe", !arePvpFoes({ team: 0, id: "a" }, { team: 0, id: "a" }));
  check("same non-zero team are NOT foes (future team modes)", !arePvpFoes({ team: 1, id: "a" }, { team: 1, id: "b" }));
  check("different non-zero teams are foes", arePvpFoes({ team: 1, id: "a" }, { team: 2, id: "b" }));
}

// ---------------------------------------------------------------------------------------------
process.stdout.write(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(failures.map((f) => "  - " + f).join("\n") + "\n");
  process.exit(1);
}
