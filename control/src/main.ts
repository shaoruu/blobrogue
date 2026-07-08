// Entry point for blobrogue-control. Binds 127.0.0.1:8091 (loopback only; the admin panel
// proxies to it). Refuses to start in production without its token secrets — a control plane
// with no auth must never come up. On boot it recovers any operation interrupted by a prior
// crash so a reconnecting admin sees the true state. pm2 supervises the process.

import { loadConfig } from "./config.js";
import { createLogger, levelFromEnv } from "./logger.js";
import { createControlServer } from "./httpApi.js";
import { buildProductionDeps } from "./service.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger({ app: "blobrogue-control", pid: process.pid }, levelFromEnv());

  if (cfg.isProd && (cfg.adminTokenSecret === null || cfg.confirmTokenSecret === null)) {
    log.error("refusing to start: BRC_ADMIN_TOKEN_SECRET and BRC_CONFIRM_TOKEN_SECRET are required in production");
    process.exit(1);
  }
  if (cfg.allowDevAuth) log.warn("DEV AUTH BYPASS ENABLED (local only) — accepting dev:<actor> tokens");

  const deps = buildProductionDeps(cfg, log);
  const recovered = await deps.controller.recoverInterrupted();
  if (recovered > 0) log.warn("recovered interrupted operations on boot", { count: recovered });

  const server = createControlServer(deps);
  await server.listen();

  const shutdown = (sig: string): void => {
    log.info("shutting down", { sig });
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => log.error("uncaughtException", { err: String(err), stack: err.stack ?? "" }));
  process.on("unhandledRejection", (reason) => log.error("unhandledRejection", { reason: String(reason) }));
}

void main();
