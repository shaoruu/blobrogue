# BlobRogue — Playtest Backlog (Ian + friend, live QA)

Source of truth for all playtest feedback. Status: 🔴 todo · 🟡 in progress (specced/building) · 🟢 shipped live.
I iterate through this until done. Newest feedback appended; status kept current.

## SHIPPED LIVE (this session, v8→v15)
🟢 Menu polish, dash sync, invite links, weapon wave (7 effect guns), lighting/AO, hotbar cap+swap, weapon rarity (legendary+mystery), boss earned-window rework + party/gear scaling, premium coin economy + Mythic, co-op game-feel (remote audio sync, friendly-fire bonk, coin-to-wallet, no-card-on-1-9, world-anchored E prompt), player CHANGELOG.

## BUILT & VERIFIED — awaiting deploy (Ian playing, deploy held)
🟡 #69 Combat/perf: boss WALL-PATHING fix, thumper/all FPS fixes + standing perf gate, effect-guns (snapwire/halo/crook) break barrels, sunlance range+fire-sound, coin-in-wall spawn clamp, corpse cap, flocker O(n²).
🟡 #70 UI: big centered hero blob, reorganized menu nav hierarchy, TABBED settings, design-system tokens (color/type/focus/keycap), in-game What's New panel.

## BUGS (investigating → fix batch)
🟡 Heart double-consume — "consume a heart even though I consumed a heart" (extra heart spent). [investigating]
🟡 Leaderboard stuck — reached floor ~36 but leaderboard shows 20; deepest floor not recorded past a point. [investigating]
🟡 Name change doesn't work — profile rename shipped (#53) but Ian can't change username. [investigating]
🟡 Sentry (Prism Sentry) has no animation — static turret. [investigating]
🟡 Umbra (phase) sprite is broken/ugly. [investigating]
🟡 Drag & drop still buggy / imprecise — precision + drag-out-to-discard specced (UI designer), needs build.
🟡 Consuming hearts when already at/над full? (part of heart bug) [investigating]

## CONTENT — more of (Ian loves it)
🟡 MORE HATS / COSMETICS (asked 3×) — art director speccing 8-12 hats + face items; I generate via pipeline. [specced]
🟡 MORE BLESSINGS — Ian loves them, wants more variety (respect raw caps). [game designer speccing]
🟡 MORE BOSSES — repeats start at floor 35; want fresh bosses ramping toward floor ~100 (gradual). Big content push, phase it. [todo → design]
🟡 Legendary gun TEXTURES redone (some "ass") — visual pass. [queued]
🟡 BULLET ART — "a lot of guns' bullets are still just circles." Make the bullet-visual pass COMPREHENSIVE (all guns, not just the flagged few). AD gave language for 8; extend to every flat one. [queued, expand scope]

## NEW SYSTEMS / FEATURES
🟡 XP + KIT/CLASS system with ULTIMATES (healer etc.) — pick a kit to start, charge + use an ult as that kit; co-op team comps. Big. [game designer speccing, phase v1]
🟡 SEE HEALTH — actual HP numbers on HUD, not just hearts. [game designer rec]
🟡 INTERACT WITH PATCH (shopkeeper) — some interaction beyond buying. [todo → design]

## QUEUED (specced earlier, pre-this-dump)
🟡 Double-tap dash + rebindable dash key (R). [specced]
🟡 Shop: click-outside-to-close + clearer sold-out/heart-limit states. [specced]
🟡 Ground FX: frost zone ✅done, thumper scorch decal + frost render tweak. [queued in visual pass]
🟡 Music expansion (~29 tracks, pool+shuffle+combat crossfade). [audio spec in]
🟡 Run persistence — reconnect resumes the run instead of dropping it. [todo → design]
🟡 Hotbar full-swap flow redo (auto-swap equipped, E for slot pick). [specced]
🟡 Everything spawnable in DEV WORLD (standing checklist per feature).
