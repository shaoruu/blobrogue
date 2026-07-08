// HTTP endpoints (loopback only; never proxied publicly): /healthz, /metrics, and a local-only
// /dev-ticket. Extracted from the socket server as a pure request handler over injected deps, so
// observability + the dev mint aren't tangled into the transport. /metrics + /healthz bind
// loopback and must not be exposed to the internet (ops spec §7).

import type { IncomingMessage, ServerResponse } from "node:http";
import { mintTicket } from "./auth.js";
import type { ServerConfig } from "./config.js";
import type { HealthReport } from "./metrics.js";

export interface HttpDeps {
  config: ServerConfig;
  health: () => HealthReport;
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

    if (url.pathname === "/dev-ticket") {
      // Local-only convenience: mint a ticket for a browser tab without a Convex minter. Enabled
      // ONLY when the dev bypass is on (hard-disabled in production).
      if (!deps.config.auth.allowDev) { res.writeHead(404).end(); return; }
      const playerId = (url.searchParams.get("playerId") ?? "guest-" + Math.random().toString(36).slice(2, 8)).slice(0, 48);
      const ticket = deps.config.auth.secret ? mintTicket(deps.config.auth.secret, playerId) : "dev:" + playerId;
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }).end(JSON.stringify({ ticket, playerId }));
      return;
    }

    res.writeHead(404).end();
  };
}
