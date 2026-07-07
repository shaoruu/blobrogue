# blobrogue — AUTHORITATIVE SERVER: PRODUCTION SPEC
Companion to blobrogue_AUTHORITATIVE_SERVER_spec.md (architecture + isomorphic sim core). That doc = WHAT to build; this = the PRODUCTION BAR for each piece + which hardening is essential at each stage vs deferrable. Ian's bar: "end to end, all production grade" — built in safe stages, game live throughout, every stage built to the bar (not "harden later"). Grounded in the real code (pure sim modules + game.ts audit + the interp.ts buffer already shipped).

## The rule that reconciles "production grade" with "incremental"
"Production grade at each stage" does NOT mean "build all systems before stage 1." It means: **whatever a stage ships must be robust for what it does** — a stage that accepts network input MUST validate + rate-limit it from day one; a stage with no persistence needn't build reconnect-state-resume yet. Each section below marks [ESSENTIAL @ <stage>] (must exist the moment that stage ships) vs [DEFERRABLE → <stage>] (genuinely fine to add later, with why it's safe to defer). Never defer a security or crash-safety property of a surface you've already exposed.

===============================================================
# 1. NETCODE — done properly (not "send position, render position")
===============================================================
The stack, in the order data flows. Our pure `stepWorld` (see architecture spec §1) is what makes all of this implementable — deterministic replay is the foundation of prediction, reconciliation, and lag comp.

## 1a. Client-side prediction [ESSENTIAL @ Stage C]
- Client applies its own InputCmd to a LOCAL WorldState via the SAME `stepWorld` every render frame → zero-latency local movement/dash/fire feel.
- Keep a ring buffer of unacked inputs, each tagged `seq` (monotonic) + the client tick it was produced on.
- Predict ONLY: local player kinematics (move/dash/collision via moveCircle) + own-bullet spawn/visual travel. Do NOT predict damage, kills, enemy AI, spawns, loot — those are server truth (reconciled). This is the deliberate line from the architecture spec: it keeps prediction simple and desync-free (no client RNG divergence).

## 1b. Server reconciliation [ESSENTIAL @ Stage C]
- Every snapshot carries `ackSeq` (last input from THIS client the server applied) + authoritative `self` state.
- On snapshot: set local player to `self`, then RE-APPLY all buffered inputs with `seq > ackSeq` through stepWorld → the predicted state re-converges. On agreement (the common case) the correction is sub-pixel and invisible; only genuine divergence (you got knocked back server-side) visibly corrects. Classic Quake/Overwatch replay reconciliation — possible precisely because stepWorld is pure/deterministic.
- Smooth large corrections (>a few px) over 2-3 frames rather than snapping, so a correction never jars.

## 1c. Snapshot interpolation for remote entities [ESSENTIAL @ Stage B] — REUSE interp.ts
- Other players + ALL enemies + remote bullets are NOT predicted — rendered from snapshots through the interp.ts buffer already in the repo (RENDER_DELAY ~100-120ms, teleport-snap, bounded extrapolation). This is a shipped, proven component; the pivot reuses it verbatim, keyed by entityId. Enemies are just "remote entities."
- Interpolation delay is the jitter absorber: a late/dropped snapshot is covered by interpolating within the buffer; only a gap longer than the buffer extrapolates then holds.

## 1d. Input buffering (both ends) [ESSENTIAL @ Stage C]
- CLIENT: coalesce inputs to a fixed send rate (~30-60Hz) independent of render FPS; never drop the local prediction, only the network send cadence.
- SERVER: per-player input QUEUE drained once per server tick (20Hz). If multiple inputs arrived since last tick, apply in seq order (sub-stepping) so fast clients aren't advantaged. If NONE arrived (packet loss/lag), the server repeats the last input for a bounded number of ticks (continue-last-intent) then idles the player — prevents a hitchy player from freezing mid-dash. Cap the queue depth (drop oldest beyond N) as backpressure.

## 1e. Lag compensation — server rewinds to shooter's view [ESSENTIAL @ Stage C for hit-reg fairness; DEFERRABLE → refine post-C]
- The server keeps a short RING HISTORY of world snapshots (positions of all entities) for the last ~200-300ms (a few ticks — cheap, it's the same compact structs).
- When a client's fire/hit input arrives tagged with the client's render tick, the server REWINDS enemy positions to where the shooter actually saw them (client render time = serverTick - interpDelay - halfRTT), tests the hit against THOSE positions, then applies damage in the present. So a player who accurately led a target on their screen lands the shot despite latency — the standard authoritative FPS model.
- Bound the rewind (reject hit-times older than the history window → anti-cheat). Clamp per-client RTT used for rewind to a sane max (e.g. 250ms) so a faked-high-latency client can't rewind absurdly far.
- WHY essential-at-C: without it, laggy players feel their shots "miss" targets they clearly hit → the combat feels broken in the exact multiplayer case this whole project exists for. The initial version can be simple (rewind to a single interpDelay-adjusted tick); refining the exact time math is the deferrable part, not the mechanism.

## 1f. Jitter/latency handling [ESSENTIAL @ Stage B/C]
- Client estimates RTT + jitter from heartbeat/snapshot timing; sizes its interpolation delay adaptively (min ~2 snapshot intervals, grow under jitter). interp.ts already trails render time — make its delay adapt to measured jitter rather than a fixed 120ms.
- Clock sync: client aligns to server tick via periodic heartbeat (server sends its tick+time; client computes offset). All input tick-stamps use the synced clock so reconciliation + lag comp math line up.

===============================================================
# 2. ROBUSTNESS
===============================================================
## 2a. Graceful client reconnect / session resume [ESSENTIAL @ Stage D; DEFERRABLE → D before that]
- SESSION MODEL: on join the server issues a `sessionId` bound to the authenticated playerId + current world. On socket drop, the server keeps the player's entity in-world (or in a "disconnected" grace state) for a GRACE WINDOW (e.g. 30-60s) instead of instantly despawning.
- On reconnect (same sessionId + valid auth ticket): rebind the socket to the existing player entity, send a FULL snapshot (not a delta) to re-sync, resume. Beyond the grace window: treat as fresh join (respawn at hub). 
- WHY staged: pre-persistent-world (Stages B/C, floor-based ephemeral rooms) a disconnect losing the run is acceptable (matches today). Once the world is PERSISTENT (Stage D) and you can lose real progress, resume becomes ESSENTIAL. Build the sessionId handle at C (cheap), the resume logic at D.

## 2b. Server auto-restart (pm2) [ESSENTIAL @ Stage B]
- pm2 `Restart=always` equivalent (pm2 does this by default) + `max_memory_restart` (from the ops section). A crash → pm2 restarts within seconds. Because worlds are IN-MEMORY, a restart drops live sessions — so pair with: (a) fast reconnect (2a) so clients auto-rejoin, (b) periodic persistence of durable state (gear/Amber/boss-flags) to Convex so a restart never loses SAVED progress, only the live positions. Ephemeral world state (exact enemy positions) is acceptable to lose on a crash-restart; clients reconnect and re-sync.

## 2c. Zero/low-downtime deploys [ESSENTIAL @ Stage C; DEFERRABLE → C]
- `pm2 startOrReload` gives a fast restart. For a stateful game server, TRUE zero-downtime needs draining: on deploy, the process (i) stops accepting new joins, (ii) flushes durable state to Convex, (iii) sends clients a "reconnect shortly" message, (iv) exits; pm2 starts the new build; clients auto-reconnect (2a) into fresh worlds. Live combat blips for a few seconds — acceptable for an indie co-op game; announce deploys or deploy at low-traffic times. TRUE hitless handoff (socket passing between old/new process) is DEFERRABLE and likely never worth it here — call it out and don't build it.

## 2d. Backpressure [ESSENTIAL @ Stage B for input; @ Stage C for broadcast]
- INPUT side: per-connection input queue is bounded; beyond N queued, drop oldest (a client can't flood the tick loop). A connection sending faster than a sane cap gets throttled/kicked (see rate limits, §3).
- OUTPUT side: if a socket's send buffer backs up (slow client), do NOT block the tick loop — check `ws.bufferedAmount`; if it exceeds a threshold, skip sending that client this tick (they interpolate/extrapolate over the gap) and, if sustained, disconnect them with a "connection too slow" reason. The sim tick must NEVER await a socket write. All sends are fire-and-forget with buffer guards.

## 2e. No crash on malformed input [ESSENTIAL @ Stage B — the moment a socket exists]
- EVERY inbound message goes through a strict validator/decoder before touching sim state: known message type, correct shape/types, numeric ranges finite + in-bounds, string lengths capped. Reject (count + optionally kick) anything malformed; NEVER let a bad message throw inside the tick loop. Wrap per-message handling in try/catch that isolates one connection's error from the world. A fuzzer throwing garbage at the socket must not crash the server. This is non-negotiable from the first WS byte.

===============================================================
# 3. SECURITY / ANTI-CHEAT — server is the only truth
===============================================================
[ESSENTIAL @ Stage B/C — the instant the server accepts network input. This is the category you NEVER defer for an exposed surface.]
- **Validate ALL inputs against sim limits:** move vector clamped to unit length (no speed-hacking via moveX=99); dash honored only if the server's own dashCd is ready (ignore client-claimed dashes); fire honored only if the server's fireCd for that weapon is ready (server owns fire rate — client can't fabricate rate-of-fire); aim is free (just an angle). The server runs stepWorld with the SERVER's cooldowns/positions, so a lying client simply has its illegal intent ignored — cheating is structurally impossible, not merely detected.
- **Never trust client-claimed hits/damage/kills.** Clients send INPUTS (I'm firing, aiming here), never outcomes. All hit detection + damage + death happen in server stepWorld (with lag-comp rewind, §1e). A client literally has no message that says "I hit enemy N" — the protocol doesn't include one. This is the core anti-cheat guarantee and it's architectural, not a check.
- **Position authority + sanity:** server owns positions; it never accepts a client-sent position. Client sends inputs; server integrates them. (Prediction is the client guessing the server's result, never asserting it.) A reconciliation that finds the client wildly off just snaps it — so teleport hacks can't exist.
- **Per-connection rate limits:** cap inbound msg rate (e.g. ≤120 msg/s/conn), input rate (drop/queue-bound beyond the tick can consume), join attempts, and reconnect attempts. Exceed → throttle then disconnect. Protects the tick loop + is basic DoS hygiene.
- **Auth on every connection:** the WS `join` carries a short-lived signed ticket minted by a Convex action for the authenticated playerId (see ops §7). Server verifies (shared secret / JWKS) before binding a player. No valid ticket → no world access. An unauthenticated socket can do nothing but get rejected.
- **Server-side reason codes on kick** (invalid auth / rate limit / malformed / too slow) for observability, never leaking internals to the client.

===============================================================
# 4. TRANSPORT — production WebSocket
===============================================================
- **wss:// (TLS) always** [ESSENTIAL @ Stage B] — terminated at nginx (ops §7), so the Node `ws` server speaks plain ws on 127.0.0.1 and nginx does TLS on 443. Client uses `wss://`. No plaintext game traffic on the wire, ever.
- **Message encoding** [tight JSON ESSENTIAL @ B; binary DEFERRABLE → E]: start with COMPACT JSON (short keys, ints for enums — the SimEvent/snapshot structs are already compact). Debuggable and plenty for co-op scale (tens of KB/s/client at 20Hz interest-filtered). Move to BINARY (hand-packed ArrayBuffer or msgpack/flatbuffers) ONLY when §8 load-tests show bandwidth is the bottleneck — likely only at open-world entity counts (Stage E). Put encode/decode behind a `Codec` interface now so swapping JSON→binary is one module, not a rewrite. Deferring binary is safe because interest management controls bandwidth first and more cheaply.
- **Interest management** [ESSENTIAL @ Stage C for enemies; full grid @ Stage E]: each client's snapshot includes ONLY entities within its interest radius (~1.5× viewport). Stage C (single floor) = a simple distance filter per player. Stage E (open world) = a spatial grid/hash so interest queries are O(nearby) not O(world). THE primary bandwidth + server-CPU lever — build the per-player filter at C, the spatial index at E. Full state only on join/reconnect; interest-filtered updates after.
- **Heartbeat / timeout** [ESSENTIAL @ Stage B]: server pings each connection on an interval (~5s) and drops one that misses ~2-3 (ws ping/pong or an app heartbeat carrying the clock-sync payload from §1f). Detects half-open sockets (client vanished without a close) so ghost players don't linger. Client also detects server silence → triggers reconnect (2a).
- **Delta compression** [DEFERRABLE → E]: send only changed fields/entities vs the last ack'd snapshot per client. Meaningful only at higher entity counts; interest management + JSON is enough through Stage D. Keep snapshots per-client-ack'd so deltas are addable without a protocol change.

===============================================================
# 5. SCALE — multi-world / sharding from the start (even if v1 runs one)
===============================================================
[Design ESSENTIAL @ Stage B — build the abstraction now; horizontal scale DEFERRABLE → when load demands]
- **World isolation from day one:** the server hosts a `Map<worldId, World>`; each World owns its own WorldState + tick + connected players. v1 may run ONE world, but the CODE never assumes one. The single most important scale decision and it costs nothing up front — a global-singleton world is the dead-end to avoid. A "room" (Stage C) and a "world shard" (Stage E) are the SAME abstraction with different lifetimes.
- **One tick loop, N worlds** (single process): iterate worlds per tick. A single modern core handles many small worlds (tens of enemies, few players each). Measure tick-time budget (§6) to know the per-process world ceiling.
- **Horizontal scale path (documented, not built v1):** worlds are independent + in-memory → shard ACROSS processes/boxes by running more server instances (more pm2 apps / more Hetzner boxes), each owning a disjoint set of worldIds. A lightweight DIRECTORY (a Convex table or a small coordinator) maps worldId/room-code → instance host:port; the client asks the directory where to connect, then opens its WS there. Because a world lives entirely in one process, there is no cross-process shared mutable state — the clean sharding property. Load-balance by assigning new worlds to the least-loaded instance. This is the "not a single-process toy" guarantee: v1 is one process, but the world abstraction + directory indirection make scaling out a matter of ADDING instances, not re-architecting.
- **Graceful world lifecycle:** worlds spin up on demand (first player), tick only while populated, and are torn down (durable state flushed to Convex) after empty for a timeout — so an idle server isn't ticking dead worlds.

===============================================================
# 6. OBSERVABILITY
===============================================================
[Structured logging + health ESSENTIAL @ Stage B; metrics @ Stage C; dashboards DEFERRABLE]
- **Structured logging** [ESSENTIAL @ B]: JSON logs (pino — fast, low overhead) with levels + context (worldId, playerId, connId). Log lifecycle (join/leave/reconnect/disconnect+reason), errors (via the isolating try/catch from 2e), and deploy/restart events. NEVER log per-tick or per-message at info level (a firehose) — sample or debug-gate hot paths. pm2 captures stdout → the log files from ops §7.
- **Health-check endpoint** [ESSENTIAL @ B]: a tiny HTTP endpoint (same process, separate path/port — e.g. `GET /healthz` on 127.0.0.1) returning 200 + `{ status, uptime, worlds, players, tickMs_p50 }`. pm2 + an external uptime check (or town's existing monitoring) hit it. Distinguish liveness (process up) from readiness (accepting joins).
- **Metrics** [ESSENTIAL @ C, minimal]: track + expose (on `/metrics`, Prometheus text or JSON):
  - tick time (p50/p95/max) per world + aggregate — THE key health signal; if tick time approaches the tick budget (50ms @ 20Hz) the server is overloaded.
  - connected clients, active worlds, msgs/s in+out, bytes/s, snapshot size, dropped/throttled connections, reconnects, rejected-inputs (cheat signal), avg RTT.
- **Alerting/dashboards** [DEFERRABLE]: wiring metrics into Grafana/alerts is nice-to-have; the /metrics + /healthz endpoints make it addable anytime. Don't block launch on dashboards; DO watch tick-time from day one (log a WARN if a tick exceeds budget).

===============================================================
# 7. OPS ON HETZNER (production additions to the ops section)
===============================================================
Base ops (pm2 app beside town, ports, deploy.sh, nginx, firewall) are in the architecture spec §6 — this adds the PRODUCTION requirements:
- **wss/TLS termination** [ESSENTIAL @ B]: nginx (already fronting town) reverse-proxies `wss://blobrogue-gs.<domain>/ws` → `127.0.0.1:8090` with the WS `Upgrade`/`Connection` headers + long `proxy_read_timeout` (3600s), reusing town's Let's Encrypt cert. Node binds 127.0.0.1 only → the game port is never publicly exposed; only 443/80/SSH stay open (no new firewall rule; mind Hetzner's separate Cloud firewall). The `/healthz` + `/metrics` endpoints bind 127.0.0.1 and are NOT proxied publicly (or are IP-allowlisted) — never expose metrics to the internet.
- **Env / secrets handling** [ESSENTIAL @ B]: secrets (GS_AUTH_SECRET for ticket verification, CONVEX_URL/deploy keys) live in an `.env` on the box readable only by the deploy user (chmod 600), loaded by the process — NOT committed, NOT inlined in the pm2 ecosystem file if that's in git (reference `process.env`, keep real values in the box `.env` or pm2's env management). Rotate GS_AUTH_SECRET without a client change (it's server↔Convex only). Document required env var NAMES in the repo (no values).
- **pm2 production config** [ESSENTIAL @ B]: `instances:1` fork mode (NEVER cluster — stateful worlds), `max_memory_restart`, `pm2 save` + `pm2 startup` so the app auto-restores when the box comes back up, log rotation (`pm2 install pm2-logrotate`) so game logs don't fill the disk beside town.
- **Deploy safety** [ESSENTIAL @ C]: deploy.sh runs the drain sequence (2c) — stop new joins, flush durable state, reload — not a blind restart, once real progress can be lost. Keep the previous build one dir back for a fast manual rollback (`pm2 startOrReload` the old ecosystem). Tag deploys in logs.
- **Coexistence guarantees with town** (from ops §6, reaffirmed at the prod bar): own port, own pm2 app, mem-capped so it can't starve town, own log files + rotation, own /opt dir. Shares only nginx+TLS+443 and the pm2 daemon. A game-server crash-loop cannot take down town (separate processes; pm2 isolates; mem cap prevents OOM contention).

===============================================================
# 8. TESTING — verify netcode before it goes live
===============================================================
[Sim unit tests ESSENTIAL @ Stage A; headless load-test harness ESSENTIAL @ Stage B and used at every stage after]
- **Deterministic sim tests** [ESSENTIAL @ A]: because stepWorld is pure, unit-test it — same (state, inputs, seed) → same output, on node. Golden-master a few scripted scenarios (fire → hit → kill, dash i-frames, enemy telegraph timing) so the extraction (Stage A) is provably behavior-equivalent to today's game AND stays stable as the server evolves. The safety net that lets you refactor confidently.
- **Reconciliation correctness** [ESSENTIAL @ C]: a test that runs a client-predicted stepWorld + a server stepWorld with injected latency/loss and asserts the client re-converges to server state after reconciliation (no permanent drift). Prove the netcode math, don't eyeball it.
- **Headless load-test harness (simulated clients)** [ESSENTIAL @ B, grown each stage]: a node script opening M real WS connections, each a bot sending realistic input streams (move/aim/fire) and validating it receives well-formed snapshots. Use it to:
  - LOAD: ramp M clients across K worlds; watch tick-time p95, bandwidth/client, server CPU/mem, dropped connections. Find the per-process ceiling (informs §5 sharding threshold).
  - NETCODE UNDER ADVERSITY: inject artificial latency, jitter, and packet loss (a `tc netem`-style shim or in-harness delay/drop) and verify prediction/interp/lag-comp still feel right (hits register, no rubber-banding). This is how you verify the "done properly" netcode before real players.
  - SOAK: run for hours → catch memory leaks (world teardown not freeing), fd leaks (sockets), tick drift.
  - HOSTILE-INPUT: malformed messages + rate-flooding bots → verify 2e (no crash) + §3 (rate-limit/disconnect) hold.
- **Staging deployment** [ESSENTIAL @ C]: run the server as a SECOND pm2 app (blobrogue-gs-staging) on a different port/subdomain on the same box, deploy there first, run the harness against it, then promote to prod. Cheap on the existing box, catches prod-config issues before players.
- **Pre-live gate per stage:** a stage ships to prod only after: sim tests green, the load harness passes at target concurrency with tick-time within budget, and the adversity + hostile-input runs pass. That's the "verify before live" bar.

===============================================================
# PER-STAGE HARDENING MATRIX (the "essential now vs deferrable" answer)
===============================================================
Each stage from the architecture spec, with what MUST be production-grade AT that stage vs what's safe to defer (and why safe).

**STAGE A — extract isomorphic sim core (no network).**
ESSENTIAL: deterministic sim unit tests + golden-master vs current game (§8); behavior-preserving (game plays identically solo). DEFERRABLE: all network hardening (no socket exists yet). The bar here is "provably unchanged behavior," nothing network.

**STAGE B — POC server + one enemy over WS.**
ESSENTIAL (the moment a socket exists): malformed-input safety (2e), input validation + auth ticket + rate limits (§3), wss/TLS (§4), heartbeat/timeout (§4), pm2 auto-restart (2b), structured logging + /healthz (§6), snapshot interp reuse (1c), the world-map abstraction (§5, even with one world), the load/hostile-input harness (§8). DEFERRABLE: lag comp (no real combat yet), reconnect-resume (ephemeral), delta/binary (JSON fine), metrics dashboards, cross-process sharding. Rationale: B exposes a network surface → ALL security + crash-safety of that surface is essential; gameplay-depth hardening waits for the stages that add that gameplay.

**STAGE C — server owns all enemies + combat (co-op room).**
ESSENTIAL: full prediction + reconciliation (1a/1b), input buffering (1d), lag-compensated hit-reg (1e — combat fairness now matters), jitter handling (1f), interest management per-player (§4), output backpressure (2d), metrics incl. tick-time (§6), reconciliation + adversity load-tests (§8), low-downtime drain deploy (2c), staging deploy (§8). DEFERRABLE: reconnect-resume (rooms still ephemeral — losing a run on disconnect matches today), spatial-index interest (distance filter is enough at one floor), binary/delta encoding, cross-process sharding. The netcode-heavy stage — its "done properly" list is the biggest.

**STAGE D — ADD open-world mode alongside floors (floors permanent; UPDATE: both modes, not a replacement).**
The floor loop stays as-is as one mode; open-world is a SECOND mode on the same authoritative core (same stepWorld/server/biomes), selected from the menu, driven by a `mode` field on the World. ESSENTIAL for the open-world mode specifically (new because its progress is persistent + losable): reconnect + session resume (2a), periodic durable-state persistence to Convex + flush-on-deploy/exit (2b/2c), crash-recovery that preserves SAVED progress. Floor mode keeps today’s ephemeral-run behavior (a disconnect losing a run is acceptable, matches current). DEFERRABLE: sharding (still one open-world instance), binary encoding.

**STAGE E — interest mgmt / regions + chunk streaming (open-world mode).**
ESSENTIAL: spatial-index interest management (§4), and NOW binary/delta encoding if load-tests show bandwidth pressure at open-world entity counts (§4). DEFERRABLE: multi-box sharding (unless one box's CPU is hit).

**STAGE F — world bosses + drop-in public worlds (open-world mode).**
ESSENTIAL: the world-directory + multi-world assignment (§5) for public drop-in matchmaking; per-world load balancing; the full anti-cheat surface under public (untrusted) players — rate limits + validation now face the open internet, so re-audit them. DEFERRABLE: cross-box horizontal scale until concurrency demands it (the directory indirection makes it a capacity add, not a rewrite).

## BOTTOM LINE
"Production grade end to end" is achievable incrementally by one rule: **every stage ships with the hardening its OWN surface requires — never expose a network surface without its security + crash-safety, never defer a property of something already live.** The netcode is done properly (prediction + reconciliation + interp + input buffering + lag-comp rewind + jitter handling), not "send/render position." The server is the sole authority and cheating is structurally impossible (clients send inputs, never outcomes). The world abstraction + directory make it multi-world/shardable from day one without building the scale-out until load demands it. Observability (structured logs, /healthz, /metrics, tick-time watch) and a headless load+adversity+soak harness gate every stage before it goes live. The riskiest piece remains Stage A (the sim extraction) — de-risked by golden-master tests against the current game. Build in stages, hold the production bar per surface, and the game stays live throughout.
