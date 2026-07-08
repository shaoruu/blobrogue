# blobrogue Stage B/C Technical Audit

**Scope:** merged Stage B PR #21 (`f4bb8de`) and draft Stage C PR #22 (`585b6c4`)  
**Verdict:** **BLOCK PR #22.** Stage B established useful seams, but shipped with unresolved authoritative-loop defects. Stage C improves shared combat attribution, lag compensation, interest filtering, and tests, yet remains a fixed-arena proof rather than end-to-end server ownership of the floor run. It also retains multiple correctness and exploit bugs.

## Verification performed

- Read real PR diffs, current code, specs, PR review comments, server/client/sim tests, and ops templates.
- Root: `npm test && npm run build` — PASS (6 goldens, 35 Stage-C sim checks, purity scan, Vite build).
- Server: `npm test && npm run build` — PASS (14 Stage-B + 24 Stage-C checks, TypeScript build).
- `npm run harness` — PASS at 4 clients, 100 ms RTT / 20 ms jitter / 5% loss: 0 px settled drift, 197 ms p90 render latency, 0.573 ms tick p95, 49.2 KB/s/client.
- These results validate the bounded arena scenarios they exercise. They do **not** validate generated floors, authoritative loadout/blessings, floor transitions, event reliability, production proxy identity, high-refresh clients, or real WSS deployment.
- GitHub required checks are not a production gate: PR #22 shows Vercel preview and neutral Bugbot, not root/server test, harness, soak, or deployment checks.

## 1. Gameplay state ownership matrix

| State | Current authority | Audit result |
|---|---|---|
| Player position/dash/HP/cooldowns | Server state; local movement predicted/reconciled | **Partial.** Correct seam, but client-controlled `dt` permits 2x advancement and zero-time cooldown/invulnerability behavior; ack logic can discard unsimulated inputs (`server/src/world.ts:107-132`, `server/src/config.ts:55-56`). |
| Inventory / owned weapons | Server acquires pickups, but wire omits `ownedWeapons` and client prediction inventory never receives it | **BLOCKER.** `PlayerSim.ownedWeapons` exists (`src/sim/world.ts:65-76`), but `SelfWire` only carries current weapon (`src/net/protocol.ts:35-48`). Online HUD/switching reads client-local inventory (`src/game/game.ts:1006-1021,1311-1316`). |
| Weapon switching | Client mutates render/prediction world only | **BLOCKER.** No switch intent exists in `ClientMsg` (`src/net/protocol.ts:93-100`); keyboard/scroll calls `equipWeaponInWorld` locally (`src/game/game.ts:1006-1021`). Server keeps firing its prior weapon. Current test grants weapons directly in server memory, bypassing the missing player path (`server/test/stagec.test.ts:42-57`). |
| Blessing offers/choices/mods | Server emits an offer event; client rolls choices and applies the item locally | **BLOCKER.** Client calls unseeded `rollItemChoices(3)` and `applyItemToWorld` (`src/game/game.ts:977-991`); no choice message, offer id, validation, authoritative mods, or wire state exists. Server combat therefore does not use the chosen blessing. |
| Coins / kills / combo | Server simulation and `SelfWire` | **Mostly server-owned**, but disconnected projectile/status owners fall back to an unrelated primary player (`src/sim/world.ts:248-257`), corrupting kills, combo, loot value, and lifesteal. |
| Down / revive | Server simulation and snapshots | **Server-owned but buggy.** Downing can abort remaining enemy processing (`src/sim/world.ts:836-841`); last standing teammate disconnect can strand downed players indefinitely (`src/sim/world.ts:1535-1558`, `server/src/server.ts:348-357`). `reviveProgress` is not wired, so no authoritative progress UI. |
| Floor seed / dungeon geometry | Fixed constants and independently reconstructed client arena | **BLOCKER.** Online always boots `STAGE_B_SEED/FLOOR` with `isSandbox:true` (`src/game/game.ts:445-451`; `src/client/wsTransport.ts:141-145`); server does the same and manually seeds a demo layout (`server/src/world.ts:43-78`). Snapshot carries floor but neither seed nor dungeon/room/exit schema (`src/net/protocol.ts:103-120`). |
| Objective / floor clear | Inferred from current enemy list; boss/chest forced global | **Partial.** No explicit objective/room phase/clear/transition state. Interest-filtered `enemies.length` is not a safe global clear predicate for the HUD (`src/game/game.ts:1311-1317`). |
| Exit + descend | Disabled online by sandbox mode | **BLOCKER.** `updateExit` returns for sandbox (`src/sim/world.ts:1563-1565`); server world never descends. Existing co-op path is client/Convex orchestration, not authoritative WS (`src/sim/world.ts:1571-1581`; `src/game/game.ts:1204-1215`). `descend` also emits blessing for `LOCAL_ID`, wrong for server players (`src/sim/world.ts:1581-1590`). |
| Enemies / AI / boss | Server simulation | **Server-owned**, with the downed-player early-return bug and flow-field refresh keyed only by the primary player's tile (`src/sim/world.ts:1175-1205`), which can leave multi-source paths stale until timer rebuilds. |
| Bullets / hit / damage / status | Server simulation; bullets render from snapshots; enemy hit rewind | **Server-owned**, but prediction creates bullets in `predState` without world stepping/cleanup, causing unbounded hidden growth (Stage B path `src/client/wsTransport.ts:291-350`). Lag compensation assumes 120 ms while client may render at 90–100 ms, allowing over-rewind near tick boundaries (`src/client/wsTransport.ts:250-258`, `server/src/world.ts:25-30`). |
| Loot / pickups | Server simulation and snapshots | **Mostly server-owned.** Pickups are first-come authoritative. Missing stable pickup IDs makes lifecycle/delta/event dedupe brittle (`src/net/protocol.ts:87-89,284-302`). |
| Props | Server simulation and snapshots | **Server-owned**, but replacing prediction props with only the current interest view can introduce collision pop/rubber-band at the boundary (`src/client/wsTransport.ts:279-282`; `src/net/protocol.ts:353-354`). |
| Chests | Server open state and loot roll | **Partial.** Bullet-open attributes the chest to `primaryPlayer`, not `Bullet.owner`, so another player can receive the blessing/reward (`src/sim/world.ts:1413-1424`). Blessing choice then becomes client-local. |

## 2. Prioritized findings

### Blockers

1. **PR #22 does not satisfy ALL-state server ownership or a full floor run.** It explicitly remains a fixed sandbox arena, with generated dungeon, seed/geometry, objective, exit/descend, weapon switching, and blessing choice absent from the protocol and server lifecycle. Evidence above; the PR report itself admits the arena, missing descend, and missing switch.

2. **Authoritative time is client-controlled.** Each input supplies `dt`; the server permits 0.10 s of player simulation per 0.05 s tick (`server/src/config.ts:55-56`, `server/src/world.ts:123-132`). The anti-cheat test accepts ~400 px/s as success despite normal movement being ~200 px/s (`server/test/stagec.test.ts:147-165`). `dt:0` can also avoid per-player cooldown/invulnerability progress. When budget reaches zero, later inputs are still acked and discarded, causing correction/drift. Replace this with server-tick-owned advancement: latest sampled intent (or bounded sub-tick queue) applied for exactly `FIXED_DT`; ack only consumed intent sequences. Add 60/120/144/240 Hz and adversarial `dt=0/1` tests.

3. **Online loadout is split-brain.** Inventory and blessings affect the client-local `LOCAL_ID` prediction/render player, while server combat continues from server state. Add validated semantic commands (`equip {slot/id, commandSeq}`, `chooseBlessing {offerId, choiceId}`), server-owned offer RNG/expiry, server validation against inventory/offers, authoritative `ownedWeapons`, `ownedItemIds/mods`, and snapshot/reconcile support. Never accept resulting stats from the client.

4. **No authoritative multi-floor world contract.** Replace `STAGE_B_*`/`isSandbox:true` online bootstrap with server-created run state. Full snapshot must establish run/world revision, seed or authoritative dungeon geometry, floor, rooms/exit/objective state, and stable entity IDs. Server alone evaluates clear/exit/descend and applies floor reset/blessing offers for every relevant player.

5. **Stage B production connection identity is broken behind the documented nginx topology.** Server keys per-IP limits from `req.socket.remoteAddress` (`server/src/server.ts:202-210`), while nginx proxies from loopback and merely sets `X-Real-IP` (`server/nginx.example.conf:9-17`). All public users collapse to one IP and hit the 16-connection cap. Use a trusted-proxy configuration and parse a single trusted header only when the direct peer is loopback; test spoofing and >16 distinct proxied users.

6. **High-refresh clients can self-disconnect.** `Game.tick` sends one input per animation frame and server caps all messages at 120/s (`src/client/wsTransport.ts:329-350`, `server/src/server.ts:238-248`). 144/240 Hz clients exceed it. Decouple input send cadence from RAF (e.g. 30–60 Hz coalescing), and keep separate token buckets for join/control/input/stat.

### High

7. **Downing a player can abort enemy processing.** `updateEnemies` returns when a victim reaches zero and `!w.isCoop`; authoritative WS worlds have multiple players but `isCoop:false` (`src/sim/world.ts:836-841`, online setup at `src/game/game.ts:451`). Continue processing after applying room-level game-over logic. Regression: two players, first downed by early enemy, later enemies/projectiles still advance exactly once.

8. **Events are neither reliable nor idempotent.** `world.lastEvents` is overwritten each tick (`server/src/world.ts:135-137`); a backpressured client skips the snapshot and permanently loses those events (`server/src/server.ts:147-163`). Events have no monotonic id/range, client dedupe, or ack. Add per-world event sequence plus bounded ring; snapshots carry `eventFrom/eventTo`, clients dedupe and request/receive recovery or reconstruct critical transitions from state. Keep critical gameplay state out of transient events. Filter positional FX by interest.

9. **Lag compensation is applied at projectile collision time, not fire time.** Every friendly projectile tests against a historical enemy position on each later tick (`src/sim/world.ts:841-861`), using the shooter's current RTT-derived rewind (`server/src/world.ts:25-30,103-105`). A slow projectile can therefore ghost-hit a position the target occupied long after firing; melee similarly compares the current attacker pose with a historical target (`src/sim/world.ts:864-880`). For instantaneous attacks, correlate the fire command to a viewed server tick and rewind both actors. For simulated projectiles, spawn/fast-forward from fire time, then use present-time collision. Add negative impossible-hit tests; the current planted-bullet and “boss eventually took damage” tests do not prove fairness (`test/stagec.sim.test.ts:224-248`; `server/test/stagec.test.ts:197-210`).

10. **Snapshot ordering is unchecked.** WSTransport accepts every snapshot as latest and reconciles its ack with no monotonic tick/ack guard (`src/client/wsTransport.ts:243-304`). Reordered delivery can regress state and replay already-applied inputs. Ignore stale world revisions/ticks and never decrease ack. Add deliberate reorder/duplicate tests, not just loss/jitter.

11. **Server decode is shallow and protocol version can be omitted.** Client decode validates only top-level server `t` then casts (`src/net/protocol.ts:205-217`). Join decoder maps missing/invalid version to 0 and server explicitly accepts 0 (`src/net/protocol.ts:167-171`; `server/src/server.ts:281`). Require exact integer version and exhaustive runtime schemas/codecs in both directions; reject unknown fields where security-sensitive. Add schema round-trip/fuzz/property tests.

12. **Disconnect/game-over lifecycle is incomplete.** Game-over stops RAF but leaves WSTransport connected (`src/game/game.ts:1359-1370`), keeping the player in the authoritative world. Last-standing disconnect can leave downed peers stuck. Introduce explicit room/player lifecycle states and idempotent leave/terminal transition; call transport stop on terminal exit.

13. **Attribution shortcuts remain.** `resolveOwner` transfers disconnected owners' outcomes to an unrelated player (`src/sim/world.ts:248-257`), and bullet-opened chests use `primaryPlayer` (`src/sim/world.ts:1413-1424`). Preserve immutable actor identity on projectiles/status/explosions; if the actor has left, grant no personal reward or credit the retained run identity, never another live player.

### Medium

14. **Interest filtering is not a coherent view model.** It filters entities but broadcasts all events (`server/src/server.ts:160-163`), causing distant global shake/freeze; static/dynamic objects pop at radius boundaries; no hysteresis or tombstones exist. Create a per-client `InterestView` with enter/update/leave semantics, margin/hysteresis, global objective channel, and event filtering.

15. **Lag-comp time model disagrees with adaptive interpolation.** Server always adds 120 ms while client delay ranges 90–300 ms (`src/net/protocol.ts:21-24`, `src/client/wsTransport.ts:66-70,250-258`, `server/src/world.ts:25-30`). Send a bounded, server-validated render-delay sample or derive the exact viewed server tick from shot input; clamp by history and test calm-link over-rewind plus high-jitter under-rewind.

16. **Heartbeat accepts any pong id.** `handlePong` ignores the decoded id (`server/src/server.ts:188-190,332-341`), so stale/unsolicited pongs reset liveness and contaminate RTT. Match the outstanding id and only update RTT once.

17. **Config accepts invalid finite values.** `intEnv` does not enforce integer/min/max relationships (`server/src/config.ts:32-57`). Negative heartbeat, queue, buffer, or connection values can disable protections or create loops. Parse and fail fast with a validated config schema.

18. **Production deployment is a template, not a verified path.** `server/deploy.sh` intentionally exits 1 (`server/deploy.sh:1-29`); PR #22 was not staged over WSS. Stage B's own gate required real WSS and staging. Add CI for both packages plus harness, an immutable deploy artifact, readiness/drain/rollback, staging smoke, and a real proxy/IP/auth test before calling production-ready.

## 3. Architecture and module quality

### What is good

- `src/sim` remains pure and deterministic; the purity test scans 12 modules and goldens pass.
- `Transport` keeps solo and online behind one client loop (`src/client/transport.ts:15-29`).
- Server imports the same sim rather than duplicating gameplay logic.
- Client input protocol does not expose hit/damage/position outcome messages.
- Auth secret is required in production and dev bypass is gated by both explicit flag and non-production (`server/src/auth.ts:88-95`, `server/src/main.ts:13-17`).
- Strict inbound numeric/length validation, queue bounds, heartbeat, output-buffer checks, structured logs, loopback bind, PM2 single-process constraint, and nginx WS upgrade shape are sound foundations.

### Debt / coupling

- `src/game/game.ts` is 2,742 lines and mixes input, online/legacy co-op orchestration, run transitions, UI, audio, FX, rendering, dev controls, and direct state mutation. It is the primary god file.
- `src/sim/world.ts` is 1,658 lines and combines run construction, player state, weapons, combat, AI, drops, props, chests, revive, and floor lifecycle. Pure does not mean cohesive. Split by deterministic systems behind a `WorldContext`; retain one ordered orchestrator.
- `src/client/wsTransport.ts` (513 lines) combines connection state, codec handling, prediction, replay, interpolation, interest materialization, metrics, and render-object conversion. Split connection/session, predictor/reconciler, snapshot view, and telemetry.
- `server/src/server.ts` (451 lines) mixes HTTP, WS lifecycle, scheduling, snapshots, auth dispatch, metrics, and ops. Extract `ConnectionGateway`, `WorldRunner`, and HTTP observability without changing behavior.
- State/wire copying is manual and duplicated: `toSelfWire`, `applySelfWire`, `copyPlayer`, remote conversion. Missing fields caused the inventory/mod authority gap. Define explicit `AuthoritativePlayerSnapshot` and a single tested projection/apply boundary; use exhaustive compile-time field coverage plus runtime codec tests.
- `needsFullSnap` is connection state but unused (`server/src/connection.ts:51`, initialized `server/src/server.ts:221`), signaling an unfinished resync path.
- `DEFAULT_WORLD_ID`, Stage-B seed/floor, fixed tick/snapshot assumptions, and hard-coded global boss/chest policy are magic topology, not a room abstraction.

## 4. Netcode assessment

Prediction/reconciliation and interpolation are plausible for movement in the measured arena, but the test claim is narrower than production correctness. Current tests measure settled drift after idle; they do not bound continuous-play correction rate, stale snapshot handling, collision-boundary behavior, event delivery, high refresh, backpressure recovery, reconnect, floor transitions, loadout actions, or memory growth. Lag compensation rewinds enemy overlap only; document explicitly which melee/projectile/explosion cases use history and test each fairness contract.

Minimum added gates:

1. Property test server advancement is invariant to client FPS/message chunking and malicious `dt`.
2. Duplicate/reordered/delayed snapshots and ack monotonicity.
3. Backpressure drop across shot/hurt/kill/chest/descend/game-over events with exactly-once presentation and state convergence.
4. 60/120/144/240 Hz clients for 10+ minutes; bounded pending inputs, bullets, interp tracks, event ring, and heap.
5. Interest enter/leave/hysteresis/tombstones and collision near boundary.
6. 2–4 player generated-floor golden: pickups, different inventories/blessings, clear, exit, one descend, new dungeon, reconnect/leave during downed and in-flight damage.
7. Proxy/auth adversity: trusted forwarding, spoofed headers, replayed/expired tickets, duplicate identity, protocol mismatch, pong mismatch.
8. CI soak/load with production-like entity count, not six demo enemies; assert p95/p99 tick, event backlog, dropped views, heap slope, and bandwidth.

## 5. Colyseus ADR recommendation

**Decision: keep the current raw-WS transport now; do not rewrite Stage C onto Colyseus. Build a selective room/session adapter boundary so adoption remains cheap.**

Why:

- The valuable domain seam already exists: pure deterministic sim, `GameWorld`, `Transport`, and codec boundary. Colyseus would not fix client-owned loadout/blessings, authoritative time, attribution, or floor lifecycle; those are domain contract defects.
- A framework migration during the authority closeout would enlarge the diff and obscure regressions.
- Colyseus's strongest benefits map to the missing next lifecycle layer: explicit Room lifecycle, seat/reservation/reconnect handling, schema-driven state sync/change tracking, and multi-room matchmaking/monitoring.

Selective preparation:

- Define `RoomRuntime` (`join/leave/command/tick/snapshot/terminate`) around `GameWorld`; keep sim unaware of WS or Colyseus.
- Define stable authoritative schemas and command handlers independent of JSON transport.
- Put identity/session/resume tokens behind `SessionStore`, and state views behind `SnapshotPublisher`.
- A future Colyseus adapter may implement these ports; the current WS adapter remains viable.

Revisit adoption when **any two** are true: (1) session resume/reconnection and seat reservation enter scope; (2) more than one room type or dynamic room creation/matchmaking ships; (3) hand-built full snapshots/deltas exceed bandwidth budget or schema evolution repeatedly causes regressions; (4) horizontal room placement/drain/migration is required; (5) the team spends two consecutive milestones rebuilding framework lifecycle/schema features. Benchmark a thin vertical slice first: one generated room, reconnect, schema bandwidth/CPU, and client adapter complexity. No big-bang rewrite.

## 6. Minimal staged repair plan

**Patch 0 — immediately, before more Stage C work:** fix server-owned time/ack semantics, high-Hz send cadence, proxy IP trust, exact protocol version, downed enemy-loop return, game-over socket cleanup, pong-id validation, disconnected attribution, and chest opener ownership. Add focused regressions.

**Patch 1 — command and player authority:** add semantic equip and blessing-choice commands; authoritative offer state; wire inventory/items/mods/revive progress; one projection/apply schema. Delete online direct mutations in `Game`.

**Patch 2 — real run world:** server-created seed/generated dungeon/objective; full bootstrap schema; stable IDs; server clear/exit/descend; multi-player transition policy; per-floor reset and offers. Keep solo `LocalTransport` unchanged.

**Patch 3 — reliable views:** monotonic world revision/tick/ack, event IDs/ring/dedupe, coherent interest enter/leave/hysteresis, state-derived critical transitions, stale snapshot rejection.

**Patch 4 — production gate:** mandatory root/server tests and harness in CI, production-shape soak, trusted-proxy/WSS staging smoke, deploy artifact + drain/readiness/rollback, then a final architecture review. Only then merge Stage C.

## Merge gate

PR #22 may merge only when every ownership row above is server truth in online mode, no direct online gameplay mutation remains in `Game`, generated multi-floor play passes with two clients, Patch 0 defects have regressions, event/snapshot ordering is robust under loss/reorder/backpressure, and the staging WSS path is verified. Passing the existing arena tests is necessary but not sufficient.
