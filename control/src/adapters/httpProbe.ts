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

// The game protocol version the synthetic join speaks. Must equal src/net/protocol.ts
// PROTOCOL_VERSION (the control build cannot import across its rootDir, so the value is
// mirrored here); control/test/integration.test.ts locks the two together and additionally
// joins a REAL gs, so drift fails loudly.
// v8: Patch's shop room (dealer pickups off the wire, `shop` snapshot state, the shopBuy
// command + event) + the bestiary wave (new enemy kinds/moves/hazard kinds + the
// EnemyWire aux channel) — disjoint wire growth sharing one version.
// v9: the remote-dash sync — PlayerWire grows the dash/invuln readout block
// (dti/ddx/ddy/dnv/inv) so observing clients render a teammate's dash.
// v10: the weapon effect wave (snapshot `effs` weapon-effect entities + SelfWire `chg`
// charge reconcile + the effect events) on top of the dash + shop + bestiary wire.
// v11: the hotbar cap (MAX_OWNED_WEAPONS) + the client->server `swap` command that claims
// a weapon pickup at the cap by trading an owned weapon for it.
// v12: the weapon rarity + mystery wave (five legendary WeaponIds, hidden-identity
// mystery pickups/pedestals via `myst`, the mysteryReveal + implosion events).
// v13: the earned-windows boss rework + fair-surprise layer — the enemy kind set grew
// (the Weaver's `knot` and `sac` mechanic bodies) and the hazard kind set grew
// (`omen`, the ambush pre-spawn tell); no new wire fields (guard/exposed rides aux).
// v14: the premium coin economy (premium stall slot kinds + mode on the shop wire,
// SelfWire premium run state).
// v15: the co-op game-feel pass — a new friendlyNudge event (the playful friendly-fire
// bonk) + the shot/meleeSwing/playerHurt/heal/pickup events reclassified to "pos" scope
// so a networked player's actions reach nearby observers, not only the actor.
// v16: the Wave 1 seeded-randomness layer — the snapshot carries `pcl` (the floor-locked
// co-op count the client resolves the mutator/affix descriptor with) and the enemy wire
// carries `afx` (a rolled elite's affix id) for its material tell.
// v17: the Wave 1 DEEP BOSSES (The Sump F35–45) — the enemy wire's closed kind + move sets
// grew (jet/tithe/tithe_slab/quorum/quorum_shield/quorum_heal/quorum_dmg + mirror/merge);
// no new struct field (they reuse bph/aux/hp/afs/atk).
// v18: the KIT/CLASS + ULT + account-MASTERY system — SelfWire grows the kit/ult block
// (kit/uc/ura/ovt/phs/uiv/pst), the input command grows the `ult` requested bit, the
// effect-entity kind set grew (sanctuary/aegis), four ult SimEvents joined the wire, and the
// join ticket carries the validated kit + mastery level claim (kt/ml).
// v19: the Wave 1 deep-boss rework — the enemy attack-move wire set grew four values
// (tracer/beam/spew/hurl) for the reworked JET/TITHE/QUORUM movesets; no new struct field.
// v20: two new enemy kinds (tithe_tribute, quorum_splinter) for the 4p surplus content.
// v21: EnemyWire grows `brr` (boss transition-beat-live flag) for the boss state/art binding.
// v22: EnemyWire grows `mfm` (JET mirror-salvo lead Resonance-family index) for the telegraph.
// v23: the AttackMove set grows "rip" (the Tithe's dedicated P3 debris-wheel signature).
// v24: the snapshot DELTA wire — `snap` carries `sseq`, a new `snapd` delta message carries
// per-baseline changes, and `input` carries `ackSnap` (the client's retained baseline sseq).
// v25: Wave 2 kit signatures — SelfWire grows ovh/osh/pra (Gunner overheat / Bulwark overshield
// / Mender pulse-CD), `input` grows a `pulse` bit, and EnemyWire grows `mkt` (Phantom mark).
// v26: JET's surprise layer — a new enemy kind `jet_echo` + EnemyWire `mir` (the mirrored
// PlayerId), and a new dynamic HazardKind `corrupt` (the per-phase arena-corruption drain zone).
// v27: the GORGE F50 giant — new enemy kinds `gorge` + `gorge_seam` and a new PropKind
// `gorge_debris` (the shell phase rides bph + the exposed state rides aux, so no new EnemyWire field).
// v28: the PVP MVP — PlayerWire.tm (FFA team), SelfWire.rsp (respawn countdown), the top-level
// `match` block, and the reliable pvpKill / pvpMatchOver events (all inert in co-op).
// v29: PVP Wave 1 reliable presentation events (ring-out, chain-frag, sudden-death).
// v30: distinct authoritative PvP hard-grace and spawn-shield ticks.
// v31: authoritative PvP shield-break event before its offense.
// v32: shared spawn protection end ticks and held-offense arming feedback.
export const SYNTHETIC_JOIN_PROTOCOL = 32;

interface SyntheticSpawnSelf {
  spo?: number;
  sge?: number;
  sse?: number;
  sgr?: number;
  ssh?: number;
  sfl?: boolean;
}

export function isSyntheticSpawnProtectionSelf(value: object): boolean {
  const self = value as SyntheticSpawnSelf;
  const ticks = [self.spo, self.sge, self.sse, self.sgr, self.ssh];
  if (!ticks.every((tick) => Number.isSafeInteger(tick) && (tick ?? -1) >= 0)) return false;
  if (typeof self.sfl !== "boolean") return false;
  return (self.spo ?? 0) === 0
    || ((self.sge ?? 0) >= (self.spo ?? 0) && (self.sse ?? 0) >= (self.sge ?? 0));
}

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
    // Real per-world occupancy from gs /worlds: which worlds exist, how many players each
    // holds, and WHO is in each — the panel view that shows whether a room's members
    // actually share one world. Every field is runtime-validated (the shape is a loose
    // cast at the fetch boundary). Falls back to the healthz aggregate against an older gs.
    const raw = await this.getJsonShaped<{ worlds?: Array<Partial<WorldSummary>> }>(`${this.cfg.baseUrl}/worlds`);
    if (raw !== null && Array.isArray(raw.worlds)) {
      const out: WorldSummary[] = [];
      for (const e of raw.worlds) {
        if (typeof e !== "object" || e === null) continue;
        out.push({
          id: typeof e.id === "string" ? e.id : "unnamed",
          players: typeof e.players === "number" && Number.isFinite(e.players) ? e.players : 0,
          tick: typeof e.tick === "number" && Number.isFinite(e.tick) ? e.tick : 0,
          names: Array.isArray(e.names) ? e.names.filter((n): n is string => typeof n === "string") : [],
          away: Array.isArray(e.away) ? e.away.filter((n): n is string => typeof n === "string") : [],
        });
      }
      return out;
    }
    const h = await this.getJson(`${this.cfg.baseUrl}/healthz`);
    if (h === null) return [];
    return [{ id: "gs-aggregate", players: numField(h, "players"), tick: 0, names: [], away: [] }];
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
          try { ws.send(JSON.stringify({ t: "join", ticket, protocol: SYNTHETIC_JOIN_PROTOCOL })); } catch { finish(false, "ws_liveness", "send_failed"); }
        }
        // Without a secret, receiving ANY server frame (e.g. a heartbeat ping) proves the WS
        // server + tick/heartbeat loop are alive.
      });
      ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
        const text = Buffer.isBuffer(data) ? data.toString("utf8") : Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data).toString("utf8");
        let msg: unknown;
        try { msg = JSON.parse(text); } catch { return; }
        if (typeof msg !== "object" || msg === null) return;
        const m = msg as { t?: string; self?: object | null };
        if (secret !== null) {
          if (m.t === "snap" && m.self !== null && m.self !== undefined) {
            if (isSyntheticSpawnProtectionSelf(m.self)) finish(true, "synthetic_join", null);
            else finish(false, "ws_liveness", "join_snap_invalid");
          }
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
    return this.getJsonShaped<Record<string, LogValue>>(url);
  }

  // Fetch + parse JSON as a caller-declared loose shape. The shape is a boundary cast, so
  // callers must runtime-validate every field they read (all of them do).
  private async getJsonShaped<T extends object>(url: string): Promise<T | null> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const obj: unknown = await res.json();
      if (typeof obj !== "object" || obj === null) return null;
      return obj as T;
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
