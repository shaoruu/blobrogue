# blobrogue — POST-SERVER WORLD UX + ARENA FLOORS (design-prep contract)
**Priority gate:** DESIGN ONLY until authoritative multiplayer Stage A→B→C is complete and production-green. Do not build this on client-local state or static menu UI. Every interaction below lives in the authoritative `World`/`stepWorld` model and uses the production transport/persistence foundation.

## 1. No menu on launch: AMBER CAMP is the lobby
After authentication/loading, the player spawns directly into a shared, walkable Amber Camp world instance. There is no mode-selection/title menu between login and movement.

### Camp authority / persistence
- Camp is a `World { mode:"camp" }` on the authoritative server, with server-owned player movement/collision/interactions, persistent station/character unlock state loaded from Convex, and snapshot interpolation like every other world.
- Solo uses the same Camp through LocalTransport; multiplayer uses the shared server instance. No separate UI-only simulation.
- Account/private Camp by default; invited/public social Camp is a later world-directory policy, not a different gameplay implementation.

### Amber Heart centerpiece
- Physical center and spawn landmark. Its authored state reads account/world progression: dormant → flicker → steady beat → radiant/mature. Growth is visual/functional, not another meter.
- Interact opens only concise progression details; most state is visible in-world (light, buildings, NPCs, displayed weapons/characters).
- Party rally radius around the Heart is social only; it does not create a party by itself.

### Collected/unlocked characters live physically
- Each unlocked character appears as an authored NPC/inhabitant with a distinct Camp location and silhouette.
- Walk up + interact to inspect/swap character. No roster menu. Locked characters may be hinted through empty authored spaces or diegetic clues, not grey portrait grids.
- Character state/loadout changes are server-validated persistent mutations.

### Walk-up stations (NPCs, not menu tabs)
- **Healer:** restore/test sustain rules; clearly shows cost before confirm.
- **Armorer:** gear/trinket loadout, sidegrade inspection, Foundation node equip (bounded caps from Progression spec).
- **Dealer:** run stock preview / discovered arsenal display; temporary-run coins are not spendable in Camp.
- **Training:** targets, DPS/status/readability practice, movement tutorial, weapon testing.
- **Archive/contract NPC (later):** boss mastery/fusion/challenges.
Interaction contract: enter proximity → authored prompt → one compact panel; leaving range closes it. No full-screen navigation shell.

## 2. Physical mode gates + party formation
Two permanent landmarks in Camp:
- **DESCENT GATE:** floor-run mode.
- **WILDS GATE:** open-world mode.
Both use world-specific materials/silhouettes, not generic portals. Gate label and current objective/destination are readable before entry.

### Party formation by entering together
- A gate has an authoritative staging volume and short departure countdown (e.g. 5s) that starts when first player confirms/stands ready.
- Players inside at departure form the party and enter the same destination World instance. Players outside remain in Camp. Anyone may step out to cancel their own readiness; countdown only fully cancels if staging becomes empty.
- UI: world-space ready markers/names + `2 READY · DEPARTING IN 4`; no room code/menu required for normal flow.
- Late join: friend enters Camp, then joins the appropriate gate; floor-run late join policy is between floors/safe threshold, open-world may join at a safe anchor. Server decides.
- Quick Play remains an optional direct shortcut/channel/deep link, but Camp is the default lived experience.

## 3. Arena floors — rare authored sealed encounters
Rare floor-run event, selected deterministically after the server owns combat. Large central arena room; doors seal only after all present party members enter (or a clearly telegraphed timeout pulls them in). Existing floor remains playable before/after.

### Frequency / reward
- First eligible after floor 4; target ~12–18% of non-boss floors, never consecutive, never directly before a milestone boss.
- Clear grants one premium reward choice: Rare blessing upgrade, undiscovered weapon, Boss Relic chance, or large coin cache. Reward is party-safe/instanced where appropriate.
- Failure follows normal run death; no separate arena currency.

### Four authored event templates
1. **DUO BOSS:** two complementary miniboss-scale bosses; each ~45–55% normal boss effective HP. Their pattern families must be compatible.
2. **BOSS + LIEUTENANT:** one ~70% boss plus one smart elite/leader whose death breaks/changes boss support pattern.
3. **MINIBOSS GAUNTLET:** 3 distinct elites sequentially with 1.0–1.5s breath/reward beats; never simultaneous pile-on.
4. **SURVIVAL EVENT:** 45–60s authored waves with pressure objectives; wave composition uses threat budgets and movement grammar, not body spam.

### Authored overlap arbitration (mandatory)
Arena controller owns a global `commitBudget` / pattern scheduler:
- Max **2 major committed patterns** active simultaneously; max 1 arena-wide denial pattern.
- No two independent locked hits may create unavoidable damage within 0.40s at the same player location.
- Reserve windows: each major move declares `telegraphStart`, `lock`, `active`, `recover`, `footprint`; scheduler rejects/delays overlaps violating escape corridors.
- Duo bosses use complementary roles (e.g. charger + zoner) but attacks alternate/interleave. Never two rushers, two full-room zones, or two summons simultaneously.
- When one Duo boss dies, survivor gains ONE authored technique/escalation, not a blanket rage stat multiplier/HP refill.
- Co-op targeting splits pressure but never creates one unavoidable crossfire per player; snapshot player count at arena start for balance.

### Floor-purpose UX integration
Before seal: `ENTER THE ARENA`. Sealed: event-specific objective (`DEFEAT THE DUO`, `BREAK THE LIEUTENANT`, `SURVIVE · 42s`). Clear: `ARENA CLEAR — CLAIM REWARD`; exit unlock follows the canonical floor objective state. Minimap central room pulses uniquely only while discovered/active.

## 4. Depth escalation: material / ecology / room grammar, not hue-only
Biome color lanes remain support, never the identity by themselves. Each depth band must change three visible layers:

### Verdant Hollow — elastic / living
- Materials: roots, damp wood, leaf mats, soft amber sap.
- Ecology: flocking/hopping soft creatures, root seams, living props.
- Room grammar: round/branching rooms, soft obstacles, clear escape loops; teaches universal movement verbs safely.

### Sunless Caves — sound / momentum
- Materials: shale, exposed bone, resonant stone, falling dust.
- Ecology: eyeless listeners (Marrow/Rattleback/Knellbat), ceiling/wall commitment, sound tells.
- Room grammar: long charge lanes, echo chambers, hard impact walls, pockets of darkness with material tells—never invisible attacks.

### The Deep — fracture / wrong geometry
- Materials: jet-black resin, cold mineral seams, broken architecture, dead amber.
- Ecology: seam-followers, angular orbiters, wall logic, precise feints.
- Room grammar: offset/T-shaped spaces, visible fracture paths, staggered elevations suggested by wall faces; navigable/readable despite wrongness.

### Emberreach — convection / pressure
- Materials: clinker, glassy slag, vents, flowing heat seams.
- Ecology: anchored venters, jet movement, fissure eruption, cooling recoveries.
- Room grammar: pressure lanes and safe pockets that change over time; hazards change space, not merely recolor walls or inflate HP.

### Escalation acceptance
At grayscale/low saturation, a screenshot of room silhouette/material/props should still identify biome. A player should name the biome from room grammar and creature movement before reading the banner. Every new biome supplies at least: 2 structural room shapes, 2 prop/material families, 1 environmental interaction, and 2 weighted movement verbs.

## 5. Staging after authoritative combat sync
- **D1:** Camp World shell + Heart + physical Descent Gate; spawn directly into Camp. Stations may be placeholder NPCs but authoritative interactions.
- **D2:** physical characters + Healer/Armorer/Dealer/Training; persistent state wiring.
- **D3:** Wilds Gate + open-world World flavor; party staging shared across both gates.
- **D4:** Arena floor controller + ONE event (Boss+Lieutenant recommended first; easiest arbitration proof) + premium reward.
- **D5:** remaining arena templates + material/ecology/room-grammar expansion.
No D-stage work begins before A/B/C production gates pass.

## Bottom line
The future UX is a place, not menus: players wake in Amber Camp, walk to people and gates, gather physically, and leave together. Arena floors are rare authored pressure tests governed by a server-side overlap scheduler, not random boss piles. Depth reads through material, ecology, geometry, and movement; hue only reinforces it. All of it is built on the authoritative World abstraction, never as throwaway static UI.

---
## REAL LIGHTING POINTER (post-server only)
Lighting/darkness is specified in `blobrogue_POST_SERVER_LIGHTING_spec.md`: authoritative coarse light field + client authored rendering, strict tell/objective readability, biome light grammars, and contextual mob pressure. It supersedes hue-only identity but does not change D-stage ordering; no implementation before A/B/C.
