// Companion-pet follow physics (client-render-only, out-of-sim). A pet is PURELY cosmetic:
// it never touches the authoritative world, the wire, or determinism. This module owns the
// felt "trotting companion" motion — a velocity that lags then scampers to keep up, a sit
// when it catches you, an axis-separated wall SLIDE (mirroring the sim's own moveCircle so a
// pet rounds corners with the player instead of clipping through), and a warp escape hatch
// when it falls way behind or wedges. Pure math + an injected wall predicate, no DOM, so the
// whole follow contract is unit-testable on its own (see test/petfollow.test.ts).

// The pet's lagged follow position and its trot velocity. All values are display-space
// render state — nothing here is ever read by the sim.
export interface PetFollow {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;     // 1 (right) or -1 (left); tracks travel while trotting, owner while sat
  isMoving: boolean;  // trotting (drives the RUN clip) vs settled (drives the IDLE clip)
  stuckT: number;     // seconds spent trying to move but making no progress -> warp escape
}

// Where the pet settles: just BEHIND the owner (opposite their horizontal facing) and a hair
// below, so a sat pet clears the ~52px blob and never blocks the player's aim or shots.
export const PET_REST_OFFSET = 40;
export const PET_REST_DROP = 6;

// Within this of the rest spot the pet SITS (a settle band, so it eases to a stop instead of
// rubber-banding onto the exact point).
export const PET_STOP_DIST = 14;
// How fast the trot velocity eases toward its target each second. Lower = more lag before it
// gets going (the scamper ramp); this is what makes it feel like a body with momentum rather
// than a rigid position lerp.
export const PET_FOLLOW_ACCEL = 10;
// Desired trot speed grows this many px/s per px the pet is behind its rest spot — a little
// lag close in, a real scamper when it has ground to make up.
export const PET_FOLLOW_GAIN = 9;
// Hard cap on the trot (px/s). Above the player's own top speed (270) so it can always close
// the gap, never so high it teleports.
export const PET_MAX_SPEED = 360;
// Fell WAY behind (a dash / teleport / floor change): scamper-warp to the rest spot.
export const PET_WARP_DIST = 380;
// The pet's collision radius. Smaller than the player's (18) so it fits anywhere the player
// fit — it can never wedge in a gap the owner just walked through.
export const PET_COLLIDE_RADIUS = 9;
// Trying to move but wedged (target across a wall, no slide progress) for this long -> warp.
export const PET_STUCK_TIME = 0.45;
// Trot speed (px/s) above which the pet reads as moving (RUN); below it, settled (IDLE).
export const PET_MOVE_EPS = 14;

export function createPetFollow(x: number, y: number, facing: number): PetFollow {
  return { x, y, vx: 0, vy: 0, facing, isMoving: false, stuckT: 0 };
}

// Advance one pet's follow toward (restX, restY) — the spot behind its owner — for dt
// seconds, resolving against walls via the injected `isWallAt` predicate. Returns true when
// the pet WARPED this step (so the caller can spawn the scamper puff). `isWallAt(x, y)` must
// report whether world point (x, y) lies in a solid tile (the same test the player uses).
export function stepPetFollow(
  p: PetFollow,
  restX: number,
  restY: number,
  ownerFacing: number,
  dt: number,
  isWallAt: (x: number, y: number) => boolean,
): boolean {
  if (dt <= 0) return false;
  const dx = restX - p.x;
  const dy = restY - p.y;
  const dist = Math.hypot(dx, dy);

  // Warp escape hatch: way behind (dash/teleport/floor change) OR wedged with no progress.
  // Never warp INTO a wall — if the rest spot itself is solid, keep pathing in on foot.
  if ((dist > PET_WARP_DIST || p.stuckT > PET_STUCK_TIME) && !isWallAt(restX, restY)) {
    p.x = restX;
    p.y = restY;
    p.vx = 0;
    p.vy = 0;
    p.stuckT = 0;
    p.isMoving = false;
    p.facing = ownerFacing;
    return true;
  }

  // Desired trot velocity: points at the rest spot, its speed scaling with how far behind the
  // pet is (lag close in, scamper when far), and zero inside the settle band so it coasts to
  // a sit rather than snapping onto the point.
  const desiredSpeed = dist > PET_STOP_DIST
    ? Math.min(PET_MAX_SPEED, PET_FOLLOW_GAIN * (dist - PET_STOP_DIST))
    : 0;
  const inv = dist > 1e-4 ? 1 / dist : 0;
  const targetVx = dx * inv * desiredSpeed;
  const targetVy = dy * inv * desiredSpeed;
  // Ease velocity toward that target (acceleration) — the lag-then-scamper feel a rigid lerp
  // can't give: the trot has to spin up and coast back down.
  const k = Math.min(1, dt * PET_FOLLOW_ACCEL);
  p.vx += (targetVx - p.vx) * k;
  p.vy += (targetVy - p.vy) * k;

  // Integrate against walls, axis-separated exactly like the sim's moveCircle: probe the
  // leading edge on each axis independently, so a blocked axis stalls while the free one keeps
  // sliding — the pet rounds a corner along the wall instead of clipping through it. A blocked
  // axis also drops that velocity component so it never builds pressure into the wall.
  const beforeX = p.x;
  const beforeY = p.y;
  const r = PET_COLLIDE_RADIUS;
  const mvx = p.vx * dt;
  const nx = p.x + mvx;
  if (!isWallAt(nx + Math.sign(mvx) * r, p.y)) p.x = nx;
  else p.vx = 0;
  const mvy = p.vy * dt;
  const ny = p.y + mvy;
  if (!isWallAt(p.x, ny + Math.sign(mvy) * r)) p.y = ny;
  else p.vy = 0;

  // Stuck accounting: it WANTS to move but barely displaced (wedged, not merely sliding) ->
  // ramp toward the warp escape; any real progress resets the timer.
  const moved = Math.hypot(p.x - beforeX, p.y - beforeY);
  if (desiredSpeed > 0 && moved < desiredSpeed * dt * 0.25) p.stuckT += dt;
  else p.stuckT = 0;

  const speed = Math.hypot(p.vx, p.vy);
  p.isMoving = speed > PET_MOVE_EPS;
  if (p.isMoving && Math.abs(p.vx) > PET_MOVE_EPS * 0.5) p.facing = p.vx >= 0 ? 1 : -1;
  else if (!p.isMoving) p.facing = ownerFacing;
  return false;
}
