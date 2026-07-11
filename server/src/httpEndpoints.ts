// HTTP endpoints (loopback only; never proxied publicly): /healthz, /metrics, /worlds, and a
// local-only /dev-ticket. Extracted from the socket server as a pure request handler over
// injected deps, so observability + the dev mint aren't tangled into the transport. None of
// these bind beyond loopback and none are exposed to the internet (ops spec §7).

import type { IncomingMessage, ServerResponse } from "node:http";
import { mintTicket, isValidWorldId, sanitizeDisplayName, type TicketClaims } from "./auth.js";
import type { ServerConfig } from "./config.js";
import type { HealthReport } from "./metrics.js";

// One live world, as exposed to the control panel: which world exists, how many players it
// holds, its tick, WHO is connected (display names, ordered by join), and whose seats are
// reserved for a reconnect — the ops-facing view that answers "did both room members
// actually land in one world?" and "who is mid-outage?" without log spelunking.
export interface WorldReport {
  id: string;
  players: number;
  tick: number;
  names: string[];
  away: string[];
}

export interface HttpDeps {
  config: ServerConfig;
  health: () => HealthReport;
  worlds: () => WorldReport[];
}

export function createHttpHandler(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
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
