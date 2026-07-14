// PVP (free-for-all arena deathmatch) sim suite — the gate-able P1 core.
//
// Proves the four mode-gated concerns and the balancer's combat model, all in the PURE sim:
//   - DAMAGE TARGETING: an owned round/swing hits a NON-OWNER foe (co-op passes friendly through);
//     every hit routes through the ONE damagePlayer funnel with `by` attribution.
//   - NO AI / ARENA: the symmetric buildPvpArena() (fair, point-symmetric, spread spawns).
//   - SPAWNS: id-sorted spread placement + break-on-fire spawn i-frames.
//   - MATCH: the tick-based FRAG-LIMIT RESPAWN state machine (lobby->countdown->live->over),
//     deterministic + reconnect-stable winner, respawn (never elimination).
// Plus the balancer numbers (fixed 100 HP, global 1.78x + per-weapon outliers, 35% per-hit cap,
// per-weapon TTK band) and the NO-SNOWBALL guard (ults off, zero in-match power gain).
//
// Run: npm run test:pvp

import {
  createWorld, stepWorld, spawnPlayerInWorld, setPlayerAbsence, isPvp, applyItemToWorld,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import {
  PVP, buildPvpArena, pvpArenaRot90, pvpHitDamage, pvpPerHitCap, pvpFragLimit, farthestSpawnIndex, arePvpFoes,
  pvpRespawnDelayTicks, pvpCountdownTicks, pvpEnvKillCreditWindowTicks, pvpChainWindowTicks,
  pvpDraftEveryTicks, pvpDraftSeed, pvpBlessingBlacklist, pvpComebackTierBump,
} from "../src/sim/pvp.js";
import type { Vec2 } from "../src/sim/types.js";
import { WEAPONS } from "../src/sim/weapons.js";
import { ULT } from "../src/sim/kits.js";
import { TILE } from "../src/sim/types.js";
import { WEAPON_KB } from "../src/sim/constants.js";
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

// Drop two players next to each other on a CLEAR horizontal lane of the 19x19 arena (row 4 has
// no cover props), protection cleared, `a` facing `b` (straight right). Returns the aim angle.
function faceOff(a: PlayerSim, b: PlayerSim, gap: number): number {
  a.x = 300; a.y = 216; a.invuln = 0; // tile (6,4)
  b.x = 300 + gap; b.y = 216; b.invuln = 0;
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
  check("spawn iframe = 2.0s", PVP.spawnIframeSec === 2.0);
  check("player knockback constants are exact", PVP.kbScalar === 1.0 && PVP.kbMaxPerHit === 180 && PVP.kbSelfDuringIframe === 0);
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
  const { dungeon, spawns, cover, pits } = buildPvpArena();
  check("arena is the authoritative 19x19 square", dungeon.w === 19 && dungeon.h === 19);
  check("arena has 8 spawn candidates (full FFA)", spawns.length === 8, `${spawns.length}`);
  check("arena has 12 breakable cover pieces after four inner cells become pits", cover.length === 12, `${cover.length}`);
  check("arena has four sparse lethal pits", pits.length === 4, `${pits.length}`);
  check("spawns are all distinct (maximally spread)", new Set(spawns.map((s) => `${s.x},${s.y}`)).size === spawns.length);

  // 4-fold rotational symmetry (provably fair): the wall grid, the spawn set, and the cover set
  // are each invariant under a 90 degree rotation.
  const key = (p: Vec2) => `${Math.round(p.x)},${Math.round(p.y)}`;
  const spawnSet = new Set(spawns.map(key));
  const coverSet = new Set(cover.map(key));
  const pitSet = new Set(pits.map(key));
  const spawnsSymmetric = spawns.every((s) => spawnSet.has(key(pvpArenaRot90(s))));
  const coverSymmetric = cover.every((c) => coverSet.has(key(pvpArenaRot90(c))));
  const pitsSymmetric = pits.every((pit) => pitSet.has(key(pvpArenaRot90(pit))));
  check("spawns are invariant under 90 rotation", spawnsSymmetric);
  check("cover is invariant under 90 rotation", coverSymmetric);
  check("pits are invariant under 90 rotation", pitsSymmetric);
  check("pits are disjoint from every spawn", pits.every((pit) => !spawnSet.has(key(pit))));
  const minPitSpawnTiles = Math.min(...pits.flatMap((pit) =>
    spawns.map((spawn) => Math.hypot(pit.x - spawn.x, pit.y - spawn.y) / TILE)
  ));
  check("every pit stays at least three tiles from every spawn", minPitSpawnTiles >= 3, `min=${minPitSpawnTiles.toFixed(2)}`);
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

  // Break-on-fire: a respawn-protected player who fires drops protection immediately.
  const w = pvpWorld(5, ["p1", "p2"]);
  advanceToLive(w);
  const p1 = w.players.get("p1")!;
  p1.invuln = PVP.spawnIframeSec;
  stepN(w, 1, new Map([["p1", inp({ firing: true, aim: 0 })]]));
  check("first outgoing attack breaks spawn protection", p1.invuln === 0);

  // Spawn protection blocks incoming damage (no instant re-death).
  const w2 = pvpWorld(6, ["p1", "p2"]);
  advanceToLive(w2);
  const s2 = w2.players.get("p1")!; const v2 = w2.players.get("p2")!;
  const aim2 = faceOff(s2, v2, 60);
  v2.invuln = PVP.spawnIframeSec; // victim freshly (re)spawned
  s2.weapon = "pistol"; s2.ownedWeapons = ["pistol"];
  stepN(w2, 20, new Map([["p1", inp({ firing: true, aim: aim2 })]]));
  check("spawn i-frames prevent instant re-death", v2.hp === PVP.maxHp, `hp=${v2.hp}`);

  // farthestSpawnIndex is deterministic and avoids an occupied spawn.
  const occupied = [spawns[0]];
  const idx = farthestSpawnIndex(spawns, occupied);
  check("respawn picks a spawn away from occupants", idx !== 0);

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
}

// ---------------------------------------------------------------------------------------------
section("PLAYER KNOCKBACK: weapon impulse, hard clamp, and iframe immunity");
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

  const protectedWorld = pvpWorld(61, ["p1", "p2"]);
  advanceToLive(protectedWorld);
  const protectedShooter = protectedWorld.players.get("p1")!;
  const protectedVictim = protectedWorld.players.get("p2")!;
  const protectedAim = faceOff(protectedShooter, protectedVictim, 60);
  protectedShooter.weapon = "railgun";
  protectedShooter.ownedWeapons = ["railgun"];
  protectedVictim.invuln = PVP.spawnIframeSec;
  const protectedX = protectedVictim.x;
  const protectedY = protectedVictim.y;
  stepN(protectedWorld, 12, new Map([["p1", inp({ firing: true, aim: protectedAim })]]));
  check("spawn-iframe player takes zero knockback",
    protectedVictim.x === protectedX && protectedVictim.y === protectedY);
}

// ---------------------------------------------------------------------------------------------
section("LETHAL PITS: ring-out, bounded credit, and iframe safety");
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
    && (expired.match!.scores.get("p1") ?? 0) === 0);

  const protectedWorld = pvpWorld(64, ["p1", "p2"]);
  advanceToLive(protectedWorld);
  const protectedPlayer = protectedWorld.players.get("p2")!;
  protectedPlayer.x = pit.x;
  protectedPlayer.y = pit.y;
  protectedPlayer.invuln = PVP.spawnIframeSec;
  stepN(protectedWorld, 1, new Map());
  check("an iframe player standing over a pit is not spawn-locked",
    protectedPlayer.hp === PVP.maxHp && protectedPlayer.respawnT === 0);
  protectedPlayer.invuln = 0;
  const ringEvents = stepCollect(protectedWorld, 1, new Map());
  check("the same pit kills immediately once protection ends",
    protectedPlayer.respawnT > 0 && ringEvents.some((event) => event.t === "pvpRingOut"));
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
  stepN(w, respawnCd + 2, new Map()); // stop firing; let the respawn resolve
  check("the player respawns at full HP after the delay", victim.hp === PVP.maxHp && victim.respawnT === 0);
  check("respawn arms fresh spawn protection", victim.invuln > 0);
  check("respawn delay matches the named constant", Math.abs(respawnCd - pvpRespawnDelayTicks()) <= 1);
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
      return `${id}:${p.x.toFixed(3)},${p.y.toFixed(3)},${p.hp.toFixed(3)},${p.respawnT},${p.invuln.toFixed(3)}#${w.match!.scores.get(id) ?? 0}`;
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

// ---------------------------------------------------------------------------------------------
section("DETERMINISM EDGE-CASES: self-immune, same-tick order-stable, no shoot-from-iframe");
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

  // NO SHOOT-FROM-IFRAME: spawn protection blocks INCOMING fire while active, then drops the
  // instant the protected player fires — so they can never peek-shoot from invuln.
  {
    const w = pvpWorld(52, ["p1", "p2"]);
    advanceToLive(w);
    const s = w.players.get("p1")!; const foe = w.players.get("p2")!;
    s.x = 300; s.y = 216; s.weapon = "pistol"; s.ownedWeapons = ["pistol"];
    s.invuln = PVP.spawnIframeSec; // freshly respawned, protected
    foe.x = 360; foe.y = 216; foe.invuln = 0; foe.weapon = "pistol"; foe.ownedWeapons = ["pistol"];
    stepN(w, 6, new Map([["p2", inp({ firing: true, aim: Math.PI })]])); // foe fires; s idle + protected
    check("iframed player takes no incoming damage while protected", s.hp === PVP.maxHp && s.invuln > 0, `hp=${s.hp} inv=${s.invuln.toFixed(2)}`);
    stepN(w, 1, new Map([["p1", inp({ firing: true, aim: 0 })], ["p2", inp({ firing: true, aim: Math.PI })]]));
    check("firing drops the iframe the instant the shot goes out", s.invuln === 0);
    const before = s.hp;
    stepN(w, 8, new Map([["p2", inp({ firing: true, aim: Math.PI })]]));
    check("after firing, the player is immediately vulnerable (no shoot-from-invuln)", s.hp < before, `hp=${s.hp}`);
  }
}

// ---------------------------------------------------------------------------------------------
section("P2 WIRE: protocol v29, match block + team + respawn round-trip, reliable events");
{
  check("PROTOCOL_VERSION bumped to 29", PROTOCOL_VERSION === 29);

  // A pvp snapshot round-trips the match block, per-player team, and the local respawn field.
  const w = pvpWorld(30, ["p1", "p2"]);
  advanceToLive(w);
  w.match!.scores.set("p1", 4);
  w.match!.scores.set("p2", 2);
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
  }

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
      { id: 3, e: { t: "pvpSuddenDeath", leader: "p1" } as const },
    ],
  };
  const eventRoundTrip = jsonCodec.decodeServer(jsonCodec.encodeServer(eventSnap));
  check("Wave 1 ring-out, chain, and crescendo events round-trip reliably",
    eventRoundTrip.t === "snap"
    && eventRoundTrip.events.map((entry) => entry.e.t).join(",")
      === "pvpRingOut,pvpChainFrag,pvpSuddenDeath");
}

// ---------------------------------------------------------------------------------------------
section("FFA foe predicate");
{
  check("distinct FFA players (team 0) are foes", arePvpFoes(0, "a", 0, "b"));
  check("a player is never their own foe", !arePvpFoes(0, "a", 0, "a"));
  check("same non-zero team are NOT foes (future team modes)", !arePvpFoes(1, "a", 1, "b"));
  check("different non-zero teams are foes", arePvpFoes(1, "a", 2, "b"));
}

// ---------------------------------------------------------------------------------------------
process.stdout.write(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(failures.map((f) => "  - " + f).join("\n") + "\n");
  process.exit(1);
}
