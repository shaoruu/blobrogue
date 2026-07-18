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
  // The "ult requested" intent (Q). Optional so pre-existing callers stay valid; absent reads
  // as released. The client can only REQUEST — the authoritative sim validates charge + the 8s
  // lockout and resolves the effect (spec §7). Inert for a neutral-kit player.
  ult?: boolean;
  // The MENDER heal-pulse intent (Wave 2). Optional so pre-existing callers stay valid; absent
  // reads as released. Like `ult`, the client can only REQUEST — the authoritative sim validates
  // the pulse cooldown + resolves the directed heal. Inert for every non-Mender kit.
  pulse?: boolean;
  // The PET ABILITY force-cast intent. Pets AUTO-cast (server-owned smart AI) with no player bind,
  // so a live client always sends this false; it survives only as an optional DEBUG force-cast the
  // authoritative sim honors under the same rails as auto-cast. Inert without an ability pet.
  petAbility?: boolean;
}

export const IDLE_INPUT: InputCmd = { seq: 0, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };
