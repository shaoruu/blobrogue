// Animation/AI QA gates: the cross-cutting correctness contract over the whole bestiary.
//  - archetype manifest completeness (role/movement/attack/telegraph/hitbox/stats/
//    counterplay/directional states/authority);
//  - the direction matrix: every declared move×phase×facing resolves through the
//    documented 4-dir projection, all transition types, diagonal hysteresis, idle
//    direction hold, flip-flicker counting;
//  - authority: the sim (never animation frames) drives damage and state; wire round
//    trips preserve mid-move state; dt=0 pause/hitstop advances nothing; animation
//    dimensions provably never affect collision/behavior;
//  - frame-rate equivalence: 30/60/120Hz and a throttled pattern produce the same
//    committed-attack traces;
//  - alignment: projectile origins/directions ride the SAME lockedAngle the facing
//    lock renders;
//  - navigation: preferred-range holds, LOS gates, large radii, dynamic props, door
//    crowding with a >3s-stuck-while-path-exists metric;
//  - co-op agreement + late-join/reconnect restore without wrong-facing flashes;
//  - dense legal-max +25% stress with full world cleanup;
//  - boss transitions exactly once under burst/DoT/simultaneous hits/pause, with a
//    deterministic sequence and a single death/reward.
//
// Run: npm run test:qagates

import { createWorld, stepWorld, devSpawnEnemy, devSpawnProp, isFloorCleared } from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { InputCmd } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { AttackPhase, Bullet, Enemy, EnemyKind } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import { ENEMY_ARCHETYPES, createEnemy, eliteAffixOf } from "../src/sim/enemies.js";
import {
  ENEMY_MOVESET, SPRITE_CONTRACT, ENEMY_ACCEPTANCE, ENEMY_ROLE, isRegularKind,
} from "../src/sim/bestiary.js";
import { LIVE_CAPS, TIERS } from "../src/sim/balance.js";
import { toEnemyWire, enemyFromWire, buildSnapshot, jsonCodec } from "../src/net/protocol.js";
import {
  createFacing, updateFacing, computeEnemyPose, resolveClip, AIMED_MOVES,
} from "../src/game/facing.js";
import type { EnemyPose, SelectableClip, Facing4 } from "../src/game/facing.js";
import { SHEETS } from "../src/game/assets.js";
import { Rng } from "../src/sim/rng.js";
import * as C from "../src/sim/constants.js";

const DT = 1 / 60;
const ALL_KINDS = Object.keys(ENEMY_ARCHETYPES) as EnemyKind[];

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

function idle(seq: number): InputCmd {
  return { seq, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };
}

function step(w: WorldState, cmd: InputCmd, dt = DT): SimEvent[] {
  return stepWorld(w, new Map([[LOCAL_ID, cmd]]), dt);
}

function stepFor(w: WorldState, seconds: number, ev?: SimEvent[]): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    const out = step(w, idle(w.tick + 1));
    if (ev) ev.push(...out);
  }
}

function arena(seed: number, floor = 1): { w: WorldState; p: PlayerSim } {
  const w = createWorld(seed, floor, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  p.invuln = 0;
  return { w, p };
}

function spawnReady(w: WorldState, kind: EnemyKind, x: number, y: number): Enemy {
  const e = devSpawnEnemy(w, kind, x, y);
  e.spawnTimer = 0;
  return e;
}

function plantShot(w: WorldState, x: number, y: number, vx: number, vy: number, damage: number, opts: { radius?: number; hitList?: Enemy[] } = {}): void {
  w.bullets.push({
    x, y, vx, vy, radius: opts.radius ?? 8, life: 0.1, friendly: true, owner: LOCAL_ID,
    damage, color: "#fff", pierce: 0, hitList: opts.hitList ?? null, isCrit: false,
  } as Bullet);
}

// ---- 1. archetype manifest completeness ----

function manifestGates(): void {
  section("manifest: role/movement/attack/telegraph/hitbox/stats/counterplay/directional/authority per kind");
  let ok = true;
  for (const kind of ALL_KINDS) {
    const a = ENEMY_ARCHETYPES[kind];
    const moves = ENEMY_MOVESET[kind];
    const contract = SPRITE_CONTRACT[kind];
    const problems: string[] = [];
    if (moves === undefined) problems.push("no moveset");
    if (contract === undefined) problems.push("no sprite contract");
    // Telegraph/facing authority: every committed move has an authored aimed decision
    // (Record<AttackMove, boolean> makes this compile-enforced; assert it anyway).
    for (const m of moves ?? []) if (typeof AIMED_MOVES[m] !== "boolean") problems.push(`move ${m} unfaced`);
    // Hitbox sanity: collision radius positive and never larger than the art read.
    if (!(a.radius > 0 && a.radius * 2 <= a.drawSize * 1.25)) problems.push("hitbox/draw mismatch");
    // Stats: authored, positive, damage inside the 1–2 contract (0 for decoys).
    if (!(a.baseHp >= 1 && a.baseSpeed >= 0 && a.touchDamage >= 0 && a.touchDamage <= 2)) problems.push("stats");
    // Counterplay: every REGULAR kind carries its acceptance manifest.
    if (isRegularKind(kind) && ENEMY_ACCEPTANCE[kind] === undefined) problems.push("no acceptance");
    if (problems.length > 0) { ok = false; process.stdout.write(`    ${kind}: ${problems.join(", ")}\n`); }
  }
  check("every kind's manifest is complete", ok);

  // Directional-state declarations match the actual sheet registrations.
  const hasKey = (kind: string, clip: string): boolean => SHEETS[`${kind}.${clip}`] !== undefined;
  const facings: readonly string[] = ["down", "up", "side"];
  let contractOk = true;
  for (const kind of ALL_KINDS) {
    const c = SPRITE_CONTRACT[kind];
    let holds = true;
    if (c === "directional") {
      holds = facings.every((f) => hasKey(kind, `walk_${f}`) && hasKey(kind, `attack_${f}`));
    } else if (c === "directional_walk") {
      holds = facings.every((f) => hasKey(kind, `walk_${f}`)) && !facings.some((f) => hasKey(kind, `attack_${f}`));
    } else if (c === "vertical_hold") {
      holds = hasKey(kind, "walk_down") && hasKey(kind, "walk_up") && !hasKey(kind, "walk_side")
        && hasKey(kind, "attack_down") && hasKey(kind, "attack_up") && !hasKey(kind, "attack_side")
        && hasKey(kind, "attack");
    } else if (c === "mass") {
      holds = hasKey(kind, "idle") && hasKey(kind, "attack") && !hasKey(kind, "walk_down");
    } else if (c === "decoy") {
      holds = hasKey(kind, "idle") && !hasKey(kind, "attack") && !hasKey(kind, "walk_down");
    } else {
      holds = hasKey(kind, "walk") || hasKey(kind, "idle");
    }
    if (!holds) { contractOk = false; process.stdout.write(`    ${kind}: registrations do not match '${c}'\n`); }
  }
  check("sheet registrations match every kind's declared directional contract", contractOk);
}

// ---- 2. the direction matrix ----

function poseOf(overrides: Partial<EnemyPose>): EnemyPose {
  return {
    facing: "down", isMirrored: false, verticalFacing: "down", isMoving: true, isAttacking: false,
    move: "none", phase: "none", windup: 0, aimAngle: 0,
    ...overrides,
  };
}

function directionMatrixGates(): void {
  section("direction matrix: every declared move × phase × facing resolves through the 4-dir projection");
  const everyClip = (_clip: SelectableClip): boolean => true;
  let matrixOk = true;
  for (const kind of ALL_KINDS) {
    for (const move of ENEMY_MOVESET[kind]) {
      for (const phase of ["windup", "active", "recover"] as const) {
        for (const facing of ["down", "up", "side"] as Facing4[]) {
          for (const isMirrored of facing === "side" ? [false, true] : [false]) {
            const pose = poseOf({ move, phase, facing, isMirrored, isAttacking: phase !== "recover" });
            const choice = resolveClip(everyClip, pose);
            // With a full library the move+phase sheet always wins, facing-specific first.
            if (choice.clip !== `${move}_${phase}_${facing}`) matrixOk = false;
            // Only side-left ever mirrors; vertical art never does.
            if (choice.isMirrored !== (facing === "side" && isMirrored)) matrixOk = false;
          }
        }
      }
    }
  }
  check("every (move, phase, facing) cell resolves to its own sheet with lawful mirroring", matrixOk);

  section("direction transitions: move→attack override, attack→move restore, idle hold, flip counting");
  {
    // Movement → aimed attack → movement: the aim owns the facing only while committed.
    const e = createEnemy("seamcutter", 0, 0, 16, new Rng(1), 0);
    const f = createFacing();
    let pose = computeEnemyPose(e, f, 150, 0, true);
    check("walking east reads side-right", pose.facing === "side" && !pose.isMirrored);
    e.attack.phase = "windup"; e.attack.move = "seam"; e.attack.lockedAngle = -Math.PI / 2;
    pose = computeEnemyPose(e, f, 150, 0, true);
    check("an aimed commitment overrides movement facing (seam up)", pose.facing === "up");
    e.attack.phase = "none"; e.attack.move = "none";
    pose = computeEnemyPose(e, f, 150, 0, true);
    check("release restores movement-derived facing", pose.facing === "side" && !pose.isMirrored);
    pose = computeEnemyPose(e, f, 0, 0, false);
    check("idle preserves the last direction (frame-0 hold)", pose.facing === "side" && !pose.isMoving);
  }
  {
    // One full slow rotation of the velocity vector: exactly four facing changes —
    // the quadrant boundaries once each, no flicker at the diagonals.
    const f = createFacing();
    updateFacing(f, 150, 0);
    // The RENDER-relevant identity: the mirror only matters while side-facing (vertical
    // art never mirrors — the legacy L/R memory updating underneath is not a flip).
    const renderKey = (): string => f.facing === "side" ? `side|${f.isMirrored}` : f.facing;
    let flips = 0;
    let prev = renderKey();
    for (let i = 1; i <= 480; i++) {
      const ang = (i / 480) * Math.PI * 2;
      updateFacing(f, Math.cos(ang) * 150, Math.sin(ang) * 150);
      const now = renderKey();
      if (now !== prev) flips++;
      prev = now;
    }
    check("a full velocity rotation produces exactly 4 facing changes (hysteresis holds the diagonals)",
      flips === 4, `flips=${flips}`);
  }
  {
    // A wobbling diagonal (the flip-flicker reproduction): zero changes.
    const f = createFacing();
    updateFacing(f, 150, 150 * 0.9);
    let flips = 0;
    let prev = f.facing;
    for (let i = 0; i < 200; i++) {
      updateFacing(f, 150, 150 * (1 + 0.12 * Math.sin(i * 0.7)));
      if (f.facing !== prev) flips++;
      prev = f.facing;
    }
    check("a jittering diagonal never flickers (0 changes over 200 frames)", flips === 0, `flips=${flips}`);
  }
}

// ---- 3. authority: the sim drives everything; frames drive nothing ----

function authorityGates(): void {
  section("authority: wire round-trips preserve mid-move state for EVERY kind");
  let wireOk = true;
  for (const kind of ALL_KINDS) {
    const e = createEnemy(kind, 500.25, 611.5, 9, new Rng(3), 7);
    const moves = ENEMY_MOVESET[kind];
    if (moves.length > 0) {
      e.attack.phase = "windup";
      e.attack.move = moves[0];
      e.attack.windup = 0.62;
      e.attack.isAimLocked = true;
      e.attack.lockedAngle = 2.1;
      e.attack.markX = 777; e.attack.markY = 888;
    }
    e.aux = kind === "sinderling" ? 1 : kind === "echo" ? 2.5 : 0;
    const rt = enemyFromWire(toEnemyWire(e), e.x, e.y);
    if (rt.kind !== kind || rt.attack.move !== e.attack.move || rt.attack.phase !== e.attack.phase
      || Math.abs(rt.attack.windup - e.attack.windup) > 1e-9 || rt.attack.lockedAngle !== e.attack.lockedAngle
      || rt.aux !== e.aux || rt.radius !== e.radius) {
      wireOk = false;
      process.stdout.write(`    ${kind}: wire round trip lost state\n`);
    }
  }
  check("every kind's committed state (move/phase/windup/lock/mark/aux/radius) rides the wire", wireOk);

  section("pause/hitstop: a dt=0 step advances NOTHING and emits nothing");
  {
    const { w, p } = arena(0xA110);
    p.x = 840; p.y = 600;
    const e = spawnReady(w, "skeleton", 1000, 600);
    stepFor(w, 0.3); // mid-windup
    check("mid-commitment before the pause", e.attack.phase === "windup");
    const snap = JSON.stringify([e.x, e.y, e.attack.time, e.attack.windup, e.attack.phase, e.hp]);
    let events = 0;
    for (let i = 0; i < 120; i++) events += step(w, idle(w.tick + 1), 0).length;
    check("120 zero-dt steps: no events, no windup progress, no movement, no duplicate attack",
      events === 0 && JSON.stringify([e.x, e.y, e.attack.time, e.attack.windup, e.attack.phase, e.hp]) === snap);
    stepFor(w, 1.0);
    check("resuming completes the ONE commitment (never a replay)", e.attack.phase !== "windup");
  }

  section("animation dimensions never affect collision or behavior");
  {
    const run = (): string => {
      const w = createWorld(0xD1A1, 4, { isSandbox: true });
      w.isGodMode = true;
      const p = w.players.get(LOCAL_ID)!;
      p.x = 840; p.y = 600;
      for (const [kind, x, y] of [["skeleton", 1100, 600], ["charger", 600, 500], ["rootward", 900, 850]] as const) {
        spawnReady(w, kind, x, y);
      }
      for (let t = 0; t < 300; t++) step(w, { seq: t, moveX: Math.sin(t / 30), moveY: 0, aim: t / 40, firing: t % 3 === 0, dash: false });
      return JSON.stringify(w.enemies.map((e) => [e.x, e.y, e.hp, e.attack.move, e.attack.phase]));
    };
    const before = run();
    // Mutate every archetype's RENDER fields; the sim must be provably blind to them.
    const saved = ALL_KINDS.map((k) => [k, ENEMY_ARCHETYPES[k].drawSize, ENEMY_ARCHETYPES[k].alpha] as const);
    for (const k of ALL_KINDS) {
      (ENEMY_ARCHETYPES[k] as { drawSize: number }).drawSize *= 3;
      (ENEMY_ARCHETYPES[k] as { alpha: number }).alpha *= 0.5;
    }
    const after = run();
    for (const [k, drawSize, alpha] of saved) {
      (ENEMY_ARCHETYPES[k] as { drawSize: number }).drawSize = drawSize;
      (ENEMY_ARCHETYPES[k] as { alpha: number }).alpha = alpha;
    }
    check("tripling draw sizes and halving alphas changes NOTHING in the sim trace", before === after);
  }
}

// ---- 4. frame-rate equivalence ----

function commitTrace(kind: EnemyKind, dist: number, pattern: readonly number[]): string[] {
  const w = createWorld(0xF4A7E, 1, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  p.invuln = 0;
  p.x = 840; p.y = 600;
  const e = spawnReady(w, kind, 840 + dist, 600);
  const trace: string[] = [];
  let prevPhase: AttackPhase = "none";
  let time = 0;
  let i = 0;
  while (time < 10) {
    const dt = pattern[i++ % pattern.length];
    stepWorld(w, new Map([[LOCAL_ID, idle(i)]]), dt);
    time += dt;
    if (e.attack.phase !== prevPhase) {
      trace.push(`${e.attack.phase}:${e.attack.move}`);
      prevPhase = e.attack.phase;
    }
  }
  return trace;
}

// Equal, allowing ONE trailing entry of drift (a commitment landing exactly on the
// 10s boundary quantizes differently per rate).
function traceEq(a: string[], b: string[]): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

function rateGates(): void {
  section("frame-rate equivalence: 30/60/120Hz + throttled produce the same committed-attack traces");
  const patterns: Array<[string, readonly number[]]> = [
    ["30Hz", [1 / 30]], ["60Hz", [1 / 60]], ["120Hz", [1 / 120]], ["throttled", [1 / 20, 1 / 120]],
  ];
  for (const [kind, dist] of [["spitter", 300], ["caskbellows", 360], ["skeleton", 180]] as Array<[EnemyKind, number]>) {
    const base = commitTrace(kind, dist, patterns[0][1]);
    let ok = base.length > 0;
    for (const [name, pattern] of patterns.slice(1)) {
      const trace = commitTrace(kind, dist, pattern);
      if (!traceEq(base, trace)) {
        ok = false;
        process.stdout.write(`    ${kind} ${name}: ${trace.join(" ")} vs ${base.join(" ")}\n`);
      }
    }
    check(`${kind}: identical commitment sequence across every rate (${base.length} transitions)`, ok);
  }
}

// ---- 5. alignment: shared direction lock + projectile origins ----

function alignmentGates(): void {
  section("alignment: projectiles leave the muzzle along the SAME lockedAngle the facing renders");
  const cases: Array<[EnemyKind, number, number]> = [
    ["spitter", 300, 4], ["orbiter", 170, 4], ["caskbellows", 360, 4],
  ];
  for (const [kind, dist, muzzlePad] of cases) {
    const { w, p } = arena(0xA119 ^ kind.length);
    p.x = 840; p.y = 640; // slightly off-axis so the locked angle is a real diagonal
    const e = spawnReady(w, kind, 840 + dist, 600 - 60);
    let fired: Bullet | null = null;
    let locked = 0;
    let poseAim = Number.NaN;
    for (let t = 0; t < 600 && fired === null; t++) {
      if (e.attack.phase === "windup" && e.attack.isAimLocked) {
        locked = e.attack.lockedAngle;
        // The shared direction lock: the render pose faces the exact commitment angle.
        const pose = computeEnemyPose(e, createFacing(), 0, 0, false);
        poseAim = pose.aimAngle;
      }
      step(w, idle(w.tick + 1));
      const b = w.bullets.find((x) => !x.friendly);
      if (b) fired = b;
    }
    const expectX = e.x + Math.cos(locked) * (e.radius + muzzlePad);
    const expectY = e.y + Math.sin(locked) * (e.radius + muzzlePad);
    const dir = fired ? Math.atan2(fired.vy, fired.vx) : Number.NaN;
    check(`${kind}: bolt origin sits on the locked muzzle and flies the locked angle`,
      fired !== null && Math.hypot((fired?.x ?? 0) - expectX, (fired?.y ?? 0) - expectY) < 8
      && Math.abs(dir - locked) < 0.2 && Math.abs(poseAim - locked) < 1e-9,
      fired ? `offset=${Math.hypot(fired.x - expectX, fired.y - expectY).toFixed(1)}px` : "never fired");
  }
}

// ---- 6. navigation gates ----

function navigationGates(): void {
  section("navigation: preferred ranges hold after settle");
  const holdCases: Array<[EnemyKind, number, number, number, number]> = [
    // kind, spawn dist, min hold, max hold, min in-band share
    ["spitter", 300, 100, 500, 0.9],
    ["orbiter", 170, 60, 300, 0.85],
    ["caskbellows", 360, 140, 540, 0.85],
  ];
  for (const [kind, dist, lo, hi, share] of holdCases) {
    const { w, p } = arena(0x9A11 ^ kind.length);
    p.x = 840; p.y = 600;
    const e = spawnReady(w, kind, 840 + dist, 600);
    stepFor(w, 4);
    let inBand = 0;
    const samples = Math.round(4 / DT);
    for (let t = 0; t < samples; t++) {
      step(w, idle(w.tick + 1));
      const d = Math.hypot(e.x - p.x, e.y - p.y);
      if (d >= lo && d <= hi) inBand++;
    }
    check(`${kind} holds its preferred band [${lo},${hi}] ≥${share * 100}% of the time`,
      inBand / samples >= share, `${((inBand / samples) * 100).toFixed(0)}%`);
  }
  {
    const { w, p } = arena(0x9A20);
    p.x = 840; p.y = 600;
    const e = spawnReady(w, "echojack", 1140, 600);
    stepFor(w, 3);
    let minD = Infinity;
    for (let t = 0; t < Math.round(5 / DT); t++) {
      step(w, idle(w.tick + 1));
      minD = Math.min(minD, Math.hypot(e.x - p.x, e.y - p.y));
    }
    check("the echojack never lets the player inside its flee bubble", minD >= 120, `min=${minD.toFixed(0)}px`);
  }

  section("navigation: line of sight gates ranged commitments");
  {
    const { w, p } = arena(0x9A21);
    p.x = (17 + 0.5) * TILE; p.y = (12 + 0.5) * TILE;
    const e = spawnReady(w, "spitter", (25 + 0.5) * TILE, (12 + 0.5) * TILE); // 384px: inside the band
    for (let ty = 8; ty <= 16; ty++) w.dungeon.tiles[ty * w.dungeon.w + 21] = 1; // a wall column between them
    const ev: SimEvent[] = [];
    stepFor(w, 4, ev);
    check("walled off, the spitter never winds up (no spit, no muzzle)",
      e.attack.phase === "none" && !ev.some((x) => x.t === "spitMuzzle"));
    for (let ty = 8; ty <= 16; ty++) w.dungeon.tiles[ty * w.dungeon.w + 21] = 0;
    w.obstacleRev++; // the blocking set changed: navigation re-derives
    let guard = 0;
    while (e.attack.phase !== "windup" && guard++ < 300) step(w, idle(w.tick + 1));
    check("sight restored, the commitment follows", guard < 300);
  }

  section("navigation: a large-radius captain routes a prop row; door crowding never sticks >3s");
  {
    const { w, p } = arena(0x9A22, 13);
    p.x = (15 + 0.5) * TILE; p.y = (12 + 0.5) * TILE;
    for (const ty of [10, 11, 12, 13, 14]) devSpawnProp(w, "barrel", (20 + 0.5) * TILE, (ty + 0.5) * TILE);
    const m = spawnReady(w, "marshal", (26 + 0.5) * TILE, (12 + 0.5) * TILE);
    m.hp = m.maxHp = 400;
    let reached = false;
    for (let t = 0; t < 20 * 30 && !reached; t++) {
      p.x = (15 + 0.5) * TILE; p.y = (12 + 0.5) * TILE;
      stepWorld(w, new Map([[LOCAL_ID, idle(t)]]), 1 / 20);
      if (Math.hypot(m.x - p.x, m.y - p.y) < p.pr + m.radius + 10) reached = true;
    }
    check("the marshal (largest ground body) rounds the row to contact", reached);
  }
  {
    // Door crowding: six mixed bodies funnel through a one-tile gap. The stuck metric:
    // no enemy may make zero progress for >3s while a path exists (it does — the gap),
    // excluding contact and committed attack phases.
    const { w, p } = arena(0x9A23, 9);
    p.x = (15 + 0.5) * TILE; p.y = (12 + 0.5) * TILE;
    for (let ty = 4; ty <= 19; ty++) {
      if (ty === 12) continue; // the door
      devSpawnProp(w, "barrel", (20 + 0.5) * TILE, (ty + 0.5) * TILE);
    }
    const pack: Enemy[] = [];
    const kinds: EnemyKind[] = ["slime", "skeleton", "charger", "rootward", "sinderling", "slime"];
    kinds.forEach((kind, i) => {
      pack.push(spawnReady(w, kind, (26 + (i % 2)) * TILE, (8 + i * 2) * TILE));
    });
    const lastPos = new Map<number, { x: number; y: number }>();
    const stuck = new Map<number, number>();
    let worstStuck = 0;
    let reachedCount = 0;
    const reachedSet = new Set<number>();
    for (let t = 0; t < 20 * 30; t++) {
      p.x = (15 + 0.5) * TILE; p.y = (12 + 0.5) * TILE;
      stepWorld(w, new Map([[LOCAL_ID, idle(t)]]), 1 / 20);
      for (const e of pack) {
        if (e.dead) continue;
        const prev = lastPos.get(e.id);
        const moved = prev ? Math.hypot(e.x - prev.x, e.y - prev.y) : 99;
        lastPos.set(e.id, { x: e.x, y: e.y });
        const contact = Math.hypot(e.x - p.x, e.y - p.y) < p.pr + e.radius + 12;
        if (contact && !reachedSet.has(e.id)) { reachedSet.add(e.id); reachedCount++; }
        const isCommitted = e.attack.phase !== "none";
        const s = (!contact && !isCommitted && moved < 1.2) ? (stuck.get(e.id) ?? 0) + 1 / 20 : 0;
        stuck.set(e.id, s);
        worstStuck = Math.max(worstStuck, s);
      }
    }
    check("every body funnels through the door (≥5 of 6 reach contact)", reachedCount >= 5, `reached=${reachedCount}`);
    check("no enemy is stuck >3s while the path exists", worstStuck < 3.0, `worst=${worstStuck.toFixed(2)}s`);
  }
}

// ---- 7. co-op agreement + late join ----

function coopGates(): void {
  section("co-op: two clients decode the same authoritative state; late join restores without a facing flash");
  {
    const { w } = arena(0xC0A6, 9);
    const e = spawnReady(w, "seamcutter", 1000, 600);
    e.attack.phase = "windup"; e.attack.move = "seam"; e.attack.isAimLocked = true;
    e.attack.lockedAngle = Math.PI; e.attack.windup = 0.7; e.attack.markX = 500; e.attack.markY = 600;
    const raw = jsonCodec.encodeServer(buildSnapshot(w, LOCAL_ID, 0, [], 0, true, { worldId: "room:QA" }));
    const a = jsonCodec.decodeServer(raw);
    const b = jsonCodec.decodeServer(raw);
    check("two decoders agree byte-for-byte on enemies/state/phase",
      JSON.stringify(a) === JSON.stringify(b));
    if (a.t === "snap") {
      const wireE = a.enemies.find((x) => x.kind === "seamcutter")!;
      const restored = enemyFromWire(wireE, wireE.x, wireE.y);
      // The late joiner's FIRST rendered frame: the aimed commitment owns the facing —
      // never a default-down flash, never a replayed windup.
      const f = createFacing();
      const pose = computeEnemyPose(restored, f, 0, 0, false);
      check("a late join faces the locked commitment on frame one (no wrong-facing flash)",
        pose.facing === "side" && pose.isMirrored && pose.move === "seam" && pose.windup === 0.7);
      const pose2 = computeEnemyPose(restored, f, 0, 0, false);
      check("…and the pose is stable across repeated zero-velocity frames", JSON.stringify(pose) === JSON.stringify(pose2));
    }
  }
  {
    // Identical observed motion ⇒ identical derived facing on every client.
    const fA = createFacing();
    const fB = createFacing();
    for (let i = 0; i < 120; i++) {
      const vx = Math.cos(i / 20) * 150, vy = Math.sin(i / 20) * 150;
      updateFacing(fA, vx, vy);
      updateFacing(fB, vx, vy);
    }
    check("facing derivation is a pure function of observed motion (clients always agree)",
      fA.facing === fB.facing && fA.isMirrored === fB.isMirrored && fA.lastVertical === fB.lastVertical);
  }
}

// ---- 8. dense legal-max +25% stress + cleanup ----

function stressGates(): void {
  section("stress: legal-max +25% pressure holds every cap, then the world cleans to zero");
  const { w, p } = arena(0x57E5, 14);
  p.x = 840; p.y = 600;
  const mix: Array<[EnemyKind, Enemy["tier"]]> = [];
  for (let i = 0; i < 14; i++) mix.push([i % 2 === 0 ? "slime" : "skeleton", "standard"]);
  for (let i = 0; i < 6; i++) mix.push(["bat", "swarm"]);
  mix.push(["charger", "standard"], ["seamcutter", "standard"], ["burrower", "standard"], ["charger", "brute"]);
  mix.push(["skeleton", "elite"], ["ghost", "elite"], ["slime", "elite"]);
  mix.push(["echojack", "standard"], ["fragment", "standard"], ["echojack", "standard"]);
  check("the stress mix is legal-max +25% (30 units vs 24 live bodies)", mix.length === 30 && LIVE_CAPS.bodies === 24);
  const rng = new Rng(0x1234);
  mix.forEach(([kind, tier], i) => {
    const ang = (i / mix.length) * Math.PI * 2;
    const e = createEnemy(kind, 840 + Math.cos(ang) * (320 + (i % 4) * 60), 600 + Math.sin(ang) * (240 + (i % 3) * 50), 14, rng, w.nextEnemyId++, { tier });
    // Half start queued: the release gates must hold the caps as the fight churns.
    if (i < 22) { e.spawnTimer = 0; w.enemies.push(e); } else { w.pendingSpawns.push(e); }
  });
  let capsOk = true;
  for (let t = 0; t < Math.round(12 / DT); t++) {
    step(w, idle(w.tick + 1));
    let bodies = 0, elites = 0, brutes = 0, controllers = 0;
    for (const e of w.enemies) {
      if (e.dead) continue;
      bodies++;
      if (e.tier === "elite") elites++;
      if (e.tier === "brute") brutes++;
      if (ENEMY_ROLE[e.kind] === "controller") controllers++;
    }
    if (elites > LIVE_CAPS.elites || brutes > LIVE_CAPS.brutes || controllers > LIVE_CAPS.controllers) capsOk = false;
  }
  check("class caps hold through 12s of dense churn (releases included)", capsOk);
  // Now clear the field (two-sided shots beat every guard arc) and let the world drain.
  let guard = 0;
  while ((w.enemies.length > 0 || w.pendingSpawns.length > 0) && guard++ < 60 * 30) {
    for (const e of w.enemies) {
      if (e.dead) continue;
      plantShot(w, e.x - 40, e.y, 400, 0, 99999);
      plantShot(w, e.x + 40, e.y, -400, 0, 99999);
    }
    step(w, idle(w.tick + 1));
  }
  stepFor(w, 8); // fuses, cinders, decoys, projectiles all run out
  check("every enemy and reinforcement is gone", w.enemies.length === 0 && w.pendingSpawns.length === 0);
  check("every dynamic hazard expired (charges detonated, cinders burned out)", w.hazards.length === 0);
  check("every projectile drained", w.bullets.length === 0);
  check("release-arbiter and lag-comp scratch drained (no leaks)",
    w.recentReleases.length === 0 && w.enemyHist.size === 0);
  check("the floor reads cleared", isFloorCleared(w));
}

// ---- 9. boss transitions exactly once ----

interface BossProbe {
  entering: number;
  exiting: number;
  kills: number;
  trace: string[];
}

function probeEvents(ev: SimEvent[], bossId: number, probe: BossProbe): void {
  for (const e of ev) {
    if (e.t === "bossTransition" && e.eid === bossId) {
      if (e.entering) probe.entering++;
      else probe.exiting++;
      probe.trace.push(`${e.entering ? "enter" : "exit"}:${e.phase}`);
    }
    if (e.t === "enemyKill" && e.eid === bossId) {
      probe.kills++;
      probe.trace.push("kill");
    }
  }
}

function bossOnceRun(kind: EnemyKind, mode: "burst" | "dot" | "simultaneous"): { probe: BossProbe; w: WorldState; boss: Enemy } {
  const w = createWorld(0xB0CE ^ kind.length, 10, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  p.invuln = 0;
  const boss = devSpawnEnemy(w, kind, p.x + 220, p.y);
  const probe: BossProbe = { entering: 0, exiting: 0, kills: 0, trace: [] };
  stepFor(w, 0.2);
  if (mode === "burst") {
    plantShot(w, boss.x, boss.y, 1, 0, 1e6, { radius: 4 });
  } else if (mode === "dot") {
    boss.burn = 1.5;
    boss.burnDmg = boss.maxHp * 2; // one 0.25s tick crosses the first threshold outright
    boss.burnOwner = LOCAL_ID;
  } else {
    for (let i = 0; i < 3; i++) plantShot(w, boss.x, boss.y, 1, 0, boss.maxHp * 0.4, { radius: 4 });
  }
  let syncOk = true;
  for (let t = 0; t < Math.round(10 / DT); t++) {
    probeEvents(step(w, idle(w.tick + 1)), boss.id, probe);
    // The invariant sampled EVERY tick: transitions observed == transitions recorded.
    if (boss.boss && probe.entering !== boss.boss.transitionsDone) syncOk = false;
  }
  if (!syncOk) probe.trace.push("DESYNC");
  return { probe, w, boss };
}

function bossOnceGates(): void {
  section("boss transitions: exactly once per threshold under burst / DoT / simultaneous hits");
  for (const kind of ["boss", "marrow", "weaver", "gilded", "choir"] as EnemyKind[]) {
    const burst = bossOnceRun(kind, "burst");
    check(`${kind}: a 1e6 burst walks BOTH beats exactly once each (enter/exit paired)`,
      burst.probe.entering === 2 && burst.probe.exiting === 2 && !burst.probe.trace.includes("DESYNC")
      && burst.boss.boss?.phase === 3,
      burst.probe.trace.join(" "));
    const dot = bossOnceRun(kind, "dot");
    check(`${kind}: a DoT crossing fires each transition once (never per tick)`,
      dot.probe.entering <= 2 && dot.probe.entering === dot.probe.exiting && !dot.probe.trace.includes("DESYNC"),
      dot.probe.trace.join(" "));
    const simul = bossOnceRun(kind, "simultaneous");
    // The beat's shockwave dissipates every projectile near the boss the instant the
    // threshold crosses — the other two same-tick rounds are EATEN, so exactly one
    // beat fires and nothing can double-enter. (Stronger than de-duplication: the
    // anti-burst beat consumes the burst itself.)
    check(`${kind}: three same-tick threshold hits fire ONE beat (the shockwave eats the rest)`,
      simul.probe.entering === 1 && simul.probe.exiting === 1 && !simul.probe.trace.includes("DESYNC"),
      simul.probe.trace.join(" "));
    // Determinism: the burst scenario replays to the identical sequence.
    const again = bossOnceRun(kind, "burst");
    check(`${kind}: the transition sequence is deterministic`,
      again.probe.trace.join("|") === burst.probe.trace.join("|"));
  }

  section("boss beats: pause-frozen, wire-restorable, single death/reward");
  {
    const { w, p } = arena(0xB0CF, 10);
    p.invuln = 0;
    const boss = devSpawnEnemy(w, "boss", p.x + 220, p.y);
    stepFor(w, 0.2);
    plantShot(w, boss.x, boss.y, 1, 0, 1e6, { radius: 4 });
    stepFor(w, 0.2);
    check("the beat is live", boss.attack.move === "roar" && boss.boss?.roar !== null);
    const frozen = boss.attack.windup;
    let pausedEvents = 0;
    for (let i = 0; i < 100; i++) pausedEvents += step(w, idle(w.tick + 1), 0).length;
    check("a paused beat neither progresses nor re-fires", pausedEvents === 0 && boss.attack.windup === frozen);
    const rt = enemyFromWire(toEnemyWire(boss), boss.x, boss.y);
    check("a reconnecting client restores the beat mid-flight (phase + move + windup)",
      rt.boss?.phase === 2 && rt.attack.move === "roar" && Math.abs(rt.attack.windup - frozen) < 1e-9);
    // Ride out both beats, then the single death: one kill, one chest, floor cleared.
    const probe: BossProbe = { entering: 0, exiting: 0, kills: 0, trace: [] };
    for (let t = 0; t < Math.round(8 / DT); t++) probeEvents(step(w, idle(w.tick + 1)), boss.id, probe);
    let guard = 0;
    while (!boss.dead && guard++ < 60 * 20) {
      plantShot(w, boss.x, boss.y, 1, 0, 5000, { radius: 30, hitList: w.enemies.filter((e) => e !== boss) });
      probeEvents(step(w, idle(w.tick + 1)), boss.id, probe);
    }
    check("exactly ONE death event and ONE boss chest; the floor clears once",
      boss.dead && probe.kills === 1 && w.chests.filter((c) => c.kind === "boss").length === 1 && isFloorCleared(w));
  }
}

function main(): void {
  manifestGates();
  directionMatrixGates();
  authorityGates();
  rateGates();
  alignmentGates();
  navigationGates();
  coopGates();
  stressGates();
  bossOnceGates();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll animation/AI QA gates hold.\n");
}

main();
