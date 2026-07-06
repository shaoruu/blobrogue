# blobrogue audio spec (audio director) — build-ready, ZzFX-mappable

## Identity: "8-bit, but it hits"
Fully synthetic (square/saw/noise + pitch envelopes + touch of bitcrush), every action physical. Refs: Enter the Gungeon (weapon punch), Nuclear Throne (dirty/aggressive), Downwell (one small palette), Soul Knight (bright+short for density).
5 pillars (EVERY sound): (1) transient-forward atk≤2ms (dash exempt); (2) pitch=info (small/friendly=high, big/threat=low, rewards ascend/deaths descend); (3) VARIATION or death — ±random on every play (varPct), #1 amateur→pro tell, never skip; (4) short by default 40-180ms (long = events); (5) frequency separation (weapons mid, impacts high-mid, boss/sub low, UI top).

## Synth core (build once, rest is data)
sfx({ shape, freq, freqEnd, sweepMs, atkMs, decMs, durMs, noise, lp, lpEnd, hp, q, bit, vol, bus, varPct })
- shape square|saw|sine|triangle + white-noise voice blended by noise(0..1)
- freq→freqEnd over sweepMs (exp); amp env atkMs then decMs→0 (sustain 0); lp→lpEnd sweep; hp; q; bit(0..1) crush; vol pre-bus; bus→category gain; varPct=±% on freq (+~half on durMs)
- helpers: seq(notes[],opts); duck(bus,toGain,holdMs,recoverMs)

## SFX
WEAPONS (transient + tonal down-sweep body + noise; bigger→lower/noisier/louder/longer, faster→shorter/quieter/more var):
- pistol: square 420→120 sweep45 atk1 dec65 dur80 noise.30 lp3000→800 q1 vol.50 var6
- shotgun: saw 180→55 sweep90 atk1 dec150 dur170 noise.70 lp4000→400 q.7 vol.68 var8 + sub sine 80→40 dur70; loudest
- rapid: square 540→320 sweep22 atk.5 dec35 dur45 noise.15 lp4200→1500 q1 vol.34 var10
- future archetypes: laser(sine 1200→300/60ms bit.3), plasma(square+40Hz trem bit.4), rocket(noise whoosh+sub, sep explosion), beam(ONE looped voice start/stop), charge(looped rising sine→release)
IMPACTS:
- enemy hit: square 900→520 sweep30 atk1 dec45 dur55 noise.35 lp5000 vol.40 var15; +2% pitch/consecutive hit within 300ms (combo), reset on gap
- enemy death (base slime splat): square 500→80 sweep110 atk1 dec150 dur180 noise.50 lp3500→600 bit.25 + sub sine 120→50 dur90 vol.50 var12. variants: slime=base | bat=freq×1.5+trem18Hz dur130 | skeleton=base+3×12ms noise ticks @+30/60/90ms bit.5 hp1200 | ghost=sine 700→200 slow dur320 noise.1 lp2000→400 vol.45
PLAYER:
- hurt: two detuned saws (220+233)→150/150ms atk1 dec180 dur200 noise.20 lp1800→700 bit.2 trem8Hz vol.62 var3; on hit duck(music,.5,120,500); must cut through
- dash: white noise dur180 BANDPASS 400→2000→600 q3 atk8 dec160 + sine zip 300→900/120ms vol.3, vol.40 var10
PICKUPS (ascending): coin seq[988,1319] square 50ms vol.40 (shower arpeggiates up, reset); heart seq[523,659,784] tri/sine 55ms vol.45; gun seq[C5,G5,C6]+E6 sparkle square bit.2 ~350ms vol.52; level-up 5-note major arp C-E-G-C-E +sparkle ~500ms vol.52
WORLD/BOSS: floor descend sine/tri 600→120/500ms + noise descent + thump ~700ms vol.50 (−1 semitone/floor optional); BOSS roar (marquee) layer sub sine 60→45 dur1200 + 3 detuned saws 110/108/113→70 lp1500→300 bit.4 trem6Hz dur900 + rising noise swell dur700→slam ~1.5s vol.85, duck(music,.3,200,800)+duck(sfx,.6,200,600); boss attacks telegraph(sine 200→650/400ms), slam(noise+sub100→40 dur160 vol.6), spit(sine 420→150 bit.4 dur90)
UI/DEFEAT: click square 1200 dur25 vol.28 bus:ui var2 (confirm 1500); hover sine 900 dur15 vol.16; game over seq descending minor [440,392,330,262] square→sine slowing, final bend C4→B3, lp 2000→300 vol.60 ~1.2s, duck(music,.2,...) or stop

## Music (seeds; juice pass needs only the dungeon loop)
Engine: lookahead scheduler (setInterval ~25ms schedules ~100ms ahead on ctx.currentTime; NEVER setTimeout note-by-note). Step arrays, loop.
Dungeon: D Dorian 112BPM 16steps/bar 8-bar. bass tri+lp400; pad 2 detuned saws lp800 drone; arp square Dm7 gated 16ths; kick steps 0&8; hat offbeats. Intensity layers crossfade on enemy count L0 bass+pad→L1 +hats+sparse arp→L2 +kick+dense arp.
Boss: A Phrygian 144BPM driving 16th bass, kick every beat, root+♭2 stab, riser; final phase +high lead+double hats. Menu: D major 84BPM gentle randomized arp.

## Mix
voice→category gain→master→limiter→dest. Defaults: master .80, music .50, sfx .90, ui .60 (music UNDER sfx). Limiter DynamicsCompressor(thresh -6, ratio 12, atk .003, rel .25) on master. Cap ~4-6 concurrent/SFX (steal oldest) + ~15ms retrigger cooldown. Ducking via setTargetAtTime. Persist localStorage blobrogue.audio {master,music,sfx,muted}; music/sfx toggles SEPARATE; mute=master→0 keep ctx alive; pause music on tab hidden + game pause.

## GATE: 5s rapid fire = rhythm not buzz · each weapon ID'able blind (shotgun>pistol>rapid weight) · no clip 6+ stacked · hit≠death · hurt cuts through · pickups rewarding · roar ducks+lands heavy · loop survives 2min · mute/vol persist, music/sfx independent.
PRIORITY for juice pass: varPct on shots + shotgun weight + hurt clarity carry the first impression.
