# ADR 0001 — Finish the typed WebSocket transport now; keep a Colyseus adapter seam

- Status: Accepted
- Date: 2026-07-08
- Context: Stage C (authoritative co-op combat). Ian asked whether we should adopt Colyseus
  (idiomatic multiplayer framework) instead of our hand-rolled WebSocket transport.

## Decision

Ship Stage C on the **existing typed WS transport** (proven, green harness), and keep the
architecture **framework-adaptable** behind explicit ports so a later migration to Colyseus (or
another room framework) is an additive adapter, not a rewrite. Do **not** perform a wholesale
Colyseus migration mid-flight.

## Why not migrate now

- **Colyseus does not supply the parts that are hard and already working here:** client-side
  prediction, server reconciliation (deterministic replay of unacked inputs), entity
  interpolation, and **lag compensation** (fire-time-anchored rewind). Those are custom netcode we
  built on our pure `stepWorld`; Colyseus would sit *around* them, not replace them.
- **Our harness is green:** reconnection-free authoritative combat, 0px reconciliation drift under
  50/100/150ms RTT + jitter + loss, tick p95 < 0.5ms, reliable events under 40% loss, anti-cheat
  (server owns time/cooldowns/positions), and a fixed-timestep model immune to client dt and frame
  rate. Rewriting the transport now would risk all of that for no correctness gain.
- **The wire is already tiny + validated** (interest-filtered JSON, strict boundary decode). We do
  not yet have the scale problems Colyseus's schema-delta/matchmaking primarily solve.

## What Colyseus *would* map to (the adapter seam)

We introduced three explicit ports (`server/src/ports.ts`) so each concern can be swapped:

| Our port (concrete impl)                     | Colyseus equivalent                                  |
|----------------------------------------------|------------------------------------------------------|
| `RoomRuntime` (`GameWorld`)                  | a Colyseus `Room` (`onCreate`/`onJoin`/`onLeave`, `setSimulationInterval`) |
| `SessionStore` (`WorldRegistry`)             | Colyseus matchmaking + `MatchMaker` room registry + reconnect tokens |
| `SnapshotPublisher` (`WsSnapshotPublisher`)  | Colyseus `Schema` + `StateView` automatic delta encoding |
| our reliable-event ring + ack               | Colyseus reliable messages / patch stream            |
| our fixed-tick loop + `Clock`                | `room.setSimulationInterval` (Colyseus owns the loop)|

Crucially, our **prediction / reconciliation / interpolation / lag-comp stay as-is** in either
world — they live in the client (`WSTransport`) + the pure `src/sim`, above whatever transport
publishes state. A Colyseus adapter implements the three ports (Room ↔ RoomRuntime, matchmaking ↔
SessionStore, schema-delta ↔ SnapshotPublisher) and re-uses the identical sim + client netcode.

## Explicit adoption checkpoint (revisit trigger)

Re-evaluate Colyseus **before public Camp / open-world (Stage D+)**, when we take on any of:

1. **Reconnect / session resume** — Colyseus's reconnection tokens + `allowReconnection` are
   battle-tested; our `SessionStore` port is where that would land.
2. **Multi-room matchmaking / drop-in public worlds** — Colyseus `MatchMaker`, room filters, and
   seat reservation vs. our single `WorldRegistry`.
3. **Schema-delta / bandwidth at open-world entity counts** — Colyseus `Schema` binary deltas vs.
   our interest-filtered JSON (our Codec seam already makes a binary swap a one-module change).
4. **Horizontal placement across processes/boxes** — Colyseus `@colyseus/proxy` + presence vs. our
   documented directory-indirection plan.

If two or more of those land at once, adopt the Colyseus adapter behind the ports. Until then, the
typed WS transport is the lower-risk, fully-owned choice.

## Consequences

- We maintain the transport ourselves (deploy/ops surface) — accepted; it is small and typed.
- The ports add a thin indirection now (RoomRuntime/SessionStore/SnapshotPublisher) — this is the
  cost that buys the migration option and keeps `server.ts` from being a god blob.
- The sim, client netcode, and tests are transport-agnostic, so the adapter is genuinely additive.
