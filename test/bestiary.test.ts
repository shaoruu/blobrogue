// Bestiary-wave sim assertions: the six new commons (rootward, echojack, seamcutter,
// caskbellows, sinderling, fragment), their decoys (echo, knell), the behavior-elite
// affixes (commander, bulwark, volatile, echoed — brace retained), and the mid-band
// miniboss templates (Root Marshal, The Toll). Exercised headlessly on the pure sim:
// behavior identity + counterplay, spawn/threat integration, protocol round-trips,
// trapped-mob navigation, dense-room performance, and replay determinism.
//
// Run: npm run test:bestiary

import {
  createWorld, stepWorld, devSpawnEnemy, devSpawnProp, isFloorCleared,
} from "../src/sim/world.js";
import type { WorldState, PlayerSim } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { InputCmd } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { Bullet, Enemy, EnemyKind } from "../src/sim/types.js";
import { TILE } from "../src/sim/types.js";
import {
  createEnemy, spawnFloorEnemies, ENEMY_ARCHETYPES, FAMILY_INTRO_FLOOR, eliteAffixOf,
  minibossKindForFloor, minibossHpForFloor, isMinibossKind, isBossFloor, isGauntletFloor,
} from "../src/sim/enemies.js";
import { generateDungeon } from "../src/sim/dungeon.js";
import {
  ELITE_COMMANDER, ELITE_BULWARK, ELITE_VOLATILE, ELITE_ECHOED, MARSHAL, TOLL, MINIBOSS,
} from "../src/sim/balance.js";
import {
  toEnemyWire, enemyFromWire, toHazardWire, hazardFromWire, buildSnapshot, jsonCodec,
} from "../src/net/protocol.js";
import { Rng } from "../src/sim/rng.js";
import * as C from "../src/sim/constants.js";

const DT = 1 / 60;

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

function step(w: WorldState, cmd: InputCmd): SimEvent[] {
  return stepWorld(w, new Map([[LOCAL_ID, cmd]]), DT);
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
  const p = w.players.get(LOCAL_ID)!;
  p.invuln = 0;
  return { w, p };
}

function spawnReady(w: WorldState, kind: EnemyKind, x: number, y: number): Enemy {
  const e = devSpawnEnemy(w, kind, x, y);
  e.spawnTimer = 0;
  return e;
}

// A directional planted round (the content suite's plantBullet, with velocity): guard/
// plate arcs judge the arrival direction, so these tests need real headings.
function plantShot(w: WorldState, x: number, y: number, vx: number, vy: number, damage: number, opts: { radius?: number; life?: number; pierce?: number } = {}): Bullet {
  const b: Bullet = {
    x, y, vx, vy, radius: opts.radius ?? 5, life: opts.life ?? 1, friendly: true, owner: LOCAL_ID,
    damage, color: "#fff", pierce: opts.pierce ?? 0, hitList: null, isCrit: false,
  };
  w.bullets.push(b);
  return b;
}

function enemyBullets(w: WorldState): Bullet[] {
  return w.bullets.filter((b) => !b.friendly);
}

// ---- rootward: the formation anchor ----

function rootwardTests(): void {
  section("rootward: the slow guard eats frontal fire; flank, pierce and melee do not care");
  {
    const { w, p } = arena(0x4001);
    p.x = 700; p.y = 600;
    const e = spawnReady(w, "rootward", 900, 600);
    stepFor(w, 2.5); // the guard turns toward the player (west) at its slow capped rate
    check("the guard tracked onto the target", Math.abs(Math.abs(e.attack.lockedAngle) - Math.PI) < 0.35,
      `guard=${e.attack.lockedAngle.toFixed(2)}`);
    const hp0 = e.hp;
    const ev: SimEvent[] = [];
    plantShot(w, e.x - 60, e.y, 400, 0, 3); // frontal: arrives from the west, into the guard
    stepFor(w, 0.3, ev);
    check("a frontal round is absorbed (blocked event, no damage, round spent)",
      e.hp === hp0 && ev.some((x) => x.t === "bulletBlocked") && !w.bullets.some((b) => b.friendly));
    plantShot(w, e.x - 60, e.y, 400, 0, 3, { pierce: 1 });
    stepFor(w, 0.3);
    check("a PIERCING round punches straight through the guard", e.hp === hp0 - 3, `hp ${hp0} -> ${e.hp}`);
    const hp1 = e.hp;
    plantShot(w, e.x + 60, e.y, -400, 0, 3); // the flank: from behind the guard
    stepFor(w, 0.3);
    check("a rear shot lands full damage", e.hp === hp1 - 3, `hp ${hp1} -> ${e.hp}`);
  }
  {
    // The slow turn IS the counterplay: a guard still facing east cannot block a west shot.
    const { w, p } = arena(0x4002);
    p.x = 700; p.y = 600;
    const e = spawnReady(w, "rootward", 900, 600);
    e.attack.lockedAngle = 0; // guard facing east; the player (and the shot) are west
    const hp0 = e.hp;
    plantShot(w, e.x - 60, e.y, 400, 0, 3);
    stepFor(w, 0.2);
    check("a shot outside the arc lands (the guard turns slower than footwork)", e.hp === hp0 - 3);
  }
  {
    // Formation cover: the guard's reach pad eats a round that would MISS the body and
    // hit the ally sheltering behind it.
    const { w, p } = arena(0x4003);
    p.x = 700; p.y = 576;
    const e = spawnReady(w, "rootward", 900, 600);
    e.attack.lockedAngle = Math.PI;
    const ally = spawnReady(w, "slime", 950, 578);
    const allyHp = ally.hp;
    const ev: SimEvent[] = [];
    // y offset 24: misses the rootward body (17 + 5 = 22) but sits inside the guard pad.
    plantShot(w, 780, 576, 400, 0, 3);
    stepFor(w, 0.5, ev);
    check("the guard's reach shields the ally in its shadow",
      ally.hp === allyHp && ev.some((x) => x.t === "bulletBlocked"), `allyHp=${ally.hp}/${allyHp}`);
  }
}

// ---- echojack: false noise, then the visible relocation ----

function echojackTests(): void {
  section("echojack: plants a 1-HP decoy on a telegraphed beat, then blinks perpendicular");
  {
    const { w, p } = arena(0x4011);
    p.x = 840; p.y = 600;
    const e = spawnReady(w, "echojack", 1120, 600); // inside approach, outside flee
    let guard = 0;
    while (e.attack.move !== "decoy" && guard++ < 300) step(w, idle(w.tick + 1));
    check("the jack telegraphs the decoy plant", e.attack.move === "decoy" && e.attack.phase === "windup");
    const plantX = e.x, plantY = e.y;
    stepFor(w, C.ECHOJACK_DECOY_WINDUP + 0.02);
    const echo = w.enemies.find((x) => x.kind === "echo");
    check("a false-noise echo stands where the jack was", echo !== undefined
      && Math.hypot((echo?.x ?? 0) - plantX, (echo?.y ?? 0) - plantY) < 24);
    check("the jack is mid-blink (the visible relocation)", e.attack.move === "blink" && e.attack.phase === "active");
    stepFor(w, C.ECHOJACK_BLINK_DUR + 0.05);
    const displaced = Math.abs(e.y - plantY);
    check("the blink moved it decisively PERPENDICULAR to the player axis", displaced > 100,
      `dy=${displaced.toFixed(0)}px`);
    // The decoy: shootable (1 HP), worthless (no loot, no combo), and self-expiring.
    const kills0 = p.kills;
    plantShot(w, echo!.x - 40, echo!.y, 400, 0, 1);
    stepFor(w, 0.2);
    check("the decoy dies to one hit and pays NOTHING (no kill credit, no loot)",
      echo!.dead && p.kills === kills0 && w.pickups.length === 0);
  }
  {
    // Unshot, the echo expires on its aux fuse — quietly, still no loot.
    const { w, p } = arena(0x4012);
    p.x = 840; p.y = 600;
    const e = spawnReady(w, "echojack", 1120, 600);
    let guard = 0;
    while (!w.enemies.some((x) => x.kind === "echo") && guard++ < 600) step(w, idle(w.tick + 1));
    const echo = w.enemies.find((x) => x.kind === "echo")!;
    check("the echo carries its fuse on the aux channel", echo.aux > 0 && echo.aux <= C.ECHO_LIFE);
    e.dead = true; // retire the jack so no second decoy muddies the count
    stepFor(w, C.ECHO_LIFE + 0.2);
    check("the unshot echo expires by itself, loot-free", !w.enemies.some((x) => x.kind === "echo") && w.pickups.length === 0);
  }
}

// ---- seamcutter: the previewed wall-to-wall lane ----

function seamcutterTests(): void {
  section("seamcutter: previews the seam, locks it, cuts it with timed perpendicular sweeps");
  {
    const { w, p } = arena(0x4021);
    p.x = 1100; p.y = 600;
    const e = spawnReady(w, "seamcutter", 840, 600);
    stepFor(w, 0.1);
    check("in range it telegraphs the seam", e.attack.move === "seam" && e.attack.phase === "windup");
    stepFor(w, C.SEAM_LOCK + 0.05);
    check("the lane locks partway through the preview", e.attack.isAimLocked);
    const mark = { x: e.attack.markX, y: e.attack.markY };
    check("the preview reaches wall-to-wall (the mark sits near the east wall)", mark.x > 1450,
      `mark=${mark.x.toFixed(0)},${mark.y.toFixed(0)}`);
    // The early-cross counter: sidestep after the lock — the seam must not follow.
    p.y = 900;
    stepFor(w, C.SEAM_WINDUP - C.SEAM_LOCK + 0.05);
    check("the cut commits along the LOCKED lane", e.attack.phase === "active"
      && Math.abs(e.attack.markY - mark.y) < 1e-9);
    // The counter: get BEHIND the cut (it never turns; the sweeps fly perpendicular).
    p.x = 500; p.y = 600;
    const ev: SimEvent[] = [];
    stepFor(w, 1.0, ev);
    const sweeps = enemyBullets(w);
    check("the cut throws timed PERPENDICULAR sweep pairs as it travels",
      sweeps.length >= 4 && sweeps.every((b) => Math.abs(b.vx) < 1 && Math.abs(b.vy) > 100),
      `sweeps=${sweeps.length}`);
    stepFor(w, 1.6, ev);
    check("the far wall ends the cut in the punish recover", e.attack.move === "seam" && e.attack.phase === "recover");
    check("the player standing behind the cut was never hit", p.hp === p.maxHp);
  }
}

// ---- caskbellows: the lane sentry and its rear crank ----

function caskbellowsTests(): void {
  section("caskbellows: locked 3-shot volley; a rear-crank hit staggers the whole commitment");
  {
    const { w, p } = arena(0x4031);
    p.x = 1200; p.y = 600;
    const e = spawnReady(w, "caskbellows", 840, 600);
    stepFor(w, 0.1);
    check("in range it winds the volley (volley grammar)", e.attack.move === "volley" && e.attack.phase === "windup");
    stepFor(w, C.CASK_WINDUP + (C.CASK_SHOTS - 1) * C.CASK_SHOT_GAP + 0.1);
    const bolts = enemyBullets(w);
    check("the volley is a 3-shot burst down the locked lane", bolts.length === C.CASK_SHOTS
      && bolts.every((b) => b.vx > 100 && Math.abs(b.vy) < 40), `bolts=${bolts.length}`);
    check("it recovers after the burst", e.attack.phase === "recover" && e.attack.move === "volley");
  }
  {
    const { w, p } = arena(0x4032);
    p.x = 1200; p.y = 600;
    const e = spawnReady(w, "caskbellows", 840, 600);
    stepFor(w, 0.3); // mid-windup, lane locked east
    check("mid-commitment", e.attack.phase === "windup");
    plantShot(w, 760, 600, 400, 0, 2); // lands on its BACK (the crank)
    stepFor(w, 0.3);
    check("the rear-crank hit staggers it into the crash punish window",
      e.attack.move === "crash" && e.attack.phase === "recover");
    stepFor(w, 1.0);
    check("the stagger holds well past an ordinary recover", e.attack.phase === "recover" && e.attack.move === "crash",
      `t=${e.attack.time.toFixed(2)} of ${C.CASK_STAGGER}`);
    stepFor(w, 0.7);
    check("…then releases", e.attack.phase === "none");
  }
  {
    // A frontal hit mid-windup does NOT stagger — the crank is strictly the back arc.
    const { w, p } = arena(0x4033);
    p.x = 1200; p.y = 600;
    const e = spawnReady(w, "caskbellows", 840, 600);
    stepFor(w, 0.3);
    plantShot(w, 950, 600, -400, 0, 2);
    stepFor(w, 0.3);
    check("a frontal hit damages but never staggers", e.attack.move === "volley" && e.hp < e.maxHp);
  }
}

// ---- sinderling: heat, the jet, the shared-risk death ----

function sinderlingTests(): void {
  section("sinderling: consumes an environmental heat pulse (or stokes itself) to ARM");
  {
    // A live fire vent: standing on its ACTIVE tile arms instantly — one consumed pulse.
    const { w, p } = arena(0x4041);
    p.x = 700; p.y = 600;
    const ventTx = 20, ventTy = 12;
    w.floorHazards.push({ id: 0, kind: "fire_vent", tx: ventTx, ty: ventTy, phase: 3.4, group: 0 });
    const e = spawnReady(w, "sinderling", (ventTx + 0.5) * TILE, (ventTy + 0.5) * TILE);
    check("it spawns unarmed", e.aux === 0);
    stepFor(w, 0.2);
    check("standing heat arms it (aux flips to 1 on the wire channel)", e.aux === 1);
  }
  {
    // A brazier is standing heat too: the unarmed sinderling WALKS to it, then arms.
    const { w, p } = arena(0x4042);
    p.x = 700; p.y = 900;
    devSpawnProp(w, "brazier", 1100, 600);
    const e = spawnReady(w, "sinderling", 900, 600);
    stepFor(w, 4);
    check("it sought the brazier and armed on arrival", e.aux === 1);
  }
  {
    // No heat anywhere: the long stationary self-stoke channel is the fallback.
    const { w, p } = arena(0x4043);
    p.x = 840; p.y = 600;
    const e = spawnReady(w, "sinderling", 1050, 600);
    stepFor(w, 0.1);
    check("with no heat it stokes itself (stationary channel)", e.attack.move === "stoke" && e.attack.phase === "windup");
    const x0 = e.x;
    stepFor(w, C.SINDER_STOKE_WINDUP + 0.05);
    check("the stoke is stationary and arms it", e.aux === 1 && Math.abs(e.x - x0) < 2);
  }

  section("sinderling: the locked flame jet lays a burning cinder wake");
  {
    const { w, p } = arena(0x4044);
    p.x = 1050, p.y = 600;
    const e = spawnReady(w, "sinderling", 840, 600);
    e.aux = 1; // armed
    let guard = 0;
    while (e.attack.move !== "rush" && guard++ < 300) step(w, idle(w.tick + 1));
    check("the armed sinderling telegraphs the jet (rush grammar)", e.attack.move === "rush" && e.attack.phase === "windup");
    p.invuln = 999; // read the wake without contact noise
    stepFor(w, C.SINDER_JET_WINDUP + C.SINDER_JET_DUR + 0.1);
    const cinders = w.hazards.filter((h) => h.kind === "cinder");
    check("the jet left a cinder wake (authoritative hazards)", cinders.length >= 3, `cinders=${cinders.length}`);
    // Standing in fire hurts (protection rules apply, so the tick self-limits).
    p.invuln = 0;
    const hp0 = p.hp;
    p.x = cinders[0].x; p.y = cinders[0].y;
    stepFor(w, 0.1);
    check("standing in a cinder burns 1", p.hp === hp0 - 1);
    stepFor(w, C.SINDER_CINDER_LIFE + 0.2);
    check("cinders expire on their own", w.hazards.every((h) => h.kind !== "cinder"));
  }

  section("sinderling: an ARMED death bursts shared-risk fire; an unarmed death is quiet");
  {
    const { w, p } = arena(0x4045);
    p.x = 880; p.y = 600;
    const e = spawnReady(w, "sinderling", 840, 600);
    e.aux = 1;
    const bystander = spawnReady(w, "slime", 870, 640);
    bystander.hp = bystander.maxHp = 10;
    const hpP = p.hp, hpS = bystander.hp;
    const ev: SimEvent[] = [];
    plantShot(w, 780, 600, 400, 0, 99);
    stepFor(w, 0.2, ev);
    check("the armed death detonates", e.dead && ev.some((x) => x.t === "explosion"));
    check("the burst is SHARED risk: the player takes 1, the bystander enemy takes more",
      p.hp === hpP - C.SINDER_BURST_PLAYER_DMG && bystander.hp === hpS - C.SINDER_BURST_ENEMY_DMG,
      `p ${hpP}->${p.hp}, slime ${hpS}->${bystander.hp}`);
  }
  {
    const { w, p } = arena(0x4046);
    p.x = 880; p.y = 600;
    const e = spawnReady(w, "sinderling", 840, 600);
    const hp0 = p.hp;
    const ev: SimEvent[] = [];
    plantShot(w, 780, 600, 400, 0, 99);
    stepFor(w, 0.2, ev);
    check("an unarmed death bursts nothing", e.dead && !ev.some((x) => x.t === "explosion") && p.hp === hp0);
  }
}

// ---- choir fragment: the tether IS the lane ----

function fragmentTests(): void {
  section("fragment: tethers to a source; the harmonize pulse damages along the line");
  {
    const { w, p } = arena(0x4051);
    p.x = 840; p.y = 700;
    const src = spawnReady(w, "slime", 1150, 600);
    src.hp = src.maxHp = 500; // a sturdy voice for the whole reading
    const e = spawnReady(w, "fragment", 900, 600);
    stepFor(w, 0.1);
    check("the fragment tethered to the nearest other enemy (aux = id + 1)", e.aux === src.id + 1);
    let guard = 0;
    while (e.attack.move !== "harmonize" && guard++ < 400) step(w, idle(w.tick + 1));
    check("it telegraphs the harmonize pulse", e.attack.move === "harmonize" && e.attack.phase === "windup");
    // Stand ON the segment for the pulse.
    p.x = (e.x + src.x) / 2; p.y = (e.y + src.y) / 2;
    p.invuln = 0;
    const hp0 = p.hp;
    stepFor(w, C.FRAGMENT_PULSE_WINDUP + C.FRAGMENT_PULSE_ACTIVE + 0.1);
    check("standing on the tether during the pulse takes 1", p.hp === hp0 - 1, `hp ${hp0} -> ${p.hp}`);
  }
  {
    // Kill the source: the tether drops and the pattern SIMPLIFIES (no more pulses).
    const { w, p } = arena(0x4052);
    p.x = 840; p.y = 760;
    const src = spawnReady(w, "slime", 1150, 600);
    const e = spawnReady(w, "fragment", 900, 600);
    stepFor(w, 0.1);
    check("tethered", e.aux === src.id + 1);
    plantShot(w, src.x - 50, src.y, 400, 0, 999);
    stepFor(w, 0.3);
    check("killing the source drops the tether", src.dead && e.aux === 0);
    let sang = false;
    for (let t = 0; t < Math.round(5 / DT); t++) {
      step(w, idle(w.tick + 1));
      if (e.attack.move === "harmonize") sang = true;
    }
    check("the untethered fragment never harmonizes (simplified pattern)", !sang);
  }
  {
    // Line-of-sight break: drag the source behind a wall and the tether lets go.
    const { w, p } = arena(0x4053);
    p.x = 840; p.y = 760;
    const src = spawnReady(w, "slime", 1150, 600);
    const e = spawnReady(w, "fragment", 900, 600);
    stepFor(w, 0.1);
    check("tethered before the break", e.aux === src.id + 1);
    src.x = 24; src.y = 24; // inside the border wall region: LOS to it is gone
    stepFor(w, 0.1);
    check("breaking line of sight defuses the tether", e.aux !== src.id + 1);
  }
}

// ---- the behavior elites ----

function eliteTests(): void {
  section("elite affixes: one per kind, deterministic (the read is learnable)");
  check("the affix table is authored per kind (slime commander, charger bulwark, ghost volatile, spitter echoed, skeleton brace)",
    eliteAffixOf("slime") === "commander" && eliteAffixOf("charger") === "bulwark"
    && eliteAffixOf("ghost") === "volatile" && eliteAffixOf("spitter") === "echoed"
    && eliteAffixOf("skeleton") === "brace");

  section("commander: the rally is ONE synchronized commit (speed, never damage)");
  {
    const { w, p } = arena(0x4061, 6);
    p.x = 840; p.y = 600;
    const cmd = createEnemy("slime", 1100, 600, 6, w.rng, w.nextEnemyId++, { tier: "elite" });
    cmd.spawnTimer = 0;
    w.enemies.push(cmd);
    const packA = spawnReady(w, "slime", 1150, 560);
    const packB = spawnReady(w, "slime", 1150, 640);
    let guard = 0;
    while (cmd.attack.move !== "roar" && guard++ < 300) step(w, idle(w.tick + 1));
    check("the commander sounds the rally (roar grammar, stationary beat)",
      cmd.attack.move === "roar" && cmd.attack.phase === "windup");
    stepFor(w, ELITE_COMMANDER.rallyWindup + 0.05);
    check("the rally orders the pack into the delayed surge",
      packA.surgeDelay > 0 || packA.surgeTime > 0, `delay=${packA.surgeDelay.toFixed(2)}`);
    stepFor(w, ELITE_COMMANDER.surgeDelay + 0.1);
    check("the surge lands a beat later (readable, dodgeable)", packA.surgeTime > 0 && packB.surgeTime > 0);
  }
  {
    // Pack panic on death: the leaderless pack scatters and starts nothing from idle.
    const { w, p } = arena(0x4062, 6);
    p.x = 840; p.y = 600;
    const cmd = createEnemy("slime", 1050, 600, 6, w.rng, w.nextEnemyId++, { tier: "elite" });
    cmd.spawnTimer = 0;
    w.enemies.push(cmd);
    const packA = spawnReady(w, "skeleton", 1100, 560);
    stepFor(w, 0.1);
    plantShot(w, cmd.x - 50, cmd.y, 400, 0, 9999);
    stepFor(w, 0.1);
    check("killing the commander panics the pack", cmd.dead && packA.panicTime > 0);
    const d0 = Math.hypot(packA.x - p.x, packA.y - p.y);
    stepFor(w, 0.8);
    const d1 = Math.hypot(packA.x - p.x, packA.y - p.y);
    check("the panicked body FLEES the player", d1 > d0 + 30, `${d0.toFixed(0)} -> ${d1.toFixed(0)}px`);
  }

  section("bulwark: one directional breakable plate — finite, directional, never immunity");
  {
    const { w, p } = arena(0x4063, 6);
    p.x = 1300; p.y = 600; // beyond the charger's rush trigger: the plate is what we read
    const e = createEnemy("charger", 840, 600, 6, w.rng, w.nextEnemyId++, { tier: "elite" });
    e.spawnTimer = 0;
    w.enemies.push(e);
    const plate0 = e.aux;
    check("the bulwark spawns with a scaled plate on the aux channel", plate0 > 0, `plate=${plate0}`);
    stepFor(w, 0.5); // the plate tracks toward the player (east)
    const hp0 = e.hp;
    const ev: SimEvent[] = [];
    plantShot(w, e.x + 80, e.y, -400, 0, 5); // frontal, into the plate
    stepFor(w, 0.3, ev);
    check("a frontal round is absorbed by the plate (HP spent, body untouched)",
      e.hp === hp0 && e.aux === plate0 - 5 && ev.some((x) => x.t === "bulletBlocked"), `plate ${plate0} -> ${e.aux}`);
    plantShot(w, e.x - 80, e.y, 400, 0, 5); // the flank: from behind
    stepFor(w, 0.3);
    check("the flank lands full damage through an intact plate", e.hp === hp0 - 5);
    const hp1 = e.hp;
    plantShot(w, e.x + 80, e.y, -400, 0, 5, { pierce: 1 });
    stepFor(w, 0.3);
    check("a piercing round ignores the plate", e.hp === hp1 - 5);
    plantShot(w, e.x + 80, e.y, -400, 0, 999);
    stepFor(w, 0.3);
    check("overload SHATTERS the plate for good (aux 0)", e.aux === 0);
    const hp2 = e.hp;
    plantShot(w, e.x + 80, e.y, -400, 0, 5);
    stepFor(w, 0.3);
    check("frontal fire lands once the plate is gone", e.hp === hp2 - 5);
  }

  section("volatile: the delayed shared burst — the kill is safe, the corpse is not");
  {
    const { w, p } = arena(0x4064, 6);
    p.x = 880; p.y = 600;
    const e = createEnemy("ghost", 840, 600, 6, w.rng, w.nextEnemyId++, { tier: "elite" });
    e.spawnTimer = 0;
    w.enemies.push(e);
    const bystander = spawnReady(w, "slime", 860, 640);
    bystander.hp = bystander.maxHp = 10;
    bystander.chill = 20; // frozen witness: its own contact chasing must not muddy the read
    stepFor(w, 0.1);
    plantShot(w, e.x - 40, e.y, 400, 0, 9999);
    stepFor(w, 0.25);
    const fuse = w.hazards.find((h) => h.kind === "charge");
    check("death plants the fused charge (a visible hazard, no instant damage)",
      e.dead && fuse !== undefined && p.hp === p.maxHp);
    const hpP = p.hp, hpS = bystander.hp;
    const ev: SimEvent[] = [];
    stepFor(w, ELITE_VOLATILE.fuseSeconds + 0.1, ev);
    check("the fuse detonates a SHARED burst (player 1, enemy more)",
      ev.some((x) => x.t === "explosion") && p.hp === hpP - ELITE_VOLATILE.playerDamage
      && bystander.hp === hpS - ELITE_VOLATILE.enemyDamage,
      `p ${hpP}->${p.hp}, slime ${hpS}->${bystander.hp}`);
  }

  section("echoed: the last release repeats once, offset in time — never simultaneous");
  {
    const { w, p } = arena(0x4065, 6);
    p.x = 1100; p.y = 600;
    const e = createEnemy("spitter", 840, 600, 6, w.rng, w.nextEnemyId++, { tier: "elite" });
    e.spawnTimer = 0;
    w.enemies.push(e);
    const ev: SimEvent[] = [];
    let guard = 0;
    while (!ev.some((x) => x.t === "spitMuzzle") && guard++ < 600) ev.push(...step(w, idle(w.tick + 1)));
    check("the elite spitter released its live volley", guard < 600);
    const n1 = enemyBullets(w).length;
    check("the echo is armed, not fired (no simultaneous double damage)", e.echoTime > 0 && n1 > 0);
    const muzzles0 = ev.filter((x) => x.t === "spitMuzzle").length;
    stepFor(w, ELITE_ECHOED.delay + 0.1, ev);
    const muzzles1 = ev.filter((x) => x.t === "spitMuzzle").length;
    check("the echo refired the same pattern after the delay", muzzles1 === muzzles0 + 1
      && enemyBullets(w).length === n1 * 2, `bullets ${n1} -> ${enemyBullets(w).length}`);
    check("the echo does not re-arm itself (one repeat per release)", e.echoTime === 0);
  }
}

// ---- the miniboss templates ----

function minibossCadenceTests(): void {
  section("miniboss cadence: seeded, mid-band, no immediate repeats");
  {
    let deterministic = true;
    let offCadenceClean = true;
    let noRepeats = true;
    const seen = new Set<EnemyKind>();
    for (let s = 0; s < 40; s++) {
      const seed = 0x707 + s * 691;
      let prev: EnemyKind | null = null;
      for (let floor = 1; floor <= 48; floor++) {
        const kind = minibossKindForFloor(seed, floor);
        if (kind !== minibossKindForFloor(seed, floor)) deterministic = false;
        const isCadence = floor >= MINIBOSS.firstFloor && floor % 5 === MINIBOSS.firstFloor % 5;
        if (!isCadence && kind !== null) offCadenceClean = false;
        if (isCadence) {
          if (kind === null || kind === prev) noRepeats = false;
          if (kind !== null) seen.add(kind);
          prev = kind;
        }
      }
    }
    check("the pick is a pure function of (seed, floor)", deterministic);
    check("minibosses land ONLY on the mid-band cadence (13, 18, 23, …)", offCadenceClean);
    check("no template repeats back-to-back within a run", noRepeats);
    check("both templates appear across seeds", seen.size === 2, [...seen].join(","));
    check("the cadence never collides with boss or gauntlet floors",
      [13, 18, 23, 28, 33].every((f) => !isBossFloor(f) && !isGauntletFloor(f)));
  }
  {
    // Natural miniboss floors: exactly one captain, in the ACTIVE wave, on the gauntlet
    // HP formula, with the regular plan trimmed to its budget share.
    let ok = true;
    let hpOk = true;
    let activeOk = true;
    for (let s = 0; s < 6; s++) {
      const seed = 0x111 + s * 887;
      for (const floor of [13, 18, 23]) {
        const kind = minibossKindForFloor(seed, floor)!;
        const d = generateDungeon(seed, floor);
        const spawns = spawnFloorEnemies(d, seed, floor);
        const captains = [...spawns.active, ...spawns.pending].filter((e) => e.captainPhase !== undefined);
        if (captains.length !== 1 || captains[0].kind !== kind) ok = false;
        if (captains[0] && captains[0].maxHp !== minibossHpForFloor(kind, floor)) hpOk = false;
        if (!spawns.active.includes(captains[0])) activeOk = false;
      }
    }
    check("every cadence floor fields exactly ONE captain of the seeded template", ok);
    check("captain HP rides the anchored formula (round-10 of the template fraction)", hpOk);
    check("the captain always enters the active wave (never a queued reinforcement)", activeOk);
    check("floor 14 (off-cadence) fields none", (() => {
      const d = generateDungeon(0x515, 14);
      const spawns = spawnFloorEnemies(d, 0x515, 14);
      return [...spawns.active, ...spawns.pending].every((e) => e.captainPhase === undefined && !isMinibossKind(e.kind));
    })());
  }
}

function marshalTests(): void {
  section("Root Marshal: P1 formation (guard + wards), the 50% shield-to-cover shatter, P2 sweeps");
  {
    const { w, p } = arena(0x4071, 13);
    w.isGodMode = true;
    p.x = 700; p.y = 600;
    const e = spawnReady(w, "marshal", 1000, 600);
    e.hp = e.maxHp = 400;
    e.captainPhase = 1;
    e.aux = 1;
    stepFor(w, 3);
    check("P1: the guard turned onto the player", Math.abs(Math.abs(e.attack.lockedAngle) - Math.PI) < 0.6);
    const hp0 = e.hp;
    const ev: SimEvent[] = [];
    plantShot(w, e.x - 80, e.y, 400, 0, 5);
    stepFor(w, 0.3, ev);
    check("P1: frontal fire is eaten by the wide guard", e.hp === hp0 && ev.some((x) => x.t === "bulletBlocked"));
    stepFor(w, MARSHAL.summonInterval + 1);
    const wards = w.enemies.filter((x) => x.isSummoned && x.kind === "rootward" && !x.dead);
    check("P1: it raises its rootward formation (capped)", wards.length >= 1 && wards.length <= MARSHAL.summonCap,
      `wards=${wards.length}`);
    // Cross 50% from the flank: the shield SHATTERS INTO COVER.
    const props0 = w.props.length;
    plantShot(w, e.x + 80, e.y, -400, 0, 210);
    const ev2: SimEvent[] = [];
    stepFor(w, 0.3, ev2);
    check("the 50% cross fires the captain transition", e.captainPhase === 2 && ev2.some((x) => x.t === "bossPhase"));
    check("the shield became DESTRUCTIBLE COVER on the field", w.props.length > props0,
      `props ${props0} -> ${w.props.length}`);
    check("the phase rode the aux channel for the client", e.aux === 2);
    // Read the dropped guard on open ground (the fresh cover crates sit on the old
    // guard line, and cover eating bullets is exactly what cover is for).
    e.x = 1100; e.y = 900;
    const hp1 = e.hp;
    plantShot(w, e.x - 80, e.y, 400, 0, 5);
    stepFor(w, 0.3);
    check("P2: the guard is gone — frontal fire lands", e.hp === hp1 - 5, `hp ${hp1} -> ${e.hp}`);
    // P2 pressure: sweeps arrive (events — the bolts themselves may spend on the cover).
    const ev3: SimEvent[] = [];
    stepFor(w, MARSHAL.sweepCooldown + MARSHAL.sweepWindup + 0.5, ev3);
    check("P2: the sweeps flow (ring or fan released)",
      ev3.some((x) => x.t === "radialBurst" || x.t === "bossVolley"));
  }
}

function tollTests(): void {
  section("The Toll: knell rings alternating aimed peals; P2 plants killable noise-lures");
  {
    const { w, p } = arena(0x4081, 18);
    w.isGodMode = true;
    p.x = 840; p.y = 600;
    const e = spawnReady(w, "toll", 1140, 600);
    e.hp = e.maxHp = 400;
    e.captainPhase = 1;
    e.aux = 1;
    const ev: SimEvent[] = [];
    let guard = 0;
    while (!ev.some((x) => x.t === "radialBurst") && guard++ < 600) ev.push(...step(w, idle(w.tick + 1)));
    check("P1: the first knell tolls an expanding ring", guard < 600
      && enemyBullets(w).length >= TOLL.ringCount, `bullets=${enemyBullets(w).length}`);
    check("P1: no lure yet (the noise game is P2)", !w.enemies.some((x) => x.kind === "knell"));
    guard = 0;
    while (!ev.some((x) => x.t === "bossVolley") && guard++ < 600) ev.push(...step(w, idle(w.tick + 1)));
    check("P1: the cadence alternates into the aimed peal", guard < 600);
    // Cross 50%: the noise-lure phase.
    plantShot(w, e.x - 80, e.y, 400, 0, 210);
    stepFor(w, 0.2);
    check("the 50% cross flips P2", e.captainPhase === 2 && e.aux === 2);
    guard = 0;
    while (!w.enemies.some((x) => x.kind === "knell") && guard++ < 900) step(w, idle(w.tick + 1));
    const lure = w.enemies.find((x) => x.kind === "knell");
    check("P2: the knell plants a noise-lure at the player's feet", lure !== undefined
      && Math.hypot((lure?.x ?? 0) - p.x, (lure?.y ?? 0) - p.y) < 120);
    // Let it toll: the fuse ring fires from the lure's spot.
    const evLure: SimEvent[] = [];
    stepFor(w, TOLL.lureLife + 0.1, evLure);
    check("an ignored lure TOLLS its own ring", lure!.dead === true && evLure.some((x) => x.t === "radialBurst"));
  }
  {
    // The counterplay: shoot the noise before it sounds.
    const { w, p } = arena(0x4082, 18);
    w.isGodMode = true;
    p.x = 840; p.y = 600;
    const e = spawnReady(w, "toll", 1140, 600);
    e.hp = e.maxHp = 400;
    e.captainPhase = 2;
    e.aux = 2;
    let guard = 0;
    while (!w.enemies.some((x) => x.kind === "knell") && guard++ < 900) step(w, idle(w.tick + 1));
    const lure = w.enemies.find((x) => x.kind === "knell")!;
    // Silence every other sound source so the count below is the lure's alone.
    const beforeShot = enemyBullets(w).length;
    plantShot(w, lure.x - 40, lure.y, 400, 0, 5);
    const ev: SimEvent[] = [];
    stepFor(w, 0.2, ev);
    check("a shot silences the lure (dead, NO ring beyond the round that killed it)",
      lure.dead && !ev.some((x) => x.t === "radialBurst"), `bullets ${beforeShot} -> ${enemyBullets(w).length}`);
  }
}

// ---- spawn/threat integration ----

function integrationTests(): void {
  section("roster integration: intro floors, cards, caps");
  check("the bestiary wave lands down the biome ladder (rootward F8 … fragment F31)",
    FAMILY_INTRO_FLOOR.rootward === 8 && FAMILY_INTRO_FLOOR.caskbellows === 11
    && FAMILY_INTRO_FLOOR.echojack === 13 && FAMILY_INTRO_FLOOR.seamcutter === 16
    && FAMILY_INTRO_FLOOR.sinderling === 26 && FAMILY_INTRO_FLOOR.fragment === 31);
  {
    // No new kind ever spawns before its intro floor; decoys/minibosses never roster-spawn.
    let introOk = true;
    let summonsClean = true;
    for (let s = 0; s < 8 && introOk; s++) {
      const seed = 0xBEA57 + s * 4241;
      for (let floor = 1; floor <= 34; floor++) {
        if (isBossFloor(floor)) continue;
        const d = generateDungeon(seed, floor);
        const spawns = spawnFloorEnemies(d, seed, floor);
        for (const e of [...spawns.active, ...spawns.pending]) {
          if (floor < (FAMILY_INTRO_FLOOR[e.kind] ?? 0)) introOk = false;
          if (e.kind === "echo" || e.kind === "knell") summonsClean = false;
          if (isMinibossKind(e.kind) && e.captainPhase === undefined) summonsClean = false;
        }
      }
    }
    check("no new family spawns before its intro floor (8 seeds × F1–34)", introOk);
    check("decoys never roster-spawn; miniboss kinds only as captains", summonsClean);
  }
  {
    // The new kinds actually SHOW UP in their bands.
    const seen = new Set<EnemyKind>();
    for (let s = 0; s < 14; s++) {
      const seed = 0xF1E1D + s * 733;
      for (const floor of [9, 12, 14, 17, 27, 32]) {
        const d = generateDungeon(seed, floor);
        const spawns = spawnFloorEnemies(d, seed, floor);
        for (const e of [...spawns.active, ...spawns.pending]) seen.add(e.kind);
      }
    }
    const wanted: EnemyKind[] = ["rootward", "caskbellows", "echojack", "seamcutter", "sinderling", "fragment"];
    check("every new common appears in floor plans across seeds", wanted.every((k) => seen.has(k)),
      wanted.filter((k) => !seen.has(k)).join(",") || "all present");
  }
  {
    // Room guards: never two rootwards in one room (the wall-verb readability cap).
    let capOk = true;
    for (let s = 0; s < 10; s++) {
      const seed = 0x9AD + s * 311;
      for (const floor of [8, 9, 12, 14]) {
        const d = generateDungeon(seed, floor);
        const spawns = spawnFloorEnemies(d, seed, floor);
        const roomOf = (e: Enemy): number => {
          for (let i = 0; i < d.rooms.length; i++) {
            const r = d.rooms[i];
            const tx = Math.floor(e.x / TILE), ty = Math.floor(e.y / TILE);
            if (tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h) return i;
          }
          return -1;
        };
        const perRoom = new Map<number, number>();
        for (const e of [...spawns.active, ...spawns.pending]) {
          if (e.kind !== "rootward") continue;
          const room = roomOf(e);
          perRoom.set(room, (perRoom.get(room) ?? 0) + 1);
          if ((perRoom.get(room) ?? 0) > 1) capOk = false;
        }
      }
    }
    check("max one rootward anchor per room", capOk);
  }
}

// ---- protocol: the bestiary rides the wire ----

function protocolTests(): void {
  section("protocol v8: aux channel, new kinds/moves/hazards round-trip the codec");
  {
    const { w } = arena(0x4091, 26);
    const sinder = spawnReady(w, "sinderling", 900, 600);
    sinder.aux = 1;
    const frag = spawnReady(w, "fragment", 1000, 600);
    frag.aux = sinder.id + 1;
    frag.attack.phase = "windup";
    frag.attack.move = "harmonize";
    const cutter = spawnReady(w, "seamcutter", 1100, 600);
    cutter.attack.phase = "active";
    cutter.attack.move = "seam";
    w.hazards.push({ id: 1, kind: "cinder", x: 900, y: 620, radius: 24, life: 2, maxLife: 3 });
    w.hazards.push({ id: 2, kind: "charge", x: 940, y: 620, radius: 60, life: 0.5, maxLife: 0.9 });
    const snap = buildSnapshot(w, LOCAL_ID, 0, [], 0, true, { worldId: "room:TEST" });
    const decoded = jsonCodec.decodeServer(jsonCodec.encodeServer(snap));
    check("the full snapshot survives encode -> strict decode", decoded.t === "snap");
    if (decoded.t === "snap") {
      const ws = decoded.enemies.find((e) => e.kind === "sinderling");
      const wf = decoded.enemies.find((e) => e.kind === "fragment");
      const wc = decoded.enemies.find((e) => e.kind === "seamcutter");
      check("the aux channel rides the wire (armed flag + tether id)",
        ws?.aux === 1 && wf?.aux === sinder.id + 1);
      check("the new moves validate (harmonize windup, seam active)",
        wf?.atk.mv === "harmonize" && wc?.atk.mv === "seam" && wc?.atk.ph === "active");
      check("cinder + charge hazards validate on the wire",
        decoded.hzds.some((h) => h.k === "cinder") && decoded.hzds.some((h) => h.k === "charge"));
    }
    // Entity round-trips preserve the render contract fields.
    const rt = enemyFromWire(toEnemyWire(sinder), sinder.x, sinder.y);
    check("enemyFromWire reconstructs aux for the renderer", rt.aux === 1 && rt.kind === "sinderling");
    const hz = hazardFromWire(toHazardWire(w.hazards[0]));
    check("hazardFromWire preserves the cinder", hz.kind === "cinder" && hz.radius === 24);
  }
}

// ---- navigation: the new roster on obstructed ground ----

function navTests(): void {
  section("trapped-mob navigation: new ground kinds route through a prop row (no wedge, no NaN)");
  {
    const w = createWorld(0x40A1, 1, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    p.x = (17 + 0.5) * TILE; p.y = (12 + 0.5) * TILE;
    // A solid 3-prop row between the pack and the player.
    for (const ty of [11, 12, 13]) devSpawnProp(w, "barrel", (20 + 0.5) * TILE, (ty + 0.5) * TILE);
    const rootward = spawnReady(w, "rootward", (23 + 0.5) * TILE, (12 + 0.5) * TILE);
    const sinder = spawnReady(w, "sinderling", (23 + 0.5) * TILE, (13 + 0.5) * TILE);
    const cask = spawnReady(w, "caskbellows", (28 + 0.5) * TILE, (12 + 0.5) * TILE);
    let sinderReached = false;
    let rootwardReached = false;
    let caskCommitted = false;
    let finiteOk = true;
    const DT20 = 1 / 20;
    const inputs = new Map([[LOCAL_ID, idle(0)]]);
    for (let t = 0; t < 700; t++) {
      p.x = (17 + 0.5) * TILE; p.y = (12 + 0.5) * TILE; // pin the target
      stepWorld(w, inputs, DT20);
      for (const e of w.enemies) {
        if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) finiteOk = false;
      }
      if (Math.hypot(sinder.x - p.x, sinder.y - p.y) < p.pr + sinder.radius + 8) sinderReached = true;
      if (Math.hypot(rootward.x - p.x, rootward.y - p.y) < p.pr + rootward.radius + 8) rootwardReached = true;
      if (cask.attack.move === "volley" || cask.seq > 0) caskCommitted = true;
    }
    check("the sinderling routed around the row to contact", sinderReached);
    check("the slow rootward wall also arrived (bounded time)", rootwardReached);
    check("the caskbellows closed to its band and committed a volley", caskCommitted);
    check("every position stayed finite throughout", finiteOk);
  }
  {
    // The seamcutter's cut smashes THROUGH the row rather than wedging on it.
    const w = createWorld(0x40A2, 1, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    p.x = (17 + 0.5) * TILE; p.y = (12 + 0.5) * TILE;
    for (const ty of [11, 12, 13]) devSpawnProp(w, "crate", (20 + 0.5) * TILE, (ty + 0.5) * TILE);
    const cutter = spawnReady(w, "seamcutter", (23 + 0.5) * TILE, (12 + 0.5) * TILE);
    const inputs = new Map([[LOCAL_ID, idle(0)]]);
    let didCut = false;
    for (let t = 0; t < 300; t++) {
      p.x = (17 + 0.5) * TILE; p.y = (12 + 0.5) * TILE;
      stepWorld(w, inputs, 1 / 20);
      if (cutter.attack.move === "seam" && cutter.attack.phase === "active") didCut = true;
    }
    check("the seamcutter committed its cut on obstructed ground", didCut);
    check("the cut splintered the furniture in its lane (broken props leave the world)",
      w.props.filter((pr) => !pr.dead).length < 3, `intact=${w.props.filter((pr) => !pr.dead).length}`);
  }
}

// ---- dense-room performance ----

function perfTests(): void {
  section("perf gate: a dense mixed bestiary room stays far under the 20Hz tick budget");
  const w = createWorld(0x40B1, 1, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  p.x = (17 + 0.5) * TILE; p.y = (12 + 0.5) * TILE;
  const rng = new Rng(0xFEED);
  const used = new Set<number>();
  let props = 0;
  while (props < 40) {
    const tx = 2 + rng.int(0, 29);
    const ty = 2 + rng.int(0, 19);
    const idx = ty * w.dungeon.w + tx;
    if (used.has(idx) || (Math.abs(tx - 17) <= 1 && Math.abs(ty - 12) <= 1)) continue;
    used.add(idx);
    devSpawnProp(w, rng.chance(0.5) ? "crate" : "barrel", (tx + 0.5) * TILE, (ty + 0.5) * TILE);
    props++;
  }
  const kinds: EnemyKind[] = [
    "rootward", "echojack", "seamcutter", "caskbellows", "sinderling", "fragment",
    "slime", "bat", "skeleton", "spitter",
  ];
  for (let i = 0; i < 60; i++) {
    const tx = 2 + rng.int(0, 29);
    const ty = 2 + rng.int(0, 19);
    const e = devSpawnEnemy(w, kinds[i % kinds.length], (tx + 0.5) * TILE, (ty + 0.5) * TILE);
    e.spawnTimer = 0;
    if (i % 10 === 0) e.aux = e.kind === "sinderling" ? 1 : e.aux;
  }
  const marshal = spawnReady(w, "marshal", (28 + 0.5) * TILE, (18 + 0.5) * TILE);
  marshal.hp = marshal.maxHp = 400;
  marshal.captainPhase = 1;
  const toll = spawnReady(w, "toll", (5 + 0.5) * TILE, (5 + 0.5) * TILE);
  toll.hp = toll.maxHp = 400;
  toll.captainPhase = 2;
  const inputs = new Map([[LOCAL_ID, idle(0)]]);
  for (let t = 0; t < 40; t++) stepWorld(w, inputs, 1 / 20); // warmup (JIT + field builds)
  const times: number[] = [];
  for (let t = 0; t < 300; t++) {
    const t0 = performance.now();
    stepWorld(w, inputs, 1 / 20);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((s, x) => s + x, 0) / times.length;
  const p95 = times[Math.floor(times.length * 0.95)];
  process.stdout.write(`    62 mixed enemies (+2 captains) + 40 props: avg ${avg.toFixed(3)}ms/tick, p95 ${p95.toFixed(3)}ms (50ms budget @20Hz)\n`);
  check("average tick far under the 20Hz budget", avg < 8, `avg=${avg.toFixed(3)}ms`);
  check("p95 tick under budget", p95 < 16, `p95=${p95.toFixed(3)}ms`);
}

// ---- replay determinism ----

function determinismTests(): void {
  section("determinism: the mixed bestiary replays bit-identically (pure, seeded, no wall-clock)");
  const run = (): number[] => {
    const w = createWorld(0x40C1, 13, { isSandbox: true });
    w.isGodMode = true;
    const p = w.players.get(LOCAL_ID)!;
    p.x = 840; p.y = 600;
    const kinds: EnemyKind[] = ["rootward", "echojack", "seamcutter", "caskbellows", "sinderling", "fragment"];
    kinds.forEach((kind, i) => {
      const e = spawnReady(w, kind, 500 + (i % 3) * 300, 400 + Math.floor(i / 3) * 320);
      if (kind === "sinderling") e.aux = 1;
    });
    const cmd = createEnemy("slime", 1200, 800, 13, w.rng, w.nextEnemyId++, { tier: "elite" });
    cmd.spawnTimer = 0;
    w.enemies.push(cmd);
    const marshal = spawnReady(w, "marshal", 1250, 350);
    marshal.hp = marshal.maxHp = 400;
    marshal.captainPhase = 1;
    for (let t = 0; t < 600; t++) {
      stepWorld(w, new Map([[LOCAL_ID, {
        seq: t, moveX: Math.sin(t / 25), moveY: Math.cos(t / 40), aim: t / 30, firing: t % 5 === 0, dash: false,
      }]]), DT);
    }
    const out: number[] = [];
    for (const e of w.enemies) out.push(e.x, e.y, e.hp, e.aux, e.seq);
    for (const h of w.hazards) out.push(h.x, h.y, h.life);
    return out;
  };
  const a = run(), b = run();
  check("two fresh seeded runs produce identical state streams",
    a.length === b.length && a.every((v, i) => v === b[i]), `${a.length} scalars compared`);
  check("everything stayed finite", a.every((v) => Number.isFinite(v)));
}

// ---- floor-clear semantics with decoys ----

function clearTests(): void {
  section("floor clear: decoys count as live bodies but always resolve themselves");
  const { w, p } = arena(0x40D1);
  p.x = 840; p.y = 600;
  const e = spawnReady(w, "echojack", 1100, 600);
  let guard = 0;
  while (!w.enemies.some((x) => x.kind === "echo") && guard++ < 600) step(w, idle(w.tick + 1));
  plantShot(w, e.x, e.y, 1, 0, 9999, { radius: 14, life: 0.1 });
  stepFor(w, 0.2);
  check("the jack is down, its echo still stands", e.dead && w.enemies.some((x) => x.kind === "echo"));
  check("the floor is not cleared while the echo stands", !isFloorCleared(w));
  stepFor(w, C.ECHO_LIFE + 0.3);
  check("the echo expires and the floor clears itself", isFloorCleared(w));
}

function main(): void {
  rootwardTests();
  echojackTests();
  seamcutterTests();
  caskbellowsTests();
  sinderlingTests();
  fragmentTests();
  eliteTests();
  minibossCadenceTests();
  marshalTests();
  tollTests();
  integrationTests();
  protocolTests();
  navTests();
  perfTests();
  determinismTests();
  clearTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll bestiary-wave assertions hold.\n");
}

main();
