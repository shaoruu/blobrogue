// Content Wave B anti-degenerate metadata (Quill FINAL safety locks).
//
// `stackCategory` is the GD-canonical grouping used for the A+B combo audit and the
// same-category stacking cap. It is authored metadata (a label per content id) plus a set
// of REAL runtime clamps every Wave B secondary/proc system routes through:
//
//   - same-category cap 2  (at most two items of a category compound)
//   - proc rate ≤ 4 /s / player / target  (hard clamp; overflow discarded)
//   - sameTargetRepeat ≤ 0.35  (share of a system's DPS that may re-hit one body)
//
// Wave A ids carry the GD labels too (they were unlabelled at ship — see the FILL doc);
// this is the single place both waves are audited from.

import {
  WAVE_B_PROC_RATE_PER_SEC,
  WAVE_B_PROC_WINDOW,
} from "./constants.js";

export const SAME_CATEGORY_CAP = 2;

// One canonical stackCategory per content id (weapons + blessings), Wave A + Wave B.
export const STACK_CATEGORY: Readonly<Record<string, string>> = {
  // Wave A weapons
  mooring_nail: "position",
  sluicegate: "modeshift",
  oddsmaker: "gamble",
  pathmaker: "route",
  // Wave A blessings
  hold_fast: "stability",
  nothing_wasted: "reclaim",
  second_breath_muddy: "dash_refund",
  on_the_beat: "cadence",
  shared_rope: "revive",
  // Wave B weapons
  resonant_fork: "link",
  red_pen: "mark_detonate",
  margin_call: "reflect_passive",
  sidewinder: "flank_arc",
  // Wave B blessings
  crosscurrent: "chain_boost",
  last_warm_round: "cycle_finale",
  known_by_touch: "reveal",
  remember_me: "lethal_save",
  carry_the_light: "objective_support",
};

export function stackCategoryOf(id: string): string | undefined {
  return STACK_CATEGORY[id];
}

// A rolling per-(owner,target) proc window. Timestamps are world-seconds; anything older
// than the window is pruned. A proc is admitted only while fewer than the cap remain in
// the window — overflow is discarded (never queued), exactly as the safety lock states.
export interface ProcWindow {
  admit(key: string, nowSec: number): boolean;
  clear(): void;
}

export function createProcWindow(
  ratePerSec: number = WAVE_B_PROC_RATE_PER_SEC,
  windowSec: number = WAVE_B_PROC_WINDOW,
): ProcWindow {
  const hits = new Map<string, number[]>();
  return {
    admit(key: string, nowSec: number): boolean {
      const cutoff = nowSec - windowSec;
      const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);
      if (recent.length >= ratePerSec) {
        hits.set(key, recent);
        return false;
      }
      recent.push(nowSec);
      hits.set(key, recent);
      return true;
    },
    clear(): void {
      hits.clear();
    },
  };
}

export function procKey(ownerId: string | null, targetId: number, system: string): string {
  return `${ownerId ?? "-"}:${targetId}:${system}`;
}
