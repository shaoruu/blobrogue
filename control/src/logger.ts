// Structured JSON logging for the control plane — same one-line-per-event shape as the game
// server, but every context value is run through the redactor so a token or secret can never
// reach stdout/pm2 logs. Not called on any hot path; lifecycle, auth decisions, and deploy
// transitions only.

import { redactValue } from "./redact.js";
import type { LogValue } from "./types.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogContext = Record<string, LogValue | undefined>;

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  child(base: LogContext): Logger;
}

function redactCtx(ctx: LogContext): LogContext {
  const out: LogContext = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (v === undefined) continue;
    out[k] = redactValue(k, v);
  }
  return out;
}

export function createLogger(base: LogContext = {}, minLevel: LogLevel = "info"): Logger {
  const min = LEVEL_RANK[minLevel];
  const safeBase = redactCtx(base);
  const emit = (level: LogLevel, msg: string, ctx?: LogContext): void => {
    if (LEVEL_RANK[level] < min) return;
    const rec = { level, time: new Date().toISOString(), msg, ...safeBase, ...(ctx ? redactCtx(ctx) : {}) };
    process.stdout.write(JSON.stringify(rec) + "\n");
  };
  return {
    debug: (m, c) => emit("debug", m, c),
    info: (m, c) => emit("info", m, c),
    warn: (m, c) => emit("warn", m, c),
    error: (m, c) => emit("error", m, c),
    child: (extra) => createLogger({ ...base, ...extra }, minLevel),
  };
}

export function levelFromEnv(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const v = (env.BRC_LOG_LEVEL ?? "info").toLowerCase();
  return v === "debug" || v === "info" || v === "warn" || v === "error" ? v : "info";
}
