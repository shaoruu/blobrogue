// Integration test: boots a REAL blobrogue-gs in-process and runs the REAL HttpGameServerProbe
// against it — proving the loopback health read + synthetic-join VERIFY path works end-to-end
// (no Hetzner, no faked gs). Then it runs a full deploy through the controller whose VERIFY step
// hits the live server. The pm2 reload is faked (we don't restart the in-process gs), but VERIFY
// exercises the live socket + tick loop, which is the property that matters.

import { WebSocket } from "ws";

import {
  HttpGameServerProbe,
  SYNTHETIC_JOIN_PROTOCOL,
  isSyntheticSpawnProtectionSelf,
} from "../src/adapters/httpProbe.js";
import { NodeTailReader } from "../src/adapters/tail.js";
import type { WorldSummary } from "../src/types.js";
import { PROTOCOL_VERSION, jsonCodec } from "../../src/net/protocol.js";
import { mintTicket as mintGsTicket } from "../../server/src/auth.js";
import { ChecksumArtifactVerifier } from "../src/artifactVerifier.js";
import { DeployController, type OperationContext } from "../src/deployController.js";
import { DeployLock } from "../src/deployLock.js";
import { DefaultGameServerAdmin } from "../src/gameServerAdmin.js";
import { createLogger } from "../src/logger.js";
import { FileAuditSink } from "../src/stores/auditSink.js";
import { FileOperationStore } from "../src/stores/operationStore.js";
import { FsReleaseStore } from "../src/stores/releaseStore.js";
import { GameServer } from "../../server/src/server.js";
import { loadConfig as loadGsConfig } from "../../server/src/config.js";
import { createLogger as createGsLogger } from "../../server/src/logger.js";
import { FakePm2, InMemoryFileSystem, ManualClock, stageRelease, TestRunner } from "./harness.js";

const GS_SECRET = "itest-gs-secret";
const CTX: OperationContext = { actor: "op", requestId: "itest", idempotencyKey: null, tokenJti: "jti", confirmJti: "cf" };

async function bootGs(heartbeatMs: number): Promise<{ port: number; close: () => Promise<void> }> {
  const cfg = { ...loadGsConfig({}), host: "127.0.0.1", port: 0, auth: { secret: GS_SECRET, allowDev: true }, heartbeatMs, heartbeatMisses: 3 };
  const gs = new GameServer(cfg, { logger: createGsLogger({ app: "gs-itest" }, "error") });
  const port = await gs.listen();
  return { port, close: () => gs.close() };
}

export async function suite(t: TestRunner): Promise<void> {
  await t.suite("integration: real gs status + synthetic-join verify", async () => {
    t.check("synthetic join speaks the current game protocol", SYNTHETIC_JOIN_PROTOCOL === PROTOCOL_VERSION,
      `probe=${SYNTHETIC_JOIN_PROTOCOL} game=${PROTOCOL_VERSION}`);
    t.check("control rejects missing or malformed v32 spawn protection self fields",
      isSyntheticSpawnProtectionSelf({ spo: 0, sge: 0, sse: 0, sgr: 0, ssh: 0, sfl: false })
      && !isSyntheticSpawnProtectionSelf({ spo: 0, sge: 0, sse: 0, sgr: 0, ssh: 0 })
      && !isSyntheticSpawnProtectionSelf({ spo: 10, sge: 9, sse: 20, sgr: 0, ssh: 0, sfl: false }));
    const gs = await bootGs(200);
    try {
      const probe = new HttpGameServerProbe(
        { baseUrl: `http://127.0.0.1:${gs.port}`, wsUrl: `ws://127.0.0.1:${gs.port}/ws`, logOutFile: null, syntheticTicketSecret: GS_SECRET, logTailMax: 100 },
        new NodeTailReader(),
      );
      const status = await probe.status();
      t.check("real gs status ok", status.status === "ok", `status=${status.status}`);
      const readiness = await probe.readiness();
      t.check("real gs ready", readiness.live && readiness.ready);
      const verify = await probe.verify();
      t.check("full synthetic join verifies against real gs", verify.ok && verify.depth === "synthetic_join", `ok=${verify.ok} depth=${verify.depth} detail=${verify.detail ?? ""}`);
      // Per-world occupancy over the live /worlds endpoint: hold a real join open in a room
      // world and the panel read shows exactly that world with its occupant — the ops view
      // that answers "did the room's members land in one world?".
      const socket = new WebSocket(`ws://127.0.0.1:${gs.port}/ws`);
      await new Promise<void>((resolve) => socket.on("open", () => resolve()));
      const decodedFrame = new Promise<ReturnType<typeof jsonCodec.decodeServer>>((resolve, reject) => {
        socket.once("message", (data) => {
          try { resolve(jsonCodec.decodeServer(data.toString())); }
          catch (error) { reject(error); }
        });
      });
      socket.send(JSON.stringify({ t: "join", ticket: mintGsTicket(GS_SECRET, "panel-player", 60, Date.now(), { worldId: "room:OPSX", name: "PanelPlayer" }), protocol: SYNTHETIC_JOIN_PROTOCOL }));
      const decoded = await decodedFrame;
      t.check("shared decoder validates v32 synthetic self spawn-protection fields",
        decoded.t === "snap"
        && decoded.self !== null
        && Number.isInteger(decoded.self.spo)
        && Number.isInteger(decoded.self.sge)
        && Number.isInteger(decoded.self.sse)
        && Number.isInteger(decoded.self.sgr)
        && Number.isInteger(decoded.self.ssh)
        && typeof decoded.self.sfl === "boolean");
      let room: WorldSummary | undefined;
      for (let i = 0; i < 100 && room === undefined; i++) {
        await new Promise((r) => setTimeout(r, 20));
        room = (await probe.worlds()).find((w) => w.id === "room:OPSX");
      }
      t.check("live /worlds lists the room world with its occupant", room !== undefined && room.players === 1 && room.names[0] === "PanelPlayer",
        `world=${JSON.stringify(room ?? null)}`);
      socket.close();
    } finally {
      await gs.close();
    }
  });

  await t.suite("integration: credential-free ws-liveness verify (no synthetic secret)", async () => {
    const gs = await bootGs(150);
    try {
      const probe = new HttpGameServerProbe(
        { baseUrl: `http://127.0.0.1:${gs.port}`, wsUrl: `ws://127.0.0.1:${gs.port}/ws`, logOutFile: null, syntheticTicketSecret: null, logTailMax: 100 },
        new NodeTailReader(),
      );
      const verify = await probe.verify();
      t.check("ws-liveness verify passes without game credentials", verify.ok && verify.depth === "ws_liveness", `ok=${verify.ok} depth=${verify.depth}`);
    } finally {
      await gs.close();
    }
  });

  await t.suite("integration: full deploy whose VERIFY hits the live gs", async () => {
    const gs = await bootGs(200);
    try {
      const root = "/opt/blobrogue-gs";
      const clock = new ManualClock();
      const log = createLogger({ app: "control-itest" }, "error");
      const fs = new InMemoryFileSystem();
      const releases = new FsReleaseStore(fs, root);
      const operations = new FileOperationStore(fs, "/opt/blobrogue-control/state");
      const audit = new FileAuditSink(fs, "/opt/blobrogue-control/state");
      const verifier = new ChecksumArtifactVerifier(fs, root);
      const probe = new HttpGameServerProbe(
        { baseUrl: `http://127.0.0.1:${gs.port}`, wsUrl: `ws://127.0.0.1:${gs.port}/ws`, logOutFile: null, syntheticTicketSecret: GS_SECRET, logTailMax: 100 },
        new NodeTailReader(),
      );
      const pm2 = new FakePm2();
      const gameServer = new DefaultGameServerAdmin(probe, pm2);
      const controller = new DeployController({ releases, operations, gameServer, verifier, audit, lock: new DeployLock(), clock, log, retainedReleases: 5 });

      const id = stageRelease(fs, root);
      const op = await controller.deploy(id, CTX);
      const verifyTransition = op.transitions.find((x) => x.state === "verify");
      t.check("deploy done with live verify", op.state === "done" && op.result === "success", `state=${op.state} err=${op.error ?? ""}`);
      t.check("verify transition recorded synthetic_join", (verifyTransition?.note ?? "").includes("synthetic_join"), `note=${verifyTransition?.note ?? ""}`);
      t.check("current switched to release", (await releases.current())?.releaseId === id);
    } finally {
      await gs.close();
    }
  });
}
