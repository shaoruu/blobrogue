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

// The contract the game core uses to talk to a co-op session. The Convex-backed
// implementation lives in src/net; the game itself never imports Convex, so solo
// play works with zero network code in the graph.
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
