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
      { body: "Combat + performance pass: bosses path around walls instead of beaching on cover; fixed frame-rate drops from Thumper/AoE weapons (with a standing perf guard so it can't regress); Snapwire / Razor Halo / Crooked Chain now break barrels & props; Sunlance range matches its beam and got a fire sound; coins can no longer drop inside walls." },
      { body: "Visual polish: real crystalline frost-zone art (no more flat green disc), redone weapon projectiles (Frostline shard + the legendaries), and a proper charred scorch mark from Thumper." },
      { body: "Hotbar overhaul: precise drag-to-reorder + drag-a-weapon-out-to-drop, cleaner full-hotbar swap." },
      { body: "Double-tap a direction to dash (+ rebindable dash key), shop click-outside-to-close & clearer sold-out states, more music variety, and run persistence on reconnect." },
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
