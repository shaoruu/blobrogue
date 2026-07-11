// GENERATED FILE — do not edit by hand.
// Produced from CHANGELOG.md by tools/genChangelog.mjs (wired into the build via
// vite.config.ts). Edit the changelog, not this file.

export interface ChangelogEntry {
  title?: string;
  body: string;
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
      { title: "Three new companions to rescue", body: "a grey cat, a baby amber dragon, and a baby slime join the doggie at the Kennel — rescue each from a deeper floor (the slime waits in the deepest dark), then pick which one rides along at your side (one companion at a time)." },
      { title: "More guns, more traits", body: "8 new weapons — Cleaver (a slow saw disc that shreds a whole line), Scrapper (twin-pellet spray hose), Skipper (buckshot that banks off walls), Arcbolt (short-range shocker that arcs across a pack), Cryobolt (freezes a body solid), Firebomb (a lob that leaves the blast ablaze), Tracker (one heavy seeker that never misses), and the legendary Singularity (collapses the pack onto one point, then a nova detonates on the clump). Plus 10 new blessings — Marksman, Juggernaut, Heavy Rounds, Skirmisher, Executioner, Overload, Featherweight, Frostbite, Quickdraw, and Vanguard — each a distinct build with a real tradeoff." },
      { body: "Content push: more bosses ramping toward floor 100 (with giant spectacle set-pieces + anti-repeat affixes), new gun verbs, deeper-floor enemies, and seeded floor mutators/elite affixes for run variety." },
      { body: "Kits/classes + XP: pick a class (Gunner/Mender/Bulwark/Phantom) with a signature ultimate; account XP unlocks kits & cosmetics." },
      { body: "More cosmetics (a fresh wave of real generated hats + face items, replacing the old placeholder ones), more blessings, HP numbers on the HUD, and interact-with-Patch." },
      { body: "Bug fixes in flight: heart double-consume, leaderboard deepest-floor not recording past a point, name change, sentry animation, Umbra art, drag-and-drop precision." },
      { body: "Double-tap dash + rebindable dash key, shop click-outside-to-close, remaining visual polish (bullet art, thumper scorch), music variety, run persistence on reconnect." },
    ],
  },
  {
    version: "2026-07-11",
    date: "2026-07-11",
    entries: [
      { title: "New guns sound the part", body: "the 8 new weapons each got a distinct fire sound (saw-disc whirr, arc zap, cryo crackle, the void cannon's gravity whoomp, and more)." },
      { title: "Chunkier, better-spaced Camp Doggie", body: "the pup is now pixelated to match the game's art scale (it was rendering too high-def/smooth next to everything else), and it sits a bit further back so it hangs out beside you instead of on top of you." },
      { title: "Main menu fits on one screen", body: "the home screen no longer scrolls — Play, Camp, the leaderboard glance, and every destination are visible at once on any window size (the blob stays the centerpiece). Short laptops now compact the hero band instead of pushing Play off-screen." },
    ],
  },
  {
    version: "2026-07-10",
    date: "2026-07-10",
    entries: [
      { title: "🐕 Meet your Camp Doggie + the Amber loop", body: "A stray pup you rescue from the depths now trots at your side — sits when you're still, follows you into every run. It's the first of a growing pack. Plus Amber is now a currency you KEEP between runs (earned from floors, depth, and first boss kills), spent at the new Amber Camp on companions and upgrades. More camp coming soon." },
      { title: "Cosmetic edge cleanup", body: "removed stray colored specks that could appear at the edges of the blob when wearing hats/glasses (leftover pixels in the transparent areas of the art)." },
      { title: "Kits/classes + ultimates + XP", body: "pick a class in the Amber Camp lobby — GUNNER (Overdrive: burst fire), MENDER (Sanctuary: healing zone), BULWARK (Aegis: projectile-blocking dome), PHANTOM (Phase: team invuln + speed). Each has a signature ULTIMATE on a server-charged meter (fills from damage/kills/time). Plus an account MASTERY track that unlocks kits as you play, and **HP numbers on the HUD** (not just hearts). Co-op: comps emerge, no forced roles." },
      { title: "Cosmetic hats fixed + head redesign", body: "hats no longer double-stack on the baked-in cowboy hat — the blob now has a proper bare rounded head, and any hat you equip sits cleanly on top (cowboy hat is now its own equippable). Fixed hats covering the eyes and the head bulging out around narrow hats; all 7 hats (cowboy/top/wizard/chef/beanie/crown/helmet) now sit right." },
      { title: "Three new deep bosses (F35/F40/F45)", body: "JET — a corrupted mirror of your squad that turns your own weapon archetypes against you (survive its phases and it burns out, exposed). THE TITHE — an armored feeder that re-armors behind a feeding slab; smash the slab to open its window. QUORUM — three linked husks on one shared HP pool with load-bearing roles (kill order matters), that fuse into a merge-form if you're too slow. All earned-window fights (real tells, dodge-able, no HP sponges), co-op-scaled, and they honor the new floor mutators/affixes so repeats stay fresh." },
      { title: "Deep runs stay fresh (F31+)", body: "floors past 30 now roll seeded **mutators** (Dense Dark, Molten Floor, Twinned Elites, Fracture Storm, Amberfall, Thin Air — up to 2 per floor, shown on the HUD), elites can spawn with **affixes** (splits / shielded / hazard-trail / reflect / enrage), and deep bosses can carry an extra telegraphed **affix** pattern so a repeat boss fights differently. All deterministic + co-op-synced, with a 4-player readability budget so it never becomes unreadable soup." },
      { title: "Fixes + controls", body: "leaderboard now banks your deepest floor as you descend (no more losing depth to a disconnect); precise hotbar drag-to-reorder + drag a weapon out to drop it; double-tap a direction to dash (toggle in settings) and a rebindable dash key; the Prism Sentry animates now; and a max-HP/artifact accounting fix." },
      { title: "Deep-game foundations (floors 31-50 groundwork)", body: "per-region enemy decks so deeper floors stop repeating the same roster, a 4-player effect-density system so busy fights stay readable, a deterministic randomness backbone for upcoming floor mutators/affixes, and four new deep-region palettes (Sump/Veinworks/Pale/Null Core)." },
      { title: "New cosmetics + legendary art", body: "a fresh wave of real hats (top, crown, party, halo, wizard, beanie, helmet, chef, flower, mushroom, horns, headphones) and face items (sunglasses, monocle, eyepatch, star shades, 3D glasses) — replacing the old placeholder shapes — plus proper art for all 5 legendary guns (Umbra, Reaper, Hive, Midas, Lodestone)." },
      { title: "Combat correctness + performance", body: "bosses now path around walls & cover instead of beaching on them (no more cheesing from behind a wall); fixed frame-rate drops from Thumper and other AoE weapons, with a standing performance guard so it can't regress; Snapwire / Razor Halo / Crooked Chain now break barrels & props; Sunlance's range matches its beam and it has a fire sound; coins can no longer drop inside walls." },
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
      { title: "The Effect Wave — 7 new weapons", body: "Frostline (chill zones), Snapwire (tripwires), Razor Halo (orbiting blades), Prism Sentry (deployable turret), Breach (charge-up blast), Lastlight, and Crooked Chain — built on new shared effect systems." },
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
