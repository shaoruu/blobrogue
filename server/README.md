# blobrogue-gs — authoritative game server (Stage B)

A standalone Node + `ws` server that imports the **same** `src/sim/stepWorld` the client runs
and is the single source of truth for a networked world. Stage B is the first networked stage:
one arena world with a few server-owned enemies, 1–2 clients connecting over WebSocket that
predict their own movement and reconcile against authoritative snapshots. Solo play is
untouched — it stays on the in-process `LocalTransport` with zero sockets/serialization.

The server never trusts client-claimed outcomes: **clients send inputs, never positions, hits,
or kills.** All movement is clamped, all combat/AI runs in server `stepWorld`.

## Layout

```
server/src/        server process: ws + http, world registry, 20Hz tick, auth, rate limits,
                   heartbeat, backpressure, structured logs, /healthz + /metrics
server/harness/    headless measurement + adversity harness (real WSTransport over injected
                   RTT/jitter/loss) + a bot driver
server/test/       server + netcode assertion suite (the CI gate)
src/net/protocol.ts  shared wire contract + Codec seam (imported by client AND server)
src/client/wsTransport.ts  client transport: predict + reconcile + interpolate
```

## Run it locally (server + two browser clients)

The Stage-B world is a fixed arena; both clients see the same server-owned enemies.

1. **Install + start the server** (dev auth enabled so a local tab can mint a ticket without
   Convex — this is local-only and hard-disabled in production):

   ```sh
   cd server
   npm install
   GS_ALLOW_DEV_AUTH=1 GS_AUTH_SECRET=devsecret npm run dev
   # -> listening on 127.0.0.1:8090, ws path /ws
   ```

2. **Start the client (vite)** in another terminal from the repo root:

   ```sh
   npm install
   npm run dev
   # -> http://localhost:5173
   ```

3. **Open two tabs** at:

   ```
   http://localhost:5173/?gs=ws://127.0.0.1:8090/ws
   ```

   Each tab fetches a dev ticket from `http://127.0.0.1:8090/dev-ticket` (carrying the tab's
   chosen name/color), joins the same `arena-1` world, predicts its own blob (instant
   movement), and renders the same authoritative enemies plus the other player (interpolated,
   name above the blob). To prove ROOM isolation without Convex, mint per-tab tickets with a
   world claim: `curl "http://127.0.0.1:8090/dev-ticket?world=room:ABCD&name=Ada&color=2"` —
   tabs whose tickets share a `world` share a world; different worlds never meet.

The production player flow (`PLAY ONLINE` in the menu, or the `?online=1` deep link) goes
through the Convex-backed room lobby instead: create/join/quick-play a room, then the ticket
minted by `convex/gsTicket.ts` binds that room's world id, every snapshot echoes the bound
world id back for the client to assert, and a party start reveals gameplay only once the
whole room is on the server's own roster (see MULTIPLAYER.md §7). Solo is unaffected either
way.

## Health / metrics

```sh
curl http://127.0.0.1:8090/healthz   # { status, uptime, worlds, players, tick p50/p95/max }
curl http://127.0.0.1:8090/metrics   # counters + tick percentiles (JSON)
curl http://127.0.0.1:8090/worlds    # per-world occupancy: { id, players, tick, names } each
./healthcheck.sh                      # exits 0 iff status ok
```

Both bind loopback and must never be proxied to the internet (see `nginx.example.conf`).

## Tests + measurement

```sh
npm run typecheck   # tsc --noEmit (server + shared sim/protocol)
npm run build       # tsc emit -> dist/ (entry dist/server/src/main.js)
npm run test        # server + netcode assertion suite (auth, reconciliation, hostile input,
                    # heartbeat, two-client agreement, tick/bandwidth, anti-cheat)
npm run harness     # measured go/no-go report; env: GS_RTT GS_JITTER GS_LOSS GS_CLIENTS GS_SECONDS
```

## Production notes (Stage B scope)

- Bind `127.0.0.1:8090`; nginx terminates `wss://` on 443 and reverse-proxies to it
  (`nginx.example.conf`). No new firewall port.
- pm2 app `blobrogue-gs`, **fork / instances:1 (never cluster)**, `max_memory_restart 512M`,
  own logs — beside town, isolated (`ecosystem.config.cjs`).
- `GS_AUTH_SECRET` is required in production (the server refuses to start without it). The dev
  bypass (`GS_ALLOW_DEV_AUTH=1`) is refused when `NODE_ENV=production`.
- `deploy.sh` is a **template** (mirrors town's flow) — review before first use; this repo does
  not touch any live box.

Deferred to later stages (per the production matrix): lag compensation, reconnect/session
resume, interest management, binary/delta encoding, cross-process sharding.
