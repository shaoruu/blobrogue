// Real game-server probe over loopback. Reads /healthz + /metrics, tails the gs log file, and
// runs the layered VERIFY (HTTP -> WS liveness -> optional full synthetic join). The synthetic
// ticket secret, when configured, is used ONLY to mint a short-lived loopback verification ticket
// for a dedicated synthetic player id; it is never used to accept inbound control requests, so
// the control/game credential boundary holds. When gs does not implement a lifecycle endpoint,
// drain/flush/resume degrade to `deferred_to_reload` rather than failing a deploy.

import { createHmac } from "node:crypto";
import { WebSocket } from "ws";

import { redactFields } from "../redact.js";
import type { GameServerLifecycleAction, GameServerProbe } from "../ports.js";
import type {
  AdminEffectResult,
  GameServerStatus,
  LogQuery,
  LogRecord,
  LogValue,
  MetricsSnapshot,
  Readiness,
  VerifyResult,
  WorldSummary,
} from "../types.js";

export interface HttpProbeConfig {
  baseUrl: string;
  wsUrl: string;
  logOutFile: string | null;
  syntheticTicketSecret: string | null;
  logTailMax: number;
}

export interface TailReader {
  tail(path: string, maxLines: number): Promise<string[]>;
}

export class HttpGameServerProbe implements GameServerProbe {
  constructor(private cfg: HttpProbeConfig, private tailReader: TailReader) {}

  async status(): Promise<GameServerStatus> {
    const h = await this.getJson(`${this.cfg.baseUrl}/healthz`);
    if (h === null) return { status: "unreachable", uptimeSec: 0, worlds: 0, players: 0, connections: 0, tickMs_p50: 0, tickMs_p95: 0, tickMs_max: 0 };
    return {
      status: typeof h.status === "string" ? h.status : "unknown",
      uptimeSec: numField(h, "uptimeSec"),
      worlds: numField(h, "worlds"),
      players: numField(h, "players"),
      connections: numField(h, "connections"),
      tickMs_p50: numField(h, "tickMs_p50"),
      tickMs_p95: numField(h, "tickMs_p95"),
      tickMs_max: numField(h, "tickMs_max"),
    };
  }

  async readiness(): Promise<Readiness> {
    const h = await this.getJson(`${this.cfg.baseUrl}/healthz`);
    if (h === null) return { live: false, ready: false, detail: "healthz_unreachable" };
    const ok = h.status === "ok";
    return { live: true, ready: ok, detail: ok ? null : "status_not_ok" };
  }

  async metrics(): Promise<MetricsSnapshot> {
    const m = await this.getJson(`${this.cfg.baseUrl}/metrics`);
    if (m === null) return {};
    const out: MetricsSnapshot = {};
    for (const [k, v] of Object.entries(m)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    return out;
  }

  async worlds(): Promise<WorldSummary[]> {
    const h = await this.getJson(`${this.cfg.baseUrl}/healthz`);
    if (h === null) return [];
    // gs exposes an aggregate at Stage B (no per-world endpoint); surface it as one summary.
    return [{ id: "gs-aggregate", players: numField(h, "players"), tick: 0 }];
  }

  async logs(q: LogQuery): Promise<LogRecord[]> {
    if (this.cfg.logOutFile === null) return [];
    const limit = Math.min(q.limit, this.cfg.logTailMax);
    const lines = await this.tailReader.tail(this.cfg.logOutFile, limit * 2);
    const out: LogRecord[] = [];
    for (const line of lines) {
      const rec = parseLogLine(line);
      if (rec === null) continue;
      if (q.level !== null && rec.level !== q.level) continue;
      out.push({ time: rec.time, level: rec.level, msg: rec.msg, fields: redactFields(rec.fields) });
    }
    return out.slice(-limit);
  }

  async lifecycle(action: GameServerLifecycleAction): Promise<AdminEffectResult> {
    try {
      const res = await this.postWithTimeout(`${this.cfg.baseUrl}/admin/${action}`, 3000);
      if (res === null) return { mode: "deferred_to_reload", detail: "gs lifecycle endpoint unreachable" };
      if (res.status === 404) return { mode: "deferred_to_reload", detail: "gs lifecycle endpoint not implemented" };
      if (res.status >= 200 && res.status < 300) return { mode: "applied", detail: null };
      return { mode: "deferred_to_reload", detail: `gs lifecycle returned ${res.status}` };
    } catch {
      return { mode: "deferred_to_reload", detail: "gs lifecycle call errored" };
    }
  }

  async verify(): Promise<VerifyResult> {
    const readiness = await this.readiness();
    if (!readiness.ready) return { ok: false, depth: "http_only", detail: readiness.detail };

    const wsResult = await this.probeWs();
    if (!wsResult.ok) return { ok: false, depth: "ws_liveness", detail: wsResult.detail };
    if (wsResult.depth === "synthetic_join") return { ok: true, depth: "synthetic_join", detail: null };
    return { ok: true, depth: "ws_liveness", detail: null };
  }

  // ---- ws verification ----

  private probeWs(): Promise<{ ok: boolean; depth: "ws_liveness" | "synthetic_join"; detail: string | null }> {
    return new Promise((resolve) => {
      let settled = false;
      const ws = new WebSocket(this.cfg.wsUrl, { handshakeTimeout: 3000 });
      const timer = setTimeout(() => finish(false, "ws_liveness", "timeout"), 5000);
      const finish = (ok: boolean, depth: "ws_liveness" | "synthetic_join", detail: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* already closing */ }
        resolve({ ok, depth, detail });
      };

      const secret = this.cfg.syntheticTicketSecret;
      ws.on("open", () => {
        if (secret !== null) {
          const ticket = mintGsTicket(secret, "synthetic-verify", 60);
          // Mirrors PROTOCOL_VERSION in src/net/protocol.ts (v4: depth-progression
          // generator + hazards). The control plane is deliberately standalone (no
          // cross-repo imports), so the pin is by-hand: bump it with every protocol rev
          // or the synthetic join gets rejected and deploys mis-verify.
          try { ws.send(JSON.stringify({ t: "join", ticket, protocol: 4 })); } catch { finish(false, "ws_liveness", "send_failed"); }
        }
        // Without a secret, receiving ANY server frame (e.g. a heartbeat ping) proves the WS
        // server + tick/heartbeat loop are alive.
      });
      ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
        const text = Buffer.isBuffer(data) ? data.toString("utf8") : Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data).toString("utf8");
        let msg: unknown;
        try { msg = JSON.parse(text); } catch { return; }
        if (typeof msg !== "object" || msg === null) return;
        const m = msg as { t?: unknown; self?: unknown };
        if (secret !== null) {
          if (m.t === "snap" && m.self !== null && m.self !== undefined) finish(true, "synthetic_join", null);
          else if (m.t === "error") finish(false, "ws_liveness", "join_rejected");
        } else {
          finish(true, "ws_liveness", null);
        }
      });
      ws.on("error", (err) => finish(false, "ws_liveness", err instanceof Error ? err.message : "ws_error"));
    });
  }

  // ---- http helpers ----

  private async getJson(url: string): Promise<Record<string, LogValue> | null> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const obj: unknown = await res.json();
      if (typeof obj !== "object" || obj === null) return null;
      return obj as Record<string, LogValue>;
    } catch {
      return null;
    }
  }

  private async postWithTimeout(url: string, ms: number): Promise<{ status: number } | null> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), ms);
      const res = await fetch(url, { method: "POST", signal: ctrl.signal });
      clearTimeout(t);
      return { status: res.status };
    } catch {
      return null;
    }
  }
}

function numField(o: Record<string, LogValue>, k: string): number {
  const v = o[k];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

interface RawLog {
  time: string;
  level: string;
  msg: string;
  fields: Record<string, LogValue>;
}

function parseLogLine(line: string): RawLog | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, LogValue>;
  const fields: Record<string, LogValue> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === "time" || k === "level" || k === "msg") continue;
    fields[k] = v;
  }
  return {
    time: typeof o.time === "string" ? o.time : "",
    level: typeof o.level === "string" ? o.level : "info",
    msg: typeof o.msg === "string" ? o.msg : "",
    fields,
  };
}

// Mints a game ticket in the gs `v1.<b64url(payload)>.<hmac>` envelope. This mirrors the game
// server's own ticket format (the documented wire contract); the integration test boots the real
// gs and joins with a ticket minted here, which fails loudly if the format ever drifts.
function mintGsTicket(secret: string, playerId: string, ttlSec: number, nowMs = Date.now()): string {
  const payload = { pid: playerId, exp: Math.floor(nowMs / 1000) + ttlSec };
  const b64 = (buf: Buffer): string => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const body = "v1." + b64(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64(createHmac("sha256", secret).update(body).digest());
  return body + "." + sig;
}
