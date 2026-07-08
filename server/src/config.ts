// Server configuration, parsed once from the environment. Bind defaults to 127.0.0.1:8090
// (ops spec §6): the game port is NEVER exposed publicly — nginx terminates wss on 443 and
// reverse-proxies to this loopback port. /healthz + /metrics also bind loopback and are not
// proxied to the internet.

import { authConfigFromEnv, type AuthConfig } from "./auth.js";

export interface ServerConfig {
  host: string;
  port: number;
  wsPath: string;
  auth: AuthConfig;
  isProd: boolean;
  // Trusted reverse-proxy CIDRs. Only when the immediate peer matches one of these do we read the
  // real client IP from X-Forwarded-For (P0-4). Behind nginx this is loopback; direct-exposed
  // deployments should leave it as loopback so no client can spoof its per-IP bucket via XFF.
  trustedProxies: string[];
  // per-connection limits (production spec §3 / §2d)
  maxConnsPerIp: number;
  maxMsgsPerSec: number;      // inbound message rate cap per connection
  maxInputQueue: number;      // bounded input queue depth (backpressure)
  joinTimeoutMs: number;      // must send join within this window or get dropped
  heartbeatMs: number;        // ping interval
  heartbeatMisses: number;    // missed pongs tolerated before drop
  sendBufferLimit: number;    // ws.bufferedAmount threshold to skip a client this tick
  slowClientKickBytes: number;// sustained backpressure -> disconnect
  // continue-last-intent: repeat a player's last input for up to N starved ticks
  maxStarveTicks: number;
  // anti-cheat step clamps
  maxInputDt: number;         // per-input dt cap (seconds)
  maxTickDtPerPlayer: number; // total simulated dt per player per tick (speed-hack cap)
  // interest management: per-client snapshot radius in px (0 disables filtering)
  interestRadius: number;
  // Measurement mode: build an OPEN arena world (no dungeon walls) so the load harness can move a
  // probe in a straight monotonic line for render-latency correlation. Production runs the real
  // dungeon (same stepWorld/tick/netcode); this only changes map geometry. Default off.
  arena: boolean;
}

function intEnv(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const raw = env[key];
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.GS_HOST ?? "127.0.0.1",
    port: intEnv(env, "PORT", 8090),
    wsPath: env.GS_WS_PATH ?? "/ws",
    auth: authConfigFromEnv(env),
    isProd: env.NODE_ENV === "production",
    trustedProxies: (env.GS_TRUSTED_PROXIES ?? "127.0.0.1/32,::1/128").split(",").map((s) => s.trim()).filter((s) => s.length > 0),
    maxConnsPerIp: intEnv(env, "GS_MAX_CONNS_PER_IP", 16),
    maxMsgsPerSec: intEnv(env, "GS_MAX_MSGS_PER_SEC", 120),
    maxInputQueue: intEnv(env, "GS_MAX_INPUT_QUEUE", 32),
    joinTimeoutMs: intEnv(env, "GS_JOIN_TIMEOUT_MS", 5000),
    heartbeatMs: intEnv(env, "GS_HEARTBEAT_MS", 5000),
    heartbeatMisses: intEnv(env, "GS_HEARTBEAT_MISSES", 3),
    sendBufferLimit: intEnv(env, "GS_SEND_BUFFER_LIMIT", 256 * 1024),
    slowClientKickBytes: intEnv(env, "GS_SLOW_CLIENT_KICK_BYTES", 1024 * 1024),
    maxStarveTicks: intEnv(env, "GS_MAX_STARVE_TICKS", 10),
    maxInputDt: 0.05,          // one server step; a client can't advance faster per input
    maxTickDtPerPlayer: 0.10,  // <= 2 ticks of movement per tick even under input floods
    interestRadius: intEnv(env, "GS_INTEREST_RADIUS", 1100), // ~1.5x viewport half-extent; 0 = off
    arena: env.GS_ARENA === "1",
  };
}
