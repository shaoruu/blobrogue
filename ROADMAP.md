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

## Next up (rough priority)
1. **Server-authoritative enemies in co-op** — currently enemies are simulated per-client from the shared seed (identical at spawn, diverge on interaction). Make the host authoritative and sync enemy state so teammates fight the *same* mobs. (Seam is ready via `CoopBridge`.)
2. Sound & music — shooting, hits, death, ambient dungeon loop (WebAudio).
3. Better dungeon generation — distinct room types, treasure rooms, locked doors.
4. Juice & polish — screen shake, hit-stop, damage numbers, muzzle flash, death anims.
5. More weapons + character/unlock meta (the `players.unlocks` field is already there).
6. Mobile / touch controls (virtual sticks) so it's playable on phones.
7. Meta: score/leaderboard (Convex), harden accounts (swap to Convex Auth if needed).

## Notes
- Keep it fun first. One shipped, verified improvement per evolution run.
- Never leave the repo un-building or undeployed.
- Solo must always work with zero Convex config — never let a missing `VITE_CONVEX_URL` break the deployed game.
