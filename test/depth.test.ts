// Depth-progression suite: locks the level-design contracts of the biome ladder —
// generator invariants (connectivity, open centers, sealed borders, determinism), room
// archetypes escalating with depth, boss arenas, and the hazard layer's fairness rules
// (telegraph windows, safety radii, pool-never-seals-a-path, iframe gating, rift pull
// being escapable pressure). Everything here is seeded and deterministic.
//
// Run: npm run test:depth

import { generateDungeon } from "../src/sim/dungeon.js";
import type { Dungeon, RoomShape } from "../src/sim/dungeon.js";
import {
  placeHazards, hazardBudgetForFloor, hazardPhaseAt, hazardPhaseFrac, isHazardDamaging,
  HAZARD_TIMING, HAZARD_DAMAGE, RIFT_PULL_SPEED, RIFT_PULL_RADIUS, hazardPeriod,
} from "../src/sim/hazards.js";
import type { Hazard, HazardKind } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import { BIOMES, biomeIndexForFloor, biomeDepthForFloor, biomeForFloor } from "../src/sim/biomes.js";
import { BIOME_PRESSURE, PLAYER } from "../src/sim/balance.js";
import { spawnFloorEnemies, isBossFloor } from "../src/sim/enemies.js";
import { createWorld, stepWorld, isFloorCleared, devSpawnEnemy } from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { InputCmd } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import { jsonCodec, buildSnapshot } from "../src/net/protocol.js";
import type { ServerMsg } from "../src/net/protocol.js";

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
const SEEDS = [0x1a2b3c, 0xbee5, 0x7777777, 0xdead10cc, 0x1359, 0xcafe42, 0x900d5eed, 0x31415926];
const FLOORS = [1, 2, 3, 5, 7, 9, 10, 12, 15, 17, 20, 22, 25, 27, 30];

function idle(seq: number): InputCmd {
  return { seq, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };
}

// BFS over open floor tiles; `blocked` marks extra impassable tiles (e.g. pools).
function reachableFrom(d: Dungeon, sx: number, sy: number, blocked?: Set<number>): Set<number> {
  const seen = new Set<number>();
  const start = sy * d.w + sx;
  if (d.tiles[start] !== 0 || blocked?.has(start)) return seen;
  seen.add(start);
  const queue = [start];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const cx = cur % d.w, cy = (cur / d.w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= d.w || ny >= d.h) continue;
      const ni = ny * d.w + nx;
      if (d.tiles[ni] !== 0 || seen.has(ni) || blocked?.has(ni)) continue;
      seen.add(ni);
      queue.push(ni);
    }
  }
  return seen;
}

const DRAMATIC: readonly RoomShape[] = ["pillars", "arena", "cavern", "gauntlet"];

function generatorInvariantTests(): void {
  section("generator invariants: determinism, sealed border, open centers, full connectivity");
  let deterministic = true, borderSealed = true, centersOpen = true, connected = true, exitFar = true;
  for (const seed of SEEDS) {
    for (const floor of FLOORS) {
      const d = generateDungeon(seed, floor);
      const again = generateDungeon(seed, floor);
      if (JSON.stringify(d) !== JSON.stringify(again)) deterministic = false;
      for (let x = 0; x < d.w; x++) {
        if (d.tiles[x] !== 1 || d.tiles[(d.h - 1) * d.w + x] !== 1) borderSealed = false;
      }
      for (let y = 0; y < d.h; y++) {
        if (d.tiles[y * d.w] !== 1 || d.tiles[y * d.w + d.w - 1] !== 1) borderSealed = false;
      }
      for (const r of d.rooms) {
        if (d.tiles[r.cy * d.w + r.cx] !== 0) centersOpen = false;
      }
      const seen = reachableFrom(d, d.spawn.x, d.spawn.y);
      let openCount = 0;
      for (const t of d.tiles) if (t === 0) openCount++;
      if (seen.size !== openCount) connected = false;
      if (!seen.has(d.exit.y * d.w + d.exit.x)) connected = false;
      if (Math.abs(d.exit.x - d.spawn.x) + Math.abs(d.exit.y - d.spawn.y) < 8) exitFar = false;
    }
  }
  check(`deterministic across ${SEEDS.length} seeds x ${FLOORS.length} floors`, deterministic);
  check("map border ring stays solid wall", borderSealed);
  check("every room center is open floor", centersOpen);
  check("EVERY open tile is reachable from the spawn (no sealed pockets, exit included)", connected);
  check("the exit lands far from the spawn (a journey, not a scatter)", exitFar);
}

function archetypeDepthTests(): void {
  section("room archetypes escalate with depth");
  let shallowExotic = 0;
  let deepDramaticFloors = 0;
  let deepFloorCount = 0;
  let shallowShare = 0, shallowRooms = 0, deepShare = 0, deepRooms = 0;
  for (const seed of SEEDS) {
    for (const floor of FLOORS) {
      const d = generateDungeon(seed, floor);
      const dramatic = d.rooms.filter((r) => DRAMATIC.includes(r.shape)).length;
      if (floor <= 2) {
        // The floor-2 treasure vault is the one sanctioned early flourish.
        shallowExotic += d.rooms.filter((r) => r.shape !== "rect" && r.shape !== "cell" && r.shape !== "hall" && r.shape !== "vault").length;
      }
      if (floor <= 3) { shallowShare += dramatic; shallowRooms += d.rooms.length; }
      if (floor >= 17) {
        deepShare += dramatic; deepRooms += d.rooms.length;
        deepFloorCount++;
        if (dramatic >= 2) deepDramaticFloors++;
      }
    }
  }
  check("floors 1-2 stay architecturally gentle (no pillars/arenas/caverns/gauntlets)", shallowExotic === 0);
  const shallowFrac = shallowShare / Math.max(1, shallowRooms);
  const deepFrac = deepShare / Math.max(1, deepRooms);
  check("dramatic-shape share rises sharply with depth", deepFrac > shallowFrac + 0.25,
    `shallow=${(shallowFrac * 100).toFixed(0)}% deep=${(deepFrac * 100).toFixed(0)}%`);
  check("every deep floor carries at least two dramatic rooms", deepDramaticFloors === deepFloorCount,
    `${deepDramaticFloors}/${deepFloorCount}`);

  let vaultOk = true;
  for (const seed of SEEDS) {
    const d = generateDungeon(seed, 4);
    const treasure = d.rooms.find((r) => r.kind === "treasure");
    if (!treasure || treasure.shape !== "vault") continue; // treasure may be demoted on cramped layouts
    // The vault ring is real: walls exist strictly inside the room rect.
    let innerWalls = 0;
    for (let y = treasure.y + 1; y < treasure.y + treasure.h - 1; y++) {
      for (let x = treasure.x + 1; x < treasure.x + treasure.w - 1; x++) {
        if (d.tiles[y * d.w + x] === 1) innerWalls++;
      }
    }
    if (innerWalls < 8) vaultOk = false;
  }
  check("treasure vaults carry a real sealed ring", vaultOk);

  let hazardRoomDeep = 0;
  for (const seed of SEEDS) {
    const d = generateDungeon(seed, 18);
    if (d.rooms.some((r) => r.kind === "hazard")) hazardRoomDeep++;
  }
  check("deep floors author hazard set-piece rooms", hazardRoomDeep >= SEEDS.length - 1, `${hazardRoomDeep}/${SEEDS.length}`);

  section("boss floors stage a grand arena");
  let arenaOk = true, bossInArena = true, approachOk = true;
  for (const seed of SEEDS) {
    for (const floor of [5, 10, 20, 25]) {
      const d = generateDungeon(seed, floor);
      const last = d.rooms[d.rooms.length - 1];
      if (last.shape !== "arena" || last.w < 13 || last.h < 11) arenaOk = false;
      const spawns = spawnFloorEnemies(d, seed, floor);
      const boss = spawns.active.find((e) => e.kind === "boss");
      if (!boss) { bossInArena = false; continue; }
      const bx = Math.floor(boss.x / TILE), by = Math.floor(boss.y / TILE);
      if (bx < last.x || bx >= last.x + last.w || by < last.y || by >= last.y + last.h) bossInArena = false;
      if (d.tiles[by * d.w + bx] !== 0) bossInArena = false;
      if (d.exit.x !== last.cx || d.exit.y !== last.cy) approachOk = false;
    }
  }
  check("the final room of every boss floor is a 13x11+ arena", arenaOk);
  check("the boss spawns on open floor inside its arena", bossInArena);
  check("the exit sits at the arena center (beat the boss, descend the band)", approachOk);
}

function biomeLadderTests(): void {
  section("biome ladder: six one-way bands, five floors each, capped by their boss");
  check("six biomes exist", BIOMES.length === 6);
  check("balance pressure covers every biome", BIOME_PRESSURE.length === BIOMES.length);
  check("floors 1-5 are Verdant, 6-10 Sunless, 11-15 Deep, 16-20 Ember, 21-25 Fracture, 26+ Null",
    biomeIndexForFloor(1) === 0 && biomeIndexForFloor(5) === 0 &&
    biomeIndexForFloor(6) === 1 && biomeIndexForFloor(10) === 1 &&
    biomeIndexForFloor(11) === 2 && biomeIndexForFloor(15) === 2 &&
    biomeIndexForFloor(16) === 3 && biomeIndexForFloor(20) === 3 &&
    biomeIndexForFloor(21) === 4 && biomeIndexForFloor(25) === 4 &&
    biomeIndexForFloor(26) === 5 && biomeIndexForFloor(99) === 5);
  check("every biome band ends on its boss floor", [5, 10, 15, 20, 25].every((f) =>
    isBossFloor(f) && biomeIndexForFloor(f) === biomeIndexForFloor(f - 1)));
  check("band depth ramps 0..1 within each band", biomeDepthForFloor(6) === 0 && biomeDepthForFloor(10) === 1
    && biomeDepthForFloor(26) === 0 && biomeDepthForFloor(30) === 1 && biomeDepthForFloor(300) === 1);
  check("mood darkens and thickens with every band", BIOMES.every((b, i) =>
    i === 0 || (b.vignette > BIOMES[i - 1].vignette && b.lightLevel > BIOMES[i - 1].lightLevel
      && b.detailDensity > BIOMES[i - 1].detailDensity)));
}

function hazardPlacementTests(): void {
  section("hazard placement: fairness radii, budgets, escalation, determinism");
  let noneShallow = true, budgetOk = true, radiiOk = true, onFloorOk = true, noDupes = true, deterministic = true;
  let centersClear = true, bossRoomClear = true;
  const bandTiles = new Map<number, { total: number; floors: number }>();
  for (const seed of SEEDS) {
    for (const floor of FLOORS) {
      const d = generateDungeon(seed, floor);
      const hz = placeHazards(d, seed, floor);
      const again = placeHazards(d, seed, floor);
      if (JSON.stringify(hz) !== JSON.stringify(again)) deterministic = false;
      if (floor <= 2 && hz.length > 0) noneShallow = false;
      if (hz.length > hazardBudgetForFloor(floor)) budgetOk = false;
      const seenTiles = new Set<number>();
      for (const h of hz) {
        const key = h.ty * d.w + h.tx;
        if (seenTiles.has(key)) noDupes = false;
        seenTiles.add(key);
        if (d.tiles[key] !== 0) onFloorOk = false;
        if (Math.max(Math.abs(h.tx - d.spawn.x), Math.abs(h.ty - d.spawn.y)) <= 3) radiiOk = false;
        if (Math.max(Math.abs(h.tx - d.exit.x), Math.abs(h.ty - d.exit.y)) <= 2) radiiOk = false;
        for (const r of d.rooms) {
          if (Math.abs(h.tx - r.cx) + Math.abs(h.ty - r.cy) <= 1) centersClear = false;
        }
        if (isBossFloor(floor)) {
          const arena = d.rooms[d.rooms.length - 1];
          if (h.tx >= arena.x - 1 && h.tx < arena.x + arena.w + 1 && h.ty >= arena.y - 1 && h.ty < arena.y + arena.h + 1) bossRoomClear = false;
        }
      }
      if (!isBossFloor(floor)) {
        const band = biomeIndexForFloor(floor);
        const agg = bandTiles.get(band) ?? { total: 0, floors: 0 };
        agg.total += hz.length;
        agg.floors++;
        bandTiles.set(band, agg);
      }
    }
  }
  check("floors 1-2 are hazard-free (the safe teaching band)", noneShallow);
  check("hazard tile count never exceeds the floor budget", budgetOk);
  check("layout is deterministic per (seed, floor)", deterministic);
  check("hazards sit on open floor, one per tile", onFloorOk && noDupes);
  check("safety radii hold: spawn (3), exit (2)", radiiOk);
  check("room centers (chest/dealer ground) stay clear", centersClear);
  check("boss arenas stay hazard-free (the boss IS the danger)", bossRoomClear);
  const bandMeans: number[] = [];
  for (let band = 0; band < BIOMES.length; band++) {
    const agg = bandTiles.get(band);
    bandMeans.push(agg ? agg.total / agg.floors : 0);
  }
  check("hazard density escalates band over band", bandMeans.every((m, i) => i === 0 || m > bandMeans[i - 1]),
    bandMeans.map((m) => m.toFixed(1)).join(" -> "));

  section("static pools never seal a path");
  let poolsFair = true;
  for (const seed of SEEDS) {
    for (const floor of FLOORS) {
      const d = generateDungeon(seed, floor);
      const hz = placeHazards(d, seed, floor);
      const pools = new Set<number>();
      for (const h of hz) if (h.kind === "toxic_pool") pools.add(h.ty * d.w + h.tx);
      if (pools.size === 0) continue;
      // Damage-free traversal: spawn must still reach the exit and every room center
      // without ever standing in a pool (pulse hazards are crossable by timing).
      const seen = reachableFrom(d, d.spawn.x, d.spawn.y, pools);
      if (!seen.has(d.exit.y * d.w + d.exit.x)) poolsFair = false;
      for (const r of d.rooms) if (!seen.has(r.cy * d.w + r.cx)) poolsFair = false;
    }
  }
  check("spawn -> exit and every room center reachable without touching a pool", poolsFair);
}

function hazardTimingTests(): void {
  section("hazard cycle fairness: long telegraphs, readable rhythm");
  for (const kind of ["spikes", "fire_vent", "void_rift"] as const) {
    const t = HAZARD_TIMING[kind]!;
    check(`${kind}: telegraph >= 0.9s and idle >= 2s (never a surprise)`, t.telegraph >= 0.9 && t.idle >= 2);
    const h: Hazard = { id: 0, kind, tx: 0, ty: 0, phase: 0, group: 0 };
    let order = "";
    for (let c = 0; c < hazardPeriod(kind); c += 0.05) {
      const ph = hazardPhaseAt(h, c);
      const ch = ph === "idle" ? "i" : ph === "telegraph" ? "t" : "a";
      if (!order.endsWith(ch)) order += ch;
    }
    check(`${kind}: cycle runs idle -> telegraph -> active`, order === "ita", order);
    check(`${kind}: phase fraction stays 0..1`, [0.1, 1.3, 2.9, 4.4].every((c) => {
      const f = hazardPhaseFrac(h, c);
      return f >= 0 && f <= 1;
    }));
  }
  check("pools are permanently active (and permanently visible)",
    isHazardDamaging({ id: 0, kind: "toxic_pool", tx: 0, ty: 0, phase: 0, group: 0 }, 0.123));
}

// A world at `floor` with combat stripped so only the floor itself can act.
function quietWorld(seed: number, floor: number): WorldState {
  const w = createWorld(seed, floor);
  w.enemies = [];
  w.pendingSpawns = [];
  return w;
}

function findHazardWorld(kind: HazardKind, floor: number): { w: WorldState; h: Hazard } {
  for (const seed of SEEDS) {
    const w = quietWorld(seed, floor);
    const h = w.hazards.find((x) => x.kind === kind);
    if (h) return { w, h };
  }
  throw new Error(`no ${kind} found at floor ${floor} across seeds`);
}

function step(w: WorldState, seq: number): SimEvent[] {
  return stepWorld(w, new Map([[LOCAL_ID, idle(seq)]]), DT);
}

function hazardDamageTests(): void {
  section("hazard damage: telegraphed, 1 damage, iframe-gated, no melting");
  {
    const { w, h } = findHazardWorld("spikes", 8);
    const p = w.players.get(LOCAL_ID)!;
    p.x = (h.tx + 0.5) * TILE;
    p.y = (h.ty + 0.5) * TILE;
    p.invuln = 0;
    const hp0 = p.hp;
    let sawTelegraphBeforeHit = false;
    let wasTelegraph = false;
    let hitEvents = 0;
    let hitAt = -1;
    for (let t = 0; t < 60 * 8; t++) {
      const ph = hazardPhaseAt(h, w.hazardClock + DT);
      if (ph === "telegraph") wasTelegraph = true;
      const evs = step(w, t);
      for (const e of evs) {
        if (e.t === "hazardHit") {
          hitEvents++;
          if (hitAt < 0) { hitAt = t; if (wasTelegraph) sawTelegraphBeforeHit = true; }
        }
      }
      if (hitAt >= 0 && t > hitAt + 30) break;
    }
    check("standing on spikes takes damage when they fire", hitAt >= 0 && p.hp < hp0, `hp ${hp0}->${p.hp}`);
    check("the hit was telegraphed first", sawTelegraphBeforeHit);
    check("post-hit protection prevents same-window melting", hitEvents === 1 && hp0 - p.hp === HAZARD_DAMAGE,
      `hits=${hitEvents}`);
  }
  {
    // The dash iframe carries you across an erupting tile unharmed.
    const { w, h } = findHazardWorld("spikes", 8);
    const p = w.players.get(LOCAL_ID)!;
    p.x = (h.tx + 0.5) * TILE;
    p.y = (h.ty + 0.5) * TILE;
    p.invuln = 0;
    const hp0 = p.hp;
    for (let t = 0; t < 60 * 6; t++) {
      p.dashInvuln = 0.2; // continuously re-armed iframe, isolating the protection check
      step(w, t);
    }
    check("dash iframe fully protects from hazards", p.hp === hp0, `hp=${p.hp}`);
  }
  {
    const { w, h } = findHazardWorld("toxic_pool", 12);
    const p = w.players.get(LOCAL_ID)!;
    p.x = (h.tx + 0.5) * TILE;
    p.y = (h.ty + 0.5) * TILE;
    p.invuln = 0;
    const hp0 = p.hp;
    let hits = 0;
    // 0.75s in the pool: one hit lands immediately, and the 0.8s post-hit protection
    // must still be holding the second one off — the drain is paced, never a melt.
    for (let t = 0; t < 45; t++) {
      for (const e of step(w, t)) if (e.t === "hazardHit") hits++;
    }
    check("standing in a pool costs 1, then protection paces the drain (1 per 0.8s)", hits === 1 && p.hp === hp0 - 1,
      `hits=${hits} hp=${p.hp}`);
    check("crossing a pool quickly costs at most 1 heart", PLAYER.postHitInvuln >= (2 * TILE) / (PLAYER.moveSpeed * 0.8));
  }
  {
    // Hazards never touch enemies: bodies are encounter pressure, the floor is the
    // player's problem.
    const { w, h } = findHazardWorld("spikes", 8);
    const p = w.players.get(LOCAL_ID)!;
    p.invuln = 1e9;
    const foe = devSpawnEnemy(w, "skeleton", (h.tx + 0.5) * TILE, (h.ty + 0.5) * TILE);
    foe.speed = 0;
    foe.spawnTimer = 1e9; // hold still: this test isolates hazard contact
    const hpBefore = foe.hp;
    for (let t = 0; t < 60 * 8; t++) step(w, t);
    check("enemies are immune to floor hazards", foe.hp === hpBefore, `hp ${hpBefore}->${foe.hp}`);
  }
}

function riftPullTests(): void {
  section("void rifts: escapable pull pressure");
  check("pull speed stays well under walk speed (always escapable)",
    RIFT_PULL_SPEED <= PLAYER.moveSpeed * 0.5, `${RIFT_PULL_SPEED} vs ${PLAYER.moveSpeed}`);
  const { w, h } = findHazardWorld("void_rift", 22);
  const p = w.players.get(LOCAL_ID)!;
  const cx = (h.tx + 0.5) * TILE, cy = (h.ty + 0.5) * TILE;
  p.invuln = 1e9; // isolate the pull from damage
  let pulled = false;
  let idlePhaseStill = true;
  for (let t = 0; t < 60 * 10; t++) {
    const ph = hazardPhaseAt(h, w.hazardClock + DT);
    p.x = cx - RIFT_PULL_RADIUS * 0.7;
    p.y = cy;
    const before = Math.hypot(p.x - cx, p.y - cy);
    step(w, t);
    const after = Math.hypot(p.x - cx, p.y - cy);
    if (ph === "active" && after < before - 0.1) pulled = true;
    if (ph === "idle" && Math.abs(after - before) > 1e-6) idlePhaseStill = false;
  }
  check("an ACTIVE rift drags a nearby player toward its core", pulled);
  check("a dormant rift never moves anyone", idlePhaseStill);
}

function wireTests(): void {
  section("hazardHit rides the reliable event wire");
  const w = createWorld(0xbee5, 8);
  const ev: SimEvent = { t: "hazardHit", pid: LOCAL_ID, kind: "spikes", x: 100, y: 200 };
  const msg = buildSnapshot(w, LOCAL_ID, 0, [{ id: 1, e: ev }], 1, false, {});
  const decoded = jsonCodec.decodeServer(jsonCodec.encodeServer(msg)) as Extract<ServerMsg, { t: "snap" }>;
  check("hazardHit round-trips the strict server->client decoder",
    decoded.events.length === 1 && decoded.events[0].e.t === "hazardHit"
    && (decoded.events[0].e as Extract<SimEvent, { t: "hazardHit" }>).kind === "spikes");
}

function determinismTests(): void {
  section("full-floor determinism with hazards live");
  const runA = runFloor(0x51015, 13, 60 * 6);
  const runB = runFloor(0x51015, 13, 60 * 6);
  check("two identical runs produce identical worlds + hazard clocks", runA === runB);
}

function runFloor(seed: number, floor: number, ticks: number): string {
  const w = createWorld(seed, floor);
  for (let t = 0; t < ticks; t++) step(w, t);
  const p = w.players.get(LOCAL_ID)!;
  return JSON.stringify({
    clock: w.hazardClock,
    hz: w.hazards,
    p: [p.x, p.y, p.hp],
    e: w.enemies.map((e) => [e.id, Math.round(e.x), Math.round(e.y), e.hp]),
    cleared: isFloorCleared(w),
    biome: biomeForFloor(floor).name,
  });
}

function main(): void {
  generatorInvariantTests();
  archetypeDepthTests();
  biomeLadderTests();
  hazardPlacementTests();
  hazardTimingTests();
  hazardDamageTests();
  riftPullTests();
  wireTests();
  determinismTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nDepth-progression contracts hold (archetypes, biome ladder, hazard fairness).\n");
}

main();
