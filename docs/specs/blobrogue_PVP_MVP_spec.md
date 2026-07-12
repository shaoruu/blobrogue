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
   MVP: FFA last-blob-standing round; best-of-N rounds (N configurable, MVP N=3) [GD? bo3 vs frag-limit].
   Round ends when ≤1 player alive; match ends when a player wins ceil(N/2) rounds. Short reset between rounds.

## PVP DAMAGE MODEL (BALANCER OWNS — defaults pending exact numbers)
- PvE weapon damage would near-instantly delete a player. Apply a GLOBAL PVP damage scalar to player-vs-player
  hits ONLY (PvE damage untouched). [BAL?] target TTK ~3-5s between even players → a single global scalar for MVP;
  per-weapon overrides later. Leave the scalar a NAMED constant (e.g. PVP.dmgScale) so balancer tunes one number.
- Player HP: [BAL?] reuse PvE pool + scale incoming, OR fixed PVP HP for clean math. Leave named.
- KITS/ULTS: everyone gets a symmetric starting kit for a fair MVP [GD?/BAL? which kit, or free pick].
  Ultimates: [GD?/BAL?] blanket-disable for MVP vs keep+tune (Mender self-heal / Bulwark shield / Phantom dash
  / Gunner overheat may be degenerate in a duel). Default lean: keep spawn-iframes + ult-invuln if ults on;
  disable blessing-pick immunity and long absent-immunity mid-round.

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
