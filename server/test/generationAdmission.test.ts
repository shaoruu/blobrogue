import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket as WsClient } from "ws";
import { GenerationAdmissionStore } from "../src/generationAdmissionStore.js";
import { Bot, idle, startTestServer, waitUntil } from "../harness/lib.js";
import {
  POLICY_AUTHORITY_PROBE_PURPOSE,
  POLICY_AUTHORITY_PROBE_SUBJECT,
  POLICY_AUTHORITY_PROBE_WORLD_PREFIX,
  mintTicket,
} from "../src/auth.js";
import { PROTOCOL_VERSION } from "../../src/net/protocol.js";

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

function signedEnvelope(secret: string, payload: object): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const body = `v2.${encoded}`;
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

async function rawJoin(url: string, ticket: string): Promise<{ t?: string; code?: string }> {
  return await new Promise((resolve) => {
    const socket = new WsClient(url);
    const timer = setTimeout(() => {
      socket.close();
      resolve({ t: "timeout" });
    }, 2_000);
    let isSettled = false;
    const finish = (frame: { t?: string; code?: string }): void => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      socket.close();
      resolve(frame);
    };
    socket.on("open", () => {
      socket.send(JSON.stringify({ t: "join", ticket, protocol: PROTOCOL_VERSION }));
    });
    socket.on("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString("utf8")) as { t?: string; code?: string };
      if (frame.t === "error" || frame.t === "authorityAck") finish(frame);
    });
    socket.on("close", () => finish({ t: "closed" }));
  });
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
  check(
    "superseded tombstone cleanup preserves the generation high-water mark",
    restartedStore.isRetired("room:ABCD:g1", 2000 + 10 * 60_000),
  );

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

  const pvpStatePath = join(directory, "pvp-admission.json");
  let pvpAdmissionRequests = 0;
  const pvpAdmissionServer = createServer((_request, response) => {
    pvpAdmissionRequests++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ isAllowed: true, code: "ok" }));
  });
  await new Promise<void>((resolve) => pvpAdmissionServer.listen(0, "127.0.0.1", resolve));
  const pvpAdmissionAddress = pvpAdmissionServer.address();
  if (pvpAdmissionAddress === null || typeof pvpAdmissionAddress === "string") {
    throw new Error("PVP admission server did not bind");
  }
  const pvpConfig = {
    generationStatePath: pvpStatePath,
    pvpPrivateEnabled: true,
    receiptSecret: "pvp-restart-receipt-secret",
    admissionEndpoint: `http://127.0.0.1:${pvpAdmissionAddress.port}/gs/admission`,
  };

  const pvpFirst = await startTestServer(pvpConfig);
  const pvpG1 = new Bot({
    url: pvpFirst.url,
    secret: pvpFirst.secret,
    playerId: "pvp-restart-g1",
    world: "pvp:room:PVPR:g1",
    kit: "gunner",
    masteryLevel: 1,
    isPetChoiceMade: true,
    script: () => idle(),
  });
  pvpG1.start();
  check("canonical PVP generation one joins through normal admission",
    await waitUntil(() => pvpG1.transport.isReady(), 3_000)
    && pvpAdmissionRequests === 1);
  await pvpFirst.close();
  pvpG1.stop();

  const pvpSecond = await startTestServer(pvpConfig);
  try {
    const recovered = new GenerationAdmissionStore(pvpStatePath);
    check("restart recovers and durably retires canonical PVP generation one",
      recovered.recoveredActiveWorldIds().includes("pvp:room:PVPR:g1")
      || recovered.isRetired("pvp:room:PVPR:g1"));

    const staleG1 = new Bot({
      url: pvpSecond.url,
      secret: pvpSecond.secret,
      playerId: "pvp-stale-g1",
      world: "pvp:room:PVPR:g1",
      kit: "gunner",
      masteryLevel: 1,
      isPetChoiceMade: true,
      script: () => idle(),
    });
    staleG1.start();
    check("old correct-policy v2 generation-one ticket rejects after restart",
      await waitUntil(() => (staleG1.transport.lastError ?? "").includes("run_ended"), 3_000)
      && pvpSecond.server.getWorld("pvp:room:PVPR:g1") === undefined);

    const missingPolicy = mintTicket(
      pvpSecond.secret,
      "pvp-missing-policy",
      120,
      Date.now(),
      {
        worldId: "pvp:room:PVPR:g1",
        kit: "gunner",
        masteryLevel: 1,
        isPetChoiceMade: true,
      },
    );
    check("restart cannot recreate generation one with missing policy",
      (await rawJoin(pvpSecond.url, missingPolicy)).code === "policy_required"
      && pvpSecond.server.getWorld("pvp:room:PVPR:g1") === undefined);

    const unknownPolicy = signedEnvelope(pvpSecond.secret, {
      pid: "pvp-unknown-policy",
      exp: Math.floor(Date.now() / 1000) + 120,
      wld: "pvp:room:PVPR:g1",
      pp: "future_public_v1",
      kt: "gunner",
      ml: 1,
      pc: true,
    });
    check("restart cannot recreate generation one with unknown or mismatched policy",
      (await rawJoin(pvpSecond.url, unknownPolicy)).code === "policy_invalid"
      && pvpSecond.server.getWorld("pvp:room:PVPR:g1") === undefined
      && pvpSecond.server.getWorld("room:PVPR:g1") === undefined);

    const probeTicket = signedEnvelope(pvpSecond.secret, {
      pid: POLICY_AUTHORITY_PROBE_SUBJECT,
      exp: Math.floor(Date.now() / 1000) + 60,
      wld: `${POLICY_AUTHORITY_PROBE_WORLD_PREFIX}0123456789abcdef`,
      pp: "private_draft_v1",
      pr: POLICY_AUTHORITY_PROBE_PURPOSE,
    });
    check("synthetic authority probe acknowledges without creating generation two",
      (await rawJoin(pvpSecond.url, probeTicket)).t === "authorityAck"
      && pvpSecond.server.getWorld("pvp:room:PVPR:g2") === undefined);

    const requestsBeforeG2 = pvpAdmissionRequests;
    const pvpG2 = new Bot({
      url: pvpSecond.url,
      secret: pvpSecond.secret,
      playerId: "pvp-current-g2",
      world: "pvp:room:PVPR:g2",
      kit: "gunner",
      masteryLevel: 1,
      isPetChoiceMade: true,
      script: () => idle(),
    });
    pvpG2.start();
    check("generation two proceeds only through fresh v2 ticket and normal admission",
      await waitUntil(() => pvpG2.transport.isReady(), 3_000)
      && pvpAdmissionRequests === requestsBeforeG2 + 1
      && pvpSecond.server.getWorld("pvp:room:PVPR:g2")?.pvpPolicy === "private_draft_v1");
    staleG1.stop();
    await pvpSecond.close();
    pvpG2.stop();
  } catch (error) {
    await pvpSecond.close();
    throw error;
  }

  const pvpThird = await startTestServer(pvpConfig);
  try {
    const durable = new GenerationAdmissionStore(pvpStatePath);
    check("repeat restart preserves PVP generation high-water without deletion hole",
      durable.isRetired("pvp:room:PVPR:g1")
      && durable.isRetired("pvp:room:PVPR:g2"));
    const staleG2 = new Bot({
      url: pvpThird.url,
      secret: pvpThird.secret,
      playerId: "pvp-stale-g2",
      world: "pvp:room:PVPR:g2",
      kit: "gunner",
      masteryLevel: 1,
      isPetChoiceMade: true,
      script: () => idle(),
    });
    staleG2.start();
    check("second restart rejects old generation two with no PVP/co-op fallback",
      await waitUntil(() => (staleG2.transport.lastError ?? "").includes("run_ended"), 3_000)
      && pvpThird.server.getWorld("pvp:room:PVPR:g2") === undefined
      && pvpThird.server.getWorld("room:PVPR:g2") === undefined);
    staleG2.stop();
  } finally {
    await pvpThird.close();
    await new Promise<void>((resolve) => pvpAdmissionServer.close(() => resolve()));
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
