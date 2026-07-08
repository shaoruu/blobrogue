# Stage B/C Technical-Director audit — response & resolution (closeout)

Point-by-point resolution of the TD audit that blocked PR #22 (the audit itself is
`docs/specs/blobrogue_TECH_AUDIT_stageBC.md`). Every Blocker, High, and Medium finding has a
fix + a dedicated regression test. No gameplay features added; solo is byte-identical
(golden-master proof).

Run everything: `npm test && npm run build` (root), `cd server && npm install && npm test &&
npm run build`, measurements `npm run harness` (root). Current totals: root goldens 6/6, sim
81, protocol 65, netcode 19, floor-run golden 36, purity PASS; server Stage B 14 + Stage C 49 +
hardening 52 + ticket agreement 14.

## Blockers

**B1 — authoritative time was client-controlled (`dt`).**
Resolved. Inputs are dt-less INTENT samples; the server tick consumes exactly one per fixed
50ms step and acks only consumed sequences (`server/src/world.ts`). The client samples/sends on
the same fixed-step accumulator, so cadence is frame-rate independent. The strict decoder
rejects unknown fields, so a smuggled `dt` is a protocol error rather than silently ignored.
Tests: hardening "adversarial dt (0/1e9/-5) rejected + zero movement + kicked", "input flood
advances ~1 step/tick", "60/120/144/240Hz clients advance equally"; protocol "input carrying dt
is a protocol error"; stagec "speed/fire-rate hack clamped to the tick cadence".

**B2 — online inventory/switching was split-brain.**
Resolved. `equip {weapon, cseq}` is a validated semantic command (only OWNED slots equip;
stale/duplicate cseq dropped — idempotent retries). `ownedWeapons`/`ownedItemIds`/`mods` ride
`SelfWire` through the exhaustive projection boundary; the online client never calls
`equipWeaponInWorld`. Tests: stagec "two clients switch independently; unowned equip rejected;
stale cseq ignored"; sim "switch only owned slots"; protocol projection round-trip.

**B3 — blessings were client-rolled and client-applied online.**
Resolved. The server owns the offer RNG (dedicated stream), offer ids, expiry
(`GS_OFFER_TTL_MS`), and validation; the client answers `chooseBlessing {offerId, choiceId}`;
mods apply server-side and provably change server combat. Tests: stagec "offer/choose
authoritative; wrong-offer-id + off-pool rejected; consumed offer can't re-claim"; hardening
"expired offer rejects a late choice"; floorrun "blessings measurably change combat".

**B4 — no authoritative multi-floor world (fixed seed/sandbox bootstrap).**
Resolved. The server rolls a FRESH random seed per run, owns the generated
dungeon/rooms/objective/exit, alone evaluates clear/exit/descend, applies per-floor resets +
offers to every player, and resets the room to a new run when it empties. Snapshots carry world
revision, seed, floor, cleared, terminal `over`, and stable ids for every entity class. Tests:
`test/floorrun.test.ts` (2-player generated-floor golden: pickups → diverging inventories →
diverging blessings → combat clear → exit gate → one descend → new dungeon → wire coherence);
stagec "multi-floor run over the wire (2 clients, 2 descends, offers between)"; hardening "run
reset on empty room".

**B5 — proxy connection identity broken under the documented nginx topology.**
Resolved. Forwarded headers are honored only when the direct peer is a trusted proxy (loopback
default): X-Forwarded-For rightmost-non-trusted first, then X-Real-IP — the header the shipped
nginx template actually sets (the real breakage: the old code read only XFF, which nginx never
set). Junk values fall through; untrusted peers' headers are ignored. Tests: hardening "spoofed
XFF/X-Real-IP ignored", "X-Real-IP shape resolves the real client", "20 distinct proxied users
all join at the default per-IP cap of 16".

**B6 — high-refresh clients could self-disconnect.**
Resolved. Input cadence is fixed-step (~20/s at any FPS) and inbound rate limiting is segmented
into per-class buckets (input/control/stat/pong) under the aggregate cap. Tests: hardening
"240Hz client plays sustained with rateLimited=0 and bounded internals", "input-class flood is
killed by the input bucket", "60/120/144/240Hz equivalence".

## Highs

**H7 — downing a player aborted enemy processing.**
Resolved: the early return excludes `isShared` worlds. Tests: sim "down does NOT abort enemy
iteration in a shared world" + non-shared control.

**H8 — events were lossy and non-idempotent.**
Resolved: per-world monotonic event ids + bounded ring, per-client resend until acked, client
id-dedupe, snapshot `evTo` high-water (ack advances past interest-filtered gaps), and critical
transitions derivable from STATE (floor/seed/rev, cleared, over). Tests: hardening "kill event
exactly once under 40% loss"; netcode "resend dedupe + evTo ack + acked ids never replay",
"terminal state from snapshot".

**H9 — lag compensation applied at collision time, wrong for melee/slow projectiles.**
Resolved: fire-time anchored rewind that decays with projectile age; melee evaluates BOTH
actors at fire time (swing-origin attacker pose + rewound target); the rewind window uses the
client's reported adaptive render delay clamped to [90,300]ms with server-measured RTT. Tests:
sim "fire-time swing hits what the attacker saw", "impossible hit: post-fire movement can't
drag a rewound swing onto a target", "hitscan fire-time view / slow projectile decays to
present", "absurd rewind clamps".

**H10 — snapshot ordering unchecked.**
Resolved: stale world revisions and stale/duplicate ticks are ignored; the ack never decreases
(a replayed full snapshot can't resurrect consumed inputs). Tests: `test/netcode.test.ts`
reorder/duplicate/stale-rev/ack-monotonic over a scripted fake socket.

**H11 — shallow decode; protocol version bypass.**
Resolved: exact integer version required (v2); EXHAUSTIVE runtime validation both directions
(every server field type/range-checked, a compile-time-exhaustive per-event schema table,
unknown-field rejection on client frames). Tests: protocol round-trips every variant, 2×3000
frame fuzz (only ProtocolError ever escapes), corrupt-snapshot rejection; hardening fuzz +
protocol-0 rejection.

**H12 — incomplete disconnect/game-over lifecycle.**
Resolved: `Game.gameOver()` stops the transport; unexpected transport close online ends the run;
the server closes sockets deterministically on game over; the last standing player leaving no
longer strands downed teammates (idempotent `endRun` via the stranded-wipe check); an emptied
room resets to a fresh run. Tests: sim "stranded downed player gets game over, exactly once";
hardening "wipe closes socket + removes player", "room resets on empty".

**H13 — attribution shortcuts (primary-player fallback).**
Resolved: `primaryPlayer` no longer exists. A departed actor's projectiles/burns/explosions
still deal damage but credit NO ONE (never another live player); burns keep the immutable owner
id; bullet-opened chests use the bullet's owner only. Tests: sim "departed owner's kill credits
no one", "departed igniter's DoT credits no one", "departed owner's bullet does not open a
chest for someone else", "live bullet's chest credits the shooter".

## Mediums

**M14 — interest filtering wasn't a view model.** Per-client `InterestView` with enter/exit
hysteresis (enter R, leave 1.15R, stable ids, rev-scoped) + event scope filtering (pid events to
their player, positional FX inside the view, objectives global). Tombstones are unnecessary:
snapshots carry full entity sets, so leave = absence. Tests: protocol hysteresis suite;
hardening "far client receives no distant positional events; ack still advances".

**M15 — lag-comp time model disagreed with adaptive interpolation.** The client reports its
actual adaptive render delay (`stat.dly`); the server clamps it to the same [90,300]ms window.

**M16 — heartbeat accepted any pong.** Only the outstanding ping's id counts; wrong/unsolicited
pongs neither reset liveness nor touch RTT. Test: hardening "wrong-id pongs still time out".

**M17 — config accepted invalid values.** `intEnv` enforces integer + min/max and fails fast at
boot. Test: hardening "invalid config refuses to boot".

**M18 — production deployment as a verified path.** Partially closed: the deploy/control plane
shipped separately (PR #23, `control/`); this PR adds the production JOIN path (Convex minter →
verifier byte-agreement, production URL default, production-shaped handshake smoke). Live WSS
staging remains an operator step (no deploy access from the authoring environment): deploy the
updated server build (protocol v2) and `npx convex env set GS_AUTH_SECRET <shared secret>`.

## Architecture

`src/net/playerSnapshot.ts` is the single `AuthoritativePlayerSnapshot` projection/apply
boundary: every `PlayerSim` field classified exactly once (server-owned vs client-owned) with a
compile-time exhaustiveness guard (an unclassified field does not compile), used by
`toSelfWire`/`applySelfWire` AND the render-player copy. This fixed a live bug of exactly the
audit's predicted class: the manual render copy silently dropped
`ownedWeapons`/`ownedItemIds`/`mods`/`reviveProgress` online. `src/sim` purity and solo goldens
hold; the `RoomRuntime`/`SessionStore`/`SnapshotPublisher` ports and the Colyseus ADR
(`docs/adr/0001`) are unchanged.
