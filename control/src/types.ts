// Domain types for the control plane. Plain data only — no host handles, no functions. These
// are the shapes that flow across the API, into the durable stores, and through the deploy
// state machine. Everything the admin panel sees is one of these.

// ---- releases ----

// The three required build gates. Only "pass" is accepted at PREFLIGHT; "fail"/"skip" reject.
export type GateResult = "pass" | "fail" | "skip";

export interface ReleaseGates {
  typecheck: GateResult;
  unitTests: GateResult;
  goldens: GateResult;
}

// Produced by the build pipeline and shipped INSIDE the artifact. The control service treats
// this as untrusted until ArtifactVerifier recomputes the checksum and re-derives the releaseId.
export interface ReleaseManifest {
  releaseId: string;
  version: string;
  commit: string;
  builtAt: string; // ISO-8601
  checksum: string; // sha256 hex of the packaged tree (see checksum.ts)
  gates: ReleaseGates;
  files: string[]; // packaged relpaths (server + client + control), sorted
}

export interface Release {
  releaseId: string;
  manifest: ReleaseManifest;
  isCurrent: boolean;
  isStaging: boolean;
  isRetained: boolean;
}

export interface VerifiedRelease {
  releaseId: string;
  manifest: ReleaseManifest;
}

export type VerifyOutcome =
  | { ok: true; release: VerifiedRelease }
  | { ok: false; reason: string };

// ---- operations (durable) ----

export type OperationKind = "deploy" | "deploy_preview" | "restart" | "rollback";

// The deploy state machine plus terminal/exceptional states.
export type OperationState =
  | "preflight"
  | "drain"
  | "flush"
  | "switch"
  | "pm2_reload"
  | "verify"
  | "resume"
  | "done"
  | "failed"
  | "rolled_back"
  | "interrupted";

export type OperationResult = "pending" | "success" | "failure" | "rolled_back";

export interface OperationTransition {
  state: OperationState;
  at: string; // ISO-8601
  note: string | null;
}

export interface OperationRecord {
  id: string;
  kind: OperationKind;
  state: OperationState;
  result: OperationResult;
  releaseId: string | null;
  prevReleaseId: string | null;
  actor: string;
  requestId: string;
  idempotencyKey: string | null;
  tokenJti: string | null;
  confirmJti: string | null;
  transitions: OperationTransition[];
  error: string | null;
  startedAt: string;
  updatedAt: string;
}

// ---- audit (append-only, immutable) ----

export interface AuditRecord {
  at: string; // ISO-8601
  actor: string;
  action: string;
  releaseId: string | null;
  prevReleaseId: string | null;
  requestId: string;
  operationId: string | null;
  tokenJti: string | null;
  confirmJti: string | null;
  result: string;
  detail: string | null;
}

// ---- game-server views (read-only, redacted) ----

export interface GameServerStatus {
  status: string;
  uptimeSec: number;
  worlds: number;
  players: number;
  connections: number;
  tickMs_p50: number;
  tickMs_p95: number;
  tickMs_max: number;
}

export interface Readiness {
  live: boolean;
  ready: boolean;
  detail: string | null;
}

export interface WorldSummary {
  id: string;
  players: number;
  tick: number;
  // Who is actually connected to this world (display names) — the ops answer to "did the
  // whole room land in ONE world?" during a multiplayer incident.
  names: string[];
  // Whose seats are reserved for a reconnect (mid-outage) — the ops answer to "who is
  // currently dropped and inside their grace window?".
  away: string[];
}

// A single redacted structured log line. Values are primitives only (already sanitized).
export type LogValue = string | number | boolean | null;
export interface LogRecord {
  time: string;
  level: string;
  msg: string;
  fields: Record<string, LogValue>;
}

export interface LogQuery {
  limit: number;
  level: string | null;
}

// gs /metrics is a flat map of numeric counters + tick percentiles.
export type MetricsSnapshot = Record<string, number>;

// Depth actually achieved by a VERIFY probe — reported honestly (§4.6 of the spec).
export type VerifyDepth =
  | "http_only"
  | "ws_liveness"
  | "synthetic_join"
  | "policy_v2_parser"
  | "policy_v2_parser+synthetic_join";

export interface VerifyResult {
  ok: boolean;
  depth: VerifyDepth;
  detail: string | null;
}

// Result of a game-server admin side effect (drain/flush/resume/restart).
export type AdminEffectMode = "applied" | "deferred_to_reload" | "unsupported";
export interface AdminEffectResult {
  mode: AdminEffectMode;
  detail: string | null;
}
