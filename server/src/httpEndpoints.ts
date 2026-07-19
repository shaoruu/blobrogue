// HTTP endpoints (loopback only; never proxied publicly): /healthz, /metrics, /worlds, and a
// local-only /dev-ticket. Extracted from the socket server as a pure request handler over
// injected deps, so observability + the dev mint aren't tangled into the transport. None of
// these bind beyond loopback and none are exposed to the internet (ops spec §7).

import type { IncomingMessage, ServerResponse } from "node:http";
import { mintTicket, isValidWorldId, sanitizeDisplayName, type TicketClaims } from "./auth.js";
import type { ServerConfig } from "./config.js";
import type { HealthReport } from "./metrics.js";
import { PROTOCOL_VERSION } from "../../src/net/protocol.js";
import { GENERATION_ADMISSION_PREFIX } from "../../src/net/generationAdmission.js";
import { PRIVATE_DRAFT_PVP_POLICY } from "../../src/net/pvpPolicy.js";
import type { AdminPlayerLoadout } from "../../src/sim/world.js";
import {
  verifyControlWorldAction,
  MAX_CONTROL_FLOOR,
  type ControlWorldAction,
} from "./controlAuth.js";
import type { AdminPlayerLoadoutResult } from "./ports.js";

// One live world, as exposed to the control panel: which world exists, how many players it
// holds, its tick, WHO is connected (display names, ordered by join), and whose seats are
// reserved for a reconnect — the ops-facing view that answers "did both room members
// actually land in one world?" and "who is mid-outage?" without log spelunking.
export interface WorldReport {
  id: string;
  players: number;
  tick: number;
  floor: number;
  names: string[];
  away: string[];
}

export type ControlWorldActionResult =
  | {
    isApplied: true;
    worldId: string;
    floor: number;
    players: number;
    loadouts?: AdminPlayerLoadoutResult[];
  }
  | { isApplied: false; reason: "world_not_found" | "pvp_forbidden" };

export interface HttpDeps {
  config: ServerConfig;
  health: () => HealthReport;
  worlds: () => WorldReport[];
  lifecycle: (action: "drain" | "flush" | "resume") => void;
  controlWorld: (action: ControlWorldAction) => ControlWorldActionResult;
}

export function createHttpHandler(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const usedControlJtis = new Map<string, number>();
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST") {
      if (url.pathname === "/admin/world-action") {
        void handleControlWorldAction(deps, usedControlJtis, req, res);
        return;
      }
      const match = /^\/admin\/(drain|flush|resume)$/.exec(url.pathname);
      if (match) {
        deps.lifecycle(match[1] as "drain" | "flush" | "resume");
        res.writeHead(204).end();
        return;
      }
    }
    if (req.method !== "GET") { res.writeHead(405).end(); return; }

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(deps.health()));
      return;
    }

    if (url.pathname === "/metrics") {
      const h = deps.health();
      const { counters, status, ...scalars } = h;
      // Flat JSON of every metric (counters + tick/snapshot/rtt/reconciliation gauges). A
      // Prometheus text exposition is a trivial later reformat behind the same numbers.
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status, ...scalars, ...counters }));
      return;
    }

    if (url.pathname === "/worlds") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ worlds: deps.worlds() }));
      return;
    }

    if (url.pathname === "/version") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        protocol: PROTOCOL_VERSION,
        coopTicket: "v1",
        pvpTicket: "v2",
        admission: GENERATION_ADMISSION_PREFIX,
        pvpPolicies: [PRIVATE_DRAFT_PVP_POLICY],
        pvpPrivateEnabled: deps.config.pvpPrivateEnabled,
        pvpPublicEnabled: deps.config.pvpPublicEnabled,
      }));
      return;
    }

    if (url.pathname === "/dev-ticket") {
      // Local-only convenience: mint a ticket for a browser tab without a Convex minter. Enabled
      // ONLY when the dev bypass is on (hard-disabled in production). Mirrors the production
      // minter's optional claims so the two-tab proof covers room-scoped worlds + identity:
      // ?world=<worldId>&name=<displayName>&color=<index>&hat=<id>&face=<id>.
      if (!deps.config.auth.allowDev) { res.writeHead(404).end(); return; }
      const playerId = (url.searchParams.get("playerId") ?? "guest-" + Math.random().toString(36).slice(2, 8)).slice(0, 48);
      const claims: TicketClaims = {};
      const world = url.searchParams.get("world");
      if (world !== null && isValidWorldId(world)) claims.worldId = world;
      const name = url.searchParams.get("name");
      const cleanName = name !== null ? sanitizeDisplayName(name) : null;
      if (cleanName !== null) claims.name = cleanName;
      const colorRaw = url.searchParams.get("color");
      if (colorRaw !== null && colorRaw !== "") {
        const color = Number(colorRaw);
        if (Number.isInteger(color) && color >= 0 && color <= 15) claims.colorIndex = color;
      }
      const hat = url.searchParams.get("hat");
      if (hat !== null && /^[a-z0-9_]{1,24}$/.test(hat)) claims.hat = hat;
      const face = url.searchParams.get("face");
      if (face !== null && /^[a-z0-9_]{1,24}$/.test(face)) claims.face = face;
      const pet = url.searchParams.get("pet");
      if (pet !== null && /^[a-z0-9_]{1,24}$/.test(pet)) claims.pet = pet;
      const ticket = deps.config.auth.secret
        ? mintTicket(deps.config.auth.secret, playerId, undefined, undefined, claims)
        : "dev:" + playerId + (claims.worldId !== undefined ? "@" + claims.worldId : "");
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }).end(JSON.stringify({ ticket, playerId }));
      return;
    }

    res.writeHead(404).end();
  };
}

async function handleControlWorldAction(
  deps: HttpDeps,
  usedJtis: Map<string, number>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req, 12 * 1024);
  if (body === null) {
    res.writeHead(413).end();
    return;
  }
  const action = parseControlWorldAction(body);
  if (action === null) {
    res.writeHead(400).end();
    return;
  }
  const auth = verifyControlWorldAction(
    deps.config.controlSecret,
    typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
    action,
  );
  if (!auth.isValid) {
    res.writeHead(401).end();
    return;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [jti, exp] of usedJtis) if (exp <= nowSec) usedJtis.delete(jti);
  if (usedJtis.has(auth.jti)) {
    res.writeHead(409).end();
    return;
  }
  usedJtis.set(auth.jti, auth.exp);
  const result = deps.controlWorld(action);
  const status = result.isApplied ? 200 : result.reason === "world_not_found" ? 404 : 409;
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  }).end(JSON.stringify(result));
}

function parseControlWorldAction(body: string): ControlWorldAction | null {
  let value: ControlWorldAction | null;
  try {
    value = JSON.parse(body) as ControlWorldAction | null;
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  if (value.action === "warp") {
    const keys = Object.keys(value);
    if ((keys.length !== 3 && keys.length !== 4)
      || keys.some((key) => !["action", "worldId", "floor", "loadouts"].includes(key))
      || !isValidWorldId(value.worldId)
      || !Number.isSafeInteger(value.floor)
      || value.floor < 1
      || value.floor > MAX_CONTROL_FLOOR
      || !isAdminLoadouts(value.loadouts)) {
      return null;
    }
    return value;
  }
  if (value.action === "force-open-exit") {
    if (Object.keys(value).length !== 2 || !isValidWorldId(value.worldId)) return null;
    return value;
  }
  return null;
}

function isAdminLoadouts(loadouts: AdminPlayerLoadout[] | undefined): boolean {
  if (loadouts === undefined) return true;
  if (!Array.isArray(loadouts) || loadouts.length > 4) return false;
  const players = new Set<string>();
  for (const loadout of loadouts) {
    if (typeof loadout !== "object" || loadout === null) return false;
    const keys = Object.keys(loadout);
    if (keys.length < 1
      || keys.some((key) => !["player", "weapons", "blessings", "kitId", "hp"].includes(key))
      || typeof loadout.player !== "string"
      || loadout.player.length < 1
      || loadout.player.length > 48
      || players.has(loadout.player)) {
      return false;
    }
    players.add(loadout.player);
    if (loadout.weapons !== undefined) {
      if (!Array.isArray(loadout.weapons)
        || loadout.weapons.length > 9
        || loadout.weapons.some((id) => typeof id !== "string" || !/^[a-z0-9_]{1,32}$/.test(id))
        || new Set(loadout.weapons).size !== loadout.weapons.length) {
        return false;
      }
    }
    if (loadout.blessings !== undefined) {
      if (!Array.isArray(loadout.blessings) || loadout.blessings.length > 64) return false;
      const blessingIds = new Set<string>();
      for (const blessing of loadout.blessings) {
        if (typeof blessing !== "object"
          || blessing === null
          || Object.keys(blessing).length !== 2
          || typeof blessing.id !== "string"
          || !/^[a-z0-9_]{1,48}$/.test(blessing.id)
          || blessingIds.has(blessing.id)
          || !Number.isSafeInteger(blessing.lvl)
          || blessing.lvl < 1
          || blessing.lvl > 3) {
          return false;
        }
        blessingIds.add(blessing.id);
      }
    }
    if (loadout.kitId !== undefined
      && (typeof loadout.kitId !== "string" || !/^[a-z0-9_]{1,24}$/.test(loadout.kitId))) {
      return false;
    }
    if (loadout.hp !== undefined
      && (typeof loadout.hp !== "number"
        || !Number.isFinite(loadout.hp)
        || loadout.hp <= 0
        || loadout.hp > 1000)) {
      return false;
    }
  }
  return true;
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let isOverLimit = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) isOverLimit = true;
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(isOverLimit ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}
