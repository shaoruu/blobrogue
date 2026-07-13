# blobrogue — PVP (FFA Arena Deathmatch) AUDIO MANIFEST
Audio Director. Recommendations + drop-in waveSpec rows. Bound to the shipped sim events blobrogue named: `pvpKill` (pos, by/victim/x/y), `pvpMatchOver` (global, winner), `match.ph` ("lobby"|"countdown"|"live"|"over"), `SelfWire.rsp` (respawn tick countdown). Runner wires hooks; assets generated via fal (elevenlabs SFX) unless reused. Buses/priority per waveSpec (ui/sfx/voiceTell, WAVE_PRIORITY).

## Sonic direction — SNAPPIER / ARCADE (distinct from moody PvE)
PvP is fast, competitive, dopamine. Where PvE is warm-dark and organic, PvP audio is:
- BRIGHTER, tighter, more electronic-arcade: crisp transients, short tails, a confident "sport/fighting-game announcer" energy WITHOUT literal voice.
- HIGHER register + faster attack than PvE cues so they punch through a chaotic FFA without muddying combat.
- Clean, dry, and LOUD-feeling (peak-managed by the limiter). PvP cues carry information under pressure, so readability > atmosphere.
- Still material/authored (no MIDI/oscillator placeholders) — arcade brightness comes from bright real materials (glass, metal, snap, synth-adjacent but sampled), not from oscillators.
- PALETTE ANCHOR: a small "PvP kit" identity — a signature bright metallic/glass "ping+thock" for frags, an ascending 3-note arcade sting family for wins, a descending one for losses — so the mode has its own recognizable voice, separate from PvE and from the amber/meta warmth.

## THE #1 RULE: pvpKill fires for EVERYONE — branch by role at the client
`pvpKill{by,victim}` is one event broadcast to all clients. The client MUST branch on the LOCAL player id:
- `by === self` → FRAG CONFIRM (the big juicy one, non-spatial, full gain — this is YOUR kill).
- `victim === self` → YOU DIED (death cue, non-spatial).
- neither → NEUTRAL KILL (a distant, quieter, SPATIAL thud at x/y so the arena feels alive but far frags don't spam you). Rate-limit these hard.
This one branch is the difference between "PvP feels great" and "every frag in a 6-player lobby blasts the same loud sound." Spell it out to the cloud agent wiring the hook.

## BEAT LIST + waveSpec rows

### 1. FRAG CONFIRM (by === self) — THE money sound
The single most important PvP cue. Punchy, bright, unmistakably "YES." Distinct from PvE enemyDeath (which is wet/organic) — this is a crisp arcade hit-confirm. Non-spatial, plays at full in your head.
- Base: `pvp.frag` — a tight bright "ping + thock" (glassy high transient + a satisfying low body). ~0.35s. 3 variants so a killstreak doesn't machine-gun one clip.
- ESCALATION (cheap, huge feel): a multikill/streak pitch-step. Same file, step the playbackRate up per rapid frag within a window (e.g. +1 semitone per kill inside 4s, reset on gap) — the classic arcade "double/triple kill rises." Stays in the 0.85-1.15 safe band for ~2 steps; for a bigger streak ladder, generate 2-3 dedicated escalation takes (`pvp.frag_streak2/3`) rather than pitching out of band.
```ts
"pvp.frag": { stem: "pvp/frag", variants: 3, gain: 0.85, bus: "ui", priority: 92, jitter: 0.03, cooldownMs: 40 },
"pvp.fragStreak2": { stem: "pvp/frag_streak2", variants: 1, gain: 0.88, bus: "ui", priority: 92, jitter: 0 },
"pvp.fragStreak3": { stem: "pvp/frag_streak3", variants: 1, gain: 0.9, bus: "ui", priority: 92, jitter: 0 },
```
Priority 92 = above weapon/impact, just under boss-lock reserved — a frag must never be culled. ui bus so it's non-positional and rides the SFX slider.
Prompt: "a punchy bright arcade kill-confirm, a crisp glassy high ping with a tight satisfying low thock, short and snappy, video-game frag hit marker, dry, no reverb tail, mono" (×3 distinct).

### 2. YOU DIED (victim === self) — distinct from co-op down
The victim's cue. NOT the co-op "down—wait for teammate" (that's collaborative/hopeful); PvP death is a sharp, deflating "you got got." Quick, clean, a touch comedic-arcade rather than grim (FFA respawns fast — this is a slap, not a funeral).
- `pvp.death` — a short descending "power-down" whiff + a dull impact. ~0.6s. Non-spatial, full gain. Ducks nothing (you want to hear the room).
```ts
"pvp.death": { stem: "pvp/death", variants: 2, gain: 0.8, bus: "ui", priority: 95, jitter: 0.02 },
```
Priority 95 (= revive tier) — your own death always reads. Prompt: "a short deflating arcade death cue, a quick descending downward whiff into a dull soft impact, you-got-eliminated, snappy not grim, dry, mono."

### 3. NEUTRAL KILL (someone else fragged someone else) — arena liveliness
Spatial, quiet, rate-limited. Makes the FFA feel populated without spamming.
- `pvp.killDistant` — a small dry thud/pop at the kill x/y. ~0.3s, low gain, spatial, hard cooldown + off-camera capped.
```ts
"pvp.killDistant": { stem: "pvp/kill_distant", variants: 2, gain: 0.35, bus: "sfx", priority: WAVE_PRIORITY.impact, jitter: 0.05, spatial: true, cooldownMs: 300 },
```
Fallback OK here (reuse enemyDeath filtered) since it's background texture. Prompt: "a short distant dry combat thud, a far-off elimination, small and unobtrusive, mono."

### 4. MATCH START — countdown + GO
Off `match.ph` transitions lobby→countdown→live.
- `pvp.countTick` — each countdown second (3..2..1). Bright arcade blip, RISING pitch per tick (tension ramp). Fire on the whole-second countdown readout. Non-spatial.
- `pvp.fight` — the "GO/FIGHT" stinger the instant ph flips to "live". The hypest cue in the mode — bright ascending arcade sting, "fighting-game round-start" energy (no literal voice, or a stylized non-verbal shout is fine if it reads clean). ~0.9s.
```ts
"pvp.countTick": { stem: "pvp/count_tick", variants: 1, gain: 0.6, bus: "ui", priority: 90, jitter: 0 },
"pvp.fight": { stem: "pvp/fight_go", variants: 1, gain: 0.9, bus: "ui", priority: 96, jitter: 0 },
```
Wire: countTick on each rsp-independent match countdown second; play a HIGHER rate on the final tick, then pvp.fight on ph==="live". Prompts: tick = "a short bright arcade countdown blip, clean, mono." fight = "an energetic ascending arcade round-start stinger, bright and hype, fighting-game GO, no words, short punchy build, dry."

### 5. MATCH OVER — WON vs LOST (branch on winner === self)
Off `pvpMatchOver{winner}` (and/or ph==="over" with match.win). Branch at client:
- winner === self → `pvp.win` — a triumphant bright arcade victory sting. ~1.5s. The ascending 3-note PvP family, resolved up, confident.
- else → `pvp.lose` — a shorter, deflating defeat cue. ~1.2s. Descending, not punishing — "gg, again?" energy (fast requeue).
```ts
"pvp.win": { stem: "pvp/match_win", variants: 1, gain: 0.9, bus: "ui", priority: 96, jitter: 0 },
"pvp.lose": { stem: "pvp/match_lose", variants: 1, gain: 0.8, bus: "ui", priority: 96, jitter: 0 },
```
Prompts: win = "a triumphant bright arcade victory fanfare sting, ascending confident resolve, celebratory, short, no words, dry." lose = "a short deflating arcade defeat cue, descending, disappointed but light, not harsh, dry."

### 6. RESPAWN — "back in" (off SelfWire.rsp reaching 0)
- `pvp.respawnTick` (optional) — a soft tick as your rsp countdown ticks down while you wait. Low gain, easy to omit if it feels naggy — your call; I'd ship it subtle.
- `pvp.respawnIn` — a short "you're back / weapons hot" blip the instant rsp hits 0 and you regain control. Snappy, positive, gets you moving.
```ts
"pvp.respawnTick": { stem: "pvp/respawn_tick", variants: 1, gain: 0.3, bus: "ui", priority: WAVE_PRIORITY.ui, jitter: 0, cooldownMs: 400 },
"pvp.respawnIn": { stem: "pvp/respawn_in", variants: 1, gain: 0.6, bus: "ui", priority: 90, jitter: 0 },
```
Prompts: respawnIn = "a short bright ready blip, back in the fight, weapons hot, snappy positive, dry, mono."

### 7. OPTIONAL TENSION / STAKES cues (nice-to-have, ship after core)
- `pvp.takeLead` — a bright rising 2-note when YOU take the frag lead (needs the scoreboard to expose lead-change; client can compute from the scores block). Small dopamine spike.
- `pvp.lostLead` — a subtle downward counterpart when you lose the lead. Keep quiet.
- `pvp.matchPoint` — a tension riser when any player reaches (fraglimit − 1) / the match is one frag from ending — the "someone's about to win" heartbeat. Raises stakes on the final frag.
- `pvp.finalFrag` — a special heavier hit on the match-winning kill (layer over pvp.frag for the winner / pvp.death for the loser). Makes the last kill feel like THE kill.
```ts
"pvp.takeLead": { stem: "pvp/take_lead", variants: 1, gain: 0.6, bus: "ui", priority: 88, jitter: 0 },
"pvp.matchPoint": { stem: "pvp/match_point", variants: 1, gain: 0.7, bus: "ui", priority: 90, jitter: 0 },
"pvp.finalFrag": { stem: "pvp/final_frag", variants: 1, gain: 0.95, bus: "ui", priority: 97, jitter: 0 },
```
These need a bit of client logic (lead tracking, fraglimit awareness) — flag to the cloud agent; if that's more than they want in v1, ship 1-6 and add these next pass.

## Reuse vs new (answer to (c))
- MOSTLY NEW. PvP's whole point is a distinct snappier identity; reusing PvE cues would make it feel like the same game with a scoreboard. The frag/death/win/lose/fight cues are the mode's signature — generate fresh.
- REUSE is fine for: `pvp.killDistant` (filtered enemyDeath), and weapon-fire/hit sounds during the match (PvP uses the same guns — those stay the existing weapon cues; do NOT re-author gunfire for PvP). So: shots/impacts reuse the arsenal; the KILL/DEATH/MATCH-FLOW layer is all-new PvP kit.
- Do NOT reuse `gameOver` for pvp.lose (too heavy/final — PvP loss is light/requeue) or co-op `revive`/down for pvp.death.

## Production (answer to (b))
- You generate via the fal pipeline (elevenlabs sound-effects/v2), same as every SFX pass — I spec + gate, you produce. I can't author final masters here (no fal creds in my env), but the prompts above are generation-ready.
- Counts: frag ×3 + streak2/streak3, death ×2, killDistant ×2, countTick, fight, win, lose, respawnIn (+ optional respawnTick, takeLead, matchPoint, finalFrag). ~14-17 short one-shots. Trivial on fal.
- All MONO except none (these are all one-shots); dry, short tails; loudness ~ -15 to -16 LUFS for the hero cues (frag/fight/win) so PvP feels loud-and-proud, -18 for ticks/utility. The master limiter handles stacking.
- Send me each batch and I gate: frag must feel GREAT + distinct from PvE death; win vs lose instantly readable; countdown→fight lands with hype; nothing culls a frag; neutral kills don't spam. Then Ian's ear.

## Priority order
1. `pvp.frag` (×3) + `pvp.death` — the core loop, 90% of the feel. Ship these first.
2. `pvp.fight` + `pvp.countTick` (match start hype) + `pvp.win`/`pvp.lose` (payoff).
3. `pvp.respawnIn` + `pvp.killDistant` (arena life).
4. Optional streak escalation + tension cues (takeLead/matchPoint/finalFrag).

## Note on PvP MUSIC (flag, not in scope unless you want it)
If you want music: a single driving, fast, arcade-tense loop for the "live" phase (crossfade in on ph→live, out on ph→over), reusing the music-bus/crossfade system. Not required for the juice pass — the SFX above carry it — but it's the natural follow-up. Say the word and I'll spec it with the music-expansion structure.
