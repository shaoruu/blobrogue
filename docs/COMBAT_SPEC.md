# blobrogue combat / enemy-attack spec (game designer) — build-ready

Grounded in live constants: tile 48px, player 6HP/move200/dash620·0.16s·cd0.7s, on-hit i-frames 0.9s.

## Fairness budget (every attack obeys)
- Min wind-up 0.4s; tier-1 threats 0.5-0.7s. Dodgeable by WALKING (200px/s), not only dashing.
- Every committed attack has a stationary RECOVERY window (reward for dodging).
- Ranged attackers respect line-of-sight (isWall raycast exists). Wall = counterplay.
- Aim LOCKS partway through wind-up (never t=0 or t=end); lock→release gap = juke/skill window.

## SKELETON — Lunge (retrofit; keep 6HP/spd62/touch1)
CHASE→WINDUP→LUNGE→RECOVER→cd. Trigger dist≤200 & LOS & cd==0.
- WINDUP 0.55s: speed→0, coil squash, red-tint 0→1, aim line. Aim LOCKS @0.35s (last 0.20s untracked).
- LUNGE 0.28s: dash locked dir @520px/s (~145px), contact 1dmg + knockback, trail.
- RECOVER 0.5s: stationary dizzy = free-damage window. cd 2.0s from lunge start.

## SPITTER — NEW ranged caster (spawn floor 2+)
baseHp3(+0.5/fl), speed30, r15, touch1, draw~42. Kiter: dist<160 flee@30; >420 approach; 160-420 w/LOS attack.
- WINDUP 0.7s: mouth charge-glow + aim tracer. Aim LOCKS @0.45s.
- PROJECTILE: bullet struct friendly:false, speed300, r7, dmg1, life2.5s, color #ff5a7a. Respects walls (existing isWall→life=0).
- cd 1.8s. Floor4+: 3-glob spread (center ±0.18rad).

## GHOST — "solidify" tell (light retrofit; keep 4HP/spd56/phasing/alpha.62)
- dist≤120px → 0.4s ramp alpha .62→1.0 + shimmer. TOUCH DMG ONLY at full alpha. Translucent contact = nothing.
- Always damageable (don't gate bullets on alpha).

## BOSS Slime King — 3 HP-phases (42HP+7/fl, spd34, touch2, r34)
Transitions: 0.8s roar (inflate+flash, NOT invuln).
- P1 (100-66%) Hop-Slam: WINDUP 0.6s (crouch + growing shadow ring on target tile r→90, LOCKS @0.3s) → air 0.5s → LAND shockwave r90 dmg2 → RECOVER 0.7s. cd3.5s. +1 slime/3.4s.
- P2 (66-33%) + Radial Burst: WINDUP 0.8s → 8 globs ring speed260 dmg1 friendly:false; alternate bursts +22.5° offset. Hop-Slam cd→2.8s.
- P3 (33-0%) Frenzy: Hop-Slam cd→2.2s + landing emits 4 globs; 2 slimes/cycle; boss speed +20%.

## Shared impl notes
1. Enemy projectiles = bullet friendly:false. Player-hit loop: for b in bullets where !b.friendly: if invuln==0 && !isDown && hypot(px-b.x,py-b.y)<pr+b.radius → damage(b.damage); b.life=0. Clear non-friendly bullets on floor change + boss death.
2. DON'T reuse hit-flash for telegraphs (decays *7 ~0.14s, too short). Add per-enemy `windup` timer 0..1 → pulsing tint + aim line + AoE ground marker.
3. Aim-lock: store lockedAngle at lock fraction.
4. Gate WINDUP behind spawnTimer≤0.
5. Knockback (from juice pass) doubles as fairness spacing.

## BUILD ORDER: Spitter FIRST (validates enemy-projectile system the boss reuses), then skeleton lunge, ghost solidify, boss moveset.
Sequencing note: build AFTER the juice pass merges (both touch game.ts; enemy attacks reuse juice-pass knockback + shake/hit-stop on the new hits).
