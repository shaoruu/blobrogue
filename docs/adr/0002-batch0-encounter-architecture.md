# ADR 0002 — Batch0 Encounter Architecture

Status: Accepted (foundation only; no Sever content)

## Context
Gorge F50 shipped on the classic arena HP-death path. Later cross-room bosses (Sever55+) need
authoritative room graph edges, route/checkpoint/carrier state, and custom completion that is
reconnect/replay safe — without overloading `BossState`.

## Decision
1. `Room.id` (journey index) + `Dungeon.edges: RoomEdge[]` retained at gen (chain + shortcuts).
2. `Dungeon.blueprint` plumbing; Batch0 ships `'arena'` only (preserves Gorge F50).
3. `WorldState.encounter: EncounterState | null` plain-data (not on BossState).
4. `isFloorCleared` accepts `encounter.active && encounter.completed` for custom kinds; arena
   still clears via HP-death → `endBossDanger` (Gorge unchanged).
5. Protocol **v34**: snapshot field `enc: EncounterWire | null` (additive, strict decode).
   Whole-replaced on delta like `shop`/`match`.

## Sever plug-in (next)
- Author a `'hunt'` (or escape) blueprint on the boss floor.
- Drive `EncounterState` checkpoints/carrier/progress from Sever AI.
- Call `completeEncounter` + `grantEncounterCompletionReward` on objective success.
- Keep max one `isBossKind` body; pursuits = mechanic entities.

## Out of scope here
Sever AI, art/audio, PvP flags, merge/deploy.
