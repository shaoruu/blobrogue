// GENERATED FILE — do not edit by hand.
// Produced from CHANGELOG.md by tools/genChangelog.mjs (wired into the build via
// vite.config.ts). Edit the changelog, not this file.

export interface ChangelogEntry {
  title?: string;
  body: string;
  media?: string[]; // public URL paths of shipped sprite art, e.g. "/sprites/pets/wick.png"
}

export interface ChangelogSection {
  version: string;
  date: string;
  entries: ChangelogEntry[];
}

export const CHANGELOG: ChangelogSection[] = [
  {
    version: "unreleased",
    date: "unreleased",
    entries: [
      { title: "More deep bosses toward floor 100", body: "the run keeps growing past the F80 Wake — more every-five-floors bosses and the giant F100 finale are still to come." },
      { title: "PVP beyond the private arena", body: "public matchmaking is still switched off, and a siege / objective mode is still ahead." },
      { title: "Odds and ends still queued", body: "click-outside-to-close on the shop, a Thumper scorch decal, more music variety, and full run-persistence so a dropped connection resumes your run instead of losing it." },
    ],
  },
  {
    version: "2026-07-20",
    date: "2026-07-20",
    entries: [
      { title: "The game fills your whole screen now", body: "on a big or high-res monitor the play area used to sit inside a black letterbox border. It now renders edge-to-edge at up to 4K, so you see more of the room and it stays pixel-crisp — no more bars around the game." },
      { title: "Your ult tells you the moment it's ready", body: "the little \"[F] <ULT> READY\" tag that pops over your blob when your ultimate charges now re-appears every time it recharges, for all four kits — not just the first time in a run. A quick, easy-to-miss-free reminder that your big button is back." },
    ],
  },
  {
    version: "2026-07-19",
    date: "2026-07-19",
    entries: [
      { title: "No more clipping through walls", body: "fixed a movement bug where you (or an enemy) could tunnel through a wall corner at the wrong moment. Collision is solid now, identically for everyone in co-op, so you can't accidentally slip out of a room or get shoved through geometry." },
      { title: "You can pick up guns reliably again", body: "weapon pickup range was finicky and swapping weapons by number key didn't always take. Walking over a dropped gun now grabs it dependably, and keyboard weapon-swapping is snappy and consistent." },
      { title: "Weapon switching doesn't scramble your hotbar", body: "changing weapons used to occasionally re-shuffle or blank the hotbar slots for a frame. The hotbar now holds its layout through a switch, so your slots stay put." },
      { title: "Teammates' melee swings show up", body: "in co-op, other players' melee attacks weren't drawing on your screen — a blade would deal damage with no visible swing. Remote melee now animates for everyone, so you can actually see your friend cleaving." },
      { title: "Split Shot is back (and Shoulderfire got reworked)", body: "the projectile blessings (Split Shot and its Scattergun cousin) return in a tuned-down form, so a movement build via Side Channel isn't the only projectile option — Split Shot is a fair pick again, not a must-have. And the old twin-pellet Scrapper is now \"Shoulderfire\": instead of a plain spray it fires a straight ghost round 80° off to one side of your aim, rewarding deliberate aim rotation.", media: ["/sprites/weapon_scrapper.png"] },
      { title: "Mender's team heal-over-time works again", body: "a bug had silently zeroed out the passive healing a Mender radiates to nearby allies (it was rounding down to nothing). Allies standing near a Mender now get their steady trickle of health back, exactly as intended — Mender's whole job as the team's sustain is restored." },
      { title: "The Oddsmaker's gambles sound like what they roll", body: "the gamble gun's random payloads now each have their own audio — a ricochet ping, a seeker whoosh, a blast thud, a pierce zip — so you can hear which effect you rolled, not just see it.", media: ["/sprites/weapon_oddsmaker.png"] },
      { title: "Sever won't stall mid-hunt", body: "on the F55 Sever fight, the boss could get stuck after an intercept window and stop hunting. It now correctly resumes the chase after each window, so the fight keeps flowing instead of hanging." },
      { title: "Loot stops spawning on the exit", body: "treasure could drop right on top of the GO DOWN exit, so grabbing it and leaving the floor fought each other. Chests and pickups now keep clear of the exit tile." },
      { title: "Bosses keep their signature weapons", body: "fixed a case where a boss's hand-picked weapon could get overwritten by a generic one — deliberate boss loadouts are preserved now." },
    ],
  },
  {
    version: "2026-07-18",
    date: "2026-07-18",
    entries: [
      { title: "Framerate protects itself now", body: "the game watches its own frame time, and if things get heavy in a busy fight it quietly dials back cosmetic detail (fewer particles, lighter effects) to hold a smooth framerate, then restores full detail once it clears. It never touches anything you need to see — boss tells, telegraphs, hazards, and the HUD always stay full. You shouldn't notice it working; you'll just stop noticing drops." },
      { title: "Razor Halo won't tank your FPS in a crowd", body: "orbiting through a big pack of enemies used to fire off a burst of hit-effects on every blade contact and stutter the frame. Those contact effects now batch together, so a dense swarm stays smooth — the Halo hits exactly as hard, it just stops spamming the effects.", media: ["/sprites/weapon_halo.png"] },
      { title: "Arena ultimates hit like a truck (visually)", body: "the private-arena kit ults got a big glow-up so they actually read as screen-dominating — Gunner's salvo is a bold cyan volley, Mender's triage a green heal pulse, Bulwark's shove a solid steel slab wall, Phantom's slip a violet phase-blur — each on its own color so a 4-way brawl stays readable." },
      { title: "Private-arena fights now change on the fly", body: "clearly marked tar blooms slow the chokepoints, warned gusts sweep exposed fighters unless they duck behind cover, and telegraphed spark mines pop with a small hit and shove. Tactical mid-match drafts offer counter-picks like Brace Band to soften knockback, Clear Eyes to briefly reveal a visible rival, and Rip Post to clear tar and chip nearby cover." },
      { title: "Jet stops littering the floor", body: "the F35 Mirror boss (Jet) left its blue corruption zones behind after it died, cluttering the room. They now clear when Jet goes down, so the floor's clean once the fight's over.", media: ["/sprites/jet_phase1.png","/sprites/jet_expose.png"] },
      { title: "Razor Halo is a main now", body: "the worn blade-orbit got a heavy buff so you can actually build around it — 4 blades (was 3), faster spin, harder contact, a shorter re-hit, and a bigger, punchier flare on fire. It shreds anything that presses into your space.", media: ["/sprites/weapon_halo.png"] },
      { title: "Razor Halo grows as you upgrade it", body: "the orbit now visibly escalates with your build — more blades, thicker glowing trails, and a more dramatic flare at higher upgrade tiers, so a maxed Halo looks as strong as it hits (readability + hit geometry unchanged).", media: ["/sprites/weapon_halo.png"] },
      { title: "Melee weapons hit like they mean it", body: "a full class buff so you can main a blade — Cutlass (fast circle-clear), Claymore (heavy flank sweep), Pike (reach thrust), and the Crooked Chain (snappier reel + harder sweep) all got more damage, snappier cadence, and a touch more reach, with their boss pricing paid down so parked uptime stays fair.", media: ["/sprites/weapon_crook.png"] },
      { title: "Melee feels meaty now", body: "a juice pass gives each blade its own impact weight — Cutlass reads as a snappy flurry, Claymore lands a heavy low thud with a cleave shockwave on big hits, Pike is a sharp linear skewer — plus combo-scaled blade trails and crit sparks. Performance-safe (effects coalesce, no frame drops)." },
      { title: "Melee sounds, per weapon", body: "a new melee audio layer — distinct swing + impact stems for Cutlass / Claymore / Pike, a cleave boom on heavy hits, a crit ring, and dedicated cues for the new melee blessings (including a decisive execute stinger)." },
      { title: "Five melee-native blessings", body: "real melee build verbs (not stat sticks) — STAGGER PULSE (heavy hits ring a knockback + slow to nearby foes), BLADE WARD (landing a hit grants a brief absorb shield), CLEAVE ON CRIT (a crit swing widens into a bigger arc), MOMENTUM CHARGE (dash or cover ground to load a big next swing), and FINISHER (execute low-HP trash — bosses always immune)." },
      { title: "Split Shot is gone — say hi to Side Channel", body: "the \"just more pellets\" blessing (and its Scattergun cousin) are retired. In their place, Side Channel rewards movement — after a dash or a hard aim-flick, your next shot also fires a ghost round along your *previous* aim. A second projectile you earn by juking, not by hosing." },
      { title: "PVP Wave 3 — arena ultimates (private arena)", body: "the private-room deathmatch now has kit ults built for the arena — Gunner's salvo, Mender's triage burst, Bulwark's shove-wall, and Phantom's blink. Public matchmaking stays off; this is private room-code arena only." },
      { title: "PVP melee stays fair", body: "with melee buffed, blades were killing too fast in duels, so player-vs-player melee damage is dampened in the arena (co-op melee is untouched) to keep fights in the intended ~4-5 second range." },
      { title: "\"px\" is gone from blessing text", body: "blessing descriptions no longer leak raw pixel units (stuff like \"revive from 12px farther\") — they read in plain language now, and a test keeps it that way." },
      { title: "Oddsmaker no longer tanks your FPS", body: "the gamble gun's blast used to stack a full barrel-explosion (screen flash, tons of debris) on every roll and drop frames under rapid fire. Now it gets a proportionate, still-punchy pop — juicy without the stutter.", media: ["/sprites/weapon_oddsmaker.png"] },
    ],
  },
  {
    version: "2026-07-17",
    date: "2026-07-17",
    entries: [
      { title: "Original pets finally have their attack wiggle too", body: "doggie/cat/dragon/slime now ship 4-frame attack strips (256×64) built from each base PNG with the same deterministic squash/stretch/lean transforms as the rescue pack — no fal per-frame. Assets were already registered and the owner-fire emote already fires for every equipped pet; the missing sheets were the only gap.", media: ["/sprites/pets/doggie.png","/sprites/pets/cat.png","/sprites/pets/dragon.png","/sprites/pets/slime.png"] },
      { title: "Rescue pets now read as real animals", body: "Wick (moth), Pebble (toad), Clatter (hermit crab), and Nullfin (fish) got a silhouette pass so you recognize them at a glance — same companions, clearer animal DNA (idle/walk/attack strips updated).", media: ["/sprites/pets/wick.png","/sprites/pets/pebble.png","/sprites/pets/clatter.png","/sprites/pets/nullfin.png"] },
      { title: "Four more companions to rescue (with a new \"attack\" wiggle)", body: "Wick, Pebble, Clatter, and Nullfin join the pack at the Kennel — each rescued from a deeper floor (Wick at 5, Pebble at 9, Clatter at 14, Nullfin at 20), never bought, purely a companion at your side. Every pet (old and new) now also does a quick, cute reaction beat when its owner fires or swings — a little pet \"emote,\" never combat. Pets still never grant any power. (Sable ART PASS sprites wired at the registered paths; Vale EAR PASS on Wren-locked pet SFX stems (wick_flicker/drift/spark, pebble_hop/puff/blink, clatter_scuttle/settle/click, nullfin_glide/bubble/puff); see docs/audio/PET_WAVE_D_SELECTED_MANIFEST.json. Provisional verbs (flutter/fold/sparkle/tongue/snap) rejected. Attack emote still falls back gracefully if a sheet is missing.)", media: ["/sprites/pets/wick.png","/sprites/pets/pebble.png","/sprites/pets/clatter.png","/sprites/pets/nullfin.png"] },
      { title: "More hats + more face items", body: "8 new hats — Corked Cap, Lamplighter's Brim, Root Circlet, Ember Visor, Bone Band, Brass Archivist Cap, Pale Hood, and Null Crown — plus 6 new face items — Amber Specs, Coal Smudge, Shale Goggles, Pale Bandage, Resin Monocle, and Choir Veil. Some are yours from the start; others are earned by going deep or racking up all-time kills. All purely cosmetic, worn over your blob, never any gameplay effect. (Sable ART PASS oriented PNGs wired at the registered paths; a still-missing item simply renders nothing.)", media: ["/sprites/cosmetics/hat_cork_side.png","/sprites/cosmetics/hat_lamp_brim_side.png","/sprites/cosmetics/hat_root_side.png","/sprites/cosmetics/hat_ember_visor_side.png","/sprites/cosmetics/face_amber_specs_side.png","/sprites/cosmetics/face_coal_smudge_side.png","/sprites/cosmetics/face_shale_goggles_side.png","/sprites/cosmetics/face_choir_veil_side.png"] },
      { title: "Private room-code ARENA is playable (public matchmaking still off)", body: "the Online Home ARENA toggle is now live whenever private pvp is enabled — pick ARENA and CREATE ROOM to spin up a private, code-shared deathmatch, or JOIN CODE into a friend's. QUICK PLAY still only reaches the public pool, which stays dark, so a pvp quick play is refused up front and steers you to CREATE ROOM. The toggle only shows the disabled `ARENA · PATCHING` state when both private and public pvp are off. No change to the public kill switch." },
    ],
  },
  {
    version: "2026-07-16",
    date: "2026-07-16",
    entries: [
      { title: "F70 Claimant has its own ALL THINGS OWED sound kit", body: "the fight no longer borrows Choir/Weaver placeholders. Entrance, phase, death, the 1.4s crown-lane tell + aim-lock + descent, punish shatter, recover, capped miss, claim-token pickup/pass/drop, socket light, deposit, guard chip, and overcommit each ship as dedicated gilded-debt one-shots (ogg+mp3). CROWNFALL stays retired." },
      { title: "F80 Wake — THE LAST PROCESSION story SFX", body: ": 16 selected stems (ogg+mp3) under `public/audio/boss/wake_procession_*` — remastered loudnorm+alimiter=.89, early onset, denser lock/fail/front (no front_v3/fail_v1). WAVE_SOUNDS + bestiaryAudio remapped off choir/weaver placeholders; NIGHTFALL PROCESSION stays retired." },
      { title: "Wave C held guns aim along the barrel", body: "Hushiron, Backtalk, Lamplighter, and Faultlink ship diagonal held sprites (barrel ~30–40° up-right, same convention as Cleaver/Tracker). Their `HELD_ART_ANGLE` corrections were missing, so the overlay pointed off the true aim — the same diagonal-gun bug Ian caught on the first content-wave pass. Measured per-sprite and registered; no art regen.", media: ["/sprites/weapon_hushiron.png","/sprites/weapon_backtalk.png","/sprites/weapon_lamplighter.png","/sprites/weapon_faultlink.png","/sprites/weapon_cleaver.png","/sprites/weapon_tracker.png"] },
      { title: "Wave C gun art (pickup + held)", body: "Hushiron, Backtalk, Lamplighter, and Faultlink now have real floor-pickup sprites (`weapon_<id>.png`, 64px) and in-hand held overlays (`held_<id>.png`, 40px) — cold-iron stance rifle, warm-copper parry stub, warm lamp-muzzle, and teal twin-prong fault-seam. Dropped at the exact paths `assets.ts` already registered; hotbar icons and held draw no longer fall back to the generic gun.", media: ["/sprites/weapon_hushiron.png","/sprites/weapon_backtalk.png","/sprites/weapon_lamplighter.png","/sprites/weapon_faultlink.png"] },
      { title: "Amber Camp polish (Kennel pets + button edges)", body: "Kennel cards now show the real pet sprites (doggie / cat / baby dragon / baby slime) via the same thumbnail the loadout gate already uses; amber price digits on the yellow Camp buttons render cleanly in VT323 (no new font); Camp Upgrade / Bring Along / Leave Companion buttons no longer sit flush or crush their labels; and the weird dark left/right dashes on those compact yellow buttons are gone (they were the chunky menu clip-path notches + ink ring on a short CTA).", media: ["/sprites/pets/doggie.png","/sprites/pets/cat.png","/sprites/pets/dragon.png","/sprites/pets/slime.png"] },
      { title: "F80 THE WAKE — THE LAST PROCESSION (Batch3B)", body: "a cross-room escort. An autonomous last-light convoy advances from the spawn side to the exit across the room graph inside a continuous warmth corridor; the team PROTECTs it — ride inside the corridor and shoot the one highlighted blocker before each threshold while a dark front closes from behind. Escort the convoy across a threshold with the blocker cleared → THE LAST PROCESSION: a 1.5s blackout tell, then the dark front follows the convoy to the threshold and the Wake is forced into the light for a 4.0s window. Step to a side shelter off the path to stall the convoy and survive with no window; a miss is a bounded warmth loss + a capped hit, never a wipe. Crossing the final threshold clears the floor. PROTOCOL 43 (`last_procession`). NIGHTFALL PROCESSION retired." },
      { title: "F70 CLAIMANT — ALL THINGS OWED (Batch3A)", body: "a compact coordination arena. One player carries a claim-token and becomes the marked target; that carrier's shots can't break the Claimant's guard, so the team has to deliberately pass the token (solo: deposit it through the timed sockets instead). Three correct passes/deposits bait an overcommit → ALL THINGS OWED: a 1.4s angular crown-lane tell locks aim at 0.84s, then one socket lights — deposit the token into that socket after the lock to shatter the crown and kneel the boss for a 3.0s window. Dash perpendicular out of the lane to survive with the token (no window); a miss is a capped hit, never a wipe. PROTOCOL 42 (`all_things_owed`). CROWNFALL retired." },
      { title: "F65 UNDERTOW — THE RIVER COMES BACK (Batch2B)", body: "steal a Warm Pulse in the deep room and run it spawnward while an untargetable flood pursues. Deposit the Pulse in a highlighted relief vent before the front arrives to force Undertow to manifest for a 3.5s punish window; drop into a marked alcove to survive without a window. Soft failure only — never a wipe. PROTOCOL 41 (`river_comes_back`). BLACK_TIDE retired." },
    ],
  },
  {
    version: "2026-07-13",
    date: "2026-07-13",
    entries: [
      { title: "Mender isn't immortal anymore", body: "a solo Mender used to sit at full HP the whole run (its self-heal out-paced all incoming damage). Now taking a hit pauses your OWN healing for a beat and your self-heal is capped lower, so damage actually lands and HP drifts down in a fight — you have to play well and grab hearts like anyone. Healing OTHERS is completely unchanged: a Mender still fully carries the team's sustain and can instantly clutch-heal a teammate under fire." },
    ],
  },
  {
    version: "2026-07-12",
    date: "2026-07-12",
    entries: [
      { title: "PVP arena now actually loads the arena", body: "fixed a bug where picking ARENA and joining dropped you into a normal co-op dungeon (procedural rooms, a GO DOWN exit, walk-through-walls) instead of the deathmatch arena. The client wasn't reading the match mode off the server, so it rebuilt a co-op dungeon over the real arena. Now it reads the mode from the authoritative world and builds the right map." },
      { title: "PVP has sound now", body: "the arena deathmatch got its own snappy arcade audio layer, distinct from the moody PvE. A crisp frag-confirm ping when YOU get a kill (that pitches up on a killstreak), a deflating \"you got got\" cue when you die, a rising countdown into a hype GO stinger at match start, triumphant-vs-deflated stings for win/lose, a \"back in\" blip on respawn, and quiet spatial thuds for far-off kills so the arena feels alive without spamming you. (Co-op audio is unchanged.)" },
      { title: "PVP is here — free-for-all ARENA DEATHMATCH", body: "a whole new way to play. Jump into a symmetric arena and frag it out — everyone starts on equal footing (same gun, no kits/ults/perks, so it's pure aim and movement), you respawn a couple seconds after dying (no sitting out), and first to the frag limit wins (the target scales with lobby size, ~8 for a 1v1 up to ~12 for a 6-player brawl, with a time cap). Fresh spawns get brief protection so you're never spawn-camped, player-vs-player damage is tuned for ~4-5 second fights (not instant deletes), and the arena's cover is breakable so the map opens up as the match goes on. Pick CO-OP or ARENA in the online lobby. (Co-op is completely unchanged.)" },
      { title: "No more \"peeing\" ult meter", body: "the ult charge orbs no longer stream continuously from your blob to the meter (a Mender charging its ult mid-heal looked like... well). Now a satisfying spark flies from an enemy only when a kill or boss-hit feeds your ult; passive charging just pulses the meter in place." },
      { title: "The F50 GIANT has arrived — the GORGE", body: "hit floor 50 and you'll face a colossal, half-sunk boss three times your size that never chases — its whole threat is the room. You can't just burn it down: its outer shell is a true wall (zero damage while it's sealed). You crack it open by destroying the glowing tectonic weak-points that jut out on a telegraph, which peels the shell off a layer at a time — crusted rind, then dark chitin, then the blazing molten-amber core (your stolen amber) underneath. Each of the three layers is its own mini-fight with a different problem: phase 1 you time your dash through expanding shockwave rings, phase 2 the floor shrinks as creeping slag pools deny ground, and phase 3 you ride one rotating safe-lane while everything's live. Every peeled shell sloughs off as debris you can duck behind. It's a real three-chapter fight, not a bag of HP — and it's the template for the giants waiting at F75 and F100.", media: ["/sprites/gorge_shell_core.png","/sprites/gorge_shell_rind.png","/sprites/gorge_shell_chitin.png"] },
      { title: "Ghosts no longer flicker or face the wrong way", body: "because a ghost phases straight *through* you instead of stopping, it used to snap left-then-right every frame while it overlapped you — the sprite flickered and half its walk frames faced backward. Phasing enemies now read their facing from a smoothed drift instead of that frame-to-frame wobble, so a ghost calmly faces the way it's actually travelling. Every other enemy and the hero are unchanged." },
      { title: "No more seams between walls and floors", body: "the thin 1px lines that could show up along tile edges as the camera panned are gone — the dungeon now renders its floor and wall tiles with crisp pixel-perfect sampling, so the world reads as one solid surface with no anti-aliased gaps. Smooth camera panning is unchanged." },
      { title: "The F30 finale keeps you guessing", body: "the Hollow Choir now reshapes its hall on every phase — resonant pillars crumble and a fresh gapped ring rises — and the ring genuinely changes shape as the fight escalates (it closes into a tight inner ring, then opens out into a wide, sparse one), so each phase's hall reads as a distinct room instead of the same ring re-spun, always with a clear route through. And its verses no longer summon only ghosts: each gathering verse is a different readable spectral kin — the drifting revenant, the hollow dead, and now a wheeling swarm of grave-bats roused from the rafters — so the \"who's singing this time\" guess is three voices deep and no two silence-the-choir loops feel the same. The earned-window core is untouched: you still open its window by silencing the verse.", media: ["/sprites/choir.png","/sprites/choir_attack.png"] },
      { title: "The F35 Mirror boss (Jet) now truly turns YOU against yourself", body: "Jet's corrupted salvo no longer cycles your mirrored schools in a fixed order — it now draws WHICH of your own guns to turn on you unpredictably, never the same school twice in a row, so you can't rote-memorize the pattern. It also spawns telegraphed REFLECTIONS of you: a cold, hollow-eyed jet-black copy of a targeted player (teammates see \"[name]'s reflection\") flickers in on a fair warning tell, fires one salvo of your own aggression back at you, then dissolves — one at a time, fragile and brief, never a second Jet to fight. And as Jet wins, the arena itself goes dark: cold resin-corruption creeps inward from the edges each phase (bright-edged so you always read \"don't stand here\"), shrinking your safe ground while always leaving a route. The core fight is unchanged — you still open Jet's window by surviving its mirror salvo.", media: ["/sprites/jet_phase1.png","/sprites/jet_expose.png"] },
      { title: "The Quorum's splinters now play fair", body: "when a husk breaks, its \"splinter\" shards no longer pop into existence right on top of you. Each shard now telegraphs its arrival like every other boss add — a brief hazard tell blooms at the spot first, and a shard will never appear inside your personal space. Everything else about the fight is unchanged: the shards still carry their parent's role (heal/damage/shield), the kill-order lesson holds, and the wave cap and pacing are the same.", media: ["/sprites/quorum_merge.png","/sprites/quorum_splinter_dmg.png","/sprites/quorum_splinter_heal.png","/sprites/quorum_splinter_shield.png"] },
    ],
  },
  {
    version: "2026-07-11",
    date: "2026-07-11",
    entries: [
      { title: "Every gun now fires real bullet FX — no more plain circles", body: "the bullet-visual pass is now comprehensive across the whole arsenal, including the legendaries (Reaper's menacing soul-bolt, Hive's darting seeker mote, Midas's golden gleam, Umbra's violet phase round with an afterimage, Lodestone's inward-pulling magnet swirl) plus Lastlight, Breach, Frostline, and the Prism Sentry's bolts — each reads its own identity instead of falling back to a flat circle.", media: ["/sprites/weapon_umbra.png","/sprites/weapon_reaper.png","/sprites/weapon_hive.png","/sprites/weapon_midas.png","/sprites/weapon_lodestone.png","/sprites/weapon_frostline.png"] },
      { title: "Design-system tokenization", body: "swapped raw hex colors in the run-stats panel, roster, results screen, and shop icon tints over to the existing `:root` tokens (identical render), and added two decoupled affirmative-green tokens — `--ok` for menu/lobby status (connected / ready) and `--at-exit` for the in-run HUD \"teammate is at the exit\" cue." },
      { title: "Less HUD clutter for Gunners", body: "the HEAT pip row no longer sits empty when you're cold — it appears the moment heat starts building (or the boil-over kicks in) and tucks away at zero, so an idle Gunner isn't staring at a blank readout. Your dash meter stays put." },
      { title: "Kits now work in SOLO", body: "playing solo (and classic co-op) finally spawns you as your chosen class — you get its stat lean, starting weapon, passives, and a live ult meter with the right badge and signature row — instead of the kitless neutral blob with a pistol. Your Amber Camp pick now applies everywhere, not just online. A kit chip on the title names your current class and opens the picker, so you always know (and can change) what you're playing. Also fixed a HUD bug where a kitless player still showed a nameless \"ULT\" widget." },
      { title: "Enemy shots read as real threats", body: "enemy bullets are no longer flat circles — they're now hot danger-orbs (a soft glow + a white-hot core that says \"dodge this\"), kept round + uniform so they're instantly distinct from your own streaky shots, and readability-gated on every biome." },
      { title: "Each class now feels distinct", body: "GUNNER builds Momentum to an OVERHEAT burst (pierce + fire-rate spike) shown as heat pips; BULWARK carries a regenerating overshield you watch absorb hits on the health bar; MENDER gets a visible heal-beam to your hurt ally plus a directed heal-pulse (press C); PHANTOM marks enemies it dashes through (they take +15%) and refunds part of the dash. No stat bloat — each is a signature you can see and feel." },
      { title: "Each class finally FEELS different", body: "every kit now has one signature you can see and feel in the first few seconds. **Gunner** builds HEAT as you land hits unhit — a pip row climbs 0→5 and, at full heat, the gun boils over into a short burst of extra fire + pierce (a hit no longer wipes the whole ramp, so it survives a boss fight). **Bulwark** carries a regenerating armor OVERSHIELD shown right on the health bar — chips soak hits before your hearts and top back up out of combat. **Mender** gets a directed heal-beam to whoever's hurt most plus a short-cooldown PULSE (press C) to snap-heal the ally you're aiming at. **Phantom** dashing THROUGH an enemy marks it (everyone's shots hit it harder for a moment) and refunds part of the dash — lean into the movement. None of it raises the ceiling; each is just a faster, more legible route to what the class already did." },
      { title: "Your ult finally makes sense", body: "the meter now shows your kit's ult BY NAME (Overdrive / Sanctuary / Aegis / Phase), lights up loud when it's READY, and visibly charges from combat — energy motes fly from enemies you kill and bosses you hit straight into the meter. Charging is now weighted toward playing (kills + damage) instead of a passive timer, and a kit badge shows which class you are." },
      { title: "Pets feel alive now", body: "the companion was redesigned (a chunkier shiba pup that reads cleaner) and it no longer clips through walls — it paths around them with you, lags-then-scampers to keep up, and actually animates (idle breathe + a real trotting run cycle). Same fix applies to all pets.", media: ["/sprites/pets/doggie.png"] },
      { title: "The new guns fire real bullets, not circles", body: "all 8 recent weapons (Cleaver, Scrapper, Skipper, Arcbolt, Cryobolt, Firebomb, Tracker, Singularity) now have proper layered projectile FX matching each weapon (the Singularity's swirling void orb, Firebomb's fiery shell, Arcbolt's electric crackle, etc.) instead of the plain fallback circle.", media: ["/sprites/weapon_cleaver.png","/sprites/weapon_scrapper.png","/sprites/weapon_skipper.png","/sprites/weapon_arcbolt.png","/sprites/weapon_cryobolt.png","/sprites/weapon_firebomb.png"] },
      { title: "Smoother co-op netcode", body: "the game now sends only what changed each frame (with periodic full keyframes), cutting per-player network traffic ~90% in busy 4-player fights — more headroom, less lag under load. Reconnects and packet loss recover cleanly." },
      { title: "The Amber Camp has sound", body: "opening the Camp, buying an upgrade, and the can't-afford nudge now play warm amber cues instead of silence." },
      { title: "Every pet has a voice now", body: "the cat meows and purrs, the baby dragon chirps and rumbles, and the slime squishes along beside you (each warm and cooldown'd so it stays cute, never annoying).", media: ["/sprites/pets/cat.png","/sprites/pets/dragon.png","/sprites/pets/slime.png"] },
      { title: "The doggie has a voice", body: "your companion now softly pants as it trots to keep up and gives a content little sigh when it settles beside you (warm, low, and cooldown'd so it never grates).", media: ["/sprites/pets/doggie.png"] },
      { title: "New guns sound the part", body: "the 8 new weapons each got a distinct fire sound (saw-disc whirr, arc zap, cryo crackle, the void cannon's gravity whoomp, and more)." },
      { title: "More guns, more traits", body: "8 new weapons — Cleaver (a slow saw disc that shreds a whole line), Scrapper (twin-pellet spray hose), Skipper (buckshot that banks off walls), Arcbolt (short-range shocker that arcs across a pack), Cryobolt (freezes a body solid), Firebomb (a lob that leaves the blast ablaze), Tracker (one heavy seeker that never misses), and the legendary Singularity (collapses the pack onto one point, then a nova detonates on the clump). Plus 10 new blessings — Marksman, Juggernaut, Heavy Rounds, Skirmisher, Executioner, Overload, Featherweight, Frostbite, Quickdraw, and Vanguard — each a distinct build with a real tradeoff.", media: ["/sprites/weapon_cleaver.png","/sprites/weapon_scrapper.png","/sprites/weapon_skipper.png","/sprites/weapon_arcbolt.png","/sprites/weapon_cryobolt.png","/sprites/weapon_firebomb.png"] },
      { title: "Three new companions to rescue", body: "a grey cat, a baby amber dragon, and a baby slime join the doggie at the Kennel — rescue each from a deeper floor (the slime waits in the deepest dark), then pick which one rides along at your side (one companion at a time).", media: ["/sprites/pets/doggie.png","/sprites/pets/cat.png","/sprites/pets/dragon.png","/sprites/pets/slime.png"] },
      { title: "Chunkier, better-spaced Camp Doggie", body: "the pup is now pixelated to match the game's art scale (it was rendering too high-def/smooth next to everything else), and it sits a bit further back so it hangs out beside you instead of on top of you.", media: ["/sprites/pets/doggie.png"] },
      { title: "Main menu fits on one screen", body: "the home screen no longer scrolls — Play, Camp, the leaderboard glance, and every destination are visible at once on any window size (the blob stays the centerpiece). Short laptops now compact the hero band instead of pushing Play off-screen." },
    ],
  },
  {
    version: "2026-07-10",
    date: "2026-07-10",
    entries: [
      { title: "🐕 Meet your Camp Doggie + the Amber loop", body: "A stray pup you rescue from the depths now trots at your side — sits when you're still, follows you into every run. It's the first of a growing pack. Plus Amber is now a currency you KEEP between runs (earned from floors, depth, and first boss kills), spent at the new Amber Camp on companions and upgrades. More camp coming soon.", media: ["/sprites/pets/doggie.png"] },
      { title: "Cosmetic edge cleanup", body: "removed stray colored specks that could appear at the edges of the blob when wearing hats/glasses (leftover pixels in the transparent areas of the art)." },
      { title: "Kits/classes + ultimates + XP", body: "pick a class in the Amber Camp lobby — GUNNER (Overdrive: burst fire), MENDER (Sanctuary: healing zone), BULWARK (Aegis: projectile-blocking dome), PHANTOM (Phase: team invuln + speed). Each has a signature ULTIMATE on a server-charged meter (fills from damage/kills/time). Plus an account MASTERY track that unlocks kits as you play, and **HP numbers on the HUD** (not just hearts). Co-op: comps emerge, no forced roles." },
      { title: "Cosmetic hats fixed + head redesign", body: "hats no longer double-stack on the baked-in cowboy hat — the blob now has a proper bare rounded head, and any hat you equip sits cleanly on top (cowboy hat is now its own equippable). Fixed hats covering the eyes and the head bulging out around narrow hats; all 7 hats (cowboy/top/wizard/chef/beanie/crown/helmet) now sit right." },
      { title: "Three new deep bosses (F35/F40/F45)", body: "JET — a corrupted mirror of your squad that turns your own weapon archetypes against you (survive its phases and it burns out, exposed). THE TITHE — an armored feeder that re-armors behind a feeding slab; smash the slab to open its window. QUORUM — three linked husks on one shared HP pool with load-bearing roles (kill order matters), that fuse into a merge-form if you're too slow. All earned-window fights (real tells, dodge-able, no HP sponges), co-op-scaled, and they honor the new floor mutators/affixes so repeats stay fresh.", media: ["/sprites/jet_phase1.png","/sprites/jet_expose.png","/sprites/tithe_tribute.png","/sprites/tithe_phase2.png","/sprites/quorum_merge.png","/sprites/quorum_splinter_dmg.png"] },
      { title: "Deep runs stay fresh (F31+)", body: "floors past 30 now roll seeded **mutators** (Dense Dark, Molten Floor, Twinned Elites, Fracture Storm, Amberfall, Thin Air — up to 2 per floor, shown on the HUD), elites can spawn with **affixes** (splits / shielded / hazard-trail / reflect / enrage), and deep bosses can carry an extra telegraphed **affix** pattern so a repeat boss fights differently. All deterministic + co-op-synced, with a 4-player readability budget so it never becomes unreadable soup." },
      { title: "Fixes + controls", body: "leaderboard now banks your deepest floor as you descend (no more losing depth to a disconnect); precise hotbar drag-to-reorder + drag a weapon out to drop it; double-tap a direction to dash (toggle in settings) and a rebindable dash key; the Prism Sentry animates now; and a max-HP/artifact accounting fix.", media: ["/sprites/weapon_sentry.png"] },
      { title: "Deep-game foundations (floors 31-50 groundwork)", body: "per-region enemy decks so deeper floors stop repeating the same roster, a 4-player effect-density system so busy fights stay readable, a deterministic randomness backbone for upcoming floor mutators/affixes, and four new deep-region palettes (Sump/Veinworks/Pale/Null Core)." },
      { title: "New cosmetics + legendary art", body: "a fresh wave of real hats (top, crown, party, halo, wizard, beanie, helmet, chef, flower, mushroom, horns, headphones) and face items (sunglasses, monocle, eyepatch, star shades, 3D glasses) — replacing the old placeholder shapes — plus proper art for all 5 legendary guns (Umbra, Reaper, Hive, Midas, Lodestone).", media: ["/sprites/cosmetics/hat_top_side.png","/sprites/cosmetics/hat_crown_side.png","/sprites/cosmetics/hat_wizard_side.png","/sprites/cosmetics/hat_halo_side.png","/sprites/weapon_umbra.png","/sprites/weapon_reaper.png","/sprites/weapon_hive.png","/sprites/weapon_midas.png"] },
      { title: "Combat correctness + performance", body: "bosses now path around walls & cover instead of beaching on them (no more cheesing from behind a wall); fixed frame-rate drops from Thumper and other AoE weapons, with a standing performance guard so it can't regress; Snapwire / Razor Halo / Crooked Chain now break barrels & props; Sunlance's range matches its beam and it has a fire sound; coins can no longer drop inside walls.", media: ["/sprites/weapon_snapwire.png","/sprites/weapon_halo.png","/sprites/weapon_crook.png"] },
      { title: "UI overhaul", body: "your blob is now a big centerpiece on the main menu; the menu buttons are reorganized with clear hierarchy; Settings is now tabbed (Audio / Gameplay / Video / Accessibility) instead of one long list; a game-wide consistency pass (unified colors, text sizes, focus outlines, keycaps, panels); and a new in-game **What's New** panel so you can read the changelog right in the game." },
    ],
  },
  {
    version: "2026-07-09",
    date: "2026-07-09",
    entries: [
      { title: "Co-op game-feel pass", body: "you now HEAR teammates' guns, hits, and pickups (positional audio); friendly fire is a harmless playful \"bonk\" (a little shove + squash, zero damage); coins fly into your wallet on pickup; the weapon stat card no longer pops when you tap 1–9; the \"E to trade\" prompt now floats by your character instead of the screen corner; and a batch of previously-silent events got sound." },
      { title: "Premium coin economy", body: "shops get richer and pricier the deeper you go — a boss-reward vendor, a guaranteed pre-final-boss vendor, legendary/mystery weapons, heart containers, rare blessings, rerolls, and a big-ticket **Mythic** \"spend everything\" capstone on floors 20/25/30. Leftover coins trickle a little Amber; coins never buy permanent power." },
      { title: "Boss rework — earned windows + fair surprise", body: "bosses (Weaver first) are guarded by default and open real damage windows you create (break anchor knots, clear egg-sacs, bait charges), with unpredictable-but-always-telegraphed attacks, plus party- and gear-aware scaling so a strong 4-player squad gets a tougher fight instead of a bullet sponge." },
      { title: "Weapon rarity system", body: "rarity tiers, five legendary \"gimmick\" guns with unique mechanics, and mystery \"???\" drops you identify by grabbing them." },
      { title: "The Effect Wave — 7 new weapons", body: "Frostline (chill zones), Snapwire (tripwires), Razor Halo (orbiting blades), Prism Sentry (deployable turret), Breach (charge-up blast), Lastlight, and Crooked Chain — built on new shared effect systems.", media: ["/sprites/weapon_frostline.png","/sprites/weapon_snapwire.png","/sprites/weapon_halo.png","/sprites/weapon_sentry.png","/sprites/weapon_breach.png","/sprites/weapon_lastlight.png"] },
      { title: "Ambient occlusion + authored lighting", body: "for real depth and mood (with a high-contrast accessibility toggle)." },
      { title: "Hotbar cap + swap-or-drop", body: "the hotbar is capped so slots stay mapped to 1–9; grabbing a weapon when full gives you a swap prompt." },
      { title: "Remote dash sync", body: "you can see teammates' dashes (blink + afterimage + dust)." },
      { title: "Shareable room invite links", body: "(`/r/CODE`) — friends click and drop straight into your lobby, guests included." },
      { title: "Menu & identity redesign", body: "play-first title screen with your live blob, global leaderboard, profiles, a cosmetics closet (hats/glasses), in-profile rename, and a global pixel scrollbar." },
      { title: "Bestiary expansion", body: "a two-wave enemy ecology with behavior-based elites and minibosses." },
      { title: "The boss roster", body: "5 bosses, 4 new enemies, 2 new weapons — the big content drop." },
      { title: "Depth-progression world", body: "six biome bands with distinct room types, seeded floor hazards, and reactive ambience." },
      { title: "Authoritative co-op", body: "revive downed teammates, spectate, shared blessing gate, party economy, and room replay." },
      { title: "Patch's Waystation", body: "an in-run Dealer shop room." },
      { title: "Audio settings", body: "master / music / SFX volume sliders." },
      { body: "Fixes & polish: props no longer jitter against the player, the boss health bar shows the boss's name, calmer default screen shake, teammate colors + names sync correctly (with a one-time name prompt), early-game weapon variety (no more same guns every run), full de-synthesized authored audio, enemy durability tiers, and readability fixes." },
    ],
  },
  {
    version: "2026-07-08",
    date: "2026-07-08",
    entries: [
      { title: "Multiplayer hardened", body: "one authoritative server path, verified room readiness, and reconnect grace/resume so a flaky connection never locks you out." },
      { title: "Minecraft-style hotbar", body: "for weapons + blessing chips, and an authoritative inventory (click to equip, drag to reorder, drop)." },
      { title: "Wave audio system", body: "manifest-driven boss/mob/weapon/hazard/co-op sound." },
      { title: "Difficulty reset", body: "tougher Slime King, threat-budgeted floors, tighter heart economy, leveled blessings." },
      { title: "Online lobby", body: "with room-scoped worlds and player identity." },
      { body: "Game-juice polish (melee rework, particles/VFX everywhere), enemies route around barrels/props instead of getting stuck, safe loot ejection from chests, and a batch of playtest bug fixes." },
      { body: "Immutable release pipeline + control plane stood up for safe deploys." },
    ],
  },
  {
    version: "2026-07-07",
    date: "2026-07-07",
    entries: [
      { body: "More weapons (Boomstick, Longshot, Nailer — 12 total), status-effect VFX integration, and the combo widget/tier ramp." },
      { body: "Optional Google sign-in (guest play always preserved)." },
      { body: "Smooth remote-player interpolation (killed the co-op jitter) + distinct player colors." },
      { body: "Dev/creative sandbox page for testing." },
    ],
  },
  {
    version: "2026-07-06",
    date: "2026-07-06",
    entries: [
      { title: "BlobRogue is born", body: "co-op multiplayer (up to 4), enemy variety, a starting arsenal, minimap + stats HUD, and juicy animation." },
      { body: "Telegraphed enemy attacks (projectiles, Spitter, lunges, ghosts) and a 3-phase boss." },
      { body: "In-run item/blessing system — pick a blessing when you descend." },
      { body: "Flow-field pathfinding so enemies route around walls and actually hunt you." },
      { body: "Destructible props (crates/pots/barrels with explosive chains) + treasure chests." },
      { body: "+6 weapons (SMG, Hand Cannon, Burst, Ricochet, Homing, Tesla), item icons + build panel, real generated audio, and sprite-based bullet/death FX." },
    ],
  },
];

// The newest section's version key (a date, or "unreleased"). The __BUILD_VERSION__
// define resolves to this at build time; this export is the runtime/test fallback.
export const LATEST_VERSION: string = CHANGELOG[0]?.version ?? "unreleased";
