# Claimant F70 — ALL THINGS OWED (Batch3A) — Ian + Anson playtest notes

**Protocol:** 42 (`all_things_owed`) — Undertow owns 41; Choirmaster 39; PVP #143 owns 40.
**Base:** `origin/main` @ 58abe98 (PROTOCOL 41, Undertow Batch2B merged).
**Signature (story name everywhere):** ALL THINGS OWED. **CROWNFALL retired.**

## Floor pin
- F70 CLAIMANT — verb **PASS-THE-CLAIM** (token relay / compact coordination)
- `structureKind: 'arena'` (Batch0) — ONE compact coordination arena, NOT a new cross-room / RoomEdge chase graph.
- Chain: Gorge50 / Sever55 / Choirmaster60 / Undertow65 / **Claimant70** / Pale75 / Wake80 (out of scope)

## How to play
1. Enter the arena — the Claimant is guarded; a claim-token sits at center and claim-sockets ring the space.
2. Touch the token to carry it (carrier = the marked target; the crown-lane will aim at the carrier).
3. Break the guard by **passing deliberately**: carrier fire cannot break the Claimant's guard (heavily chipped, never immune) — only non-carrier fire chips it, so the team must pass the token around.
   - **Solo:** deposit the token through the timed sockets instead of passing to a partner.
4. **Three correct passes / socket deposits** (checkpoint 0..3) bait an **overcommit** → **ALL THINGS OWED**.
5. **ALL THINGS OWED** (1.4s angular crown/beam tell → aim locks at **0.84s** → **0.6s** descent → **3.0s** kneel punish):
   - After the aim lock, **exactly one socket lights** (the success counter — never lit before the lock).
   - **Success:** the carrier deposits the token into the **lit socket** after lock and before impact → the crown hits an empty socket, shatters → boss kneels → `openBossWindow(3.0)`.
   - **Survival:** the carrier **dashes perpendicular out of the crown-lane** → survives, keeps the token, **no window**.
   - **Failure:** capped hit to the carrier (anti-one-shot holds); **never wipe**; run stays winnable.

## Readability
- The crown-lane is elongated (not circular) and targets the current carrier; the material footprint reads well before the 0.84s lock.
- The lit socket appears only after the lock, so the "where do I deposit" read is unambiguous and fair (≥0.30s reaction after lock).
- Token / sockets / crown-lane markers are indestructible mechanic entities — incidental AoE never removes them (no soft-lock).

## Guard (PASS-THE-CLAIM)
- Guarded by default; the ONLY window is the ALL THINGS OWED socket-deposit success. Unrelated exposure never opens the Owed window.
- Carrier fire chips at `carrierGuardMult`; non-carrier fire chips at `guardMult` (both reductions, never immunity).

## Reconnect / late-join
- Flags restore: carrier / tokenSocketId / highlightedSocketId / passesCompleted / passCount / owedPhase / owedOutcome / aimLockedAt / lockFrac / tokenDropped.
- Late-join spawns on an arena safe tile; if the carrier is absent, the token becomes a world-pickup after a short grace (never deadlock).

## Out of scope this PR
Wake F80 / new cross-room edges / Undertow redesign / Pale redesign / art PNGs / authored audio takes / PVP enable. CROWNFALL naming is retired and never revived.

## BALANCER_TODO
Quill owns final HP/TTK/bank — provisional calibration only (`CLAIMANT` in `balance.ts`).
