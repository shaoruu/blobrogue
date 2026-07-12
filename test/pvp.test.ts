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
  createWorld, stepWorld, spawnPlayerInWorld, setPlayerAbsence, isPvp,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import {
  PVP, buildPvpArena, pvpArenaRot90, pvpHitDamage, pvpPerHitCap, pvpFragLimit, farthestSpawnIndex, arePvpFoes,
  pvpRespawnDelayTicks, pvpCountdownTicks,
} from "../src/sim/pvp.js";
import type { Vec2 } from "../src/sim/types.js";
import { WEAPONS } from "../src/sim/weapons.js";
import { ULT } from "../src/sim/kits.js";
import { TILE } from "../src/sim/types.js";
import type { InputCmd } from "../src/sim/input.js";
import type { SimEvent } from "../src/sim/events.js";
import { buildSnapshot, jsonCodec, validateSnap, PROTOCOL_VERSION } from "../src/net/protocol.js";
import type { ServerMsg } from "../src/net/protocol.js";
import { diffSnapshot, applySnapshotDelta, snapshotToWire } from "../src/net/snapshotDelta.js";

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
  // pistol: 2 base * 1.78 (no outlier entry).
  check("pistol hit = base*dmgMult", Math.abs(pvpHitDamage("pistol", WEAPONS.pistol.damage) - WEAPONS.pistol.damage * PVP.dmgMult) < 1e-9);
  // outliers stack ON TOP of the global scalar.
  check("sawnoff outlier 0.45 stacks on the scalar", Math.abs(pvpHitDamage("sawnoff", WEAPONS.sawnoff.damage) - WEAPONS.sawnoff.damage * PVP.dmgMult * 0.45) < 1e-9);
  check("spear outlier 0.85 stacks on the scalar", Math.abs(pvpHitDamage("spear", WEAPONS.spear.damage) - WEAPONS.spear.damage * PVP.dmgMult * 0.85) < 1e-9);
  // Frag limit scales with the match-start player count: clamp(round(6+count), 8, 16).
  check("fragLimit scales 2p->8, 4p->10, 6p->12", pvpFragLimit(2) === 8 && pvpFragLimit(4) === 10 && pvpFragLimit(6) === 12);
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
section("SPAWNS: symmetric 19x19 arena + spread + break-on-fire protection");
{
  const { dungeon, spawns, cover } = buildPvpArena();
  check("arena is the authoritative 19x19 square", dungeon.w === 19 && dungeon.h === 19);
  check("arena has 8 spawn candidates (full FFA)", spawns.length === 8, `${spawns.length}`);
  check("arena has 16 breakable cover pieces", cover.length === 16, `${cover.length}`);
  check("spawns are all distinct (maximally spread)", new Set(spawns.map((s) => `${s.x},${s.y}`)).size === spawns.length);

  // 4-fold rotational symmetry (provably fair): the wall grid, the spawn set, and the cover set
  // are each invariant under a 90 degree rotation.
  const key = (p: Vec2) => `${Math.round(p.x)},${Math.round(p.y)}`;
  const spawnSet = new Set(spawns.map(key));
  const coverSet = new Set(cover.map(key));
  const spawnsSymmetric = spawns.every((s) => spawnSet.has(key(pvpArenaRot90(s))));
  const coverSymmetric = cover.every((c) => coverSet.has(key(pvpArenaRot90(c))));
  check("spawns are invariant under 90 rotation", spawnsSymmetric);
  check("cover is invariant under 90 rotation", coverSymmetric);
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
section("P2 WIRE: protocol v28, match block + team + respawn round-trip, reliable events");
{
  check("PROTOCOL_VERSION bumped to 28", PROTOCOL_VERSION === 28);

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
