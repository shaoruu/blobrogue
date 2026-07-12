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
import { SHEETS, registerMoveSheet, devSpriteManifest } from "../src/game/assets.js";
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
    facing: "side", isMirrored: false, verticalFacing: "down", isMoving: true, isAttacking: false,
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
      "fade", "wail", "split", "pounce", "weave", "slam", "sweep", "brace",
      "decoy", "blink", "seam", "stoke", "harmonize", "knell",
    ];
    check("every AttackMove has an authored aimed/non-aimed facing decision",
      moves.every((m) => typeof AIMED_MOVES[m] === "boolean"), `${moves.length} moves`);
    check("the bestiary wave's aimed moves face their lanes (seam/blink), its beats face movement",
      AIMED_MOVES.seam && AIMED_MOVES.blink
      && !AIMED_MOVES.decoy && !AIMED_MOVES.stoke && !AIMED_MOVES.harmonize && !AIMED_MOVES.knell);
  }
  {
    // A seamcutter's locked lane owns the facing through the whole cut; tiny velocity
    // jitter mid-commitment must never flip it (the anti-flicker contract on a new kind).
    const e = createEnemy("seamcutter", 500, 500, 16, new Rng(2), 1);
    const f = createFacing();
    e.attack.phase = "windup";
    e.attack.move = "seam";
    e.attack.lockedAngle = Math.PI; // cutting west
    let flips = 0;
    let prevMirror = true;
    for (let i = 0; i < 90; i++) {
      const jitterX = (i % 2 === 0 ? 1 : -1) * 20; // sub-deadzone knockback dribble
      const pose = computeEnemyPose(e, f, jitterX, 6, true);
      if (pose.isMirrored !== prevMirror && i > 0) flips++;
      prevMirror = pose.isMirrored;
    }
    check("a locked seam never flip-flickers under sub-deadzone velocity noise",
      flips === 0 && f.facing === "side" && f.isMirrored, `flips=${flips}`);
  }
  section("smoothed facing: a phasing drifter holds steady as it passes through its target");
  {
    // The ghost bug: a phasing body drifts THROUGH the player instead of colliding, so
    // once it overlaps, its heading snaps target-ward → past → back every frame — the
    // observed velocity reverses at FULL speed (well above the deadzone), and the L/R
    // mirror flips every frame (flicker / "half frames face opposite"). The deadzone gates
    // on magnitude, not sign, so it cannot catch this on the raw signal.
    const raw = createFacing();
    const smoothed = createFacing();
    const ghost = createEnemy("ghost", 500, 500, 1, new Rng(3), 0);
    let rawFlips = 0, smoothFlips = 0;
    let prevRaw = raw.isMirrored, prevSmooth = smoothed.isMirrored;
    for (let i = 0; i < 120; i++) {
      const vx = (i % 2 === 0 ? 1 : -1) * 60; // ±full-speed reversal each frame (the phase-through)
      const rawPose = computeEnemyPose(ghost, raw, vx, 8, true, false);
      const smoothPose = computeEnemyPose(ghost, smoothed, vx, 8, true, true);
      if (i > 0 && rawPose.isMirrored !== prevRaw) rawFlips++;
      if (i > 0 && smoothPose.isMirrored !== prevSmooth) smoothFlips++;
      prevRaw = rawPose.isMirrored; prevSmooth = smoothPose.isMirrored;
    }
    check("WITHOUT smoothing the phase-through oscillation flip-flickers the mirror (the bug)",
      rawFlips > 40, `rawFlips=${rawFlips}`);
    check("WITH smoothing the ghost holds a steady facing through the wobble (the fix)",
      smoothFlips === 0, `smoothFlips=${smoothFlips}`);
  }
  {
    // The fix must not freeze facing: a smoothed drifter still turns to its GENUINE travel
    // direction — it only ignores the sign-reversing wobble, never a sustained heading.
    const f = createFacing();
    const ghost = createEnemy("ghost", 500, 500, 1, new Rng(4), 0);
    for (let i = 0; i < 30; i++) computeEnemyPose(ghost, f, 90, 0, true, true); // sustained travel RIGHT
    check("a smoothed drifter faces its sustained rightward travel", f.facing === "side" && !f.isMirrored);
    for (let i = 0; i < 30; i++) computeEnemyPose(ghost, f, -90, 0, true, true); // then sustained LEFT
    check("…and turns to face a sustained leftward travel (facing never frozen)",
      f.facing === "side" && f.isMirrored);
    for (let i = 0; i < 30; i++) computeEnemyPose(ghost, f, 0, -90, true, true); // then straight UP
    check("…and up when it commits upward", f.facing === "up");
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
    // The blocked-side contract (the Gilded Warden): DOWN+UP sets only — horizontal
    // movement HOLDS the nearest approved vertical sheet, unmirrored, and side-facing
    // attacks resolve to the approved generic strip. No fake side slide.
    const has = withSheets(["walk_down", "walk_up", "attack_down", "attack_up", "attack"]);
    const strafeAfterDown = resolveClip(has, poseOf({ facing: "side", verticalFacing: "down", isMirrored: true }));
    check("a blocked side profile strafing after walking DOWN holds walk_down (never mirrored)",
      strafeAfterDown.clip === "walk_down" && !strafeAfterDown.isMirrored);
    const strafeAfterUp = resolveClip(has, poseOf({ facing: "side", verticalFacing: "up" }));
    check("…and after walking UP it holds walk_up (the nearest approved vertical)",
      strafeAfterUp.clip === "walk_up");
    const idleSide = resolveClip(has, poseOf({ facing: "side", verticalFacing: "up", isMoving: false }));
    check("standing side-on holds frame 0 of the vertical sheet (no slide, no mirror)",
      idleSide.clip === "walk_up" && idleSide.isHoldFirstFrame && !idleSide.isMirrored);
    const sideAttack = resolveClip(has, poseOf({ isAttacking: true, facing: "side" }));
    check("a side-facing attack resolves to the approved generic strip", sideAttack.clip === "attack");
    const downAttack = resolveClip(has, poseOf({ isAttacking: true, facing: "down" }));
    check("a down-facing attack still picks its approved directional sheet", downAttack.clip === "attack_down");
  }
  {
    // The vertical-hold memory lives in the tracker: strafing preserves the last vertical.
    const f = createFacing();
    updateFacing(f, 0, -140);       // walk up
    updateFacing(f, 200, 20);       // hard strafe right
    check("the tracker remembers the last vertical while strafing", f.facing === "side" && f.lastVertical === "up");
    updateFacing(f, 30, 180);       // turn down
    updateFacing(f, -200, 10);      // strafe left
    check("…and updates it when the vertical changes", f.facing === "side" && f.lastVertical === "down");
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

// Multi-move bosses need more than one generic attack sheet: any authored move+phase
// outranks the generic tiers, and every absence falls through cleanly. Exercised with
// each boss's REAL move ids (the AD language maps: Marrow charge/stomp -> rush/volley,
// Weaver pounce/lattice -> pounce/weave, Warden slam/prison/turret-sweep -> slam/roar/
// sweep, Choir sing/swell -> wail/fade).
function moveSheetTests(): void {
  section("move-specific telegraphs: authored move+phase outranks the generic attack");
  const withSheets = (available: SelectableClip[]) => (clip: SelectableClip) => available.includes(clip);
  {
    // MARROW: a charge windup and a volley windup select DIFFERENT authored sheets.
    const has = withSheets(["rush_windup_side", "rush_windup", "volley_windup", "attack_side", "attack"]);
    const charge = resolveClip(has, poseOf({ isAttacking: true, move: "rush", phase: "windup", facing: "side", isMirrored: true }));
    check("Marrow charge windup picks its own directional sheet", charge.clip === "rush_windup_side" && charge.isMirrored);
    const volley = resolveClip(has, poseOf({ isAttacking: true, move: "volley", phase: "windup", facing: "side" }));
    check("Marrow volley windup picks the volley sheet, never the charge's", volley.clip === "volley_windup");
    const spin = resolveClip(has, poseOf({ isAttacking: true, move: "spin", phase: "windup", facing: "side" }));
    check("an unauthored move (spin) falls back to the directional generic attack", spin.clip === "attack_side");
  }
  {
    // WEAVER: pounce vs lattice-weave, plus phase specificity within one move.
    const has = withSheets(["pounce_active", "weave_windup", "attack"]);
    const pounce = resolveClip(has, poseOf({ isAttacking: true, move: "pounce", phase: "active", facing: "up" }));
    check("Weaver pounce (airborne) picks its authored active sheet", pounce.clip === "pounce_active");
    const weave = resolveClip(has, poseOf({ isAttacking: true, move: "weave", phase: "windup", facing: "up" }));
    check("Weaver lattice-weave picks its own windup sheet", weave.clip === "weave_windup");
    const pounceWindup = resolveClip(has, poseOf({ isAttacking: true, move: "pounce", phase: "windup", facing: "up" }));
    check("the same move in an unauthored PHASE falls to the generic attack", pounceWindup.clip === "attack");
  }
  {
    // GILDED WARDEN: three distinct commitments resolve three distinct sheets, and the
    // authored EXPOSED recover (the punish pose) wins during recovery.
    const has = withSheets(["slam_active", "sweep_active", "roar_windup", "slam_recover", "walk_down", "idle"]);
    const slam = resolveClip(has, poseOf({ isAttacking: true, move: "slam", phase: "active", facing: "down" }));
    const sweep = resolveClip(has, poseOf({ isAttacking: true, move: "sweep", phase: "active", facing: "down" }));
    const sanctify = resolveClip(has, poseOf({ isAttacking: true, move: "roar", phase: "windup", facing: "down" }));
    check("Warden quake / sweep / sanctify each select their own sheet",
      slam.clip === "slam_active" && sweep.clip === "sweep_active" && sanctify.clip === "roar_windup");
    const exposed = resolveClip(has, poseOf({ isAttacking: false, move: "slam", phase: "recover", facing: "down", isMoving: false }));
    check("the EXPOSED recover pose is first-class (move+recover outranks idle)", exposed.clip === "slam_recover");
  }
  {
    // CHOIR: sing (wail) vs swell (fade) — and with nothing authored, the ladder is
    // byte-identical to the pre-contract behavior.
    const has = withSheets(["wail_windup", "fade_active", "idle", "attack"]);
    const sing = resolveClip(has, poseOf({ isAttacking: true, move: "wail", phase: "windup", facing: "side" }));
    const swell = resolveClip(has, poseOf({ isAttacking: true, move: "fade", phase: "active", facing: "side" }));
    check("Choir sing vs swell select different authored sheets", sing.clip === "wail_windup" && swell.clip === "fade_active");
    const bare = resolveClip(withSheets(["walk", "idle"]), poseOf({ isAttacking: true, move: "wail", phase: "windup", isMoving: true }));
    check("with no move or attack sheets at all, the legacy ladder is unchanged", bare.clip === "walk");
  }
  {
    // The registration helper writes the exact key/filename contract, omni and directional.
    registerMoveSheet("marrow", "rush_windup", 12, { isDirectional: true });
    registerMoveSheet("gilded", "slam_active", 10);
    registerMoveSheet("weaver", "pounce_active", 12, { fileBase: "weaver2_px" });
    check("registerMoveSheet writes directional move keys off the stem",
      SHEETS["marrow.rush_windup_side"]?.src === "/sprites/marrow_rush_windup_side.png"
      && SHEETS["marrow.rush_windup_down"]?.src === "/sprites/marrow_rush_windup_down.png"
      && SHEETS["marrow.rush_windup_up"]?.src === "/sprites/marrow_rush_windup_up.png");
    check("registerMoveSheet writes omni move keys",
      SHEETS["gilded.slam_active"]?.src === "/sprites/gilded_slam_active.png");
    check("registerMoveSheet honors AD-versioned stems",
      SHEETS["weaver.pounce_active"]?.src === "/sprites/weaver2_px_pounce_active.png");
  }
}

// The AD's approved-final assets are drop-ins: the hooks must carry these EXACT
// filenames so wiring the art is a pure file copy, never a code change.
function approvedHookTests(): void {
  section("approved asset hooks: every actor's directional walk + attack set");
  // Approved actor queue, each with the full walk_{down,up,side} + attack_{down,up,side}
  // contract off its manifest file stem (the Weaver ships on the versioned weaver2_px).
  const actors: Array<[string, string]> = [
    ["marrow", "marrow"],
    ["burrower", "burrower"],
    ["weaver", "weaver2_px"],
    ["charger", "charger"],
    ["orbiter", "orbiter"],
    ["shielder", "shielder"],
  ];
  for (const [sprite, stem] of actors) {
    const keys: Array<[string, string]> = [
      [`${sprite}.walk_down`, `/sprites/${stem}_walk_down.png`],
      [`${sprite}.walk_up`, `/sprites/${stem}_walk_up.png`],
      [`${sprite}.walk_side`, `/sprites/${stem}_walk_side.png`],
      [`${sprite}.attack_down`, `/sprites/${stem}_attack_down.png`],
      [`${sprite}.attack_up`, `/sprites/${stem}_attack_up.png`],
      [`${sprite}.attack_side`, `/sprites/${stem}_attack_side.png`],
    ];
    check(`${sprite}: directional walk + attack hooks derive from the '${stem}' stem`,
      keys.every(([key, src]) => SHEETS[key]?.src === src),
      keys.map(([key]) => SHEETS[key]?.src ?? "missing").join(", "));
  }
  check("the Weaver's base sprite hook expects weaver2_px.png",
    devSpriteManifest().some((a) => a.group === "sprites" && a.label === "weaver" && a.src === "/sprites/weaver2_px.png"));
  // The Gilded Warden's side profile is BLOCKED (art gate, failed twice): DOWN+UP sets +
  // the generic attack strip only — no side file is registered or ever requested.
  check("gilded: approved DOWN+UP walk/attack + generic attack hooks only",
    SHEETS["gilded.walk_down"]?.src === "/sprites/gilded_walk_down.png"
    && SHEETS["gilded.walk_up"]?.src === "/sprites/gilded_walk_up.png"
    && SHEETS["gilded.attack_down"]?.src === "/sprites/gilded_attack_down.png"
    && SHEETS["gilded.attack_up"]?.src === "/sprites/gilded_attack_up.png"
    && SHEETS["gilded.attack"]?.src === "/sprites/gilded_attack.png");
  check("gilded: NO side files are registered (side profile blocked)",
    SHEETS["gilded.walk_side"] === undefined && SHEETS["gilded.attack_side"] === undefined);
  check("the stationary Choir carries an idle loop + omni attack (no walk triplet)",
    SHEETS["choir.idle"]?.src === "/sprites/choir_idle.png"
    && SHEETS["choir.attack"]?.src === "/sprites/choir_attack.png"
    && SHEETS["choir.walk_down"] === undefined);

  section("bestiary-wave asset hooks: directional sets, mass contracts, decoy loops");
  // Full walk+attack contract for the mobile new kinds (+ the marshal miniboss).
  for (const [sprite, hasAttack] of [
    ["echojack", true], ["seamcutter", true], ["caskbellows", true],
    ["sinderling", true], ["marshal", true], ["rootward", true], ["mason", true],
  ] as Array<[string, boolean]>) {
    const walkOk = (["down", "up", "side"] as const).every(
      (f) => SHEETS[`${sprite}.walk_${f}`]?.src === `/sprites/${sprite}_walk_${f}.png`);
    const attackOk = (["down", "up", "side"] as const).every(
      (f) => (SHEETS[`${sprite}.attack_${f}`]?.src === `/sprites/${sprite}_attack_${f}.png`) === hasAttack);
    check(`${sprite}: directional hooks registered (${hasAttack ? "walk + attack" : "walk only — it has no attack"})`,
      walkOk && attackOk);
  }
  // The ecology gate made the rootward the FORKROOT BAILIFF: its directional attack
  // sheet is the divider RAISE (arms up, roots rising), never a swing.
  check("the bailiff's raise rides the directional attack hooks",
    SHEETS["rootward.attack_down"] !== undefined && SHEETS["rootward.attack_side"] !== undefined);
  check("the fragment and The Toll ride the drifting-mass contract (idle + omni attack)",
    SHEETS["fragment.idle"]?.src === "/sprites/fragment_idle.png"
    && SHEETS["fragment.attack"]?.src === "/sprites/fragment_attack.png"
    && SHEETS["toll.idle"]?.src === "/sprites/toll_idle.png"
    && SHEETS["toll.attack"]?.src === "/sprites/toll_attack.png"
    && SHEETS["fragment.walk_down"] === undefined && SHEETS["toll.walk_down"] === undefined);
  check("the decoys carry idle-loop hooks only (echo/knell)",
    SHEETS["echo.idle"]?.src === "/sprites/echo_idle.png"
    && SHEETS["knell.idle"]?.src === "/sprites/knell_idle.png"
    && SHEETS["echo.walk_down"] === undefined && SHEETS["knell.attack"] === undefined);

  section("legacy roster directional hooks: drop-in ready, current art preserved");
  for (const sprite of ["slime", "bat", "skeleton", "ghost", "spitter"]) {
    check(`${sprite}: directional walk hooks registered off its own stem`,
      (["down", "up", "side"] as const).every(
        (f) => SHEETS[`${sprite}.walk_${f}`]?.src === `/sprites/${sprite}_walk_${f}.png`));
  }
  check("the legacy single-strip walks REMAIN registered (the ladder holds today's look until new sheets load)",
    SHEETS["slime.walk"]?.src === "/sprites/slime_walk.png"
    && SHEETS["skeleton.walk"]?.src === "/sprites/skeleton_walk.png"
    && SHEETS["bat.walk"]?.src === "/sprites/bat_walk.png"
    && SHEETS["ghost.walk"]?.src === "/sprites/ghost_walk.png");
  {
    // The stationary-boss ladder: a drifting Choir with only an idle sheet keeps
    // breathing while it moves instead of dropping to the static base.
    const has = (clip: SelectableClip) => clip === "idle" || clip === "attack";
    const drifting = resolveClip(has, poseOf({ isMoving: true, facing: "down" }));
    check("a moving body with idle-only art keeps its idle loop", drifting.clip === "idle");
    const attacking = resolveClip(has, poseOf({ isAttacking: true, facing: "up" }));
    check("its omni attack sheet still wins while attacking", attacking.clip === "attack");
  }

  section("approved asset hooks: weapon pairs + fx masks");
  check("the Thumper pickup hook expects weapon_thumper.png",
    devSpriteManifest().some((a) => a.group === "weapon pickups" && a.label === "pickup mortar" && a.src === "/sprites/weapon_thumper.png"));
  check("the Thumper held hook expects held_thumper.png",
    devSpriteManifest().some((a) => a.group === "held weapons" && a.label === "held mortar" && a.src === "/sprites/held_thumper.png"));
  check("the Beam pickup hook expects beam2_px.png",
    devSpriteManifest().some((a) => a.group === "weapon pickups" && a.label === "pickup beam" && a.src === "/sprites/beam2_px.png"));
  check("the Beam held hook expects held_beam2_px.png",
    devSpriteManifest().some((a) => a.group === "held weapons" && a.label === "held beam" && a.src === "/sprites/held_beam2_px.png"));
  check("the beam's dedicated ray is a registered code-tinted white mask (beam_ray)",
    devSpriteManifest().some((a) => a.group === "bullet fx" && a.label === "beam_ray" && a.src === "/sprites/fx/beam_ray.png"));
  // Cut content stays honest: nothing registered for removed weapons (the boomerang).
  // (The old cut "vortex" concept was re-authored as the Lodestone legendary, which
  // registers real hooks below.)
  check("no hooks exist for cut weapons (boomerang removed at the gate)",
    !devSpriteManifest().some((a) => a.label.includes("boomerang")));
  // The legendary wave's FAL hooks: pickup + held pairs for all five, exact drop-in
  // filenames (art generated separately; the fallback ladder covers until each lands).
  const legendaryHooks: Array<[string, string]> = [
    ["reaper", "reaper"], ["swarm", "hive"], ["midas", "midas"], ["phase", "umbra"], ["vortex", "lodestone"],
  ];
  check("every legendary registers its pickup + held hooks (FAL drop-in filenames)",
    legendaryHooks.every(([id, art]) =>
      devSpriteManifest().some((a) => a.group === "weapon pickups" && a.label === `pickup ${id}` && a.src === `/sprites/weapon_${art}.png`)
      && devSpriteManifest().some((a) => a.group === "held weapons" && a.label === `held ${id}` && a.src === `/sprites/held_${art}.png`)));
}

function main(): void {
  facingTests();
  poseTests();
  ladderTests();
  moveSheetTests();
  approvedHookTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nThe art/render facing contract holds.\n");
}

main();
