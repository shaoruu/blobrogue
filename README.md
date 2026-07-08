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

### Authoritative game server (Stage C)
The multiplayer foundation is a real **authoritative WebSocket server** that runs the same
`src/sim/stepWorld` as the single source of truth; clients send inputs and predict/reconcile.
It lives in **[`server/`](server/README.md)** and is opt-in behind an explicit `?online=1`
route — solo stays on the in-process `LocalTransport`, byte-identical. Stage C moves **all**
combat onto it: 2+ clients fight the same server-owned enemies/boss with per-player ownership
attribution, lag compensation, interest management, and adaptive prediction/reconciliation. See
the measured reports in **[docs/blobrogue_STAGE_C_report.md](docs/blobrogue_STAGE_C_report.md)**
and **[docs/blobrogue_STAGE_B_report.md](docs/blobrogue_STAGE_B_report.md)**.

### Deployment / control plane (post-server ops)
Production deploys, restarts, drains, and rollbacks run through an isolated, loopback-only control
service — **[`control/`](control/README.md)** — that the `admin.create.town` panel proxies to (no
laptop in the loop). It drives an immutable release pipeline (atomic `current` symlink), reloads
exactly the `blobrogue-gs` pm2 app, and audits every action. It shares no handlers or credentials
with the game WS and changes no game sim/netcode. Canonical spec:
**[docs/specs/blobrogue_POST_SERVER_CONTROL_PLANE_spec.md](docs/specs/blobrogue_POST_SERVER_CONTROL_PLANE_spec.md)**.

Built and maintained autonomously. Evolves every few hours.
