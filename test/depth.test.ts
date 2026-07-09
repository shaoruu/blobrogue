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
  placeFloorHazards, floorHazardBudgetFor, floorHazardPhaseAt, floorHazardPhaseFrac, isFloorHazardDamaging,
  HAZARD_TIMING, FLOOR_HAZARD_DAMAGE, RIFT_PULL_SPEED, RIFT_PULL_RADIUS, floorHazardPeriod,
  HAZARD_PERIOD, HAZARD_RELEASE_GAP, floorHazardOnset, floorHazardOnsetsInRoom,
} from "../src/sim/hazards.js";
import { HAZARD_DIFFICULTY } from "../src/sim/balance.js";
import type { Difficulty } from "../src/sim/balance.js";
import type { FloorHazard, FloorHazardKind } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import { BIOMES, biomeIndexForFloor, biomeDepthForFloor, biomeForFloor, floorBannerText } from "../src/sim/biomes.js";
import { BIOME_PRESSURE, PLAYER } from "../src/sim/balance.js";
import { spawnFloorEnemies, isBossFloor, isGauntletFloor, isBossKind, createEnemy, SWARM_ROOM_MIN_AREA } from "../src/sim/enemies.js";
import { createWorld, stepWorld, isFloorCleared, devSpawnEnemy, devSpawnProp } from "../src/sim/world.js";
import { Rng } from "../src/sim/rng.js";
import type { Bullet } from "../src/sim/types.js";
import * as C from "../src/sim/constants.js";
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
const FLOORS = [1, 2, 3, 5, 7, 9, 10, 12, 15, 17, 20, 22, 25, 27, 30, 32, 35];

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
  let isDeterministic = true, isBorderSealed = true, areCentersOpen = true, isConnected = true, isExitFar = true;
  for (const seed of SEEDS) {
    for (const floor of FLOORS) {
      const d = generateDungeon(seed, floor);
      const again = generateDungeon(seed, floor);
      if (JSON.stringify(d) !== JSON.stringify(again)) isDeterministic = false;
      for (let x = 0; x < d.w; x++) {
        if (d.tiles[x] !== 1 || d.tiles[(d.h - 1) * d.w + x] !== 1) isBorderSealed = false;
      }
      for (let y = 0; y < d.h; y++) {
        if (d.tiles[y * d.w] !== 1 || d.tiles[y * d.w + d.w - 1] !== 1) isBorderSealed = false;
      }
      for (const r of d.rooms) {
        if (d.tiles[r.cy * d.w + r.cx] !== 0) areCentersOpen = false;
      }
      const seen = reachableFrom(d, d.spawn.x, d.spawn.y);
      let openCount = 0;
      for (const t of d.tiles) if (t === 0) openCount++;
      if (seen.size !== openCount) isConnected = false;
      if (!seen.has(d.exit.y * d.w + d.exit.x)) isConnected = false;
      if (Math.abs(d.exit.x - d.spawn.x) + Math.abs(d.exit.y - d.spawn.y) < 8) isExitFar = false;
    }
  }
  check(`deterministic across ${SEEDS.length} seeds x ${FLOORS.length} floors`, isDeterministic);
  check("map border ring stays solid wall", isBorderSealed);
  check("every room center is open floor", areCentersOpen);
  check("EVERY open tile is reachable from the spawn (no sealed pockets, exit included)", isConnected);
  check("the exit lands far from the spawn (a journey, not a scatter)", isExitFar);
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

  let isVaultOk = true;
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
    if (innerWalls < 8) isVaultOk = false;
  }
  check("treasure vaults carry a real sealed ring", isVaultOk);

  let hazardRoomFloors = 0;
  for (const seed of SEEDS) {
    const d = generateDungeon(seed, 18);
    if (d.rooms.some((r) => r.kind === "hazard")) hazardRoomFloors++;
  }
  check("deep floors author hazard set-piece rooms", hazardRoomFloors >= SEEDS.length - 1, `${hazardRoomFloors}/${SEEDS.length}`);

  section("boss floors stage a grand arena");
  let isArenaOk = true, isBossInArena = true, isApproachOk = true;
  for (const seed of SEEDS) {
    for (const floor of [5, 10, 15, 30]) {
      const d = generateDungeon(seed, floor);
      const last = d.rooms[d.rooms.length - 1];
      if (last.shape !== "arena" || last.w < 13 || last.h < 11) isArenaOk = false;
      const spawns = spawnFloorEnemies(d, seed, floor);
      if (isGauntletFloor(floor)) {
        // The F10 gauntlet arena starts EMPTY: the stage machine spawns its captains.
        const isOccupied = spawns.active.some((e) =>
          e.x >= last.x * TILE && e.x < (last.x + last.w) * TILE && e.y >= last.y * TILE && e.y < (last.y + last.h) * TILE);
        if (isOccupied) isBossInArena = false;
      } else {
        const boss = spawns.active.find((e) => isBossKind(e.kind));
        if (!boss) { isBossInArena = false; continue; }
        const bx = Math.floor(boss.x / TILE), by = Math.floor(boss.y / TILE);
        if (bx < last.x || bx >= last.x + last.w || by < last.y || by >= last.y + last.h) isBossInArena = false;
        if (d.tiles[by * d.w + bx] !== 0) isBossInArena = false;
      }
      if (d.exit.x !== last.cx || d.exit.y !== last.cy) isApproachOk = false;
    }
  }
  check("the final room of every boss floor is a 13x11+ arena", isArenaOk);
  check("bosses spawn on open floor inside their arena; the gauntlet arena starts empty", isBossInArena);
  check("the exit sits at the arena center (beat the boss, descend the band)", isApproachOk);
}

// The curriculum's level-side cadence (blobrogue_ENCOUNTER_CURRICULUM_spec.md §2, §4):
// within every band the architecture runs Arrive -> ... -> Synthesize -> Prove, and the
// anti-repeat deck keeps pressure cards from stacking along the player's route.
function curriculumCadenceTests(): void {
  section("curriculum cadence: teaching/remix/breather architecture + anti-repeat deck");
  {
    // Synthesize floors (slot 3) stage more drama than their band's Arrive floor (slot 0).
    let arriveDramatic = 0, arriveRooms = 0, synthDramatic = 0, synthRooms = 0;
    for (const seed of SEEDS) {
      for (const band of [2, 3, 4, 5, 6]) {
        const arrive = band * 5 + 1;
        const synth = band * 5 + 4;
        const da = generateDungeon(seed, arrive);
        const ds = generateDungeon(seed, synth);
        arriveDramatic += da.rooms.filter((r) => DRAMATIC.includes(r.shape)).length;
        arriveRooms += da.rooms.length;
        synthDramatic += ds.rooms.filter((r) => DRAMATIC.includes(r.shape)).length;
        synthRooms += ds.rooms.length;
      }
    }
    const arriveShare = arriveDramatic / Math.max(1, arriveRooms);
    const synthShare = synthDramatic / Math.max(1, synthRooms);
    check("Synthesize floors out-stage their band's Arrive floors (breathe, then build)",
      synthShare > arriveShare + 0.08,
      `arrive=${(arriveShare * 100).toFixed(0)}% synth=${(synthShare * 100).toFixed(0)}%`);
  }
  {
    // The anti-repeat deck, along the journey chain: dramatic archetypes never three in
    // a row, a simple breather follows every mid-chain arena, and at least 30% of every
    // floor stays simple/mastery ground (simple-room runs ARE the sanctioned fallback).
    let isNoTriple = true, isBreatherOk = true, isSimpleShareOk = true;
    const isSimple = (s: RoomShape) => s === "rect" || s === "cell" || s === "hall";
    for (const seed of SEEDS) {
      for (const floor of FLOORS) {
        const d = generateDungeon(seed, floor);
        const rooms = d.rooms;
        for (let i = 2; i < rooms.length; i++) {
          if (DRAMATIC.includes(rooms[i].shape)
            && rooms[i].shape === rooms[i - 1].shape && rooms[i].shape === rooms[i - 2].shape) isNoTriple = false;
        }
        for (let i = 1; i < rooms.length; i++) {
          if (rooms[i - 1].shape === "arena" && !isSimple(rooms[i].shape) && rooms[i].shape !== "vault") isBreatherOk = false;
        }
        const simple = rooms.filter((r) => isSimple(r.shape)).length;
        if (simple < Math.ceil(rooms.length * 0.3) - 1) isSimpleShareOk = false;
      }
    }
    check("no dramatic archetype three rooms in a row along the route", isNoTriple);
    check("a simple breather always follows a mid-chain arena", isBreatherOk);
    check("every floor keeps >=30% simple/mastery rooms", isSimpleShareOk);
  }
}

function biomeLadderTests(): void {
  section("biome ladder: the canonical 30-floor six-region spine + terminal Null band");
  check("seven bands exist (six curriculum regions + the post-F30 Null)", BIOMES.length === 7);
  check("balance pressure covers every band", BIOME_PRESSURE.length === BIOMES.length);
  check("curriculum mapping: Amberwild 1-5, Rootbound 6-10, Sunless 11-15, Deep 16-20, Gilded 21-25, Ember 26-30, Null 31+",
    biomeIndexForFloor(1) === 0 && biomeIndexForFloor(5) === 0 &&
    biomeIndexForFloor(6) === 1 && biomeIndexForFloor(10) === 1 &&
    biomeIndexForFloor(11) === 2 && biomeIndexForFloor(15) === 2 &&
    biomeIndexForFloor(16) === 3 && biomeIndexForFloor(20) === 3 &&
    biomeIndexForFloor(21) === 4 && biomeIndexForFloor(25) === 4 &&
    biomeIndexForFloor(26) === 5 && biomeIndexForFloor(30) === 5 &&
    biomeIndexForFloor(31) === 6 && biomeIndexForFloor(99) === 6);
  check("curriculum names hold", BIOMES.map((b) => b.name).join("|") ===
    "Amberwild|Rootbound Warrens|Sunless Caves|The Deep|Gilded Archive|Emberreach|The Null");
  check("every band ends on its milestone floor", [5, 10, 15, 20, 25, 30].every((f) =>
    isBossFloor(f) && biomeIndexForFloor(f) === biomeIndexForFloor(f - 1)));
  check("F10 is the Miniboss Gauntlet, announced as such (a non-boss milestone)",
    isGauntletFloor(10) && !isGauntletFloor(5) && !isGauntletFloor(20)
    && floorBannerText(10, { isBoss: true, isGauntlet: true }) === "MINIBOSS GAUNTLET"
    && floorBannerText(15, { isBoss: true }) === "BOSS FLOOR");
  check("band depth ramps 0..1 within each band", biomeDepthForFloor(6) === 0 && biomeDepthForFloor(10) === 1
    && biomeDepthForFloor(31) === 0 && biomeDepthForFloor(35) === 1 && biomeDepthForFloor(300) === 1);
  check("mood darkens and thickens with every band", BIOMES.every((b, i) =>
    i === 0 || (b.vignette > BIOMES[i - 1].vignette && b.lightLevel > BIOMES[i - 1].lightLevel
      && b.detailDensity > BIOMES[i - 1].detailDensity)));
}

function hazardPlacementTests(): void {
  section("hazard placement: fairness radii, budgets, escalation, determinism");
  let isShallowClean = true, isBudgetOk = true, areRadiiOk = true, isOnFloor = true, hasNoDupes = true, isLayoutDeterministic = true;
  let areCentersClear = true, isBossRoomClear = true;
  const bandTiles = new Map<number, { total: number; floors: number }>();
  for (const seed of SEEDS) {
    for (const floor of FLOORS) {
      const d = generateDungeon(seed, floor);
      const hz = placeFloorHazards(d, seed, floor);
      const again = placeFloorHazards(d, seed, floor);
      if (JSON.stringify(hz) !== JSON.stringify(again)) isLayoutDeterministic = false;
      // Studio-gate cadence: floor 1 teaches with zero hazards; floor 2 carries only the
      // half-unit spikes taste; boss floors are boss-authored ONLY (generator places none).
      if (floor === 1 && hz.length > 0) isShallowClean = false;
      if (floor === 2 && (hz.length > 2 || hz.some((h) => h.kind !== "spikes"))) isShallowClean = false;
      if (hz.length > floorHazardBudgetFor(floor)) isBudgetOk = false;
      const seenTiles = new Set<number>();
      for (const h of hz) {
        const key = h.ty * d.w + h.tx;
        if (seenTiles.has(key)) hasNoDupes = false;
        seenTiles.add(key);
        if (d.tiles[key] !== 0) isOnFloor = false;
        if (Math.max(Math.abs(h.tx - d.spawn.x), Math.abs(h.ty - d.spawn.y)) <= 3) areRadiiOk = false;
        if (Math.max(Math.abs(h.tx - d.exit.x), Math.abs(h.ty - d.exit.y)) <= 2) areRadiiOk = false;
        for (const r of d.rooms) {
          if (Math.abs(h.tx - r.cx) + Math.abs(h.ty - r.cy) <= 1) areCentersClear = false;
        }
      }
      if (isBossFloor(floor) && hz.length > 0) isBossRoomClear = false;
      if (!isBossFloor(floor)) {
        const band = biomeIndexForFloor(floor);
        const agg = bandTiles.get(band) ?? { total: 0, floors: 0 };
        agg.total += hz.length;
        agg.floors++;
        bandTiles.set(band, agg);
      }
    }
  }
  check("floor 1 is hazard-free; floor 2 carries only the spikes teaching taste", isShallowClean);
  check("hazard tile count never exceeds the floor budget", isBudgetOk);
  check("layout is deterministic per (seed, floor)", isLayoutDeterministic);
  check("hazards sit on open floor, one per tile", isOnFloor && hasNoDupes);
  check("safety radii hold: spawn (3), exit (2)", areRadiiOk);
  check("room centers (chest/dealer ground) stay clear", areCentersClear);
  check("boss floors carry ZERO generator hazards (boss-authored only)", isBossRoomClear);
  const bandMeans: number[] = [];
  for (let band = 0; band < BIOMES.length; band++) {
    const agg = bandTiles.get(band);
    bandMeans.push(agg ? agg.total / agg.floors : 0);
  }
  check("hazard density escalates band over band", bandMeans.every((m, i) => i === 0 || m > bandMeans[i - 1]),
    bandMeans.map((m) => m.toFixed(1)).join(" -> "));

  section("static pools never seal a path");
  let arePoolsFair = true;
  for (const seed of SEEDS) {
    for (const floor of FLOORS) {
      const d = generateDungeon(seed, floor);
      const hz = placeFloorHazards(d, seed, floor);
      const pools = new Set<number>();
      for (const h of hz) if (h.kind === "toxic_pool") pools.add(h.ty * d.w + h.tx);
      if (pools.size === 0) continue;
      // Damage-free traversal: spawn must still reach the exit and every room center
      // without ever standing in a pool (pulse hazards are crossable by timing).
      const seen = reachableFrom(d, d.spawn.x, d.spawn.y, pools);
      if (!seen.has(d.exit.y * d.w + d.exit.x)) arePoolsFair = false;
      for (const r of d.rooms) if (!seen.has(r.cy * d.w + r.cx)) arePoolsFair = false;
    }
  }
  check("spawn -> exit and every room center reachable without touching a pool", arePoolsFair);
}

// The studio balance gate's hazard rows (docs/specs/blobrogue_STUDIO_BALANCE_GATE.md
// §1-2): difficulty budget multipliers, per-room simultaneity caps, denial caps, and the
// 0.30s release-spacing arbiter. Every pulse kind shares ONE cycle period, so proving a
// room's schedule over a single period proves it for the whole run.
function studioGateTests(): void {
  section("studio gate: difficulty hazard rows (0.65x / 1.00x / 1.30x, caps, arbiter)");
  check("mode table matches the gate: budgets .65/1.00/1.30, caps 1/2/3 units, denial 25/35/45%",
    HAZARD_DIFFICULTY.casual.budgetMult === 0.65 && HAZARD_DIFFICULTY.standard.budgetMult === 1.0
    && HAZARD_DIFFICULTY.brutal.budgetMult === 1.3
    && HAZARD_DIFFICULTY.casual.roomSimultaneousCap === 1 && HAZARD_DIFFICULTY.standard.roomSimultaneousCap === 2
    && HAZARD_DIFFICULTY.brutal.roomSimultaneousCap === 3
    && HAZARD_DIFFICULTY.casual.roomDenialCap === 0.25 && HAZARD_DIFFICULTY.standard.roomDenialCap === 0.35
    && HAZARD_DIFFICULTY.brutal.roomDenialCap === 0.45);
  check("every pulse kind shares the arbiter's cycle period", (["spikes", "fire_vent", "void_rift"] as const)
    .every((k) => Math.abs(floorHazardPeriod(k) - HAZARD_PERIOD) < 1e-9));
  {
    let isOrdered = true;
    for (let f = 3; f <= 30; f++) {
      if (isBossFloor(f)) continue;
      const c = floorHazardBudgetFor(f, "casual");
      const s = floorHazardBudgetFor(f, "standard");
      const b = floorHazardBudgetFor(f, "brutal");
      if (!(c <= s && s <= b)) isOrdered = false;
      if (Math.abs(c - Math.round(0.65 * s)) > 1 || Math.abs(b - Math.round(1.3 * s)) > 1) isOrdered = false;
    }
    check("per-floor budgets scale by the mode multipliers (Casual <= Standard <= Brutal)", isOrdered);
  }

  const MODES: readonly Difficulty[] = ["casual", "standard", "brutal"];
  let isConcurrencyOk = true, isSpacingOk = true, isDenialOk = true, isModeDeterministic = true;
  let roomsChecked = 0;
  const circGap = (a: number, b: number): number => {
    const raw = Math.abs(a - b) % HAZARD_PERIOD;
    return Math.min(raw, HAZARD_PERIOD - raw);
  };
  for (const mode of MODES) {
    const rules = HAZARD_DIFFICULTY[mode];
    for (const seed of SEEDS) {
      for (const floor of FLOORS) {
        const d = generateDungeon(seed, floor);
        const hz = placeFloorHazards(d, seed, floor, mode);
        if (JSON.stringify(hz) !== JSON.stringify(placeFloorHazards(d, seed, floor, mode))) isModeDeterministic = false;
        if (hz.length === 0) continue;
        for (let ri = 0; ri < d.rooms.length; ri++) {
          const room = d.rooms[ri];
          const inRoom = hz.filter((h) => h.tx >= room.x && h.tx < room.x + room.w && h.ty >= room.y && h.ty < room.y + room.h);
          if (inRoom.length === 0) continue;
          roomsChecked++;
          // Denial cap: hazard tiles vs the room's walkable floor.
          let open = 0;
          for (let ty = room.y; ty < room.y + room.h; ty++) {
            for (let tx = room.x; tx < room.x + room.w; tx++) {
              if (d.tiles[ty * d.w + tx] === 0) open++;
            }
          }
          if (inRoom.length > rules.roomDenialCap * Math.max(1, open) + 1e-9) isDenialOk = false;
          // Simultaneity cap: sample one full shared period; count DISTINCT GROUPS with
          // any pulse tile active. Arenas get the gate's +1 allowance (Standard/Brutal).
          const cap = rules.roomSimultaneousCap >= 2 && room.shape === "arena"
            ? Math.min(3, rules.roomSimultaneousCap + 1)
            : rules.roomSimultaneousCap;
          const pulses = inRoom.filter((h) => h.kind !== "toxic_pool");
          for (let t = 0; t < HAZARD_PERIOD; t += 0.05) {
            const active = new Set<number>();
            for (const h of pulses) if (isFloorHazardDamaging(h, t)) active.add(h.group);
            if (active.size > cap) { isConcurrencyOk = false; break; }
          }
          // Release spacing: distinct release instants in this room stay >= 0.30s apart
          // (circular — the schedule repeats every period). Same-instant releases belong
          // to one group erupting as one unit (vent channels). Read through the SAME
          // hook (hazardOnsetsInRoom) the future mob-commitment scheduler will use.
          const releases = floorHazardOnsetsInRoom(hz, room);
          for (let i = 0; i < releases.length; i++) {
            for (let j = i + 1; j < releases.length; j++) {
              if (circGap(releases[i], releases[j]) < HAZARD_RELEASE_GAP - 1e-6) isSpacingOk = false;
            }
          }
          for (const h of pulses) {
            if (!releases.some((r) => Math.abs(r - floorHazardOnset(h)) < 1e-6)) isSpacingOk = false;
          }
        }
      }
    }
  }
  check("per-room simultaneous ACTIVE hazard groups never exceed the mode cap (+1 in arenas)",
    isConcurrencyOk, `rooms checked=${roomsChecked}`);
  check("no two release instants within 0.30s in any room (the overlap arbiter)", isSpacingOk);
  check("per-room hazard denial stays under the mode cap", isDenialOk);
  check("every mode is independently deterministic", isModeDeterministic);
}

function hazardTimingTests(): void {
  section("hazard cycle fairness: long telegraphs, readable rhythm");
  for (const kind of ["spikes", "fire_vent", "void_rift"] as const) {
    const t = HAZARD_TIMING[kind]!;
    check(`${kind}: telegraph >= 0.9s and idle >= 2s (never a surprise)`, t.telegraph >= 0.9 && t.idle >= 2);
    const h: FloorHazard = { id: 0, kind, tx: 0, ty: 0, phase: 0, group: 0 };
    let order = "";
    for (let c = 0; c < floorHazardPeriod(kind); c += 0.05) {
      const ph = floorHazardPhaseAt(h, c);
      const ch = ph === "idle" ? "i" : ph === "telegraph" ? "t" : "a";
      if (!order.endsWith(ch)) order += ch;
    }
    check(`${kind}: cycle runs idle -> telegraph -> active`, order === "ita", order);
    check(`${kind}: phase fraction stays 0..1`, [0.1, 1.3, 2.9, 4.4].every((c) => {
      const f = floorHazardPhaseFrac(h, c);
      return f >= 0 && f <= 1;
    }));
  }
  check("pools are permanently active (and permanently visible)",
    isFloorHazardDamaging({ id: 0, kind: "toxic_pool", tx: 0, ty: 0, phase: 0, group: 0 }, 0.123));
}

// A world at `floor` with combat stripped so only the floor itself can act.
function quietWorld(seed: number, floor: number): WorldState {
  const w = createWorld(seed, floor);
  w.enemies = [];
  w.pendingSpawns = [];
  return w;
}

function findHazardWorld(kind: FloorHazardKind, floor: number): { w: WorldState; h: FloorHazard } {
  for (const seed of SEEDS) {
    const w = quietWorld(seed, floor);
    const h = w.floorHazards.find((x) => x.kind === kind);
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
    let isTelegraphedBeforeHit = false;
    let wasTelegraphSeen = false;
    let hitEvents = 0;
    let hitAt = -1;
    for (let t = 0; t < 60 * 8; t++) {
      const ph = floorHazardPhaseAt(h, w.floorHazardClock + DT);
      if (ph === "telegraph") wasTelegraphSeen = true;
      const evs = step(w, t);
      for (const e of evs) {
        if (e.t === "hazardHit") {
          hitEvents++;
          if (hitAt < 0) { hitAt = t; if (wasTelegraphSeen) isTelegraphedBeforeHit = true; }
        }
      }
      if (hitAt >= 0 && t > hitAt + 30) break;
    }
    check("standing on spikes takes damage when they fire", hitAt >= 0 && p.hp < hp0, `hp ${hp0}->${p.hp}`);
    check("the hit was telegraphed first", isTelegraphedBeforeHit);
    check("post-hit protection prevents same-window melting", hitEvents === 1 && hp0 - p.hp === FLOOR_HAZARD_DAMAGE,
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
  let isPulled = false;
  let isIdleStill = true;
  for (let t = 0; t < 60 * 10; t++) {
    const ph = floorHazardPhaseAt(h, w.floorHazardClock + DT);
    p.x = cx - RIFT_PULL_RADIUS * 0.7;
    p.y = cy;
    const before = Math.hypot(p.x - cx, p.y - cy);
    step(w, t);
    const after = Math.hypot(p.x - cx, p.y - cy);
    if (ph === "active" && after < before - 0.1) isPulled = true;
    if (ph === "idle" && Math.abs(after - before) > 1e-6) isIdleStill = false;
  }
  check("an ACTIVE rift drags a nearby player toward its core", isPulled);
  check("a dormant rift never moves anyone", isIdleStill);
}

// A sandbox arena with combat stripped: only the scripted actors below can act.
function quietArena(seed: number): WorldState {
  const w = createWorld(seed, 1, { isSandbox: true });
  w.isGodMode = true;
  return w;
}

function propInteractionTests(): void {
  section("physical interaction hook: attacks break environment props");
  {
    // Boss hop-slam obliterates the cover it lands on (routed through the canonical
    // enemySmashEnvironment path — radius semantics proven by the far crate surviving).
    const w = quietArena(0xb055);
    const p = w.players.get(LOCAL_ID)!;
    const boss = devSpawnEnemy(w, "boss", p.x + 150, p.y);
    boss.attack.cooldown = 0;
    boss.spawnTimer = 0;
    const crate = devSpawnProp(w, "crate", p.x + 20, p.y);
    const farCrate = devSpawnProp(w, "crate", p.x + 600, p.y + 200);
    let isSlammed = false;
    for (let t = 0; t < 60 * 8 && !isSlammed; t++) {
      if (step(w, t).some((e) => e.t === "bossSlam")) isSlammed = true;
    }
    check("boss slam fired", isSlammed);
    check("cover under the slam shattered", crate.dead);
    check("cover outside the slam radius survived", !farCrate.dead);
  }
  {
    // The boss's body crushes cover it walks through (it does not politely path around).
    const w = quietArena(0xc4a5);
    const p = w.players.get(LOCAL_ID)!;
    const boss = devSpawnEnemy(w, "boss", p.x + 400, p.y);
    boss.attack.cooldown = 1e9; // never attacks: pure chase
    boss.spawnTimer = 0;
    devSpawnProp(w, "barrel", p.x + 200, p.y); // dead on its path to the player
    let isCrushed = false;
    for (let t = 0; t < 60 * 6 && !isCrushed; t++) {
      if (step(w, t).some((e) => e.t === "propBreak")) isCrushed = true;
    }
    check("boss walking through a barrel crushes it", isCrushed);
  }
  {
    // Skeleton charge smashes the crate the player is hiding behind.
    const w = quietArena(0x51a5);
    const p = w.players.get(LOCAL_ID)!;
    const sk = devSpawnEnemy(w, "skeleton", p.x + 160, p.y);
    sk.spawnTimer = 0;
    sk.attack.cooldown = 0;
    devSpawnProp(w, "crate", p.x + 80, p.y);
    let isShattered = false;
    for (let t = 0; t < 60 * 5 && !isShattered; t++) {
      if (step(w, t).some((e) => e.t === "propBreak")) isShattered = true;
    }
    check("a committed lunge shatters cover in its path", isShattered);
  }
  {
    // Enemy fire is stopped by props: cover you can hide behind, and lose.
    const w = quietArena(0xc0e4);
    const p = w.players.get(LOCAL_ID)!;
    w.isGodMode = false;
    const crate = devSpawnProp(w, "crate", p.x + 60, p.y);
    const hpBefore = p.hp;
    const shot: Bullet = {
      x: p.x + 200, y: p.y, vx: -300, vy: 0, radius: 7, life: 3, friendly: false,
      owner: null, damage: 1, color: "#f00", pierce: 0, hitList: null, isCrit: false,
    };
    w.bullets.push(shot);
    for (let t = 0; t < 60; t++) step(w, t);
    check("the crate absorbed the glob (player unhurt behind cover)",
      p.hp === hpBefore && crate.hp < C.PROP_HP.crate && w.bullets.length === 0,
      `hp=${p.hp} crateHp=${crate.hp}`);
  }
  {
    // Boss arenas stage a destructible cover ring (authored, deterministic).
    let isCoverOk = true;
    for (const seed of SEEDS) {
      for (const floor of [5, 20]) {
        const w = createWorld(seed, floor);
        const arena = w.dungeon.rooms[w.dungeon.rooms.length - 1];
        const inArena = w.props.filter((pr) =>
          pr.x >= arena.x * TILE && pr.x < (arena.x + arena.w) * TILE &&
          pr.y >= arena.y * TILE && pr.y < (arena.y + arena.h) * TILE);
        if (inArena.length < 3) isCoverOk = false;
        if (inArena.some((pr) => pr.kind === "brazier")) isCoverOk = false; // ring is all breakable
      }
    }
    check("every boss arena carries a breakable cover ring (3+ props, no braziers)", isCoverOk);
  }
}

function flockTests(): void {
  section("flocking: the canonical bat flock (content module) moves as one animal");
  {
    // Three bats spawned STACKED: the world's flock steering must un-stack them, keep
    // them a loose pack, and still close on the player. Behavioral, implementation-
    // agnostic — the content module in world.ts is the single canonical flock.
    const w = quietArena(0xf10c);
    const p = w.players.get(LOCAL_ID)!;
    const bats = [0, 1, 2].map(() =>
      createEnemy("bat", p.x + 400, p.y + 200, 1, w.rng, w.nextEnemyId++, { tier: "swarm" }));
    for (const b of bats) { b.spawnTimer = 0; w.enemies.push(b); }
    const centroidDist = () => {
      const cx = bats.reduce((s2, b) => s2 + b.x, 0) / 3;
      const cy = bats.reduce((s2, b) => s2 + b.y, 0) / 3;
      return Math.hypot(cx - p.x, cy - p.y);
    };
    const d0 = centroidDist();
    for (let t = 0; t < 90; t++) step(w, t);
    let minPair = Infinity, maxSpread = 0;
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        const d = Math.hypot(bats[i].x - bats[j].x, bats[i].y - bats[j].y);
        minPair = Math.min(minPair, d);
        maxSpread = Math.max(maxSpread, d);
      }
    }
    check("separation un-stacks the pack", minPair > 12, `minPair=${minPair.toFixed(1)}`);
    check("cohesion holds the flock together", maxSpread < 320, `spread=${maxSpread.toFixed(1)}`);
    check("the flock still hunts (centroid closed distance)", centroidDist() < d0 - 40,
      `${d0.toFixed(0)} -> ${centroidDist().toFixed(0)}`);
  }
  {
    // Determinism: the same flock replays byte-identically.
    const run = (): string => {
      const w = quietArena(0xf10c);
      const p = w.players.get(LOCAL_ID)!;
      for (let i = 0; i < 3; i++) {
        const b = createEnemy("bat", p.x + 300, p.y + 150, 1, w.rng, w.nextEnemyId++, { tier: "swarm" });
        b.spawnTimer = 0;
        w.enemies.push(b);
      }
      for (let t = 0; t < 120; t++) step(w, t);
      return JSON.stringify(w.enemies.map((e) => [e.x, e.y, e.zig]));
    };
    check("flock movement is deterministic", run() === run());
  }
}

function swarmSpacingTests(): void {
  section("level-generation spacing: swarm packs get open air");
  let isSpacingOk = true;
  let packsSeen = 0;
  for (const seed of SEEDS) {
    for (const floor of FLOORS) {
      if (isBossFloor(floor)) continue;
      const d = generateDungeon(seed, floor);
      const roomy: boolean[] = d.rooms.map((r) => {
        let open = 0;
        for (let ty = r.y; ty < r.y + r.h; ty++) {
          for (let tx = r.x; tx < r.x + r.w; tx++) {
            if (d.tiles[ty * d.w + tx] === 0) open++;
          }
        }
        return open >= SWARM_ROOM_MIN_AREA;
      });
      // Only enforceable when some non-spawn room qualifies (tiny floors get a pass).
      if (!roomy.some((ok, i) => ok && i > 0)) continue;
      const spawns = spawnFloorEnemies(d, seed, floor);
      const roomOf = (x: number, y: number): number => {
        for (let i = 0; i < d.rooms.length; i++) {
          const r = d.rooms[i];
          if (x >= r.x * TILE && x < (r.x + r.w) * TILE && y >= r.y * TILE && y < (r.y + r.h) * TILE) return i;
        }
        return -1;
      };
      for (const e of [...spawns.active, ...spawns.pending]) {
        if (e.tier !== "swarm") continue;
        packsSeen++;
        const room = roomOf(e.x, e.y);
        if (room >= 0 && !roomy[room]) isSpacingOk = false;
      }
    }
  }
  check(`every floor-spawned swarm unit sits in a room with >=${SWARM_ROOM_MIN_AREA} open tiles`,
    isSpacingOk && packsSeen > 0, `swarm units checked=${packsSeen}`);
}

function wireTests(): void {
  section("hazardHit rides the reliable event wire");
  const w = createWorld(0xbee5, 8);
  const ev: SimEvent = { t: "hazardHit", pid: LOCAL_ID, kind: "spikes", x: 100, y: 200 };
  const msg = buildSnapshot(w, LOCAL_ID, 0, [{ id: 1, e: ev }], 1, false, { worldId: "w-depth-test" });
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
    clock: w.floorHazardClock,
    hz: w.floorHazards,
    p: [p.x, p.y, p.hp],
    e: w.enemies.map((e) => [e.id, Math.round(e.x), Math.round(e.y), e.hp]),
    cleared: isFloorCleared(w),
    biome: biomeForFloor(floor).name,
  });
}

function main(): void {
  generatorInvariantTests();
  archetypeDepthTests();
  curriculumCadenceTests();
  biomeLadderTests();
  hazardPlacementTests();
  studioGateTests();
  hazardTimingTests();
  hazardDamageTests();
  riftPullTests();
  propInteractionTests();
  flockTests();
  swarmSpacingTests();
  wireTests();
  determinismTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nDepth-progression contracts hold (archetypes, biome ladder, hazard fairness).\n");
}

main();
