// Integration test: boots a REAL blobrogue-gs in-process and runs the REAL HttpGameServerProbe
// against it — proving the loopback health read + synthetic-join VERIFY path works end-to-end
// (no Hetzner, no faked gs). Then it runs a full deploy through the controller whose VERIFY step
// hits the live server. The pm2 reload is faked (we don't restart the in-process gs), but VERIFY
// exercises the live socket + tick loop, which is the property that matters.

import { WebSocket } from "ws";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";

import {
  HttpGameServerProbe,
  SYNTHETIC_ADMISSION_ENVELOPE,
  SYNTHETIC_COOP_TICKET_ENVELOPE,
  SYNTHETIC_JOIN_PROTOCOL,
  SYNTHETIC_PVP_TICKET_ENVELOPE,
  POLICY_PROBE_PURPOSE,
  POLICY_PROBE_SUBJECT,
  POLICY_PROBE_WORLD_PREFIX,
  isSyntheticSpawnProtectionSelf,
  mintPolicyParserProbeTicket,
  validateAuthorityVersion,
  type ProbeJson,
} from "../src/adapters/httpProbe.js";
import { mintGameServerControlToken } from "../src/adapters/gameServerControlAuth.js";
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
import { GameWorld } from "../../server/src/world.js";
import { WorldRegistry } from "../../server/src/worldRegistry.js";
import { loadConfig as loadGsConfig } from "../../server/src/config.js";
import { createLogger as createGsLogger } from "../../server/src/logger.js";
import { FakePm2, InMemoryFileSystem, ManualClock, stageRelease, TestRunner } from "./harness.js";

const GS_SECRET = "itest-gs-secret";
const GS_CONTROL_SECRET = "itest-gs-control-secret";
const CTX: OperationContext = { actor: "op", requestId: "itest", idempotencyKey: null, tokenJti: "jti", confirmJti: "cf" };

async function bootGs(heartbeatMs: number): Promise<{ port: number; close: () => Promise<void> }> {
  const cfg = { ...loadGsConfig({}), host: "127.0.0.1", port: 0, auth: { secret: GS_SECRET, allowDev: false }, controlSecret: GS_CONTROL_SECRET, heartbeatMs, heartbeatMisses: 3 };
  const gs = new GameServer(cfg, { logger: createGsLogger({ app: "gs-itest" }, "error") });
  const port = await gs.listen();
  return { port, close: () => gs.close() };
}

interface PolicyProbeFrame {
  t?: string;
  code?: string;
  depth?: string;
}

function signProbePayload(payload: object, version: "v1" | "v2" = "v2"): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const body = `${version}.${encoded}`;
  const signature = createHmac("sha256", GS_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}

async function sendPolicyProbeTicket(port: number, ticket: string): Promise<PolicyProbeFrame> {
  return await new Promise<PolicyProbeFrame>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timer = setTimeout(() => {
      socket.close();
      resolve({ t: "timeout" });
    }, 2_000);
    let isSettled = false;
    const finish = (frame: PolicyProbeFrame): void => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      socket.close();
      resolve(frame);
    };
    socket.on("open", () => {
      socket.send(JSON.stringify({ t: "join", ticket, protocol: SYNTHETIC_JOIN_PROTOCOL }));
    });
    socket.on("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString("utf8")) as PolicyProbeFrame;
      if (frame.t === "authorityAck" || frame.t === "error") finish(frame);
    });
    socket.on("close", () => finish({ t: "closed" }));
  });
}

export async function suite(t: TestRunner): Promise<void> {
  await t.suite("integration: signed live-world rescue reaches authoritative multiplayer state", async () => {
    const logger = createGsLogger({ app: "gs-control-itest" }, "error");
    const registry = new WorldRegistry(
      (id, policy) => new GameWorld(id, 0x5E7E, false, "coop", policy),
      logger,
    );
    const room = registry.ensureRoom("room:CTRL:g1", null);
    room.addPlayer("ian", "bulwark", "ian-account");
    room.addPlayer("coop", "mender", "coop-account");
    const ianWeapons = JSON.stringify(room.state.players.get("ian")?.ownedWeapons);
    const cfg = {
      ...loadGsConfig({}),
      host: "127.0.0.1",
      port: 0,
      auth: { secret: GS_SECRET, allowDev: false },
      controlSecret: "dedicated-control-secret",
    };
    const server = new GameServer(cfg, { logger, sessions: registry });
    const port = await server.listen();
    const baseUrl = `http://127.0.0.1:${port}`;
    const probe = new HttpGameServerProbe(
      {
        baseUrl,
        wsUrl: `ws://127.0.0.1:${port}/ws`,
        logOutFile: null,
        syntheticTicketSecret: GS_SECRET,
        controlSecret: "dedicated-control-secret",
        logTailMax: 100,
      },
      new NodeTailReader(),
    );
    try {
      const unsigned = await fetch(`${baseUrl}/admin/world-action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "warp", worldId: room.id, floor: 55 }),
      });
      t.check("unsigned direct game-server mutation is rejected", unsigned.status === 401);

      const warp = await probe.mutateWorld({ action: "warp", worldId: room.id, floor: 55 });
      t.check("signed warp moves the shared authoritative room", warp.isApplied
        && room.state.floor === 55
        && room.state.players.size === 2);
      t.check("signed warp preserves player loadouts",
        JSON.stringify(room.state.players.get("ian")?.ownedWeapons) === ianWeapons);

      const loadoutWarp = await probe.mutateWorld({
        action: "warp",
        worldId: room.id,
        floor: 60,
        loadouts: [
          {
            player: "ian-account",
            kitId: "phantom",
            hp: 2.5,
            weapons: ["pistol", "shotgun", "tesla", "nailer", "margin_call", "red_pen", "umbra"],
            blessings: [
              { id: "glass_cannon", lvl: 3 },
              { id: "hair_trigger", lvl: 2 },
              { id: "missing_blessing", lvl: 1 },
            ],
          },
          {
            player: "coop-account",
            kitId: "mender",
            hp: 3,
            weapons: ["pistol", "halo"],
            blessings: [{ id: "swift_boots", lvl: 2 }],
          },
        ],
      });
      const warpedIan = room.state.players.get("ian")!;
      const warpedCoop = room.state.players.get("coop")!;
      t.check("signed warp applies distinct co-op hotbars and kits",
        loadoutWarp.isApplied
        && room.state.floor === 60
        && warpedIan.kitId === "phantom"
        && JSON.stringify(warpedIan.ownedWeapons) === JSON.stringify([
          "pistol", "shotgun", "tesla", "nailer", "margin_call", "red_pen",
        ])
        && warpedCoop.kitId === "mender"
        && JSON.stringify(warpedCoop.ownedWeapons) === JSON.stringify(["pistol", "halo"]));
      t.check("signed warp applies leveled blessings and reports unknown ids",
        warpedIan.ownedItemIds.filter((id) => id === "glass_cannon").length === 3
        && warpedIan.ownedItemIds.filter((id) => id === "hair_trigger").length === 2
        && warpedCoop.ownedItemIds.filter((id) => id === "swift_boots").length === 2
        && loadoutWarp.isApplied
        && loadoutWarp.loadouts?.[0]?.isApplied === true
        && loadoutWarp.loadouts[0].grant.skippedWeapons.includes("umbra")
        && loadoutWarp.loadouts[0].grant.skippedBlessings.includes("missing_blessing"));

      if (room.state.encounter !== null) {
        room.state.encounter.completed = false;
        room.state.encounter.failed = true;
      }
      const force = await probe.mutateWorld({ action: "force-open-exit", worldId: room.id });
      t.check("signed force-open clears a stuck shared floor", force.isApplied
        && room.state.enemies.length === 0
        && room.state.pendingSpawns.length === 0
        && room.state.encounter?.completed === true);

      const replayAction = { action: "force-open-exit", worldId: room.id } as const;
      const replayToken = mintGameServerControlToken("dedicated-control-secret", replayAction);
      const replayRequest = (): Promise<Response> => fetch(`${baseUrl}/admin/world-action`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${replayToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(replayAction),
      });
      const first = await replayRequest();
      const second = await replayRequest();
      t.check("signed game-server action tokens are single-use",
        first.status === 200 && second.status === 409);
    } finally {
      await server.close();
    }
  });

  await t.suite("integration: real gs status + synthetic-join verify", async () => {
    t.check("synthetic join speaks the current game protocol", SYNTHETIC_JOIN_PROTOCOL === PROTOCOL_VERSION,
      `probe=${SYNTHETIC_JOIN_PROTOCOL} game=${PROTOCOL_VERSION}`);
    t.check("synthetic authority probe expects v1 co-op, v2 PVP, and a2 admission",
      SYNTHETIC_COOP_TICKET_ENVELOPE === "v1"
      && SYNTHETIC_PVP_TICKET_ENVELOPE === "v2"
      && SYNTHETIC_ADMISSION_ENVELOPE === "a2");
    const versionBase = {
      protocol: PROTOCOL_VERSION,
      coopTicket: "v1",
      pvpTicket: "v2",
      admission: "a2",
      pvpPrivateEnabled: true,
      pvpPublicEnabled: false,
    };
    t.check("exact canonical policy catalog passes",
      validateAuthorityVersion({ ...versionBase, pvpPolicies: ["private_draft_v1"] }).isValid);
    const catalogCases: Array<[string, ProbeJson, string]> = [
      ["missing", versionBase, "pvp_policy_catalog_malformed"],
      ["empty", { ...versionBase, pvpPolicies: [] }, "pvp_policy_catalog_mismatch"],
      ["extra", { ...versionBase, pvpPolicies: ["private_draft_v1", "future_public_v1"] }, "pvp_policy_catalog_mismatch"],
      ["unknown", { ...versionBase, pvpPolicies: ["future_public_v1"] }, "pvp_policy_catalog_mismatch"],
      ["duplicate", { ...versionBase, pvpPolicies: ["private_draft_v1", "private_draft_v1"] }, "pvp_policy_catalog_duplicate"],
      ["malformed", { ...versionBase, pvpPolicies: "private_draft_v1" }, "pvp_policy_catalog_malformed"],
    ];
    for (const [label, candidate, detail] of catalogCases) {
      const validation = validateAuthorityVersion(candidate);
      t.check(`${label} policy catalog fails VERIFY clearly`,
        !validation.isValid && validation.detail === detail,
        `detail=${validation.detail ?? ""}`);
    }
    t.check("control rejects missing or malformed v33 spawn protection self fields",
      isSyntheticSpawnProtectionSelf({ spo: 0, sge: 0, sse: 0, sgr: 0, ssh: 0, sfl: false })
      && !isSyntheticSpawnProtectionSelf({ spo: 0, sge: 0, sse: 0, sgr: 0, ssh: 0 })
      && !isSyntheticSpawnProtectionSelf({ spo: 10, sge: 9, sse: 20, sgr: 0, ssh: 0, sfl: false }));
    const gs = await bootGs(200);
    try {
      const probe = new HttpGameServerProbe(
        { baseUrl: `http://127.0.0.1:${gs.port}`, wsUrl: `ws://127.0.0.1:${gs.port}/ws`, logOutFile: null, syntheticTicketSecret: GS_SECRET, controlSecret: GS_CONTROL_SECRET, logTailMax: 100 },
        new NodeTailReader(),
      );
      const status = await probe.status();
      t.check("real gs status ok", status.status === "ok", `status=${status.status}`);
      const readiness = await probe.readiness();
      t.check("real gs ready", readiness.live && readiness.ready);
      const beforePolicyProbe = await probe.status();
      const beforePolicyWorlds = await probe.worlds();
      const policyProbe = await probe.verifyPolicyParser();
      t.check("live deployed v2 parser returns the terminal authority acknowledgement",
        policyProbe.ok && policyProbe.depth === "policy_v2_parser",
        `ok=${policyProbe.ok} detail=${policyProbe.detail ?? ""}`);
      let afterPolicyProbe = await probe.status();
      for (let attempt = 0; attempt < 100 && afterPolicyProbe.connections !== 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        afterPolicyProbe = await probe.status();
      }
      t.check("successful parser probe creates no world, body, seat, or retained connection",
        beforePolicyProbe.worlds === 0
        && beforePolicyProbe.players === 0
        && beforePolicyProbe.connections === 0
        && beforePolicyWorlds.length === 0
        && afterPolicyProbe.worlds === 0
        && afterPolicyProbe.players === 0
        && afterPolicyProbe.connections === 0
        && (await probe.worlds()).length === 0);

      const expires = Math.floor(Date.now() / 1000) + 60;
      const canonical = {
        pid: POLICY_PROBE_SUBJECT,
        exp: expires,
        wld: `${POLICY_PROBE_WORLD_PREFIX}0123456789abcdef`,
        pp: "private_draft_v1",
        pr: POLICY_PROBE_PURPOSE,
      };
      const validTicket = mintPolicyParserProbeTicket(
        GS_SECRET,
        60,
        Date.now(),
        "fedcba9876543210",
      );
      const malformedTickets = [
        ["missing policy", signProbePayload({
          pid: canonical.pid, exp: canonical.exp, wld: canonical.wld, pr: canonical.pr,
        })],
        ["unknown policy", signProbePayload({ ...canonical, pp: "future_public_v1" })],
        ["wrong subject", signProbePayload({ ...canonical, pid: "synthetic-verify" })],
        ["wrong namespace", signProbePayload({ ...canonical, wld: "verify:wrong" })],
        ["normal PVP world", signProbePayload({ ...canonical, wld: "pvp:room:PROB:g1" })],
        ["wrong purpose", signProbePayload({ ...canonical, pr: "synthetic_join" })],
        ["missing purpose", signProbePayload({
          pid: canonical.pid, exp: canonical.exp, wld: canonical.wld, pp: canonical.pp,
        })],
        ["wrong key order", signProbePayload({
          exp: canonical.exp,
          pid: canonical.pid,
          wld: canonical.wld,
          pp: canonical.pp,
          pr: canonical.pr,
        })],
        ["wrong version", signProbePayload(canonical, "v1")],
        ["forged signature", `${validTicket.slice(0, -1)}${validTicket.endsWith("a") ? "b" : "a"}`],
      ] as const;
      for (const [label, ticket] of malformedTickets) {
        const frame = await sendPolicyProbeTicket(gs.port, ticket);
        t.check(`${label} probe rejects without authority acknowledgement`,
          frame.t === "error" && frame.depth !== POLICY_PROBE_PURPOSE,
          `frame=${JSON.stringify(frame)}`);
      }
      let afterRejects = await probe.status();
      for (let attempt = 0; attempt < 100 && afterRejects.connections !== 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        afterRejects = await probe.status();
      }
      t.check("probe rejects leave all gameplay authority state empty",
        afterRejects.worlds === 0
        && afterRejects.players === 0
        && afterRejects.connections === 0
        && (await probe.worlds()).length === 0);

      const mismatchedVersionServer = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          ...versionBase,
          pvpPolicies: ["private_draft_v1", "future_public_v1"],
        }));
      });
      await new Promise<void>((resolve) => mismatchedVersionServer.listen(0, "127.0.0.1", resolve));
      const mismatchAddress = mismatchedVersionServer.address();
      if (mismatchAddress === null || typeof mismatchAddress === "string") {
        throw new Error("version mismatch server did not bind");
      }
      const mismatchProbe = new HttpGameServerProbe(
        {
          baseUrl: `http://127.0.0.1:${mismatchAddress.port}`,
          wsUrl: `ws://127.0.0.1:${gs.port}/ws`,
          logOutFile: null,
          syntheticTicketSecret: GS_SECRET,
          controlSecret: GS_CONTROL_SECRET,
          logTailMax: 100,
        },
        new NodeTailReader(),
      );
      const mismatchResult = await mismatchProbe.verifyForDeploy();
      t.check("advertised constants cannot hide a mismatched deployed policy catalog",
        !mismatchResult.ok
        && mismatchResult.depth === "http_only"
        && mismatchResult.detail === "pvp_policy_catalog_mismatch");
      await new Promise<void>((resolve) => mismatchedVersionServer.close(() => resolve()));

      const verify = await probe.verifyForDeploy();
      t.check("full VERIFY requires parser acknowledgement plus ordinary synthetic liveness",
        verify.ok && verify.depth === "policy_v2_parser+synthetic_join",
        `ok=${verify.ok} depth=${verify.depth} detail=${verify.detail ?? ""}`);
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
      socket.send(JSON.stringify({
        t: "join",
        ticket: mintGsTicket(GS_SECRET, "synthetic-verify", 60, Date.now(), {
          worldId: "verify:OPSX",
          name: "PanelPlayer",
          isSyntheticVerify: true,
        }),
        protocol: SYNTHETIC_JOIN_PROTOCOL,
      }));
      const decoded = await decodedFrame;
      t.check("shared decoder validates v33 synthetic self spawn-protection fields",
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
        room = (await probe.worlds()).find((w) => w.id === "verify:OPSX");
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
        { baseUrl: `http://127.0.0.1:${gs.port}`, wsUrl: `ws://127.0.0.1:${gs.port}/ws`, logOutFile: null, syntheticTicketSecret: null, controlSecret: null, logTailMax: 100 },
        new NodeTailReader(),
      );
      const diagnostic = await probe.verifyDiagnostic();
      t.check("credential-free ws liveness remains diagnostic-only",
        diagnostic.ok && diagnostic.depth === "ws_liveness",
        `ok=${diagnostic.ok} depth=${diagnostic.depth}`);
      const deployVerify = await probe.verifyForDeploy();
      t.check("credential-free deploy verification fails closed",
        !deployVerify.ok
        && deployVerify.depth === "http_only"
        && deployVerify.detail === "policy_probe_secret_missing");
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
        { baseUrl: `http://127.0.0.1:${gs.port}`, wsUrl: `ws://127.0.0.1:${gs.port}/ws`, logOutFile: null, syntheticTicketSecret: GS_SECRET, controlSecret: GS_CONTROL_SECRET, logTailMax: 100 },
        new NodeTailReader(),
      );
      const pm2 = new FakePm2();
      const reload = pm2.reload.bind(pm2);
      pm2.reload = async (app) => {
        await reload(app);
        await fetch(`http://127.0.0.1:${gs.port}/admin/resume`, { method: "POST" });
      };
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
