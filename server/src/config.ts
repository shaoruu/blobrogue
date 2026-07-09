// Server configuration, parsed once from the environment and VALIDATED (fail fast on junk — a
// negative heartbeat or zero queue silently disabling a protection is worse than refusing to
// boot). Bind defaults to 127.0.0.1:8090 (ops spec §6): the game port is NEVER exposed publicly
// — nginx terminates wss on 443 and reverse-proxies to this loopback port. /healthz + /metrics
// also bind loopback and are not proxied to the internet.

import { authConfigFromEnv, type AuthConfig } from "./auth.js";

export interface ServerConfig {
  host: string;
  port: number;
  wsPath: string;
  auth: AuthConfig;
  isProd: boolean;
  // Trusted reverse-proxy CIDRs. Only when the immediate peer matches one of these do we read the
  // real client IP from X-Forwarded-For / X-Real-IP (P0-4). Behind nginx this is loopback;
  // direct-exposed deployments should leave it as loopback so no client can spoof its per-IP
  // bucket via forwarded headers.
  trustedProxies: string[];
  // per-connection limits (production spec §3 / §2d)
  maxConnsPerIp: number;
  maxMsgsPerSec: number;      // aggregate inbound message cap per connection (all classes)
  // Per-class inbound caps (separate buckets so one class can't starve/kill another and a
  // high-refresh client's input stream stays far below the aggregate cap):
  maxInputPerSec: number;     // input intents (fixed-step cadence is ~20/s; cap leaves headroom)
  maxControlPerSec: number;   // join/equip/chooseBlessing (semantic commands)
  maxStatPerSec: number;      // telemetry uplink
  maxPongPerSec: number;      // heartbeat replies
  maxInputQueue: number;      // bounded input queue depth (backpressure)
  joinTimeoutMs: number;      // must send join within this window or get dropped
  heartbeatMs: number;        // ping interval
  heartbeatMisses: number;    // missed pongs tolerated before drop
  sendBufferLimit: number;    // ws.bufferedAmount threshold to skip a client this tick
  slowClientKickBytes: number;// sustained backpressure -> disconnect
  // continue-last-intent: repeat a player's last input for up to N starved ticks
  maxStarveTicks: number;
  // blessing offers expire after this long unanswered (bounded server state; the run moves on)
  offerTtlMs: number;
  // interest management: per-client snapshot radius in px (0 disables filtering)
  interestRadius: number;
  // Measurement mode: build an OPEN arena world (no dungeon walls) so the load harness can move a
  // probe in a straight monotonic line for render-latency correlation. Production runs the real
  // dungeon (same stepWorld/tick/netcode); this only changes map geometry. Default off.
  arena: boolean;
}

// Strict integer env parse: undefined/empty uses the default; anything else must be a finite
// integer within [min, max] or the server refuses to start (audit: config must fail fast, not
// silently run with a protection disabled).
function intEnv(env: NodeJS.ProcessEnv, key: string, def: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`invalid ${key}=${JSON.stringify(raw)} (expected integer in [${min}, ${max}])`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.GS_HOST ?? "127.0.0.1",
    port: intEnv(env, "PORT", 8090, 0, 65535),
    wsPath: env.GS_WS_PATH ?? "/ws",
    auth: authConfigFromEnv(env),
    isProd: env.NODE_ENV === "production",
    trustedProxies: (env.GS_TRUSTED_PROXIES ?? "127.0.0.1/32,::1/128").split(",").map((s) => s.trim()).filter((s) => s.length > 0),
    maxConnsPerIp: intEnv(env, "GS_MAX_CONNS_PER_IP", 16, 1, 10000),
    maxMsgsPerSec: intEnv(env, "GS_MAX_MSGS_PER_SEC", 120, 10, 100000),
    maxInputPerSec: intEnv(env, "GS_MAX_INPUT_PER_SEC", 60, 5, 100000),
    maxControlPerSec: intEnv(env, "GS_MAX_CONTROL_PER_SEC", 12, 1, 10000),
    maxStatPerSec: intEnv(env, "GS_MAX_STAT_PER_SEC", 6, 1, 10000),
    maxPongPerSec: intEnv(env, "GS_MAX_PONG_PER_SEC", 12, 1, 10000),
    maxInputQueue: intEnv(env, "GS_MAX_INPUT_QUEUE", 32, 1, 4096),
    joinTimeoutMs: intEnv(env, "GS_JOIN_TIMEOUT_MS", 5000, 100, 600000),
    heartbeatMs: intEnv(env, "GS_HEARTBEAT_MS", 5000, 50, 600000),
    heartbeatMisses: intEnv(env, "GS_HEARTBEAT_MISSES", 3, 1, 100),
    sendBufferLimit: intEnv(env, "GS_SEND_BUFFER_LIMIT", 256 * 1024, 1024, 1 << 30),
    slowClientKickBytes: intEnv(env, "GS_SLOW_CLIENT_KICK_BYTES", 1024 * 1024, 1024, 1 << 30),
    maxStarveTicks: intEnv(env, "GS_MAX_STARVE_TICKS", 10, 0, 1000),
    offerTtlMs: intEnv(env, "GS_OFFER_TTL_MS", 60000, 1000, 3600000),
    // Interest filtering defaults OFF (full snapshots) after the Sev-0 room-divergence
    // incident: filtering may only be re-enabled explicitly (GS_INTEREST_RADIUS=1100, ~1.5x
    // viewport half-extent) once the coherence suite + the staged rollout criteria in
    // MULTIPLAYER.md §7 have been verified against the deployed build.
    interestRadius: intEnv(env, "GS_INTEREST_RADIUS", 0, 0, 100000),
    arena: env.GS_ARENA === "1",
  };
}
