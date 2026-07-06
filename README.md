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
- **Esc** — pause + settings (mute, screen-shake intensity)

Clear a floor of enemies, then step into the glowing exit to descend. See how deep you can get.

## Features
- **Feel & sound** — a lightweight **procedural WebAudio** engine (no audio files at all):
  per-weapon shots, enemy hits/deaths, pickups, dash, descend, boss, and game-over cues,
  plus a subtle looping dungeon score and a tenser boss variant. On top of that: **hit-stop**
  on kills, **trauma-based screen shake**, **death gibs + impact particles** (wall sparks vs
  enemy puffs), floor decals, a directional **muzzle flash**, and **shell casings**. Mute and
  shake-intensity live in the pause/menu settings (persisted). Tuning knobs sit at the top
  of `src/game/game.ts` (freeze/trauma/kick tables) and in `src/game/audio.ts` (synth voices).
- **Juicy, animated everything** — procedural squash-and-stretch, bob/hop, lean, shoot
  recoil, muzzle flash, hit flash, and death pops on every character and pickup (no extra
  art needed). Optional drop-in frame spritesheets are supported too — see [ART.md](ART.md).
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
