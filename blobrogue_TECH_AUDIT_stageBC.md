# Stage B/C Technical-Director audit — response & resolution

Point-by-point resolution of the TD audit that blocked PR #22. Every P0/High has a fix + a
dedicated regression test. All suites green (root goldens 6, sim 61, purity; server Stage B 14 +
Stage C 39 + hardening 16). No gameplay features added.

Run everything: `npm test` (root) and `cd server && npm test`; measurements `cd server && npm run harness`.

## P0 blockers

**P0-1 — online inventory/switch + blessing choices were client-local.**
Resolved. Weapon inventory + current selection are authoritative (`PlayerSim.ownedWeapons`/`weapon`,
streamed in `SelfWire`). Switching is an intent message `{t:"switch",weapon}` validated server-side
(`switchWeaponInWorld` equips only OWNED slots; cooldown/swing reset in the sim). Blessing choices
are server-decided (seeded `rollBlessingChoices`, sent as `{t:"offer",id,choices}`); the pick
`{t:"pickBlessing",itemId}` is validated against exactly the offered set and applied server-side;
mods flow back via `SelfWire.mods`. Persistence is Stage D (documented).
Tests: sim "weapon switch" (2), server "two clients switch independently" + "unowned rejected",
"blessing offer/pick authoritative; off-pool rejected; consumed can't re-pick".

**P0-2 — server was a fixed sandbox arena.**
Resolved. The server world is a REAL generated dungeon run (`GameWorld` → `createWorld(seed,1,
{isShared})`): authoritative seed/floor/dungeon/enemies/props/chests/pickups, objective/boss state,
`cleared`/exit-open flag, and a **party-wide** `descend` (only when all living players reach the
cleared exit; server-decided, no client transition). Snapshots carry `seed`/`floor`/`cleared`;
clients rebuild the identical dungeon geometry on descend.
Tests: sim "party-wide descend" + "same next floor/seed/enemy layout"; server "authoritative
descend: both clients transition to the same next floor + layout".

**P0-3 — client-controlled dt allowed 2x time + bad acks.**
Resolved. The wire `input` carries **no dt**; it is an intent sample. The server tick alone owns
simulation time — each player consumes exactly ONE input command per fixed tick at `FIXED_DT`
(`GameWorld.step`). `ackSeq` = the last command the server consumed; the client replays unacked
commands at the fixed step. A client can no longer buy time.
Tests: server "input flood advances ~1 fixed step/tick (no time advantage)"; existing speed-hack
clamp.

**P0-4 — nginx collapsed all users to loopback for the per-IP cap.**
Resolved. `clientIpFrom` (server/src/net.ts) reads the real client IP from `X-Forwarded-For` ONLY
when the immediate peer is a configured trusted proxy (`GS_TRUSTED_PROXIES`, loopback by default);
an untrusted peer's XFF is ignored (no spoofing). Per-IP cap now keys on the real client.
Tests: hardening "clientIpFrom trusts XFF only from a trusted proxy; ignores spoofed XFF" (unit) +
"per-IP cap uses X-Forwarded-For behind the proxy" (integration).

**P0-5 — high-Hz clients could exploit input cadence.**
Resolved. The client predicts on a FIXED-timestep accumulator and sends exactly one command per
fixed step, independent of render FPS; the server consumes one per tick. A 240Hz client produces
the same cadence as a 30Hz one.
Tests: hardening "30/60/144/240Hz clients advance equally (fixed-step sampling)" (spread ~0px).

## Highs

**H1 — downing could abort enemy processing.** Fixed: the shared world (`isShared`) never
early-returns the enemy loop on a player hitting 0 HP (down/revive owns that); solo keeps its
game-over early-return. Tests: sim "down does NOT abort enemy iteration" + non-shared control.

**H2 — transient events lossy/non-idempotent.** Fixed: a bounded per-room reliable-event ring
tags every event with a monotonic id; each snapshot carries events newer than the client's ack;
the client dedupes by id and acks via `input.ackEv`. Effectively-once under loss/backpressure.
Tests: hardening "a killed enemy's kill event reaches a 40%-loss client exactly once".

**H3 — lag-comp rewound at collision time (wrong for slow projectiles).** Fixed: lag-comp is
anchored at FIRE time (bullets/swings carry `bornTick`+`lagRewind`) and DECAYS one tick per tick
(`fireTimeRewind`), so a hitscan-fast shot tests the shooter's fire-time view while a slow
projectile tests PRESENT positions at impact. Bounded to the history window. Tests: sim
"hitscan-fast shot uses fire-time view" + "slow projectile decays to present-time".

**H4 — client accepted stale/out-of-order snapshots.** Fixed: the client drops any non-full
snapshot with `tick <= lastSnapTick`. (`wsTransport.ingestSnapshot`.)

**H5 — protocol 0 bypass / shallow decode.** Fixed: join requires `protocol === PROTOCOL_VERSION`
(no 0/missing bypass); the client→server decoder deep-validates every field at the boundary.
Tests: hardening "fuzz garbage frames cannot crash + strict protocol-0 rejection".

**H6 — game-over left the socket open.** Fixed: a full wipe is a deterministic leave — the server
sends the final snapshot (carrying the gameOver event) then closes the socket (4008) and removes
the player. Tests: hardening "full wipe deterministically closes the socket + removes the player".

**H7 — wrong chest / disconnected-owner attribution.** Fixed: a bullet that opens a chest credits
the bullet's `owner` (the shooter), with a documented fallback to the primary player when the
shooter has disconnected (`resolveOwner`). Melee already credited the swinging player.

## Architecture quality

- **No god `server.ts`.** Split into small typed modules: `clock` (injectable), `metrics`
  (Metrics class), `net` (proxy IP), `httpEndpoints`, `worldRegistry`, `snapshotPublisher`,
  `messageRouter`, `world`, `connection`, `config`, `auth`, `logger`. `server.ts` is now a thin
  transport/lifecycle orchestrator with DI (clock/codec/metrics/auth/sessions/publisher).
- **Explicit ports** (`server/src/ports.ts`): `RoomRuntime`, `SessionStore`, `SnapshotPublisher`
  — room sim, lifecycle, and state publication are decoupled from the socket server.
- **Exhaustive discriminated unions**: `messageRouter` dispatches `ClientMsg` with `assertNever`
  (a new variant won't compile until handled).
- **Colyseus adapter/revisit documented**: `docs/adr/0001-typed-ws-transport-and-colyseus-seam.md`
  (why finish typed WS now; how each port maps to Colyseus; explicit revisit trigger before public
  Camp/open-world).

## Reconnect/resume (deferred to Stage D — allowed)

Live gameplay state is fully server-owned while connected (positions, HP/mods/inventory/coins/
combo, enemies/bullets/props/chests/pickups/loot, floor/objective, down/revive). Rooms remain
ephemeral; a disconnect ends the run (matches today's solo/co-op). The `SessionStore` port is where
reconnect tokens land at Stage D.

### Non-gameplay client-only state (explicitly enumerated)

These stay client-side (presentation only; never authority): camera/viewport, all particles/decals/
gibs/afterimages/muzzle FX, screen trauma/shake/hit-stop freeze/hurt-flash, audio/music, the
pause + blessing overlays (the *choice* is server-validated; the overlay is UI), minimap, HUD
layout, cosmetic squash/lean anim, biome tint/torches, input key bindings + autofire resolution,
FPS/dev readouts, and the local render-extrapolation of the predicted player between fixed steps.
