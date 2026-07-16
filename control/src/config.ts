// Control-plane configuration, parsed once from the environment. Binds 127.0.0.1:8091 by
// default (loopback only; the admin panel proxies to it, nothing public reaches it directly).
// Secrets live in the box .env (chmod 600); this reads NAMES from process.env. See
// .env.example for the required variable names.

export interface ControlConfig {
  host: string;
  port: number;
  isProd: boolean;

  adminTokenSecret: string | null;
  confirmTokenSecret: string | null;
  tokenAudience: string;
  adminTokenMaxTtlSec: number;
  allowedOrigins: string[]; // empty = allow any (behind the token); use in prod to pin the panel
  allowDevAuth: boolean;

  rateCapacity: number;
  rateRefillPerSec: number;

  releasesRoot: string;
  retainedReleases: number;
  stateDir: string;
  logTailMax: number;

  gsBaseUrl: string;
  gsWsUrl: string;
  gsLogOutFile: string | null;
  gsSyntheticTicketSecret: string | null; // required in production; null permits diagnostics only
}

function intEnv(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const raw = env[key];
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

function strEnv(env: NodeJS.ProcessEnv, key: string, def: string): string {
  const v = env[key];
  return v !== undefined && v.length > 0 ? v : def;
}

function optEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const v = env[key];
  return v !== undefined && v.length > 0 ? v : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ControlConfig {
  const isProd = env.NODE_ENV === "production";
  const origins = (env.BRC_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const gsSyntheticTicketSecret = optEnv(env, "BRC_GS_SYNTHETIC_TICKET_SECRET");
  if (isProd && gsSyntheticTicketSecret === null) {
    throw new Error("policy_probe_secret_missing");
  }
  return {
    host: strEnv(env, "BRC_HOST", "127.0.0.1"),
    port: intEnv(env, "BRC_PORT", 8091),
    isProd,

    adminTokenSecret: optEnv(env, "BRC_ADMIN_TOKEN_SECRET"),
    confirmTokenSecret: optEnv(env, "BRC_CONFIRM_TOKEN_SECRET"),
    tokenAudience: strEnv(env, "BRC_TOKEN_AUDIENCE", "blobrogue-control"),
    adminTokenMaxTtlSec: intEnv(env, "BRC_ADMIN_TOKEN_MAX_TTL_SEC", 900),
    allowedOrigins: origins,
    allowDevAuth: !isProd && env.BRC_ALLOW_DEV_AUTH === "1",

    rateCapacity: intEnv(env, "BRC_RATE_CAPACITY", 30),
    rateRefillPerSec: intEnv(env, "BRC_RATE_REFILL_PER_SEC", 1),

    releasesRoot: strEnv(env, "BRC_RELEASES_ROOT", "/opt/blobrogue-gs"),
    retainedReleases: intEnv(env, "BRC_RETAINED_RELEASES", 5),
    stateDir: strEnv(env, "BRC_STATE_DIR", "/opt/blobrogue-control/state"),
    logTailMax: intEnv(env, "BRC_LOG_TAIL_MAX", 500),

    gsBaseUrl: strEnv(env, "BRC_GS_BASE_URL", "http://127.0.0.1:8090"),
    gsWsUrl: strEnv(env, "BRC_GS_WS_URL", "ws://127.0.0.1:8090/ws"),
    gsLogOutFile: optEnv(env, "BRC_GS_LOG_OUT_FILE"),
    gsSyntheticTicketSecret,
  };
}
