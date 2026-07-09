// The art/render contract (Ian + AD): persistent 4-way facing from movement with a
// deadzone (no jitter), attack intent overriding while a move telegraphs, and the
// directional-sheet selection ladder that lets AD assets drop in with zero further
// architecture changes. All pure logic (src/game/facing.ts) — no DOM, no canvas.
//
// Run: npm run test:facing

import {
  createFacing, updateFacing, facingFromAngle, computeEnemyPose, resolveClip,
  AIMED_MOVES, FACING_DEADZONE, FACING_AXIS_BIAS,
} from "../src/game/facing.js";
import type { EnemyPose, SelectableClip } from "../src/game/facing.js";
import { SHEETS, devSpriteManifest } from "../src/game/assets.js";
import { createEnemy } from "../src/sim/enemies.js";
import type { Enemy, AttackMove } from "../src/sim/types.js";
import { Rng } from "../src/sim/rng.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

function testEnemy(): Enemy {
  return createEnemy("charger", 500, 500, 1, new Rng(1), 0);
}

function poseOf(overrides: Partial<EnemyPose> = {}): EnemyPose {
  return {
    facing: "side", isMirrored: false, isMoving: true, isAttacking: false,
    move: "none", phase: "none", windup: 0, aimAngle: 0,
    ...overrides,
  };
}

function facingTests(): void {
  section("4-way facing: derivation, deadzone, persistence");
  {
    const f = createFacing();
    check("a fresh body faces down (the AD's default pose)", f.facing === "down" && !f.isMirrored);
    updateFacing(f, 120, 0);
    check("committed rightward motion turns it side-right", f.facing === "side" && !f.isMirrored);
    updateFacing(f, -120, 0);
    check("leftward motion mirrors the side pose", f.facing === "side" && f.isMirrored);
    updateFacing(f, 0, 140);
    check("downward motion turns it down", f.facing === "down");
    updateFacing(f, 0, -140);
    check("upward motion turns it up", f.facing === "up");
  }
  {
    const f = createFacing();
    updateFacing(f, 150, 0);
    for (let i = 0; i < 60; i++) updateFacing(f, (i % 2 === 0 ? 1 : -1) * (FACING_DEADZONE - 5), FACING_DEADZONE - 5);
    check("sub-deadzone drift (knockback dribble, interp noise) never moves the facing",
      f.facing === "side" && !f.isMirrored);
    updateFacing(f, 0, 0);
    check("standing still holds the last facing (persistent, frame 0 idles)", f.facing === "side");
  }
  {
    // A 45° walk must not flip axis every frame: the other axis has to LEAD decisively.
    const f = createFacing();
    updateFacing(f, 200, 0);
    let flips = 0;
    let prev = f.facing;
    for (let i = 0; i < 120; i++) {
      const wobble = 1 + 0.1 * Math.sin(i); // vy/vx wobbles around 1.0 across frames
      updateFacing(f, 200, 200 * wobble);
      if (f.facing !== prev) { flips++; prev = f.facing; }
    }
    check("a wobbling diagonal never see-saws the facing (axis hysteresis)", flips === 0,
      `flips=${flips}, bias=${FACING_AXIS_BIAS}`);
    updateFacing(f, 60, 60 * FACING_AXIS_BIAS * 1.2);
    check("a decisively vertical turn still takes the facing", f.facing === "down");
  }
  {
    const f = createFacing();
    facingFromAngle(f, Math.PI); // aim hard left
    check("aim angles snap facing with no deadzone", f.facing === "side" && f.isMirrored);
    facingFromAngle(f, -Math.PI / 2);
    check("an upward aim faces up", f.facing === "up");
  }
}

function poseTests(): void {
  section("pose: attack intent overrides movement while a move telegraphs");
  {
    const e = testEnemy();
    const f = createFacing();
    // Walking right...
    let pose = computeEnemyPose(e, f, 150, 0, true);
    check("movement drives the pose while idle-attacking", pose.facing === "side" && !pose.isAttacking);
    // ...then a rush windup locks an aim to the LEFT: the body must face its commitment.
    e.attack.phase = "windup";
    e.attack.move = "rush";
    e.attack.lockedAngle = Math.PI;
    e.attack.windup = 0.6;
    pose = computeEnemyPose(e, f, 150, 0, true);
    check("an AIMED windup turns the body onto its locked angle (movement overridden)",
      pose.isAttacking && pose.facing === "side" && pose.isMirrored && pose.aimAngle === Math.PI);
    check("the pose exposes the telegraph to the renderer (move/phase/windup)",
      pose.move === "rush" && pose.phase === "windup" && pose.windup === 0.6);
    // A non-aimed move (the crash stun's recover, a roar…) leaves movement facing alone.
    e.attack.move = "roar";
    e.attack.lockedAngle = -Math.PI / 2;
    pose = computeEnemyPose(e, f, 150, 0, true);
    check("a NON-aimed move keeps the movement-derived facing", pose.facing === "side" && !pose.isMirrored);
  }
  {
    // The Record type makes this a compile error first; the runtime check documents it.
    const moves: AttackMove[] = [
      "none", "lunge", "spit", "hopslam", "radial", "roar", "squeeze",
      "rush", "crash", "dive", "erupt", "volley", "spin", "shield",
      "fade", "wail", "split", "pounce", "weave", "slam", "sweep",
    ];
    check("every AttackMove has an authored aimed/non-aimed facing decision",
      moves.every((m) => typeof AIMED_MOVES[m] === "boolean"), `${moves.length} moves`);
  }
}

function ladderTests(): void {
  section("clip ladder: attack_<dir> -> attack -> walk_<dir> -> legacy walk/idle");
  const withSheets = (available: SelectableClip[]) => (clip: SelectableClip) => available.includes(clip);
  {
    const has = withSheets(["walk_down", "walk_up", "walk_side", "attack_side", "attack"]);
    const attack = resolveClip(has, poseOf({ isAttacking: true, facing: "side", isMirrored: true }));
    check("a directional attack sheet wins while attacking", attack.clip === "attack_side" && attack.isMirrored);
    const attackUp = resolveClip(has, poseOf({ isAttacking: true, facing: "up" }));
    check("a missing directional attack degrades to the omni attack sheet", attackUp.clip === "attack");
    const walk = resolveClip(has, poseOf({ facing: "up" }));
    check("walking without attacking picks the facing's walk sheet", walk.clip === "walk_up" && !walk.isMirrored);
  }
  {
    const has = withSheets(["walk_down", "walk_up", "walk_side"]);
    const idle = resolveClip(has, poseOf({ facing: "side", isMoving: false, isMirrored: true }));
    check("an idle body holds frame 0 of its facing sheet (frame 0 IS the idle pose)",
      idle.clip === "walk_side" && idle.isHoldFirstFrame && idle.isMirrored);
    const moving = resolveClip(has, poseOf({ facing: "side", isMoving: true }));
    check("a moving body plays the sheet", moving.clip === "walk_side" && !moving.isHoldFirstFrame);
    const attacking = resolveClip(has, poseOf({ isAttacking: true, facing: "down" }));
    check("attacking without any attack sheet falls through to the facing walk", attacking.clip === "walk_down");
  }
  {
    const has = withSheets(["walk_down", "walk_up", "walk_side"]);
    const down = resolveClip(has, poseOf({ facing: "down", isMirrored: true }));
    check("down/up directional art NEVER mirrors (only side does)", !down.isMirrored);
  }
  {
    // The legacy tier: exactly today's behavior for every existing enemy.
    const has = withSheets(["walk", "idle"]);
    const walk = resolveClip(has, poseOf({ facing: "down", isMirrored: true, isMoving: true }));
    check("no directional art -> legacy walk with the persistent L/R mirror",
      walk.clip === "walk" && walk.isMirrored && !walk.isHoldFirstFrame);
    const idle = resolveClip(has, poseOf({ isMoving: false }));
    check("legacy idle when standing", idle.clip === "idle");
    const none = resolveClip(withSheets([]), poseOf({ isMoving: true }));
    check("no sheets at all still resolves (drawChar then falls back to static + procedural)",
      none.clip === "walk");
  }
}

// The AD's approved-final assets are drop-ins: the hooks must carry these EXACT
// filenames so wiring the art is a pure file copy, never a code change.
function approvedHookTests(): void {
  section("approved asset hooks: exact final filenames (weaver2 / beam2 pair)");
  check("the Weaver's base sprite hook expects weaver2_px.png",
    devSpriteManifest().some((a) => a.group === "sprites" && a.label === "weaver" && a.src === "/sprites/weaver2_px.png"));
  const dirs: Array<[string, string]> = [
    ["weaver.walk_down", "/sprites/weaver2_px_walk_down.png"],
    ["weaver.walk_up", "/sprites/weaver2_px_walk_up.png"],
    ["weaver.walk_side", "/sprites/weaver2_px_walk_side.png"],
    ["weaver.attack", "/sprites/weaver2_px_attack.png"],
  ];
  check("the Weaver directional/attack contract derives from the weaver2_px stem",
    dirs.every(([key, src]) => SHEETS[key]?.src === src),
    dirs.map(([key]) => SHEETS[key]?.src ?? "missing").join(", "));
  check("the Beam pickup hook expects beam2_px.png",
    devSpriteManifest().some((a) => a.group === "weapon pickups" && a.label === "pickup beam" && a.src === "/sprites/beam2_px.png"));
  check("the Beam held hook expects held_beam2_px.png",
    devSpriteManifest().some((a) => a.group === "held weapons" && a.label === "held beam" && a.src === "/sprites/held_beam2_px.png"));
  check("the beam's dedicated ray is a registered code-tinted white mask (beam_ray)",
    devSpriteManifest().some((a) => a.group === "bullet fx" && a.label === "beam_ray" && a.src === "/sprites/fx/beam_ray.png"));
}

function main(): void {
  facingTests();
  poseTests();
  ladderTests();
  approvedHookTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nThe art/render facing contract holds.\n");
}

main();
