# Bestiary balance envelope (implemented contract)

The governance layer over all bestiary growth. Constants live in `src/sim/balance.ts`
(`ENVELOPE`, `LIVE_CAPS`, `ELITE_COST_CAP`, tier costs), the identity layer in
`src/sim/bestiary.ts` (roles, modules, remixes, acceptance manifests), enforcement in
the planner (`src/sim/enemies.ts`) and the live release gates (`src/sim/world.ts`), and
the seeded regression suite in `test/envelope.test.ts` (`npm run test:envelope`).

## Roster capacity
Up to 24 genuine regular archetypes: 8 simple, 10 complex families (ranged / complex /
controller verbs), 6 biome specialists. Current occupancy: 4 simple, 9 complex families,
2 specialists (15 of 24). Bosses, captains and summon-only decoys sit outside the roster.

## Intro cadence
At most 2 truly NEW movement/attack modules per 5-floor band, and a remix of an existing
module (e.g. rootward remixing the shielder's guard) only ≥1 floor after its teaching
kind. Band 1 (F1–5) is the shipped curriculum's teaching prologue and is explicitly
grandfathered — it front-loads the primer verbs per the corrected gate's cadence table.

## Composition and exposure (planner-enforced)
Per floor ≤7 distinct regular archetypes; per room ≤4 archetypes, ≤2 complex units,
≤1 elite affix, ≤1 controller; a controller never shares a room with a guard wall (the
banned control+denial pairing). ≥35% simple/mastery rooms per deck (raised from 30%),
never more than 2 complex rooms consecutively (unchanged). Hazards keep their own
shipped studio gate: per-room simultaneity caps, ≤35% walkable denial, pool placement
that provably never seals the safe route — the envelope's "max 1 hazard per room" row
maps onto that gate's per-mode caps rather than replacing them.

## Threat costs
swarm 0.5 · simple 1 · ranged 1.5 · complex 2 · controller 2.25 · brute 3 · elite 4
(clamped ≤6 on complex/controller chassis) · miniboss 10 (band 8–12, paid from the floor
budget) · hazard-unit equivalents 1.5 / arena 4 recorded for composition math (hazard
placement itself stays tile-budgeted under its gate). Summons cost threat: decoys carry
0.25 and every summon counts against the live threat budget while it stands.

## Live simultaneity caps
≤24 bodies, ≤2 complex movers (+1 only at a full P4 party), ≤2 brutes, ≤2 elites,
≤2 controllers — enforced at the spawn split and at every reinforcement release.
Dynamic hazards are individually capped at their sources (webs 8, cinders 12, charges
≤ live volatile elites).

## Co-op
Encounter scaling stays snapshotted at floor build. The party's EXTRA threat buys mostly
simple bodies: the floor's heavy spend (any unit costing >1) is capped at the solo
budget, so P>1 adds bodies, not stacked verbs.

## New-enemy acceptance (never a stat-only variant)
Every regular archetype ships an acceptance manifest (`ENEMY_ACCEPTANCE`): silhouette
read ≤300ms, a counter verb unique per module, commitment timing with the §4 ≥0.30s
post-lock dodge and ≥0.35s punish window, and a favorable/unfavorable matchup statement.
Kinds sharing a module must be declared remixes with distinct counter verbs; tints are
unique per kind. A kind with nothing to declare cannot pass the suite.

## Pacing targets
Room-chain P50 (the floor's room-to-room combat under band-median reference builds):
~12–22s early, 18–32 mid, 24–40 late. The deterministic harness measures a
perfect-tracking bot playing the authored counters, so targets scale by the documented
`HARNESS_TIME_SHARE = 0.55` (the share of real room time that is pure combat throughput
— same convention as the balance suite's practical-DPS estimator factors). Pressure:
≤50 sustained / ≤60 hard simultaneous live enemy projectiles. Escalation: per-floor
effective-HP growth ≤ +12% from F5 (the F1–4 teaching ramp is authored and steeper);
enemy damage never grows with floor at all (stronger than the ≤ +10% row).

## Minibosses and bosses
Minibosses: at most one per band (the cadence is one floor per band), optional/separate
from the boss ladder, 1–2 moves plus the 50% captain phase, no immunity anywhere.
Bosses: 3 phases each (one new technique per phase, then remix), fixed cadence/tell/
recovery grammar, capped adds, and a ≥20s minimum legal TTK so the fastest legal build
still sees the techniques — all pre-existing contracts, now asserted by the envelope
suite alongside the shipped balance gates.

## Known deviations (reported, deliberate)
- Band 1 module cadence grandfathered (shipped curriculum gate).
- The F1–4 HP ramp exceeds +12%/floor by authored design; the cap binds from F5.
- Hazard budgeting stays under its own studio gate rather than the generic threat costs.

## The creative ecology gate (two waves over raw taxonomy)

**Wave A (common decks)** — predators + supports + at most ONE truly new topology/
material WORKER per biome band, each editing the room persistently:
- **Forkroot Bailiff** (Rootbound, consolidates the wave-1 Rootward): the slow guard
  stays its defense; its one commitment raises/MOVES an asymmetric root divider.
- **Silt Keel** (the Deep, consolidates the wave-1 Seamcutter): the previewed oblique
  plow now raises ONE persistent silt berm beside the furrow — the sweep-bolt payload is
  superseded (zoning by topology, not projectiles).
- **Clinker Mason** (Emberreach, new): masons one handed L-corner of clinker bricks
  around a heat vent — the sinderling's feeding ground — apex toward the player, open
  back as the approach lane.

**Topology law** (enforced in sim + `test/ecology.test.ts`): one persistent topology
edit per room (planner seats ≤1 worker/room; a raise is refused while another owner's
edit stands); explicit escape route (wall/exit standoffs guarantee end gaps; everything
destructible; the suite BFS-verifies player→exit reachability through live fights); old
construction REPLACED whenever a worker builds anew (and it persists past its builder).

**Wave B (rare, never in common decks)** — the elite affixes (a layer over Wave-A
chassis), the summon bodies (echo, knell) and the lieutenants (Root Marshal, The Toll),
each declared in `WAVE_B_SYNTHESIS` as a synthesis of verbs Wave A taught earlier.

**Considered, not landed (reported):** Amber Grazer (band-1 curriculum stays locked;
its either-side cover gimmick is inherent to ALL constructions — props block both
sides); Ribsnare (closing a corridor conflicts with the enforced escape-route law until
door-state plumbing exists); Vellum Grafter (Sunless already carries two commons and the
±2-modules-per-band cadence; its flee verb overlaps the echojack).
