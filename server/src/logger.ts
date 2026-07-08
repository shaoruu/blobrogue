// Structured JSON logging (production spec §6). One line of JSON per event with a level +
// context, written to stdout so pm2 captures it into the per-app log files. NEVER called on
// the per-tick / per-message hot path at info level (that would be a firehose) — lifecycle,
// errors, and deploy/restart events only; hot-path detail is debug-gated.
//
// A tiny purpose-built logger (not pino) keeps the server dependency surface to just `ws`;
// the shape (level/time/msg/context) is pino-compatible so a drop-in is trivial later.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogContext = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  child(base: LogContext): Logger;
}

function levelFromEnv(): LogLevel {
  const v = (process.env.GS_LOG_LEVEL ?? "info").toLowerCase();
  return v === "debug" || v === "info" || v === "warn" || v === "error" ? v : "info";
}

export function createLogger(base: LogContext = {}, minLevel: LogLevel = levelFromEnv()): Logger {
  const min = LEVEL_RANK[minLevel];
  const emit = (level: LogLevel, msg: string, ctx?: LogContext): void => {
    if (LEVEL_RANK[level] < min) return;
    const rec: Record<string, unknown> = { level, time: new Date().toISOString(), msg, ...base, ...ctx };
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
