// Deterministic boids for swarm-tier fliers (the cave-bat flocks): separation keeps the
// pack from collapsing into one stacked blob, cohesion keeps it reading as ONE animal,
// and a Kuramoto phase coupling synchronizes the members' wander clocks so the whole
// flock banks and weaves together. Alignment-by-heading is deliberately implicit — every
// member already steers at the same chase target, so coupling the wander phases is what
// actually produces the coordinated motion.
//
// Pure and allocation-free: a function of current positions only (no rng, no stored
// state beyond the enemy's own zig clock), so every client and the server compute the
// identical flock. Results are written into the shared `flockOut` scratch, mirroring
// FlowField.step.

import type { Enemy } from "./types.js";

export interface FlockParams {
  readonly neighborRadius: number;   // px within which another member counts as flock
  readonly separationRadius: number; // px under which members push apart
  readonly separationGain: number;   // strength of the push-apart force
  readonly cohesionGain: number;     // strength of the drift toward the flock centroid
  readonly maxSteer: number;         // rad: max deviation from the chase heading
  readonly syncGain: number;         // Kuramoto coupling on the wander clock (1/s)
}

export const BAT_FLOCK: FlockParams = {
  neighborRadius: 120,
  separationRadius: 44,
  separationGain: 1.5,
  cohesionGain: 0.35,
  maxSteer: 1.05,
  syncGain: 2.4,
};

// Scratch output (callers read immediately; never stored).
export const flockOut = { heading: 0, zigNudge: 0 };

// True when `other` flocks with `self`: same living archetype at the same tier.
function isFlockmate(self: Enemy, other: Enemy): boolean {
  return other !== self && !other.dead && other.kind === self.kind && other.tier === self.tier;
}

// Steer `self`'s chase heading by its flockmates and compute the wander-phase coupling.
// baseAngle is the already-resolved chase direction (flow field + wander); the flock can
// bend it by at most maxSteer, so the pack never forgets the hunt.
export function flockSteer(self: Enemy, all: readonly Enemy[], baseAngle: number, p: FlockParams): void {
  flockOut.heading = baseAngle;
  flockOut.zigNudge = 0;
  let sepX = 0, sepY = 0;
  let sumX = 0, sumY = 0;
  let sync = 0;
  let n = 0;
  const nr2 = p.neighborRadius * p.neighborRadius;
  for (const o of all) {
    if (!isFlockmate(self, o)) continue;
    const dx = self.x - o.x, dy = self.y - o.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > nr2) continue;
    n++;
    sumX += o.x;
    sumY += o.y;
    sync += Math.sin(o.zig - self.zig);
    if (d2 < p.separationRadius * p.separationRadius) {
      if (d2 < 1) {
        // Perfectly stacked (a pack spawn): push apart along a deterministic id-keyed
        // direction so the un-stack is reproducible everywhere.
        const a = (self.id - o.id) * 2.399963; // golden angle: spreads any stack evenly
        sepX += Math.cos(a);
        sepY += Math.sin(a);
      } else {
        const d = Math.sqrt(d2);
        const push = (p.separationRadius - d) / p.separationRadius;
        sepX += (dx / d) * push;
        sepY += (dy / d) * push;
      }
    }
  }
  if (n === 0) return;
  let vx = Math.cos(baseAngle) + sepX * p.separationGain;
  let vy = Math.sin(baseAngle) + sepY * p.separationGain;
  const cx = sumX / n - self.x, cy = sumY / n - self.y;
  const cd = Math.hypot(cx, cy);
  if (cd > p.separationRadius) {
    vx += (cx / cd) * p.cohesionGain;
    vy += (cy / cd) * p.cohesionGain;
  }
  let delta = Math.atan2(vy, vx) - baseAngle;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  if (delta > p.maxSteer) delta = p.maxSteer;
  else if (delta < -p.maxSteer) delta = -p.maxSteer;
  flockOut.heading = baseAngle + delta;
  flockOut.zigNudge = (sync / n) * p.syncGain;
}
