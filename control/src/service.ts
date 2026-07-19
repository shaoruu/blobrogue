// Wiring: build the concrete adapters + domain objects from config and assemble ControlDeps.
// This is the ONLY place production host adapters (fs / pm2 / gs probe) are constructed; the
// tests build ControlDeps with in-memory fakes instead, so the same HTTP + controller code runs
// unchanged against real or faked hosts.

import { NodeFileSystem } from "./adapters/nodeFs.js";
import { HttpGameServerProbe } from "./adapters/httpProbe.js";
import { Pm2Exec } from "./adapters/pm2Exec.js";
import { NodeTailReader } from "./adapters/tail.js";
import { AuthGate } from "./auth/gate.js";
import { NonceStore } from "./auth/nonceStore.js";
import { RateLimiter } from "./auth/rateLimiter.js";
import { ChecksumArtifactVerifier } from "./artifactVerifier.js";
import type { ControlConfig } from "./config.js";
import { DeployController } from "./deployController.js";
import { DeployLock } from "./deployLock.js";
import { DefaultGameServerAdmin } from "./gameServerAdmin.js";
import type { ControlDeps } from "./httpApi.js";
import type { Logger } from "./logger.js";
import type { Clock } from "./ports.js";
import { FileAuditSink } from "./stores/auditSink.js";
import { FileOperationStore } from "./stores/operationStore.js";
import { FsReleaseStore } from "./stores/releaseStore.js";

export const systemClock: Clock = { now: () => Date.now() };

export function buildProductionDeps(cfg: ControlConfig, log: Logger, clock: Clock = systemClock): ControlDeps {
  const fs = new NodeFileSystem();
  const releases = new FsReleaseStore(fs, cfg.releasesRoot);
  const operations = new FileOperationStore(fs, cfg.stateDir);
  const audit = new FileAuditSink(fs, cfg.stateDir);
  const verifier = new ChecksumArtifactVerifier(fs, cfg.releasesRoot);

  const probe = new HttpGameServerProbe(
    {
      baseUrl: cfg.gsBaseUrl,
      wsUrl: cfg.gsWsUrl,
      logOutFile: cfg.gsLogOutFile,
      syntheticTicketSecret: cfg.gsSyntheticTicketSecret,
      controlSecret: cfg.gsControlSecret,
      logTailMax: cfg.logTailMax,
    },
    new NodeTailReader(),
  );
  const gameServer = new DefaultGameServerAdmin(probe, new Pm2Exec());

  const lock = new DeployLock();
  const controller = new DeployController({
    releases, operations, gameServer, verifier, audit, lock, clock, log, retainedReleases: cfg.retainedReleases,
  });

  const authGate = new AuthGate(cfg, new NonceStore(clock), new NonceStore(clock), clock);
  const rateLimiter = new RateLimiter(clock, cfg.rateCapacity, cfg.rateRefillPerSec);

  return { cfg, log, clock, releases, operations, gameServer, verifier, audit, controller, authGate, rateLimiter };
}
