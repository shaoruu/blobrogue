// What the simulation EMITS each step (data only). The client replays each event into the
// exact existing FX body (particles/sound/trauma/...), so the juice is byte-identical
// — only the trigger path changed. The server (Stage B) ignores most of these.
//
// Design: mostly SEMANTIC events (one per FX cluster). A few generic atoms (flash/puff/
// trauma) mop up residual one-off effects. isNearCamera gating is a CLIENT concern applied
// in the handler; the sim emits unconditionally. Remote-player FX (revive/remote-shot/
// remote-hurt) are presence-driven CLIENT-only and are NOT SimEvents in Stage A.

import type { PlayerId } from "./input.js";
import type { WeaponId, EnemyKind, PickupKind, PropKind } from "./types.js";

export type SimEvent =
  // combat — player
  | { t: "shot"; pid: PlayerId; weapon: WeaponId; x: number; y: number; aim: number; px: number; py: number }
  | { t: "meleeSwing"; pid: PlayerId; weapon: WeaponId; x: number; y: number; aim: number; bx: number; by: number }
  // combat — enemy damage
  | { t: "enemyHit"; eid: number; dmgX: number; dmgY: number; dmg: number; crit: boolean; puffX: number; puffY: number; puffColor: string; melee: boolean; closeShotgun: boolean; killed: boolean }
  | { t: "thornsHit"; eid: number; x: number; y: number; radius: number; dmg: number; tint: string }
  | { t: "burnTick"; x: number; y: number; radius: number; dmg: number }
  | { t: "shockArc"; eid: number; x: number; y: number; tx: number; ty: number; tRadius: number; dmg: number; color: string; killed: boolean }
  | { t: "enemyKill"; eid: number; kind: EnemyKind; x: number; y: number; combo: number }
  | { t: "heal"; pid: PlayerId; x: number; y: number }
  // player movement / state
  | { t: "dashStart"; pid: PlayerId; x: number; y: number }
  | { t: "dashTrail"; pid: PlayerId; x: number; y: number }
  | { t: "playerHurt"; pid: PlayerId; x: number; y: number }
  | { t: "itemPicked"; pid: PlayerId; x: number; y: number; tint: string }
  | { t: "offerBlessing"; pid: PlayerId }
  | { t: "revive"; pid: PlayerId; by: PlayerId; x: number; y: number } // downed player brought back by a teammate
  // pickups / loot
  | { t: "pickup"; pid: PlayerId; kind: PickupKind; x: number; y: number }
  | { t: "lootDrop"; x: number; y: number; color: string }
  // bullets / world
  | { t: "bulletWall"; x: number; y: number; aim: number }
  | { t: "bulletBounce"; x: number; y: number; aim: number; color: string }
  | { t: "bulletExpire"; x: number; y: number; color: string }
  | { t: "propHit"; propId: number; kind: PropKind; x: number; y: number }
  | { t: "propBreak"; kind: PropKind; x: number; y: number }
  | { t: "explosion"; x: number; y: number; r: number }
  | { t: "chestOpen"; kind: string; x: number; y: number }
  // enemies / boss
  | { t: "spitMuzzle"; x: number; y: number }
  | { t: "lungeTrail"; x: number; y: number }
  | { t: "bossSlam"; x: number; y: number }
  | { t: "radialBurst"; x: number; y: number }
  | { t: "bossAddSpawn"; eid: number; x: number; y: number; mx: number; my: number; spawned: boolean }
  | { t: "bossPhase"; eid: number; x: number; y: number }
  // flow / run
  | { t: "descend"; toFloor: number }
  | { t: "reachExit"; toFloor: number } // co-op: client requests a shared-floor descend
  | { t: "gameOver"; pid: PlayerId }
  // generic atoms (residual one-off FX)
  | { t: "flash"; eid: number }
  | { t: "puff"; x: number; y: number; n: number; color: string }
  | { t: "trauma"; amount: number }
  // positional near-cam sound cue (+ optional near-cam trauma) for AI telegraph tells
  | { t: "cue"; name: string; x: number; y: number; rate: number; gain: number; trauma: number };
