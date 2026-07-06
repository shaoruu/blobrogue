# blobrogue roadmap

A co-op top-down roguelike shooter (Soul Knight–inspired). Hero = the amber cowboy-blob.
Built & evolved autonomously by Ian's "personal" assistant, every few hours. Runs entirely from the box.

Live: https://blobrogue-shaoruuu.vercel.app/

## Done
- v0: playable single-player core — procedural dungeons (rooms + corridors), WASD movement, mouse twin-stick shooting, dash with i-frames, slime enemies with chase AI, HP/hearts, particles, clear-floor-then-descend loop, camera follow. Vite+TS, canvas. Deployed to Vercel.
- **Multiplayer co-op via Convex** — host/join with a 4-letter code, shared dungeon via seed+floor sync, see teammates move & shoot in real time, descend together, down-but-not-out + revive. Client uses the vanilla `ConvexClient`. Solo still works with zero Convex config (graceful degrade). See `MULTIPLAYER.md`.
- **Accounts + saved data** — lightweight persistent identity (localStorage clientId + name → Convex `players`), all-time stats (deepest floor, kills, coins, runs) that persist across sessions and show on the title + stats screens.
- **Enemy variety + boss** — bats (fast, erratic), skeletons (tanky melee), ghosts (phase through walls, semi-transparent), and a slime-king boss every 5th floor (2× size, contact damage, spawns minions, gates the exit). Deterministic seeded spawns; gentler early floors.
- **Weapons & pickups** — pistol / shotgun / rapid with distinct feel, gun pickups that swap your weapon, heart (heal) + coin (currency) drops. Current weapon in the HUD.
- **Minimap + stats HUD** — top-right minimap (rooms/corridors, player, exit, enemy & teammate dots), a clean hearts/floor/kills/coins/weapon bar, and a hold-Tab run/all-time stats panel. Dark-navy + amber aesthetic, layout-shift-free.
- **Juice / procedural animation** — every character and pickup is animated: idle bob + squash-and-stretch, moving hop + lean, shoot recoil + muzzle flash, hit flash, death pop/squash/fade, spinning coins, boss breathing + spawn telegraph. Plus optional drop-in frame spritesheets (horizontal strips) with procedural fallback. See `ART.md`.

## Next up (rough priority)
1. **Server-authoritative enemies in co-op** — currently enemies are simulated per-client from the shared seed (identical at spawn, diverge on interaction). Make the host authoritative and sync enemy state so teammates fight the *same* mobs. (Seam is ready via `CoopBridge`.)
2. Sound & music — shooting, hits, death, ambient dungeon loop (WebAudio).
3. Better dungeon generation — distinct room types, treasure rooms, locked doors.
4. More juice — screen shake, hit-stop, damage numbers (procedural anim + muzzle flash + death anims now done).
5. Real frame animation — drop fal-generated `*_walk.png` / `*_idle.png` strips into `public/sprites` and register them (see `ART.md`).
6. More weapons + character/unlock meta (the `players.unlocks` field is already there).
7. Mobile / touch controls (virtual sticks) so it's playable on phones.
8. Meta: score/leaderboard (Convex), harden accounts (swap to Convex Auth if needed).

## Notes
- Keep it fun first. One shipped, verified improvement per evolution run.
- Never leave the repo un-building or undeployed.
- Solo must always work with zero Convex config — never let a missing `VITE_CONVEX_URL` break the deployed game.

## Studio direction (game designer playtest, code-level)
- **Depth gap found:** combat is 100% contact-damage, ZERO enemy projectiles. Fix = telegraphed enemy attacks + real boss moveset (priority #2, after juice). This creates the dodge "dance".
- **Folded into juice pass:** enemy knockback on hit, hurt vignette, instant-restart (Enter/R), dash afterimage + i-frames 0.2→0.35s.
- **Do NOT:** nerf enemies (balance is fine), touch twin-stick controls (tight). On red assets base≥dark.
- **Monetization:** premium Steam $9.99-12.99; web = free demo/viral funnel; do a Steam "Coming Soon" page early for wishlists; no ads/gacha.
- Ranked: 1) juice (in flight, expanded) 2) enemy attacks+telegraphs (promoted) 3) in-run item synergies + meta unlocks, then co-op revive/scaling (scaffolding exists).

## Open-world / "not just stages" direction (game designer call, DECIDED)
Verdict: YES to the feeling, NO to a pivot. Deliver Minecraft/Terraria's sense of PLACE + persistence WITHOUT terrain-building (that's a multi-year, wrong-engine trap; Convex is wrong for per-tile sync; sandbox dilutes the combat).
- Keep the queue EXACTLY: juice → combat → items/meta. Unchanged.
- Then TIER 0 (the "open world feeling" for ~20% work, reuses Amber meta):
  1. Blob Camp becomes a walkable HUB/town you spawn into & return to (Hades House vibe).
  2. Contiguous BIOMES (forest→caves→depths, seamless) replace "FLOOR N" title cards — reskin of existing floor loop.
  3. Hub visibly GROWS as you spend Amber (forge/range/armory/NPCs appear) = base-building dopamine w/o terrain editing.
- Guardrail: hub is OPT-IN texture; Quick Play stays one-click-to-combat. Protect the "one more run" loop.
- TIER 2 (v2 north star, only if v1 lands): traversable overworld + light gatherable resources → base upgrades.
- TIER 3 (never/sequel): full destructible terrain + freeform + persistent shared world. Not blobrogue.
Ordering: Tier-0 hub spec comes AFTER items/meta ship (needs Amber to exist). GD writes it build-ready then.

## Systems-depth vision (game designer, DECIDED) — "persistent base, ephemeral expeditions"
One game shape: top-down survival-crafting-combat where our roguelike combat IS the expedition layer. Craft/gear at a persistent growing HOME BASE (Convex doc state, co-op shared) → launch instanced procedural EXPEDITIONS (the combat) → beat biome boss → unlock next tier + resources → craft better → deeper. Comps: Core Keeper, Valheim, Deep Rock.
KEY ARCHITECTURE: persist the BASE not the WORLD (Convex's strength; avoids per-tile terrain sync). Expeditions instanced/ephemeral; Quick Play still works.
Two item layers: persistent EQUIPMENT (craft/keep/bring in) vs in-run ITEMS (ephemeral build variety, lost on death) — resolves the roguelike-vs-survival tension, no rework to items spec.
QUEUE UNCHANGED: juice → combat → items/meta (all substrate the systems extend; loadouts = persistent mods, hub = Amber rendered physical).
v1 (deep+open feeling, ~20% effort, all reskins/extensions): 1) tiered biome progression (boss gates tier) 2) contiguous biomes replace floor cards 3) persistent growing hub (Amber→buildings/NPCs) 4) multi-slot equipment loadouts.
v2 (after v1 ships): gathering + SHALLOW crafting (hub stations functional) · persistent shared co-op base · base-defense wave mode (reuses combat).
v3 (if metrics justify): constrained base building (NOT freeform voxel) · day/night+hazards · deeper crafting/biomes.
HARD CUTS (refuse — the multi-year traps): freeform destructible terrain (never), persistent shared overworld (use base+instanced instead), hunger/thirst/temp meters (tedium), Minecraft-scale crafting trees (keep shallow).
DISCIPLINE: every phase independently shippable+fun; ship v1 to players BEFORE layering systems.
RELEASE MODEL PIVOT: Early Access + public roadmap (fits systems-deep games grown in public — Valheim/Core Keeper/Terraria did exactly this; turns "not fully built" into the pitch; strong wishlist+retention driver). Web demo + instant co-op = top of funnel.
