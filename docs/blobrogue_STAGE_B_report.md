# blobrogue — Stage B spike report (authoritative WS + prediction/reconciliation)

Stage B stands up the first networked stage on top of Stage A's pure `src/sim/stepWorld`: a
standalone Node + `ws` authoritative server, a client `WSTransport` that predicts the local
player and reconciles against server snapshots, remote entities via the shipped `interp.ts`,
and a headless measurement/adversity harness. Solo remains `LocalTransport`, byte-identical.

This is a **production-shaped authoritative proof**, not cosmetic sync: the server owns
player/world/enemy state, runs the same `stepWorld`, and clients send **inputs only** — no
client-claimed positions, hits, or kills exist in the protocol.

## What shipped

- **Server (`server/`)** — own package, imports the shared `src/sim`. `Map<worldId, GameWorld>`
  registry (one arena world active at B). Fixed **20Hz** drift-corrected accumulator on a
  monotonic clock. Per-player bounded input queue drained in seq order each tick; per-input dt
  and per-tick total-dt clamps (anti speed-hack); continue-last-intent on starvation. Snapshot
  every tick. The tick loop never awaits a socket send (bufferedAmount guard).
- **Protocol/Codec seam (`src/net/protocol.ts`)** — compact validated JSON now, `Codec`
  interface so binary is a later one-module swap. Client `join/input/pong`; server
  `snap/ping/error`. Tight wire structs (self/players/enemies/bullets) + `SimEvent`s. Strict
  decoder rejects unknown types, wrong shapes, non-finite/out-of-range numbers, oversized
  frames.
- **Production safety from the first socket** — per-connection `try/catch` isolation (malformed
  input can't reach the tick loop), HMAC auth-ticket verify seam with an **explicit local-only**
  dev bypass (hard-disabled when `NODE_ENV=production`), inbound message rate limit, join
  timeout, app-level heartbeat/timeout, output backpressure, per-IP connection cap, structured
  JSON logs, `/healthz` + `/metrics`. Binds `127.0.0.1:8090`; wss is nginx-terminated in prod.
- **Client `WSTransport`** — implements the Stage-A `Transport` seam, so the client frame loop
  is identical for solo and online. Predicts the local player through the shared
  `stepPlayerPhase`; keeps an unacked input ring; on each snapshot resets to authoritative
  `self`, drops `<= ackSeq`, replays the rest; smooths small corrections over a few frames and
  snaps large ones. Other players + enemies interpolate via `interp.ts`; bullets dead-reckon.
- **Integration** — online mode is behind an explicit `?online=1` (`?gs=<wsUrl>`) route; solo
  and the existing Convex co-op path are untouched.
- **Ops assets** — `ecosystem.config.cjs` (fork/instances:1/512M), `deploy.sh` template,
  `nginx.example.conf`, `.env.example` (names only), `healthcheck.sh`. Ian's Hetzner box is
  **not** touched by this PR.

## Measured spike results (go/no-go)

Harness: in-process server + 4 clients (one idle observer, one mover, two orbiting) driving the
**real** `WSTransport` over latency-injected sockets, `5%` packet loss, jitter `= RTT/5`, 8s.
Reproduce with `cd server && GS_RTT=<ms> GS_LOSS=0.05 npm run harness`.

| metric | threshold | RTT 0ms | RTT 50ms | RTT 100ms |
|---|---|---|---|---|
| reconciliation drift (predicted vs authoritative, post-idle) | no permanent drift | **0.00 px** | **0.00 px** | **0.00 px** |
| remote-enemy move → client render (p50 / p90) | p90 < 200ms | 113 / **131** ms | 138 / **158** ms | 163 / **182** ms |
| server tick time (p50 / p95 / max) | p95 < 50ms (target <10ms) | 0.20 / **0.32** / 1.80 ms | 0.19 / **0.32** / 1.71 ms | 0.19 / **0.30** / 1.47 ms |
| snapshot size / bandwidth | low-KB/s/client | ~1.46 KB/msg, **28.5 KB/s** | ~1.45 KB/msg, **28.3 KB/s** | ~1.45 KB/msg, **28.3 KB/s** |

All four go/no-go thresholds **PASS** at 50–100ms simulated RTT with 5% loss. Render latency
scales with RTT exactly as predicted (interp delay ~120ms + half-RTT + up to one tick).
Bandwidth (~28 KB/s/client at 20Hz, all-entities, 4 enemies + 3 other players) is comfortably
low-KB and extrapolates fine to Stage-C counts once interest management (deferred) lands.

## Robustness / hostile-input (server assertion suite)

`cd server && npm run test` — 14/14 checks pass:

- valid ticket joins + spawns; bad ticket rejected + closed.
- predicted self **reconverges to authoritative self with 0.00px drift** under 100ms RTT /
  20ms jitter / 5% loss (no permanent drift).
- two clients observe **identical** authoritative enemy positions (maxDelta 0.00px).
- malformed frames → counted + disconnected; ping flood → rate-limited + disconnected;
  **server stays healthy and a legit neighbor is unaffected** (no crash from one connection).
- a silent socket is dropped by the heartbeat; a clean disconnect removes the player.
- tick p95 within budget + avg snapshot < 4KB under load.
- speed-hacked movement (`mx` far beyond unit) is clamped by the sim + per-tick dt cap.

## Solo unchanged

`npm test` (repo root) — all 6 golden-master scenarios pass tick-for-tick (state + events) and
deterministic. `src/sim` purity grep is clean (no canvas/document/window/sfx/ConvexClient/ws;
the `SpriteName` type leak into `src/game` was moved into the pure `src/sim/types.ts`). The
step was factored into `stepPlayerPhase` + `stepWorldPhase`, composed by an unchanged
`stepWorld`, so solo runs the identical simulation.

## Honest deviations from the spec (called out)

- **`selfId` on every snapshot**, not only the join snapshot — a dropped join snapshot must not
  lose client identity under loss. Cheap and strictly more robust.
- **Bullets dead-reckon** on the client rather than routing through the `interp.ts` id-keyed
  buffer (bullets have no stable id and are short-lived); other players + enemies use `interp.ts`
  verbatim.
- **Own-player FX (muzzle/dash) come from the server event stream**, not predicted, to avoid
  double-firing juice; only local **movement** is predicted (the go/no-go criterion). Predicting
  own-bullet visuals is a clean later addition on the same seam.
- **Multiplayer kill/status credit** attributes to a "primary" player (bullets carry no owner at
  Stage A); the per-shooter ledger + lag-compensated hit-reg are explicitly Stage C. Solo keeps
  the `LOCAL_ID` player, so this is behavior-identical for solo.
- **`/dev-ticket` + `dev:` tickets** exist only when `GS_ALLOW_DEV_AUTH=1` and never in
  production; the production ticket source (a Convex action minting HMAC tickets with the same
  `GS_AUTH_SECRET`) is Stage-C wiring — the server's verify side is production-ready now.

## Deferred (per the production hardening matrix)

Lag compensation, reconnect/session resume, interest management, binary/delta encoding,
metrics dashboards, and cross-process sharding are Stage C+ and intentionally not built here.
The seams (Codec, world registry, per-client ack'd snapshots) make each an additive change.
