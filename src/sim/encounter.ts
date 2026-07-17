// Batch0 — Encounter architecture foundation (docs/playtest packet OWNER LOCK).
// Plain-data EncounterState on WorldState; NOT overloaded onto BossState.
// Custom completion can clear a floor without enemies.length===0 alone.
// 'arena' / null preserves Gorge F50 HP-death + endBossDanger unchanged.

import type { PlayerId } from "./input.js";
import type { Dungeon, EncounterStructureKind } from "./dungeon.js";

export type EncounterKind = "none" | EncounterStructureKind;

export interface EncounterState {
  kind: EncounterKind;
  active: boolean;
  structureKind: EncounterStructureKind | "none";
  currentRoomId: number;
  routeEdgeId: number | null; // index into dungeon.edges or null
  checkpoint: number;         // 0..N
  // 0..1 progress for arena; discrete counts for later kinds — document per kind.
  objectiveProgress: number;
  carrierPlayerId: PlayerId | null;
  failureCount: number;
  completed: boolean;
  failed: boolean; // soft failure / worsened route — not run wipe
  // kind-specific bag (plain JSON-serializable):
  flags: Record<string, number | string | boolean | null>;
}

export function createIdleEncounter(): EncounterState {
  return {
    kind: "none",
    active: false,
    structureKind: "none",
    currentRoomId: -1,
    routeEdgeId: null,
    checkpoint: 0,
    objectiveProgress: 0,
    carrierPlayerId: null,
    failureCount: 0,
    completed: false,
    failed: false,
    flags: {},
  };
}

// Clone for reconnect/replay fixtures — bit-identical plain data.
export function cloneEncounter(e: EncounterState): EncounterState {
  return {
    kind: e.kind,
    active: e.active,
    structureKind: e.structureKind,
    currentRoomId: e.currentRoomId,
    routeEdgeId: e.routeEdgeId,
    checkpoint: e.checkpoint,
    objectiveProgress: e.objectiveProgress,
    carrierPlayerId: e.carrierPlayerId,
    failureCount: e.failureCount,
    completed: e.completed,
    failed: e.failed,
    flags: { ...e.flags },
  };
}

export function encounterEqual(a: EncounterState | null, b: EncounterState | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Boss-floor 'arena' encounter: active, progress tracks living boss HP fraction inverse.
// Completion is NOT driven here for arena — Gorge HP-death + endBossDanger stay authoritative.
export function initArenaEncounter(dungeon: Dungeon): EncounterState {
  const bp = dungeon.blueprint;
  const spawnRoomId = bp?.spawnRoomId ?? (dungeon.rooms.length > 0 ? dungeon.rooms[dungeon.rooms.length - 1].id : 0);
  const routeEdgeId = bp && bp.chaseEdgeIds.length > 0 ? bp.chaseEdgeIds[0] : null;
  return {
    kind: "arena",
    active: true,
    structureKind: "arena",
    currentRoomId: spawnRoomId,
    routeEdgeId,
    checkpoint: 0,
    objectiveProgress: 0,
    carrierPlayerId: null,
    failureCount: 0,
    completed: false,
    failed: false,
    flags: {},
  };
}

// Dev/smoke fixture: a custom objective encounter that can complete WITHOUT clearing enemies.
export function initSmokeEncounter(dungeon: Dungeon): EncounterState {
  const start = dungeon.rooms[0]?.id ?? 0;
  return {
    kind: "hunt",
    active: true,
    structureKind: "hunt",
    currentRoomId: start,
    routeEdgeId: dungeon.edges.length > 0 ? 0 : null,
    checkpoint: 0,
    objectiveProgress: 0,
    carrierPlayerId: null,
    failureCount: 0,
    completed: false,
    failed: false,
    flags: { smoke: true, need: 1 },
  };
}


// Batch1 Sever F55: hunt/intercept encounter on the Batch0 room graph.
// flags (OWNER LOCK): escapeMeter, supportsCut, interceptState, chosenExitEdgeId, worldsplitPhase.
// trapAttacks counts WORLDSPLITs held at the current stand (drives the escape/failure path).
export function initHuntEncounter(dungeon: Dungeon): EncounterState {
  const bp = dungeon.blueprint;
  const spawnRoomId = bp?.spawnRoomId ?? (dungeon.rooms.length > 1 ? 1 : 0);
  const routeEdgeId = bp && bp.chaseEdgeIds.length > 0 ? bp.chaseEdgeIds[0] : (dungeon.edges.length > 0 ? 0 : null);
  return {
    kind: "hunt",
    active: true,
    structureKind: "hunt",
    currentRoomId: spawnRoomId,
    routeEdgeId,
    checkpoint: 0,
    objectiveProgress: 0,
    carrierPlayerId: null,
    failureCount: 0,
    completed: false,
    failed: false,
    flags: {
      escapeMeter: 0,
      supportsCut: 0,
      interceptState: "hunt", // hunt | trap | window | escaped
      chosenExitEdgeId: -1,   // set to the corridor fled through; -1 until it first flees
      worldsplitPhase: "idle", // idle | plant | fracture | punish
      trapAttacks: 0,
    },
  };
}

export function completeEncounter(e: EncounterState): void {
  e.completed = true;
  e.active = true;
  e.objectiveProgress = 1;
}

export function setEncounterCheckpoint(e: EncounterState, checkpoint: number, roomId: number): void {
  e.checkpoint = checkpoint;
  e.currentRoomId = roomId;
}

export function setEncounterCarrier(e: EncounterState, pid: PlayerId | null): void {
  e.carrierPlayerId = pid;
}

export function bumpEncounterProgress(e: EncounterState, amount: number): void {
  e.objectiveProgress = Math.max(0, Math.min(1, e.objectiveProgress + amount));
  if (e.objectiveProgress >= 1) completeEncounter(e);
}

// Whether the encounter path alone may open the exit (custom completion).
export function isEncounterObjectiveComplete(e: EncounterState | null): boolean {
  return e !== null && e.active && e.completed;
}
