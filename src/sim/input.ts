// What a player intends this tick. The client builds one per frame from keys/mouse/
// settings (autofire + dash resolution stay client-side); stepWorld reads these instead
// of the DOM. Plain data so it can later ride the wire for an authoritative server.

export type PlayerId = string;

// Stage A runs a single local player; this is its id in the world's players map.
export const LOCAL_ID: PlayerId = "local";

export interface InputCmd {
  seq: number;        // client input sequence (reconciliation later; unused in solo)
  moveX: number;      // -1..1 raw axis (stepWorld normalizes, matching the old updatePlayer)
  moveY: number;      // -1..1 raw axis
  aim: number;        // radians, world-space (client computes from mouse+camera)
  firing: boolean;    // resolved autofire/hold state
  dash: boolean;      // shift held (stepWorld still gates on cooldown + movement)
  // Interact key held (E) — the explicit revive-channel intent. Optional so pre-existing
  // callers (tests/harness scripts) stay valid; absent reads as released. Solo has nothing
  // to interact with, so the bit is inert there.
  interact?: boolean;
}

export const IDLE_INPUT: InputCmd = { seq: 0, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };
