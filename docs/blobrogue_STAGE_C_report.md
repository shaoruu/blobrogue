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

**Full-state authority + TD audit closeout (this revision):** the server now owns ALL floor-run
gameplay state — authoritative weapon inventory + idempotent validated `equip{cseq}`,
server-decided + validated + expiring blessings (`offer{id}` / `chooseBlessing{offerId}`), a
real generated dungeon with a SERVER-ROLLED per-run seed, party-wide authoritative descend, a
world revision + terminal-run state on every snapshot, and full player state
(HP/mods/blessings/owned weapons/coins/kills/combo/down/revive) over the wire through ONE
compile-time-exhaustive projection boundary (`src/net/playerSnapshot.ts`). Every blocker/High
(and the Medium items) in `docs/specs/blobrogue_TECH_AUDIT_stageBC.md` is resolved with a named
regression — see the PR description for the point-by-point mapping. Key netcode change: **the
server tick alone owns simulation time** — inputs are dt-less intent samples consumed one per
fixed tick (a smuggled `dt` field is a protocol error), so the sim is immune to client-authored
dt and independent of client frame rate. Production join works end-to-end: a Convex action
(`convex/gsTicket.ts`) mints the same `v1.<payload>.<sig>` HMAC ticket `server/src/auth.ts`
verifies (byte-for-byte agreement locked by `server/test/ticket.test.ts`), and production
builds default to `wss://gs.create.town/ws` behind the strictly opt-in `?online=1`. Server
architecture stays in small typed modules behind explicit ports
(`RoomRuntime`/`SessionStore`/`SnapshotPublisher`); the Colyseus evaluation + adapter seam is
`docs/adr/0001`.

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

Measured in an OPEN arena (`GS_ARENA`) so the render-latency probe travels a clean monotonic line;
production runs the real dungeon with identical stepWorld/tick/netcode (only map geometry differs).

| clients | reconciliation drift | render latency p50 / p90 | tick p50 / p95 / max | snapshot / bandwidth |
|---|---|---|---|---|
| 3 (co-op)   | **0.00 px** | 175 / **199** ms | 0.21 / **0.38** / 1.99 ms | 1.8 KB · **35 KB/s/client** |
| 4           | **0.00 px** | 170 / **193** ms | 0.23 / **0.36** / 2.23 ms | 1.9 KB · **38 KB/s/client** |
| 8           | **0.00 px** | 171 / **196** ms | 0.31 / **0.45** / 1.66 ms | 2.4 KB · **48 KB/s/client** |
| 6 · 30s soak| **0.00 px** | 177 / **197** ms | 0.22 / **0.32** / 2.08 ms | 2.2 KB · **43 KB/s/client** |
| 4 · audit closeout rerun | **0.00 px** | 176 / **212** ms | 0.25 / **0.41** / 2.47 ms | 1.9 KB · **37.9 KB/s/client** |

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
- **Stage C pure-sim** (`npm run test:sim`): **81/81** — ownership (bullet/coin/burn/barrel),
  DEPARTED-owner attribution (kill credits no one, chest not phantom-opened, burn keeps the
  immutable id), down/revive (down vs game-over, contact skips downed, team wipe, teammate
  revive + decay), stranded-downed game over + idempotent terminal transition,
  down-does-not-abort-iteration (H1) + non-shared control, fire-time lag-comp (hitscan uses
  fire-time view; slow projectile decays to present; melee rewinds BOTH actors) +
  impossible-hit negatives, interest filtering, barrel chain + friendly fire, validated weapon
  switch, party-wide descend + identical seed/floor/layout, first-come coin/weapon ownership.
- **Protocol contract** (`npm run test:protocol`): **65/65** — both directions round-trip
  losslessly, 2×3000-frame fuzz never escapes ProtocolError, unknown fields on client frames
  rejected (malicious `dt` is an error), the AuthoritativePlayerSnapshot projection round-trips
  every server-owned field, interest enter/exit hysteresis, event scope table.
- **Client netcode ordering** (`npm run test:netcode`): **19/19** — stale/duplicate/reordered
  snapshots ignored (rev + tick), ack never decreases (no input resurrection), reliable-event
  dedupe + evTo ack advance, offer id dedupe, terminal state from snapshots, world rebuild from
  the authoritative seed/floor.
- **2-player generated-floor golden** (`npm run test:floorrun`): **36/36** — real generated
  dungeon, diverging pickups/inventories, diverging server-applied blessings that measurably
  change combat, full combat floor clear, party exit gate, one descend, fresh next dungeon with
  per-floor resets, wire coherence for both players, determinism replay.
- **Server suites** (`cd server && npm test`): Stage B **14/14** + Stage C **42/42** + hardening
  **51/51** + ticket agreement **14/14** = **121/121**. Stage C adds: idempotent equip cseq,
  offer-id echo validation. Hardening adds: adversarial-dt kick (0/huge/negative), >16 distinct
  proxied users at the default cap, X-Real-IP (the documented nginx shape) + spoof safety,
  60/120/144/240Hz equivalence, sustained 240Hz play without rate limiting + segmented-bucket
  input-flood kick, offer expiry, pong-id mismatch timeout, config fail-fast, positional-event
  interest filtering with evTo ack advance, run reset when the room empties. Ticket: the Convex
  minter and the server verifier agree BYTE-FOR-BYTE; tamper/expiry/replay/wrong-secret reject.

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

(`?online=1` on a dev build uses `ws://127.0.0.1:8090/ws` and fetches a local `/dev-ticket`;
a PRODUCTION build defaults to `wss://gs.create.town/ws` and mints its ticket through the
Convex `gsTicket:mint` action instead. `?gs=<wsUrl>` explicitly targets any server and always
uses that server's dev-ticket path.)

Both tabs join the **same** server world and see the shared boss + enemies + the other player.
Aim at the boss and hold fire in both tabs: **the same boss HP bar drops for both**, phase
changes together, it dies once, and **one** boss chest spawns that both tabs see. Verify server
health/metrics: `curl -s localhost:8090/healthz` and `curl -s localhost:8090/metrics`.

## Honest deviations / limitations

- **The server runs the real generated dungeon floor run** (authoritative random per-run seed/
  floor/dungeon/enemies/props/chests/pickups + party-wide descend + run reset when the room
  empties). Boss floors are every 5th; the multi-bot boss test spawns a boss into the live
  authoritative world to keep boss-combat assertions deterministic on floor 1 (the boss entity
  is authoritative regardless of how it spawned).
- **Lag-comp rewind is anchored at FIRE time and decays.** The rewind window uses the
  server-measured RTT plus the client's REPORTED adaptive interp delay (`stat.dly`), clamped
  server-side to the same [90,300]ms window the client's interpolation uses and to the sim's
  bounded history — a lie can only mis-rewind the sender's own shots inside that window. Melee
  evaluates BOTH actors at fire time (swing-origin pose + rewound target).
- **RTT for lag-comp is sampled from ping/pong** at the heartbeat cadence, smoothed, with strict
  pong-id matching; the client's own RTT (for interp) is measured per input→ack, much finer.
- **Reconnect/session resume is Stage D** per the matrix (rooms ephemeral; a disconnect ends the
  run, matching today's solo/co-op; the last standing player leaving cleanly game-overs any
  stranded downed teammates). Live gameplay state is fully server-owned while connected; the
  `SessionStore` port is where reconnect tokens land at Stage D.
- **Blessing/persistence:** blessing mods are authoritative + applied server-side; offers carry
  ids and expire server-side; cross-run persistence (Convex) is Stage D.
- **Measurement is done in an open arena** (`GS_ARENA`) so the render-latency probe travels a
  clean monotonic line; production runs the real dungeon with identical stepWorld/tick/netcode.
- **Production join path is wired but not smoke-tested against the live box from this
  environment** (no deploy access from the cloud agent): the Convex minter/action, the client
  production ticket path, and the `wss://gs.create.town/ws` default are shipped and the
  mint/verify agreement is locked by tests; deploying the updated server build + setting
  `GS_AUTH_SECRET` in Convex (`npx convex env set GS_AUTH_SECRET ...`) are the two ops steps.

## Non-gameplay client-only state

Presentation only, never authority: camera/viewport; particles/decals/gibs/afterimages/muzzle;
trauma/shake/hit-stop/hurt-flash; audio/music; pause + blessing overlays (the *choice* is
server-validated, the overlay is UI); minimap; HUD layout; cosmetic squash/lean; biome tint/
torches; key bindings + autofire resolution; FPS/dev readouts; local render-extrapolation of the
predicted player between fixed steps.

## Stage B dependency

Stage B (PR #21) is **merged to `main`** (`f4bb8de`); this branch is based directly on it and
builds Stage C on the real server/`WSTransport`/protocol seams. No rebase dependency remains.
