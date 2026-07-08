# blobrogue — Stage C report (server owns ALL combat; full multi-client sync)

Stage C moves **all** combat onto the authoritative server that Stage B stood up. Two or more
real clients now fight the **same** enemies and boss in one server-owned world: the server owns
players, enemy AI, bullets/projectiles, collision, hit detection, damage/status/knockback,
death, boss HP/phases, props/explosions/chests/pickups/loot, and floor-clear state. Clients send
**inputs only**, predict their own movement, and reconcile; remote players/enemies/bullets
interpolate. **Solo stays `LocalTransport` and behavior-identical** (the six golden suites pass
byte-for-byte and `src/sim` stays pure).

Built on the merged Stage B (`main` @ `f4bb8de`): the real `server/`, `src/net/protocol.ts`
Codec, and `src/client/wsTransport.ts` seams — no parallel scaffolding.

---

## Required engineering (task items 1-10) → where it lives

1. **Per-player ownership attribution** — `Bullet.owner` + `Enemy.burnOwner` thread the causing
   player through every strike; `updateEnemies` credits kills/combo/coins(loot value)/lifesteal
   to the resolved owner, not a "primary player". `destroyProp(..., by)` credits explosive-barrel
   kills to the detonator. The Stage-B `primaryPlayer` combat shortcut is removed from the strike
   path (it survives only as a benign empty-world fallback). No client message can assert damage.
   → `src/sim/world.ts`, `src/sim/types.ts`, `src/sim/weapons.ts`.
2. **Full authoritative multi-player stepWorld** — target selection already scans all
   players/remote targets; contact + enemy bullets damage the correct victim; down/revive is
   authoritative off the players map; boss/exit/room state is common. Snapshot/wire now carry
   props/pickups/chests + floor exactly once. → `src/sim/world.ts`, `src/net/protocol.ts`.
3. **Lag compensation** — the world keeps a bounded per-enemy position ring (`recordHistory`,
   ~300ms / 6 ticks). A shooter's bullet/melee overlap is tested against the enemy **rewound** by
   that player's `rewindTicks` (server-computed from measured RTT + interp delay, clamped to the
   window), then damage applies to the enemy's **current** state. Rewind is server-derived and
   bounded (anti-cheat-safe; no impossible rewind). `rewindTicks` is 0 in solo/prediction, so hit
   tests use present positions and goldens are unchanged. → `rewoundEnemyPos`/`recordHistory` in
   `src/sim/world.ts`, `rewindTicksFor` in `server/src/world.ts`.
4. **Prediction / reconciliation / jitter** — local movement predicted instantly via
   `stepPlayerPhase`; own fire/muzzle/projectile FX are server-confirmed (deduped: `wsTransport`
   only replays global + own-pid events), so no double FX. Adaptive interpolation delay
   (90-300ms) sized from measured snapshot **jitter**; **clock sync** offset from `ping.time`;
   correction smoothing thresholds (glide < 96px, snap beyond). → `src/client/wsTransport.ts`,
   `src/net/interp.ts`.
5. **Interest management** — per-client snapshots include only entities within
   `GS_INTEREST_RADIUS` (default 1100px ≈ 1.5× viewport) **plus** always-global objective state
   (the boss enemy + boss chest) and the client's own player. Join/full snapshots send
   everything to bootstrap. Simple distance filter (spatial index is Stage E). Output
   backpressure from Stage B retained. → `buildSnapshot` in `src/net/protocol.ts`,
   `server/src/config.ts` + `server.ts`.
6. **Clean disconnect / rejoin** — authoritative server means no host handoff; a clean
   disconnect removes the player and the world is uncorrupted; a fresh join rejoins the room.
   Session resume remains Stage D per the matrix (rooms are ephemeral).
7. **Production hardening** — `/metrics` now reports tick p50/p95/max, snapshot bytes p50/p95/max,
   server-measured RTT avg/p95, and client-reported jitter/reconciliations/correction-max (via a
   validated `stat` uplink), on top of Stage B's counters (msgs/bytes, drops/backpressure,
   rejected inputs, malformed, rate-limited). Structured logs, input validation + cooldown/anti
   speed/fire/dash hacks, WSS/nginx/pm2/deploy templates all retained from Stage B.
8. **Tests / harness** — see below.
9. **Manual/demo** — exact two-tab commands below; dev auth is local-only.
10. **Ops** — server binds `127.0.0.1`; production auth seam + tickets, pm2/nginx/deploy
    templates unchanged. **Ian's Hetzner box is NOT touched by this PR** — this is a
    deploy-ready package. (Main runner currently lacks restored SSH; nothing was deployed.)

Explicitly **out of scope** and not built: open world / camp / dealers / weapon schools / mob
waves / balance reset. Full combat sync only.

---

## Measured results (actual numbers)

Headless harness: in-process server + real `WSTransport` bots over latency-injected sockets, 5%
loss, jitter = RTT/4-5. Reproduce: `cd server && GS_CLIENTS=<n> GS_SECONDS=<s> GS_RTT=<ms> npm run harness`.

| clients | reconciliation drift | render latency p50 / p90 | tick p50 / p95 / max | snapshot / bandwidth |
|---|---|---|---|---|
| 3 (co-op)   | **0.00 px** | 171 / **196** ms | 0.23 / **0.37** / 2.06 ms | 2.3 KB · **45 KB/s/client** |
| 4           | **0.00 px** | 178 / **201** ms | 0.27 / **0.41** / 2.27 ms | 2.5 KB · **48 KB/s/client** |
| 8           | **0.00 px** | 175 / **200** ms | 0.32 / **0.49** / 1.82 ms | 3.1 KB · **60 KB/s/client** |
| 6 · 30s soak| **0.00 px** | 181 / **211** ms | 0.23 / **0.35** / 2.13 ms | 3.3 KB · **64 KB/s/client** |

- **Reconciliation drift is 0.00 px** at 50/100/150ms RTT with jitter + 5% loss — no permanent
  drift, corrections stay sub-`SMOOTH_MAX_PX` and glide.
- **Render latency** ≈ half-RTT + adaptive interp (~130ms) + up to one tick (50ms); ~200ms p90 at
  100ms RTT is the physical floor and matches theory.
- **Tick p95 < 0.5ms** — far under the 50ms budget and the <10ms target, at the expected co-op
  room size **and** at 8 clients. Sim is O(enemies × players); ample headroom.
- **30s soak** is clean: no drift growth, no tick drift, no dropped snapshots, stable memory
  (world/socket teardown frees).

Adaptive interp measured 115-159ms (grows with jitter), correction-max ~26-31px under 150ms RTT.

## Test output (all gates green)

- **Solo goldens** (`npm test` root): 6/6 scenarios pass tick-for-tick (state + FX),
  deterministic. **`src/sim` purity**: PASS (no DOM/socket/Convex/client imports — enforced by
  `test/purity.test.ts`).
- **Stage C pure-sim** (`npm run test:sim`): **35/35** — ownership (bullet/coin/burn/barrel),
  down/revive (down vs game-over, contact skips downed, team wipe, teammate revive + decay),
  lag-comp (rewound hit that present-time misses + no-impossible-rewind control), interest
  filtering, barrel chain + friendly fire.
- **Server suites** (`cd server && npm test`): Stage B **14/14** + Stage C **24/24** = **38/38** —
  incl. 2 bots + different weapons kill the same boss with identical HP/phase/death and one
  authoritative chest both see; identical enemy set + shared props across clients; interest
  exclusion over the wire; tampered client can't speed/fire-rate-hack (server owns cooldowns) and
  has no message to claim a hit; prediction reconverges @ 50/100/150ms RTT with bounded interp;
  high-latency attacker still lands shots (lag-comp); malformed/flood can't crash.

## Manual two-tab proof (local, dev auth only)

```sh
# Terminal 1 — authoritative server (loopback, dev tickets enabled — LOCAL ONLY):
cd server && npm install
GS_ALLOW_DEV_AUTH=1 npm run dev        # ws://127.0.0.1:8090/ws  (+ /healthz, /metrics)

# Terminal 2 — client dev server:
npm install && npm run dev             # vite on http://localhost:5173
```

Open **two browser tabs** at:

```
http://localhost:5173/?online=1
```

(`?online=1` uses `ws://127.0.0.1:8090/ws` by default; each tab fetches a local `dev:` ticket.)

Both tabs join the **same** server world and see the shared boss + enemies + the other player.
Aim at the boss and hold fire in both tabs: **the same boss HP bar drops for both**, phase
changes together, it dies once, and **one** boss chest spawns that both tabs see. Verify server
health/metrics: `curl -s localhost:8090/healthz` and `curl -s localhost:8090/metrics`.

## Honest deviations / limitations

- **Stage-C proof world is a fixed combat arena** (boss + mixed enemies + explosive-barrel chain
  + breakables + a chest), not a descending dungeon. This exercises every combat subsystem
  deterministically for all clients and avoids multi-player floor-descent orchestration, which is
  not part of "full combat sync". Floor-clear/boss-defeated **state** is shared and observable;
  multi-floor descend orchestration is left for a follow-up (the sim's `descend` exists).
- **Lag-comp rewind uses a fixed assumed interp delay** (`INTERP_BASE_DELAY_MS`) server-side, not
  the client's exact adaptive delay. Under jitter the client's delay only grows, so the server
  slightly **under**-rewinds — safe/bounded, never over-rewinds. Documented; refining the exact
  time math is the deferrable part of §1e.
- **RTT for lag-comp is sampled from ping/pong** at the heartbeat cadence (5s default), smoothed;
  it tracks slowly-changing links well. The client's own RTT (for interp) is measured per
  input→ack, much finer.
- **Reconnect/session resume is Stage D** per the matrix (rooms ephemeral; a disconnect losing a
  run matches today's solo/co-op).
- **Weapon switching has no wire message yet** — the harness grants different weapons server-side
  (the authoritative loadout source) to prove multi-weapon boss damage. A `switch` input is a
  clean later addition on the same seam.
- **Not deployed.** No access to Ian's Hetzner from the cloud agent; the pm2/nginx/deploy/env
  templates are shipped and staging-ready.

## Stage B dependency

Stage B (PR #21) is **merged to `main`** (`f4bb8de`); this branch is based directly on it and
builds Stage C on the real server/`WSTransport`/protocol seams. No rebase dependency remains.
