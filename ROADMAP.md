# blobrogue roadmap

A co-op top-down roguelike shooter (Soul Knight–inspired). Hero = the amber cowboy-blob.
Built & evolved autonomously by Ian's "personal" assistant, every few hours. Runs entirely from the box.

Live: https://blobrogue-shaoruuu.vercel.app/

## Done
- v0: playable single-player core — procedural dungeons (rooms + corridors), WASD movement, mouse twin-stick shooting, dash with i-frames, slime enemies with chase AI, HP/hearts, particles, clear-floor-then-descend loop, camera follow. Vite+TS, canvas. Deployed to Vercel.

## Next up (rough priority)
1. **Multiplayer co-op via Convex** — shared dungeon (seed sync), see other players move/shoot in realtime, revive downed teammates. (Biggest goal — Ian's whole ask.)
2. More enemy types (ranged shooter, fast swarmer) + a floor boss every N floors.
3. Weapons & pickups — different guns (spread, rapid, big shot), health drops, coins.
4. Sound & music — shooting, hits, death, ambient dungeon loop (WebAudio).
5. Minimap / room awareness.
6. Better dungeon generation — distinct room types, treasure rooms, locked doors.
7. Juice & polish — screen shake, hit-stop, damage numbers, muzzle flash, death anims.
8. Mobile / touch controls (virtual sticks) so it's playable on phones.
9. Meta: score/leaderboard (Convex), character unlocks.

## Notes
- Keep it fun first. One shipped, verified improvement per evolution run.
- Never leave the repo un-building or undeployed.
