# blobrogue — STAGE B: POC SERVER + WS + PREDICTION/RECONCILIATION (cursor-agent-ready)
Builds directly on Stage A's output: `stepWorld(state, inputs, dt): SimEvent[]`, `WorldState`, `InputCmd`, `SimEvent`, the `Transport` seam (LocalTransport shipped), and the shipped `interp.ts` buffer. Stage B is the FIRST networked stage: a real Node WS server runs the SAME stepWorld as authority on a tiny world; one client connects via a new WSTransport, renders authoritatively, predicts its own movement, and reconciles. Goal = prove the whole netcode loop end-to-end on minimal surface + run the go/no-go spike. Production hardening per the matrix in the production spec (§ per-stage: B = all socket security/crash-safety essential; lag-comp/resume/binary deferred).

## Scope discipline (what B IS and ISN'T)
IS: one server process, one world, a handful of enemies (or one), 1-2 real clients, WS transport, client prediction of the LOCAL player, server reconciliation, remote entities via interp, and the measurement harness. Prove the loop + the numbers.
ISN'T: not lag-comp (Stage C — no real combat fairness need yet), not reconnect-resume (ephemeral), not interest management beyond "send all" (tiny world), not binary encoding (JSON), not sharding (one world), not the open world. Those are later stages; the production matrix marks them deferrable at B. Keep B small — its job is to de-risk the transport+prediction, not to be the game.

===============================================================
# 1. WHY STAGE A MAKES THIS SMALL
===============================================================
After Stage A: stepWorld is pure + isomorphic, the client already runs it through a Transport (LocalTransport), and rendering already reads from a WorldState + replays SimEvents. So Stage B is almost entirely: (a) a Node process that imports src/sim and ticks stepWorld, (b) a WSTransport implementing the SAME Transport interface LocalTransport does, (c) prediction+reconciliation wrapping the client's stepWorld call. The GAME code barely changes — you swap LocalTransport for WSTransport for the online path; solo keeps LocalTransport untouched. That's the payoff of Stage A: the server is "LocalTransport, but the sim runs over there."

===============================================================
# 2. SERVER (server/ package)
===============================================================
## Process shape
New `server/` (own package.json + tsconfig; imports `src/sim/` via a path alias / workspace ref — one repo, like Convex already coexists). Entry `server/src/main.ts`:
- Create the `ws` WebSocketServer bound to 127.0.0.1:PORT (nginx terminates TLS → wss, per ops spec §6/§7). 
- Hold a `Map<worldId, World>` (the multi-world abstraction from the production spec — B runs ONE world but the shape is there). Each World = { state: WorldState, inputs: Map<PlayerId, InputCmd[]>, clients: Map<connId, Conn>, tick, lastSnapshotAt }.
- **Fixed tick loop at 20Hz (50ms)** via a drift-corrected accumulator (monotonic clock, not naive setInterval): each tick → for each world → drain each player's queued inputs (apply in seq order, sub-step) → `stepWorld(world.state, inputsThisTick, FIXED_DT)` → collect SimEvents → build+send per-client snapshots → advance world.tick.
- The sim tick NEVER awaits a socket write (backpressure: fire-and-forget with `ws.bufferedAmount` guard, production spec §2d).

## Connection lifecycle (production-grade from the first socket — matrix: essential @ B)
- On connect: expect a `join` message with an auth ticket (see §5); validate → bind a PlayerId → add a PlayerSim to the world's `state.players` (spawn at the world's spawn point) → send an initial FULL snapshot. Reject unauthenticated/malformed joins (close with a reason code).
- Per message: strict validate/decode (known type, shapes, finite numeric ranges, capped lengths) inside a try/catch that isolates one conn's error — a malformed message NEVER throws into the tick loop (production spec §2e). Rate-limit inbound msgs/inputs per conn.
- Heartbeat: ws ping every ~5s; drop a conn that misses 2-3 (kills half-open sockets). 
- On disconnect: remove the PlayerSim from the world (B is ephemeral — no resume yet), log lifecycle.
- pm2 auto-restart + structured logging + /healthz from the production spec (essential @ B).

## Server → client message: snapshot
```ts
{ t:"snap", tick, ackSeq,            // ackSeq = last input seq from THIS client the server applied
  self: PlayerSimWire,               // authoritative local-player state for reconciliation
  players: PlayerSimWire[],          // OTHER players (B: all of them; interest mgmt is Stage C+)
  enemies: EnemyWire[], bullets: BulletWire[], // B: all (tiny world)
  events: SimEvent[] }               // events since last snap → client replays juice (handleSimEvents)
```
Wire structs = the compact plain-data subset (no anim — that's client-side per Stage A). JSON to start (Codec interface so binary is a later swap).

## Client → server messages
```ts
{ t:"join", ticket }                 // short-lived signed auth ticket (Convex-minted, §5)
{ t:"input", seq, moveX, moveY, aim, firing, dash }   // the Stage-A InputCmd + seq, ~30-60Hz coalesced
{ t:"pong", id }                     // heartbeat reply
```

===============================================================
# 3. CLIENT: WSTransport + prediction + reconciliation
===============================================================
## WSTransport (implements the same Transport interface as LocalTransport)
```ts
// src/client/wsTransport.ts
export class WSTransport implements Transport {
  private ws: WebSocket;                 // wss://blobrogue-gs.<domain>/ws
  private localState: WorldState;        // client's PREDICTED world
  private pendingInputs: InputCmd[] = []; // unacked ring buffer (seq'd) for reconciliation
  private latestSnap: Snapshot | null = null;
  private events: SimEvent[] = [];
  private seq = 0;

  sendInput(cmd: InputCmd) {
    cmd.seq = ++this.seq;
    this.pendingInputs.push(cmd);
    this.ws.send(encode({ t:"input", ...cmd }));
    // PREDICT: apply locally to localState immediately (zero-latency feel) — LOCAL PLAYER ONLY.
    const evs = stepWorld(this.localState, new Map([[LOCAL_ID, cmd]]), FIXED_DT);
    this.events.push(...evs); // predicted juice (muzzle/dash) fires instantly; server events reconcile
  }
  onSnapshot(s: Snapshot) {   // called from ws.onmessage
    this.latestSnap = s;
    // RECONCILE the local player: snap to server truth, then replay unacked inputs.
    const p = this.localState.players.get(LOCAL_ID)!;
    applyWire(p, s.self);                                   // authoritative pos/hp/cooldowns
    this.pendingInputs = this.pendingInputs.filter(i => i.seq > s.ackSeq); // drop acked
    for (const i of this.pendingInputs) stepWorld(this.localState, new Map([[LOCAL_ID, i]]), FIXED_DT); // re-apply
    // REMOTE entities: feed the interp buffer (enemies + other players + remote bullets).
    ingestIntoInterp(s, receiveTime);
    this.events.push(...s.events); // server-authoritative juice (kills, hits on others)
  }
  poll() {
    // Build the render WorldState: LOCAL player from predicted localState; enemies/others from interp.
    const rendered = composeRenderState(this.localState, interpSample(now));
    const ev = this.events; this.events = [];
    return { state: rendered, events: ev, ackSeq: this.latestSnap?.ackSeq ?? 0 };
  }
}
```
## The three netcode pieces (production spec §1a/1b/1c — essential @ B for the loop; lag-comp deferred to C)
- **Prediction (§1a):** local player applied to localState via stepWorld every input → zero-latency movement/dash/fire feel. ONLY the local player is predicted (Stage-A determinism rule: don't predict damage/kills/enemy AI).
- **Reconciliation (§1b):** each snapshot → set local player to server `self`, drop inputs ≤ ackSeq, replay the rest through stepWorld. Agreement = invisible; divergence corrects (smooth corrections >few px over 2-3 frames). This is exactly why Stage A made stepWorld pure/deterministic — replay-reconciliation depends on it.
- **Interpolation (§1c):** other players + all enemies + remote bullets rendered from snapshots via the SHIPPED interp.ts (RENDER_DELAY ~100-120ms), keyed by entity id. Enemies are just "remote entities." Reuse verbatim — this is the biggest already-built piece.
- Clock sync + adaptive interp delay from measured RTT: minimal at B (fixed delay ok for the POC), refined at C.

## main.ts wiring (the only game-code change)
Online path binds `new WSTransport(url, ticket)`; solo path keeps `new LocalTransport()`. The client raf loop is IDENTICAL for both (build InputCmd → transport.sendInput → transport.poll → renderFrom(state) + handleSimEvents(events)). That Transport symmetry — built in Stage A — is what makes Stage B a small, contained change to the client.

===============================================================
# 4. THE GO/NO-GO SPIKE (run as the FIRST thing in Stage B)
===============================================================
This IS Stage B's core purpose: prove Convex-free WS + the sim-over-network holds up before investing in Stages C-F. Build the minimal loop above with ONE enemy (or a few) and MEASURE with the load harness (production spec §8):
## What to measure + thresholds (GO if ALL hold)
1. **End-to-end input latency (predicted):** local player movement must feel instant (it's predicted, so this is ~0 by construction — verify prediction actually runs and reconciliation doesn't visibly snap under normal RTT). PASS = no perceptible input lag, no rubber-banding at 50-100ms simulated RTT.
2. **Remote-entity latency:** server enemy move → client render < ~200ms (one tick + interp delay + half-RTT). Log the timestamp delta. PASS < 200ms p90.
3. **Reconciliation correctness:** under injected latency/jitter/loss, the predicted local player re-converges to server truth with no permanent drift and no visible teleporting in normal play. PASS = the automated reconciliation test (production spec §8) stays within float tolerance + manual feel is smooth.
4. **Server tick health:** tick time p95 well under the 50ms budget with the POC load (1-4 clients, few enemies). PASS = p95 < ~10ms (tons of headroom at this scale; confirms the model isn't accidentally heavy).
5. **Bandwidth:** per-client snapshot size + bytes/s at 20Hz JSON, all-entities (tiny world). PASS = low-KB/s/client; sanity-check it extrapolates fine to Stage-C enemy counts with interest mgmt.
6. **Robustness smoke:** malformed/flooding messages don't crash the server (§2e/§3); a client disconnect/reconnect cleanly re-joins.
## If it fails
- Latency/jitter feel bad despite prediction → check the fixed-step + clock-sync + interp-delay tuning before blaming transport (usually a tuning bug, not WS).
- Bandwidth/write concerns at scale → interest management (Stage C) + binary codec (Stage E) are the levers; note the projected numbers.
- Only if raw WS latency itself is unacceptable (very unlikely for client↔server on a known host) would you reconsider transport — but the whole point of this re-spec was that Convex was the wrong realtime tool and a direct WS is the right one, so expect green.
- The spike is ~1-2 days on top of the Stage-A output and is the go/no-go for the whole server investment. Run it FIRST in Stage B, before building out the full connection lifecycle/hardening.

===============================================================
# 5. OPS / AUTH for the POC (lean, production-shaped)
===============================================================
- Deploy the POC server as its OWN pm2 app on the Hetzner box (blobrogue-gs, or blobrogue-gs-staging first), 127.0.0.1:PORT, nginx `/ws` reverse-proxy with the WS Upgrade headers + long read timeout, wss via town's cert — all per the ops sections. For pure local spike work you can run it on localhost with `ws://` before wiring nginx; wire wss before any non-local test.
- **Auth ticket:** a Convex action mints a short-lived signed token (JWT or HMAC nonce) for the authenticated playerId; the client fetches it, passes it in the WS `join`; the server verifies (shared GS_AUTH_SECRET or Convex JWKS). Even the POC validates the ticket — never an unauthenticated world (production matrix: auth essential @ B). Guest identity works (the clientId path) — the ticket just binds whatever identity Convex already established.
- Env/secrets: GS_AUTH_SECRET + CONVEX_URL in the box `.env` (chmod 600), not committed.

===============================================================
# 6. BUILD / VALIDATION CHECKLIST (each step verifiable; solo never breaks)
===============================================================
Solo (LocalTransport) is UNTOUCHED throughout — verify it still plays identically after every step.
1. **server/ skeleton:** Node + ws, imports src/sim, one world, fixed 20Hz tick calling stepWorld with NO clients (just prove it ticks a world with one enemy, logs tick-time). Run locally.
2. **WS connect + join + auth ticket** (§5): a client connects, authenticates, gets a PlayerSim + initial full snapshot. Malformed-input/rate-limit/heartbeat hardening in from this step (matrix: essential @ B).
3. **Server→client snapshots at 20Hz**; client renders enemies/other-players from snapshots via interp (NO prediction yet — local player also from snapshot, will feel laggy; that's expected this step). Proves transport + interp end-to-end.
4. **Client prediction + reconciliation** (§3): local player predicted via stepWorld, reconciled to `self`+ackSeq. Local movement now instant. Run the reconciliation test + manual feel.
5. **Server-side input validation/clamping + anti-cheat basics** (§3 of production spec): move clamped to unit, dash/fire honored only if the SERVER's cooldowns allow. Verify a tampered client can't speed/rapid-hack.
6. **THE GO/NO-GO SPIKE (§4):** run the harness, inject latency/jitter/loss, measure all thresholds. Decision point. (You can front-load a minimal version of this right after step 4 to de-risk early.)
7. **Wire main.ts:** online path → WSTransport; solo → LocalTransport (unchanged). One enemy shared between 2 real browser tabs, both authoritative, both predicting their own player. 
8. **Deploy to staging pm2 app on Hetzner**, wss via nginx, run the harness against it (real network, not just localhost). 
GATE to Stage C: the loop works over real wss with 2 clients (both see the same authoritative enemy, both have instant local movement, reconciliation invisible), the spike thresholds all pass, malformed/hostile input can't crash it, and SOLO still plays byte-for-byte via LocalTransport (grep src/sim purity still clean; the game core still imports no ws/Convex — the transport does).

## BOTTOM LINE
Stage B is small because Stage A did the hard part: the server is "run the shipped stepWorld over there," and WSTransport is LocalTransport with a socket + prediction/reconciliation wrapping the same stepWorld, remote entities smoothed by the interp.ts you already ship. Build it minimal (one world, few enemies, 1-2 clients), run the go/no-go spike FIRST with measured thresholds, keep the socket production-hardened from byte one (auth, validate, rate-limit, no-crash, heartbeat, pm2, logs, /healthz), and leave solo on LocalTransport untouched. Green spike + a working 2-client authoritative loop over wss = the foundation proven; Stage C then moves ALL enemies+combat onto it with lag-comp + interest management.
