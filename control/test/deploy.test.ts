// Deploy state machine tests (controller level): happy path transitions + audit; bad artifact
// rejected at preflight without switching; VERIFY failure triggers atomic rollback to the prior
// release; drain/flush/resume are driven; restart reloads gs; a second operation while one holds
// the lock is rejected; an interrupted operation is recovered on boot.

import { LockedError } from "../src/errors.js";
import type { OperationContext } from "../src/deployController.js";
import { makeTestBed, stageRelease, TestRunner } from "./harness.js";

const CTX: OperationContext = { actor: "op", requestId: "req-1", idempotencyKey: null, tokenJti: "jti", confirmJti: "cf" };

export async function suite(t: TestRunner): Promise<void> {
  await t.suite("deploy: happy path switches current, reloads gs, audits", async () => {
    const bed = await makeTestBed();
    try {
      const id = stageRelease(bed.fs, bed.cfg.releasesRoot);
      const op = await bed.deps.controller.deploy(id, CTX);
      t.check("operation done", op.state === "done" && op.result === "success", `state=${op.state}`);
      t.check("current points at deployed release", (await bed.deps.releases.current())?.releaseId === id);
      t.check("gs reloaded exactly once", bed.pm2.reloads.length === 1 && bed.pm2.reloads[0] === "blobrogue-gs", bed.pm2.reloads.join(","));
      t.check("drain+flush+resume driven in order", bed.probe.lifecycleCalls.join(",") === "drain,flush,resume");
      const audits = await bed.deps.audit.list(10);
      t.check("audit record written for deploy", audits.length === 1 && audits[0].action === "deploy" && audits[0].result === "success");
      const durable = await bed.deps.operations.get(op.id);
      t.check("operation durable + terminal", durable !== null && durable.state === "done");
      t.check("transitions cover the state machine", op.transitions.map((x) => x.state).join(">").includes("drain>flush>switch>pm2_reload>verify>resume>done"));
    } finally {
      await bed.close();
    }
  });

  await t.suite("deploy: bad artifact rejected at preflight (no switch)", async () => {
    const bed = await makeTestBed();
    try {
      const id = stageRelease(bed.fs, bed.cfg.releasesRoot, { tamperChecksum: "00".repeat(32) });
      const op = await bed.deps.controller.deploy(id, CTX);
      t.check("operation failed", op.state === "failed" && op.result === "failure", `state=${op.state} err=${op.error}`);
      t.check("error names the artifact rejection", (op.error ?? "").includes("artifact_rejected"));
      t.check("current never switched", (await bed.deps.releases.current()) === null);
      t.check("gs never reloaded", bed.pm2.reloads.length === 0);
    } finally {
      await bed.close();
    }
  });

  await t.suite("deploy: VERIFY failure auto-rolls-back to prior release", async () => {
    const bed = await makeTestBed();
    try {
      const prev = stageRelease(bed.fs, bed.cfg.releasesRoot, { version: "1.0.0" });
      await bed.deps.releases.switchCurrent(prev);
      const next = stageRelease(bed.fs, bed.cfg.releasesRoot, { version: "2.0.0" });
      bed.probe.verifyValue = { ok: false, depth: "synthetic_join", detail: "synthetic join failed" };

      const op = await bed.deps.controller.deploy(next, CTX);
      t.check("operation rolled_back", op.state === "rolled_back" && op.result === "rolled_back", `state=${op.state}`);
      t.check("current restored to prior release", (await bed.deps.releases.current())?.releaseId === prev, `current=${(await bed.deps.releases.current())?.releaseId}`);
      t.check("gs reloaded for switch then restore", bed.pm2.reloads.length === 2 && bed.pm2.reloads.every((a) => a === "blobrogue-gs"));
      t.check("resume still called after rollback", bed.probe.lifecycleCalls.includes("resume"));
      const audits = await bed.deps.audit.list(10);
      t.check("audit reflects rolled_back", audits[0].result === "rolled_back");
    } finally {
      await bed.close();
    }
  });

  await t.suite("deploy: single lock rejects a concurrent operation", async () => {
    const bed = await makeTestBed();
    try {
      const a = stageRelease(bed.fs, bed.cfg.releasesRoot, { version: "1.0.0" });
      const b = stageRelease(bed.fs, bed.cfg.releasesRoot, { version: "2.0.0" });
      const p1 = bed.deps.controller.deploy(a, { ...CTX, requestId: "r1" });
      let locked = false;
      const p2 = bed.deps.controller.deploy(b, { ...CTX, requestId: "r2" }).catch((err) => {
        if (err instanceof LockedError) locked = true;
        return null;
      });
      await Promise.all([p1, p2]);
      t.check("second concurrent deploy hit the lock", locked);
    } finally {
      await bed.close();
    }
  });

  await t.suite("restart: reloads exactly blobrogue-gs and verifies", async () => {
    const bed = await makeTestBed();
    try {
      const id = stageRelease(bed.fs, bed.cfg.releasesRoot);
      await bed.deps.releases.switchCurrent(id);
      const op = await bed.deps.controller.restart(CTX);
      t.check("restart done", op.state === "done" && op.result === "success");
      t.check("only blobrogue-gs reloaded", bed.pm2.reloads.length === 1 && bed.pm2.reloads[0] === "blobrogue-gs");
    } finally {
      await bed.close();
    }
  });

  await t.suite("boot: interrupted operation is recovered", async () => {
    const bed = await makeTestBed();
    try {
      const now = new Date(bed.clock.now()).toISOString();
      await bed.deps.operations.create({
        id: "op_" + "a".repeat(18), kind: "deploy", state: "switch", result: "pending",
        releaseId: "abc123def456-1.2.3-0123456789ab", prevReleaseId: null, actor: "op", requestId: "r",
        idempotencyKey: null, tokenJti: null, confirmJti: null,
        transitions: [{ state: "preflight", at: now, note: null }], error: null, startedAt: now, updatedAt: now,
      });
      const recovered = await bed.deps.controller.recoverInterrupted();
      t.check("one interrupted op recovered", recovered === 1);
      const op = await bed.deps.operations.get("op_" + "a".repeat(18));
      t.check("op marked interrupted", op !== null && op.state === "interrupted" && op.result === "failure");
    } finally {
      await bed.close();
    }
  });
}
