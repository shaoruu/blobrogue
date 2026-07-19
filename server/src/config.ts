// Server configuration, parsed once from the environment and VALIDATED (fail fast on junk — a
// negative heartbeat or zero queue silently disabling a protection is worse than refusing to
// boot). Bind defaults to 127.0.0.1:8090 (ops spec §6): the game port is NEVER exposed publicly
// — nginx terminates wss on 443 and reverse-proxies to this loopback port. /healthz + /metrics
// also bind loopback and are not proxied to the internet.

import { RESUME_GRACE_MS } from "../../src/net/protocol.js";
import { PVP_PRIVATE_ENABLED, PVP_PUBLIC_ENABLED } from "../../src/net/pvpFlag.js";
import { authConfigFromEnv, type AuthConfig } from "./auth.js";

export interface ServerConfig {
  host: string;
  port: number;
  wsPath: string;
  auth: AuthConfig;
  controlSecret: string | null;
  receiptSecret: string | null;
  receiptEndpoint: string | null;
  admissionEndpoint: string | null;
  generationStatePath: string | null;
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
  // Reconnect grace: how long an unexpectedly-disconnected player's body/state is reserved
  // (absent + safe) before the authoritative leave applies. 0 disables seats entirely.
  resumeGraceMs: number;
  // Silent-drop detection (studio balance gate §6: "invulnerable/non-targeting after 3s
  // disconnect detection"): a connection that delivers NO inbound traffic for this long has
  // its body marked absent/safe immediately — without waiting for the heartbeat timeout to
  // close the socket — and restored the moment traffic resumes. 0 disables the fast path.
  absenceDetectMs: number;
  // interest management: per-client snapshot radius in px (0 disables filtering)
  interestRadius: number;
  // Measurement mode: build an OPEN arena world (no dungeon walls) so the load harness can move a
  // probe in a straight monotonic line for render-latency correlation. Production runs the real
  // dungeon (same stepWorld/tick/netcode); this only changes map geometry. Default off.
  arena: boolean;
  // Independent outer rollout guards. Signed room policy remains mandatory even in tests that
  // override one guard. Neither is env-configurable, so ops cannot bypass coordinated releases.
  pvpPublicEnabled: boolean;
  pvpPrivateEnabled: boolean;
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
  const auth = authConfigFromEnv(env);
  const controlSecret = env.GS_CONTROL_SECRET && env.GS_CONTROL_SECRET.length > 0
    ? env.GS_CONTROL_SECRET
    : null;
  const receiptSecret = env.GS_RECEIPT_SECRET && env.GS_RECEIPT_SECRET.length > 0
    ? env.GS_RECEIPT_SECRET
    : null;
  if (controlSecret !== null && (controlSecret === auth.secret || controlSecret === receiptSecret)) {
    throw new Error("GS_CONTROL_SECRET must be distinct from GS_AUTH_SECRET and GS_RECEIPT_SECRET");
  }
  return {
    host: env.GS_HOST ?? "127.0.0.1",
    port: intEnv(env, "PORT", 8090, 0, 65535),
    wsPath: env.GS_WS_PATH ?? "/ws",
    auth,
    controlSecret,
    receiptSecret,
    receiptEndpoint: env.GS_CONVEX_RECEIPT_URL && env.GS_CONVEX_RECEIPT_URL.length > 0
      ? env.GS_CONVEX_RECEIPT_URL
      : null,
    admissionEndpoint: env.GS_CONVEX_ADMISSION_URL && env.GS_CONVEX_ADMISSION_URL.length > 0
      ? env.GS_CONVEX_ADMISSION_URL
      : null,
    generationStatePath: env.GS_GENERATION_STATE_PATH && env.GS_GENERATION_STATE_PATH.length > 0
      ? env.GS_GENERATION_STATE_PATH
      : null,
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
    // 2s pings keep a healthy connection's inbound gap under the 3s absence-detection window
    // (a paused/backgrounded tab still pongs), so soft absence can never flicker on a live
    // link; 3 misses still close a truly dead socket in ~6s -> seat reservation.
    heartbeatMs: intEnv(env, "GS_HEARTBEAT_MS", 2000, 50, 600000),
    heartbeatMisses: intEnv(env, "GS_HEARTBEAT_MISSES", 3, 1, 100),
    sendBufferLimit: intEnv(env, "GS_SEND_BUFFER_LIMIT", 256 * 1024, 1024, 1 << 30),
    slowClientKickBytes: intEnv(env, "GS_SLOW_CLIENT_KICK_BYTES", 1024 * 1024, 1024, 1 << 30),
    maxStarveTicks: intEnv(env, "GS_MAX_STARVE_TICKS", 10, 0, 1000),
    offerTtlMs: intEnv(env, "GS_OFFER_TTL_MS", 60000, 1000, 3600000),
    resumeGraceMs: intEnv(env, "GS_RESUME_GRACE_MS", RESUME_GRACE_MS, 0, 600000),
    absenceDetectMs: intEnv(env, "GS_ABSENCE_DETECT_MS", 3000, 0, 60000),
    // Interest filtering defaults OFF (full snapshots) after the Sev-0 room-divergence
    // incident: filtering may only be re-enabled explicitly (GS_INTEREST_RADIUS=1100, ~1.5x
    // viewport half-extent) once the coherence suite + the staged rollout criteria in
    // MULTIPLAYER.md §7 have been verified against the deployed build.
    interestRadius: intEnv(env, "GS_INTEREST_RADIUS", 0, 0, 100000),
    arena: env.GS_ARENA === "1",
    // Mirrors the shared build flag (no env override by design — see the field doc).
    pvpPublicEnabled: PVP_PUBLIC_ENABLED,
    pvpPrivateEnabled: PVP_PRIVATE_ENABLED,
  };
}
