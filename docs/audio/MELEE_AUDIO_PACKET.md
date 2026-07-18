# Melee juice + verbs — Vale AUDIO PACKET

Audio hooks for MELEE_EFFECTS_PACKET §2 (VFX escalation) + §3 (5 melee-native verbs). Design ref tip `0cf77fa8`.
**Rule:** every cue rides an EXISTING event the sim already raises (`meleeSwing`, `enemyHit{melee}`) or ONE new per-verb event the blessing proc raises — **never poll sim**. Authored stem → DERIVE fallback → silence (contract), never oscillator.

## 0. Decisions
Model `fal-ai/elevenlabs/sound-effects/v2`; `pcm_44100`/`mp3_44100_192`; ship `.ogg`+`.mp3`.
Global suffix: `single isolated one-shot, dry, immediate readable transient, no music, no ambience, no long reverb, mono, dark-fantasy video game sound effect`.
Influence **0.35** (combat). Batch `melee-juice-verbs-v1`.
Buses/priority (existing `WAVE_PRIORITY`): swings + verb casts = `weapon` (70); contact impacts + rings = `impact` (60); ward-up self-cue = `weapon`. All `spatial: true`, `bus: "sfx"`.
Legacy samples still exist (`meleeSwing`/`meleeHit`/`heavySwing`/`parry`) — these authored rows REPLACE the flat reuse per identity, and every row lists a legacy DERIVE fallback so nothing goes silent pre-gen.

## 1. How it wires (no new polling)
- **Swing** already fires on the `meleeSwing` event; client picks stem by `e.weapon` exactly like the existing `MELEE_FEEL.swingSfx` switch. New per-identity swing rows below just extend that table (cutlass/claymore/pike).
- **Impact** already fires on `enemyHit{melee:true}` → today calls `sfx("meleeHit")`. Delta: local wielder selects impact stem by `this.weapon`; **remote** melee hits keep the shared thump (as today — remote has no reliable weapon on the impact). Note for Helix: if you want remote per-identity impact, carry `weapon` on the melee `enemyHit` (optional, not required).
- **Cleave shockwave / crit / verbs**: each rides the SAME coalesced path the VFX uses (one `ShockwaveField` ring per frame). Audio must mirror that: **one cue per swing/proc, never per body**. Use `cooldownMs` + `isPerEntityCooldown:false` on the AoE cues so a multi-body cleave = one sound.

## 2. §2 VFX escalation — per-identity melee SFX

### 2.1 Swing layer (on `meleeSwing`, select by weapon)
|event|file|dur|gain|var|decision + exact EL prompt|
|---|---|---:|---:|---:|---|
|`melee.cutlassSwing` (sword)|`sfx/melee_cutlass_swing`|0.16|.55|3|NEW: `A light fast cutlass swing whips through the air, quick tight blade whoosh with a bright edge, snappy and short, [suffix]` — fallback `meleeSwing` rate 1.12|
|`melee.claymoreSwing` (longsword)|`sfx/melee_claymore_swing`|0.26|.80|2|NEW: `A heavy two-handed claymore winds up and sweeps, deep weighty air whoosh with a low iron rush, slow and powerful, [suffix]` — fallback `heavySwing` rate 1.0|
|`melee.pikeThrust` (spear)|`sfx/melee_pike_thrust`|0.16|.58|3|NEW: `A pike thrusts forward in a sharp linear stab, tight directional air spit and a thin metallic tip zip, fast and pointed, [suffix]` — fallback `meleeSwing` rate 1.3 highpass 1000|

### 2.2 Impact layer (on `enemyHit{melee:true}`, select by weapon; crit branch layers 2.4)
|event|file|dur|gain|var|decision + exact EL prompt|
|---|---|---:|---:|---:|---|
|`melee.cutlassHit`|`sfx/melee_cutlass_hit`|0.16|.62|3|NEW: `A fast blade bites flesh and light armor, quick wet-edged cut with a short metallic tick, snappy flurry hit, no long tail, [suffix]` — fallback `meleeHit` rate 1.1|
|`melee.claymoreHit`|`sfx/melee_claymore_hit`|0.24|.88|3|NEW: `A massive claymore lands a meaty crushing blow, deep low-frequency thud and heavy bone-and-armor crunch, weighty impact with a short sub tail, [suffix]` — fallback `meleeHit` rate 0.85 lowpass 3000|
|`melee.pikeHit`|`sfx/melee_pike_hit`|0.16|.62|3|NEW: `A pike tip punches a clean skewer, sharp focused puncture pop and a thin metallic slide, precise single-point hit, [suffix]` — fallback `meleeHit` rate 1.15 highpass 900|

### 2.3 Cleave shockwave (on Claymore heavy hit OR cleave_crit; ONE per frame, coalesced)
|event|file|dur|gain|var|decision + exact EL prompt|
|---|---|---:|---:|---:|---|
|`melee.cleaveShock`|`sfx/melee_cleave_shock`|0.42|.80|2|NEW: `A heavy cleave releases a low outward shockwave, deep whoomph of displaced air and a short dusty low-freq ring expanding once, powerful but controlled, no long tail, [suffix]` — fallback `heavySwing` rate 0.85|
Mix: `duck music:.8/.06/.25`; `cooldownMs 140`, `isPerEntityCooldown:false` (one ring/frame, mirrors the pooled `ShockwaveField`). Honors flashFactor visually; audio just fires once.

### 2.4 Melee crit layer (crit branch of `enemyHit{melee}`, layers over 2.2 hit)
|event|file|dur|gain|var|decision + exact EL prompt|
|---|---|---:|---:|---:|---|
|`melee.crit`|`sfx/melee_crit`|0.20|.66|2|NEW: `A critical blade strike rings with a bright hot metallic sing over the impact, sharp gold-edged crit flourish, short, [suffix]` — fallback existing `crit` sample gain .6|
Note: keep the existing `crit` sample as fallback; this is an additive melee-flavored layer, not a replacement, and stays under the impact so it reads as "crit on top of hit."

## 3. §3 melee-native verbs (one new event each, raised on the blessing proc)

|verb event|file|dur|gain|prio|var|layering + exact EL prompt|
|---|---|---:|---:|---|---:|---|
|`stagger_pulse` (KB+slow ring)|`sfx/melee_stagger_pulse`|0.40|.72|impact|2|Layers over the triggering hit; ONE per proc (ICD 0.8s matches Quill). NEW: `A heavy blow rings a stagger shock outward, low concussive pulse and a brief metallic ring pushing bodies back, short controlled, no long tail, [suffix]` — fallback `heavySwing` rate 0.9|
|`blade_ward` (absorb shield-up)|`sfx/melee_blade_ward`|0.45|.55|weapon|1|Self-cue on the wielder when the ward grants/refreshes; soft, non-positional feel (still sfx bus). NEW: `A blade earns a brief guard, a warm protective shell shimmers up with a soft metallic ward chime, reassuring and short, not a pickup jingle, [suffix]` — fallback `parry` rate 1.1 highpass 1200. Cooldown so a refresh every hit doesn't chime-spam: `cooldownMs 1200`.|
|`cleave_crit` (wider crit swing)|— (reuse `melee.cleaveShock` + `melee.crit`)|—|—|impact|—|NO new stem: a crit swing that cleaves plays `melee.crit` (2.4) layered with ONE `melee.cleaveShock` (2.3). Keeps it a "bigger melee," not a new fantasy. Coalesced one-ring.|
|`momentum_charge` — banked ready|`sfx/melee_momentum_ready`|0.30|.40|weapon|1|Quiet tell when momentum banks (after dash/200px): a subtle charged-blade hum-up, low so it never nags. NEW: `A blade quietly charges with gathered momentum, soft rising energy hum and faint metallic shimmer, restrained ready cue, [suffix]` — fallback `parry` rate 1.3. `cooldownMs 800`.|
|`momentum_charge` — payoff hit|`sfx/melee_momentum_payoff`|0.30|.85|impact|2|Layers on the empowered lunge hit (the +40/55/70% strike). NEW: `A charged momentum blade lands a truck-like lunge blow, deep front-loaded slam with a whipping lunge streak and heavy knockback thud, decisive, [suffix]` — fallback `heavySwing` rate 0.95|
|`finisher` (execute stinger)|`sfx/melee_finisher_execute`|0.55|.92|impact|2|The distinct decisive execute — fires ONLY on the execute kill (non-boss ≤ threshold). NEW: `A decisive execution blow finishes a wounded enemy, a heavy final blade-through with a short dark metallic ring-out and a satisfying low thud, conclusive, no gore squelch, [suffix]` — fallback `heavySwing` rate 0.85 + existing `crit`. Layers a touch of the crit sing; heavier freeze already handled by VFX. ICD not needed (kill-gated) but `cooldownMs 200` guards a double-execute frame.|

## 4. waveSpec binding sketch
```
melee.cutlassSwing   sfx/melee_cutlass_swing   v3 g.55 weapon  (MELEE_FEEL.sword swing)
melee.claymoreSwing  sfx/melee_claymore_swing  v2 g.80 weapon  (MELEE_FEEL.longsword swing)
melee.pikeThrust     sfx/melee_pike_thrust     v3 g.58 weapon  (MELEE_FEEL.spear swing)
melee.cutlassHit     sfx/melee_cutlass_hit     v3 g.62 impact  (enemyHit melee, weapon=sword)
melee.claymoreHit    sfx/melee_claymore_hit    v3 g.88 impact  (enemyHit melee, weapon=longsword)
melee.pikeHit        sfx/melee_pike_hit        v3 g.62 impact  (enemyHit melee, weapon=spear)
melee.cleaveShock    sfx/melee_cleave_shock    v2 g.80 impact  duck .8/.06/.25  cd140 !perEntity
melee.crit           sfx/melee_crit            v2 g.66 impact  (enemyHit melee crit layer)
melee.staggerPulse   sfx/melee_stagger_pulse   v2 g.72 impact  cd800
melee.bladeWard      sfx/melee_blade_ward      v1 g.55 weapon  cd1200
melee.momentumReady  sfx/melee_momentum_ready  v1 g.40 weapon  cd800
melee.momentumPayoff sfx/melee_momentum_payoff v2 g.85 impact
melee.finisher       sfx/melee_finisher_execute v2 g.92 impact cd200
```
All `bus: "sfx"`, `spatial: true`, `jitter: 0.04–0.05`. Crook is NOT a swing (TetherSpec) — none of these bind to Crook; its `tetherLatch`/`chain_*` stays. stagger_pulse/blade_ward MAY fire on the Crook sweep hit (design §4) — those two are weapon-agnostic on any melee-flagged hit, so they already work if the sweep raises the proc.

## 5. Coalescing / anti-spam (hard, mirrors perf packet)
- AoE cues (`cleaveShock`, `staggerPulse`) fire **once per swing/proc**, never per body — `isPerEntityCooldown:false` + short `cooldownMs`.
- Per-hit identity impacts already ride the 4–6 concurrent SFX cap + ~15ms retrigger in the mixer; combo pitch-ramp stays on the existing path.
- `momentumReady` and `bladeWard` are low-gain and cooldown-gated so footwork/hit refreshes never chatter.
- Nothing here adds a per-frame trigger; all are event-driven.

## 6. Handoff
Vale owns gen + ear gate for batch `melee-juice-verbs-v1` (13 authored stems). Helix wires the 13 events; swing/impact ride existing `meleeSwing`/`enemyHit{melee}` weapon-select, verbs ride their proc events. No sim polling. Ship SFX in the SAME PR as the VFX/verb code (Ian standing rule: SFX with every content drop).
