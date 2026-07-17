# Undertow F65 — THE RIVER COMES BACK (Batch2B) — Ian + Anson playtest notes

**Protocol:** 41 (`river_comes_back`) — Choirmaster owns 39; PVP #143 owns 40.
**Base:** `origin/main` @ a5456fb (PROTOCOL 39).
**Signature (story name everywhere):** THE RIVER COMES BACK. **BLACK_TIDE retired.**

## Floor pin
- F65 UNDERTOW — verb **STEAL / ESCAPE** (reverse-floor pursuit)
- `structureKind: 'escape'` (Batch0). Batch2's ONE new cross-room structure.
- Chain: Gorge50 / Sever55 / Choirmaster60 / **Undertow65** / Claimant70 (out of scope) / Pale75 / Wake80 (out of scope)

## How to play
1. Enter the deep/final room — Warm Pulse is planted; Undertow body is present but flood idle until steal.
2. Touch the Warm Pulse to steal it (carrier pip on HUD). Co-op: drop/pass by leaving carrier (Pulse becomes world-pickup after grace).
3. Run **spawnward** along the authored reverse path (≥2 RoomEdges, width≥3). Relief vents + a marked alcove stay readable.
4. **THE RIVER COMES BACK** (1.6s tell → 1.2s front → 3.5s punish):
   - **Success:** deposit Pulse in the **highlighted relief vent** before the front arrives → Undertow manifests → `openBossWindow(3.5)`.
   - **Survival:** drop Pulse and shelter in the **marked alcove** → survive, lose bounded checkpoint progress, **no window**.
   - **Failure:** capped hit; pursuit advances one checkpoint; **never wipe**.

## Custom completion
Pulse deposited + at least one manifestation resolved + Undertow body defeated opens the exit via encounter `completed` (does not require total enemy clear of mechanic bodies).

## Reconnect / late-join
- Flags restore: checkpoint / carrier / flood progress / riverPhase / riverOutcome / ventsUsedMask / manifestCount.
- Late-join spawns at current checkpoint room (safe tile).

## Out of scope this PR
Claimant F70 / Wake F80 / Vein catalog / art PNGs / authored audio takes / PVP enable / Choirmaster redesign.

## BALANCER_TODO
Quill owns final HP/TTK/bank — provisional calibration only (`UNDERTOW` in `balance.ts`).
