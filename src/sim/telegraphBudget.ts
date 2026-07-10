// GATE 2 — the 4-player telegraph / effect-density controller
// (docs/blobrogue_WAVE1_FOUNDATIONS.md). Giants + mutators + four players' FX become unreadable
// soup without a budget; earned-window fairness is theoretical without it. This module is the
// framework: a pure, deterministic classifier + budget + overlap arbiter. Content (giants,
// mutators, elite affixes) plugs its sources in next build.
//
// Two halves:
//  - CLASSIFY + BUDGET (planBudget): a per-frame budget with a fixed PRIORITY ORDER. The HARD
//    RULE — fairness cues (anything that tells the player about incoming damage) are EXEMPT from
//    culling; ONLY ambient/cosmetic FX get culled. Reserved visual REGISTERS keep enemy tells,
//    the four players' own weapon FX, and ambient cosmetics separate, so a teammate's effects can
//    never occupy the enemy-tell register and mask an incoming attack. This half is pure and is
//    consumed client-side for cosmetic culling (never touches the sim, never desyncs).
//  - ARBITRATE (arbitrateLethalWindups): two LETHAL windups never resolve on the same tile within
//    LETHAL_WINDOW_S. Colliding windups are staggered (delayed) or relocated DETERMINISTICALLY,
//    seeded off (worldSeed, floorIndex) so the arbitration is authoritative and identical on every
//    client. This generalizes the sim's existing release arbiter (world.ts recentReleases) into a
//    documented, tested controller.

import type { AttackMove, AttackPhase } from "./types.js";
import { Rng } from "./rng.js";

// ---- priority order (highest survives budget pressure) ----
export const TelegraphPriority = {
  ambient: 0,
  hazardMutator: 1,
  eliteAffix: 2,
  giantPhase: 3,
  bossWindup: 4,
} as const;
export type TelegraphPriorityId = (typeof TelegraphPriority)[keyof typeof TelegraphPriority];

// ---- reserved visual registers ----
// enemyTell   — incoming-damage tells (boss/giant/elite/enemy telegraphs). Never shared.
// playerWeapon— the four players' own weapon FX. Kept out of the enemyTell register so it can
//               never mask an incoming attack; never culled (a player must see their own feedback).
// ambient     — cosmetic FX (motes, dust, decals). The ONLY register the budget culls.
export const VisualRegister = {
  enemyTell: "enemyTell",
  playerWeapon: "playerWeapon",
  ambient: "ambient",
} as const;
export type VisualRegisterId = (typeof VisualRegister)[keyof typeof VisualRegister];

export interface TelegraphSource {
  id: number | string;
  priority: TelegraphPriorityId;
  register: VisualRegisterId;
  // A fairness cue tells the player about INCOMING DAMAGE — EXEMPT from culling under any budget.
  isFairnessCue: boolean;
  cost: number; // budget units this source consumes (default 1)
}

// The one place culling is legal: a cosmetic ambient source that is NOT a fairness cue. Everything
// else (fairness cues, the players' own weapon FX) always renders.
function isCullable(s: TelegraphSource): boolean {
  return !s.isFairnessCue && s.register === VisualRegister.ambient;
}

export interface BudgetPlan {
  rendered: TelegraphSource[];
  culled: TelegraphSource[];
}

// Keep every non-cullable source (all fairness cues + the players' weapon FX) unconditionally,
// then fill the remaining budget with cullable ambient by descending priority (stable within a
// priority so the choice is deterministic), culling the overflow. Pure — the same inputs always
// yield the same plan on every client.
export function planBudget(sources: readonly TelegraphSource[], budget: number): BudgetPlan {
  const rendered: TelegraphSource[] = [];
  const cullable: TelegraphSource[] = [];
  let usedByProtected = 0;
  for (const s of sources) {
    if (isCullable(s)) cullable.push(s);
    else {
      rendered.push(s);
      usedByProtected += s.cost;
    }
  }
  // Stable descending-priority order over the cullable ambient set (index breaks ties).
  const ordered = cullable
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.priority - a.s.priority || a.i - b.i);
  let remaining = Math.max(0, budget - usedByProtected);
  const culled: TelegraphSource[] = [];
  for (const { s } of ordered) {
    if (s.cost <= remaining) {
      rendered.push(s);
      remaining -= s.cost;
    } else {
      culled.push(s);
    }
  }
  return { rendered, culled };
}

// ---- classification: an enemy telegraph -> a budget source ----
// The minimal shape a telegraph source needs; the client fills it from the authoritative enemy
// snapshot (kind/tier/attack), keeping this module decoupled + headlessly testable.
export interface TelegraphClassInput {
  id: number;
  phase: AttackPhase;
  move: AttackMove;
  isBoss: boolean;
  isGiantPhaseCue?: boolean; // a giant's phase-transition cue (content next build)
  isElite?: boolean;
  isHazardOrMutator?: boolean;
}

// Every incoming-damage telegraph is a fairness cue in the enemyTell register (EXEMPT). Its
// priority tiers by source so the (future) ambient budget yields to the deadliest tells first.
export function classifyTelegraph(t: TelegraphClassInput): TelegraphSource {
  let priority: TelegraphPriorityId = TelegraphPriority.hazardMutator;
  if (t.isBoss) priority = TelegraphPriority.bossWindup;
  else if (t.isGiantPhaseCue) priority = TelegraphPriority.giantPhase;
  else if (t.isElite) priority = TelegraphPriority.eliteAffix;
  else if (t.isHazardOrMutator) priority = TelegraphPriority.hazardMutator;
  return {
    id: t.id,
    priority,
    register: VisualRegister.enemyTell,
    isFairnessCue: true, // a windup/active tell always warns of incoming damage
    cost: 1,
  };
}

// A cosmetic ambient source (biome motes, dust, decals): the only thing the budget may cull.
export function ambientSource(id: number | string, cost = 1): TelegraphSource {
  return { id, priority: TelegraphPriority.ambient, register: VisualRegister.ambient, isFairnessCue: false, cost };
}

// A player's own weapon FX: kept out of the enemyTell register (never masks a tell), never culled.
export function playerWeaponSource(id: number | string, cost = 1): TelegraphSource {
  return { id, priority: TelegraphPriority.ambient, register: VisualRegister.playerWeapon, isFairnessCue: false, cost };
}

// ---- overlap arbitration: no two LETHAL windups same-tile within ~0.3s ----
export const LETHAL_WINDOW_S = 0.3;
// The deepest a windup may be deferred before we relocate it instead (staggering forever would
// hold a telegraph up indefinitely — at most one window of stagger, then move).
const MAX_STAGGER_S = LETHAL_WINDOW_S;

export interface LethalWindup {
  id: number;
  tileX: number;
  tileY: number;
  resolveAt: number; // seconds until this windup resolves into its damage release
}

export type ArbitrationAction = "keep" | "stagger" | "relocate";

export interface ArbitratedWindup {
  id: number;
  tileX: number;
  tileY: number;
  resolveAt: number;
  action: ArbitrationAction;
}

function conflicts(a: { tileX: number; tileY: number; resolveAt: number }, b: { tileX: number; tileY: number; resolveAt: number }): boolean {
  return a.tileX === b.tileX && a.tileY === b.tileY && Math.abs(a.resolveAt - b.resolveAt) < LETHAL_WINDOW_S;
}

// The eight adjacent tiles, in a fixed order; a relocation walks them until a free slot is found.
const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1],
];

// Resolve so no two lethal windups share a tile within LETHAL_WINDOW_S. Deterministic + seeded off
// (worldSeed, floorIndex): windups are swept in a canonical order (resolveAt, tile, id); each is
// either kept, staggered past the latest conflicting resolve (up to MAX_STAGGER_S), or — if a
// stagger would exceed that — relocated to a seeded adjacent tile clear of committed windups. Same
// inputs + seed => identical result on every client, so the moved/staggered windup is authoritative.
export function arbitrateLethalWindups(windups: readonly LethalWindup[], worldSeed: number, floorIndex: number): ArbitratedWindup[] {
  const order = windups
    .map((w) => ({ ...w }))
    .sort((a, b) => a.resolveAt - b.resolveAt || a.tileX - b.tileX || a.tileY - b.tileY || a.id - b.id);
  // Seed a dedicated arbitration stream (integer mix; not a floor-generation roll, so it is not
  // part of the roll-order contract — but still a pure function of seed+floor+the windup set).
  const rng = new Rng((Math.imul(worldSeed | 0, 0x9e3779b9) ^ Math.imul(floorIndex | 0, 0x85ebca6b) ^ order.length) | 0);
  const committed: Array<{ tileX: number; tileY: number; resolveAt: number }> = [];
  const out: ArbitratedWindup[] = [];

  for (const w of order) {
    let action: ArbitrationAction = "keep";
    // First try to stagger past every committed windup that shares this tile inside the window.
    let resolveAt = w.resolveAt;
    for (const c of committed) {
      if (c.tileX === w.tileX && c.tileY === w.tileY && resolveAt < c.resolveAt + LETHAL_WINDOW_S) {
        resolveAt = c.resolveAt + LETHAL_WINDOW_S;
        action = "stagger";
      }
    }
    let tileX = w.tileX;
    let tileY = w.tileY;
    // If the stagger overshoots the cap, relocate instead: keep the original resolveAt, walk the
    // neighbours (from a seeded rotation) to the first tile clear of committed windups in-window.
    if (resolveAt - w.resolveAt > MAX_STAGGER_S) {
      resolveAt = w.resolveAt;
      action = "relocate";
      const start = rng.int(0, NEIGHBORS.length - 1);
      for (let n = 0; n < NEIGHBORS.length; n++) {
        const [dx, dy] = NEIGHBORS[(start + n) % NEIGHBORS.length];
        const cx = w.tileX + dx;
        const cy = w.tileY + dy;
        if (!committed.some((c) => c.tileX === cx && c.tileY === cy && Math.abs(resolveAt - c.resolveAt) < LETHAL_WINDOW_S)) {
          tileX = cx;
          tileY = cy;
          break;
        }
      }
    }
    committed.push({ tileX, tileY, resolveAt });
    out.push({ id: w.id, tileX, tileY, resolveAt, action });
  }
  return out;
}

// Verify a set of windups is fair: no two lethal windups resolve on the same tile within the
// window. Exported so the sim + tests can assert the invariant on any arbitrated set.
export function hasLethalOverlap(windups: readonly { tileX: number; tileY: number; resolveAt: number }[]): boolean {
  for (let i = 0; i < windups.length; i++) {
    for (let j = i + 1; j < windups.length; j++) {
      if (conflicts(windups[i], windups[j])) return true;
    }
  }
  return false;
}
