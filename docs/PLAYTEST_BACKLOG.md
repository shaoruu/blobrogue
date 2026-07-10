# BlobRogue — Playtest Backlog (Ian + friend, live QA)

Source of truth for all playtest feedback. Status: 🔴 todo · 🟡 in progress (specced/building) · 🟢 shipped live.
I iterate through this until done. Newest feedback appended; status kept current.

## SHIPPED LIVE (this session, v8→v15)
🟢 Menu polish, dash sync, invite links, weapon wave (7 effect guns), lighting/AO, hotbar cap+swap, weapon rarity (legendary+mystery), boss earned-window rework + party/gear scaling, premium coin economy + Mythic, co-op game-feel (remote audio sync, friendly-fire bonk, coin-to-wallet, no-card-on-1-9, world-anchored E prompt), player CHANGELOG.

## SHIPPED LIVE — 2026-07-10 deploy (v15)
🟢 #69 Combat/perf: boss WALL-PATHING fix, thumper/all FPS fixes + standing perf gate, effect-guns (snapwire/halo/crook) break barrels, sunlance range+fire-sound, coin-in-wall spawn clamp, corpse cap, flocker O(n²).
🟢 #70 UI: big centered hero blob, reorganized menu nav hierarchy, TABBED settings, design-system tokens (color/type/focus/keycap), in-game What's New panel.

## BUGS (investigating → fix batch)
🟢 Cosmetic equip 'COULDN'T SAVE — REVERTED' — FIXED. Root cause = CONVEX DEPLOY GAP: #72 added new cosmetic ids client-side but Convex backend wasn't deployed, so sanitizeEquip silently dropped new ids -> reconcile reverted. Affected ALL users equipping any new cosmetic (not just guests). Fixed by deploying convex to prod (rare-shrimp-114). Root-cause pipeline fix: convex-deploy-when-convex/-changes now in memory + evolve automation.
🟢 SHIPPED (#73) Heart — DIAGNOSED: heal-heart consume paths are provably atomic + test-covered (NOT the bug). Suspect = max-HP 'Heart Container' vs heal-'Heart' confusion: applyMaxHpBonus (world.ts:1084) applies the +4 cap BEFORE subtracting the artifact devil-deal hpTithe (:1539), so a capped player buying the artifact loses containers the cap already ate → reads as double-spend. FIX: subtract tithe from raw bonus before the positive clamp; add sequential pickup+shop+artifact test; confirm w/ Ian if he means heal-hearts or containers. Golden regen if applyMaxHpBonus changes. [fix queued]
🟢 SHIPPED (#73) Leaderboard — DIAGNOSED: recordRun only fires on clean game-over (full wipe); death-while-teammates-continue / disconnect / quit never submit the deeper floor. FIX: persist deepest floor per-descend via a NEW Convex mutation (recordFloorProgress, Math.max fold) + client descend hook. Needs Convex deploy. [fix queued]
🟡 Name change doesn't work — DIAGNOSED: GUEST rename path works + is test-covered. The failure = SIGNED-IN (Google) accounts: name field disabled (menu.ts:424) AND server overwrites with the Google account name (players.ts ensureAccountRow:181), so a signed-in rename reverts = 'doesn't work'. FIX: either allow an account displayName distinct from Google name (stop ensureAccountRow clobbering), or make the read-only UI copy explain why. Client+Convex only, no game-server deploy. [fix queued]
🟢 SHIPPED (#73) Sentry no animation — ROOT-CAUSED: game.ts:5641-5647 sprite branch draws a static image, no animClock/rotation/recoil (the pre-load fallback :5653 DOES animate, so it freezes once art loads). Sim has fireCd/targetEid/aim available. FIX: idle bob/pulse + barrel-toward-target (persist aim from sentryShot) + recoil off fireCd. CLIENT-ONLY render, no golden regen. [fix queued]
🟢 Umbra + all 5 legendary weapon sprites DONE (generated + de-tealed batch #77); was stale — originally — ROOT-CAUSED: public/sprites/weapon_umbra.png + held_umbra.png DON'T EXIST (refs assets.ts:329/369), so it falls back to the generic gun icon inside the legendary glow = looks broken. Also no drawBulletFx 'phase' case (plain circle bullet). FIX: generate the 2 sprites via fal pipeline (pure file drop, hooks wired) + optional phase bullet case. CLIENT-ONLY art, no golden regen. I OWN the art gen. Generating ALL 5 legendaries (umbra/reaper/hive/midas/lodestone all missing art) per AD briefs (LEGENDARY_WEAPON_ART_DIRECTION.md) — fixes 'legendary textures ass' too. [generating]
🟢 SHIPPED (#73) Drag precision + drag-to-discard (UI spec) — in the fix build.
🟡 Consuming hearts when already at/над full? (part of heart bug) [investigating]

## CONTENT — more of (Ian loves it)
🟢 MORE HATS/COSMETICS (3×) — SHIPPED LIVE (#72): 12 hats + 5 face items wired (assetKeys+rows), procedural painters DELETED, all resolve (no invisible). AD FINAL PLACEMENT GATE PASSED on live closet (top hat crowns head, specs on eye-line under hat, no invisible, padlocks correct). BATCH CLOSED. Body-color skins + more waves = future.
🟡 MORE BLESSINGS — Ian loves them, wants more variety (respect raw caps). [game designer speccing]
🟡 MORE BOSSES — repeats start at floor 35; want fresh bosses ramping toward floor ~100 (gradual). [creative director owns roadmap]
🟡 BIGGER BOSSES sometimes — periodic GIANT/spectacle multi-phase set-piece bosses. [roadmap]
🟡 CONTENT PREREQ GATES (must land BEFORE volume or repetition gets WORSE, per CD): (1) biome-selective encounter deck — floorRoster() is cumulative/global today, needs per-region decks; (2) 4-player telegraph/effect-density controller — none exists, giants+mutators+4P = unreadable soup without it. Critical path. [awaiting CD Wave 1 packet]
🟢 CONTENT WAVE 1 FOUNDATION SHIPPED LIVE (#71): deck+density+determinism (all gates tested, golden-mastered) + 4 deep-region palettes (readability passes to F98). Server deployed v15. Content builds ON TOP now. WAS: encounter deck + 4P density controller + deterministic roll-order backbone (golden-master P1-4/reconnect/replay) + post-F30 palette stub. Content (bosses/guns/enemies/mutators) builds ON TOP after this lands.
🟡 CONTENT prereq detail: post-F30 palettes AUTHORED by AD (canonical, in DEEP_REGION_PALETTES.png + env art bible) — forwarded to foundation build agent to commit into biomes.ts + run readability gate. JET Sump contrast CONFIRMED final (real Sump floorA #16131a = interim it was gated against). ✅ unblocked. Giants (F50/75/100) = STATIONARY front-facing only (CD call, no directional rig). Wave1 boss art order JET→Tithe→Quorum→Gorge (down/front first, AD gates at in-engine size over Sump floor, then orientations/phases/anim).
🟡 CONTENT ROADMAP to F100 (CD, design done): "THE UNMAKING" 4 regions (Sump F31-50 / Veinworks F51-70 / Pale F71-90 / Null Core F91-100). 14 new bosses every-5-floors + GIANT set-pieces F50/75/100 + seeded deep-boss AFFIXES so familiar bosses fight fresh (fixes repeat complaint). New gun VERBS (DEPLOY/MODESHIFT/GAMBLE...). Seeded randomness: floor mutators/elite affixes/random events/weekly seeds (the "craziness" dial, deterministic-safe). WAVE 1 = prereqs + Jet/Tithe/Quorum bosses + Gorge giant F50 + 3 guns + Sump enemies + mutators v1 + affixes v1. CD packaging tightened Wave 1 build packet. 🟢 SHIPPED (#76) — Wave 1 randomness layer: 6 floor mutators + 5 elite affixes + boss affixes, seeded/golden-mastered, wired from the live #71 backbone stubs.
🟡 MAJOR CONTENT PUSH ("a lot more", said many ways) — more guns (new verbs/families), more enemies for deep floors, more CRAZINESS/RANDOMNESS (floor modifiers/mutators/elite affixes/random events) so deep runs stay fresh. Phased in waves. [creative director + game designer roadmap]
🟢 Legendary TEXTURES + umbra — SHIPPED LIVE (#72): real art for all 5 (umbra/reaper/hive/midas/lodestone). Fixes 'umbra fked' + 'textures ass'.
🟡 BULLET ART — "a lot of guns' bullets are still just circles." Make the bullet-visual pass COMPREHENSIVE (all guns, not just the flagged few). AD gave language for 8; extend to every flat one. [queued, expand scope]

## NEW SYSTEMS / FEATURES
🟡 XP + KIT/CLASS system with ULTIMATES — DESIGN COMPLETE (game designer). v1 = 4 kits: GUNNER (Overdrive burst), MENDER/healer (Sanctuary heal zone), BULWARK/tank (Aegis barrier), PHANTOM/mobility (Phase). Universal ult meter (server-owned, charges by damage+kills+time floor, 8s min between casts, HUD-shown separate from Resonance). XP = ACCOUNT MASTERY track (not a currency — gates ACCESS to kits/cosmetics, keeps Coins/Amber as only spendables). Kit-select pre-run in Amber Camp lobby, per-player (co-op comps emerge, no forced roles). In-run stays blessings (NOT adding a parallel in-run level). v2 deferred: Broodmother/Emberwright kits, per-kit mastery, optional NT-style in-run-XP→blessing-pick (Ian's call later). Big — phase into content build waves. [spec requested from game designer → then build]
🟡 SEE HEALTH — actual HP numbers on HUD, not just hearts. [game designer rec]
🟡 INTERACT WITH PATCH (shopkeeper) — some interaction beyond buying. [todo → design]

## QUEUED (specced earlier, pre-this-dump)
🟢 SHIPPED (#73) Double-tap dash + rebindable dash key (R).
🟡 Shop: click-outside-to-close + clearer sold-out/heart-limit states. [specced]
🟡 Ground FX: frost zone ✅done, thumper scorch decal + frost render tweak. [queued in visual pass]
🟡 Music expansion (~29 tracks, pool+shuffle+combat crossfade) + AMBER HOME MOTIF: canonical melody authored w/ literal MIDI at /workspace/blobrogue_audio_manifest/amber_motif/ (amber_motif.mid). Build = generate EL bed then DAW/sample-layer the MIDI over it (clean celesta F100 / broken-detuned-inverted Jet); NEVER text-to-music the tune. Plant in menu+Amberwild during music pass so it's internalized before Jet. Giant signature separate; they meet only at F100. [audio spec in]
🟡 Run persistence — reconnect resumes the run instead of dropping it. [todo → design]
🟡 Hotbar full-swap flow redo (auto-swap equipped, E for slot pick). [specced]
🟡 Everything spawnable in DEV WORLD (standing checklist per feature).

- 🟢 SHIPPED (#80) — Wave 1 boss ENCOUNTERS: JET F35 (mirror), Tithe F40 (feeder+2-state slab), Quorum F45 (3-husk shared-HP+tether+merge). All 3 bosses' art AD-locked + on main (#74/#75/#78); randomness layer live (#76). This is the 'more bosses / repeats at 35' fix.

## Next Wave (captured 2026-07-10 — Wave 1 DONE, gated art→encounter→in-engine)
- 🔴 GORGE F50 encounter: needs peeled-shell DEBRIS chunks (drop stripped layer as cover entities) + full encounter wiring (multi-phase shell-peel, per-phase HP on exposed-time ~1.4-1.6x via phase count). Art done (#79, giant reference).
- 🔴 F75 PALE THRONE + F100 UNMAKER: inherit the LOCKED Gorge giant grammar (same silhouette/peel/reveal, derive from Gorge shape). Pale = cold/warmth-drain material, Null = void/subtraction. Don't re-invent the silhouette (see docs/art_manifests/GORGE_F50_GIANT.md).
- 🔴 Flower cosmetic re-gen someday (source amber-drifted vs greener/multi-color brief — needs re-gen not re-snap).
- 🔴 choir.png 6% teal — minor cleanup (re-snap on choir_cyan/bone lane when convenient).
- 🔴 Sump deep-mob enemies (Wave 1 packet called for 2-3 corrupted variants — not yet built).
