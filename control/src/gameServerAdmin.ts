// The game server as an admin subject. Reads/verify delegate to the loopback probe; drain/flush/
// resume are best-effort lifecycle nudges (deferred to a graceful pm2 reload when gs doesn't
// implement them); restart reloads EXACTLY `blobrogue-gs` via the pm2 port. There is no path
// here that names any other app — town cannot be reloaded through this object.

import type { GameServerAdmin } from "./interfaces.js";
import type { GameServerProbe, Pm2Port } from "./ports.js";
import type {
  AdminEffectResult,
  GameServerStatus,
  LogQuery,
  LogRecord,
  MetricsSnapshot,
  Readiness,
  GameServerWorldActionResult,
  VerifyResult,
  WorldSummary,
} from "./types.js";

const GS_APP = "blobrogue-gs" as const;

export class DefaultGameServerAdmin implements GameServerAdmin {
  constructor(private probe: GameServerProbe, private pm2: Pm2Port) {}

  status(): Promise<GameServerStatus> {
    return this.probe.status();
  }
  readiness(): Promise<Readiness> {
    return this.probe.readiness();
  }
  metrics(): Promise<MetricsSnapshot> {
    return this.probe.metrics();
  }
  worlds(): Promise<WorldSummary[]> {
    return this.probe.worlds();
  }
  warpWorld(worldId: string, floor: number): Promise<GameServerWorldActionResult> {
    return this.probe.mutateWorld({ action: "warp", worldId, floor });
  }
  forceOpenWorldExit(worldId: string): Promise<GameServerWorldActionResult> {
    return this.probe.mutateWorld({ action: "force-open-exit", worldId });
  }
  snapshotWorld(worldId: string): Promise<GameServerWorldActionResult> {
    return this.probe.mutateWorld({ action: "snapshot", worldId });
  }
  restoreWorld(worldId: string): Promise<GameServerWorldActionResult> {
    return this.probe.mutateWorld({ action: "restore", worldId });
  }
  logs(q: LogQuery): Promise<LogRecord[]> {
    return this.probe.logs(q);
  }
  verifyDiagnostic(): Promise<VerifyResult> {
    return this.probe.verifyDiagnostic();
  }
  verifyForDeploy(): Promise<VerifyResult> {
    return this.probe.verifyForDeploy();
  }

  drain(): Promise<AdminEffectResult> {
    return this.probe.lifecycle("drain");
  }
  flush(): Promise<AdminEffectResult> {
    return this.probe.lifecycle("flush");
  }
  resume(): Promise<AdminEffectResult> {
    return this.probe.lifecycle("resume");
  }

  async restart(): Promise<void> {
    await this.pm2.reload(GS_APP);
  }
}
