# BlobRogue — Changelog

A running log of what's new in BlobRogue, our co-op top-down roguelike shooter.
Newest changes first. (Times are Pacific.)

---

## Unreleased (in progress)
- Content push: more bosses ramping toward floor 100 (with giant spectacle set-pieces + anti-repeat affixes), new gun verbs, deeper-floor enemies, and seeded floor mutators/elite affixes for run variety.
- Kits/classes + XP: pick a class (Gunner/Mender/Bulwark/Phantom) with a signature ultimate; account XP unlocks kits & cosmetics.
- More cosmetics (a fresh wave of real generated hats + face items, replacing the old placeholder ones), more blessings, HP numbers on the HUD, and interact-with-Patch.
- Bug fixes in flight: heart double-consume, leaderboard deepest-floor not recording past a point, name change, sentry animation, Umbra art, drag-and-drop precision.
- Double-tap dash + rebindable dash key, shop click-outside-to-close, remaining visual polish (bullet art, thumper scorch), music variety, run persistence on reconnect.

## 2026-07-10
- **Combat correctness + performance:** bosses now path around walls & cover instead of beaching on them (no more cheesing from behind a wall); fixed frame-rate drops from Thumper and other AoE weapons, with a standing performance guard so it can't regress; Snapwire / Razor Halo / Crooked Chain now break barrels & props; Sunlance's range matches its beam and it has a fire sound; coins can no longer drop inside walls.
- **UI overhaul:** your blob is now a big centerpiece on the main menu; the menu buttons are reorganized with clear hierarchy; Settings is now tabbed (Audio / Gameplay / Video / Accessibility) instead of one long list; a game-wide consistency pass (unified colors, text sizes, focus outlines, keycaps, panels); and a new in-game **What's New** panel so you can read the changelog right in the game.

## 2026-07-09
- **Co-op game-feel pass:** you now HEAR teammates' guns, hits, and pickups (positional audio); friendly fire is a harmless playful "bonk" (a little shove + squash, zero damage); coins fly into your wallet on pickup; the weapon stat card no longer pops when you tap 1–9; the "E to trade" prompt now floats by your character instead of the screen corner; and a batch of previously-silent events got sound.
- **Premium coin economy:** shops get richer and pricier the deeper you go — a boss-reward vendor, a guaranteed pre-final-boss vendor, legendary/mystery weapons, heart containers, rare blessings, rerolls, and a big-ticket **Mythic** "spend everything" capstone on floors 20/25/30. Leftover coins trickle a little Amber; coins never buy permanent power.
- **Boss rework — earned windows + fair surprise:** bosses (Weaver first) are guarded by default and open real damage windows you create (break anchor knots, clear egg-sacs, bait charges), with unpredictable-but-always-telegraphed attacks, plus party- and gear-aware scaling so a strong 4-player squad gets a tougher fight instead of a bullet sponge.
- **Weapon rarity system:** rarity tiers, five legendary "gimmick" guns with unique mechanics, and mystery "???" drops you identify by grabbing them.
- **The Effect Wave — 7 new weapons:** Frostline (chill zones), Snapwire (tripwires), Razor Halo (orbiting blades), Prism Sentry (deployable turret), Breach (charge-up blast), Lastlight, and Crooked Chain — built on new shared effect systems.
- **Ambient occlusion + authored lighting** for real depth and mood (with a high-contrast accessibility toggle).
- **Hotbar cap + swap-or-drop:** the hotbar is capped so slots stay mapped to 1–9; grabbing a weapon when full gives you a swap prompt.
- **Remote dash sync:** you can see teammates' dashes (blink + afterimage + dust).
- **Shareable room invite links** (`/r/CODE`) — friends click and drop straight into your lobby, guests included.
- **Menu & identity redesign:** play-first title screen with your live blob, global leaderboard, profiles, a cosmetics closet (hats/glasses), in-profile rename, and a global pixel scrollbar.
- **Bestiary expansion:** a two-wave enemy ecology with behavior-based elites and minibosses.
- **The boss roster:** 5 bosses, 4 new enemies, 2 new weapons — the big content drop.
- **Depth-progression world:** six biome bands with distinct room types, seeded floor hazards, and reactive ambience.
- **Authoritative co-op:** revive downed teammates, spectate, shared blessing gate, party economy, and room replay.
- **Patch's Waystation:** an in-run Dealer shop room.
- **Audio settings:** master / music / SFX volume sliders.
- Fixes & polish: props no longer jitter against the player, the boss health bar shows the boss's name, calmer default screen shake, teammate colors + names sync correctly (with a one-time name prompt), early-game weapon variety (no more same guns every run), full de-synthesized authored audio, enemy durability tiers, and readability fixes.

## 2026-07-08
- **Multiplayer hardened:** one authoritative server path, verified room readiness, and reconnect grace/resume so a flaky connection never locks you out.
- **Minecraft-style hotbar** for weapons + blessing chips, and an authoritative inventory (click to equip, drag to reorder, drop).
- **Wave audio system:** manifest-driven boss/mob/weapon/hazard/co-op sound.
- **Difficulty reset:** tougher Slime King, threat-budgeted floors, tighter heart economy, leveled blessings.
- **Online lobby** with room-scoped worlds and player identity.
- Game-juice polish (melee rework, particles/VFX everywhere), enemies route around barrels/props instead of getting stuck, safe loot ejection from chests, and a batch of playtest bug fixes.
- Immutable release pipeline + control plane stood up for safe deploys.

## 2026-07-07
- More weapons (Boomstick, Longshot, Nailer — 12 total), status-effect VFX integration, and the combo widget/tier ramp.
- Optional Google sign-in (guest play always preserved).
- Smooth remote-player interpolation (killed the co-op jitter) + distinct player colors.
- Dev/creative sandbox page for testing.

## 2026-07-06 — First playable
- **BlobRogue is born:** co-op multiplayer (up to 4), enemy variety, a starting arsenal, minimap + stats HUD, and juicy animation.
- Telegraphed enemy attacks (projectiles, Spitter, lunges, ghosts) and a 3-phase boss.
- In-run item/blessing system — pick a blessing when you descend.
- Flow-field pathfinding so enemies route around walls and actually hunt you.
- Destructible props (crates/pots/barrels with explosive chains) + treasure chests.
- +6 weapons (SMG, Hand Cannon, Burst, Ricochet, Homing, Tesla), item icons + build panel, real generated audio, and sprite-based bullet/death FX.
