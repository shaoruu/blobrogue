# blobrogue

A cozy little top-down roguelike shooter you play in the browser. You're an amber
cowboy-blob blasting through procedurally generated depths — solo, or in real-time co-op
with friends. Inspired by Soul Knight.

**Play:** (deploying…)

## Controls
- **WASD / Arrows** — move
- **Mouse** — aim
- **Click / hold** — shoot
- **Shift** — dash (brief i-frames)
- **Tab (hold)** — run + all-time stats

Clear a floor of enemies, then step into the glowing exit to descend. See how deep you can get.

## Features
- **Enemy variety** — slimes (chase), bats (fast zigzag), skeletons (tanky), ghosts (drift
  through walls), and a **slime-king boss every 5th floor** that spawns minions.
- **Weapons & pickups** — pistol, shotgun (spread), and rapid-fire; hearts heal, coins are
  currency, and gun pickups swap your weapon. Weapon shown in the HUD.
- **Minimap + stats HUD** — top-right minimap (rooms, exit, enemies, teammates), a clean
  hearts/floor/kills/coins/weapon bar, and a hold-Tab run-stats panel.
- **Co-op multiplayer via Convex** — host a game, share a 4-letter code, and descend the
  same dungeon together in real time. Accounts + saved stats persist across sessions.

## Stack
- Vite + TypeScript, HTML5 canvas rendering (no engine)
- Real-time multiplayer, accounts, and saved stats via [Convex](https://convex.dev)
- Deployed on Vercel

## Multiplayer / deployment
Co-op, logins, and saved data are powered by Convex and are **opt-in** via a single env
var (`VITE_CONVEX_URL`). With it unset, the game runs exactly like solo v0 — nothing
breaks. Full provisioning steps, the exact commands, and the architecture are in
**[MULTIPLAYER.md](MULTIPLAYER.md)**.

Built and maintained autonomously. Evolves every few hours.
