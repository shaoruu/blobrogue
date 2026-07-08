// Injectable time source. The tick loop needs a MONOTONIC clock (immune to wall-clock jumps)
// for drift correction; lifecycle/heartbeat/RTT stamps use WALL time. Injecting a Clock keeps
// the server deterministically testable (a fake clock can drive the loop) and removes hidden
// `Date.now()` / `performance.now()` calls scattered through the transport — one seam, not many.

import { performance } from "node:perf_hooks";

export interface Clock {
  now(): number;  // wall-clock ms (Date.now equivalent) — timestamps, RTT, heartbeat
  mono(): number; // monotonic ms (performance.now equivalent) — tick accumulator only
}

export const systemClock: Clock = {
  now: () => Date.now(),
  mono: () => performance.now(),
};
