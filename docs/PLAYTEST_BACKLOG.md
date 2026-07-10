# BlobRogue — Playtest Backlog (Ian + friend, live QA)

Source of truth for all playtest feedback. Status: 🔴 todo · 🟡 in progress (specced/building) · 🟢 shipped live.
I iterate through this until done. Newest feedback appended; status kept current.

## SHIPPED LIVE (this session, v8→v15)
🟢 Menu polish, dash sync, invite links, weapon wave (7 effect guns), lighting/AO, hotbar cap+swap, weapon rarity (legendary+mystery), boss earned-window rework + party/gear scaling, premium coin economy + Mythic, co-op game-feel (remote audio sync, friendly-fire bonk, coin-to-wallet, no-card-on-1-9, world-anchored E prompt), player CHANGELOG.

## SHIPPED LIVE — 2026-07-10 deploy (v15)
🟢 #69 Combat/perf: boss WALL-PATHING fix, thumper/all FPS fixes + standing perf gate, effect-guns (snapwire/halo/crook) break barrels, sunlance range+fire-sound, coin-in-wall spawn clamp, corpse cap, flocker O(n²).
🟢 #70 UI: big centered hero blob, reorganized menu nav hierarchy, TABBED settings, design-system tokens (color/type/focus/keycap), in-game What's New panel.

## BUGS (investigating → fix batch)
🟡 Heart double-consume — "consume a heart even though I consumed a heart" (extra heart spent). [investigating]
🟡 Leaderboard stuck — DIAGNOSED: recordRun only fires on clean game-over (full wipe); death-while-teammates-continue / disconnect / quit never submit the deeper floor. FIX: persist deepest floor per-descend via a NEW Convex mutation (recordFloorProgress, Math.max fold) + client descend hook. Needs Convex deploy. [fix queued]
🟡 Name change doesn't work — profile rename shipped (#53) but Ian can't change username. [investigating]
🟡 Sentry (Prism Sentry) has no animation — static turret. [investigating]
🟡 Umbra (phase) sprite is broken/ugly. [investigating]
🟡 Drag & drop still buggy / imprecise — precision + drag-out-to-discard specced (UI designer), needs build.
🟡 Consuming hearts when already at/над full? (part of heart bug) [investigating]

## CONTENT — more of (Ian loves it)
🟡 MORE HATS / COSMETICS (asked 3×) — WAVE 1: AD gated (mixed). Applied all fixes: re-exported ALL 17 at 64×64 (systemic socket-frame fix), regen'd 6 concept-fails (halo/horns/headphones/crown/monocle/helmet) with isolated-object prompts. 10 ship-ready (mushroom = exemplar). Sent regens back for AD re-gate → then up/side via faledit + wire to closet + REMOVE the old procedural cosmeticArt.ts painters (the rectangle hats). [awaiting AD re-gate]
🟡 MORE BLESSINGS — Ian loves them, wants more variety (respect raw caps). [game designer speccing]
🟡 MORE BOSSES — repeats start at floor 35; want fresh bosses ramping toward floor ~100 (gradual). [creative director owns roadmap]
🟡 BIGGER BOSSES sometimes — periodic GIANT/spectacle multi-phase set-piece bosses. [roadmap]
🟡 CONTENT PREREQ GATES (must land BEFORE volume or repetition gets WORSE, per CD): (1) biome-selective encounter deck — floorRoster() is cumulative/global today, needs per-region decks; (2) 4-player telegraph/effect-density controller — none exists, giants+mutators+4P = unreadable soup without it. Critical path. [awaiting CD Wave 1 packet]
🟡 CONTENT WAVE 1 FOUNDATION BUILD LAUNCHED (bc-93842d19): encounter deck + 4P density controller + deterministic roll-order backbone (golden-master P1-4/reconnect/replay) + post-F30 palette stub. Content (bosses/guns/enemies/mutators) builds ON TOP after this lands.
🟡 CONTENT prereq detail: post-F30 palettes (Sump/Veinworks/Pale/Null Core) NOT in biomes.ts yet — AD authoring the 4 region floor/wall hex sets → I lock in biomes.ts (blocks JET contrast gate). Giants (F50/75/100) = STATIONARY front-facing only (CD call, no directional rig). Wave1 boss art order JET→Tithe→Quorum→Gorge (down/front first, AD gates at in-engine size over Sump floor, then orientations/phases/anim).
🟡 CONTENT ROADMAP to F100 (CD, design done): "THE UNMAKING" 4 regions (Sump F31-50 / Veinworks F51-70 / Pale F71-90 / Null Core F91-100). 14 new bosses every-5-floors + GIANT set-pieces F50/75/100 + seeded deep-boss AFFIXES so familiar bosses fight fresh (fixes repeat complaint). New gun VERBS (DEPLOY/MODESHIFT/GAMBLE...). Seeded randomness: floor mutators/elite affixes/random events/weekly seeds (the "craziness" dial, deterministic-safe). WAVE 1 = prereqs + Jet/Tithe/Quorum bosses + Gorge giant F50 + 3 guns + Sump enemies + mutators v1 + affixes v1. CD packaging tightened Wave 1 build packet. [awaiting packet → build]
🟡 MAJOR CONTENT PUSH ("a lot more", said many ways) — more guns (new verbs/families), more enemies for deep floors, more CRAZINESS/RANDOMNESS (floor modifiers/mutators/elite affixes/random events) so deep runs stay fresh. Phased in waves. [creative director + game designer roadmap]
🟡 Legendary gun TEXTURES redone (some "ass") — visual pass. [queued]
🟡 BULLET ART — "a lot of guns' bullets are still just circles." Make the bullet-visual pass COMPREHENSIVE (all guns, not just the flagged few). AD gave language for 8; extend to every flat one. [queued, expand scope]

## NEW SYSTEMS / FEATURES
🟡 XP + KIT/CLASS system with ULTIMATES — DESIGN COMPLETE (game designer). v1 = 4 kits: GUNNER (Overdrive burst), MENDER/healer (Sanctuary heal zone), BULWARK/tank (Aegis barrier), PHANTOM/mobility (Phase). Universal ult meter (server-owned, charges by damage+kills+time floor, 8s min between casts, HUD-shown separate from Resonance). XP = ACCOUNT MASTERY track (not a currency — gates ACCESS to kits/cosmetics, keeps Coins/Amber as only spendables). Kit-select pre-run in Amber Camp lobby, per-player (co-op comps emerge, no forced roles). In-run stays blessings (NOT adding a parallel in-run level). v2 deferred: Broodmother/Emberwright kits, per-kit mastery, optional NT-style in-run-XP→blessing-pick (Ian's call later). Big — phase into content build waves. [design done → build]
🟡 SEE HEALTH — actual HP numbers on HUD, not just hearts. [game designer rec]
🟡 INTERACT WITH PATCH (shopkeeper) — some interaction beyond buying. [todo → design]

## QUEUED (specced earlier, pre-this-dump)
🟡 Double-tap dash + rebindable dash key (R). [specced]
🟡 Shop: click-outside-to-close + clearer sold-out/heart-limit states. [specced]
🟡 Ground FX: frost zone ✅done, thumper scorch decal + frost render tweak. [queued in visual pass]
🟡 Music expansion (~29 tracks, pool+shuffle+combat crossfade) + AMBER HOME MOTIF: canonical melody authored w/ literal MIDI at /workspace/blobrogue_audio_manifest/amber_motif/ (amber_motif.mid). Build = generate EL bed then DAW/sample-layer the MIDI over it (clean celesta F100 / broken-detuned-inverted Jet); NEVER text-to-music the tune. Plant in menu+Amberwild during music pass so it's internalized before Jet. Giant signature separate; they meet only at F100. [audio spec in]
🟡 Run persistence — reconnect resumes the run instead of dropping it. [todo → design]
🟡 Hotbar full-swap flow redo (auto-swap equipped, E for slot pick). [specced]
🟡 Everything spawnable in DEV WORLD (standing checklist per feature).
