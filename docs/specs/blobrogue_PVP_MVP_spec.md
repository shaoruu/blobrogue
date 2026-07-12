# blobrogue PVP MVP — build spec (FFA arena deathmatch)

Status: DRAFT for build. Architecture per TD read (/workspace/blobrogue_PVP_ARCH_read.md, grounded in main acd5adc).
Design/balance defaults below are the main-agent's lean; game designer + balancer refine via follow-up (flagged INLINE as [GD?]/[BAL?]).

## GOAL
Add PVP as a real, shipped mode: real-time free-for-all ARENA DEATHMATCH (last blob standing), reusing the
existing twin-stick movement / shooting / authoritative netcode / kits. NOT a fork of the sim. NOT a throwaway prototype.

## HARD ARCHITECTURE CONSTRAINTS (TD — non-negotiable)
1. NO forked sim / no duplicated movement-shooting-collision. ONE `mode` discriminant gating ≤4 concerns only.
2. Client NEVER predicts damage/kills dealt to another player — server-authoritative outcomes only. Victim sees
   the hit on the next authoritative snapshot; shooter sees a confirmed hit event. Do not predict opponent death.
3. Attacker plumbed through the ONE `damagePlayer` funnel (add `by: PlayerId|null`); no second damage path.
4. Exhaustive wire validators BOTH directions on the protocol bump; co-op protocol + goldens UNCHANGED.
5. Deterministic: seeded, tick-based, id-SORTED win/spawn/tie resolution (never Map iteration order). Match timers
   count in ticks, not ms. No Date.now / Math.random in sim.
6. Re-audit isProtected / isAbsent / pendingBlessings / ultInvuln gates for PvP-exploit scoping.

## MODE DISCRIMINANT
- Introduce `type WorldMode = "coop" | "pvp"` on WorldState (sandbox stays orthogonal/dev). Derive existing
  isCoop/isShared booleans from it during migration. Default mode = "coop" so every existing path + golden is a zero-diff.
- `mode` gates ONLY: (1) player-vs-player damage targeting, (2) no AI waves — load arena instead,
  (3) symmetric spawns, (4) match/round state machine (vs floor-clear/descend). Everything else stays shared.

## THE 4 GATED CONCERNS
1. DAMAGE TARGETING: in bullet/melee resolve, an owned round may hit a NON-OWNER player when mode==="pvp"
   (and teams differ), routed through damagePlayer(..., by). Today player ("friendly") bullets only hit w.enemies
   (world.ts ~3184: only !b.friendly damages players) — extend so pvp owned rounds resolve vs other players.
2. NO AI / ARENA: pvp world skips spawnFloorEnemies / wave / boss population; loads a symmetric arena. REUSE the
   buildArena() seam (world.ts:923) that isSandbox already uses to suppress enemies/props/chests/hazards.
   Build ONE fixed symmetric arena (fair sightlines + a little cover). [GD?] arena layout notes welcome.
3. SPAWNS: symmetric fixed spawn points from the arena def, id-sorted assignment (deterministic), max spread.
   Spawn i-frames on (re)spawn [BAL? ~1.5s] so nobody is spawn-camped.
4. MATCH STATE MACHINE (pure sim, tick-based): phases lobby → countdown → live → round-over → match-over.
   MVP (LOCKED — GD pushed off last-standing to kill spectator dead-time): FRAG-LIMIT RESPAWN DEATHMATCH.
   Players RESPAWN ~PVP.respawnDelaySec (2.5s) after death (NOT eliminated); respawn at farthest-from-opponents
   spawn (id-sorted) with 2.0s/first-shot protection. Match ends at PVP.fragLimit frags (SCALED by match-start player count: clamp(round(6+playerCount),8,16) → 2p:8,4p:10,6p:12) OR
   PVP.matchTimeSec cap (default 300s) → most frags wins (id-sorted tiebreak). Phases: lobby→countdown→live→
   match-over (NO per-round loop). checkStrandedWipe fully BYPASSED in pvp (no wipe; dead respawn). Fun at 2 (duel-to-N).
   POST-MVP: round-hybrid short rounds + sudden-death arena-shrink (deferred — not built now).
   NO-SNOWBALL (hard req): ult-charge loop, Gunner momentum/HEAT, kill-heal/lifesteal/on-kill buffs ALL inert in pvp.
   Flat symmetric, zero in-match power gain.

## PVP DAMAGE MODEL (BALANCER — LOCKED numbers, all in one named PVP config block)
- FIXED PVP HP = 100 (PVP.maxHp). NOT the PvE 6-pool (too coarse/swingy). PvP-only; PvE HP untouched. UI: map 100→3-heart bar (33/heart) or a PVP health bar.
- Global PVP.dmgMult = 1.78 (was 2.0; bumped for FFA respawn third-party reset beat), player-vs-player hits ONLY (PvE untouched). Median gun ~4.5s TTK vs 100 HP. Target TTK 4.5s (ship-gate band 3.5-5.5s per-weapon 1v1 median).
- Per-weapon outlier overrides (stack on the 2.0): PVP.weaponMult = { sawnoff 0.45, flamer 0.45, burst 0.72, spear 0.85, beam 0.85 } — dmg*2.0*(weaponMult[id]??1). Map ids to real weapons.ts ids; skip any that don't exist. Everything else rides flat 2.0. (ricochet/tesla/thumper come in slow ~5.8-6.7s — fine, leave.)
- HARD PER-HIT CAP: PVP.perHitCapFrac = 0.35 — no single hit/trigger removes >35% of maxHP (≤35). Anti-one-shot backstop; keep even after per-weapon tuning.
- ULTS: PVP.ultsEnabled = false — blanket-disable ALL kit ultimates for MVP (each degenerate in a duel: Mender heal=stalemate, Bulwark shield=flat EHP win, Phantom dash=infinite disengage, Gunner overheat=least bad, re-add FIRST in v2 tuned). Kit passive stat lean stays (symmetric). Blessings off (symmetric kit).
- Loadout: everyone same symmetric starting kit + weapon (neutral all-rounder). Blessings do not apply.
- SPAWN PROTECTION: PVP.spawnIframeSec = 2.0 (not 1.5 — 1.5 is only ~37% of a 4s TTK). Ends at 2.0s OR first OUTGOING attack, whichever first (no shoot-from-invuln). Plus max-distance FFA spawn selection (anti-camp beyond iframes).
- SHIP GATE (as test assertions): per-weapon 1v1 median TTK 3-5s; ZERO hits >35% HP (assert worst-case point-blank sawnoff clamps to 35); no infinite sustain/disengage (ults off).

## STAGING (TD)
- P1 (sim, no wire): mode discriminant + damagePlayer(by) + owned-round-hits-player resolve + pure match state
  machine + symmetric arena. Prove: pure-sim PvP goldens + determinism (2-4p deathmatch replayed twice =
  byte-identical, reconnect-stable). Co-op goldens UNCHANGED. GATE-ABLE CORE.
- P2 (wire): PlayerWire.team (small int) + match snapshot block (phase/timer/scores/alive/winner, single top-level
  field, delta-encoded) + kill/elimination as reliable id-tagged SimEvents + PROTOCOL_VERSION bump (v27→v28).
  Exhaustive validators both directions; delta round-trip; re-measure snapshot size (should stay tiny).
- P3 (server/lobby): pvp room type in the WorldRegistry (a RoomRuntime with a different populate + win rule),
  match orchestration, spawn assignment. Lobby UI: a "PVP" option in Play Online + room create.

## TESTS (must pass; TD gates)
- New test/pvp.test.ts: pvp mode enables player-damage (owned round hits non-owner, damagePlayer(by) attribution),
  co-op mode still passes friendly through; match state machine transitions (live→round-over on ≤1 alive,
  match-over at bo-N); deterministic winner (id-sorted, replay byte-identical); spawn i-frames; arena symmetric.
- New pvp determinism/golden: scripted 2-4p match replayed twice = identical + reconnect-stable.
- Co-op goldens / determinism / balance / protocol suites UNCHANGED (mode defaults coop).
- npm test green; tsc clean root/server/control (install server+control deps incl @types/ws first).

## ARCHITECTURE SCAN — de-risking specifics (full codebase map, additive to TD read)
- DAMAGE PREDICATE, not a boolean: the co-op `friendly` flag is the whole team model, checked at ~15+ sites (updateBullets ~3184, enemy-strike bullet loop ~3899, detonateBullet ~3282, implodeBullet ~3330, updateEffects zones/wires/sentries/orbits/tethers ~3461+, steerHoming ~3368, chain-lightning/arc, kill-shards, reflect affixes — all iterate w.enemies only). Introduce ONE canDamage(attackerOwner, targetPlayer, w) predicate + route every player-damage subsystem through it + the single damagePlayer(by) funnel. Missing a subsystem = "half the guns don't work in PvP."
- checkStrandedWipe (world.ts ~10262, all-down=gameover) is INVERTED for pvp: last-standing = WIN. Branch on mode; pvp uses the round machine's elimination, not the co-op wipe/down/revive/spectate path.
- Mode routing: mode does NOT reach the server today (only worldId does). Encode mode in the world id (`pvp:room:CODE`), parsed in GameWorld ctor (server/src/world.ts ~79) → createWorld({mode}). AVOID changing the byte-locked ticket payload (convex/gsTicketCore.ts GsTicketPayload + server/test/ticket.test.ts agreement). Mirror the prefix in client worldId derivation.
- Seams confirmed: buildArena() world.ts ~925 → fork buildPvpArena() (symmetric + spawns[]); single shared dungeon.spawn (spawnPlayerInWorld ~560, floor-reposition ~1034) → spawns[] array; PvP scalar in damagePlayer (mode-guarded, PvE goldens untouched); combat already 100% server-authoritative (client predicts only own movement) → zero prediction rework, just render authoritative outcomes.
- PROTOCOL_VERSION currently 27 (protocol.ts:281) → bump to 28. PlayerWire (protocol.ts:367) has NO team field. Room `kind` union (convex/schema.ts:119, rooms.ts:18) already threads create/join/quickPlay/start → add "pvp".
