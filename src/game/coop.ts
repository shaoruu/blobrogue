import type { RemotePlayer, WeaponId } from "../sim/types.js";

// Snapshot of the local player that gets broadcast to teammates each tick.
export interface LocalPlayerState {
  x: number; y: number;
  facing: number;
  hp: number; maxHp: number;
  weapon: WeaponId;
  floor: number;
  isDown: boolean;
  aimAngle: number;
  shotSeq: number;
  kills: number;
}

// The contract the game core uses to talk to a peer-synced co-op session. NO product
// implementation exists anymore: the Convex-backed classic co-op client was removed after
// the Sev-0 room divergence (each client simulated its own enemies/drops while players
// believed they shared a world) — PLAY ONLINE (authoritative server) is the one multiplayer
// path. The seam stays only for tests/dev tooling; nothing reachable from the menu can
// construct a bridge.
export interface CoopBridge {
  readonly selfId: string;
  readonly roomCode: string;
  getSeed(): number;
  // Authoritative shared floor for the room (everyone descends together).
  getFloor(): number;
  requestDescend(nextFloor: number): void;
  publish(state: LocalPlayerState): void;
  remotePlayers(): RemotePlayer[];
  selfColorIndex(): number;
  requestRevive(targetId: string): void;
  // Returns the HP to restore if a teammate revived us since the last check.
  consumeRevive(): number | null;
  leave(): void;
}
