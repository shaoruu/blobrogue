// The five domain interfaces the spec names (§5). Each is small and single-purpose with a
// concrete adapter (stores/*, artifactVerifier.ts, gameServerAdmin.ts) and a fake test double.
// The deploy controller and HTTP layer depend on THESE, never on the adapters directly.

import type {
  AdminEffectResult,
  AuditRecord,
  GameServerStatus,
  LogQuery,
  LogRecord,
  MetricsSnapshot,
  OperationRecord,
  Readiness,
  GameServerWorldActionResult,
  Release,
  VerifyOutcome,
  VerifyResult,
  WorldSummary,
} from "./types.js";

// Immutable release catalog over the releases dir. Never edits a release in place; only the
// `current`/`staging` symlinks move.
export interface ReleaseStore {
  list(): Promise<Release[]>;
  get(releaseId: string): Promise<Release | null>;
  current(): Promise<Release | null>;
  staging(): Promise<Release | null>;
  switchCurrent(releaseId: string): Promise<void>; // atomic symlink swap
  switchStaging(releaseId: string): Promise<void>;
  prune(keep: number): Promise<string[]>; // returns pruned ids (never current/staging)
}

// Durable operation records that survive process restart / admin reconnect.
export interface OperationStore {
  create(op: OperationRecord): Promise<void>;
  update(op: OperationRecord): Promise<void>;
  get(id: string): Promise<OperationRecord | null>;
  list(limit: number): Promise<OperationRecord[]>;
  findNonTerminal(): Promise<OperationRecord[]>;
  findByIdempotencyKey(key: string): Promise<OperationRecord | null>;
}

// The game server as an admin subject: read its health/metrics/logs, and drive its lifecycle
// (drain/flush/resume/restart/verify) via the injected probe + pm2 port.
export interface GameServerAdmin {
  status(): Promise<GameServerStatus>;
  readiness(): Promise<Readiness>;
  metrics(): Promise<MetricsSnapshot>;
  worlds(): Promise<WorldSummary[]>;
  warpWorld(worldId: string, floor: number): Promise<GameServerWorldActionResult>;
  forceOpenWorldExit(worldId: string): Promise<GameServerWorldActionResult>;
  snapshotWorld(worldId: string): Promise<GameServerWorldActionResult>;
  restoreWorld(worldId: string): Promise<GameServerWorldActionResult>;
  logs(q: LogQuery): Promise<LogRecord[]>;
  drain(): Promise<AdminEffectResult>;
  flush(): Promise<AdminEffectResult>;
  resume(): Promise<AdminEffectResult>;
  restart(): Promise<void>; // reloads exactly blobrogue-gs
  verifyDiagnostic(): Promise<VerifyResult>;
  verifyForDeploy(): Promise<VerifyResult>;
}

// Verifies an on-box release: recomputes checksum, re-derives the releaseId, confirms gates.
export interface ArtifactVerifier {
  verify(releaseId: string): Promise<VerifyOutcome>;
}

// Append-only, immutable audit log of every mutating action.
export interface AuditSink {
  append(record: AuditRecord): Promise<void>;
  list(limit: number): Promise<AuditRecord[]>;
}
