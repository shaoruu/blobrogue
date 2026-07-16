import { PALE } from "../src/sim/balance.js";
import { PALE_FLOOR } from "../src/sim/enemies.js";
import { giantRingGapCenter, giantSafeIntersection } from "../src/sim/giantGeometry.js";
import type { InputCmd, PlayerId } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { Bullet, Enemy } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import {
  applySelfWire,
  toSelfWire,
} from "../src/net/protocol.js";
import {
  createWorld,
  devSpawnEnemy,
  devSpawnProp,
  isBossExposed,
  loadFloorIntoWorld,
  moveCircle,
  refreshWarmthDrain,
  removePlayerFromWorld,
  setPlayerAbsence,
  spawnPlayerInWorld,
  stepWorld,
} from "../src/sim/world.js";
import type { PlayerSim, WorldState } from "../src/sim/world.js";

const DT = 1 / 60;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, isPassing: boolean, detail = ""): void {
  if (isPassing) {
    passed++;
    process.stdout.write(`  PASS ${name}${detail ? ` — ${detail}` : ""}\n`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ""}\n`);
  }
}

function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

function command(seq: number, moveX = 0, moveY = 0, interact = false): InputCmd {
  return { seq, moveX, moveY, aim: 0, firing: false, dash: false, interact };
}

function bullet(x: number, y: number, damage: number, radius = 18, isFriendly = true): Bullet {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    radius,
    life: 0.05,
    friendly: isFriendly,
    owner: isFriendly ? LOCAL_ID : null,
    damage,
    color: "#fff",
    pierce: 0,
    hitList: null,
    isCrit: false,
  };
}

function arena(players: number, seed: number): { world: WorldState; boss: Enemy; ids: PlayerId[] } {
  const world = createWorld(seed, PALE_FLOOR, { isSandbox: true, isShared: players > 1, skipLocalPlayer: true });
  const ids: PlayerId[] = [];
  for (let index = 0; index < players; index++) {
    const id = index === 0 ? LOCAL_ID : `p${index}`;
    const player = spawnPlayerInWorld(world, id);
    const angle = (index / players) * Math.PI * 2;
    player.x = 17 * TILE + Math.cos(angle) * 210;
    player.y = 12 * TILE + Math.sin(angle) * 210;
    player.invuln = 0;
    ids.push(id);
  }
  world.encounterPlayers = players;
  world.isGodMode = true;
  const boss = devSpawnEnemy(world, "pale", 17 * TILE, 12 * TILE);
  boss.spawnTimer = 0;
  boss.attack.cooldown = 0;
  return { world, boss, ids };
}

function liveSeams(world: WorldState, bank?: number): Enemy[] {
  return world.enemies.filter((enemy) =>
    !enemy.dead && enemy.kind === "pale_seam" && (bank === undefined || enemy.aux === bank));
}

function exposeSeams(world: WorldState, boss: Enemy, ids: PlayerId[]): void {
  if (boss.boss === null) throw new Error("Pale boss state missing");
  boss.boss.addTimer = 0;
  stepWorld(world, new Map(ids.map((id, index) => [id, command(index)])), DT);
}

function clearSeams(world: WorldState, ids: PlayerId[], seams: Enemy[]): void {
  for (const seam of seams) world.bullets.push(bullet(seam.x, seam.y, 9999));
  stepWorld(world, new Map(ids.map((id, index) => [id, command(100 + index)])), DT);
  stepWorld(world, new Map(ids.map((id, index) => [id, command(200 + index)])), DT);
}

function angleDelta(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

function coOpBankGates(): void {
  section("Pale co-op peel coordination: deterministic two-flank banks with safe fallback");
  {
    const { world, boss, ids } = arena(1, 0xC001);
    exposeSeams(world, boss, ids);
    check("1P exposes exactly one flank bank", liveSeams(world).length > 0 && liveSeams(world).every((seam) => seam.aux === 1));
  }
  {
    const { world, boss, ids } = arena(2, 0xC002);
    exposeSeams(world, boss, ids);
    const bank1 = liveSeams(world, 1);
    const bank2 = liveSeams(world, 2);
    const facing1 = Math.atan2(bank1[0].y - boss.y, bank1[0].x - boss.x);
    const facing2 = Math.atan2(bank2[0].y - boss.y, bank2[0].x - boss.x);
    check("2P exposes two non-empty deterministic banks", bank1.length > 0 && bank2.length > 0);
    check("the two fronts are physically disjoint", angleDelta(facing1, facing2) >= PALE.seamBankMinSeparationRad * 0.8);
    clearSeams(world, ids, bank1);
    check("clearing one bank alone never opens the earned window", !isBossExposed(boss) && liveSeams(world, 2).length > 0);
    clearSeams(world, ids, liveSeams(world, 2));
    check("clearing both banks opens one shared regroup window", isBossExposed(boss));
  }
  {
    const { world, boss, ids } = arena(4, 0xC004);
    exposeSeams(world, boss, ids);
    const bank1 = liveSeams(world, 1);
    const bank2 = liveSeams(world, 2);
    const centroid = (seams: Enemy[]): { x: number; y: number } => ({
      x: seams.reduce((sum, seam) => sum + seam.x, 0) / seams.length,
      y: seams.reduce((sum, seam) => sum + seam.y, 0) / seams.length,
    });
    const a = centroid(bank1);
    const b = centroid(bank2);
    check("4P still exposes exactly two readable flank fronts", bank1.length > 0 && bank2.length > 0 && bank1.length + bank2.length <= PALE.seamCap);
    check("one firing position cannot trivially cover both fronts", Math.hypot(a.x - b.x, a.y - b.y) > PALE.seamRingDist);
    for (const seam of [...bank1, ...bank2]) {
      const owner = seam.aux === 1 ? world.players.get(ids[0])! : world.players.get(ids[2])!;
      const dx = seam.x - owner.x;
      const dy = seam.y - owner.y;
      const length = Math.hypot(dx, dy);
      const [x, y] = moveCircle(world, owner.x, owner.y, owner.pr, (dx / length) * 20, (dy / length) * 20);
      check(`bank ${seam.aux} seam ${seam.id} has a reachable approach`, Math.hypot(x - owner.x, y - owner.y) > 0);
    }
  }
  {
    const { world, boss, ids } = arena(2, 0xC005);
    exposeSeams(world, boss, ids);
    const second = world.players.get(ids[1])!;
    second.isDown = true;
    clearSeams(world, ids, liveSeams(world));
    check("a downed flank anchor never deadlocks an exposure already in progress", isBossExposed(boss));
    boss.boss!.exposed = 0;
    boss.boss!.windowAddIds.length = 0;
    boss.boss!.addTimer = 0;
    exposeSeams(world, boss, ids);
    check("the next exposure deterministically collapses to solo while one player is down", liveSeams(world).every((seam) => seam.aux === 1));
  }
  {
    const { world, boss, ids } = arena(2, 0xC006);
    setPlayerAbsence(world, ids[1], true);
    exposeSeams(world, boss, ids);
    check("an absent seat is excluded before bank assignment", liveSeams(world).every((seam) => seam.aux === 1));
  }
  {
    const { world, boss, ids } = arena(2, 0xC007);
    removePlayerFromWorld(world, ids[1]);
    exposeSeams(world, boss, [ids[0]]);
    check("a departed seat collapses the next exposure without deadlock", liveSeams(world).every((seam) => seam.aux === 1));
  }
}

interface Point {
  x: number;
  y: number;
}

function segmentDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0
    ? 0
    : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

function isDangerous(
  world: WorldState,
  point: Point,
  bulletSegments: Array<{ start: Point; end: Point; radius: number }>,
  playerRadius: number,
): boolean {
  for (const segment of bulletSegments) {
    if (segmentDistance(point, segment.start, segment.end) <= playerRadius + segment.radius) return true;
  }
  for (const hazard of world.hazards) {
    if (hazard.life > 0 && (hazard.kind === "cinder" || hazard.kind === "charge")
      && Math.hypot(point.x - hazard.x, point.y - hazard.y) <= playerRadius + hazard.radius) {
      return true;
    }
  }
  return false;
}

function advanceReachable(
  world: WorldState,
  reachable: Point[],
  bulletSegments: Array<{ start: Point; end: Point; radius: number }>,
  playerRadius: number,
  speed: number,
): Point[] {
  const next = new Map<string, Point>();
  const directions = [
    [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
    [Math.SQRT1_2, Math.SQRT1_2], [Math.SQRT1_2, -Math.SQRT1_2],
    [-Math.SQRT1_2, Math.SQRT1_2], [-Math.SQRT1_2, -Math.SQRT1_2],
  ] as const;
  for (const point of reachable) {
    for (const [dx, dy] of directions) {
      const [x, y] = moveCircle(world, point.x, point.y, playerRadius, dx * speed * DT, dy * speed * DT);
      const candidate = { x, y };
      if (isDangerous(world, candidate, bulletSegments, playerRadius)) continue;
      const key = `${Math.round(x / 3)},${Math.round(y / 3)}`;
      if (!next.has(key)) next.set(key, candidate);
    }
  }
  const values = [...next.values()];
  if (values.length <= 2500) return values;
  return values.filter((_, index) => index % Math.ceil(values.length / 2500) === 0);
}

function bulletSegments(world: WorldState, before: Map<Bullet, Point>): Array<{ start: Point; end: Point; radius: number }> {
  return world.bullets
    .filter((entry) => !entry.friendly)
    .map((entry) => ({ start: before.get(entry) ?? { x: entry.x, y: entry.y }, end: { x: entry.x, y: entry.y }, radius: entry.radius }));
}

function isInsideGap(angle: number, center: number, width: number, inset: number): boolean {
  return angleDelta(angle, center) <= width / 2 - inset;
}

function ring2NavigationGate(): void {
  section("P1 ring2: exact armed footprint and physical no-dash transition");
  const { world, boss, ids } = arena(1, 0xA111);
  const player = world.players.get(ids[0])!;
  boss.boss!.phase = 1;
  boss.boss!.attackCount = 3;
  boss.attack = {
    phase: "windup", time: PALE.ringWindup - DT / 2, move: "slam", windup: 0.99, cooldown: 0,
    lockedAngle: 0, isAimLocked: false, markX: boss.x, markY: boss.y,
  };
  devSpawnProp(world, "pale_debris", boss.x + 105, boss.y + 55);
  stepWorld(world, new Map([[LOCAL_ID, command(0)]]), DT);
  const gapWidth = (PALE.ringGap / PALE.ringCount) * Math.PI * 2;
  const gapA = giantRingGapCenter(boss.boss!.attackCount, 0, PALE);
  const gapB = giantRingGapCenter(boss.boss!.attackCount, 1, PALE);
  const radii = [175, 225];
  const starts: Point[][] = [];
  for (const radius of radii) {
    const inset = Math.asin(Math.min(0.99, (player.pr + PALE.globRadius) / radius));
    for (const offset of [-gapWidth / 2 + inset + 0.03, 0, gapWidth / 2 - inset - 0.03]) {
      const point = { x: boss.x + Math.cos(gapA + offset) * radius, y: boss.y + Math.sin(gapA + offset) * radius };
      if (!isDangerous(world, point, [], player.pr)) starts.push([point]);
    }
  }
  if (starts.length < 4) throw new Error(`ring2 setup produced only ${starts.length} legal edge/center starts`);
  const isReached = starts.map(() => false);
  for (let index = 0; index < starts.length; index++) {
    for (const point of starts[index]) {
      const radius = Math.hypot(point.x - boss.x, point.y - boss.y);
      const inset = Math.asin(Math.min(0.99, (player.pr + PALE.globRadius) / radius));
      if (isInsideGap(Math.atan2(point.y - boss.y, point.x - boss.x), gapB, gapWidth, inset)) {
        isReached[index] = true;
      }
    }
  }
  const frames = Math.ceil(PALE.ring2DelaySec / DT);
  let isEveryFrameOpen = true;
  for (let tick = 0; tick < frames; tick++) {
    const before = new Map(world.bullets.map((entry) => [entry, { x: entry.x, y: entry.y }]));
    stepWorld(world, new Map([[LOCAL_ID, command(tick + 1)]]), DT);
    const segments = bulletSegments(world, before);
    for (let index = 0; index < starts.length; index++) {
      if (isReached[index]) continue;
      starts[index] = advanceReachable(world, starts[index], segments, player.pr, 200);
      if (starts[index].length === 0) isEveryFrameOpen = false;
      for (const point of starts[index]) {
        const radius = Math.hypot(point.x - boss.x, point.y - boss.y);
        const inset = Math.asin(Math.min(0.99, (player.pr + PALE.globRadius) / radius));
        if (isInsideGap(Math.atan2(point.y - boss.y, point.x - boss.x), gapB, gapWidth, inset)) {
          isReached[index] = true;
          break;
        }
      }
    }
  }
  check("the ring2 tell is armed for the full transition after ring1 releases",
    boss.attack.move === "slam" && (boss.attack.phase === "active" || boss.attack.phase === "recover"));
  check("no sampled frame collapses all reachable walk space", isEveryFrameOpen);
  check("edge and center starts at representative radii all walk A→B before ring2", isReached.every(Boolean), isReached.join(","));
}

function seedP2Pools(world: WorldState, boss: Enemy, ids: PlayerId[]): void {
  boss.boss!.phase = 2;
  for (let beat = 0; beat < 3; beat++) {
    boss.attack = {
      phase: "windup", time: PALE.zoneWindup - DT / 2, move: "spew", windup: 0.99, cooldown: 0,
      lockedAngle: 0, isAimLocked: false, markX: boss.x, markY: boss.y,
    };
    stepWorld(world, new Map(ids.map((id, index) => [id, command(beat * 10 + index)])), DT);
  }
}

function sweepNavigationRun(players: number, seed: number): {
  isRouteOpen: boolean;
  minReachable: number;
  collapseTick: number;
  collapsedStart: number;
} {
  const { world, boss, ids } = arena(players, seed);
  seedP2Pools(world, boss, ids);
  devSpawnProp(world, "pale_debris", boss.x + 90, boss.y);
  devSpawnProp(world, "pale_debris", boss.x - 70, boss.y + 70);
  boss.boss!.phase = 3;
  boss.boss!.burstParity = 1;
  boss.boss!.spinCount = 0;
  boss.attack = {
    phase: "windup", time: PALE.spokeWindup - DT / 2, move: "sweep", windup: 0.99, cooldown: 0,
    lockedAngle: 0, isAimLocked: false, markX: boss.x, markY: boss.y,
  };
  stepWorld(world, new Map(ids.map((id, index) => [id, command(100 + index)])), DT);
  for (const player of world.players.values()) player.isAbsent = true;

  const initialSafe = giantSafeIntersection(0, boss.boss!.burstParity, PALE);
  if (initialSafe === null) throw new Error("Pale sweep has no initial safe intersection");
  const starts: Point[][] = [];
  for (const radius of [170, 210]) {
    const bodyInset = Math.asin(Math.min(0.99, (18 + PALE.globRadius) / radius));
    const offsets = radius === 170 ? [-initialSafe.width / 2 + bodyInset + 0.04, 0] : [0];
    for (const offset of offsets) {
      const point = {
        x: boss.x + Math.cos(initialSafe.center + offset) * radius,
        y: boss.y + Math.sin(initialSafe.center + offset) * radius,
      };
      if (!isDangerous(world, point, [], 18)) starts.push([point]);
    }
  }
  if (starts.length < 3) throw new Error(`Pale sweep setup produced only ${starts.length} legal representative starts`);
  let minReachable = Number.POSITIVE_INFINITY;
  let isRouteOpen = true;
  let collapseTick = -1;
  let collapsedStart = -1;
  const maxFrames = Math.ceil((PALE.spokeDuration + PALE.globLife + 0.5) / DT);
  for (let tick = 0; tick < maxFrames; tick++) {
    const before = new Map(world.bullets.map((entry) => [entry, { x: entry.x, y: entry.y }]));
    stepWorld(world, new Map(ids.map((id, index) => [id, command(200 + tick * ids.length + index)])), DT);
    const segments = bulletSegments(world, before);
    for (let index = 0; index < starts.length; index++) {
      starts[index] = advanceReachable(world, starts[index], segments, 18, 100);
      minReachable = Math.min(minReachable, starts[index].length);
      if (starts[index].length === 0) {
        isRouteOpen = false;
        if (collapseTick < 0) {
          collapseTick = tick;
          collapsedStart = index;
        }
      }
    }
  }
  return { isRouteOpen: isRouteOpen && starts.every((set) => set.length > 0), minReachable, collapseTick, collapsedStart };
}

function sweepNavigationGates(): void {
  section("P3 swept volume: real bullets, pools, debris, walls, body radius, and worst warmth slow");
  const one = sweepNavigationRun(1, 0xA301);
  const four = sweepNavigationRun(4, 0xA304);
  check("1P representative center/edge starts retain a continuous no-damage walk route", one.isRouteOpen,
    `minReachable=${one.minReachable} collapse=${one.collapseTick}/start${one.collapsedStart}`);
  check("4P representative center/edge starts retain a continuous no-damage walk route", four.isRouteOpen,
    `minReachable=${four.minReachable} collapse=${four.collapseTick}/start${four.collapsedStart}`);
  for (let emission = 0; emission <= Math.ceil(PALE.spokeDuration / PALE.spokeInterval); emission++) {
    const safe = giantSafeIntersection(emission, 1, PALE);
    check(`emission ${emission} keeps an explicitly bounded safe intersection`, safe !== null && safe.width > 0.12);
  }
}

function forceWarmth(world: WorldState, boss: Enemy): PlayerSim {
  boss.boss!.phase = 3;
  refreshWarmthDrain(world);
  const player = world.players.get(LOCAL_ID)!;
  player.invuln = 0;
  return player;
}

function idleUntilChilled(world: WorldState, boss: Enemy): PlayerSim {
  const player = forceWarmth(world, boss);
  for (let tick = 0; tick < Math.ceil((PALE.warmthDrainIdleSec + 0.2) / DT); tick++) {
    stepWorld(world, new Map([[LOCAL_ID, command(tick)]]), DT);
  }
  return player;
}

function warmthSemanticsGates(): void {
  section("warmth authority: intent-gated idle, cumulative self path, lifecycle resets, and wire truth");
  {
    const { world, boss } = arena(1, 0xB101);
    const player = idleUntilChilled(world, boss);
    check("true idle deterministically chills", player.isWarmthChilled && player.warmthIdleSec >= PALE.warmthDrainIdleSec);
    const startX = player.x;
    for (let tick = 0; tick < 90 && player.isWarmthChilled; tick++) {
      stepWorld(world, new Map([[LOCAL_ID, command(1000 + tick, -1)]]), DT);
    }
    check("straight self-propelled movement thaws after the cumulative path threshold",
      !player.isWarmthChilled && Math.abs(player.x - startX) >= PALE.warmthDrainMoveClearTiles * TILE);
  }
  {
    const { world, boss } = arena(1, 0xB102);
    const player = idleUntilChilled(world, boss);
    const startX = player.x;
    for (let tick = 0; tick < 15; tick++) stepWorld(world, new Map([[LOCAL_ID, command(2000 + tick, 1)]]), DT);
    for (let tick = 0; tick < 40 && player.isWarmthChilled; tick++) {
      stepWorld(world, new Map([[LOCAL_ID, command(2100 + tick, -1)]]), DT);
    }
    check("reversing movement clears by path length even after returning near the anchor",
      !player.isWarmthChilled && Math.abs(player.x - startX) < 8, `net=${Math.abs(player.x - startX).toFixed(2)}`);
  }
  {
    const { world, boss } = arena(1, 0xB103);
    const player = forceWarmth(world, boss);
    player.warmthIdleSec = 1;
    player.x = TILE + player.pr;
    const x = player.x;
    for (let tick = 0; tick < 120; tick++) stepWorld(world, new Map([[LOCAL_ID, command(3000 + tick, -1)]]), DT);
    check("wall-holding intent pauses idle accrual", Math.abs(player.warmthIdleSec - 1) < 1e-6);
    check("blocked intent never fakes a thaw path", player.x === x && player.warmthPathPx === 0);
  }
  {
    const { world, boss } = arena(1, 0xB104);
    const player = idleUntilChilled(world, boss);
    player.x += TILE * 2;
    stepWorld(world, new Map([[LOCAL_ID, command(4000)]]), DT);
    check("external displacement and teleport-like motion do not clear chill", player.isWarmthChilled && player.warmthPathPx === 0);
  }
  {
    const { world, boss, ids } = arena(2, 0xB105);
    const player = forceWarmth(world, boss);
    player.warmthIdleSec = PALE.warmthDrainIdleSec;
    player.isWarmthChilled = true;
    setPlayerAbsence(world, ids[0], true);
    check("absence resets all stored warmth state", player.warmthIdleSec === 0 && player.warmthPathPx === 0 && !player.isWarmthChilled);
    player.warmthIdleSec = 1;
    setPlayerAbsence(world, ids[0], false);
    check("resume is always unchilled with a full warning runway", player.warmthIdleSec === 0 && !player.isWarmthChilled);
  }
  {
    const { world, boss, ids } = arena(2, 0xB10A);
    const downed = forceWarmth(world, boss);
    const reviver = world.players.get(ids[1])!;
    downed.warmthIdleSec = PALE.warmthDrainIdleSec;
    downed.isWarmthChilled = true;
    downed.hp = 1;
    downed.invuln = 0;
    reviver.x = downed.x + 24;
    reviver.y = downed.y;
    world.isGodMode = false;
    boss.spawnTimer = 999;
    world.bullets.push(bullet(downed.x, downed.y, 1, 8, false));
    stepWorld(world, new Map([[ids[0], command(5000)], [ids[1], command(5001)]]), DT);
    check("down transition resets all warmth state", downed.isDown && downed.warmthIdleSec === 0 && !downed.isWarmthChilled);
    for (let tick = 0; tick < 100 && downed.isDown; tick++) {
      stepWorld(world, new Map([
        [ids[0], command(5100 + tick * 2)],
        [ids[1], command(5101 + tick * 2, 0, 0, true)],
      ]), DT);
    }
    check("revive returns unchilled at normal speed with a full warning runway",
      !downed.isDown && downed.warmthIdleSec === 0 && downed.warmthPathPx === 0 && !downed.isWarmthChilled);
  }
  {
    const { world, boss } = arena(1, 0xB106);
    const player = idleUntilChilled(world, boss);
    const wire = toSelfWire(player);
    player.warmthIdleSec = 0;
    player.warmthPathPx = 0;
    player.isWarmthChilled = false;
    applySelfWire(player, wire);
    check("snapshot reconciliation restores the exact authoritative timer/path/chill",
      player.warmthIdleSec === wire.wit && player.warmthPathPx === wire.wpx && player.isWarmthChilled === wire.wch);
    boss.boss!.phase = 2;
    refreshWarmthDrain(world);
    check("P3 exit resets warmth immediately", player.warmthIdleSec === 0 && !player.isWarmthChilled);
    player.warmthIdleSec = 1;
    boss.boss!.phase = 3;
    boss.dead = true;
    refreshWarmthDrain(world);
    check("boss death resets warmth", player.warmthIdleSec === 0 && !player.isWarmthChilled);
    player.warmthIdleSec = 1;
    loadFloorIntoWorld(world, 76);
    check("floor load resets warmth", player.warmthIdleSec === 0 && player.warmthPathPx === 0);
  }
  const trace = (players: number): string => {
    const { world, boss, ids } = arena(players, 0xB200 + players);
    forceWarmth(world, boss);
    for (let tick = 0; tick < 120; tick++) {
      stepWorld(world, new Map(ids.map((id, index) => [
        id,
        command(tick * ids.length + index, index === 0 ? 0 : index % 2 === 0 ? 1 : -1),
      ])), DT);
    }
    return JSON.stringify(ids.map((id) => {
      const player = world.players.get(id)!;
      return [player.warmthIdleSec, player.warmthPathPx, player.isWarmthChilled, player.x, player.y];
    }));
  };
  for (const players of [1, 2, 4]) {
    check(`${players}P warmth state replays deterministically`, trace(players) === trace(players));
  }
}

function hitRadiusGates(): void {
  section("Pale hit radius: deterministic cardinal and diagonal grazes");
  const directions = Array.from({ length: 8 }, (_, index) => (index / 8) * Math.PI * 2);
  let isEveryInsideHit = true;
  let isEveryOutsideMiss = true;
  for (let index = 0; index < directions.length; index++) {
    for (const isInside of [true, false]) {
      const { world, boss, ids } = arena(1, 0xD000 + index * 2 + (isInside ? 0 : 1));
      boss.boss!.exposed = 2;
      boss.boss!.windowBank = 100;
      const radius = 4;
      const distance = boss.radius + radius + (isInside ? -0.25 : 0.25);
      world.bullets.push(bullet(
        boss.x + Math.cos(directions[index]) * distance,
        boss.y + Math.sin(directions[index]) * distance,
        1,
        radius,
      ));
      const hp = boss.hp;
      stepWorld(world, new Map([[ids[0], command(index)]]), DT);
      if (isInside) isEveryInsideHit &&= boss.hp < hp;
      else isEveryOutsideMiss &&= boss.hp === hp;
    }
  }
  check("cardinal and diagonal first-solid-contact grazes damage", isEveryInsideHit);
  check("cardinal and diagonal rime-side grazes outside the solid radius miss", isEveryOutsideMiss);
  check("the current radius remains 60 pending approved replacement sprite bbox audit", arena(1, 0xD100).boss.radius === 60);
}

function main(): void {
  coOpBankGates();
  ring2NavigationGate();
  sweepNavigationGates();
  warmthSemanticsGates();
  hitRadiusGates();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) {
    process.stdout.write(`FAILURES:\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`);
    process.exit(1);
  }
}

main();
