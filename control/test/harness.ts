// Test harness: a tiny check/suite framework (matching server/test style), in-memory fakes for
// every host port (fs / pm2 / gs probe / clock), release builders, token minters, and a wired
// ControlHttpServer on an ephemeral port. Nothing here touches the real filesystem, pm2, or a
// real game server — the entire control plane runs against fakes.

import { ChecksumArtifactVerifier } from "../src/artifactVerifier.js";
import { AuthGate } from "../src/auth/gate.js";
import { NonceStore } from "../src/auth/nonceStore.js";
import { RateLimiter } from "../src/auth/rateLimiter.js";
import { mintAdminToken, mintConfirmToken, type ConfirmAction } from "../src/auth/tokens.js";
import { treeChecksum, sha256Hex } from "../src/checksum.js";
import { loadConfig, type ControlConfig } from "../src/config.js";
import { DeployController } from "../src/deployController.js";
import { DeployLock } from "../src/deployLock.js";
import { DefaultGameServerAdmin } from "../src/gameServerAdmin.js";
import { ControlHttpServer, type ControlDeps } from "../src/httpApi.js";
import { deriveReleaseId } from "../src/ids.js";
import { createLogger } from "../src/logger.js";
import type {
  Clock,
  DirEntry,
  FileSystemPort,
  GameServerLifecycleAction,
  GameServerProbe,
  Pm2App,
  Pm2Port,
  Pm2ProcessInfo,
} from "../src/ports.js";
import { FileAuditSink } from "../src/stores/auditSink.js";
import { FileOperationStore } from "../src/stores/operationStore.js";
import { FsReleaseStore } from "../src/stores/releaseStore.js";
import type {
  AdminEffectResult,
  GameServerStatus,
  LogQuery,
  LogRecord,
  MetricsSnapshot,
  Readiness,
  ReleaseGates,
  GameServerWorldAction,
  GameServerWorldActionResult,
  VerifyResult,
  WorldSummary,
} from "../src/types.js";

// ---- mini test framework ----

export class TestRunner {
  passed = 0;
  failed = 0;
  failures: string[] = [];

  check(name: string, cond: boolean, detail = ""): void {
    if (cond) {
      this.passed++;
      process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`);
    } else {
      this.failed++;
      this.failures.push(name + (detail ? " — " + detail : ""));
      process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`);
    }
  }

  async suite(name: string, fn: (t: TestRunner) => Promise<void>): Promise<void> {
    process.stdout.write(`\n[${name}]\n`);
    try {
      await fn(this);
    } catch (err) {
      this.failed++;
      this.failures.push(`${name} threw: ${String(err)}`);
      process.stdout.write(`  FAIL ${name} threw ${String(err)}\n`);
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- clock ----

export class ManualClock implements Clock {
  constructor(private t: number = 1_700_000_000_000) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

// ---- in-memory filesystem ----

export class InMemoryFileSystem implements FileSystemPort {
  files = new Map<string, Uint8Array>();
  symlinks = new Map<string, string>();
  dirs = new Set<string>();

  private addParents(path: string): void {
    const parts = path.split("/");
    parts.pop();
    let acc = "";
    for (const p of parts) {
      acc = acc === "" ? p : acc + "/" + p;
      if (acc.length > 0) this.dirs.add(acc);
    }
  }

  setFile(path: string, data: string | Uint8Array): void {
    this.files.set(path, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    this.addParents(path);
  }

  async readFile(path: string): Promise<string | null> {
    const bytes = this.files.get(path);
    // utf8-decodes like the real adapter — lossy for binary content, by design.
    return bytes === undefined ? null : Buffer.from(bytes).toString("utf8");
  }
  async readFileBytes(path: string): Promise<Uint8Array | null> {
    return this.files.get(path) ?? null;
  }
  async writeFileAtomic(path: string, data: string): Promise<void> {
    this.setFile(path, data);
  }
  async appendFile(path: string, data: string): Promise<void> {
    const prev = this.files.get(path) ?? Buffer.alloc(0);
    this.files.set(path, Buffer.concat([prev, Buffer.from(data, "utf8")]));
    this.addParents(path);
  }
  async ensureDir(path: string): Promise<void> {
    this.dirs.add(path);
    this.addParents(path);
  }
  async listDir(path: string): Promise<DirEntry[]> {
    const prefix = path.endsWith("/") ? path : path + "/";
    const seen = new Map<string, DirEntry>();
    const consider = (full: string, kind: "file" | "dir" | "link"): void => {
      if (!full.startsWith(prefix)) return;
      const rest = full.slice(prefix.length);
      if (rest.length === 0) return;
      const name = rest.split("/")[0];
      const isNested = rest.includes("/");
      const isDirectory = isNested || kind === "dir";
      const isSymlink = !isNested && kind === "link";
      const prev = seen.get(name);
      if (prev === undefined) seen.set(name, { name, isDirectory, isSymlink });
      else if (isSymlink) seen.set(name, { name, isDirectory: false, isSymlink: true });
    };
    for (const f of this.files.keys()) consider(f, "file");
    for (const d of this.dirs) consider(d, "dir");
    for (const l of this.symlinks.keys()) consider(l, "link");
    return [...seen.values()];
  }
  async readSymlink(path: string): Promise<string | null> {
    return this.symlinks.get(path) ?? null;
  }
  async swapSymlink(linkPath: string, target: string): Promise<void> {
    this.symlinks.set(linkPath, target);
    this.addParents(linkPath);
  }
  async removeDir(path: string): Promise<void> {
    const prefix = path.endsWith("/") ? path : path + "/";
    for (const k of [...this.files.keys()]) if (k === path || k.startsWith(prefix)) this.files.delete(k);
    for (const k of [...this.dirs]) if (k === path || k.startsWith(prefix)) this.dirs.delete(k);
    for (const k of [...this.symlinks.keys()]) if (k === path || k.startsWith(prefix)) this.symlinks.delete(k);
  }
  async exists(path: string): Promise<boolean> {
    if (this.files.has(path) || this.dirs.has(path) || this.symlinks.has(path)) return true;
    const prefix = path.endsWith("/") ? path : path + "/";
    for (const k of this.files.keys()) if (k.startsWith(prefix)) return true;
    for (const d of this.dirs) if (d.startsWith(prefix)) return true;
    return false;
  }
}

// ---- fake pm2 ----

export class FakePm2 implements Pm2Port {
  reloads: Pm2App[] = [];
  failOn: Pm2App | null = null;
  async reload(app: Pm2App): Promise<void> {
    this.reloads.push(app);
    if (this.failOn === app) throw new Error(`pm2 reload failed for ${app}`);
  }
  async describe(app: Pm2App): Promise<Pm2ProcessInfo | null> {
    return { name: app, status: "online", pid: 1234, restarts: this.reloads.length };
  }
}

// ---- fake game-server probe ----

export class FakeGameServerProbe implements GameServerProbe {
  statusValue: GameServerStatus = { status: "ok", uptimeSec: 10, worlds: 1, players: 0, connections: 0, tickMs_p50: 1, tickMs_p95: 2, tickMs_max: 3 };
  readyValue: Readiness = { live: true, ready: true, detail: null };
  metricsValue: MetricsSnapshot = { msgsIn: 0, msgsOut: 0 };
  worldsValue: WorldSummary[] = [{ id: "arena-1", players: 0, tick: 0, floor: 1, names: [], away: [] }];
  logsValue: LogRecord[] = [];
  verifyDiagnosticValue: VerifyResult = { ok: true, depth: "ws_liveness", detail: null };
  verifyForDeployValue: VerifyResult = { ok: true, depth: "policy_v2_parser+synthetic_join", detail: null };
  verifyDelayMs = 0; // hold the deploy across a real timer (makes lock contention deterministic)
  lifecycleCalls: GameServerLifecycleAction[] = [];
  worldActionCalls: GameServerWorldAction[] = [];

  async status(): Promise<GameServerStatus> { return this.statusValue; }
  async readiness(): Promise<Readiness> { return this.readyValue; }
  async metrics(): Promise<MetricsSnapshot> { return this.metricsValue; }
  async worlds(): Promise<WorldSummary[]> { return this.worldsValue; }
  async mutateWorld(action: GameServerWorldAction): Promise<GameServerWorldActionResult> {
    this.worldActionCalls.push(action);
    if (!this.worldsValue.some((world) => world.id === action.worldId)) {
      return { isApplied: false, reason: "world_not_found" };
    }
    const floor = action.action === "warp"
      ? action.floor
      : this.worldsValue.find((world) => world.id === action.worldId)?.floor ?? 0;
    const isSnapshotAction = action.action === "snapshot" || action.action === "restore";
    return {
      isApplied: true,
      worldId: action.worldId,
      floor,
      players: 0,
      fidelity: isSnapshotAction ? "build+floor" : undefined,
      snapshotPath: isSnapshotAction ? `/var/lib/blobrogue/run-snapshots/${action.worldId}.json` : undefined,
    };
  }
  async logs(_q: LogQuery): Promise<LogRecord[]> { return this.logsValue; }
  async verifyDiagnostic(): Promise<VerifyResult> {
    return this.verifyDiagnosticValue;
  }
  async verifyForDeploy(): Promise<VerifyResult> {
    if (this.verifyDelayMs > 0) await sleep(this.verifyDelayMs);
    return this.verifyForDeployValue;
  }
  async lifecycle(action: GameServerLifecycleAction): Promise<AdminEffectResult> {
    this.lifecycleCalls.push(action);
    return { mode: "applied", detail: null };
  }
}

// ---- release builder (uses the real checksum + id derivation so the verifier accepts it) ----

export interface StageReleaseOpts {
  commit?: string;
  version?: string;
  gates?: ReleaseGates;
  extraFiles?: Record<string, string | Uint8Array>;
  tamperChecksum?: string; // write a WRONG checksum into the manifest
  dropFile?: string; // omit a file that the manifest lists (missing-file case)
}

// A real packaged tree always contains binary files (sprite PNGs, native addons), so the default
// staged release includes one: PNG magic + bytes that do NOT survive a utf8 decode/re-encode.
export const BINARY_SPRITE_BYTES: Uint8Array = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0xc3, 0x28, 0x80]);

export function stageRelease(fs: InMemoryFileSystem, root: string, opts: StageReleaseOpts = {}): string {
  const commit = opts.commit ?? "abc123def456";
  const version = opts.version ?? "1.2.3";
  const gates = opts.gates ?? { typecheck: "pass", unitTests: "pass", goldens: "pass" };
  const content: Record<string, string | Uint8Array> = {
    "server/dist/server/src/main.js": "console.log('gs');\n",
    "control/dist/src/main.js": "console.log('control');\n",
    "client/dist/index.html": "<!doctype html>\n",
    "client/dist/assets/sprites.png": BINARY_SPRITE_BYTES,
    ...(opts.extraFiles ?? {}),
  };
  const files = Object.keys(content).sort();
  const digests = files.map((p) => ({ path: p, sha256: sha256Hex(content[p]) }));
  const checksum = treeChecksum(digests);
  const releaseId = deriveReleaseId(commit, version, checksum);
  const dir = `${root}/releases/${releaseId}`;

  for (const p of files) {
    if (opts.dropFile === p) continue;
    fs.setFile(`${dir}/${p}`, content[p]);
  }
  fs.dirs.add(dir);
  const manifest = {
    releaseId,
    version,
    commit,
    builtAt: "2026-01-01T00:00:00Z",
    checksum: opts.tamperChecksum ?? checksum,
    gates,
    files,
  };
  fs.setFile(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
  return releaseId;
}

// ---- wiring ----

export const TEST_ADMIN_SECRET = "test-admin-secret";
export const TEST_CONFIRM_SECRET = "test-confirm-secret";
export const TEST_AUDIENCE = "blobrogue-control";

export interface TestBed {
  cfg: ControlConfig;
  clock: ManualClock;
  fs: InMemoryFileSystem;
  pm2: FakePm2;
  probe: FakeGameServerProbe;
  deps: ControlDeps;
  server: ControlHttpServer;
  base: string;
  close: () => Promise<void>;
}

export async function makeTestBed(overrides: Partial<ControlConfig> = {}): Promise<TestBed> {
  const clock = new ManualClock();
  const root = "/opt/blobrogue-gs";
  const stateDir = "/opt/blobrogue-control/state";
  const cfg: ControlConfig = {
    ...loadConfig({}),
    host: "127.0.0.1",
    port: 0,
    isProd: false,
    adminTokenSecret: TEST_ADMIN_SECRET,
    confirmTokenSecret: TEST_CONFIRM_SECRET,
    tokenAudience: TEST_AUDIENCE,
    adminTokenMaxTtlSec: 900,
    allowedOrigins: [],
    allowDevAuth: false,
    rateCapacity: 1000,
    rateRefillPerSec: 1000,
    releasesRoot: root,
    retainedReleases: 5,
    stateDir,
    logTailMax: 500,
    ...overrides,
  };
  const log = createLogger({ app: "control-test" }, "error");
  const fs = new InMemoryFileSystem();
  const pm2 = new FakePm2();
  const probe = new FakeGameServerProbe();

  const releases = new FsReleaseStore(fs, cfg.releasesRoot);
  const operations = new FileOperationStore(fs, cfg.stateDir);
  const audit = new FileAuditSink(fs, cfg.stateDir);
  const verifier = new ChecksumArtifactVerifier(fs, cfg.releasesRoot);
  const gameServer = new DefaultGameServerAdmin(probe, pm2);
  const lock = new DeployLock();
  const controller = new DeployController({ releases, operations, gameServer, verifier, audit, lock, clock, log, retainedReleases: cfg.retainedReleases });
  const authGate = new AuthGate(cfg, new NonceStore(clock), new NonceStore(clock), clock);
  const rateLimiter = new RateLimiter(clock, cfg.rateCapacity, cfg.rateRefillPerSec);
  const deps: ControlDeps = { cfg, log, clock, releases, operations, gameServer, verifier, audit, controller, authGate, rateLimiter };

  const server = new ControlHttpServer(deps);
  const port = await server.listen();
  const base = `http://127.0.0.1:${port}`;
  return { cfg, clock, fs, pm2, probe, deps, server, base, close: () => server.close() };
}

// ---- token + HTTP helpers ----

export function adminToken(clock: ManualClock, opts: { scope?: string[]; aud?: string; ttlSec?: number; sub?: string; jti?: string } = {}): string {
  const nowSec = Math.floor(clock.now() / 1000);
  return mintAdminToken(TEST_ADMIN_SECRET, {
    sub: opts.sub ?? "operator@create.town",
    scope: opts.scope ?? ["blobrogue:ops"],
    aud: opts.aud ?? TEST_AUDIENCE,
    iss: "admin.create.town",
    iat: nowSec,
    exp: nowSec + (opts.ttlSec ?? 300),
    jti: opts.jti ?? "jti-" + Math.random().toString(16).slice(2),
  });
}

export function confirmToken(clock: ManualClock, action: ConfirmAction, releaseId: string | null, opts: { ttlSec?: number; jti?: string } = {}): string {
  const nowSec = Math.floor(clock.now() / 1000);
  return mintConfirmToken(TEST_CONFIRM_SECRET, {
    action,
    releaseId,
    sub: "operator@create.town",
    aud: TEST_AUDIENCE,
    iat: nowSec,
    exp: nowSec + (opts.ttlSec ?? 45),
    jti: opts.jti ?? "cf-" + Math.random().toString(16).slice(2),
  });
}

export interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

export async function api(base: string, method: string, path: string, opts: { token?: string; confirm?: string; idem?: string; origin?: string; body?: object } = {}): Promise<HttpResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (opts.confirm !== undefined) headers["x-confirm-token"] = opts.confirm;
  if (opts.idem !== undefined) headers["idempotency-key"] = opts.idem;
  if (opts.origin !== undefined) headers.origin = opts.origin;
  const res = await fetch(base + path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  let body: Record<string, unknown> = {};
  const text = await res.text();
  if (text.length > 0) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
    } catch {
      body = { raw: text };
    }
  }
  return { status: res.status, body };
}
