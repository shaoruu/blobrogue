# blobrogue — CANONICAL DESIGN INDEX / PRIORITY LOCK
Last consolidated after Stage A merged and Stage B green/integration.

## Hard execution priority
**Only authoritative multiplayer/server coding until Stage A→B→C production-green.** Freeze gameplay-feature implementation. Documents below may be prepared/reviewed; no post-server feature code routes early.

## Foundation / build-now
1. `blobrogue_STAGE_A_extraction_spec.md` — merged shared sim foundation.
2. `blobrogue_STAGE_B_spec.md` — authoritative WS POC/prediction/reconciliation; green/integration.
3. `blobrogue_AUTHORITATIVE_SERVER_spec.md` + `blobrogue_PRODUCTION_server_spec.md` — Stage C/end-to-end authoritative players/enemies/bullets/hits/loot, reconnect/adversity/load/wss/ops.
4. `blobrogue_BALANCE_RESET_spec.md` — current balance targets; co-op section applies only after authoritative shared combat.

## Canonical design prep (implementation frozen until Stage C)
- `blobrogue_PROGRESSION_spec.md` — progression curve, boss unlock graph, Amber/Camp, Lv1–3 blessings, floor objectives/cadence, Dealer economy, duplicate/melee discovery, mode resets.
- `blobrogue_WEAPONS_spec_2.md` — Wisp/Thunderbolt benchmarks, universal weapon room verbs, charge/infinite-reserve policy.
- `blobrogue_SCHOOLS_spec.md` — Resonance / The Hollow / Fracture / High Noon mechanics. Creative source: `blobrogue_CREATIVE_VISION.md`, `blobrogue_DARK_FAMILY_RETHESIS.md`.
- `blobrogue_MOB_MOVEMENT_spec.md` — movement grammar + Bat/Slime/Knellbat/Rattleback/Crookleg.
- `blobrogue_BOSS_ROSTER_spec.md` + names flavor — bosses; Arena reuse pointer.
- `blobrogue_POST_SERVER_WORLD_UX_spec.md` — no-menu Amber Camp, physical NPCs/mode gates/party staging, Arena floors, material/ecology/room depth.
- `blobrogue_POST_SERVER_LIGHTING_spec.md` — authoritative light context + client rendering, darkness pressure/readability, biome light grammar.
- `blobrogue_POST_SERVER_LOADOUT_UX_spec.md` — bottom-center 2-weapon/2-addon HUD + actual-stat pickup inspection.
- `blobrogue_DESTRUCTIBLE_PROPS_spec.md` — future toxic gas tank, shared explosive damage, melee projectile/front-armor/crowd utility.
- `blobrogue_PALETTE_biome_hue_lanes.md` — palette support only; real lighting/material/room specs supersede hue-only identity.

## Canonical locks (quick reference)
- Two modes: floor runs + open world, same authoritative core.
- Default launch post-server: walkable shared Amber Camp, no startup menu.
- Infinite weapon reserve; local weapon constraints, no universal ammo economy.
- Temporary Coins (Dealer) + persistent Amber only.
- Blessings Lv1–3 exact deltas; max3 then removed; new choices prioritized; Magnet meaningful.
- Persistent power 20–30% ceiling, temporary expressive 4–6×, sidegrade gear, horizontal boss unlocks.
- One universal Resonance meter; max four statuses (burn/chill/shock/Fracture).
- Difficulty via movement/composition/techniques/material ecology, not HP/hue alone.
- Server is sole truth; no gameplay system built client-authoritative while waiting.

## Supersession
Explicit `*.pre-coherence.md` files and old standalone notes are historical only. If conflict: this index → named canonical active spec → latest Balance Reset for numerical tuning. Progression §10+ overrides old item/chest/economy language.
