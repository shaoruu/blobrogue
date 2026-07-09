// Dynamic-prop navigation suite: reproduces the live "enemies wedge on barrels/chests/
// props" reports as deterministic scenarios and locks the routing contract:
//
//  - every ground chaser REACHES its target in bounded time through a single prop, a
//    chest+wall corner, a 3-prop row, a concave U pocket, and dense random prop fields
//    (seed sweep) — with no >0.5s wedge and no wall/prop-ring penetration on any tick;
//  - routes are deterministic (identical position streams across two fresh runs);
//  - breaking an obstacle bumps the obstacle revision and SHORTENS the route mid-run;
//  - clearance classes respect body radius: a swarm body threads a gap a brute must
//    route around;
//  - every floor/reinforcement/split/boss-add spawn lands body-clear (walls, prop rings,
//    chest footprints) on a tile reachable from the player spawn — verified against an
//    independent BFS oracle, across seeds, floors and the boss arena;
//  - a perf gate: 50 enemies + 50 props stay far under the server tick budget.
//
// Run: npm run test:nav

import { createWorld, stepWorld, devSpawnEnemy, devSpawnProp, devSpawnChest } from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import type { Dungeon } from "../src/sim/dungeon.js";
import { createEnemy, ENEMY_ARCHETYPES } from "../src/sim/enemies.js";
import type { Enemy, Prop, PropKind } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { InputCmd, PlayerId } from "../src/sim/input.js";
import { PROP_BLOCK_RING } from "../src/sim/constants.js";
import { NAV_CLASS_RADII } from "../src/sim/nav.js";
import { Rng } from "../src/sim/rng.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

const DT = 1 / 20; // authoritative server tick
const IDLE: InputCmd = { seq: 0, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };
const idleInputs = new Map<PlayerId, InputCmd>([[LOCAL_ID, IDLE]]);

// Wedge contract: no chaser may make < WEDGE_TOL px of net progress over any window
// longer than 0.5s while still out of contact. 11 ticks at 20Hz = 0.55s; 3px tolerates
// the slime hop pulse's slow beat with a wide margin.
const WEDGE_WINDOW = 11;
const WEDGE_TOL = 3;

function tileCenter(tx: number, ty: number): { x: number; y: number } {
  return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
}

function sandbox(seed: number): WorldState {
  const w = createWorld(seed, 1, { isSandbox: true });
  w.isGodMode = true; // the stationary target must survive contact for the whole run
  return w;
}

function placePlayer(w: WorldState, x: number, y: number): void {
  const p = w.players.get(LOCAL_ID)!;
  p.x = x;
  p.y = y;
}

function propAtTile(w: WorldState, kind: PropKind, tx: number, ty: number): void {
  const c = tileCenter(tx, ty);
  devSpawnProp(w, kind, c.x, c.y);
}

// A lethal planted bullet resolves through the ordinary updateProps path on the next
// step — the REAL prop-destruction door (obstacle revision bump included).
function plantPropBreaker(w: WorldState, p: Prop): void {
  w.bullets.push({
    x: p.x, y: p.y, vx: 1, vy: 0, radius: 12, life: 0.06, friendly: true,
    owner: LOCAL_ID, damage: 500, color: "#fff", pierce: 0, hitList: null, isCrit: false,
  });
}

function contactDist(w: WorldState, e: Enemy): number {
  const p = w.players.get(LOCAL_ID)!;
  return Math.hypot(p.x - e.x, p.y - e.y) - (p.pr + e.radius);
}

// Engine invariants asserted on every tick of every run: an enemy center never inside a
// wall tile, an enemy body never inside a live prop's collision ring. Ghosts phase by
// design and are exempt.
function penetrationError(w: WorldState): string | null {
  for (const e of w.enemies) {
    if (e.dead || ENEMY_ARCHETYPES[e.kind].isPhasing) continue;
    const tx = Math.floor(e.x / TILE), ty = Math.floor(e.y / TILE);
    if (tx < 0 || ty < 0 || tx >= w.dungeon.w || ty >= w.dungeon.h || w.dungeon.tiles[ty * w.dungeon.w + tx] === 1) {
      return `enemy ${e.id} (${e.kind}) center in wall tile ${tx},${ty}`;
    }
    for (const p of w.props) {
      if (p.dead) continue;
      const rr = e.radius + p.radius * PROP_BLOCK_RING;
      if (Math.hypot(e.x - p.x, e.y - p.y) < rr - 1e-6) {
        return `enemy ${e.id} (${e.kind}) inside prop ${p.id} ring`;
      }
    }
  }
  return null;
}

interface RunResult {
  reachedTick: Map<number, number>; // enemy id -> tick it entered contact range
  wedged: Map<number, number>;      // enemy id -> first tick a >0.5s stall was seen
  penetration: string | null;
  trails: Map<number, { xs: number[]; ys: number[] }>;
}

// Step until every tracked enemy has touched the target (or maxTicks), recording
// per-enemy trails, wedge windows and penetration. `wedgeKinds` limits the stall
// contract to kinds with no authored stationary phases (a skeleton's windup/recover
// stands still by design; that is a telegraph, not a wedge). The target is re-pinned
// every tick: god mode blocks damage but not the skeleton's lunge shove, and a drifting
// target would make every reach bound meaningless.
function runChase(w: WorldState, maxTicks: number, wedgeKinds: readonly string[], onTick?: (tick: number) => void): RunResult {
  const res: RunResult = { reachedTick: new Map(), wedged: new Map(), penetration: null, trails: new Map() };
  for (const e of w.enemies) res.trails.set(e.id, { xs: [e.x], ys: [e.y] });
  const target = w.players.get(LOCAL_ID)!;
  const pinX = target.x, pinY = target.y;
  for (let tick = 0; tick < maxTicks; tick++) {
    onTick?.(tick);
    target.x = pinX;
    target.y = pinY;
    stepWorld(w, idleInputs, DT);
    if (res.penetration === null) res.penetration = penetrationError(w);
    let isAllReached = true;
    for (const e of w.enemies) {
      if (e.dead) continue;
      const trail = res.trails.get(e.id);
      if (!trail) continue;
      trail.xs.push(e.x);
      trail.ys.push(e.y);
      if (!res.reachedTick.has(e.id)) {
        if (contactDist(w, e) <= 2) {
          res.reachedTick.set(e.id, tick);
        } else {
          isAllReached = false;
          const n = trail.xs.length - 1;
          if (wedgeKinds.includes(e.kind) && n >= WEDGE_WINDOW && !res.wedged.has(e.id)) {
            const moved = Math.hypot(trail.xs[n] - trail.xs[n - WEDGE_WINDOW], trail.ys[n] - trail.ys[n - WEDGE_WINDOW]);
            if (moved < WEDGE_TOL) res.wedged.set(e.id, tick);
          }
        }
      }
    }
    if (isAllReached && res.reachedTick.size === res.trails.size) break;
  }
  return res;
}

function firstEnemy(w: WorldState): Enemy {
  return w.enemies[0];
}

// ---- case 1: single barrel dead on the chase line ----

function singleBarrelCase(): void {
  section("single barrel: chaser rounds it, reaches in bounded time, never wedges");
  const build = (): WorldState => {
    const w = sandbox(0xA11CE);
    placePlayer(w, tileCenter(17, 12).x, tileCenter(17, 12).y);
    propAtTile(w, "barrel", 19, 12);
    devSpawnEnemy(w, "slime", tileCenter(23, 12).x, tileCenter(23, 12).y);
    return w;
  };
  const w = build();
  const res = runChase(w, 300, ["slime"]);
  check("slime reached the player through the barrel line", res.reachedTick.has(firstEnemy(w).id), `ticks=${res.reachedTick.get(firstEnemy(w).id)}`);
  check("no >0.5s wedge", res.wedged.size === 0);
  check("no wall/prop penetration", res.penetration === null, res.penetration ?? "");

  const w2 = build();
  const res2 = runChase(w2, 300, ["slime"]);
  const t1 = res.trails.get(firstEnemy(w).id)!;
  const t2 = res2.trails.get(firstEnemy(w2).id)!;
  check("route deterministic across fresh runs", JSON.stringify(t1) === JSON.stringify(t2));
}

// ---- case 2: chest wedged into a wall corner (the live report) ----

function chestWallCornerCase(): void {
  section("chest + wall corner: chests never block routes; props at the corner are rounded");
  const w = sandbox(0xC0FFEE);
  const corner = tileCenter(1, 1);
  placePlayer(w, corner.x, corner.y);
  devSpawnChest(w, tileCenter(2, 1).x, tileCenter(2, 1).y); // on the only open lane
  propAtTile(w, "barrel", 1, 2);
  propAtTile(w, "crate", 2, 2); // south + diagonal approaches sealed by props
  const start = tileCenter(12, 1);
  const slime = devSpawnEnemy(w, "slime", start.x, start.y);
  let didCrossChest = false;
  const res = runChase(w, 600, ["slime"], () => {
    if (Math.floor(slime.x / TILE) === 2 && Math.floor(slime.y / TILE) === 1) didCrossChest = true;
  });
  check("slime reached the cornered player", res.reachedTick.has(slime.id), `ticks=${res.reachedTick.get(slime.id)}`);
  check("route ran OVER the chest tile (chests are not obstacles)", didCrossChest);
  check("no >0.5s wedge", res.wedged.size === 0);
  check("no wall/prop penetration", res.penetration === null, res.penetration ?? "");
}

// ---- case 3: a solid 3-prop row across the chase line ----

function threePropRowCase(): void {
  section("3-prop row: the route commits around an end instead of grinding the middle");
  const w = sandbox(0xB0BB1E);
  placePlayer(w, tileCenter(17, 12).x, tileCenter(17, 12).y);
  propAtTile(w, "barrel", 20, 11);
  propAtTile(w, "barrel", 20, 12);
  propAtTile(w, "barrel", 20, 13);
  const slime = devSpawnEnemy(w, "slime", tileCenter(23, 12).x, tileCenter(23, 12).y);
  const res = runChase(w, 400, ["slime"]);
  check("slime reached through the row", res.reachedTick.has(slime.id), `ticks=${res.reachedTick.get(slime.id)}`);
  check("no >0.5s wedge", res.wedged.size === 0);
  check("no wall/prop penetration", res.penetration === null, res.penetration ?? "");
  const trail = res.trails.get(slime.id)!;
  let maxDy = 0;
  for (const y of trail.ys) maxDy = Math.max(maxDy, Math.abs(y - 600));
  check("route detoured around a row end (real lateral excursion)", maxDy > 60, `maxDy=${maxDy.toFixed(1)}`);
}

// ---- case 4: concave U pocket opening toward the enemy ----

function uPocketCase(): void {
  section("U pocket: the classic local-steering trap — the route never enters the dead end");
  const w = sandbox(0xDEADD);
  placePlayer(w, tileCenter(16, 12).x, tileCenter(16, 12).y);
  // Back column + two arms, opening EAST toward the approaching enemy.
  for (let ty = 10; ty <= 14; ty++) propAtTile(w, "barrel", 18, ty);
  for (const tx of [19, 20]) { propAtTile(w, "barrel", tx, 10); propAtTile(w, "barrel", tx, 14); }
  const slime = devSpawnEnemy(w, "slime", tileCenter(23, 12).x, tileCenter(23, 12).y);
  let didEnterPocket = false;
  const res = runChase(w, 500, ["slime"], () => {
    const tx = Math.floor(slime.x / TILE), ty = Math.floor(slime.y / TILE);
    if (tx >= 19 && tx <= 20 && ty >= 11 && ty <= 13) didEnterPocket = true;
  });
  check("slime reached the player behind the pocket", res.reachedTick.has(slime.id), `ticks=${res.reachedTick.get(slime.id)}`);
  check("route never entered the concave pocket", !didEnterPocket);
  check("no >0.5s wedge", res.wedged.size === 0);
  check("no wall/prop penetration", res.penetration === null, res.penetration ?? "");
}

// ---- case 5: dense random prop fields, seed sweep ----

function denseSweepCase(): void {
  section("dense random props (12 seeds): slime + bat + skeleton all reach; zero wedges/penetration");
  let isAllReached = true;
  let anyWedge = "";
  let anyPenetration = "";
  for (let seedIdx = 0; seedIdx < 12; seedIdx++) {
    const w = sandbox(0x5EED + seedIdx);
    placePlayer(w, tileCenter(17, 12).x, tileCenter(17, 12).y);
    const rng = new Rng(0xFACADE + seedIdx * 7919);
    const used = new Set<number>();
    let placedCount = 0;
    while (placedCount < 14) {
      const tx = 2 + rng.int(0, 29);
      const ty = 2 + rng.int(0, 19);
      const idx = ty * w.dungeon.w + tx;
      if (used.has(idx)) continue;
      used.add(idx);
      // Keep the target and the three start corners clear so the scenario is well-posed.
      if (Math.abs(tx - 17) <= 2 && Math.abs(ty - 12) <= 2) continue;
      if ((Math.abs(tx - 30) <= 1 || Math.abs(tx - 2) <= 1) && (Math.abs(ty - 20) <= 1 || Math.abs(ty - 2) <= 1)) continue;
      propAtTile(w, rng.chance(0.5) ? "barrel" : "crate", tx, ty);
      placedCount++;
    }
    devSpawnEnemy(w, "slime", tileCenter(30, 20).x, tileCenter(30, 20).y);
    devSpawnEnemy(w, "bat", tileCenter(30, 2).x, tileCenter(30, 2).y);
    devSpawnEnemy(w, "skeleton", tileCenter(2, 20).x, tileCenter(2, 20).y);
    const res = runChase(w, 700, ["slime", "bat"]);
    if (res.reachedTick.size !== 3) { isAllReached = false; process.stdout.write(`    seed ${seedIdx}: reached ${res.reachedTick.size}/3\n`); }
    if (res.wedged.size > 0 && !anyWedge) anyWedge = `seed ${seedIdx}`;
    if (res.penetration && !anyPenetration) anyPenetration = `seed ${seedIdx}: ${res.penetration}`;
  }
  check("all chasers reached across every seed", isAllReached);
  check("no >0.5s wedge in any seed", anyWedge === "", anyWedge);
  check("no wall/prop penetration in any seed", anyPenetration === "", anyPenetration);

  // Determinism spot check on one dense seed: two fresh worlds, identical streams.
  const runOnce = (): string => {
    const w = sandbox(0x5EED + 5);
    placePlayer(w, tileCenter(17, 12).x, tileCenter(17, 12).y);
    const rng = new Rng(0xFACADE + 5 * 7919);
    const used = new Set<number>();
    let placedCount = 0;
    while (placedCount < 14) {
      const tx = 2 + rng.int(0, 29);
      const ty = 2 + rng.int(0, 19);
      const idx = ty * w.dungeon.w + tx;
      if (used.has(idx)) continue;
      used.add(idx);
      if (Math.abs(tx - 17) <= 2 && Math.abs(ty - 12) <= 2) continue;
      if ((Math.abs(tx - 30) <= 1 || Math.abs(tx - 2) <= 1) && (Math.abs(ty - 20) <= 1 || Math.abs(ty - 2) <= 1)) continue;
      propAtTile(w, rng.chance(0.5) ? "barrel" : "crate", tx, ty);
      placedCount++;
    }
    devSpawnEnemy(w, "slime", tileCenter(30, 20).x, tileCenter(30, 20).y);
    devSpawnEnemy(w, "bat", tileCenter(30, 2).x, tileCenter(30, 2).y);
    const stream: number[] = [];
    for (let t = 0; t < 300; t++) {
      stepWorld(w, idleInputs, DT);
      for (const e of w.enemies) stream.push(e.x, e.y);
    }
    return JSON.stringify(stream);
  };
  check("dense-seed position streams identical across fresh runs", runOnce() === runOnce());
}

// ---- case 6: breaking an obstacle re-routes and shortens the path ----

function obstacleBreakCase(): void {
  section("obstacle break: revision invalidates the route; the gap shortens time-to-target");
  const build = (): { w: WorldState; slime: Enemy; mid: Prop } => {
    const w = sandbox(0xB4EA4);
    placePlayer(w, tileCenter(17, 12).x, tileCenter(17, 12).y);
    for (let ty = 10; ty <= 14; ty++) propAtTile(w, "barrel", 20, ty);
    const mid = w.props[2]; // the ty=12 barrel, dead on the line
    const slime = devSpawnEnemy(w, "slime", tileCenter(25, 12).x, tileCenter(25, 12).y);
    return { w, slime, mid };
  };

  const intact = build();
  const resIntact = runChase(intact.w, 700, ["slime"]);
  const intactTicks = resIntact.reachedTick.get(intact.slime.id);
  check("intact row: slime reached around the row", intactTicks !== undefined, `ticks=${intactTicks}`);

  const broken = build();
  const revBefore = broken.w.obstacleRev;
  const resBroken = runChase(broken.w, 700, ["slime"], (tick) => {
    if (tick === 40) plantPropBreaker(broken.w, broken.mid); // 2s in: mid-route re-plan
  });
  const brokenTicks = resBroken.reachedTick.get(broken.slime.id);
  check("mid-row break: slime reached", brokenTicks !== undefined, `ticks=${brokenTicks}`);
  check("prop break bumped the obstacle revision", broken.w.obstacleRev > revBefore, `rev ${revBefore} -> ${broken.w.obstacleRev}`);
  check("broken route is decisively shorter", brokenTicks !== undefined && intactTicks !== undefined && brokenTicks + 30 < intactTicks,
    `intact=${intactTicks} broken=${brokenTicks}`);
  check("no wedge in either run", resIntact.wedged.size === 0 && resBroken.wedged.size === 0);
}

// ---- case 7: clearance classes respect body radius ----

function radiiCase(): void {
  section("different radii: a swarm body threads the gap a brute must route around");
  const w = sandbox(0x512E);
  placePlayer(w, tileCenter(17, 12).x, tileCenter(17, 12).y);
  // Two off-center props leave a 60px-center gap at y=600: free lane 36px — enough for a
  // swarm slime body (r~12.5), impossible for a brute (r~20.8).
  devSpawnProp(w, "barrel", 984, 570);
  devSpawnProp(w, "barrel", 984, 630);
  const start = tileCenter(23, 12);
  const swarm = createEnemy("slime", start.x, start.y, w.floor, w.rng, w.nextEnemyId++, { tier: "swarm" });
  const brute = createEnemy("slime", start.x, start.y + 2, w.floor, w.rng, w.nextEnemyId++, { tier: "brute" });
  w.enemies.push(swarm, brute);
  let didSwarmThread = false;
  let bruteMaxDy = 0;
  let didBruteEnterGap = false;
  const res = runChase(w, 800, ["slime"], () => {
    if (Math.abs(swarm.x - 984) < 10 && Math.abs(swarm.y - 600) < 14) didSwarmThread = true;
    if (Math.abs(brute.x - 984) < 30) {
      bruteMaxDy = Math.max(bruteMaxDy, Math.abs(brute.y - 600));
      if (Math.hypot(brute.x - 984, brute.y - 600) < 24) didBruteEnterGap = true;
    }
  });
  check("both bodies reached the player", res.reachedTick.size === 2, `reached=${res.reachedTick.size}/2`);
  check("swarm slime threaded the 36px gap", didSwarmThread);
  check("brute slime detoured around the barrier end", bruteMaxDy > 60 && !didBruteEnterGap, `maxDy=${bruteMaxDy.toFixed(1)}`);
  check("no wall/prop penetration", res.penetration === null, res.penetration ?? "");
}

// ---- case 8: spawn placement — body clearance + reachability across real floors ----

// Independent oracle: 4-neighbor BFS over tiles whose centers a body of the routing
// class can stand on (walls + live prop rings), from the floor spawn tile. Mirrors the
// clearance-class contract (radius clamps to the largest class) without sharing any
// sim code.
function oracleReachable(d: Dungeon, props: readonly Prop[], radius: number): Uint8Array {
  const routeR = Math.min(radius, NAV_CLASS_RADII[NAV_CLASS_RADII.length - 1]);
  const open = (tx: number, ty: number): boolean => {
    if (tx < 0 || ty < 0 || tx >= d.w || ty >= d.h || d.tiles[ty * d.w + tx] === 1) return false;
    const cx = (tx + 0.5) * TILE, cy = (ty + 0.5) * TILE;
    for (const p of props) {
      if (p.dead) continue;
      const rr = routeR + p.radius * PROP_BLOCK_RING;
      if (Math.hypot(cx - p.x, cy - p.y) < rr) return false;
    }
    return true;
  };
  const seen = new Uint8Array(d.w * d.h);
  const queue: number[] = [d.spawn.y * d.w + d.spawn.x];
  seen[queue[0]] = 1;
  while (queue.length > 0) {
    const cur = queue.pop()!;
    const cx = cur % d.w, cy = Math.floor(cur / d.w);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx, ny = cy + dy;
      const ni = ny * d.w + nx;
      if (nx < 0 || ny < 0 || nx >= d.w || ny >= d.h || seen[ni] || !open(nx, ny)) continue;
      seen[ni] = 1;
      queue.push(ni);
    }
  }
  return seen;
}

function spawnBodyError(w: WorldState, e: Enemy): string | null {
  const r = e.radius;
  const inWall = (x: number, y: number): boolean => {
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    return tx < 0 || ty < 0 || tx >= w.dungeon.w || ty >= w.dungeon.h || w.dungeon.tiles[ty * w.dungeon.w + tx] === 1;
  };
  if (inWall(e.x, e.y) || inWall(e.x - r, e.y) || inWall(e.x + r, e.y) || inWall(e.x, e.y - r) || inWall(e.x, e.y + r)) return "overlaps wall";
  for (const p of w.props) {
    if (p.dead) continue;
    if (Math.hypot(e.x - p.x, e.y - p.y) < r + p.radius * PROP_BLOCK_RING) return `inside prop ${p.id} ring`;
  }
  for (const c of w.chests) {
    if (Math.hypot(e.x - c.x, e.y - c.y) < r + c.radius) return `on chest ${c.id}`;
  }
  return null;
}

function spawnValidationSweep(): void {
  section("spawn validation: real floors x seeds — body-clear + oracle-reachable, incl. reinforcements + boss arena");
  let bodyFailures = 0;
  let reachFailures = 0;
  let checkedCount = 0;
  for (let seedIdx = 0; seedIdx < 10; seedIdx++) {
    for (const floor of [1, 2, 3, 5, 6]) {
      const w = createWorld(0xF10AC + seedIdx * 104729, floor, { isShared: true, skipLocalPlayer: true });
      const reachCache = new Map<number, Uint8Array>();
      for (const e of [...w.enemies, ...w.pendingSpawns]) {
        checkedCount++;
        const bodyErr = spawnBodyError(w, e);
        if (bodyErr) { bodyFailures++; process.stdout.write(`    seed ${seedIdx} floor ${floor}: ${e.kind}/${e.tier} ${bodyErr}\n`); }
        const key = Math.min(Math.ceil(e.radius), 64);
        let reach = reachCache.get(key);
        if (!reach) { reach = oracleReachable(w.dungeon, w.props, e.radius); reachCache.set(key, reach); }
        const ti = Math.floor(e.y / TILE) * w.dungeon.w + Math.floor(e.x / TILE);
        if (!reach[ti]) { reachFailures++; process.stdout.write(`    seed ${seedIdx} floor ${floor}: ${e.kind}/${e.tier} unreachable tile\n`); }
      }
    }
  }
  check(`every spawn body-clear (${checkedCount} spawns audited)`, bodyFailures === 0, `failures=${bodyFailures}`);
  check("every spawn tile reachable from the player spawn", reachFailures === 0, `failures=${reachFailures}`);
}

// ---- case 9: runtime spawns — elite split + boss adds settle out of sealed pockets ----

function splitAndAddCase(): void {
  section("elite split: children of a parent killed inside a sealed pocket relocate outside it");
  const w = sandbox(0x5B117);
  placePlayer(w, tileCenter(5, 12).x, tileCenter(5, 12).y);
  const pocket = tileCenter(25, 12);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      propAtTile(w, "barrel", 25 + dx, 12 + dy);
    }
  }
  const elite = createEnemy("slime", pocket.x, pocket.y, w.floor, w.rng, w.nextEnemyId++, { tier: "elite" });
  w.enemies.push(elite);
  w.bullets.push({
    x: elite.x, y: elite.y, vx: 1, vy: 0, radius: elite.radius + 4, life: 0.06, friendly: true,
    owner: LOCAL_ID, damage: 500, color: "#fff", pierce: 0, hitList: null, isCrit: false,
  });
  stepWorld(w, idleInputs, DT);
  const children = w.enemies.filter((e) => e.tier === "swarm");
  check("both split children spawned and survived the pocket kill", children.length === 2, `children=${children.length}`);
  const reach = oracleReachable(w.dungeon, w.props, children[0]?.radius ?? 13);
  let isOutsideOk = true;
  let isReachOk = true;
  let isBodyOk = true;
  for (const c of children) {
    if (Math.hypot(c.x - pocket.x, c.y - pocket.y) < 60) isOutsideOk = false;
    if (!reach[Math.floor(c.y / TILE) * w.dungeon.w + Math.floor(c.x / TILE)]) isReachOk = false;
    if (spawnBodyError(w, c)) isBodyOk = false;
  }
  check("children relocated OUTSIDE the sealed pocket", isOutsideOk);
  check("children landed on reachable tiles", isReachOk);
  check("children body-clear", isBodyOk);

  section("boss adds: summons from a cover-ringed boss settle body-clear on reachable ground");
  const wb = sandbox(0xB055);
  placePlayer(wb, tileCenter(8, 12).x, tileCenter(8, 12).y);
  const bossAt = tileCenter(24, 12);
  devSpawnEnemy(wb, "boss", bossAt.x, bossAt.y);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    devSpawnProp(wb, "barrel", bossAt.x + Math.cos(a) * 120, bossAt.y + Math.sin(a) * 120);
  }
  const addEvents: Array<{ mx: number; my: number; spawned: boolean }> = [];
  for (let t = 0; t < 140; t++) {
    const ev = stepWorld(wb, idleInputs, DT);
    for (const e of ev) if (e.t === "bossAddSpawn") addEvents.push({ mx: e.mx, my: e.my, spawned: e.spawned });
  }
  const spawnedAdds = wb.enemies.filter((e) => e.kind === "slime");
  check("the caged boss still summoned adds", spawnedAdds.length > 0 && addEvents.some((a) => a.spawned), `adds=${spawnedAdds.length}`);
  let isAddBodyOk = true;
  let isAddOutsideOk = true;
  for (const a of spawnedAdds) {
    if (spawnBodyError(wb, a)) isAddBodyOk = false;
    // Settled outside the sealed cover ring (interior is unreachable for ground bodies).
    if (Math.hypot(a.x - bossAt.x, a.y - bossAt.y) < 120) isAddOutsideOk = false;
  }
  check("every add body-clear", isAddBodyOk);
  check("every add settled outside the sealed cover ring", isAddOutsideOk);
}

// ---- case 10: perf gate ----

function perfGate(): void {
  section("perf gate: 50 enemies + 50 props under the server tick budget");
  const w = sandbox(0x9E4F);
  placePlayer(w, tileCenter(17, 12).x, tileCenter(17, 12).y);
  const rng = new Rng(0xBEEF);
  const used = new Set<number>();
  let props = 0;
  while (props < 50) {
    const tx = 2 + rng.int(0, 29);
    const ty = 2 + rng.int(0, 19);
    const idx = ty * w.dungeon.w + tx;
    if (used.has(idx) || (Math.abs(tx - 17) <= 1 && Math.abs(ty - 12) <= 1)) continue;
    used.add(idx);
    propAtTile(w, rng.chance(0.4) ? "crate" : "barrel", tx, ty);
    props++;
  }
  const kinds = ["slime", "bat", "skeleton", "spitter"] as const;
  for (let i = 0; i < 50; i++) {
    const tx = 2 + rng.int(0, 29);
    const ty = 2 + rng.int(0, 19);
    const c = tileCenter(tx, ty);
    devSpawnEnemy(w, kinds[i % kinds.length], c.x, c.y);
  }
  // Warmup (JIT + first field builds), then measure.
  for (let t = 0; t < 40; t++) stepWorld(w, idleInputs, DT);
  const times: number[] = [];
  for (let t = 0; t < 300; t++) {
    const t0 = performance.now();
    stepWorld(w, idleInputs, DT);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((s, x) => s + x, 0) / times.length;
  const p95 = times[Math.floor(times.length * 0.95)];
  process.stdout.write(`    50 enemies + 50 props: avg ${avg.toFixed(3)}ms/tick, p95 ${p95.toFixed(3)}ms (50ms budget @20Hz)\n`);
  check("average tick far under the 20Hz budget", avg < 6, `avg=${avg.toFixed(3)}ms`);
  check("p95 tick under budget", p95 < 12, `p95=${p95.toFixed(3)}ms`);
}

function main(): void {
  singleBarrelCase();
  chestWallCornerCase();
  threePropRowCase();
  uPocketCase();
  denseSweepCase();
  obstacleBreakCase();
  radiiCase();
  spawnValidationSweep();
  splitAndAddCase();
  perfGate();

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) {
    process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("\nDynamic-prop navigation contract holds (routing, determinism, spawn validation, perf).\n");
}

main();
