// The deploy state machine (spec §4.2). Drives PREFLIGHT -> DRAIN -> FLUSH -> SWITCH ->
// PM2_RELOAD -> VERIFY -> RESUME for a deploy, with atomic failure recovery (restore the prior
// `current` symlink, reload, resume) on any post-switch failure. restart/rollback reuse the same
// primitives. Every transition is persisted to the durable OperationStore before and after the
// step, so an interrupted operation is recoverable and never silently lost. Exactly one operation
// runs at a time (DeployLock); each completed operation writes one immutable audit record.

import { PreconditionError } from "./errors.js";
import { randomId } from "./ids.js";
import type { ArtifactVerifier, AuditSink, GameServerAdmin, OperationStore, ReleaseStore } from "./interfaces.js";
import type { Logger } from "./logger.js";
import type { Clock } from "./ports.js";
import type { DeployLock } from "./deployLock.js";
import type {
  AuditRecord,
  OperationKind,
  OperationRecord,
  OperationResult,
  OperationState,
} from "./types.js";

export interface OperationContext {
  actor: string;
  requestId: string;
  idempotencyKey: string | null;
  tokenJti: string | null;
  confirmJti: string | null;
}

export interface DeployControllerDeps {
  releases: ReleaseStore;
  operations: OperationStore;
  gameServer: GameServerAdmin;
  verifier: ArtifactVerifier;
  audit: AuditSink;
  lock: DeployLock;
  clock: Clock;
  log: Logger;
  retainedReleases: number;
}

export class DeployController {
  constructor(private d: DeployControllerDeps) {}

  // On boot, mark any operation left mid-flight as interrupted so a reconnecting admin sees the
  // truth rather than a stale "in progress".
  async recoverInterrupted(): Promise<number> {
    const inflight = await this.d.operations.findNonTerminal();
    for (const op of inflight) {
      await this.transition(op, "interrupted", "recovered on control-plane boot");
      op.result = "failure";
      op.error = op.error ?? "control plane restarted mid-operation";
      await this.d.operations.update(op);
      this.d.lock.release(op.id);
    }
    return inflight.length;
  }

  async deploy(releaseId: string, ctx: OperationContext): Promise<OperationRecord> {
    const op = this.newOperation("deploy", releaseId, ctx);
    await this.begin(op);
    let drained = false;
    let switched = false;
    let prevReleaseId: string | null = null;
    try {
      const verified = await this.d.verifier.verify(releaseId);
      if (!verified.ok) throw new PreconditionError(`artifact_rejected:${verified.reason}`);
      const current = await this.d.releases.current();
      prevReleaseId = current?.releaseId ?? null;
      op.prevReleaseId = prevReleaseId;

      await this.transition(op, "drain", (await this.d.gameServer.drain()).mode);
      drained = true;
      await this.transition(op, "flush", (await this.d.gameServer.flush()).mode);

      await this.transition(op, "switch", `-> ${releaseId}`);
      await this.d.releases.switchCurrent(releaseId);
      switched = true;

      await this.transition(op, "pm2_reload", "blobrogue-gs");
      await this.d.gameServer.restart();

      await this.transition(op, "verify", null);
      const verify = await this.d.gameServer.verify();
      if (!verify.ok) throw new Error(`verify_failed:${verify.detail ?? verify.depth}`);
      op.transitions[op.transitions.length - 1].note = `ok:${verify.depth}`;

      await this.transition(op, "resume", (await this.d.gameServer.resume()).mode);
      await this.finishSuccess(op);
      await this.d.releases.prune(this.d.retainedReleases);
      return op;
    } catch (err) {
      return this.compensate(op, err, { drained, switched, prevReleaseId, restoreId: prevReleaseId });
    } finally {
      this.d.lock.release(op.id);
    }
  }

  async rollback(releaseId: string, ctx: OperationContext): Promise<OperationRecord> {
    const op = this.newOperation("rollback", releaseId, ctx);
    await this.begin(op);
    let drained = false;
    try {
      const target = await this.d.releases.get(releaseId);
      if (target === null) throw new PreconditionError("rollback_target_unknown");
      const verified = await this.d.verifier.verify(releaseId);
      if (!verified.ok) throw new PreconditionError(`rollback_target_rejected:${verified.reason}`);
      const current = await this.d.releases.current();
      op.prevReleaseId = current?.releaseId ?? null;

      await this.transition(op, "drain", (await this.d.gameServer.drain()).mode);
      drained = true;
      await this.transition(op, "switch", `-> ${releaseId}`);
      await this.d.releases.switchCurrent(releaseId);
      await this.transition(op, "pm2_reload", "blobrogue-gs");
      await this.d.gameServer.restart();
      await this.transition(op, "verify", null);
      const verify = await this.d.gameServer.verify();
      if (!verify.ok) throw new Error(`verify_failed:${verify.detail ?? verify.depth}`);
      op.transitions[op.transitions.length - 1].note = `ok:${verify.depth}`;
      await this.transition(op, "resume", (await this.d.gameServer.resume()).mode);
      await this.finishSuccess(op);
      return op;
    } catch (err) {
      // A rollback that fails verification leaves the operator to intervene; we do not
      // auto-restore the release we were rolling AWAY from (it was the problem). We still resume.
      if (drained) await this.safe(async () => { await this.d.gameServer.resume(); });
      return this.fail(op, err);
    } finally {
      this.d.lock.release(op.id);
    }
  }

  async restart(ctx: OperationContext): Promise<OperationRecord> {
    const op = this.newOperation("restart", null, ctx);
    await this.begin(op);
    try {
      const current = await this.d.releases.current();
      op.prevReleaseId = current?.releaseId ?? null;
      op.releaseId = current?.releaseId ?? null;
      await this.transition(op, "pm2_reload", "blobrogue-gs");
      await this.d.gameServer.restart();
      await this.transition(op, "verify", null);
      const verify = await this.d.gameServer.verify();
      if (!verify.ok) throw new Error(`verify_failed:${verify.detail ?? verify.depth}`);
      op.transitions[op.transitions.length - 1].note = `ok:${verify.depth}`;
      await this.finishSuccess(op);
      return op;
    } catch (err) {
      return this.fail(op, err);
    } finally {
      this.d.lock.release(op.id);
    }
  }

  async deployPreview(releaseId: string, ctx: OperationContext): Promise<OperationRecord> {
    const op = this.newOperation("deploy_preview", releaseId, ctx);
    await this.begin(op);
    try {
      const verified = await this.d.verifier.verify(releaseId);
      if (!verified.ok) throw new PreconditionError(`artifact_rejected:${verified.reason}`);
      await this.transition(op, "switch", `staging -> ${releaseId}`);
      await this.d.releases.switchStaging(releaseId);
      await this.finishSuccess(op);
      return op;
    } catch (err) {
      return this.fail(op, err);
    } finally {
      this.d.lock.release(op.id);
    }
  }

  // ---- internals ----

  private newOperation(kind: OperationKind, releaseId: string | null, ctx: OperationContext): OperationRecord {
    const now = this.nowIso();
    return {
      id: randomId("op"),
      kind,
      state: "preflight",
      result: "pending",
      releaseId,
      prevReleaseId: null,
      actor: ctx.actor,
      requestId: ctx.requestId,
      idempotencyKey: ctx.idempotencyKey,
      tokenJti: ctx.tokenJti,
      confirmJti: ctx.confirmJti,
      transitions: [{ state: "preflight", at: now, note: null }],
      error: null,
      startedAt: now,
      updatedAt: now,
    };
  }

  private async begin(op: OperationRecord): Promise<void> {
    this.d.lock.acquire(op.id); // throws LockedError if another op holds it
    await this.d.operations.create(op);
    this.d.log.info("operation started", { operationId: op.id, kind: op.kind, releaseId: op.releaseId, actor: op.actor });
  }

  private async transition(op: OperationRecord, state: OperationState, note: string | null): Promise<void> {
    op.state = state;
    op.updatedAt = this.nowIso();
    op.transitions.push({ state, at: op.updatedAt, note });
    await this.d.operations.update(op);
    this.d.log.info("operation transition", { operationId: op.id, state, note: note ?? undefined });
  }

  private async compensate(
    op: OperationRecord,
    err: unknown,
    ctx: { drained: boolean; switched: boolean; prevReleaseId: string | null; restoreId: string | null },
  ): Promise<OperationRecord> {
    const reason = errMessage(err);
    this.d.log.warn("operation failed; compensating", { operationId: op.id, reason, switched: ctx.switched });
    if (ctx.switched && ctx.restoreId !== null && ctx.restoreId !== op.releaseId) {
      await this.safe(async () => {
        await this.transition(op, "switch", `restore -> ${ctx.restoreId}`);
        await this.d.releases.switchCurrent(ctx.restoreId!);
        await this.transition(op, "pm2_reload", "blobrogue-gs (restore)");
        await this.d.gameServer.restart();
      });
    }
    if (ctx.drained) await this.safe(async () => { await this.d.gameServer.resume(); });
    if (ctx.switched) {
      return this.finish(op, "rolled_back", "rolled_back", reason);
    }
    return this.fail(op, err);
  }

  private async fail(op: OperationRecord, err: unknown): Promise<OperationRecord> {
    return this.finish(op, "failed", "failure", errMessage(err));
  }

  private async finishSuccess(op: OperationRecord): Promise<OperationRecord> {
    return this.finish(op, "done", "success", null);
  }

  private async finish(op: OperationRecord, state: OperationState, result: OperationResult, error: string | null): Promise<OperationRecord> {
    op.state = state;
    op.result = result;
    op.error = error;
    op.updatedAt = this.nowIso();
    op.transitions.push({ state, at: op.updatedAt, note: error });
    await this.d.operations.update(op);
    await this.d.audit.append(this.auditOf(op));
    this.d.log.info("operation finished", { operationId: op.id, state, result, error: error ?? undefined });
    return op;
  }

  private auditOf(op: OperationRecord): AuditRecord {
    return {
      at: this.nowIso(),
      actor: op.actor,
      action: op.kind,
      releaseId: op.releaseId,
      prevReleaseId: op.prevReleaseId,
      requestId: op.requestId,
      operationId: op.id,
      tokenJti: op.tokenJti,
      confirmJti: op.confirmJti,
      result: op.result,
      detail: op.error,
    };
  }

  private async safe(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.d.log.error("compensation step failed", { reason: errMessage(err) });
    }
  }

  private nowIso(): string {
    return new Date(this.d.clock.now()).toISOString();
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
