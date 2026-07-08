// Entry point for the blobrogue authoritative game server. Parses config from the environment,
// binds 127.0.0.1:PORT (nginx terminates wss on 443 -> this loopback port in production), and
// runs the fixed-tick authoritative loop. pm2 supervises the process (auto-restart, mem cap).

import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { GameServer } from "./server.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger({ app: "blobrogue-gs", pid: process.pid });

  if (cfg.isProd && !cfg.auth.secret) {
    log.error("refusing to start: GS_AUTH_SECRET is required in production");
    process.exit(1);
  }
  if (cfg.auth.allowDev) log.warn("DEV AUTH BYPASS ENABLED (local only) — accepting dev:<id> tickets");

  const server = new GameServer(cfg, { logger: log });
  await server.listen();

  const shutdown = (sig: string) => {
    log.info("shutting down", { sig });
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // A single connection's error is isolated per-message; this is a last-resort net so an
  // unforeseen async throw logs instead of taking the process down silently.
  process.on("uncaughtException", (err) => log.error("uncaughtException", { err: String(err), stack: err.stack ?? "" }));
  process.on("unhandledRejection", (reason) => log.error("unhandledRejection", { reason: String(reason) }));
}

void main();
