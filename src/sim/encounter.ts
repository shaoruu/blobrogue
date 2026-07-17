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
    flags: {
      // PALE F75 THE LAST LIGHT FALLS — sim-internal reconnect/spectate bag (AttackWire carries mv/ph).
      lastLightPhase: "idle",      // idle | tell | scars | fall | punish
      lastLightOutcome: "idle",    // idle | pending | success | survival | failure
      lastLightScarIndex: 0,       // next/active scar 0..2 (3 = complete)
      lastLightScarId: -1,         // live highlighted scar enemy id
      lastLightRelit: 0,           // scars successfully relit this cast (0..3)
    },
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
// flags (OWNER LOCK): escapeMeter, supportsCut, interceptState, chosenExitEdgeId, worldsplitPhase
export function initHuntEncounter(dungeon: Dungeon): EncounterState {
  const bp = dungeon.blueprint;
  const spawnRoomId = bp?.spawnRoomId ?? (dungeon.rooms.length > 1 ? 1 : 0);
  const routeEdgeId = bp && bp.chaseEdgeIds.length > 0 ? bp.chaseEdgeIds[0] : (dungeon.edges.length > 0 ? 0 : null);
  return {
    kind: "hunt",
    // Inactive until a player enters the approach / pressure radius — no global aggro
    // before encounter activation (Batch1 OWNER LOCK).
    active: false,
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
      interceptState: "hunt", // hunt | trap | exposed | escaped
      chosenExitEdgeId: routeEdgeId ?? -1,
      worldsplitPhase: "idle", // idle | plant | fracture | punish
      worldsplitOutcome: "idle", // idle | pending | success | survival | failure
      worldsplitToothId: -1, // dedicated WORLDSPLIT tooth (≠ intercept windowAddIds)
      worldsplitToothBroken: false, // tooth died during plant/fracture
      anchorsPlantedCp: -1, // last checkpoint that received resin anchors
    },
  };
}

// Batch2A Choirmaster F60: split/silence encounter in ONE multi-lobed super-room.
// flags (OWNER LOCK): activePhrase, phraseIndex, livePillarId, silencedMask,
// sheetSpanIndex, lastNotePhase, lastNoteOutcome, acousticShadowPillarId
export function initSplitEncounter(dungeon: Dungeon): EncounterState {
  const bp = dungeon.blueprint;
  const spawnRoomId = bp?.spawnRoomId ?? (dungeon.rooms.length > 0 ? dungeon.rooms[dungeon.rooms.length - 1].id : 0);
  return {
    kind: "split",
    // Inactive until a player enters the super-room / pressure radius — no global aggro
    // before encounter activation (Batch2A OWNER LOCK).
    active: false,
    structureKind: "split",
    currentRoomId: spawnRoomId,
    routeEdgeId: null, // NOT a RoomEdge chase
    checkpoint: 0, // phrase index / silenced pillar count
    objectiveProgress: 0,
    carrierPlayerId: null,
    failureCount: 0,
    completed: false,
    failed: false,
    flags: {
      activePhrase: 0,
      phraseIndex: 0,
      livePillarId: -1,
      silencedMask: 0,
      sheetSpanIndex: 0,
      lastNotePhase: "idle", // idle | inhale | sheet | punish
      lastNoteOutcome: "idle", // idle | pending | success | survival | failure
      acousticShadowPillarId: -1,
      pillarsPlanted: false,
    },
  };
}


// Batch2B Undertow F65: escape/steal reverse-floor encounter on the Batch0 room graph.
// flags (OWNER LOCK): pulseRoomId / pulseDropped / pulseDepositVentId /
// floodFrontEdgeId / floodProgress / riverPhase / riverOutcome /
// ventsUsedMask / manifestCount / escapeDirection
export function initEscapeEncounter(dungeon: Dungeon): EncounterState {
  const bp = dungeon.blueprint;
  // Deep/final room = steal site; reverse journey runs spawnward along chaseEdgeIds.
  const spawnRoomId = bp?.spawnRoomId ?? (dungeon.rooms.length > 0 ? dungeon.rooms[dungeon.rooms.length - 1].id : 0);
  const routeEdgeId = bp && bp.chaseEdgeIds.length > 0 ? bp.chaseEdgeIds[0] : (dungeon.edges.length > 0 ? 0 : null);
  return {
    kind: "escape",
    // Inactive until Warm Pulse is stolen — no flood / manifestation before steal.
    active: false,
    structureKind: "escape",
    currentRoomId: spawnRoomId,
    routeEdgeId,
    checkpoint: 0, // 0 = deep steal room; advances spawnward along reverse route
    objectiveProgress: 0,
    carrierPlayerId: null,
    failureCount: 0,
    completed: false,
    failed: false,
    flags: {
      pulseRoomId: spawnRoomId,
      pulseDropped: false,
      pulseDepositVentId: -1,
      floodFrontEdgeId: routeEdgeId ?? -1,
      floodProgress: 0, // 0..1 along current edge/room
      riverPhase: "idle", // idle | tell | front | punish | pursuit
      riverOutcome: "idle", // idle | pending | success | survival | failure
      ventsUsedMask: 0,
      manifestCount: 0,
      escapeDirection: "spawnward",
      pulseStolen: false,
      alcoveRoomId: -1,
      highlightedVentId: -1,
    },
  };
}

// Batch3A Claimant F70: compact coordination arena (structureKind 'arena' — NOT a RoomEdge chase
// graph). Verb PASS-THE-CLAIM; signature ALL THINGS OWED. checkpoint = successful passes / socket
// deposits (0..3); objectiveProgress = pass/deposit progress; carrierPlayerId = claim-token carrier
// (null if socketed / dropped).
// flags (OWNER LOCK — serialize for reconnect/spectate): tokenSocketId / highlightedSocketId /
// passesCompleted / owedPhase / owedOutcome / aimLockedAt / lockFrac / tokenDropped / passCount.
export function initClaimantEncounter(dungeon: Dungeon): EncounterState {
  const bp = dungeon.blueprint;
  const spawnRoomId = bp?.spawnRoomId ?? (dungeon.rooms.length > 0 ? dungeon.rooms[dungeon.rooms.length - 1].id : 0);
  return {
    kind: "arena",
    // Inactive until a player enters the arena / pressure radius — no global aggro before
    // encounter activation (Batch3A OWNER LOCK).
    active: false,
    structureKind: "arena",
    currentRoomId: spawnRoomId,
    routeEdgeId: null, // NOT a RoomEdge chase — OWNER LOCK
    checkpoint: 0, // successful passes / socket deposits (0..3)
    objectiveProgress: 0,
    carrierPlayerId: null,
    failureCount: 0,
    completed: false,
    failed: false,
    flags: {
      tokenSocketId: -1,        // socket currently holding the token (-1 = carried / world)
      highlightedSocketId: -1,  // the ONE socket lit during the Owed cast (set only AFTER aim lock)
      passesCompleted: 0,       // 0..3 — mirrors checkpoint; three baits the overcommit
      passCount: 0,             // total correct passes / deposits this fight (monotonic)
      owedPhase: "idle",        // idle | tell | locked | descent | punish
      owedOutcome: "idle",      // idle | pending | success | survival | failure
      aimLockedAt: 0,           // seconds into the tell when aim locked (0 until locked; ~0.84)
      lockFrac: 0.6,            // fraction of the tell at which aim locks (0.6 × 1.4 = 0.84s)
      tokenDropped: false,      // token dropped to the arena floor (world-pickup)
      tokenPlanted: false,      // token + sockets seeded once on activation
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
