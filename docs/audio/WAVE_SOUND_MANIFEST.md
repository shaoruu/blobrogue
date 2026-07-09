# blobrogue — CURRENT WAVE SOUND MANIFEST (implementation-ready)

## 0. Decisions / audit
Model: `fal-ai/elevenlabs/sound-effects/v2`; output request `pcm_44100` where available, otherwise `mp3_44100_192`; final ship `.ogg` + `.mp3`.
Global gameplay suffix: `single isolated one-shot, dry, immediate readable transient, no music, no ambience, no long reverb, mono, dark-fantasy video game sound effect`.
Prompt influence: 0.35 combat, 0.50 identity/tonal, 0.55 UI. Generate `variants` independent takes (EL has no seed).

**Existing library audit**
- REUSE AS-IS: `cannon` (heavy impacts), `tesla` (electric attacks), `dash` (short mobility), `heavySwing` (large physical commitment), `parry` (hard lock/deflect), `bossRoar` (generic boss entrance only), `enemyHit/enemyDeath`, `revive`, `floorClear`, `coin/heart/chest/weaponPickup`, `levelup/blessing`, `uiClick` synth fallback.
- DERIVE (offline transform, no generation): low-pass/pitch-down `cannon` for rubble/rock impact; high-pass/shorten `tesla` for lightning impact; reverse+pitch `dash` for blink departure; `parry` pitch-down for shield break; `revive` pitched/filtered for reconnect-ready family.
- GENERATE NEW (readability-critical): every boss attack windup/lock/impact/phase/death; Charger/Burrower/Orbiter/Shielder telegraphs; Thumper/Sunlance identity; hazard warnings; co-op state changes; UI hierarchy cues.
- Main currently has 4 biomes; open depth PR `origin/ian/depth-progression-world-2267` adds the canonical six-band ladder: Verdant, Sunless, Deep, Emberreach, Fracture, Null. Manifest follows that PR contract and must land alongside/after it.
- Pets are not authored by species yet: manifest uses species-neutral pet state cues only. Do not generate fake animal voices until art/design names the pet species.

## 1. Mix/readability contract
Buses: `master .7`, `music .5`, `sfx .9`, `ui .6`, NEW `ambient .32`, NEW `voiceTell 1.0`.
Priority: `bossLock=100`, `playerHurt/revive=95`, `enemyLock/hazardWarn=85`, `weapon=70`, `impact=60`, `pet=35`, `ambient=20`, `uiHover=10`.
Frequency lanes: boss/enemy LOCK tells own 1–4kHz; ambience is HP/LP-soft below 1.2kHz or above 6kHz; UI is short 2–8kHz; pet cues never overlap boss locks (sidechain/mute pet bus 500ms).
Ducking notation below is `targetBus:multiplier / hold / recover`; `—` = none. Distance attenuation on world SFX: full≤240px, linear to 0.25 at 700px, off-camera cap .35 except boss/hazard locks.
Cooldowns: ambience emitters ≥4s; pet idle ≥8s; standard enemy cue per entity; boss cues never culled; UI hover ≥80ms.
Global post: trim onset to 5ms; `highpass=f=35,loudnorm=I=-16:TP=-2:LRA=11,alimiter=limit=.89`; boss/phase/death target `I=-14`; UI `I=-20`; ambience `I=-26`; equal-power loop crossfade 2–3s.

## 2. Boss identities and manifests
Sonic separation: **Marrow = bone/shale + sub impact**; **Choir = fused nonverbal voices + cyan electricity**; **Weaver = silk tension + cold glass/knife transients**; **Warden = amber crystal + orderly bell geometry**. Never share the generic boss roar beyond entrance placeholder.

### MARROW (blind charger; 0.7s charge windup, lock at 0.4s, 0.6s active, wall recover 1.0s)
|event / trigger|file|dur|gain|duck|var|decision + exact EL prompt|
|---|---|---:|---:|---|---:|---|
|`marrow.listenStart` on charge windup start|`boss/marrow_listen_vN`|0.70|.85|music:.65/.20/.35|2|NEW: `A blind giant made of shale and exposed bone plants its feet and listens, deep inhaling stone resonance, small bone rattles gathering toward a low sub pulse, danger building but no impact yet, [suffix]`|
|`marrow.aimLock` exactly at 0.4s|`boss/marrow_lock`|0.28|1.0|music:.35/.15/.45|1|NEW: `A sharp unmistakable target-lock cue made from one dry bone crack and a short resonant shale knock, urgent attack commitment, [suffix]`|
|`marrow.chargeStart` active begins|`boss/marrow_charge_vN`|0.65|.9|—|2|NEW: `A huge rock-and-bone beast explodes into a forward charge, heavy hooves and grinding shale accelerating in one direction, dry close and forceful, [suffix]`|
|`marrow.wallImpact` collision wall|`boss/marrow_wall_vN`|0.85|1.0|music:.45/.18/.55|3|DERIVE cannon pitch .72 + NEW optional: `Massive shale and bone collision into a stone wall, deep body slam, cracking rock and loose bone clatter, [suffix]`|
|`marrow.stompWindup`|`boss/marrow_stomp_warn`|0.60|.78|—|1|NEW: `Heavy stone foot lifts, low tightening rock groan and short rising sub pulse warning of a ground stomp, no impact, [suffix]`|
|`marrow.stompImpact`|`boss/marrow_stomp`|0.70|.95|music:.55/.15/.45|2|DERIVE cannon lowpass + pitch .78; layer dry debris.|
|`boss.phase` Marrow 66/33%|`boss/marrow_phase`|1.10|.95|music:.3/.35/.8|1|NEW: `Blind bone-and-shale giant enrages, deep breath becomes a cracking geological bellow, stones shift and bones chatter, no speech, dark boss phase transition`|
|`boss.death` Marrow|`boss/marrow_death`|2.00|1.0|music:.25/.8/1.2|1|NEW: `A colossal rock-and-bone creature collapses, staggered heavy stone crashes, exposed bones scatter, final deep body impact then silence, no music`|

### HOLLOW CHOIR (artillery / fused voices)
|event|file|dur|gain|duck|var|decision + exact prompt|
|---|---|---:|---:|---|---:|---|
|`choir.strikeWarn` 0.9s marker blooms|`boss/choir_strike_warn_vN`|0.90|.82|music:.6/.15/.4|2|NEW: `A tragic fused monster choir swells on one dissonant nonverbal vowel while static gathers overhead, rising cyan lightning tension, warning only, no strike, no words, dry foreground game cue`|
|`choir.strikeLock` at 0.5s|`boss/choir_strike_lock`|0.25|1.0|music:.35/.12/.35|1|NEW: `A piercing synchronized choral cutoff followed by a tiny electric snap, unmistakable lightning target lock, no words, [suffix]`|
|`choir.strikeImpact` each bolt|`boss/choir_strike_vN`|0.55|.86|—|3|DERIVE tesla (short/high-pass) OR NEW: `A violent vertical lightning bolt hits stone, tight electric crack and stone spit, no thunder tail, [suffix]`|
|`choir.swellWarn` radial 0.8s|`boss/choir_swell_warn`|0.80|.85|music:.55/.2/.5|1|NEW: `Many mournful nonverbal voices inhale together into a widening dissonant chord, radial danger swelling outward, no words, no impact yet, dry game telegraph`|
|`choir.swellFire`|`boss/choir_swell`|0.90|.92|music:.5/.12/.5|2|NEW: `A fused monster choir releases a circular scream of electrical energy, nonverbal voices and twelve sharp electric projectiles bursting outward, controlled short tail, no speech`|
|`choir.floorCharge` 1.2s arena telegraph|`boss/choir_floor_warn`|1.20|.9|music:.25/.4/.8|1|NEW: `Room-wide electrical charge rises under stone, low cyan hum climbing while hundreds of distant sad nonverbal voices converge, urgent full-arena warning, no discharge yet`|
|`choir.floorDischarge`|`boss/choir_floor_blast`|1.20|1.0|music:.2/.35/1.0|1|NEW: `A gigantic room-wide electrical discharge, broad low thunder crack, violent static sheet and brief fused-choir cry, huge but readable, no words`|
|`boss.phase` Choir|`boss/choir_phase_vN`|1.40|.95|music:.25/.45/1.0|2|NEW: `Hundreds of fused blob voices change harmony together into a darker dissonant chord, lava bubbles and electric pressure rise, tragic boss phase transition, nonverbal`|
|`boss.death` Choir|`boss/choir_death`|2.80|1.0|music:.2/1.0/1.5|1|NEW: `A colossal fused choir loses voices one by one, a descending cluster of sad nonverbal tones collapses into wet mass and lava hiss, tragic final silence, no words, no music`|

### WEAVER (precision / blink / thread)
|event|file|dur|gain|duck|var|decision + exact prompt|
|---|---|---:|---:|---|---:|---|
|`weaver.blinkTell` destination shimmer 0.35s|`boss/weaver_blink_warn_vN`|0.35|.9|music:.55/.1/.3|3|NEW: `Cold indigo glass shimmer at a teleport destination, taut silk thread plucked upward then cut short, precise urgent blink warning, [suffix]`|
|`weaver.blinkDepart`|`boss/weaver_blink_out_vN`|0.25|.65|—|2|DERIVE reverse+pitch `dash`; bandpass 1.5–6kHz.|
|`weaver.blinkArriveStrike`|`boss/weaver_strike_vN`|0.48|.9|music:.65/.08/.3|3|NEW: `A razor-fast arachnid blade lunge appears from a teleport, cold knife slice with one tight silk snap, precise and dry, [suffix]`|
|`weaver.latticeWarn` 0.7s|`boss/weaver_lattice_warn`|0.70|.82|music:.6/.15/.4|1|NEW: `Three taut silk threads stretch across space at crossing angles, high cold string tension rising into a glassy warning harmonic, no release yet, [suffix]`|
|`weaver.latticeFire`|`boss/weaver_lattice_vN`|0.65|.8|—|2|NEW: `Three sharp silk lines whip across a room and remain humming, cold glass filaments and bow-string snaps crossing, dry controlled attack`|
|`weaver.feint` phase3 fake/real pair|`boss/weaver_feint`|0.45|.86|music:.55/.12/.35|1|NEW: `Two mirrored cold glass teleport shimmers split left and right, one slightly brighter with a subtle high chime tell, deceptive but readable, [suffix]`|
|`boss.phase` Weaver|`boss/weaver_phase`|0.90|.9|music:.35/.25/.7|1|NEW: `Taut web strings accelerate into a precise dissonant arpeggio, cold shell clicks and one sharp glass harmonic announce a faster boss phase, no roar`|
|`boss.death` Weaver|`boss/weaver_death`|1.80|1.0|music:.25/.7/1.1|1|NEW: `A cold arachnid creature's tension fails, silk strings snap in sequence, glassy limbs collapse and one final low thread unwinds to silence`|

### GILDED WARDEN (amber crystal / sacred geometry)
|event|file|dur|gain|duck|var|decision + exact prompt|
|---|---|---:|---:|---|---:|---|
|`warden.turretPlace`|`boss/warden_turret_place_vN`|0.80|.75|—|2|NEW: `An amber crystal mechanism unfolds and locks into place, faceted stone clicks, warm resonant bell ping, orderly sacred machine, [suffix]`|
|`warden.turretLock` aimed bolt ready|`boss/warden_turret_lock`|0.30|.9|music:.65/.1/.3|1|NEW: `A clean amber crystal target lock, two precise ascending bell ticks ending in a hard latch, [suffix]`|
|`warden.turretFire`|`boss/warden_turret_fire_vN`|0.42|.75|—|3|NEW: `An amber crystal turret fires one slow bolt, short warm glass resonance and compressed light pulse, dry, [suffix]`|
|`warden.glyphWarn`|`boss/warden_glyph_warn_vN`|0.85|.84|music:.6/.18/.4|2|NEW: `Sacred amber geometry traces a binding circle, orderly glass harmonics descend stepwise while a crystal ring tightens, warning only, [suffix]`|
|`warden.glyphSet` root lands|`boss/warden_glyph_set`|0.65|.9|music:.55/.1/.4|1|NEW: `Amber rapidly crystallizes around a target, bright glass growth and one hard gemstone lock, immobilizing, [suffix]`|
|`warden.prisonWarn` shrinking ring|`boss/warden_prison_warn`|1.30|.92|music:.25/.4/.8|1|NEW: `Massive amber walls grow inward in sacred geometric sequence, resonant crystal pillars rising around the listener, urgent enclosing warning, no impact`|
|`warden.prisonClose`|`boss/warden_prison_close`|0.90|.95|music:.4/.2/.65|1|NEW: `Huge amber crystal walls seal into a tight prison, deep glass resonance, stone latch and ringing facets, powerful but clean`|
|`boss.phase` Warden|`boss/warden_phase`|1.20|.92|music:.3/.4/.85|1|NEW: `Ancient amber construct changes ritual state, orderly ceremonial bell chord, crystal gears rotate and sacred geometry resonates, no monster roar`|
|`boss.death` Warden|`boss/warden_death`|2.20|1.0|music:.2/.9/1.3|1|NEW: `Ancient amber guardian fractures along perfect geometric lines, rich crystal chimes fall out of tune then a heavy golden core shatters, no music`|

## 3. Standard archetype cues (names are role IDs; bind to authored entities later)
|role / trigger|file|dur|gain|duck|var|decision + prompt|
|---|---|---:|---:|---|---:|---|
|`charger.windup` 0.5–0.7s|`enemy/charger_warn_vN`|0.55|.72|—|3|NEW: `A medium enemy digs in then commits to a forward charge, scraping claws and a short rising body growl, direction-readable warning, [suffix]`|
|`charger.lock`|`enemy/charger_lock`|0.20|.85|music:.8/.05/.2|1|NEW: `One sharp claw scrape and hard body click, immediate charge commitment cue, [suffix]`|
|`burrower.submerge`|`enemy/burrow_down_vN`|0.55|.6|—|2|NEW: `A stone-shelled creature rapidly digs under loose shale, dry dirt and small rock chatter moving downward, [suffix]`|
|`burrower.track` SUPERSEDED (audio director FINAL): no continuous loop. Deterministic keyed positional emitter while burrowed — dirt grind every 1.0–1.4s @.22, pebble 0.35–0.75s @.14, shell scrape 1.3–2.0s @.18, underground thud only on direction-lock @.28; ±3% jitter max, no immediate repeat|SELECTED takes only (selected_components.json): `enemy/burrow_dirt_grind_v2`, `enemy/burrow_pebble_v1/_v2`, `enemy/burrow_shell_v1/_v2`, `enemy/burrow_underground_thud_v2`|≤0.5 each|see left|—|1/2/2/1|REJECTED, never reference: `dirt_grind_v1`, `pebble_v3`, `underground_thud_v1`, `burrow_track`. Dry mono transient-forward components; no tails, they overlap by design.|
|`burrower.lock` 0.4s pre-erupt|`enemy/burrow_lock`|0.28|.86|music:.75/.08/.25|1|NEW: `Three stones lift and crack in a fast rising pattern, clear eruption lock warning, [suffix]`|
|`burrower.erupt`|`enemy/burrow_erupt_vN`|0.65|.78|—|3|NEW: `A stone-shelled creature erupts through the ground, sharp dirt burst and rock crack with short body snap, [suffix]`|
|`orbiter.enterBand` once/entity|`enemy/orbiter_acquire_vN`|0.38|.45|—|2|NEW: `A cold angular creature enters orbit, one soft Doppler-like mineral hum circling left or right, subtle positional cue, [suffix]`|
|`orbiter.diveWarn`|`enemy/orbiter_dive_warn_vN`|0.45|.72|—|3|NEW: `Small flying enemy folds its wings for a dive, tight wing snap and fast descending whistle, warning only, [suffix]`|
|`shielder.raise`|`enemy/shield_raise_vN`|0.55|.65|—|2|NEW: `An enemy raises a heavy front shield, layered metal and stone plates lock with a low resonant clunk, [suffix]`|
|`shielder.block` (rate limit 120ms)|`enemy/shield_block_vN`|0.28|.6|—|3|REUSE/DERIVE `parry`: pitch .75–.95, lowpass 5k; do not use full parry gain.|
|`shielder.break`|`enemy/shield_break`|0.70|.82|music:.8/.08/.3|1|NEW: `A heavy enemy shield cracks and collapses, metal buckle, stone fracture and satisfying final snap, [suffix]`|

## 4. New weapons: Thumper / Sunlance (canonical content-wave branch)
Canonical mechanics from `origin/ian/content-wave-variety-1eaf`: **Thumper** is `WeaponId=mortar`, 0.75s lobbed shell, blast radius64; **Sunlance** is `WeaponId=beam`, 0.045s sustained fast cadence (not charge/release).
|event|file|dur|gain|duck|var|prompt / implementation|
|---|---|---:|---:|---|---:|---|
|`shootMortar` each lob|`sfx/thumper_fire_vN`|0.72|.82|music:.8/.06/.2|3|NEW: `A compact fantasy mortar launches one heavy concussive shell, blunt dry thump, spring-loaded metal piston and short air punch, clearly a launch not an explosion, [suffix]`|
|`mortarDetonate` authoritative blast event|`sfx/thumper_impact_vN`|0.78|.9|music:.75/.08/.3|3|NEW: `A lobbed thumper shell detonates in a compact 64-pixel blast zone, low concussive boom, tight dirt and stone debris, strong area impact with no long cinematic tail, [suffix]`|
|`beamStart` first shot after >120ms idle|`sfx/sunlance_start_vN`|0.38|.58|—|2|NEW: `A sustained amber sunlance ignites, sharp warm crystal attack and focused beam onset, radiant not electric, [suffix]`|
|`beamLoop` while held; one looped voice, NEVER retrigger at 0.045s fireCd|`sfx/sunlance_loop`|1.00|.34|—|1|NEW(loop): `Continuous focused amber sunlight beam, smooth warm crystalline harmonic with subtle energetic texture, steady volume, seamless loop, no pulses, no music, mono`|
|`beamStop` >90ms since last beam shot|`sfx/sunlance_stop`|0.28|.34|—|1|NEW: `A focused amber light beam releases and powers down, short warm crystal tail falling cleanly to silence, [suffix]`|
|`beamHit` rate-limit 120ms per target|`sfx/sunlance_hit_vN`|0.30|.42|—|2|NEW: `Focused amber light scorches and pierces a target, short warm glass sizzle and precise radiant tick, [suffix]`|

## 5. Six audio zones / biome ambience
All ambience is stereo, `ambient` bus, positional emitter layers; never one full-volume global loop. Generate 45–60s, crossfade 3s. No melody; existing dungeon/boss music remains separate.
|zone|file|gain|new prompt|
|---|---|---:|---|
|Verdant Hollow|`amb/verdant_loop`|.24|`Seamless dark fantasy forest-dungeon ambience, damp roots, soft leaf movement, distant hollow wood creaks, tiny insects, occasional amber sap drip, alive and deceptively safe, no music, no birdsong melody, restrained, 60 seconds`|
|Sunless Caves|`amb/sunless_loop`|.25|`Seamless underground cave ambience, resonant shale chamber, sparse falling pebbles, distant bone taps, cold air and long subtle echoes, lonely and dark, no creatures close, no music, 60 seconds`|
|The Deep — FINAL P0 (closes material selection; ships after Ian's spot-check): continuous bed is authored SILENCE (no `deep_loop`). Weighted diegetic emitter: one category every 1.5–3.2s, max ONE active — mineral 35% (re-arm 2–4.5s, .07–.11) / drip 25% (2.5–5s, .06–.10, v1 take-weight .5) / stress 20% (3.5–6.5s, .08–.12, ±2%) / architecture 20% (5–9s, .09–.13, r4_v1 ×.8). Deterministic per-floor ambient RNG; ±250ms lock mute; 160–520px camera ring on wall/material cells only|SELECTED takes: `amb/deep_mineral_tick_v1/_v2`, `amb/deep_resin_drip_r4_v1/_v2/_v3`, `amb/deep_resin_creak_r4_v3` (event `deep.resinStress`), `amb/deep_architecture_shift_r4_v1/_v2`|.06–.13|RETIRED: pre-r4 `deep_architecture_shift_v1`. Do NOT generate `deep_loop`.|
|Emberreach|`amb/ember_loop`|.28|`Seamless volcanic dungeon ambience, low lava movement, glassy slag ticks, distant vents breathing, sparse ember crackle and heat pressure, dangerous but not loud, no music, 60 seconds`|
|The Fracture (floors21–25)|`amb/fracture_loop`|.20|`Seamless dark fantasy fracture biome ambience, near-black teal crystal and glass under tension, sparse lateral shard glints, off-axis mineral clicks, unnaturally wide quiet spaces, cold and alien, no voices, no music, 60 seconds`|
|The Null (floor26+)|`amb/null_loop`|.18|`Seamless terminal void-dungeon ambience, anti-light purple pressure, tiny particles drifting toward the listener, very low gravitational hum and rare reversed mineral whispers, empty and oppressive, no voices, no melody, no music, 60 seconds`|

## 6. Four canonical hazards (depth-progression PR)
Canonical kinds and cycles: `spikes` 2.2 idle/0.9 telegraph/0.7 active; `toxic_pool` always active; `fire_vent` 2.6/1.0/1.4; `void_rift` 3.2/1.1/1.6. Replace current weak placeholder reuse (`uiClick/meleeSwing`, `enemyAttack/barrel`, `enemyAttack/tesla`).
|hazard / trigger|file|dur/gain|decision + exact prompt|
|---|---|---|---|
|`spikes.telegraph` phase edge|`hazard/spikes_warn_vN`|.90/.70; 2|NEW: `A row of hidden dungeon spikes arms beneath stone, sequential metal-and-bone clicks ripple across tiles and rise toward release, clear positional warning, no impact, [suffix]`|
|`spikes.active`|`hazard/spikes_fire_vN`|.65/.76; 3|NEW: `A row of sharp dungeon spikes snaps upward through stone in a fast ripple, dry metal and bone thrust with small stone chips, [suffix]`|
|`toxic_pool.enter` first player contact|`hazard/toxic_enter`|.35/.44; 1|NEW: `A boot enters a corrosive toxic pool, short wet acidic sizzle and thick bubble pop, restrained, [suffix]`|
|`toxic_pool.loop` only while player within 120px, max one mixed voice|`hazard/toxic_loop`|2.0/.18; 1|NEW(loop): `Quiet toxic pool surface, slow thick bubbles and faint acidic sizzle, seamless restrained loop, no music, mono`|
|`fire_vent.telegraph`|`hazard/vent_warn_vN`|1.00/.74; 2|NEW: `Pressure builds inside a volcanic floor vent, low steam rumble rising to a sharp hiss, clear eruption warning, no blast, [suffix]`|
|`fire_vent.active`|`hazard/vent_blast_vN`|1.20/.84; 2|NEW: `A volcanic floor vent erupts upward, violent steam and fire jet with glassy slag spit, powerful but short controlled tail, [suffix]`|
|`void_rift.telegraph`|`hazard/rift_warn_vN`|1.10/.78; 2|NEW: `A void rift opens and begins pulling space inward, low reversed mineral groan, cold suction and rising impossible pressure, clear warning, no electric zap, [suffix]`|
|`void_rift.active`|`hazard/rift_open_vN`|1.30/.80; 2|NEW: `A black void tear fully opens, deep gravitational pull, glassy space fracture and inward rushing air, no lightning, no explosion, [suffix]`|
Hazard warning phase ducks `music:.65/.12/.35`; ambient ducks `.45` until active phase ends. `toxic_pool` has no phase edge, so its loop is proximity-gated and never global.

## 7. Pets (species-neutral state cues; no fake pet identity)
|trigger|file|dur|gain|var|prompt|
|---|---|---:|---:|---:|---|
|`pet.summon`|`pet/summon`|.75|.38|1|`A small magical companion appears beside the player, warm soft pop and tiny amber shimmer, friendly and restrained, [suffix]`|
|`pet.attack`|`pet/attack_vN`|.35|.32|3|`A tiny companion makes a quick determined attack, small clothy hop and soft impact chirp without animal voice, [suffix]`|
|`pet.abilityReady`|`pet/ready`|.25|.30|1|`A tiny warm two-note chime signals a companion ability is ready, subtle, [suffix]`|
|`pet.hurt` (cooldown1s)|`pet/hurt_vN`|.38|.34|2|`A small magical companion is hit, soft impact and brief fragile shimmer, no animal cry, [suffix]`|
|`pet.down`|`pet/down`|.65|.42|1|`A small magical companion loses power, warm shimmer falls in pitch and fades, sad but brief, [suffix]`|
|`pet.revive`|`pet/revive`|.70|.38|1|DERIVE player `revive`, pitch +4 semitones, HP 250Hz.|
|`pet.idle` random≥8s, suppressed in combat|`pet/idle_vN`|.35|.16|3|`Very subtle tiny magical companion movement, soft fabric rustle and one quiet warm sparkle, no animal voice, [suffix]`|

## 8. Co-op states
|trigger|file|dur|gain|duck|decision/prompt|
|---|---|---:|---:|---|---|
|`revive.channelStart`|`coop/revive_start`|.50|.65|music:.8/.1/.3|NEW: `A teammate begins reviving another player, warm amber energy catches with a soft upward pulse and steady heartbeat onset, [suffix]`|
|`revive.channelLoop` while holding|`coop/revive_loop`|1.50|.42|—|NEW(loop): `Soft rhythmic amber healing pulse and restrained heartbeat, continuous revive channel, seamless loop, mono, no music`|
|`revive.cancel` damage/out-of-range|`coop/revive_cancel`|.35|.62|—|NEW: `A warm revive channel abruptly breaks, short glassy interruption and falling energy click, negative, [suffix]`|
|`revive.complete`|existing `revive`|existing|.9|music:.5/.18/.55|REUSE existing.|
|`spectate.enter` player becomes spectator|`coop/spectate_enter`|.65|.55|music:.75/.1/.4|NEW: `Perspective leaves a fallen player and shifts to a teammate, soft hollow whoosh and distant amber focus click, subdued, [suffix]`|
|`spectate.switch` target changes|`coop/spectate_switch`|.25|.35|—|DERIVE UI click, lowpass 5k + stereo pan whoosh.|
|`reconnect.lost`|`coop/disconnect`|.55|.65|music:.75/.1/.5|NEW: `Network connection breaks in a game, two warm digital pulses stutter downward and cut out, clear but not alarming, no harsh error buzzer, [suffix]`|
|`reconnect.try` every retry max1/2s|`coop/reconnect_tick`|.20|.28|—|DERIVE UI click, pitch -2, no jitter.|
|`reconnect.restored`|`coop/reconnect_ok`|.70|.65|music:.75/.1/.45|NEW: `Game connection restored, three warm amber pulses reconnect upward into a resolved soft chord, [suffix]`|
|`party.readyOn`|`coop/ready_on`|.38|.45|—|NEW: `A teammate marks ready, one warm wooden click and bright amber confirmation chime, [suffix]`|
|`party.readyOff`|`coop/ready_off`|.30|.38|—|NEW: `A teammate cancels readiness, a short warm confirmation tone falls one step, [suffix]`|
|`party.allReady` countdown starts|`coop/all_ready`|.80|.7|music:.7/.1/.45|NEW: `All players are ready, a confident three-note amber rally motif with a short gate mechanism latch, [suffix]`|

## 9. Difficulty / UI / profile / leaderboard
UI bus, no pitch jitter, rate-limited; never duck combat except full-screen run milestones.
|trigger|file|dur|gain|decision/prompt|
|---|---|---:|---:|---|
|`ui.hover`|procedural sine 900Hz/15ms|.10|REUSE synth; do not generate.|
|`ui.click`|existing `uiClick` synth|.22|REUSE.|
|`ui.confirm`|`ui/confirm`|.28|.38|NEW: `Short confident amber interface confirmation, wooden tactile click plus one bright warm chime, dry, no ambience`|
|`ui.back`|derive confirm pitch -4|.22|.30|DERIVE.|
|`ui.error`|`ui/error`|.35|.45|NEW: `Short restrained game interface error, two dry low wooden knocks and a muted descending tone, no harsh alarm`|
|`difficulty.change` selection rotates|`ui/difficulty_tick`|.25|.32|DERIVE click with pitch mapped Easy -2 / Normal 0 / Hard +2 / Nightmare +5; audible hierarchy.|
|`difficulty.confirm`|`ui/difficulty_confirm`|.55|.5|NEW: `Difficulty selection confirmed in a dark fantasy game, firm amber mechanism latch and short resolved chord, serious not triumphant, dry`|
|`profile.open`|`ui/profile_open`|.40|.28|NEW: `A compact leather-and-amber profile ledger opens, soft page movement and tiny warm crystal tick, dry interface sound`|
|`profile.statMilestone`|existing `levelup` at gain .55|.55|REUSE only for true milestone, never every stat update.|
|`profile.save`|`ui/profile_save`|.32|.30|NEW: `Small amber stamp presses onto a profile ledger, soft thunk and tiny glass confirmation, dry`|
|`leaderboard.open`|`ui/leaderboard_open`|.45|.30|NEW: `A ranked leaderboard panel unfolds, quick parchment slide and three subtle ascending metallic ticks, dry`|
|`leaderboard.rowMove`|derive hover|.08|.08|REUSE synth; rate limit 100ms.|
|`leaderboard.personalBest`|`ui/personal_best`|.90|.55|NEW: `Personal best achieved, concise adventurous brass-and-hammered-dulcimer success sting, warm and proud, no crowd, no long tail`|
|`leaderboard.topRank`|`ui/top_rank`|1.20|.65|NEW: `Top leaderboard rank achieved, short dark-fantasy victory flourish with warm brass, hammered dulcimer and one amber bell, no vocals, no long tail`|

## 10. TypeScript implementation contract
```ts
type AudioBus = "sfx"|"voiceTell"|"ambient"|"ui";
type Duck = { bus:"music"|"ambient"|"pet"; to:number; hold:number; recover:number };
type WaveSoundSpec = {
  stem:string; variants:number; gain:number; bus:AudioBus; priority:number;
  cooldownMs?:number; loop?:boolean; spatial?:boolean; duck?:Duck[];
  fallback?: { stem:string; rate?:number; lowpassHz?:number; highpassHz?:number };
};
```
- Sim emits semantic events (`marrowAimLock`, `choirStrikeWarn`, `reviveChannelStart`), client maps to manifest. Never infer attack phase from animation frame.
- `play(event, {x,y,entityId})`: priority-aware voice steal; max global voices 24, same-event 4, bossLock reserved 3 voices.
- Variant random without immediate repeat per event/entity; pitch jitter combat ±3% bosses, ±5% mobs/weapons; UI/locks 0%.
- Loops keyed by entity/event and explicitly stopped on phase exit/despawn/disconnect. Crossfade ambient zone changes 1.5s.
- Preload current biome + next boss; lazy-load future bosses/UI. If missing, use declared fallback and log once.
- Do not trigger: ambient one-shots during bossLock ±250ms; pet idle in combat; profile/leaderboard row noises per network update.

## 11. Generation + post pipeline
1. Generate new rows only; preserve raw under `audio-src/<stem>/takeN.*` with prompt metadata JSON.
2. Gate raw: valid decode, no vocals/speech unless Choir nonverbal, onset≤80ms except warnings/loops, no accidental melody in ambience.
3. Select takes, trim, mono one-shots; stereo ambience/music only.
4. Post one-shots: `silenceremove=start_periods=1:start_threshold=-50dB:start_silence=.005,highpass=f=35,loudnorm=I=-16:TP=-2:LRA=11,alimiter=limit=.89`.
5. Boss/phase/death use I=-14; UI I=-20; ambience I=-26. Encode ogg q5 + mp3 192.
6. Loops: remove model intro/outro; bar/texture align; equal-power 3s crossfade; measure head/tail RMS ratio .85–1.15, splice jump<.03.
7. Runtime QA: 30s stress with two players; no boss lock masked; no repeated clip identical >2 in a row; zero synth fallback when files present; zero fetch/decode failures.

## 12. Generation count / ship order
New generation budget (not counting variants): bosses 33 logical / ~48 takes; roles 10 / 20 takes; weapons 6 / 12; zones 6 loops; hazards 8 / 16; pets 6 / 10; co-op 10 / 10; UI 10 / 10. **Reuse/derive saves ~18 logical generations.**
Ship order: (1) boss lock/windup/impact + Charger/Burrower/Orbiter/Shielder, (2) Thumper/Sunlance, (3) hazards + co-op revive/reconnect, (4) ambient zones, (5) pets/UI/profile/leaderboard. Readability-critical wave must land before ambience polish.
