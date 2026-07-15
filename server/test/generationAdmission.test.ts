import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenerationAdmissionStore } from "../src/generationAdmissionStore.js";
import { Bot, idle, startTestServer, waitUntil } from "../harness/lib.js";

let passed = 0;
let failed = 0;

function check(name: string, isPassing: boolean, detail = ""): void {
  if (isPassing) {
    passed++;
    process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`);
  }
}

const directory = mkdtempSync(join(tmpdir(), "blobrogue-generation-"));
const statePath = join(directory, "admission.json");

try {
  const firstStore = new GenerationAdmissionStore(statePath, 1000);
  firstStore.markActive("room:ABCD:g1", 1000);
  const restartedStore = new GenerationAdmissionStore(statePath, 2000);
  check("restart recovers the active generation", restartedStore.recoveredActiveWorldIds().join(",") === "room:ABCD:g1");
  check("restart durably retires the old generation", restartedStore.isRetired("room:ABCD:g1", 2000));
  let isOldRejected = false;
  try { restartedStore.markActive("room:ABCD:g1", 2000); } catch { isOldRejected = true; }
  check("retired generation cannot reactivate", isOldRejected);
  restartedStore.markActive("room:ABCD:g2", 2000);
  check("new current generation is accepted", !restartedStore.isRetired("room:ABCD:g2", 2000));

  const serverPath = join(directory, "server-admission.json");
  const first = await startTestServer({ generationStatePath: serverPath });
  const live = new Bot({
    url: first.url,
    secret: first.secret,
    playerId: "restart-old",
    world: "room:RSTR:g1",
    script: () => idle(),
  });
  live.start();
  check("generation one joins before restart", await waitUntil(() => live.transport.isReady(), 3000));
  live.stop();
  check("generation one is released before restart",
    await waitUntil(() => first.server.getWorld("room:RSTR:g1") === undefined, 3000));
  await first.close();

  const second = await startTestServer({ generationStatePath: serverPath });
  try {
    const stale = new Bot({
      url: second.url,
      secret: second.secret,
      playerId: "restart-stale",
      world: "room:RSTR:g1",
      script: () => idle(),
    });
    stale.start();
    await waitUntil(() => (stale.transport.lastError ?? "").includes("run_ended"), 3000);
    check("old ticket rejects after process restart",
      (stale.transport.lastError ?? "").includes("run_ended")
      && second.server.getWorld("room:RSTR:g1") === undefined);

    const current = new Bot({
      url: second.url,
      secret: second.secret,
      playerId: "restart-current",
      world: "room:RSTR:g2",
      script: () => idle(),
    });
    current.start();
    check("new generation accepts after restart", await waitUntil(() => current.transport.isReady(), 3000));
    stale.stop();
    current.stop();
  } finally {
    await second.close();
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
