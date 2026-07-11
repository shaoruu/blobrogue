// Companion-pet follow + animation game-feel suite (client-render-only, out-of-sim). Locks
// the pet game-feel pass:
//   1. WALL COLLISION — a pet stepped toward a target NEVER ends up inside a wall tile, and it
//      SLIDES along a wall / rounds a corner (axis-separated, mirroring the sim's moveCircle)
//      instead of clipping through.
//   2. WARP ESCAPE — it warps to the rest spot when it falls way behind, and when it wedges
//      with no progress (owner dashed through a gap) — but never warps INTO a wall.
//   3. FOLLOW FEEL — it scampers to close a big gap and coasts to a settled sit (no jitter).
//   4. FRAME-COUNT INFERENCE — sheet frame count is derived from width/height, never hardcoded
//      (a 4-frame idle and a 6-frame run both drop in with no code change).
// Pure math + an injected wall predicate, so nothing here touches the sim, the wire, or DOM.
// Run: tsx test/petfollow.test.ts
import {
  createPetFollow, stepPetFollow,
  PET_REST_OFFSET, PET_STOP_DIST, PET_WARP_DIST, PET_COLLIDE_RADIUS, PET_MOVE_EPS,
} from "../src/game/petFollow.js";
import { frameCount } from "../src/game/anim.js";
import { TILE } from "../src/sim/types.js";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// A tiny tile grid + the SAME solid-tile probe the player uses (game.ts isWallAt): out of
// bounds and any `1` tile is solid. `grid[ty][tx]`.
function makeIsWallAt(grid: number[][]): (x: number, y: number) => boolean {
  const h = grid.length, w = grid[0].length;
  return (x: number, y: number): boolean => {
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= w || ty >= h) return true;
    return grid[ty][tx] === 1;
  };
}

// ---- 1) WALL COLLISION: no-clip invariant over a long owner walk (with interior pillars) ----
{
  // 16x12 room, solid border, two interior pillars. Owner circles the open interior; the pet
  // follows every frame. The pet must never land inside a solid tile — at any step.
  const W = 16, H = 12;
  const grid: number[][] = [];
  for (let ty = 0; ty < H; ty++) {
    const row: number[] = [];
    for (let tx = 0; tx < W; tx++) {
      const border = tx === 0 || ty === 0 || tx === W - 1 || ty === H - 1;
      row.push(border ? 1 : 0);
    }
    grid.push(row);
  }
  grid[5][6] = 1; grid[5][7] = 1; // a horizontal pillar to slide around
  grid[8][10] = 1;                // a lone pillar
  const isWallAt = makeIsWallAt(grid);

  const cx = (W / 2) * TILE, cy = (H / 2) * TILE, rad = 2.2 * TILE;
  const pet = createPetFollow(cx, cy, 1);
  let everInWall = false;
  const dt = 1 / 60;
  for (let i = 0; i < 3000; i++) {
    const ang = i * 0.02;
    const ownerX = cx + Math.cos(ang) * rad;
    const ownerY = cy + Math.sin(ang) * rad;
    const ownerFacing = Math.cos(ang) >= 0 ? 1 : -1;
    const restX = ownerX - ownerFacing * PET_REST_OFFSET;
    const restY = ownerY + 6;
    stepPetFollow(pet, restX, restY, ownerFacing, dt, isWallAt);
    if (isWallAt(pet.x, pet.y)) everInWall = true;
  }
  check("pet is NEVER inside a wall tile across a long owner walk (no clip-through)", !everInWall);
}

// ---- 1b) WALL COLLISION: a wall directly between pet and target is NOT passed on foot ----
{
  // Vertical wall at column tx=6 (x in [288,336)); open either side. Pet sits left, target is
  // directly across on the right. On foot it can never cross the wall (it wedges); the invariant
  // is it never enters a solid tile while pushing against it.
  const W = 14, H = 10;
  const grid: number[][] = [];
  for (let ty = 0; ty < H; ty++) {
    const row: number[] = [];
    for (let tx = 0; tx < W; tx++) row.push(tx === 6 ? 1 : (tx === 0 || ty === 0 || tx === W - 1 || ty === H - 1 ? 1 : 0));
    grid.push(row);
  }
  const isWallAt = makeIsWallAt(grid);
  const pet = createPetFollow(3.5 * TILE, 5.5 * TILE, 1);
  const restX = 9.5 * TILE, restY = 5.5 * TILE; // straight across the wall
  let everInWall = false, maxX = pet.x;
  const dt = 1 / 60;
  // Step just up to the stuck-warp threshold so we observe the ON-FOOT behavior (no warp yet).
  for (let i = 0; i < 25; i++) {
    stepPetFollow(pet, restX, restY, 1, dt, isWallAt);
    if (isWallAt(pet.x, pet.y)) everInWall = true;
    maxX = Math.max(maxX, pet.x);
  }
  check("pet pushing straight into a wall never enters the solid tile", !everInWall);
  check("pet cannot walk THROUGH the wall on foot (stays left of it + its radius)", maxX < 6 * TILE - PET_COLLIDE_RADIUS + 0.5, `maxX=${maxX.toFixed(1)} wall@${6 * TILE}`);
}

// ---- 1c) WALL COLLISION: slides along a wall / rounds a corner (free axis makes progress) ----
{
  // Vertical wall at tx=6. Pet is left of the wall; target is UP and to the right. Blocked on X,
  // the pet must SLIDE up on the free Y axis toward the target's row (rounding toward the gap),
  // never freezing and never clipping.
  const W = 14, H = 12;
  const grid: number[][] = [];
  for (let ty = 0; ty < H; ty++) {
    const row: number[] = [];
    for (let tx = 0; tx < W; tx++) row.push(tx === 6 ? 1 : (tx === 0 || ty === 0 || tx === W - 1 || ty === H - 1 ? 1 : 0));
    grid.push(row);
  }
  const isWallAt = makeIsWallAt(grid);
  const pet = createPetFollow(4.5 * TILE, 8.5 * TILE, 1);
  const startY = pet.y;
  const restX = 9.5 * TILE, restY = 2.5 * TILE; // up + across
  let everInWall = false;
  const dt = 1 / 60;
  for (let i = 0; i < 20; i++) {
    stepPetFollow(pet, restX, restY, 1, dt, isWallAt);
    if (isWallAt(pet.x, pet.y)) everInWall = true;
  }
  check("pet slides along the wall (Y makes progress toward the target while X is blocked)", pet.y < startY - TILE && !everInWall, `dy=${(pet.y - startY).toFixed(1)}`);
}

// ---- 2) WARP ESCAPE: falls way behind -> warps to the rest spot (returns true) ----
{
  const isWallAt = () => false; // open field
  const pet = createPetFollow(0, 0, 1);
  const restX = PET_WARP_DIST + 200, restY = 0; // way out of reach
  const didWarp = stepPetFollow(pet, restX, restY, 1, 1 / 60, isWallAt);
  check("pet warps when it falls beyond the warp distance", didWarp);
  check("warp snaps it onto the (standable) rest spot", Math.hypot(pet.x - restX, pet.y - restY) < 0.001);
}

// ---- 2b) WARP ESCAPE: wedged against a wall with no progress eventually warps (escape hatch) ----
{
  const W = 14, H = 10;
  const grid: number[][] = [];
  for (let ty = 0; ty < H; ty++) {
    const row: number[] = [];
    for (let tx = 0; tx < W; tx++) row.push(tx === 6 ? 1 : (tx === 0 || ty === 0 || tx === W - 1 || ty === H - 1 ? 1 : 0));
    grid.push(row);
  }
  const isWallAt = makeIsWallAt(grid);
  const pet = createPetFollow(3.5 * TILE, 5.5 * TILE, 1);
  const restX = 9.5 * TILE, restY = 5.5 * TILE; // open floor across the wall
  let warped = false;
  const dt = 1 / 60;
  for (let i = 0; i < 120 && !warped; i++) warped = stepPetFollow(pet, restX, restY, 1, dt, isWallAt);
  check("a wedged pet warps to the far-side rest spot (owner-dashed-through-a-gap escape)", warped);
  check("the wedge-warp lands on standable floor, not inside the wall", !isWallAt(pet.x, pet.y));
}

// ---- 2c) WARP ESCAPE: never warps INTO a wall (rest spot itself solid -> stays out) ----
{
  const W = 14, H = 10;
  const grid: number[][] = [];
  for (let ty = 0; ty < H; ty++) {
    const row: number[] = [];
    for (let tx = 0; tx < W; tx++) row.push(tx === 0 || ty === 0 || tx === W - 1 || ty === H - 1 ? 1 : 0);
    grid.push(row);
  }
  grid[5][9] = 1; // the rest tile is SOLID
  const isWallAt = makeIsWallAt(grid);
  const pet = createPetFollow(3.5 * TILE, 5.5 * TILE, 1);
  const restX = 9.5 * TILE, restY = 5.5 * TILE; // inside the solid tile
  let everInWall = false;
  const dt = 1 / 60;
  for (let i = 0; i < 200; i++) {
    stepPetFollow(pet, restX, restY, 1, dt, isWallAt);
    if (isWallAt(pet.x, pet.y)) everInWall = true;
  }
  check("pet never warps into a solid rest tile (stays on floor)", !everInWall);
}

// ---- 3) FOLLOW FEEL: scampers to close a gap, then coasts to a settled sit ----
{
  const isWallAt = () => false;
  const pet = createPetFollow(0, 0, 1);
  const restX = 260, restY = 0; // well beyond the stop band
  const dt = 1 / 60;
  // Early: the trot has to spin up (a little lag before it reaches speed).
  stepPetFollow(pet, restX, restY, 1, dt, isWallAt);
  const speedAfterOne = Math.hypot(pet.vx, pet.vy);
  for (let i = 0; i < 6; i++) stepPetFollow(pet, restX, restY, 1, dt, isWallAt);
  const speedAfterSeven = Math.hypot(pet.vx, pet.vy);
  check("the trot accelerates (scamper ramps up, not an instant rigid lerp)", speedAfterSeven > speedAfterOne, `${speedAfterOne.toFixed(0)} -> ${speedAfterSeven.toFixed(0)} px/s`);
  check("a moving pet reads as trotting (RUN state)", pet.isMoving);
  // Let it run to the rest spot with the owner now standing still.
  for (let i = 0; i < 600; i++) stepPetFollow(pet, restX, restY, 1, dt, isWallAt);
  check("pet catches up close to the rest spot", Math.abs(pet.x - restX) <= PET_STOP_DIST + 2, `x=${pet.x.toFixed(1)} rest=${restX}`);
  check("pet settles to a sit (IDLE state, no rubber-band jitter)", !pet.isMoving && Math.hypot(pet.vx, pet.vy) < PET_MOVE_EPS);
}

// ---- 3b) FOLLOW FEEL: keeps pace with a running owner without falling off ----
{
  const isWallAt = () => false;
  const pet = createPetFollow(0, 0, 1);
  const dt = 1 / 60;
  let ownerX = 0;
  const ownerSpeed = 200; // the player's base move speed (balance.ts PLAYER.moveSpeed)
  for (let i = 0; i < 600; i++) {
    ownerX += ownerSpeed * dt;
    stepPetFollow(pet, ownerX - PET_REST_OFFSET, 6, 1, dt, isWallAt);
  }
  const trail = ownerX - pet.x; // how far behind the owner the pet is at steady state
  check("pet keeps pace with a running owner (bounded trailing distance, never left behind)", trail > 0 && trail < PET_WARP_DIST * 0.5, `trail=${trail.toFixed(0)}px`);
  check("pet never fell far enough to warp while just keeping pace", trail < PET_WARP_DIST);
}

// ---- 4) FRAME-COUNT INFERENCE (drives the drawChar frame picker; never hardcoded) ----
{
  check("4-frame 256x64 idle strip -> 4 frames", frameCount(256, 64) === 4);
  check("6-frame 384x64 run strip -> 6 frames", frameCount(384, 64) === 6);
  check("single 64x64 static -> 1 frame", frameCount(64, 64) === 1);
  check("non-64 tall strip infers from height (192x48 -> 4)", frameCount(192, 48) === 4);
  check("absent height (not decoded) falls back to a 64px frame, never divide-by-zero", frameCount(256, 0) === 4);
  check("frame count is always at least 1 (a 0-width sheet never yields 0)", frameCount(0, 64) === 1);
}

console.log(`\n${pass} checks passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log("Companion-pet follow + animation game-feel contract holds.");
