// The CREATIVE ECOLOGY GATE: the two-wave structure over raw taxonomy.
//
//  Wave A — the common decks: predators, supports, and AT MOST ONE truly new
//  topology/material WORKER per biome band (the Forkroot Bailiff walls Rootbound, the
//  Silt Keel plows the Deep, the Clinker Mason bricks Emberreach).
//  Wave B — rare elites/lieutenants that SYNTHESIZE verbs Wave A already taught, and
//  NEVER enter common decks (summon-only bodies + the seeded miniboss cadence; the
//  elite tier is a Wave-B layer over Wave-A chassis).
//
//  Topology law (every worker): ONE persistent topology edit per room, an explicit
//  escape route (wall/exit standoffs + everything destructible), and old construction
//  REPLACED whenever the worker builds anew.
//
// Run: npm run test:ecology

import { createWorld, stepWorld, devSpawnEnemy, devSpawnProp, workerBuildSites } from "../src/sim/world.js";
import type { WorldState, PlayerSim, SimEvent } from "../src/sim/world.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { InputCmd } from "../src/sim/input.js";
import { TILE } from "../src/sim/types.js";
import type { Enemy, EnemyKind, Prop } from "../src/sim/types.js";
import {
  ENEMY_WAVE, WORKER_KINDS, isWorkerKind, WAVE_B_SYNTHESIS, ENEMY_ROLE, ENEMY_MODULE,
} from "../src/sim/bestiary.js";
import { ENEMY_ARCHETYPES, FAMILY_INTRO_FLOOR, isBossFloor, isGauntletFloor } from "../src/sim/enemies.js";
import { MAX_WORKERS_PER_ROOM } from "../src/sim/balance.js";
import * as C from "../src/sim/constants.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

const DT = 1 / 60;
const ALL_KINDS = Object.keys(ENEMY_ARCHETYPES) as EnemyKind[];

function idle(seq: number): InputCmd {
  return { seq, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };
}

function step(w: WorldState): SimEvent[] {
  return stepWorld(w, new Map([[LOCAL_ID, idle(w.tick + 1)]]), DT);
}

function stepFor(w: WorldState, seconds: number): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) step(w);
}

function arena(seed: number): { w: WorldState; p: PlayerSim } {
  const w = createWorld(seed, 1, { isSandbox: true });
  const p = w.players.get(LOCAL_ID)!;
  p.invuln = 0;
  return { w, p };
}

function spawnReady(w: WorldState, kind: EnemyKind, x: number, y: number): Enemy {
  const e = devSpawnEnemy(w, kind, x, y);
  e.spawnTimer = 0;
  return e;
}

function liveConstructions(w: WorldState): Prop[] {
  return w.props.filter((p) => p.owner !== undefined && !p.dead && p.breakT === undefined);
}

function roomIndexOf(w: WorldState, x: number, y: number): number {
  const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
  const rooms = w.dungeon.rooms;
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i];
    if (tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h) return i;
  }
  return -1;
}

// Tile-grid BFS with live props as blockers: the escape-route oracle. A construction
// may never sever the player's path to the floor exit.
function isExitReachable(w: WorldState): boolean {
  const d = w.dungeon;
  const p = w.players.get(LOCAL_ID)!;
  const isBlocked = (tx: number, ty: number): boolean => {
    if (tx < 0 || ty < 0 || tx >= d.w || ty >= d.h) return true;
    if (d.tiles[ty * d.w + tx] === 1) return true;
    const cx = (tx + 0.5) * TILE, cy = (ty + 0.5) * TILE;
    for (const pr of w.props) {
      if (pr.dead || pr.breakT !== undefined) continue;
      if (Math.hypot(pr.x - cx, pr.y - cy) < pr.radius + TILE * 0.35) return true;
    }
    return false;
  };
  const start = [Math.floor(p.x / TILE), Math.floor(p.y / TILE)];
  const goal = [d.exit.x, d.exit.y];
  const seen = new Set<number>([start[1] * d.w + start[0]]);
  const queue: number[][] = [start];
  while (queue.length > 0) {
    const [tx, ty] = queue.shift()!;
    if (tx === goal[0] && ty === goal[1]) return true;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = tx + ox, ny = ty + oy;
      const key = ny * d.w + nx;
      if (seen.has(key) || isBlocked(nx, ny)) continue;
      seen.add(key);
      queue.push([nx, ny]);
    }
  }
  return false;
}

// ---- 1. the two-wave structure ----

function twoWaveGates(): void {
  section("two waves over raw taxonomy: every kind declares its wave; Wave B never enters common decks");
  check("every kind declares a wave (A common / B rare / boss)",
    ALL_KINDS.every((k) => ENEMY_WAVE[k] !== undefined));
  check("every regular (deck) archetype is Wave A; every summon/lieutenant is Wave B",
    ALL_KINDS.every((k) => (ENEMY_ROLE[k] !== undefined) === (ENEMY_WAVE[k] === "A")));

  // Wave B stays out of common decks: sweep every non-boss floor's actual spawn plan
  // (active + reinforcements) — no echo/knell/marshal outside the miniboss cadence, and
  // the miniboss itself arrives as the CAPTAIN, never as deck filler.
  let isDeckClean = true;
  const seenWorkers = new Set<EnemyKind>();
  for (const seed of [0xEC01, 0xEC02]) {
    for (let floor = 1; floor <= 34; floor++) {
      if (isBossFloor(floor) || isGauntletFloor(floor)) continue;
      const w = createWorld(seed, floor, { isSandbox: false });
      const units = [...w.enemies, ...w.pendingSpawns];
      for (const e of units) {
        if (isWorkerKind(e.kind)) seenWorkers.add(e.kind);
        if (ENEMY_WAVE[e.kind] === "B" && e.captainPhase === undefined) {
          isDeckClean = false;
          process.stdout.write(`    wave-B deck leak: ${e.kind} seed=${seed} floor=${floor}\n`);
        }
      }
    }
  }
  check("no Wave-B body ever spawns as common deck filler (2 seeds x 34 floors)", isDeckClean);
  check("the Wave-A workers actually reach play", seenWorkers.size >= 2,
    [...seenWorkers].join(","));

  section("Wave B synthesizes LEARNED verbs (never unrelated spectacle)");
  const bKinds = ALL_KINDS.filter((k) => ENEMY_WAVE[k] === "B");
  check("every Wave-B body declares what it synthesizes", bKinds.every((k) => (WAVE_B_SYNTHESIS[k]?.length ?? 0) > 0));
  // Every synthesis source is a Wave-A teacher already met by the B-body's first
  // possible appearance (the miniboss cadence starts F13; decoys ride their owners).
  const B_FIRST_FLOOR: Readonly<Partial<Record<EnemyKind, number>>> = {
    echo: 13, knell: 13, knot: 20, sac: 20, marshal: 13, toll: 13,
    // Wave 1 boss mechanic bodies first appear on their boss floors (F40/F45).
    tithe_slab: 40, quorum_shield: 45, quorum_heal: 45, quorum_dmg: 45,
    // Wave 1 surplus adds first appear on their boss floors too.
    tithe_tribute: 40, quorum_splinter: 45,
    // JET's mirror echo first appears on JET's floor (F35).
    jet_echo: 35,
    // The GORGE giant's tectonic weak-point first appears on the F50 giant floor.
    gorge_seam: 50,
    // The PALE THRONE giant's cold tectonic weak-point first appears on the F75 giant floor.
    pale_seam: 75,
  };
  check("every synthesized verb was TAUGHT first (source intro <= B first floor)",
    bKinds.every((k) => (WAVE_B_SYNTHESIS[k] ?? []).every((src) =>
      ENEMY_WAVE[src] === "A" && (FAMILY_INTRO_FLOOR[src] ?? Infinity) <= (B_FIRST_FLOOR[k] ?? 0))));
}

// ---- 2. one worker per biome, one worker per room ----

function workerDistributionGates(): void {
  section("workers: at most ONE truly new topology worker per biome band; one per room in the plan");
  const bandOf = (floor: number): number => Math.floor((floor - 1) / 5);
  const bands = WORKER_KINDS.map((k) => bandOf(FAMILY_INTRO_FLOOR[k] ?? 0));
  check(`each worker introduces in its OWN biome band (${WORKER_KINDS.join(", ")})`,
    new Set(bands).size === WORKER_KINDS.length, bands.join(","));
  check("every worker is a declared topology module",
    WORKER_KINDS.every((k) => (ENEMY_MODULE[k] ?? "").length > 0));

  let isRoomLawOk = true;
  for (const seed of [0xEC11, 0xEC12, 0xEC13]) {
    for (const floor of [9, 13, 17, 28, 33]) {
      const w = createWorld(seed, floor, { isSandbox: false });
      const perRoom = new Map<number, number>();
      for (const e of [...w.enemies, ...w.pendingSpawns]) {
        if (!isWorkerKind(e.kind)) continue;
        const room = roomIndexOf(w, e.x, e.y);
        perRoom.set(room, (perRoom.get(room) ?? 0) + 1);
      }
      for (const [room, n] of perRoom) {
        if (n > MAX_WORKERS_PER_ROOM) {
          isRoomLawOk = false;
          process.stdout.write(`    worker overcrowd: seed=${seed} floor=${floor} room=${room} n=${n}\n`);
        }
      }
    }
  }
  check("the planner never seats two workers in one room (3 seeds x 5 floors)", isRoomLawOk);
}

// ---- 3. the topology law in the live sim ----

function topologyGates(): void {
  section("topology law: one edit per room, escape route always open, old construction replaced");
  {
    // A long mixed-worker fight: the bailiff, the keel and the mason all work one arena.
    const { w, p } = arena(0xEC21);
    p.x = 700; p.y = 600;
    devSpawnProp(w, "brazier", 1150, 700);
    const bailiff = spawnReady(w, "rootward", 950, 600);
    const keel = spawnReady(w, "seamcutter", 900, 720);
    const mason = spawnReady(w, "mason", 1120, 720);
    let isOneEditOk = true;
    let isEscapeOk = true;
    let isStandoffOk = true;
    let builds = 0;
    let lastCount = 0;
    for (let t = 0; t < 60 * 45; t++) {
      step(w);
      // Force eagerness: every worker re-arms fast so the 45s window sees many raises.
      for (const e of [bailiff, keel, mason]) {
        if (!e.dead && e.attack.phase === "none" && e.attack.cooldown > 0.4) e.attack.cooldown = 0.4;
      }
      // Player counterplay on a beat: break the standing edit every 12s, so the room
      // unlocks and the NEXT worker gets its raise (the one-edit law rotates, never
      // deadlocks).
      if (t > 0 && t % (60 * 12) === 0) {
        for (const pr of liveConstructions(w)) { pr.dead = true; pr.breakT = C.PROP_BREAK_DUR + 1; }
        w.obstacleRev++;
      }
      const live = liveConstructions(w);
      if (live.length !== lastCount) { builds++; lastCount = live.length; }
      // ONE edit per room: every live construction in a room belongs to one owner.
      const owners = new Map<number, Set<number>>();
      for (const pr of live) {
        const room = roomIndexOf(w, pr.x, pr.y);
        if (!owners.has(room)) owners.set(room, new Set());
        owners.get(room)!.add(pr.owner!);
      }
      for (const set of owners.values()) if (set.size > 1) isOneEditOk = false;
      if (t % 30 === 0) {
        if (!isExitReachable(w)) isEscapeOk = false;
        const standoff = C.CONSTRUCT_WALL_STANDOFF * TILE;
        for (const pr of live) {
          for (let ox = -1; ox <= 1 && isStandoffOk; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
              if (ox === 0 && oy === 0) continue;
              const tx = Math.floor((pr.x + ox * standoff) / TILE), ty = Math.floor((pr.y + oy * standoff) / TILE);
              if (w.dungeon.tiles[ty * w.dungeon.w + tx] === 1) { isStandoffOk = false; break; }
            }
          }
        }
      }
    }
    check("the workers actually worked (constructions rose and moved)", builds >= 3, `changes=${builds}`);
    check("at every instant, each room's live constructions belong to ONE owner", isOneEditOk);
    check("the player's path to the exit stayed open the whole fight (escape route)", isEscapeOk);
    check("no construction segment ever hugs the wall grid (guaranteed end gaps)", isStandoffOk);
  }
  {
    // Replacement across owner death: a worker's construction PERSISTS when it dies
    // (persistent topology), and the room unlocks for the next worker only when the
    // standing edit is broken.
    const { w, p } = arena(0xEC22);
    p.x = 700; p.y = 600;
    const bailiff = spawnReady(w, "rootward", 950, 600);
    let guard = 0;
    while (!w.props.some((pr) => pr.kind === "root_wall") && guard++ < 500) step(w);
    bailiff.dead = true;
    stepFor(w, 0.5);
    const standing = w.props.filter((pr) => pr.kind === "root_wall" && !pr.dead);
    check("the divider outlives its bailiff (persistent, not despawned)", standing.length > 0);
    const mason = spawnReady(w, "mason", 1000, 560);
    guard = 0;
    while (mason.attack.phase !== "recover" && guard++ < 400) step(w);
    check("the standing edit still holds the room against a second worker",
      !w.props.some((pr) => pr.kind === "clinker_brick"));
    for (const pr of standing) { pr.dead = true; pr.breakT = C.PROP_BREAK_DUR + 1; }
    w.obstacleRev++;
    mason.attack.cooldown = 0;
    guard = 0;
    while (!w.props.some((pr) => pr.kind === "clinker_brick" && !pr.dead) && guard++ < 600) step(w);
    check("break the edit and the room is buildable again (counterplay is real)",
      w.props.some((pr) => pr.kind === "clinker_brick" && !pr.dead));
  }
  {
    // The preview IS the truth: the client's footprint helper is the sim's own geometry.
    const { w, p } = arena(0xEC23);
    p.x = 700; p.y = 600;
    const e = spawnReady(w, "rootward", 950, 600);
    let guard = 0;
    while (e.attack.move !== "build" && guard++ < 400) step(w);
    const sites = workerBuildSites(e);
    stepFor(w, C.BAILIFF_BUILD_WINDUP + 0.05);
    const wall = w.props.filter((pr) => pr.kind === "root_wall" && !pr.dead);
    check("every raised segment stands on a PREVIEWED site (one geometry, no drift)",
      wall.length > 0 && wall.every((m) => sites.some((s) => Math.hypot(s.x - m.x, s.y - m.y) < 1)));
  }
}

function main(): void {
  twoWaveGates();
  workerDistributionGates();
  topologyGates();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nThe creative ecology gate holds.\n");
}

main();
