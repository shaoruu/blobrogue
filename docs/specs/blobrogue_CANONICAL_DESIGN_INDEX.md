# blobrogue — CANONICAL DESIGN INDEX / PRIORITY LOCK
Last consolidated after Stage A merged and Stage B green/integration.

## Hard execution priority
**Authoritative multiplayer foundation is production-green, but a Sev-0 party coherence/reconnect patch is active.** Freeze curriculum/gameplay feature implementation until the runner closes that patch. Continue design/review only. Documents below may be prepared/reviewed; no post-server feature code routes early.

## Foundation / build-now
1. `blobrogue_STAGE_A_extraction_spec.md` — merged shared sim foundation.
2. `blobrogue_STAGE_B_spec.md` — authoritative WS POC/prediction/reconciliation; green/integration.
3. `blobrogue_AUTHORITATIVE_SERVER_spec.md` + `blobrogue_PRODUCTION_server_spec.md` — Stage C/end-to-end authoritative players/enemies/bullets/hits/loot, reconnect/adversity/load/wss/ops.
4. `blobrogue_BALANCE_RESET_spec.md` — current balance targets; co-op section applies only after authoritative shared combat.

## Canonical design prep (implementation frozen until Sev-0 party/reconnect patch closes)
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
- Server is sole truth; no gameplay system built client-authoritative.
- Three explicit difficulty modes remain: Casual / Standard / Brutal; composition/recovery only, same HP/damage/progression.
- Pets remain scheduled horizontal account unlocks under one-slot/one-utility/readability/network caps; cosmetic-first, combat utility acceptance-gated.
- Approved first-clear chain: Slime King F5 → Gauntlet F10 → Marrow F15 → Weaver F20 → Gilded Warden F25 → Hollow Choir F30. Jet later endgame.
- Authoritative normalized global boards remain approved after scoring/anti-cheat; recognition rewards only.

## Supersession
Explicit `*.pre-coherence.md` files and old standalone notes are historical only. If conflict: this index → named canonical active spec → latest Balance Reset for numerical tuning. Progression §10+ overrides old item/chest/economy language.
- `blobrogue_POST_SERVER_CONTROL_PLANE_spec.md` — post-Stage-C admin.create.town status/metrics/logs + allowlisted safe deploy/drain/restart/rollback control plane; no shell.
- `blobrogue_ENCOUNTER_CURRICULUM_spec.md` — post-server 30-floor/six-biome mob-family curriculum, encounter deck, rare/miniboss/boss cadence, difficulty/co-op/pet gates.
