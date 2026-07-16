// Injected ports: the ONLY seams that touch the host (filesystem, pm2, the game server over
// loopback, the clock). Production wires the real adapters in adapters/*; tests wire in-memory
// fakes so the suite never mutates the box. Nothing here accepts a request-derived command,
// path, or process name — those are constructed by the domain layer from validated allow-list
// values before they reach a port.

import type {
  AdminEffectResult,
  GameServerStatus,
  LogQuery,
  LogRecord,
  MetricsSnapshot,
  Readiness,
  VerifyResult,
  WorldSummary,
} from "./types.js";

export type GameServerLifecycleAction = "drain" | "flush" | "resume";

export interface Clock {
  now(): number; // unix ms
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
}

// A minimal filesystem seam. All paths are constructed by the domain layer (releases root +
// validated releaseId), never taken verbatim from a request.
export interface FileSystemPort {
  readFile(path: string): Promise<string | null>; // utf8 text, null when absent
  readFileBytes(path: string): Promise<Uint8Array | null>; // exact bytes (for hashing), null when absent
  writeFileAtomic(path: string, data: string, mode?: number): Promise<void>;
  appendFile(path: string, data: string, mode?: number): Promise<void>;
  ensureDir(path: string, mode?: number): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  readSymlink(path: string): Promise<string | null>; // resolved target, or null
  swapSymlink(linkPath: string, target: string): Promise<void>; // atomic (temp + rename)
  removeDir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

// The set of pm2 apps this service may EVER name. `town` is deliberately absent — it is not a
// value any code path can produce, so town can never be targeted. This is an enum, not a string
// derived from input.
export const PM2_APPS = ["blobrogue-gs", "blobrogue-gs-staging", "blobrogue-control"] as const;
export type Pm2App = (typeof PM2_APPS)[number];

export interface Pm2ProcessInfo {
  name: string;
  status: string;
  pid: number | null;
  restarts: number;
}

// pm2 seam. The real adapter shells out to `pm2` with a FIXED binary + a FIXED argv built only
// from the Pm2App enum — no user string is ever concatenated into a command.
export interface Pm2Port {
  reload(app: Pm2App): Promise<void>;
  describe(app: Pm2App): Promise<Pm2ProcessInfo | null>;
}

// Reads the game server over loopback HTTP + a synthetic WS join for VERIFY.
export interface GameServerProbe {
  status(): Promise<GameServerStatus>;
  readiness(): Promise<Readiness>;
  metrics(): Promise<MetricsSnapshot>;
  worlds(): Promise<WorldSummary[]>;
  logs(q: LogQuery): Promise<LogRecord[]>;
  verifyDiagnostic(): Promise<VerifyResult>;
  verifyForDeploy(): Promise<VerifyResult>;
  // Best-effort lifecycle nudge to the running gs. The real gs may not implement these yet; the
  // adapter reports `unsupported`/`deferred_to_reload` rather than failing a deploy (spec §4.5).
  lifecycle(action: GameServerLifecycleAction): Promise<AdminEffectResult>;
}
