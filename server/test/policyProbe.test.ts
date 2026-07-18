import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket as WsClient } from "ws";
import { startTestServer, waitUntil } from "../harness/lib.js";
import { PROTOCOL_VERSION } from "../../src/net/protocol.js";
import {
  POLICY_AUTHORITY_PROBE_PURPOSE,
  POLICY_AUTHORITY_PROBE_SUBJECT,
  POLICY_AUTHORITY_PROBE_WORLD_PREFIX,
} from "../src/auth.js";

let passed = 0;
let failed = 0;

function check(name: string, isPassing: boolean, detail = ""): void {
  if (isPassing) {
    passed++;
    process.stdout.write(`  PASS ${name}${detail ? ` — ${detail}` : ""}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ""}\n`);
  }
}

function signedTicket(
  secret: string,
  payload: object,
  version: "v1" | "v2" = "v2",
): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const body = `${version}.${encoded}`;
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function signedRawTicket(secret: string, rawPayload: string): string {
  const encoded = Buffer.from(rawPayload, "utf8").toString("base64url");
  const body = `v2.${encoded}`;
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

interface ProbeResult {
  frame: { t?: string; code?: string; depth?: string };
  isClosed: boolean;
}

async function sendProbe(url: string, ticket: string): Promise<ProbeResult> {
  return await new Promise<ProbeResult>((resolve) => {
    const socket = new WsClient(url);
    let frame: ProbeResult["frame"] = {};
    let isSettled = false;
    const timer = setTimeout(() => finish(false), 2_000);
    const finish = (isClosed: boolean): void => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      socket.close();
      resolve({ frame, isClosed });
    };
    socket.on("open", () => {
      socket.send(JSON.stringify({ t: "join", ticket, protocol: PROTOCOL_VERSION }));
    });
    socket.on("message", (data: Buffer) => {
      frame = JSON.parse(data.toString("utf8")) as ProbeResult["frame"];
      if (frame.t === "authorityAck") {
        try {
          socket.send(JSON.stringify({
            t: "input",
            seq: 1,
            mx: 1,
            my: 0,
            aim: 0,
            fire: true,
            dash: true,
            act: false,
            ult: false,
            pulse: false,
            pet: false,
            ak: "",
            ackEv: 0,
            ackSnap: 0,
          }));
        } catch {}
      }
      if (frame.t === "error") finish(false);
    });
    socket.on("close", () => finish(true));
    socket.on("error", () => finish(false));
  });
}

const directory = mkdtempSync(join(tmpdir(), "blobrogue-policy-probe-"));
const generationPath = join(directory, "generations.json");
let admissionRequests = 0;
const admissionServer = createServer((_request, response) => {
  admissionRequests++;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ isAllowed: true, code: "ok" }));
});
await new Promise<void>((resolve) => admissionServer.listen(0, "127.0.0.1", resolve));
const admissionAddress = admissionServer.address();
if (admissionAddress === null || typeof admissionAddress === "string") {
  throw new Error("policy probe admission server did not bind");
}

const server = await startTestServer({
  pvpPrivateEnabled: true,
  pvpPublicEnabled: true,
  receiptSecret: "policy-probe-receipt-secret",
  admissionEndpoint: `http://127.0.0.1:${admissionAddress.port}/gs/admission`,
  generationStatePath: generationPath,
});

try {
  const now = Date.now();
  const canonical = {
    pid: POLICY_AUTHORITY_PROBE_SUBJECT,
    exp: Math.floor(now / 1000) + 60,
    wld: `${POLICY_AUTHORITY_PROBE_WORLD_PREFIX}0123456789abcdef`,
    pp: "private_draft_v1",
    pr: POLICY_AUTHORITY_PROBE_PURPOSE,
  };
  const before = server.server.health();
  const result = await sendProbe(server.url, signedTicket(server.secret, canonical));
  check("canonical v2 parser probe receives explicit terminal acknowledgement",
    result.frame.t === "authorityAck"
    && result.frame.depth === POLICY_AUTHORITY_PROBE_PURPOSE
    && result.isClosed);
  check("probe remains terminal even when both future rollout flags are true",
    server.server.getWorld(canonical.wld) === undefined
    && server.server.health().worlds === 0
    && server.server.health().players === 0);
  check("post-ack gameplay frame cannot bind or mutate state",
    server.server.health().counters.rejectedInputs === before.counters.rejectedInputs
    && server.server.health().counters.policyAuthorityProbeOk === 1);
  check("probe performs no admission, generation, receipt, progression, or draft write",
    admissionRequests === 0
    && (JSON.parse(readFileSync(generationPath, "utf8")) as { entries: object[] }).entries.length === 0
    && !existsSync(`${generationPath}.receipts`)
    && server.server.health().worlds === 0);
  check("probe connection is fully cleaned up",
    await waitUntil(() => server.server.health().connections === 0, 2_000));

  const missingPurpose = {
    pid: canonical.pid,
    exp: canonical.exp,
    wld: canonical.wld,
    pp: canonical.pp,
  };
  const missingResult = await sendProbe(server.url, signedTicket(server.secret, missingPurpose));
  check("normal v2 ticket cannot reuse the probe namespace or subject",
    missingResult.frame.t === "error"
    && missingResult.frame.code === "policy_invalid"
    && server.server.health().worlds === 0);

  const gameplayWorld = { ...canonical, wld: "pvp:room:PROB:g1" };
  const gameplayResult = await sendProbe(server.url, signedTicket(server.secret, gameplayWorld));
  check("probe purpose can never authorize a normal PVP world",
    gameplayResult.frame.t === "error"
    && gameplayResult.frame.code === "policy_invalid"
    && server.server.getWorld("pvp:room:PROB:g1") === undefined);

  const canonicalFields = [
    `"pid":${JSON.stringify(canonical.pid)}`,
    `"exp":${canonical.exp}`,
    `"wld":${JSON.stringify(canonical.wld)}`,
    `"pp":${JSON.stringify(canonical.pp)}`,
    `"pr":${JSON.stringify(canonical.pr)}`,
  ];
  for (const duplicateField of canonicalFields) {
    const duplicateResult = await sendProbe(
      server.url,
      signedRawTicket(server.secret, `{${canonicalFields.join(",")},${duplicateField}}`),
    );
    check(`signed duplicate ${duplicateField.slice(1, duplicateField.indexOf('"', 1))} claim cannot acknowledge or mutate`,
      duplicateResult.frame.t === "error"
      && duplicateResult.frame.code === "policy_invalid"
      && server.server.health().worlds === 0
      && admissionRequests === 0);
  }
} finally {
  await server.close();
  await new Promise<void>((resolve) => admissionServer.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
