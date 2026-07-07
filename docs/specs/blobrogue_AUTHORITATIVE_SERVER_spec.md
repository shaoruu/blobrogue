# blobrogue — AUTHORITATIVE GAME SERVER (build-ready re-spec)
Supersedes host-authoritative Stage 1 (now the fallback/reference). Ian's call: a real dedicated authoritative server is the single source of truth; browsers are thin (send inputs, render server state with prediction+reconciliation); Convex shrinks to accounts/auth/persistence; realtime = WebSocket. Grounded in the actual code (I audited every sim module + game.ts's method layout).

## THE GOOD NEWS (why this is feasible, from the real audit)
The scary part — "extract the sim so we don't write combat twice" — is already 80% done by how the code is structured. I checked:
- **enemies.ts, pathfind.ts, dungeon.ts, rng.ts, anim.ts, items.ts, weapons.ts, types.ts = ZERO browser references.** Pure TS logic already. They import nothing from canvas/DOM/audio/window. These MOVE into the shared core as-is.
- **game.ts (3759 lines) is the only coupled file, and it's already internally split:** the sim methods (update, updatePlayer, updateShooting, updateEnemies, strikeEnemy, killEnemy, moveCircle, isWall, blockedByProp, loadFloor + the place*/spawn* helpers) are separate from the render methods (everything `render*`/`draw*` at L2491+) and input (bindInput).
- **The ONLY coupling to sever inside sim methods is cosmetic side-effects:** ~21 `sfx()` calls, ~52 `spawnParticles/Puff/Gibs/Sparks/addDecal`, ~31 `addTrauma/addFreeze/hurtFlash`. These are fire-and-forget FX the sim shouldn't own anyway. Replace them with an EMITTED EVENT (see §1) and the sim becomes pure.
So the isomorphic refactor is: move the already-pure modules + the sim half of game.ts into a `sim/` core that emits events instead of calling FX, leaving game.ts as a thin client (prediction + render + input). No combat is rewritten. This is the linchpin and it's tractable.

===============================================================
# 1. THE ISOMORPHIC SIM CORE (the linchpin — get this right first)
===============================================================
## Target shape: a pure, deterministic, environment-free module
Create `src/sim/` (compiled for BOTH node + browser — no DOM, no canvas, no `import.meta`, no `sfx`, no `Date.now` inside step; time is passed in). Public surface:
```ts
// The entire authoritative world state — plain data, serializable, no class methods with I/O.
interface WorldState {
  tick: number;
  seed: number;
  players: Map<PlayerId, PlayerSim>;   // pos, hp, weapon, mods, dash, fireCd, aim, dead/down...
  enemies: EnemySim[];                  // the existing Enemy struct (already pure data)
  bullets: Bullet[];                    // already pure data
  props: Prop[]; pickups: Pickup[]; chests: Chest[];
  dungeon: Dungeon;                     // from dungeon.ts (pure)
}
// One authoritative step. Pure: same (state, inputs, dt) -> same (state, events) everywhere.
function stepWorld(state: WorldState, inputs: Map<PlayerId, InputCmd>, dt: number): SimEvent[];
```
`stepWorld` is game.ts's `update(dt)` with the player-input read from `inputs` (not from `this.keys`) and every cosmetic call replaced by `events.push(...)`.

## InputCmd (what a player intends this tick) — replaces reading this.keys/mouse directly
```ts
interface InputCmd {
  seq: number;            // client input sequence # (for reconciliation)
  moveX: number; moveY: number; // -1..1 (already how updatePlayer derives ix/iy)
  aim: number;            // radians
  firing: boolean; dash: boolean;
}
```
updatePlayer/updateShooting already compute from ix/iy/aimAngle/mouse.isDown/keys — swap those reads for `inputs.get(pid)` fields. Minimal change.

## SimEvent (replaces the inline FX calls — the key decoupling)
The sim EMITS what happened; the client turns events into juice, the server ignores most:
```ts
type SimEvent =
  | { t: "shot"; pid; weapon; x; y; aim }        // client: muzzle flash + shell + sfx + recoil + trauma
  | { t: "hit"; x; y; color; crit }              // client: puff + hit sfx
  | { t: "kill"; kind; x; y; big }               // client: gibs + decal + death sfx + freeze + trauma
  | { t: "hurt"; pid; x; y }                     // client: hurt vignette + sfx
  | { t: "dash"; pid; x; y }                     // client: sfx + afterimage
  | { t: "propBreak"; kind; x; y } | { t:"explosion"; x;y;r } | { t:"pickup"; kind; pid } ...
```
Every current `sfx()/spawnParticles/addTrauma` call site inside a sim method becomes one `events.push({t:...})`. The client's event handler (in game.ts) maps each event to the EXISTING spawnParticles/sfx/addTrauma code — so the juice code doesn't move, it just gets driven by events instead of inline calls. On the server, events drive nothing (or only server-side loot/persistence hooks). ~104 call sites → mechanical replacement, done incrementally (see §4).

## What stays OUT of the core (client-only, never in sim)
Rendering (all render*/draw*), audio (audio.ts), input binding, anim *presentation* (the visual squash is fine to keep client-side; the sim only needs positions/hp/phase — note: anim.ts is pure so it CAN be shared, but the sim doesn't need the cosmetic parts). Particles, decals, trauma, camera, HUD, minimap = client-only.

## Determinism requirements (must-fix during extraction)
- The sim uses `Math.random()` in a few spots (createEnemy's zig, fire()'s jitter, dropLoot rolls). For an AUTHORITATIVE server this is fine (server is the only roller) BUT for client PREDICTION to match, either (a) don't predict the random-bearing outcomes (predict movement only, let bullets/damage reconcile from server), or (b) thread the seeded Rng (rng.ts) through stepWorld for anything prediction must match. Recommendation: **predict only local player movement + own bullet spawn positions; treat all damage/kills/spawns as server-authoritative (reconciled), so RNG divergence never matters.** This keeps prediction simple and cheat-proof.

===============================================================
# 2. SERVER ARCHITECTURE
===============================================================
## Process shape
A standalone Node/TS process (`server/` package, imports `src/sim/` — shared via a workspace/path import or a tiny monorepo; keep one repo, two tsconfigs like Convex already does). Responsibilities:
- Owns N **world instances** (Stage 1: one shared world; later: one per region/shard). Each world = a WorldState + its connected players.
- **Fixed tick loop at 20-30Hz** (recommend **20Hz / 50ms** to start — plenty for a top-down shooter, half the CPU/bandwidth of 30Hz; revisit if combat feels laggy). Use a drift-corrected accumulator (`setInterval` at ~5ms polling a monotonic clock, or a self-correcting `setTimeout`) — NOT a naive setInterval(50) which drifts.
- Each tick: drain queued InputCmds per player → `stepWorld(state, inputs, dt=fixedStep)` → collect SimEvents → build per-client snapshots (§2 interest mgmt) → send. Discard events server-side except loot/kill hooks that write persistence.
- Ports: one WS port (e.g. 8080) behind the town's reverse proxy (nginx) with TLS (wss://). Health endpoint for the process manager.

## World-state model & tick
- Authoritative: every enemy, boss, bullet, prop, pickup, and player POSITION/HP lives in WorldState on the server. Hit detection, damage, collision (moveCircle/isWall/blockedByProp), enemy AI (updateEnemies), pathfinding (pathfind.ts) all run server-side via stepWorld.
- Player inputs are the ONLY thing clients author. The server validates (clamp move to unit, ignore impossible dash spam via the existing dashCd, rate-limit inputs) → cheat-resistant (no client-fabricated hits; a client can only claim inputs, never "I killed X").
- Bullets: server owns them. Client predicts its own bullets' visual travel for feel, but hits/damage are server-side (client shows a predicted puff, server confirms/denies via snapshot).

## How existing logic ports (concretely)
- enemies.ts / pathfind.ts / dungeon.ts / rng.ts / items.ts / weapons.ts / types.ts → move under `src/sim/` unchanged, imported by both server and client.
- game.ts sim methods → `src/sim/world.ts` as free functions over WorldState (not class methods), emitting events. The player-loop reads InputCmd. Multi-player from the start: updatePlayer runs per connected player (the server already needs N players; game.ts's single `this.px/py` becomes `player.x/y` in the players map — this is the one real structural change, and it's mechanical).
- The client keeps a LOCAL WorldState it runs stepWorld on for prediction (same code), then reconciles against server snapshots.

===============================================================
# 3. NETCODE PROTOCOL
===============================================================
## Transport
**Plain WebSocket** (the `ws` library server-side, native WebSocket in browser). Not WebRTC (data channels add NAT/STUN/signaling complexity for no gain here — client↔server is a normal WS to a known host). Not Convex (it's a doc DB, wrong tool for 20Hz input/snapshot streams — that was the whole reason for this re-spec). Messages as **compact JSON to start** (simple, debuggable); move to a binary encoding (e.g. a hand-packed ArrayBuffer or msgpack) ONLY if bandwidth profiling demands it — premature for the player counts here.

## Client → Server (inputs)
```
{ t:"input", seq, tick, moveX, moveY, aim, firing, dash }   // sent every client frame or ~30-60Hz, coalesced
{ t:"join", token }   // token = a short-lived Convex-issued auth ticket (see §5 identity)
{ t:"ping", id }
```
Inputs carry a monotonic `seq` — the server echoes the last-processed seq in snapshots so the client knows what to reconcile from.

## Server → Client (snapshots)
```
{ t:"snap", tick, ackSeq,           // ackSeq = last input from THIS client the server applied
  self: { x,y,hp,maxHp,dash,fireCd,... },   // authoritative local-player state (for reconciliation)
  entities: [ compactEnemy... ],    // only those in interest radius (delta if possible)
  players: [ otherPlayerPoses... ], // other players in range
  bullets: [ ... ], events:[ SimEvent... ] // events since last snap for one-shot juice
}
```
- **Snapshot rate: 20Hz** (every tick) or decouple to ~15Hz if bandwidth needs it; interpolation covers the gaps.
- **Delta / interest management (reuse the Stage-1 insight):** only send entities within an interest radius of each player (e.g. 1.5× viewport). Later (open world) this becomes per-region. Send full state on join, deltas after (only changed fields / entities that moved). Start with full interest-filtered snapshots; add field-deltas only if bandwidth profiling calls for it.

## Prediction + reconciliation (the standard model, concretely for our entities)
- **Local player (predicted):** client applies its own InputCmd to its local WorldState every frame via stepWorld (same code as server) → zero-latency movement/feel. It keeps a ring buffer of unacked inputs (seq'd).
- **Reconciliation:** each snapshot carries `self` + `ackSeq`. Client snaps its predicted player to `self` (server truth), then RE-APPLIES all inputs with seq > ackSeq on top → smoothly corrects only on genuine divergence (usually invisible). This is the classic Quake/Overwatch model; our stepWorld being pure is exactly what makes replay-reconciliation possible.
- **Other players + all enemies (interpolated):** NOT predicted — rendered from snapshots via **the interp.ts buffer you already built** (RENDER_DELAY ~100-120ms, same as today's remote players). This is the Stage-1 insight carried over verbatim: enemies become "remote entities" smoothed by interp. Zero new smoothing code.
- **Bullets:** predict your own for visual travel; enemy/other bullets interpolate; damage is always server-confirmed.

===============================================================
# 4. CLIENT REFACTOR (game.ts)
===============================================================
- game.ts stops being the authority. Its `update(dt)` splits: (a) sample input → InputCmd → send to server + push to local prediction buffer; (b) run stepWorld on the LOCAL predicted WorldState for the local player only; (c) ingest latest server snapshot → reconcile local player, replace enemies/other-players/bullets from snapshot (via interp); (d) drain snapshot `events` → the EXISTING sfx/particle/trauma code (now event-driven).
- Render methods: unchanged — they already draw from this.enemies/bullets/props/pickups; now those arrays are populated from server snapshots instead of local sim. Camera still follows the predicted local player.
- The event-handler is where all the ~104 former inline FX calls now live (one switch over SimEvent → the same spawnParticles/sfx/addTrauma bodies). The juice looks identical; it's just triggered by events.

## SOLO MODE (must still work, ideally no network round-trip) — EMBEDDED SERVER
Solo runs the SAME authoritative sim IN-PROCESS, no sockets:
- Factory an in-tab "local transport": solo instantiates the server's world module directly and calls stepWorld synchronously each frame, feeding it local input and reading state back — a loopback with no serialization, no latency, no WS. The client code path is identical (it talks to a `Transport` interface); solo binds a `LocalTransport` (in-process), multiplayer binds a `WSTransport`.
- Because prediction and authority are the SAME stepWorld, solo = "prediction that's always right" (server IS local). No reconciliation ever fires. So solo has zero netcode, zero round-trip, and — critically — **runs the identical sim, so solo feel is unchanged and can't regress relative to multiplayer.** This is the clean answer to "how does solo work": one `Transport` seam, `LocalTransport` for solo, `WSTransport` for online. (Mirrors how CoopBridge already abstracts co-op; same discipline.)
- Determinism/feel guarantee: solo's stepWorld is the exact module the server runs, so no "two combats." That's the payoff of the isomorphic core.

===============================================================
# 5. MIGRATION STAGING (incremental, each deployable, no big-bang)
===============================================================
- **STAGE A — EXTRACT THE SIM CORE (no server yet, ship-in-place).** Pull the pure modules + game.ts sim methods into `src/sim/`, convert the ~104 FX calls to emitted events + a client event-handler, and make solo run through a `LocalTransport` calling stepWorld. NO network. The game plays EXACTLY as today (solo), but now on the refactored core. This is the risky refactor done in isolation, verifiable against current behavior, shippable. THE hard part — do it first, alone. (Melee content keeps shipping in parallel on the old path until this lands, then rebases onto the core.)
- **STAGE B — POC SERVER + ONE ENEMY over WS.** Stand up the Node server running stepWorld on a tiny world (one room, one enemy), one client connects via WSTransport, renders it authoritatively, predicts its own movement, reconciles. Proves the transport + prediction + interp loop end-to-end on minimal surface. Throwaway-ish, measures latency/bandwidth (the go/no-go, §6).
- **STAGE C — SERVER OWNS ALL ENEMIES + COMBAT for a co-op room.** Full stepWorld on the server for the current floor game; clients send inputs, render snapshots, predict self. Everyone fights the same server-authoritative enemies/boss. Solo stays LocalTransport. This is the real multiplayer foundation (what host-authoritative Stage 1 aimed at, now done right).
- **STAGE D — ADD OPEN-WORLD MODE ALONGSIDE FLOORS (floors stay permanent).** UPDATE (Ian: "i want both — love the levels!"): the floor-by-floor roguelike loop STAYS AS-IS, untouched, as one selectable MODE. Open-world becomes a SECOND mode on the SAME authoritative core — same stepWorld, same server, same biomes/props/chests/combat. A menu toggle picks the mode; the server hosts floor-worlds (per-run, ephemeral) AND open-worlds (persistent) as two flavors of the same World abstraction (a `mode` field on the world drives whether it descends/ends vs persists). Open-world = one persistent map, no run-end, death→hub respawn — but ADDED next to floors, never replacing them. Because A/B/C are mode-agnostic (they authoritative-ify stepWorld itself), zero rework: this stage just adds a world flavor.
- **STAGE E — INTEREST MGMT / REGIONS + chunk streaming (open-world mode).** The open-world map goes big: server shards it by region; snapshots are per-interest. Floor mode is unaffected (small bounded maps need no streaming). Scale.
- **STAGE F — WORLD BOSSES + drop-in public worlds + persistence wiring** (open-world mode): Convex saves gear/Amber/boss-flags; server loads on join, writes on events. Floors keep their existing per-run structure; shared persistence (gear/Amber) can span both modes if desired.
Each stage leaves a deployed, playable game; Stage A ships as a pure refactor with no visible change.

===============================================================
# 6. HOSTING / OPS (Hetzner, alongside town, pm2 — LOCKED)
===============================================================
Decision locked: the game server runs on Ian's EXISTING Hetzner box, the same one town runs on, and matches town's ops pattern (./deploy.sh + pm2). Keep it lean and fully independent of town.

## Coexist with town (no interference)
- **Separate port.** Town has its own port; the game server binds its OWN localhost port (e.g. 127.0.0.1:8090 — pick any free one town isn't using; confirm with `ss -ltnp` on the box). Bind to 127.0.0.1, NOT 0.0.0.0 — nginx is the only thing that should reach it directly (see firewall).
- **Its own pm2 process.** Register as a distinct app so its lifecycle never touches town's: `pm2 start dist/server.js --name blobrogue-gs` (or via an ecosystem file, below). Town keeps its own pm2 app; they share the pm2 daemon but are independent processes — restart/stop/reload one without affecting the other.
- **Resource isolation.** Cap the game server so a runaway world can't starve town: in the pm2 ecosystem file set `max_memory_restart: "512M"` (pm2 restarts it if it exceeds that). Town is unaffected.
- **Separate logs.** pm2 keeps per-app logs (`pm2 logs blobrogue-gs`); set explicit `error_file`/`out_file` in the ecosystem file so they don't mingle with town's.

## pm2 ecosystem file (mirror town's pattern) — `server/ecosystem.config.cjs`
```js
module.exports = {
  apps: [{
    name: "blobrogue-gs",
    script: "dist/server.js",
    cwd: "/opt/blobrogue-gs",          // its own dir, not town's
    instances: 1,                       // ONE process — in-memory world state; do NOT cluster
    exec_mode: "fork",                  // NOT cluster mode (stateful, single-owner worlds)
    max_memory_restart: "512M",
    env: { NODE_ENV: "production", PORT: "8090", CONVEX_URL: "<prod convex url>", GS_AUTH_SECRET: "<shared secret for ticket verify>" },
    error_file: "/var/log/blobrogue-gs/err.log",
    out_file:   "/var/log/blobrogue-gs/out.log",
    time: true,
  }],
};
```
KEY constraint: **instances:1 / fork mode, never cluster.** Worlds live in process memory; a second instance would be a separate, inconsistent world. Horizontal scale later = more named apps on more ports (one per shard/world-group), fronted by nginx routing — not pm2 cluster mode.

## Deploy script (mirror town's ./deploy.sh + pm2) — `server/deploy.sh`
```sh
#!/usr/bin/env sh
set -eu
# Build, sync, reload — matches town's deploy.sh + pm2 flow.
npm ci && npm run build:server          // tsc the server (+ shared src/sim) to dist/
rsync -az --delete dist/ ecosystem.config.cjs package.json deploy@HETZNER-HOST:/opt/blobrogue-gs/
ssh deploy@HETZNER-HOST 'cd /opt/blobrogue-gs && npm ci --omit=dev && pm2 startOrReload ecosystem.config.cjs && pm2 save'
```
- `pm2 startOrReload` = near-zero-downtime restart if running, first-start if not (the idiom town uses). `pm2 save` persists the process list so the apps auto-restore at boot (with `pm2 startup` configured once).
- If you build ON the box instead, drop the rsync, `git pull` in /opt/blobrogue-gs, then `npm run build:server && pm2 startOrReload …` — whichever matches town's existing flow; keep them consistent so there's one deploy mental model.
- One-time on the box: run `pm2 startup` once (so pm2 auto-restores apps at boot), create `/var/log/blobrogue-gs`, create `/opt/blobrogue-gs`.

## nginx + WebSocket endpoint (reuse town's nginx + TLS)
Add a location (or a subdomain server block) to the existing nginx that already fronts town, reusing its Let's Encrypt cert:
```nginx
# wss://blobrogue-gs.<domain>/ws  (or a path on an existing host)
location /ws {
  proxy_pass http://127.0.0.1:8090;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;     # REQUIRED for WS
  proxy_set_header Connection "upgrade";      # REQUIRED for WS
  proxy_set_header Host $host;
  proxy_read_timeout 3600s;                   # long-lived sockets: don't cull idle-ish conns
  proxy_send_timeout 3600s;
}
```
The `Upgrade`/`Connection` headers + long `proxy_read_timeout` are the WS-specific must-haves (default nginx timeouts will kill long-lived game sockets otherwise). Client points `VITE_GS_URL=wss://blobrogue-gs.<domain>/ws`.

## Firewall / ports (lean, safe default)
- **Do NOT open the game-server port (8090) publicly.** Bind it to 127.0.0.1 and let ONLY nginx reach it. So the firewall (ufw / Hetzner Cloud firewall) keeps exposing just **443** (wss + https via nginx), 80 (redirect + ACME), and SSH — no new inbound port. Safest and simplest: the WS is TLS-terminated at nginx on 443, exactly like town's web traffic.
- If you ever exposed the Node port directly (NOT recommended — no TLS, no shared cert), you'd have to open it in BOTH ufw AND the Hetzner Cloud firewall — Hetzner has a network-level firewall separate from the OS one, a common gotcha (a port open in ufw but closed in the Cloud firewall is still blocked). Avoid; go through nginx on 443.
- Net: proxied through nginx on the existing 443, the game server needs ZERO new firewall changes. That's the lean path.

## Coexistence summary
Different port (127.0.0.1:8090, nginx-only) · own pm2 app (blobrogue-gs, fork/instances:1, mem-capped) · own logs · own /opt dir · shares only nginx+TLS+443 and the pm2 daemon with town · independent deploy.sh · no new open firewall ports. Town is untouched.

===============================================================
# 7. HONEST COST / RISK (read before committing)
===============================================================
- **This is a genuine step up in complexity vs host-authoritative.** You now operate a stateful realtime server: deploys, uptime, crash recovery, WS scaling, an ops surface that didn't exist. Real, ongoing cost. The payoff is real too: true single-source-of-truth, cheat-resistance, no host-migration jank, and the ONLY architecture that cleanly supports a persistent shared open world with bosses — which is exactly Ian's vision. For that end state, this is the right foundation; host-authoritative would fight you at the open-world stage. So: justified for the vision, but don't pretend it's free.
- **The isomorphic-sim extraction (Stage A) is THE risk.** It touches the 3759-line game.ts. Mitigations baked into the plan: the pure modules already move cleanly; the coupling is only ~104 mechanical FX-call→event swaps; Stage A ships as a behavior-preserving refactor you validate against the current game BEFORE any server exists. If Stage A is clean, everything downstream is standard netcode. Do it first, in isolation, with the current game as the oracle. Budget real time here.
- **Tick rate vs bandwidth vs CPU:** 20Hz × interest-filtered JSON snapshots for a handful of players is small (tens of KB/s/client). Watch: snapshot size if enemy counts spike (interest mgmt is the lever), and server CPU if you run many worlds (the sim is O(enemies×players) — fine at co-op scale, profile before mass scale). Start 20Hz/JSON; only reach for 30Hz or binary if profiling says so.
- **WS scaling:** one process handles many worlds to a point; beyond that you shard worlds across processes/boxes (stateless-ish per world makes this clean later). Not a Stage-A..C concern.
- **Determinism gotcha:** don't try to make client prediction reproduce server RNG (loot/spawns). Predict only local movement + own-bullet visuals; reconcile everything else. Keeps prediction simple and avoids desync bugs. (Called out in §1.)
- **Latency feel:** prediction hides it for YOUR movement; other players/enemies lag by interp delay (~100-120ms) exactly as co-op does today — already proven acceptable. Hit-registration is server-side, so high-latency players see a small delay between firing and confirmed damage — mask with the predicted local hit puff (fire-and-forget), reconcile the kill.

## BOTTOM LINE
Feasible without rewriting combat, because the audit shows the sim is already almost pure — the whole plan hinges on Stage A (extract `src/sim/` + event-ify the ~104 FX calls + a `Transport` seam with LocalTransport for solo), which is a contained, behavior-preserving refactor you can ship with zero visible change and the current game as your test oracle. After that it's textbook authoritative netcode (WS transport, input prediction, snapshot interp via the buffer you already have, server reconciliation). Solo stays instant and identical via the embedded LocalTransport. Deploy the lean Node WS server on Hetzner beside town. Do Stage A first and alone — if it's clean, the rest is standard.
