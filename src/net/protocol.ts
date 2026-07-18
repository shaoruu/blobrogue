// Stage B/C netcode protocol: the wire contract shared by the browser client and the Node
// authoritative server. Compact, validated JSON now; a Codec seam so a binary encoding is a
// later one-module swap (production spec §4). This module imports ONLY the pure sim (no DOM,
// no ws, no Convex) so both ends compile against it.
//
// The wire structs are the plain-data subset the client needs to render + reconcile — never
// anim/cosmetics (those stay client-side per Stage A). The server sends authoritative state;
// the client sends INPUTS/INTENTS ONLY (never outcomes/positions/hits) — the core anti-cheat
// rule. BOTH directions are exhaustively validated at runtime: client frames strictly (unknown
// fields rejected — a smuggled `dt` is a protocol error), server frames defensively (every
// field type-checked before the client trusts it).

import type { PlayerSim, WorldState } from "../sim/world.js";
import { isFloorCleared, playersAtExit, isPlayerOut } from "../sim/world.js";
import type { EncounterState } from "../sim/encounter.js";
import { shopSlotForViewer } from "../sim/shop.js";
import type { ShopSlot, ShopSlotKind, ShopState } from "../sim/shop.js";
import type {
  Enemy, Bullet, Prop, Pickup, Chest, Hazard, HazardKind, EnemyKind, WeaponId, AttackPhase,
  AttackMove, PropKind, PickupKind, ChestKind, Effect, EffectKind,
  SluiceMode, OddsmakerOutcome,
} from "../sim/types.js";
import type { EnemyTier, ShopMode } from "../sim/balance.js";
import type { PlayerMods } from "../sim/items.js";
import { PROP_RADIUS } from "../sim/constants.js";
import { WEAPONS } from "../sim/weapons.js";
import { ENEMY_ARCHETYPES, isBossKind } from "../sim/enemies.js";
import type { SimEvent } from "../sim/events.js";
import { LOCAL_ID } from "../sim/input.js";
import type { PlayerId } from "../sim/input.js";
import type { KitId } from "../sim/kits.js";
import { isKitId } from "../sim/kits.js";
import type { MatchPhase, MatchState, PvpDraftTrigger } from "../sim/pvp.js";
import { projectPlayer, applyPlayerSnapshot, modsFromWire } from "./playerSnapshot.js";
import type { AuthoritativePlayerSnapshot } from "./playerSnapshot.js";
import type { KeyedDelta, RemovalReason, SelfDelta, WireObject, WireValue } from "./snapshotDelta.js";
import { isValidWorldId } from "./worldId.js";
import {
  LEGACY_CONTENT_CATALOG_VERSION,
  isContentCatalogVersion,
} from "../sim/contentCatalog.js";
import type { ContentCatalogVersion } from "../sim/contentCatalog.js";

export { modsFromWire } from "./playerSnapshot.js";

// ---- fixed timing (server tick + snapshot rate) ----
export const TICK_HZ = 20;
export const FIXED_DT = 1 / TICK_HZ; // 50ms authoritative step
// v3: balance reset (dash-iframe/fang fields on SelfWire, enemy tier on EnemyWire,
// dealer_heart pickups, squeeze attack move, offerBlessing{rare} + bossTransition/
// enemySpawn events). Joins must carry EXACTLY this version.
// v3-additive (no bump — client->server messages are UNCHANGED, so the strict join gate is
// honest): the join TICKET payload may carry verified room/identity claims (wld/nm/cl — see
// server/src/auth.ts), and PlayerWire carries optional nm/cl which the client decodes
// defensively with fallbacks, so old<->new client/server pairs interoperate cleanly.
// v4 (ONE migration, strict equal-version join gate — skew is explicit, never silently
// interoperated on a Sev-0 surface):
//   - hotbar inventory commands: client->server `reorder` (move an inventory slot) and
//     `drop` (drop an owned weapon as a world pickup) plus the weaponDrop event
//   - room correctness: `wid` — the authoritative world id this connection is bound to, on
//     EVERY snap, so the client can ASSERT it landed in the room it expected (mismatch =
//     close, never play); `roster` — every seat in the world (verified identity + on/away
//     state), independent of interest filtering, so readiness/HUD show who actually joined
//     and who is reconnecting
//   - reconnect resume: `tok` — the single-use seat token for THIS connection (rides every
//     per-connection snapshot), presented via join's optional `resume` to reclaim the
//     reserved body; a deliberate disconnect says `leave` so no seat is reserved; PlayerWire
//     `ab` marks an absent body (rendered as a reconnecting ghost)
// v5 (intentional bump, the content wave): the snapshot grew the `hzds` hazard list
// (webs slow PREDICTED movement, so clients must know them), boss-choice/dealer
// pickup flags + the personal-claim player flag, and the enemy wire's closed kind/move
// sets grew (charger/burrower/orbiter/shielder + the boss roster; a v4 client would
// reject any snapshot carrying them as a ProtocolError). The join gate enforcing
// equality is what turns that skew into a clean "update your client" instead of a
// mid-run desync. NOTE: the control plane's synthetic VERIFY join mirrors this constant
// (control/src/adapters/httpProbe.ts SYNTHETIC_JOIN_PROTOCOL).
// v6 (the co-op experience pass — client->server messages changed, so the strict join
// gate bumps): input carries the interact intent (`act`, the explicit revive-channel
// key), a semantic `spec` message names a downed player's spectate target (the server
// centers that client's interest view on it), PlayerWire carries `rv` (authoritative
// revive progress for the reviver-side ring) and `out` (past the floor's down limit —
// unrevivable until the descent rescue), SelfWire carries `out`, and snapshots carry
// `exr` (the living present players standing at the cleared exit — the descend gate's
// own readiness predicate, driving the party coordination readout).
// v7 (intentional bump, the depth-progression world): dungeon geometry now comes from a
// NEW shared generator (journey-chained rooms, shape archetypes, curriculum cadence) and
// seeded FLOOR hazards (spikes/pools/vents/rifts — never on the wire, derived from the
// snapshot seed), so a v6 client would silently render a DIFFERENT map than the server
// simulates — the join gate fences the skew into a clean version mismatch. Also adds the
// hazardHit event for floor-hazard damage juice.
// v8 (intentional bump, Patch's shop room + the bestiary wave — two additive server->client
// growths sharing ONE version; their wire fields are disjoint, so no second bump):
//   - Patch's shop room: the Dealer's loose priced pickups are GONE — dealer_heart/
//     dealer_weapon leave the PickupKind wire set (a v7 client would render phantom
//     stock), shop floors generate a dedicated `shop` room (geometry skew, same class as
//     v7's), snapshots carry the authoritative `shop` stall state, purchases ride the new
//     client->server `shopBuy` command (explicit interact -> BUY; touch never purchases),
//     and the shopBuy event joins the reliable stream.
//   - the bestiary wave: the enemy wire's closed kind set grew (the six new commons +
//     echo/knell decoys + the marshal/toll miniboss templates), the move set grew
//     (decoy/blink/seam/stoke/harmonize/knell), the hazard kind set grew (cinder/charge —
//     both slow/damage PREDICTED play, so clients must decode them), and EnemyWire
//     carries `aux` — the one per-kind auxiliary channel (sinderling armed state, decoy
//     fuses, the fragment's tether id, a bulwark elite's plate HP). A v7 client would
//     reject any snapshot carrying these as a ProtocolError; the strict join gate turns
//     that skew into a clean "update your client".
// v9 (the remote-dash sync): PlayerWire grows the dash/invuln readout block
//   (dti/ddx/ddy/dnv/inv — the same authoritative PlayerSim fields SelfWire already carries
//   for reconciliation), so OBSERVING clients can render a teammate's dash (afterimages/
//   dust/sfx/i-frame flicker) and interpolate it as a crisp move instead of a smeared glide.
//   dashStart/dashTrail stay pid-scoped: remote dash FX are driven off this snapshot STATE
//   (interp-aligned), never off the dasher's own event stream.
// v10 (the weapon effect wave): snapshots grow the `effs` list — the authoritative weapon
//   effect entities (chill zones, snap wires, orbit blades, sentries, tethers) every client
//   must render, riding alongside the shop's `shop` stall state on the one shared world list;
//   SelfWire grows `chg` (the held Breach charge, a server-owned field prediction reconciles
//   like fireCd); and the effect events (wirePlanted/wireArmed/wireSnap/wireExpired/
//   wireRefused/haloFlare/sentryPlaced/sentryAcquire/sentryShot/sentryHit/sentryDown/
//   tetherLatch/tetherHold/tetherSweep + the shared status apply/freeze tells) join the
//   reliable channel. A client on an older version rejects every snapshot carrying these, so
//   the strict equal-version join gate turns the skew into a clean "update your client".
// v11 (the hotbar cap): the inventory is capped at MAX_OWNED_WEAPONS and a full hotbar never
//   auto-collects a weapon pickup — claiming one at the cap rides the NEW client->server
//   `swap` command (trade an owned weapon for a named floor pickup, atomically, server-
//   validated). A client at the cap on an older version would silently fail to collect with
//   no swap affordance (and the server rejects the unknown command), so the join gate bumps.
// v12 (the weapon rarity + mystery wave — ONE version for the whole feature;
// client->server messages are unchanged):
//   - the closed WeaponId set grew (the five legendaries: reaper/swarm/midas/phase/
//     vortex) — a v11 client would reject any snapshot whose pickups/bullets/inventories
//     carry them as a ProtocolError;
//   - MYSTERY pickups: PickupWire carries `myst` and a mystery pickup's `wpn` is null ON
//     THE WIRE (the identity is baked sim-side but hidden from every client until the
//     authoritative reveal) — a v11 client would render a phantom identified weapon;
//   - mystery shop pedestals: ShopSlotWire carries `myst` with the same hidden-identity
//     contract (the SOLD pedestal reveals its true face after the buy);
//   - the reliable event stream grew mysteryReveal (the reveal moment) and implosion
//     (the Lodestone's collapse FX). NOTE: the control plane's synthetic VERIFY join
//     mirrors this constant (control/src/adapters/httpProbe.ts SYNTHETIC_JOIN_PROTOCOL).
// v13 (the earned-windows boss rework + fair surprise + R scaling): NO new wire fields —
//   but two closed sets grew, which the strict validators turn into hard decode failures
//   on older clients, so the equal-version join gate bumps once for the whole arc:
//   - the enemy kind set: the Weaver's lattice `knot` and egg-sac `sac` mechanic bodies;
//   - the hazard kind set: `omen`, the ambush pre-spawn tell every client must render.
//   The deep bosses' guarded/exposed state rides the existing `aux` channel (seconds
//   left in the current EXPOSED window; 0 = guarded), the Weaver's new moves reuse the
//   closed move grammar (weave/blink/dive/pounce/rush/crash), and every window/bank/
//   lattice/pool/R decision stays sim-internal.
// v14 (intentional bump, the depth-scaling PREMIUM coin economy — the approved vendor
// ecology of docs/specs/COIN_ECONOMY_AND_VENDORS.md):
//   - the shop wire's closed slot-kind set grew (the premium sinks mystery/legendary/
//     rare_blessing/max_hp/full_heal/core_infusion/weapon_upgrade/revive_token/
//     extra_slot, the utilities reroll_all/amber_cache/prospector, the artifact, and the
//     mythic_* capstone kinds — a v13 client would reject any premium stall as a
//     ProtocolError), and ShopWire carries `md` (the stall's mode: dealer/premium/
//     spoils/climax — the read every client must agree on);
//   - SelfWire carries the premium run state the client must reconcile and render:
//     php (successive +1-heart buys, the ×1.6 price ladder), amc (amber cache armed),
//     amw (banked mythic Amber windfall), brt (the armed blessing-offer reroll),
//     rvt (banked revive token), xsl (bought hotbar slots past MAX_OWNED_WEAPONS),
//     tth (max hearts paid to the artifact), pfl (the Prospector's Draught's floor).
// v15 (the co-op game-feel pass): a NEW reliable event, friendlyNudge (a teammate's DIRECT
//   projectile grazing a friend — 0 damage, a deterministic server-side positional impulse
//   plus the comedic bonk FX), joins the wire; and the player-scoped combat events
//   shot/meleeSwing/playerHurt/heal/pickup are reclassified from "pid" to "pos" scope so a
//   networked player's actions reach every NEARBY client (not only the actor) and are
//   audible/visible positionally. A v14 client's strict validator would reject the new
//   event type, so the equal-version join gate bumps once for the whole pass. NOTE: the
//   control plane's synthetic VERIFY join mirrors this constant (control/src/adapters/
//   httpProbe.ts SYNTHETIC_JOIN_PROTOCOL).
// v16 (the Wave 1 seeded-randomness layer): the authoritative FLOOR DESCRIPTOR now EXPRESSES in
// the sim (floor mutators, elite affixes, deep-boss affixes), so two disjoint reads cross the
// wire and the equal-version join gate bumps once for the whole layer:
//   - the snapshot carries `pcl` — the co-op player count LOCKED at floor pull (never rescaled on
//     join/down/disconnect). The floor descriptor is a pure function of seed+floor+pcl, so a
//     client that resolves it with `pcl` reproduces the server's mutators EXACTLY (HUD readout,
//     the Dense Dark vision dim, the mutator-driven floor hazards it derives locally, and Thin
//     Air dash prediction) instead of guessing from its own seat count. A v15 client omits it.
//   - the enemy wire carries `afx` — a rolled elite's affix id ("splits"/"shielded"/
//     "hazardTrail"/"reflect"/"enrage", "" for none) so clients draw its material tell (the
//     reflect facet's armed/cracked state, the shielded slab, pre-cracked seams, dripping
//     element, heated veins). The boss affix needs NO new field: it blooms the existing
//     telegraphed "charge" hazards, which already ride hzds. A v15 client would reject `afx`.
// v17 (intentional bump, the Wave 1 DEEP BOSSES — The Sump F35–45): the enemy wire's closed
// kind SET grew (jet / tithe / tithe_slab / quorum / quorum_shield / quorum_heal / quorum_dmg)
// and the closed MOVE set grew (mirror / merge) — a v16 client would reject any snapshot
// carrying them as a ProtocolError (exactly the v5 precedent, where the charger/burrower/boss
// roster grew the sets). The bosses reuse the existing wire FIELDS: JET's frozen archetype
// mirror pool, the Tithe's re-armor state and the Quorum shared-HP pool all express through
// the already-shipped channels — the boss phase (`bph`), the earned-window remainder (`aux`),
// the slab/husk HP (`hp`/`mhp`), the husk break-integrity (`afs`) and the shared attack state
// (`atk`) — so no struct field was added; only the enum value sets widened. The equality join
// gate turns that skew into a clean "update your client" instead of a mid-run desync.
// NOTE: the control plane's synthetic VERIFY join mirrors this constant
// (control/src/adapters/httpProbe.ts SYNTHETIC_JOIN_PROTOCOL).
// v18 (the KIT/CLASS + ULT + account-MASTERY system — docs/specs/blobrogue_KIT_XP_SYSTEM_spec.md):
//   - SelfWire grows the authoritative kit/ult block the client reconciles + renders: kit (the
//     chosen KitId), uc (the fixed-point ult meter 0..ULT.meterMax), ura (the ultReadyAtTick 8s lockout),
//     ovt/phs/uiv (Overdrive / Phase-speed / Phase-invuln self-buff seconds), pst (the per-kit
//     passive channel). A v17 client would reject a snapshot carrying them.
//   - the input command grows a mandatory `ult` bit (the "ult requested" intent, alongside
//     dash/act) — the client can only REQUEST; the server validates charge + the 8s lockout and
//     resolves the effect (no client-authoritative heal/shield/teleport/invuln).
//   - the effect-entity closed kind set grew (`sanctuary`, `aegis`) — the two new server-owned
//     deterministic sim entities (the Mender's heal zone + the Bulwark's bullet-blocking dome)
//     ride the existing effs list, reconciled from the snapshot.
//   - four new reliable SimEvents (ultOverdrive / ultSanctuary / ultAegis / ultPhase) join the
//     wire; clients render the cast off them only.
//   - kit-select: the chosen kitId + the account Mastery level ride the signed join TICKET claim
//     (kt/ml), validated server-side against the account's unlocks — never a raw client claim.
// v19 (Wave 1 deep-boss rework — docs/specs/blobrogue_BOSS_REWORK_wave1.md): the enemy
//   attack-state wire (EnemyWire.atk.mv) gains four AttackMove values for the reworked
//   JET/TITHE/QUORUM movesets — "tracer" (JET's dash-punish snap), "beam" (the corridor
//   telegraph shared by JET's overclock/corruption and Quorum's crossfire), "spew" (the
//   Tithe's two-stage arcing pools) and "hurl" (the Tithe's thrown slab). A v18 client
//   would reject a snapshot carrying any of them (the mv set is a validated closed set).
//   The guarded/exposed body state continues to ride the existing EnemyWire.aux channel
//   (exposed-seconds remaining; 0 = guarded), so the client/art reads the guard gate with
//   no new field. The equality join gate turns the skew into a clean "update your client".
// v20 (Wave 1 deep-boss surplus content): two new enemy kinds ride the wire — tithe_tribute
//   (the Tithe's slab-reinforcing crawler) and quorum_splinter (Quorum's role-echo shard,
//   role on EnemyWire.aux: 0 shield / 1 heal / 2 dmg). isEnemyKind keys off ENEMY_ARCHETYPES,
//   so a v19 client would reject a snapshot carrying either kind.
// v21 (Wave 1 deep-boss art/state binding): EnemyWire grows ONE field — `brr`, the boss
//   transition-beat-live flag (boss.roar !== null; false for non-bosses) — so transition-beat
//   and Quorum merge-fuse VFX bind to the authoritative flag instead of re-deriving it from
//   move/phase edges. A v20 client would reject a snapshot carrying it (the enemy validator is
//   exhaustive). The other guard/expose bindings need NO new field: the boss PHASE already
//   rides `bph`, and the EXPOSED remainder already rides `aux` (restored into boss.exposed, the
//   same flag the damage gate reads) — the client now binds its guard/expose art to boss.exposed
//   directly so art and hitbox can't desync. Quorum husk kind + liveness continue to ride each
//   husk's own EnemyWire (kind + hp + position), which drives the discrete husk-state sprites.
// v22 (JET mirror telegraph): EnemyWire grows `mfm` — JET's current mirror-salvo lead
//   Resonance-family index (0..5, or -1 when not a mirror salvo). Drives the copied weapon's
//   telegraph SHAPE (fan/lane/ring/parabola/wedge) and its own family hue (the "that's my gun"
//   read); the sim tints the mirrored shards with the same enum. A v21 client rejects it.
// v23 (TITHE rip signature): the closed AttackMove set grows one value — "rip", the Tithe's
//   dedicated P3 all-slabs debris-wheel signature (was inline-reusing MARROW's "spin"). A
//   dedicated move so the collapse/debris-wheel VFX + telegraph bind to a real signal. A v22
//   client rejects a snapshot carrying it (the mv set is a validated closed set).
// v24 (snapshot DELTA wire — bandwidth): the steady-state per-client snapshot grew into its
//   budget (§4), so the per-tick frame is now DELTA-encoded against the client's last
//   acknowledged snapshot (only changed scalars/self-fields, and per keyed list only the
//   added/changed entities + explicit removal tombstones). Three wire changes bump the gate:
//   - `snap` carries `sseq`, a per-connection monotonic snapshot sequence — the ack target and
//     the delta baseline id. A `snap` is a complete KEYFRAME (join/resume bootstrap keeps
//     full:true; a mid-stream keyframe is full:false) and always re-establishes the baseline.
//   - a NEW server->client message `snapd` carries a delta against a named baseline sseq. The
//     client reconstructs the complete snapshot, validates it through the SAME exhaustive
//     snapshot validator, then applies it exactly as before — a stale/out-of-order or
//     unknown-baseline delta is dropped (a keyframe recovers). Removal tombstones distinguish
//     "gone" (died/despawned) from "left" (out of interest radius) so interest filtering is
//     never conflated with death. The reliable event stream (id + evTo) rides every frame
//     verbatim, so exactly-once delivery holds across a keyframe resync.
//   - `input` carries `ackSnap`, the highest snapshot sseq the client has applied + retained,
//     so the server can delta against the EXACT per-connection baseline the client holds and
//     fall back to a full keyframe on any gap. NOTE: the control plane's synthetic VERIFY join
//     mirrors this constant (control/src/adapters/httpProbe.ts SYNTHETIC_JOIN_PROTOCOL).
// v25 (Wave 2 kit SIGNATURES — docs/specs/blobrogue_KIT_XP_SYSTEM_spec.md): each kit gains ONE
//   felt+visible signature, growing the wire in three places:
//   - SelfWire grows three local-player fields the client reconciles + renders: `ovh` (Gunner
//     OVERHEAT boil-over seconds — the glowing-gun burst), `osh` (Bulwark OVERSHIELD chip pool
//     0..3, drawn on the health bar), and `pra` (Mender HEAL-PULSE readyAtTick, the CD readout).
//     A v24 client would reject a snapshot carrying them.
//   - the input command grows a mandatory `pulse` bit (the Mender heal-pulse request, alongside
//     ult/dash/act) — the client can only REQUEST; the server validates the pulse cooldown.
//   - EnemyWire grows `mkt` (PHANTOM dash-through mark seconds) so EVERY client draws the marked
//     glow on a shared enemy (the mark is authoritative team-wide vulnerability). A v24 client
//     rejects a snapshot carrying it (the enemy validator is exhaustive).
// v26 (JET surprise layer — §5g mirror-native): two wire changes bump the gate.
//   - a NEW enemy kind `jet_echo` rides the wire (JET's telegraphed mirror-image of a player:
//     arrives on the fair-ambush omen, fires ONE mirrored-school salvo, then dissolves). It
//     also grows EnemyWire ONE field — `mir`, the PlayerId this reflection mirrors ("" = not an
//     echo) — so every client draws the co-op read ("that's ME" / "[name]'s reflection") and
//     the CD readability distinction (cold black translucent echo vs warm solid teammate). A
//     v25 client rejects a snapshot carrying the kind or the field (both validators are exhaustive).
//   - a NEW dynamic HazardKind `corrupt` rides `hzds` (JET's per-phase arena-corruption drain
//     zone — the "The Light Goes Out" reshape creeping in from the edges). A v25 client rejects
//     a snapshot carrying it (HAZARD_KINDS is a validated closed set).
// v27 (GORGE F50 GIANT encounter — the AD-locked shell-peel giant): two closed-set widenings, no
//   new EnemyWire field.
//   - TWO new enemy kinds ride the wire: `gorge` (the F50 giant boss) and `gorge_seam` (its
//     tectonic weak-point — the peel-verb mechanic body). isEnemyKind keys off ENEMY_ARCHETYPES,
//     so a v26 client rejects a snapshot carrying either.
//   - a NEW PropKind `gorge_debris` rides `props` (the giant's sloughed shell cover). PROP_KINDS
//     is a validated closed set, so a v26 client rejects it.
//   - the giant needs NO new EnemyWire field: its SHELL PHASE (rind/chitin/core) already rides
//     `bph` (boss.phase — the client swaps the shell sprite off it, exactly like JET's phase
//     bodies), and its GUARDED/EXPOSED state already rides `aux` (the exposed remainder, restored
//     into boss.exposed — the same flag the damage gate reads). Compact by construction.
// v28: PVP MVP — PlayerWire.tm (FFA team), SelfWire.rsp (respawn countdown), a top-level `match`
// block (phase / phase-end tick / per-player frags + alive / winner), and the reliable
// pvpKill / pvpMatchOver events. All inert in co-op (team 0, respawn 0, match null).
// v29: PVP Wave 1 presentation events — ring-out, chain-frag, and sudden-death crescendo.
// v30: distinct authoritative PvP spawn-grace + spawn-shield tick windows on SelfWire and
// PlayerWire. The split drives exact attack suppression and unambiguous local/remote safety cues.
// v31: authoritative PvP shield-break event, ordered before the offense that broke it.
// v32: shared spawn-origin/end ticks, held-offense latch, and rate-limited arming feedback.
// v33: authority-plane hard cut. Guest capabilities, signed run receipts, and durable generation
// admission require the coordinated client/Convex/GS rollout; stale clients get a terminal
// refresh-required rejection instead of retrying through the reconnect grace.
// v34 (Batch0 encounter architecture): snapshots grow optional `enc` — EncounterWire carrying
//   kind/active/structure/currentRoom/routeEdge/checkpoint/objectiveProgress/carrier/failure/
//   completed/failed for HUD progress pips, carrier highlight, spectator objective read, and
//   same-run reconnect restore. null on non-encounter floors. Additive + strict decode; a v33
//   client rejects a snapshot carrying `enc` (validateSnap exact shape). Gorge arena path
//   still clears via HP-death; custom completion rides enc.completed + isFloorCleared.
// v35: PR #142 Wave A owns this coordinated cut on top of Batch0: closed WeaponId additions,
//   immutable run catalog version (`cat`), per-weapon cooldowns/cycles (`wcd`/`sgc`/`ogc`),
//   Sluice observer mode, Oddsmaker outcome, revive channel owner (`rvb`), and Muddy dash
//   state (`isMds`). Batch0 `enc` remains on the snapshot. Later PvP/Pale work allocates the
//   next version only when its own wire changes.
// v36 (Batch1 Sever F55): the closed AttackMove set grows `worldsplit` (display name
//   WORLDSPLIT) and it is decoded through inSet(ATTACK_MOVES,...), so a v35 client rejects a
//   snapshot carrying it — a real wire cut on top of Wave A's v35. Enemy kinds `sever` /
//   `sever_anchor` ride via ENEMY_ARCHETYPES (no new EnemyWire fields). EncounterState flags
//   stay sim-internal (escapeMeter/supportsCut/interceptState/chosenExitEdgeId/
//   worldsplitPhase) — Batch0's enc wire already carries checkpoint/objectiveProgress.
// v37: Content Wave B catalog `2` stacked on Sever v36 / Wave A catalog `1` — closed WeaponId
//   additions (resonant_fork / red_pen / margin_call / sidewinder) and `cat` admitting version 2.
//   Wave A fields remain on v35 semantics; Sever worldsplit wire remains on v36.
// v38 (PALE THRONE F75 GIANT encounter — the SECOND giant, reusing the AD-locked Gorge shell-peel
//   machinery via a shared giant-encounter core): two closed-set widenings, no new EnemyWire field.
//   - TWO new enemy kinds ride the wire: `pale` (the F75 giant boss) and `pale_seam` (its cold
//     tectonic weak-point — the peel-verb mechanic body). isEnemyKind keys off ENEMY_ARCHETYPES,
//     so a v37 client rejects a snapshot carrying either.
//   - a NEW PropKind `pale_debris` rides `props` (the giant's sloughed cold-shell cover). PROP_KINDS
//     is a validated closed set, so a v37 client rejects it.
//   - the giant needs NO new EnemyWire field — exactly like Gorge: its SHELL PHASE (stone/cracked/
//     core) rides `bph` (boss.phase — the client swaps the shell sprite off it) and its GUARDED/
//     EXPOSED state rides `aux` (the exposed remainder). The COLD material is a client-render/
//     telegraph-color swap only (never on the wire). Compact by construction.
// v38 also includes authoritative giant telegraph phase and local warmth state. AttackWire carries
// the giant commitment clock/counters used by exact ring2 and dual-sweep tells; SelfWire carries
// the reconciled warmth timer/path/chill state so reconnect and prediction cannot diverge.
//
// v39 (Batch2A Choirmaster F60): the closed AttackMove set grows `last_note` (display name
//   THE LAST NOTE). Enemy kinds `choirmaster` / `choir_pillar` ride via ENEMY_ARCHETYPES (no new
//   EnemyWire fields). EncounterState flags (lastNotePhase / livePillarId / sheetSpanIndex /
//   acousticShadowPillarId / silencedMask) ride Batch0's existing enc wire.
// v40: policy-bound PVP private draft wire after Choirmaster v39. Snapshot wait rows and
//   authoritative offer frames identify the draft surface/trigger/comeback state (offer k/tr/
//   isComeback), and mode-gated draft events carry balance telemetry. The strict join gate
//   makes older clients terminally refresh instead of rendering a co-op offer surface against
//   a live arena.
// v41 (Batch2B Undertow F65): the closed AttackMove set grows `river_comes_back` (display name
//   THE RIVER COMES BACK). Enemy kinds `undertow` / `warm_pulse` / `relief_vent` / `flood_front`
//   ride via ENEMY_ARCHETYPES (no new EnemyWire fields). EncounterState flags (riverPhase /
//   riverOutcome / pulseDepositVentId / floodProgress / ventsUsedMask / manifestCount /
//   escapeDirection) ride Batch0's existing enc wire. PROTOCOL 40 = PVP #143; Undertow owns
//   PROTOCOL 41. BLACK_TIDE retired — never revive.
// v42 (Batch3A Claimant F70): the closed AttackMove set grows `all_things_owed` (display name
//   ALL THINGS OWED). Enemy kinds `claimant` / `claim_token` / `claim_socket` ride via
//   ENEMY_ARCHETYPES (no new EnemyWire fields). EncounterState flags (owedPhase / owedOutcome /
//   tokenSocketId / highlightedSocketId / passesCompleted / passCount / aimLockedAt / lockFrac /
//   tokenDropped) ride Batch0's existing enc wire (arena kind). Claimant owns PROTOCOL 42.
//   CROWNFALL retired — never revive.
// v43 (Batch3B Wake F80): the closed AttackMove set grows `last_procession` (display name THE LAST
//   PROCESSION). Enemy kinds `wake` / `warm_bier` / `convoy_blocker` / `shadow_front` ride via
//   ENEMY_ARCHETYPES (no new EnemyWire fields). EncounterState flags (convoyEdgeId / convoyProgress /
//   convoyWarmth / highlightedBlockerId / blockersClearedMask / processionPhase / processionOutcome /
//   thresholdIndex / manifestCount / shadowBehind / convoyPlanted) ride Batch0's existing enc wire
//   (escort kind). Wake owns PROTOCOL 43. NIGHTFALL_PROCESSION retired — never revive.
// v44 (Content Wave C catalog `3` — guns-only +4): closed WeaponId additions (hushiron /
//   backtalk / lamplighter / faultlink) ride the wire, and the authoritative `cat` snapshot
//   field admits catalog version 3. No new blessings, no new EnemyWire/PropKind fields — the
//   four verbs are server-owned TRANSIENT combat state (sub-10s), never reconciled. The bump
//   is purely so a pre-v44 client cleanly rejects a `cat=3` run instead of decoding it.
//   MERGE ORDER: Wake (43) is on main — Wave C owns PROTOCOL 44.
export const PROTOCOL_VERSION = 44;


// How long the server reserves a disconnected player's body (their seat) before the
// authoritative leave lifecycle applies. 90s per the studio balance gate's reconnect
// contract (docs/specs/blobrogue_STUDIO_BALANCE_GATE.md §6) — a reserved body is paused,
// safe, gate-neutral, and never blocks a wipe, so the long window costs teammates nothing
// while covering real-world outages (router resets, elevator rides). Shared so the client's
// reconnect loop and grace countdown agree with the server default (GS_RESUME_GRACE_MS can
// override server-side; the countdown is display-only).
export const RESUME_GRACE_MS = 90000;

// The world-id helpers moved to ./worldId.js (a pure, sim-free module) so the online lobby
// can map room codes -> worlds without pulling protocol.ts's wire code (and the whole sim)
// onto the menu's critical path. Re-exported here so every existing consumer of protocol.js
// (client, server ticket verifier, tests) is unaffected.
export { isValidWorldId, worldIdForRoomCode, pvpWorldIdForRoomCode, isPvpWorldId, PVP_WORLD_PREFIX } from "./worldId.js";

// Base client interpolation delay (ms) for remote entities. The server uses this as the
// lag-comp rewind default until the client reports its ACTUAL adaptive delay via `stat.dly`
// (server-clamped to the same [min,max] the client's adaptive logic uses).
export const INTERP_BASE_DELAY_MS = 120;
export const INTERP_DELAY_MIN_MS = 90;
export const INTERP_DELAY_MAX_MS = 300;

// The fixedDev/measurement arena seed (harness + pre-join placeholder world). A REAL online
// run never uses this: the server rolls a fresh seed per run and the client rebuilds from the
// snapshot's authoritative seed/floor/rev.
export const STAGE_B_SEED = 0x51a9e_b0b;
export const STAGE_B_FLOOR = 1;

// ---- wire structs (tight plain-data; short keys keep JSON small + debuggable) ----

// Authoritative local-player state for reconciliation: the SelfWire is the compact encoding of
// AuthoritativePlayerSnapshot (src/net/playerSnapshot.ts — the single projection/apply boundary
// with compile-time exhaustive field coverage). No aim (the client owns its own aim).
export interface SelfWire {
  x: number; y: number;
  hp: number; mhp: number;
  inv: number;                 // post-hit invuln seconds
  dnv: number;                 // dash-iframe seconds (separate, non-extending window)
  dcd: number; dti: number;    // dashCd, dashTime
  ddx: number; ddy: number;    // dash direction
  fcd: number;                 // fireCd
  chg: number;                 // held Breach charge seconds (reconciled like fireCd)
  fng: number;                 // Vampire Fang shared proc cooldown
  fac: number;                 // facing (-1/1)
  down: boolean;               // isDown
  wit: number;                 // authoritative warmth idle seconds
  wpx: number;                 // cumulative self-propelled thaw path
  wch: boolean;                // authoritative chilled state
  rev: number;                 // reviveProgress seconds (authoritative revive hold readout)
  out: boolean;                // past the floor's down limit: unrevivable until the descent
  wpn: WeaponId;
  wpns: WeaponId[];            // authoritative owned-weapon inventory (validated equip source)
  wcd: number[];                // per-owned-weapon cooldowns aligned with wpns
  sgc: number;                  // Sluicegate cycle
  ogc: number;                  // Oddsmaker cycle
  isMds: boolean;               // muddy dash refund spent for the active dash
  rvb: string;                  // revive channel owner ("" = none)
  items: string[];             // authoritative owned blessing/item ids (HUD strip)
  mods: PlayerMods;            // authoritative run mods (drives client prediction: speed/firerate/dash)
  coins: number; kills: number; combo: number; ct: number; // HUD readouts
  bcl: boolean;                // hasClaimedBossChoice (gate §4 personal boss-reward claim)
  php: number;                 // premiumHpBuys (the ×1.6 successive +1-heart price ladder)
  amc: boolean;                // isAmberCacheArmed (end-run coins→Amber trickle armed)
  amw: number;                 // amberWindfall (mythic +8 Amber claims banked this run)
  brt: boolean;                // isBlessingRerollArmed (next blessing offer rerolls once)
  rvt: number;                 // reviveTokens (banked get-back-up, cap 1)
  xsl: number;                 // extraWeaponSlots (bought hotbar capacity, cap 1)
  tth: number;                 // hpTithe (max hearts paid to the artifact devil deal)
  pfl: number;                 // prospectorFloor (coins ×2 while the floor matches; -1 = none)
  // KIT / ULT authoritative block (v18): the chosen kit, the fixed-point ult meter, the 8s
  // lockout tick, the self-buff windows, and the per-kit passive channel.
  kit: KitId;
  uc: number;                  // ultCharge (fixed-point integer 0..ULT.meterMax)
  ura: number;                 // ultReadyAtTick (the 8s hard-floor lockout)
  ovt: number;                 // Overdrive self-buff seconds
  ovh: number;                 // Gunner OVERHEAT boil-over seconds (Wave 2 signature)
  osh: number;                 // Bulwark OVERSHIELD chip pool 0..maxChips (Wave 2 signature)
  pra: number;                 // Mender HEAL-PULSE readyAtTick (Wave 2 signature CD gate)
  phs: number;                 // Phase speed-surge seconds
  uiv: number;                 // Phase invuln seconds (<= 1.2s)
  pst: number;                 // per-kit passive channel (momentum / lifebloom / hardened)
  rsp: number;                 // pvp respawn countdown in ticks (0 = alive); gates local prediction
  sgr: number;                 // pvp hard-grace ticks (attacks suppressed)
  ssh: number;                 // pvp spawn-shield ticks (breaks on first legal attack)
  spo: number;                 // authoritative spawn-protection origin tick
  sge: number;                 // authoritative hard-grace end tick
  sse: number;                 // authoritative total-shield end tick
  sfl: boolean;                // held offense must release before it can fire
}

// Another player as seen by this client (rendered via interpolation, never predicted).
// nm/cl/ht/fc are the verified cosmetic identity from that player's join ticket (name above
// the blob, party color, equipped hat/face — all visual-only). All are decode-
// OPTIONAL with safe fallbacks (nm -> id, cl/ht/fc -> null) so frames from an older server
// still decode, and unknown cosmetic ids simply render nothing. rv is the authoritative revive-channel
// progress on a DOWNED player (seconds) — it drives the reviver-side progress ring; out
// marks a body past the floor's down limit (teammates stop offering the revive). ab marks
// a network-absent body (its player disconnected and the seat is reserved for the
// reconnect grace) — rendered as an explicit reconnecting ghost, never a live/dead read.
export interface PlayerWire {
  id: PlayerId;
  x: number; y: number;
  hp: number; mhp: number;
  fac: number; aim: number;
  wpn: WeaponId; down: boolean;
  isDrain: boolean; // Sluicegate's authoritative next-shot mode
  // Dash + invuln readout (v9), the same authoritative PlayerSim fields SelfWire carries:
  // dti > 0 marks an ACTIVE dash, ddx/ddy its direction, dnv the dash-iframe window, inv
  // the post-hit invuln. Observing clients render the dash (afterimages/dust/sfx/flicker)
  // and interpolate it crisply from this state — dashStart/dashTrail events stay the
  // dasher's own (pid scope), so nothing ever double-plays.
  dti: number;
  ddx: number; ddy: number;
  dnv: number;
  inv: number;
  sgr: number;
  ssh: number;
  spo: number;
  sge: number;
  sse: number;
  rv: number;   // authoritative revive-channel progress on a DOWNED body (seconds)
  rvb: string;  // authoritative reviver id ("" = no active channel)
  out: boolean; // past the floor's down limit — teammates stop offering the revive
  bcl: boolean; // has claimed this floor's boss weapon choice (gate §4 personal claim)
  ab: boolean;  // absent body — the seat is reserved for a reconnect (rendered as a ghost)
  nm: string;
  cl: number | null;
  ht: string | null; // equipped cosmetic hat id (visual-only; null = the classic blob)
  fc: string | null; // equipped cosmetic face id (visual-only)
  pt: string | null; // equipped cosmetic COMPANION pet id (visual-only; null = no pet)
  tm: number;        // pvp FFA team id (0 = no team / every-man-for-himself); always 0 in co-op
}

// One SEAT in this world, as published on every snapshot REGARDLESS of interest filtering:
// the world-scoped player id, the VERIFIED ticket identity it joined with (aid — the same id
// the lobby roster keys on, so readiness can be matched member-by-member), the cosmetic
// name/color, and whether the seat is live ("on") or reserved for a reconnect ("away").
// This is the server's authoritative "who is actually in this world" — the lobby's Convex
// presence is only the expectation.
export type SeatState = "on" | "away";

export interface RosterWire {
  pid: PlayerId;
  aid: string;
  nm: string;
  cl: number | null;
  st: SeatState;
}

// A player still deciding a blessing offer + the seconds left on its authoritative TTL.
// Rides every snapshot (tiny, party-sized) so all clients agree on WHO is holding the
// descend gate and for how long — a wait that is visible and bounded, never a mystery.
export interface WaitWire {
  pid: PlayerId;
  s: number;
  k: "blessing" | "pvp_draft";
  tr: PvpDraftTrigger;
  isComeback: boolean;
}

// A snapshot event carries a monotonic id so the reliable-event channel can dedupe (client
// ignores ids it already processed) and ack (client reports the max id it has seen; the server
// resends only unacked events from a bounded ring). This makes one-shot juice (kills/loot/FX)
// effectively once-delivered under packet loss — no missing, no double.
export interface WireEvent { id: number; e: SimEvent }

// Compact attack-state for enemy telegraph rendering.
export interface AttackWire {
  ph: AttackPhase; mv: AttackMove;
  wu: number;                  // windup 0..1
  lk: boolean; la: number;     // isAimLocked, lockedAngle
  mx: number; my: number;      // AoE marker
  tm: number;                  // authoritative seconds in the current attack phase
  ac: number;                  // boss commitment count (ring gap rotation)
  sc: number;                  // boss sequence count (ring2/sweep emission)
  bp: number;                  // boss burst parity (sweep wheel offset)
}

// A server-owned enemy. Positions interpolate; the rest is the latest authoritative value.
export interface EnemyWire {
  id: number; kind: EnemyKind;
  x: number; y: number;
  hp: number; mhp: number; r: number;
  tr: EnemyTier;               // variety tier (drives the client's draw scale + markers)
  atk: AttackWire;
  bph: number;                 // boss phase (0 when not a boss) — drives the per-phase base look
  // The boss transition BEAT is live (its roar/shield/molt/merge is mid-flight). Serialized
  // straight from `boss.roar !== null` (false for non-bosses) so transition-beat + merge-fuse
  // VFX can bind to the authoritative flag rather than re-deriving it from move/phase edges.
  brr: boolean;
  // JET's current MIRROR salvo lead Resonance-family index (0..5 into RESONANCE_FAMILIES), or
  // -1 when the commitment isn't a mirror salvo. Drives the copied weapon's telegraph SHAPE +
  // its own family hue (the "that's my gun" read); the sim tints the shards with the same enum.
  mfm: number;
  // The per-kind auxiliary channel (see Enemy.aux): sinderling armed flag, echo/knell
  // fuse, fragment tether id + 1, bulwark plate HP. For the earned-window bosses this IS the
  // authoritative EXPOSED remainder (seconds left; 0 = guarded — the same flag the damage gate
  // reads via boss.exposed), which enemyFromWire restores into boss.exposed so art can't desync.
  aux: number;
  // The ROLLED elite affix id ("splits"/"shielded"/"hazardTrail"/"reflect"/"enrage"), or "" for
  // none (v16) — drives the client's material affix tell.
  afx: string;
  // The rolled affix's per-body scalar (its OWN channel, never aux): a shielded slab's HP, a
  // reflect facet's armed state (>0 = armed). 0 for other affixes. Drives the armed/slab render.
  afs: number;
  // JET mirror-image echo (kind "jet_echo"): the PlayerId this reflection mirrors, or "" when the
  // body is not an echo. Drives the co-op read ("that's ME" for the mirrored player, "[name]'s
  // reflection" for teammates); enemyFromWire restores it into Enemy.mirrorOf.
  mir: string;
  burn: number; chill: number; shock: number;
  // PHANTOM dash-through MARK seconds remaining (Wave 2): a shared authoritative vulnerability so
  // every client renders the marked glow (0 = unmarked). enemyFromWire restores it into markT.
  mkt: number;
}

export interface BulletWire {
  x: number; y: number; vx: number; vy: number;
  r: number; friend: boolean; color: string;
  fx: WeaponId | null;
  sm: SluiceMode | null;
  go: OddsmakerOutcome | null;
}

// Shared world content: every client sees the SAME authoritative props/pickups/chests, so
// loot/objective state is identical. These are near-static (state flips on break/open/collect),
// so they ride the snapshot as discrete values — no interpolation needed. All three carry the
// sim's STABLE per-floor id (interest hysteresis + client anim keying + lifecycle identity).
export interface PropWire { id: number; kind: PropKind; x: number; y: number; brk: number } // brk<0 => intact
export interface PickupWire { id: number; kind: PickupKind; x: number; y: number; wpn: WeaponId | null; val: number; bch: boolean; myst: boolean } // val<0 => face value; bch = boss weapon choice; myst = unidentified (wpn hidden)
export interface ChestWire { id: number; kind: ChestKind; x: number; y: number; op: boolean; opt: number } // opt<0 => not yet open
// Authored ground hazards (webs): bounded (hard sim cap), gameplay-relevant everywhere
// (they slow PREDICTED movement), so they ride every snapshot unfiltered.
export interface HazardWire { id: number; k: HazardKind; x: number; y: number; r: number; life: number; max: number }
// Weapon effect entities (the effect wave): one flat struct covers every kind — unused
// geometry fields ride as 0/-1 defaults so the validator stays a single table. Bounded
// by hard sim caps per family (like hazards), so they ride every snapshot unfiltered.
export interface EffectWire {
  id: number;
  k: EffectKind;
  o: string;              // owner player id ("" = departed owner)
  fx: WeaponId;           // authoring weapon (render recipe)
  x: number; y: number;
  x2: number; y2: number; // wire span end (wires only)
  r: number;              // zone radius / orbit ring / sentry body / tether sweep reach
  n: number;              // orbit blade count
  a: number;              // orbit blade phase (rad)
  fl: number;             // orbit flare seconds left
  arm: number;            // wire arm seconds left (0 = live)
  hp: number; mhp: number;// sentry durability (-1 = not a sentry)
  eid: number;            // tethered enemy id (-1 = none)
  life: number; max: number;
}

// Patch's shop stall (shop floors only, ≤5 slots): the authoritative stock every client
// renders and buys against. Global like hazards — the shop is a shared objective and its
// SOLD/claim state must never be hidden by interest filtering. sold = the claiming buyer
// of a shared slot; by = the players who already bought a personal (FOR YOU) slot.
export interface ShopSlotWire {
  id: number; k: ShopSlotKind; sh: boolean;
  wpn: WeaponId | null; it: string | null;
  pr: number; x: number; y: number;
  sold: PlayerId | null; by: PlayerId[];
  myst: boolean; // mystery pedestal: wpn is hidden (null) on the wire until a buy reveals
}
// Batch0 encounter status (HUD/reconnect). Compact plain-data; flags stay sim-internal.
export interface EncounterWire {
  k: string;   // kind
  a: boolean;  // active
  sk: string;  // structureKind
  cr: number;  // currentRoomId
  re: number;  // routeEdgeId (-1 = null)
  cp: number;  // checkpoint
  op: number;  // objectiveProgress
  ca: string;  // carrierPlayerId ("" = null)
  fc: number;  // failureCount
  co: boolean; // completed
  fa: boolean; // failed
}
export interface ShopWire { md: ShopMode; kx: number; ky: number; ru: number; slots: ShopSlotWire[] }

// PVP FFA match block — ONE small top-level object on the snapshot (never smeared across every
// entity). The phase timer rides as an ABSOLUTE end-tick (`end`), so it changes only on phase
// transitions (not every tick) and the client derives "seconds left" from `end - tick`. The
// per-player scoreboard (frags + alive) changes only on kills/deaths/respawns, so the whole
// block delta-encodes as one rarely-changing object. null in co-op.
export interface MatchScoreWire { id: PlayerId; f: number; a: boolean } // frags, alive
export interface MatchWire {
  ph: MatchPhase;        // "lobby" | "countdown" | "live" | "over"
  end: number;           // absolute tick the current TIMED phase ends (0 = untimed)
  sc: MatchScoreWire[];  // per-player frags + alive (the authoritative scoreboard)
  win: PlayerId | null;  // winner id once phase === "over" (null otherwise)
}

// ---- messages ----

// Client -> server. The client authors INPUTS/INTENTS ONLY.
export type ClientMsg =
  // resume (optional): the single-use seat token from a previous connection's full snapshot.
  // Presenting it with a fresh valid ticket reclaims the reserved body (same player id, same
  // state, same world) instead of spawning a new one.
  | { t: "join"; ticket: string; protocol: number; resume?: string }
  // Deliberate goodbye: the player is leaving on purpose (quit to lobby / run end), so the
  // server must NOT reserve a reconnect seat for this connection.
  | { t: "leave" }
  // An input is an INTENT SAMPLE, not a time authority: it carries NO dt. The server advances
  // simulation time by its own fixed tick (one command = one fixed step), so a client can't buy
  // extra time by claiming a large dt. `ackEv` piggybacks the reliable-event ack (last event id
  // the client has processed) so the server can stop resending delivered events. `act` is the
  // interact intent (the held revive-channel key) — the sim validates proximity/liveness, so
  // the bit alone can never conjure a revive.
  // `ackSnap` (v24): the highest snapshot sseq this client has applied + retained as its delta
  // baseline. The server deltas the next snapshot against exactly that baseline (or sends a
  // full keyframe if it can no longer honor it), so a missed baseline can never be applied.
  | { t: "input"; seq: number; mx: number; my: number; aim: number; fire: boolean; dash: boolean; act: boolean; ult: boolean; pulse: boolean; ackEv: number; ackSnap: number }
  | { t: "pong"; id: number }
  // Spectate intent: which teammate a DOWNED player's camera follows. Pure view preference —
  // the server uses it only to center that client's interest view (and positional events)
  // while they are down; it never touches the sim, and an invalid/living-player target is
  // simply ignored (the publisher falls back to the first living teammate).
  | { t: "spec"; target: string }
  // Authoritative weapon equip: the server equips ONLY if the id is in the player's owned set
  // (a tampered client can't equip an unowned weapon). cseq is a monotonic command sequence:
  // the server ignores stale/duplicate commands so a resent equip can never double-apply or
  // regress a newer choice. Never carries any outcome.
  | { t: "equip"; weapon: WeaponId; cseq: number }
  // Authoritative inventory reorder: move the hotbar slot at `from` to position `to` (all
  // other slots keep relative order). The server validates both indices against the CURRENT
  // authoritative inventory — a stale index (inventory changed in flight) rejects, never
  // misplaces. Same cseq idempotency as equip. Never carries weapon ids or any outcome.
  | { t: "reorder"; from: number; to: number; cseq: number }
  // Authoritative weapon drop: request dropping an OWNED weapon into the world. Named by id
  // (not slot index) so a drop racing a reorder can never discard the wrong weapon. The
  // server validates ownership + player state and picks the spawn spot itself; the pickup
  // and the updated inventory flow back via snapshot. Same cseq idempotency as equip.
  | { t: "drop"; weapon: WeaponId; cseq: number }
  // Authoritative full-hotbar swap (v9): trade the OWNED weapon `drop` for the weapon
  // pickup `pickup` (the sim's stable per-floor pickup id) the player is standing on.
  // Only valid AT the hotbar cap — below it a walk-over collects. The server validates
  // everything (fullness, ownership, pickup liveness/range/claimability) and performs the
  // trade atomically: the replaced weapon lands as a normal world pickup, the incoming
  // one is acquired + equipped. Declining sends nothing. Same cseq idempotency as equip.
  | { t: "swap"; pickup: number; drop: WeaponId; cseq: number }
  // Authoritative blessing choice: names the server offer it answers (offerId) + the chosen
  // item. The server validates offerId against the live pending offer (id match, not expired)
  // and choiceId against that offer's choice set, then applies the mods server-side.
  | { t: "chooseBlessing"; offerId: number; choiceId: string }
  // Authoritative shop purchase (Patch's room): the EXPLICIT buy intent behind the panel's
  // BUY button — the only way coins move at the stall (stepping on a pedestal sends
  // nothing). Names the slot; the sim validates everything (liveness, proximity, price,
  // the per-viewer status matrix) and an invalid buy mutates nothing. Same cseq
  // idempotency as equip: a resent command can never double-charge.
  | { t: "shopBuy"; slot: number; cseq: number }
  // Client netcode telemetry uplink (observability + the lag-comp render-delay sample `dly`,
  // which the server clamps to the adaptive [90,300]ms window — a lie can only mis-rewind the
  // sender's own shots within that bounded window).
  | { t: "stat"; rtt: number; jit: number; rec: number; corr: number; dly: number };

// Server -> client.
export type ServerMsg =
  | {
      t: "snap";
      sseq: number;              // per-connection monotonic snapshot sequence (v24): the ack
                                 // target + delta baseline id. A `snap` is a COMPLETE keyframe
                                 // and always (re)establishes the client's delta baseline.
      tick: number;
      rev: number;               // world revision (increments per floor build/run reset)
      ackSeq: number;            // last input seq from THIS client the server CONSUMED
      full: boolean;             // bootstrap (join/resume) keyframe: resets offers + the event
                                 // stream (a mid-stream state keyframe is full:false)
      over: boolean;             // terminal run state (party wiped) — derivable from STATE
      selfId: PlayerId;          // this client's server-assigned id (on every snap so a dropped
                                 // join snapshot never loses identity)
      wid: string;               // the authoritative world id this connection is BOUND to —
                                 // the client asserts it against the expected room world and
                                 // refuses to play on a mismatch
      roster: RosterWire[];      // every seat in this world (verified identities + on/away),
                                 // interest-INDEPENDENT — drives readiness + the HUD count
      wait: WaitWire[];          // players still deciding a blessing offer (pid + seconds
                                 // left) — the party-wait state everyone sees identically,
                                 // so a held descend gate is explicit and NEVER indefinite
      tok?: string;              // single-use resume token for THIS connection (full snaps
                                 // only) — presented on reconnect to reclaim the seat
      seed: number;              // authoritative run seed (client rebuilds the identical dungeon)
      cat: ContentCatalogVersion;// authoritative immutable run content catalog
      floor: number;             // authoritative floor number (objective/HUD)
      pcl: number;               // co-op player count LOCKED at floor pull (1..4) — the client
                                 // resolves the identical floor descriptor (mutators/affixes) with
                                 // it; never rescaled mid-floor on join/down/disconnect
      cleared: boolean;          // authoritative floor-cleared / exit-open flag (global objective)
      exr: PlayerId[];           // living players standing at the cleared exit — the SAME
                                 // predicate the descend gate requires, on the wire (drives
                                 // the "WAITING AT EXIT · N/M" coordination readout)
      evTo: number;              // highest committed event id — the client acks up to here even
                                 // when every pending event was interest-filtered away for it
      self: SelfWire | null;     // authoritative local player (null until spawned)
      players: PlayerWire[];     // OTHER players — the whole party, NEVER interest-filtered
                                 // (teammates are shared objectives: spectate targets, roster,
                                 // minimap, revive prompts all need every member)
      enemies: EnemyWire[];
      bullets: BulletWire[];
      props: PropWire[];         // shared destructibles
      pickups: PickupWire[];     // shared loot on the ground
      chests: ChestWire[];       // shared chests (incl. the boss chest)
      hzds: HazardWire[];        // shared ground hazards (the Weaver's webs)
      shop: ShopWire | null;     // Patch's stall (shop floors only) — stock + claim state
      effs: EffectWire[];        // shared weapon effect entities (the effect wave)
      match: MatchWire | null;   // pvp FFA match block (phase/timer/scores/winner); null in co-op
      enc: EncounterWire | null; // Batch0 encounter status (null on non-encounter floors)
      events: WireEvent[];       // reliable, id-tagged events (dedupe + ack) -> client replays juice
    }
  // Snapshot DELTA (v24): only what CHANGED since the baseline snapshot `b` (the client's last
  // acknowledged sseq). `sc` = changed top-level scalars; `self` = self change; en/pl/pr/pk/ch/
  // hz/ef = per keyed-list adds/changes (`u`) + removal tombstones (`r`, tagged gone/left);
  // `w` = whole-replace small lists (roster/wait/exr/bullets/shop); ev/et = the reliable event
  // stream (verbatim, so exactly-once holds across a keyframe). The client reconstructs the
  // complete snapshot against its baseline and validates it through the snapshot validator.
  | {
      t: "snapd";
      q: number;                 // this frame's sseq
      b: number;                 // the baseline sseq this delta applies to
      sc: WireObject;            // changed top-level scalars (always carries at least `tick`)
      self?: SelfDelta;
      en?: KeyedDelta; pl?: KeyedDelta; pr?: KeyedDelta; pk?: KeyedDelta; ch?: KeyedDelta; hz?: KeyedDelta; ef?: KeyedDelta;
      w?: WireObject;
      ev: WireEvent[];
      et: number;
    }
  | { t: "ping"; id: number; tick: number; time: number }
  // A server-decided blessing offer for this client (seeded choice set), carrying a monotonic
  // `id` so it is idempotent: the server resends it (bounded) until the choice arrives or the
  // offer expires, and the client shows each id only once (no double prompt from resends). The
  // client replies with `chooseBlessing {offerId, choiceId}`; choice authority stays server-side.
  | { t: "offer"; id: number; choices: string[]; k: "blessing" | "pvp_draft"; tr: PvpDraftTrigger; isComeback: boolean }
  | { t: "error"; code: string; msg: string };

// The complete snapshot message (a keyframe). The delta channel reconstructs one of these
// against a baseline before applying, so both ends speak the same decoded shape.
export type SnapMsg = Extract<ServerMsg, { t: "snap" }>;

// ---- Codec seam (JSON now; binary is a later swap) ----

export class ProtocolError extends Error {}

export interface Codec {
  encodeServer(msg: ServerMsg): string;
  decodeServer(raw: string): ServerMsg;   // client side (server is trusted, but still validated)
  encodeClient(msg: ClientMsg): string;
  decodeClient(raw: string): ClientMsg;    // server side (STRICT — untrusted input)
}

// Guard against giant client payloads before we even parse (a client can't make us buffer MBs).
const MAX_RAW_BYTES = 4096;

// ---- primitive validators ----

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function num(o: Record<string, unknown>, k: string, lo: number, hi: number): number {
  const v = o[k];
  if (!isFiniteNum(v) || v < lo || v > hi) throw new ProtocolError(`bad ${k}`);
  return v;
}
function intOf(o: Record<string, unknown>, k: string, lo: number, hi: number): number {
  const v = num(o, k, lo, hi);
  if (Math.floor(v) !== v) throw new ProtocolError(`bad ${k}`);
  return v;
}
function boolOf(o: Record<string, unknown>, k: string): boolean {
  const v = o[k];
  if (typeof v !== "boolean") throw new ProtocolError(`bad ${k}`);
  return v;
}
function shortStr(o: Record<string, unknown>, k: string, max: number): string {
  const v = o[k];
  if (typeof v !== "string" || v.length < 1 || v.length > max) throw new ProtocolError(`bad ${k}`);
  return v;
}
// A rolled-affix id: a short string, or "" for none. Distinct from shortStr because the empty
// string is a valid value here (the common "no rolled affix" case).
function affixOf(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== "string" || v.length > 16) throw new ProtocolError(`bad ${k}`);
  return v;
}
// A PlayerId reference, or "" for none (the JET echo's mirrored-player field). Empty is a
// valid value here — most bodies are not echoes — so it is distinct from shortStr.
function idRefOf(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== "string" || v.length > 32) throw new ProtocolError(`bad ${k}`);
  return v;
}
function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ProtocolError(`bad ${what}`);
  return v as Record<string, unknown>;
}
function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new ProtocolError(`bad ${what}`);
  return v;
}

// Security-sensitive client messages allow EXACTLY their declared fields — a smuggled extra
// field (e.g. a client-authored `dt`) is a protocol error, not silently ignored.
function exactKeys(o: Record<string, unknown>, keys: readonly string[]): void {
  const ks = Object.keys(o);
  if (ks.length !== keys.length) throw new ProtocolError("unexpected fields");
  for (const k of ks) if (!keys.includes(k)) throw new ProtocolError(`unexpected field ${k}`);
}

// ---- closed-set validators (derived from sim tables so the unions can't drift) ----

function isWeaponId(v: unknown): v is WeaponId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(WEAPONS, v);
}
function weaponOf(o: Record<string, unknown>, k: string): WeaponId {
  const v = o[k];
  if (!isWeaponId(v)) throw new ProtocolError(`bad ${k}`);
  return v;
}
function isEnemyKind(v: unknown): v is EnemyKind {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(ENEMY_ARCHETYPES, v);
}
function kitOf(o: Record<string, unknown>, k: string): KitId {
  const v = o[k];
  if (!isKitId(v)) throw new ProtocolError(`bad ${k}`);
  return v;
}
const PROP_KINDS: Record<PropKind, true> = {
  crate: true, pot: true, barrel: true, barrel_explosive: true, brazier: true,
  root_wall: true, silt_mound: true, clinker_brick: true, // worker constructions (ecology gate)
  gorge_debris: true, // the GORGE giant's sloughed shell cover (F50)
  pale_debris: true, // the PALE THRONE giant's sloughed shell cover (F75)
};
const PICKUP_KINDS: Record<PickupKind, true> = { heart: true, coin: true, weapon: true };
const SHOP_SLOT_KINDS: Record<ShopSlotKind, true> = {
  weapon: true, blessing: true, heart: true, reroll: true,
  mystery: true, legendary: true, rare_blessing: true, max_hp: true, full_heal: true,
  core_infusion: true, weapon_upgrade: true, revive_token: true, extra_slot: true,
  reroll_all: true, amber_cache: true, prospector: true, artifact: true,
  mythic_weapon: true, mythic_trio: true, mythic_amber: true,
};
const SHOP_MODES: Record<ShopMode, true> = { dealer: true, premium: true, spoils: true, climax: true };
const MATCH_PHASES: Record<MatchPhase, true> = { lobby: true, countdown: true, live: true, over: true };
const CHEST_KINDS: Record<ChestKind, true> = { wood: true, boss: true };
const HAZARD_KINDS: Record<HazardKind, true> = { web: true, cinder: true, charge: true, omen: true, corrupt: true };
const EFFECT_KINDS: Record<EffectKind, true> = { zone: true, wire: true, orbit: true, sentry: true, tether: true, sanctuary: true, aegis: true };
const ATTACK_PHASES: Record<AttackPhase, true> = { none: true, windup: true, active: true, recover: true };
const ATTACK_MOVES: Record<AttackMove, true> = {
  none: true, lunge: true, spit: true, hopslam: true, radial: true, roar: true, squeeze: true,
  rush: true, crash: true, dive: true, erupt: true, volley: true, spin: true, shield: true,
  fade: true, wail: true, split: true, pounce: true, weave: true, slam: true, sweep: true,
  brace: true,
  decoy: true, blink: true, seam: true, stoke: true, harmonize: true, knell: true,
  build: true, // the worker verb (bailiff divider, mason L-corner, the Tithe's feeding slab)
  mirror: true, merge: true, // Wave 1: JET's corrupted-Resonance salvo, Quorum's fuse-merge
  // Wave 1 rework — the deep bosses' interleaved pressure moves (v19) + the Tithe's dedicated
  // P3 rip signature (v23).
  tracer: true, beam: true, spew: true, hurl: true, rip: true,
  // v35 SEVER F55 signature — display name WORLDSPLIT everywhere client-facing.
  worldsplit: true,
  // PALE F75 signature — display name THE LAST LIGHT FALLS; wire id last_light.
  // Fits existing AttackWire/EncounterState flags — no PROTOCOL_VERSION bump required.
  last_light: true,
  // HOLLOW CHOIRMASTER F60 signature — display name THE LAST NOTE; wire id last_note.
  last_note: true,
  // UNDERTOW F65 signature — display name THE RIVER COMES BACK; wire id river_comes_back.
  // Never black_tide.
  river_comes_back: true,
  // CLAIMANT F70 signature — display name ALL THINGS OWED; wire id all_things_owed.
  // Never crownfall.
  all_things_owed: true,
  // THE WAKE F80 signature — display name THE LAST PROCESSION; wire id last_procession.
  // Never nightfall_procession.
  last_procession: true,
};
const ENEMY_TIERS: Record<EnemyTier, true> = { swarm: true, standard: true, brute: true, elite: true };
const SLUICE_MODES: Record<SluiceMode, true> = { flood: true, drain: true };
const ODDSMAKER_OUTCOMES: Record<OddsmakerOutcome, true> = {
  ricochet: true, seeker: true, blast: true, pierce: true,
};
const SHOT_MODES: Record<SluiceMode | "none", true> = {
  flood: true, drain: true, none: true,
};
const SHOT_OUTCOMES: Record<OddsmakerOutcome | "none", true> = {
  ricochet: true, seeker: true, blast: true, pierce: true, none: true,
};
function inSet<T extends string>(set: Record<T, true>, v: unknown, what: string): T {
  if (typeof v !== "string" || !Object.prototype.hasOwnProperty.call(set, v)) throw new ProtocolError(`bad ${what}`);
  return v as T;
}

// ---- event schema table ----
// ONE table drives both the runtime validator (server->client decode) and the server's
// per-client interest scope. Record<SimEvent["t"], ...> makes it compile-time exhaustive: a new
// SimEvent variant will not compile until its wire schema + scope are declared here.

type FieldKind = "num" | "str" | "bool";
// Scope for interest filtering: "global" reaches every client, "pid" only the named player,
// "pos" only clients whose interest view covers (x,y) — distant one-shot FX stop leaking
// worldwide shake/audio and bandwidth.
export type EventScopeKind = "global" | "pid" | "pos";
interface EventSpec { scope: EventScopeKind; fields: Record<string, FieldKind> }

const EVENT_SPECS: Record<SimEvent["t"], EventSpec> = {
  // Positional (v14): a networked player's own combat FX must reach every NEARBY client, not
  // only the actor — a teammate's shot/swing/hurt/heal/pickup should be seen and heard
  // POSITIONALLY (the client branches self vs remote in handleSimEvent). They already carry
  // x,y, so interest filtering delivers them to observers within range.
  shot: {
    scope: "pos",
    fields: {
      pid: "str", weapon: "str", x: "num", y: "num", aim: "num", px: "num", py: "num",
      chg: "num", mode: "str", outcome: "str",
    },
  },
  meleeSwing: { scope: "pos", fields: { pid: "str", weapon: "str", x: "num", y: "num", aim: "num", bx: "num", by: "num" } },
  enemyHit: { scope: "pos", fields: { eid: "num", dmgX: "num", dmgY: "num", dmg: "num", crit: "bool", puffX: "num", puffY: "num", puffColor: "str", melee: "bool", closeShotgun: "bool", killed: "bool" } },
  thornsHit: { scope: "pos", fields: { eid: "num", x: "num", y: "num", radius: "num", dmg: "num", tint: "str" } },
  burnTick: { scope: "pos", fields: { x: "num", y: "num", radius: "num", dmg: "num" } },
  shockArc: { scope: "pos", fields: { eid: "num", x: "num", y: "num", tx: "num", ty: "num", tRadius: "num", dmg: "num", color: "str", killed: "bool" } },
  enemyKill: { scope: "pos", fields: { eid: "num", kind: "str", tier: "str", x: "num", y: "num", combo: "num", by: "str" } },
  heal: { scope: "pos", fields: { pid: "str", x: "num", y: "num" } },
  // Deliberately pid-scoped: these drive the DASHER's own juice. Teammates render a remote
  // dash off the PlayerWire dash state (dti/ddx/ddy — v9), which is interp-aligned with the
  // rendered position; broadcasting these events too would double-play the FX.
  dashStart: { scope: "pid", fields: { pid: "str", x: "num", y: "num" } },
  dashTrail: { scope: "pid", fields: { pid: "str", x: "num", y: "num" } },
  playerHurt: { scope: "pos", fields: { pid: "str", x: "num", y: "num" } },
  itemPicked: { scope: "pid", fields: { pid: "str", x: "num", y: "num", tint: "str" } },
  offerBlessing: { scope: "pid", fields: { pid: "str", rare: "bool" } },
  blessingExpired: { scope: "pid", fields: { pid: "str" } },
  // Positional: the revive moment plays for everyone standing at it (the reviver most of
  // all), not only the revived player. The revived player is AT the point by definition.
  revive: { scope: "pos", fields: { pid: "str", by: "str", x: "num", y: "num" } },
  // Positional (v14): the playful friendly-fire bonk plays for everyone standing at it.
  friendlyNudge: { scope: "pos", fields: { shooterId: "str", targetId: "str", x: "num", y: "num", dirX: "num", dirY: "num" } },
  grappleResolved: { scope: "pos", fields: { pid: "str", x: "num", y: "num", tx: "num", ty: "num", dx: "num", dy: "num" } },
  blessingProc: { scope: "pos", fields: { pid: "str", item: "str", phase: "str", x: "num", y: "num" } },
  reviveHandoff: { scope: "pos", fields: { pid: "str", from: "str", to: "str", isBoosted: "bool", x: "num", y: "num" } },
  pickup: { scope: "pos", fields: { pid: "str", kind: "str", x: "num", y: "num" } },
  lootDrop: { scope: "pos", fields: { x: "num", y: "num", color: "str" } },
  // Positional: the reveal moment plays for everyone standing at the pedestal, not only
  // the collector (the gamble resolving is shared theater).
  mysteryReveal: { scope: "pos", fields: { pid: "str", weapon: "str", twist: "str", x: "num", y: "num" } },
  shopBuy: { scope: "pos", fields: { pid: "str", slot: "num", kind: "str", x: "num", y: "num" } },
  weaponDrop: { scope: "pos", fields: { weapon: "str", x: "num", y: "num" } },
  wirePlanted: { scope: "pos", fields: { x: "num", y: "num", tx: "num", ty: "num" } },
  wireArmed: { scope: "pos", fields: { x: "num", y: "num" } },
  wireSnap: { scope: "pos", fields: { x: "num", y: "num", tx: "num", ty: "num" } },
  wireExpired: { scope: "pos", fields: { x: "num", y: "num" } },
  wireRefused: { scope: "pos", fields: { x: "num", y: "num" } },
  haloFlare: { scope: "pos", fields: { x: "num", y: "num", r: "num" } },
  sentryPlaced: { scope: "pos", fields: { x: "num", y: "num" } },
  sentryAcquire: { scope: "pos", fields: { x: "num", y: "num" } },
  sentryShot: { scope: "pos", fields: { x: "num", y: "num", aim: "num" } },
  sentryHit: { scope: "pos", fields: { x: "num", y: "num" } },
  sentryDown: { scope: "pos", fields: { x: "num", y: "num", why: "str" } },
  tetherLatch: { scope: "pos", fields: { eid: "num", x: "num", y: "num", tx: "num", ty: "num", inv: "bool" } },
  tetherHold: { scope: "pos", fields: { x: "num", y: "num" } },
  tetherSweep: { scope: "pos", fields: { x: "num", y: "num", r: "num" } },
  // KIT ULTIMATES (v18): positional cast FX. Each carries only integers + the caster id; the
  // Sanctuary zone / Aegis dome themselves ride the effs list, reconciled from the snapshot.
  ultOverdrive: { scope: "pos", fields: { pid: "str", x: "num", y: "num", durationTicks: "num" } },
  ultSanctuary: { scope: "pos", fields: { pid: "str", x: "num", y: "num", radius: "num", lifetimeTicks: "num" } },
  ultAegis: { scope: "pos", fields: { pid: "str", x: "num", y: "num", radius: "num", hpBudget: "num", lifetimeTicks: "num" } },
  ultPhase: { scope: "pos", fields: { pid: "str", x: "num", y: "num", radius: "num", invulnTicks: "num", speedTicks: "num" } },
  statusApplied: { scope: "pos", fields: { eid: "num", x: "num", y: "num", kind: "str" } },
  frozeSolid: { scope: "pos", fields: { eid: "num", x: "num", y: "num" } },
  freezeBroke: { scope: "pos", fields: { eid: "num", x: "num", y: "num" } },
  bulletWall: { scope: "pos", fields: { x: "num", y: "num", aim: "num" } },
  bulletBounce: { scope: "pos", fields: { x: "num", y: "num", aim: "num", color: "str" } },
  bulletExpire: { scope: "pos", fields: { x: "num", y: "num", color: "str" } },
  bulletBlocked: { scope: "pos", fields: { kind: "str", x: "num", y: "num", aim: "num" } },
  propHit: { scope: "pos", fields: { propId: "num", kind: "str", x: "num", y: "num" } },
  propBreak: { scope: "pos", fields: { kind: "str", x: "num", y: "num" } },
  explosion: { scope: "pos", fields: { x: "num", y: "num", r: "num", src: "str" } },
  implosion: { scope: "pos", fields: { x: "num", y: "num", r: "num" } },
  chestOpen: { scope: "pos", fields: { kind: "str", x: "num", y: "num" } },
  hazardHit: { scope: "pos", fields: { pid: "str", kind: "str", x: "num", y: "num" } },
  spitMuzzle: { scope: "pos", fields: { x: "num", y: "num" } },
  lungeTrail: { scope: "pos", fields: { x: "num", y: "num" } },
  chargeCrash: { scope: "pos", fields: { x: "num", y: "num" } },
  burrowDive: { scope: "pos", fields: { x: "num", y: "num" } },
  burrowErupt: { scope: "pos", fields: { x: "num", y: "num", r: "num" } },
  bossSlam: { scope: "pos", fields: { x: "num", y: "num" } },
  radialBurst: { scope: "pos", fields: { x: "num", y: "num" } },
  bossVolley: { scope: "pos", fields: { x: "num", y: "num" } },
  webPlaced: { scope: "pos", fields: { x: "num", y: "num", r: "num" } },
  bossAddSpawn: { scope: "pos", fields: { eid: "num", x: "num", y: "num", mx: "num", my: "num", spawned: "bool" } },
  // Global: shared-objective transitions every client must see regardless of distance.
  bossPhase: { scope: "global", fields: { eid: "num", x: "num", y: "num" } },
  bossTransition: { scope: "global", fields: { eid: "num", phase: "num", entering: "bool", queued: "num", hpFrac: "num" } },
  enemySpawn: { scope: "pos", fields: { eid: "num", kind: "str", tier: "str", x: "num", y: "num" } },
  descend: { scope: "global", fields: { toFloor: "num" } },
  reachExit: { scope: "global", fields: { toFloor: "num" } },
  gameOver: { scope: "pid", fields: { pid: "str" } },
  // PVP: positional elimination juice (everyone near the kill sees it); the authoritative
  // scoreboard rides the match block. Match-over is global (every client shows the result).
  pvpKill: { scope: "pos", fields: { by: "str", victim: "str", x: "num", y: "num" } },
  pvpRingOut: { scope: "pos", fields: { by: "str", victim: "str", x: "num", y: "num" } },
  pvpChainFrag: { scope: "pos", fields: { by: "str", chain: "num", x: "num", y: "num" } },
  pvpShieldBreak: { scope: "pos", fields: { pid: "str", x: "num", y: "num" } },
  pvpSpawnAttackBlocked: { scope: "pid", fields: { pid: "str", x: "num", y: "num" } },
  pvpSuddenDeath: { scope: "global", fields: { leader: "str" } },
  pvpDraftTriggered: { scope: "pid", fields: { pid: "str", source: "str", isComeback: "bool", ordinal: "num", score: "num", leaderScore: "num" } },
  pvpDraftOffered: { scope: "pid", fields: { pid: "str", source: "str", isComeback: "bool", ordinal: "num", items: "str" } },
  pvpDraftPicked: { scope: "pid", fields: { pid: "str", source: "str", isComeback: "bool", ordinal: "num", item: "str", level: "num", latencyTicks: "num", hp: "num", score: "num", leaderScore: "num" } },
  pvpDraftResolved: { scope: "pid", fields: { pid: "str", source: "str", ordinal: "num", outcome: "str", latencyTicks: "num" } },
  pvpDraftDelayed: { scope: "pid", fields: { pid: "str", ordinal: "num", reason: "str", remainingTicks: "num" } },
  pvpMatchOver: { scope: "global", fields: { winner: "str" } },
  // flash/trauma carry no position — rare, tiny, and safe to deliver globally.
  flash: { scope: "global", fields: { eid: "num" } },
  puff: { scope: "pos", fields: { x: "num", y: "num", n: "num", color: "str" } },
  trauma: { scope: "global", fields: { amount: "num" } },
  cue: { scope: "pos", fields: { name: "str", x: "num", y: "num", rate: "num", gain: "num", trauma: "num" } },
};

// Resolve one event's interest scope for server-side filtering. "pos" events expose their
// coordinates; "pid" events their target player.
export type EventScope =
  | { kind: "global" }
  | { kind: "pid"; pid: PlayerId }
  | { kind: "pos"; x: number; y: number };

export function eventScope(e: SimEvent): EventScope {
  const spec = EVENT_SPECS[e.t];
  if (spec.scope === "pid") return { kind: "pid", pid: (e as { pid: PlayerId }).pid };
  if (spec.scope === "pos") {
    const p = e as unknown as Record<string, unknown>;
    const x = p.x, y = p.y;
    if (isFiniteNum(x) && isFiniteNum(y)) return { kind: "pos", x, y };
    return { kind: "global" };
  }
  return { kind: "global" };
}

function validateEvent(v: unknown): SimEvent {
  const o = obj(v, "event");
  const t = o.t;
  if (typeof t !== "string" || !Object.prototype.hasOwnProperty.call(EVENT_SPECS, t)) throw new ProtocolError(`bad event type ${String(t)}`);
  const spec = EVENT_SPECS[t as SimEvent["t"]];
  for (const [field, kind] of Object.entries(spec.fields)) {
    const val = o[field];
    if (kind === "num" && !isFiniteNum(val)) throw new ProtocolError(`bad event ${t}.${field}`);
    if (kind === "str" && typeof val !== "string") throw new ProtocolError(`bad event ${t}.${field}`);
    if (kind === "bool" && typeof val !== "boolean") throw new ProtocolError(`bad event ${t}.${field}`);
  }
  if (t === "shot") {
    inSet(SHOT_MODES, o.mode, "event shot.mode");
    inSet(SHOT_OUTCOMES, o.outcome, "event shot.outcome");
  }
  return o as unknown as SimEvent;
}

// ---- strict client decode (untrusted input) ----

// Rejects unknown types, wrong shapes, non-finite numbers, out-of-range values, oversized
// strings, and UNKNOWN FIELDS. NEVER throws anything but ProtocolError (the server isolates it
// per-connection); a fuzzer cannot reach the tick loop.
function decodeClientMsg(raw: string): ClientMsg {
  if (typeof raw !== "string") throw new ProtocolError("non-string frame");
  if (raw.length > MAX_RAW_BYTES) throw new ProtocolError("oversized");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolError("bad json");
  }
  const o = obj(parsed, "frame");
  switch (o.t) {
    case "join": {
      // `resume` is the ONE optional field on a security-sensitive frame: validate the two
      // allowed shapes exactly (with/without it) — anything else is still an error.
      exactKeys(o, o.resume === undefined ? ["t", "ticket", "protocol"] : ["t", "ticket", "protocol", "resume"]);
      const ticket = shortStr(o, "ticket", 512);
      // Protocol must be an explicit finite integer (no defaulting to 0 — that was a bypass).
      // The join handler additionally enforces it EQUALS the current PROTOCOL_VERSION.
      const protocol = intOf(o, "protocol", 0, 1e6);
      if (o.resume === undefined) return { t: "join", ticket, protocol };
      return { t: "join", ticket, protocol, resume: shortStr(o, "resume", 64) };
    }
    case "leave": {
      exactKeys(o, ["t"]);
      return { t: "leave" };
    }
    case "input": {
      // seq + ackEv: non-negative safe integers. NO dt — inputs are intent samples; the server
      // tick owns simulation time, and exactKeys rejects a smuggled dt outright.
      exactKeys(o, ["t", "seq", "mx", "my", "aim", "fire", "dash", "act", "ult", "pulse", "ackEv", "ackSnap"]);
      return {
        t: "input",
        seq: intOf(o, "seq", 0, Number.MAX_SAFE_INTEGER),
        mx: num(o, "mx", -8, 8),         // raw axis; server clamps to unit length
        my: num(o, "my", -8, 8),
        aim: num(o, "aim", -1000, 1000), // radians; unbounded angle is fine to clamp loosely
        fire: boolOf(o, "fire"),
        dash: boolOf(o, "dash"),
        act: boolOf(o, "act"),
        ult: boolOf(o, "ult"),
        pulse: boolOf(o, "pulse"),
        ackEv: intOf(o, "ackEv", 0, Number.MAX_SAFE_INTEGER),
        ackSnap: intOf(o, "ackSnap", 0, Number.MAX_SAFE_INTEGER),
      };
    }
    case "pong": {
      exactKeys(o, ["t", "id"]);
      return { t: "pong", id: intOf(o, "id", 0, Number.MAX_SAFE_INTEGER) };
    }
    case "spec": {
      exactKeys(o, ["t", "target"]);
      return { t: "spec", target: shortStr(o, "target", 64) };
    }
    case "equip": {
      // The weapon id must be a KNOWN weapon; the server further validates it is actually owned.
      exactKeys(o, ["t", "weapon", "cseq"]);
      return { t: "equip", weapon: weaponOf(o, "weapon"), cseq: intOf(o, "cseq", 0, Number.MAX_SAFE_INTEGER) };
    }
    case "reorder": {
      // Slot indices are small non-negative integers; the server further validates them
      // against the player's actual inventory length.
      exactKeys(o, ["t", "from", "to", "cseq"]);
      return {
        t: "reorder",
        from: intOf(o, "from", 0, 63),
        to: intOf(o, "to", 0, 63),
        cseq: intOf(o, "cseq", 0, Number.MAX_SAFE_INTEGER),
      };
    }
    case "drop": {
      // The weapon id must be a KNOWN weapon; the server further validates ownership, player
      // state (not downed/pending/terminal), and the never-drop-the-last-weapon rule.
      exactKeys(o, ["t", "weapon", "cseq"]);
      return { t: "drop", weapon: weaponOf(o, "weapon"), cseq: intOf(o, "cseq", 0, Number.MAX_SAFE_INTEGER) };
    }
    case "swap": {
      // The pickup id is a non-negative integer naming a sim pickup; the drop id a KNOWN
      // weapon. The sim validates the rest (fullness/ownership/liveness/range) — a stale
      // or forged swap is a rejected command, never a crash and never a partial trade.
      exactKeys(o, ["t", "pickup", "drop", "cseq"]);
      return {
        t: "swap",
        pickup: intOf(o, "pickup", 0, Number.MAX_SAFE_INTEGER),
        drop: weaponOf(o, "drop"),
        cseq: intOf(o, "cseq", 0, Number.MAX_SAFE_INTEGER),
      };
    }
    case "chooseBlessing": {
      exactKeys(o, ["t", "offerId", "choiceId"]);
      return { t: "chooseBlessing", offerId: intOf(o, "offerId", 0, Number.MAX_SAFE_INTEGER), choiceId: shortStr(o, "choiceId", 48) };
    }
    case "shopBuy": {
      // The slot is a small non-negative index; the sim validates it against the live
      // shop (a bad slot is an "invalid" outcome, never a crash).
      exactKeys(o, ["t", "slot", "cseq"]);
      return { t: "shopBuy", slot: intOf(o, "slot", 0, 15), cseq: intOf(o, "cseq", 0, Number.MAX_SAFE_INTEGER) };
    }
    case "stat": {
      exactKeys(o, ["t", "rtt", "jit", "rec", "corr", "dly"]);
      return {
        t: "stat",
        rtt: num(o, "rtt", 0, 60000),
        jit: num(o, "jit", 0, 60000),
        rec: num(o, "rec", 0, 1e9),
        corr: num(o, "corr", 0, 1e7),
        dly: num(o, "dly", 0, 60000),
      };
    }
    default:
      throw new ProtocolError(`unknown type ${String(o.t)}`);
  }
}

// ---- exhaustive server decode (trusted source, validated anyway) ----
// Every field of every server message is type/range-checked before the client acts on it, so a
// corrupt/truncated frame (or a compromised path) surfaces as a ProtocolError the client drops,
// never as NaN state or an uncaught throw inside the game loop.

const POS_LIMIT = 1e7; // generous world-coordinate bound; rejects Infinity/absurd values

function validateSelfWire(v: unknown): SelfWire {
  const o = obj(v, "self");
  const wpns = arr(o.wpns, "self.wpns").map((w) => {
    if (!isWeaponId(w)) throw new ProtocolError("bad self.wpns entry");
    return w;
  });
  const items = arr(o.items, "self.items").map((it) => {
    if (typeof it !== "string" || it.length > 48) throw new ProtocolError("bad self.items entry");
    return it;
  });
  const wcd = arr(o.wcd, "self.wcd").map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e4) {
      throw new ProtocolError("bad self.wcd entry");
    }
    return value;
  });
  if (wcd.length !== wpns.length) throw new ProtocolError("bad self.wcd length");
  return {
    x: num(o, "x", -POS_LIMIT, POS_LIMIT), y: num(o, "y", -POS_LIMIT, POS_LIMIT),
    hp: num(o, "hp", 0, 1e6), mhp: num(o, "mhp", 0, 1e6),
    inv: num(o, "inv", 0, 1e4),
    dnv: num(o, "dnv", 0, 1e4),
    dcd: num(o, "dcd", 0, 1e4), dti: num(o, "dti", -1e4, 1e4),
    ddx: num(o, "ddx", -8, 8), ddy: num(o, "ddy", -8, 8),
    fcd: num(o, "fcd", 0, 1e4),
    chg: num(o, "chg", 0, 1e4),
    fng: num(o, "fng", 0, 1e4),
    fac: num(o, "fac", -1, 1),
    down: boolOf(o, "down"),
    wit: num(o, "wit", 0, 1e4),
    wpx: num(o, "wpx", 0, 1e6),
    wch: boolOf(o, "wch"),
    rev: num(o, "rev", 0, 1e4),
    out: boolOf(o, "out"),
    wpn: weaponOf(o, "wpn"),
    wpns,
    wcd,
    sgc: intOf(o, "sgc", 0, 0x0fffffff),
    ogc: intOf(o, "ogc", 0, 0x0fffffff),
    isMds: boolOf(o, "isMds"),
    rvb: idRefOf(o, "rvb"),
    items,
    mods: modsFromWire(obj(o.mods, "self.mods")),
    coins: num(o, "coins", 0, 1e9), kills: num(o, "kills", 0, 1e9),
    combo: num(o, "combo", 0, 1e9), ct: num(o, "ct", 0, 1e4),
    bcl: boolOf(o, "bcl"),
    php: intOf(o, "php", 0, 64),
    amc: boolOf(o, "amc"),
    amw: num(o, "amw", 0, 1e6),
    brt: boolOf(o, "brt"),
    rvt: intOf(o, "rvt", 0, 8),
    xsl: intOf(o, "xsl", 0, 8),
    tth: intOf(o, "tth", 0, 16),
    pfl: intOf(o, "pfl", -1, 1e6),
    kit: kitOf(o, "kit"),
    uc: intOf(o, "uc", 0, 1e6),
    ura: intOf(o, "ura", 0, Number.MAX_SAFE_INTEGER),
    ovt: num(o, "ovt", 0, 1e4),
    ovh: num(o, "ovh", 0, 1e4),
    osh: intOf(o, "osh", 0, 64),
    pra: intOf(o, "pra", 0, Number.MAX_SAFE_INTEGER),
    phs: num(o, "phs", 0, 1e4),
    uiv: num(o, "uiv", 0, 1e4),
    pst: num(o, "pst", 0, 1e4),
    rsp: intOf(o, "rsp", 0, 1e6),
    sgr: intOf(o, "sgr", 0, 1e6),
    ssh: intOf(o, "ssh", 0, 1e6),
    spo: intOf(o, "spo", 0, Number.MAX_SAFE_INTEGER),
    sge: intOf(o, "sge", 0, Number.MAX_SAFE_INTEGER),
    sse: intOf(o, "sse", 0, Number.MAX_SAFE_INTEGER),
    sfl: boolOf(o, "sfl"),
  };
}

function validatePlayerWire(v: unknown): PlayerWire {
  const o = obj(v, "player");
  const id = shortStr(o, "id", 64);
  // nm/cl/ht/fc are optional (older servers omit them): validate strictly WHEN present, fall
  // back safely when absent — never a decode failure across a version skew.
  let nm = id;
  if (o.nm !== undefined) nm = shortStr(o, "nm", 24);
  let cl: number | null = null;
  if (o.cl !== undefined && o.cl !== null) cl = intOf(o, "cl", 0, 63);
  let ht: string | null = null;
  if (o.ht !== undefined && o.ht !== null) ht = shortStr(o, "ht", 24);
  let fc: string | null = null;
  if (o.fc !== undefined && o.fc !== null) fc = shortStr(o, "fc", 24);
  let pt: string | null = null;
  if (o.pt !== undefined && o.pt !== null) pt = shortStr(o, "pt", 24);
  return {
    id,
    x: num(o, "x", -POS_LIMIT, POS_LIMIT), y: num(o, "y", -POS_LIMIT, POS_LIMIT),
    hp: num(o, "hp", 0, 1e6), mhp: num(o, "mhp", 0, 1e6),
    fac: num(o, "fac", -1, 1), aim: num(o, "aim", -1000, 1000),
    wpn: weaponOf(o, "wpn"), down: boolOf(o, "down"),
    isDrain: boolOf(o, "isDrain"),
    dti: num(o, "dti", -1e4, 1e4),
    ddx: num(o, "ddx", -8, 8), ddy: num(o, "ddy", -8, 8),
    dnv: num(o, "dnv", 0, 1e4),
    inv: num(o, "inv", 0, 1e4),
    sgr: intOf(o, "sgr", 0, 1e6),
    ssh: intOf(o, "ssh", 0, 1e6),
    spo: intOf(o, "spo", 0, Number.MAX_SAFE_INTEGER),
    sge: intOf(o, "sge", 0, Number.MAX_SAFE_INTEGER),
    sse: intOf(o, "sse", 0, Number.MAX_SAFE_INTEGER),
    rv: num(o, "rv", 0, 1e4),
    rvb: idRefOf(o, "rvb"),
    out: boolOf(o, "out"),
    bcl: boolOf(o, "bcl"),
    ab: boolOf(o, "ab"),
    nm, cl, ht, fc, pt,
    tm: intOf(o, "tm", 0, 1e6),
  };
}

function validateEnemyWire(v: unknown): EnemyWire {
  const o = obj(v, "enemy");
  const kind = o.kind;
  if (!isEnemyKind(kind)) throw new ProtocolError("bad enemy.kind");
  const a = obj(o.atk, "enemy.atk");
  return {
    id: intOf(o, "id", 0, Number.MAX_SAFE_INTEGER), kind,
    x: num(o, "x", -POS_LIMIT, POS_LIMIT), y: num(o, "y", -POS_LIMIT, POS_LIMIT),
    hp: num(o, "hp", -1e6, 1e6), mhp: num(o, "mhp", 0, 1e6), r: num(o, "r", 0, 1e4),
    tr: inSet(ENEMY_TIERS, o.tr, "enemy.tr"),
    atk: {
      ph: inSet(ATTACK_PHASES, a.ph, "enemy.atk.ph"),
      mv: inSet(ATTACK_MOVES, a.mv, "enemy.atk.mv"),
      wu: num(a, "wu", 0, 1),
      lk: boolOf(a, "lk"), la: num(a, "la", -1000, 1000),
      mx: num(a, "mx", -POS_LIMIT, POS_LIMIT), my: num(a, "my", -POS_LIMIT, POS_LIMIT),
      tm: num(a, "tm", 0, 1e4),
      ac: intOf(a, "ac", 0, Number.MAX_SAFE_INTEGER),
      sc: intOf(a, "sc", 0, Number.MAX_SAFE_INTEGER),
      bp: intOf(a, "bp", 0, 1),
    },
    bph: num(o, "bph", 0, 16),
    brr: boolOf(o, "brr"),
    mfm: num(o, "mfm", -1, 5),
    aux: num(o, "aux", -1e9, 1e9),
    afx: affixOf(o, "afx"),
    afs: num(o, "afs", -1e9, 1e9),
    mir: idRefOf(o, "mir"),
    burn: num(o, "burn", 0, 1e4), chill: num(o, "chill", 0, 1e4), shock: num(o, "shock", 0, 1e4),
    mkt: num(o, "mkt", 0, 1e4),
  };
}

function validateBulletWire(v: unknown): BulletWire {
  const o = obj(v, "bullet");
  const fx = o.fx;
  if (fx !== null && !isWeaponId(fx)) throw new ProtocolError("bad bullet.fx");
  const sm = o.sm === null ? null : inSet(SLUICE_MODES, o.sm, "bullet.sm");
  const go = o.go === null
    ? null
    : inSet(ODDSMAKER_OUTCOMES, o.go, "bullet.go");
  return {
    x: num(o, "x", -POS_LIMIT, POS_LIMIT), y: num(o, "y", -POS_LIMIT, POS_LIMIT),
    vx: num(o, "vx", -1e6, 1e6), vy: num(o, "vy", -1e6, 1e6),
    r: num(o, "r", 0, 1e4), friend: boolOf(o, "friend"), color: shortStr(o, "color", 32),
    fx: fx as WeaponId | null,
    sm,
    go,
  };
}

function validatePropWire(v: unknown): PropWire {
  const o = obj(v, "prop");
  return {
    id: intOf(o, "id", 0, Number.MAX_SAFE_INTEGER),
    kind: inSet(PROP_KINDS, o.kind, "prop.kind"),
    x: num(o, "x", -POS_LIMIT, POS_LIMIT), y: num(o, "y", -POS_LIMIT, POS_LIMIT),
    brk: num(o, "brk", -1, 1e4),
  };
}

function validatePickupWire(v: unknown): PickupWire {
  const o = obj(v, "pickup");
  const wpn = o.wpn;
  if (wpn !== null && !isWeaponId(wpn)) throw new ProtocolError("bad pickup.wpn");
  return {
    id: intOf(o, "id", 0, Number.MAX_SAFE_INTEGER),
    kind: inSet(PICKUP_KINDS, o.kind, "pickup.kind"),
    x: num(o, "x", -POS_LIMIT, POS_LIMIT), y: num(o, "y", -POS_LIMIT, POS_LIMIT),
    wpn: wpn as WeaponId | null,
    val: num(o, "val", -1, 1e9),
    bch: boolOf(o, "bch"),
    myst: boolOf(o, "myst"),
  };
}

function validateChestWire(v: unknown): ChestWire {
  const o = obj(v, "chest");
  return {
    id: intOf(o, "id", 0, Number.MAX_SAFE_INTEGER),
    kind: inSet(CHEST_KINDS, o.kind, "chest.kind"),
    x: num(o, "x", -POS_LIMIT, POS_LIMIT), y: num(o, "y", -POS_LIMIT, POS_LIMIT),
    op: boolOf(o, "op"), opt: num(o, "opt", -1, 1e4),
  };
}

function validateHazardWire(v: unknown): HazardWire {
  const o = obj(v, "hazard");
  return {
    id: intOf(o, "id", 0, Number.MAX_SAFE_INTEGER),
    k: inSet(HAZARD_KINDS, o.k, "hazard.k"),
    x: num(o, "x", -POS_LIMIT, POS_LIMIT), y: num(o, "y", -POS_LIMIT, POS_LIMIT),
    r: num(o, "r", 0, 1e4), life: num(o, "life", 0, 1e4), max: num(o, "max", 0, 1e4),
  };
}

function validateShopSlotWire(v: unknown): ShopSlotWire {
  const o = obj(v, "shopSlot");
  const wpn = o.wpn;
  if (wpn !== null && !isWeaponId(wpn)) throw new ProtocolError("bad shopSlot.wpn");
  const it = o.it;
  if (it !== null && (typeof it !== "string" || it.length < 1 || it.length > 48)) throw new ProtocolError("bad shopSlot.it");
  const sold = o.sold;
  if (sold !== null && (typeof sold !== "string" || sold.length < 1 || sold.length > 64)) throw new ProtocolError("bad shopSlot.sold");
  const by = arr(o.by, "shopSlot.by").map((p) => {
    if (typeof p !== "string" || p.length < 1 || p.length > 64) throw new ProtocolError("bad shopSlot.by entry");
    return p;
  });
  return {
    id: intOf(o, "id", 0, 15),
    k: inSet(SHOP_SLOT_KINDS, o.k, "shopSlot.k"),
    sh: boolOf(o, "sh"),
    wpn: wpn as WeaponId | null,
    it: it as string | null,
    pr: intOf(o, "pr", 0, 1e6),
    x: num(o, "x", -POS_LIMIT, POS_LIMIT), y: num(o, "y", -POS_LIMIT, POS_LIMIT),
    sold: sold as PlayerId | null,
    by,
    myst: boolOf(o, "myst"),
  };
}

function validateEncounterWire(v: unknown): EncounterWire {
  const o = obj(v, "enc");
  exactKeys(o, ["k", "a", "sk", "cr", "re", "cp", "op", "ca", "fc", "co", "fa"]);
  return {
    k: shortStr(o, "k", 32),
    a: boolOf(o, "a"),
    sk: shortStr(o, "sk", 32),
    cr: intOf(o, "cr", -1, 1e6),
    re: intOf(o, "re", -1, 1e6),
    cp: intOf(o, "cp", 0, 1e6),
    op: num(o, "op", -1e9, 1e9),
    ca: idRefOf(o, "ca"),
    fc: intOf(o, "fc", 0, 1e6),
    co: boolOf(o, "co"),
    fa: boolOf(o, "fa"),
  };
}

function validateShopWire(v: unknown): ShopWire {
  const o = obj(v, "shop");
  const slots = arr(o.slots, "shop.slots").map(validateShopSlotWire);
  if (slots.length > 16) throw new ProtocolError("bad shop.slots size");
  return {
    md: inSet(SHOP_MODES, o.md, "shop.md"),
    kx: num(o, "kx", -POS_LIMIT, POS_LIMIT), ky: num(o, "ky", -POS_LIMIT, POS_LIMIT),
    ru: intOf(o, "ru", 0, 1e4),
    slots,
  };
}

function validateMatchWire(v: unknown): MatchWire {
  const o = obj(v, "match");
  const sc = arr(o.sc, "match.sc").map((e) => {
    const s = obj(e, "match.sc entry");
    return { id: shortStr(s, "id", 64), f: intOf(s, "f", 0, 1e6), a: boolOf(s, "a") };
  });
  if (sc.length > 64) throw new ProtocolError("bad match.sc size");
  const win = o.win;
  if (win !== null && (typeof win !== "string" || win.length < 1 || win.length > 64)) throw new ProtocolError("bad match.win");
  return {
    ph: inSet(MATCH_PHASES, o.ph, "match.ph"),
    end: intOf(o, "end", 0, Number.MAX_SAFE_INTEGER),
    sc,
    win: win as PlayerId | null,
  };
}

function validateEffectWire(v: unknown): EffectWire {
  const o = obj(v, "effect");
  const owner = o.o;
  if (typeof owner !== "string" || owner.length > 64) throw new ProtocolError("bad effect.o");
  return {
    id: intOf(o, "id", 0, Number.MAX_SAFE_INTEGER),
    k: inSet(EFFECT_KINDS, o.k, "effect.k"),
    o: owner,
    fx: weaponOf(o, "fx"),
    x: num(o, "x", -POS_LIMIT, POS_LIMIT), y: num(o, "y", -POS_LIMIT, POS_LIMIT),
    x2: num(o, "x2", -POS_LIMIT, POS_LIMIT), y2: num(o, "y2", -POS_LIMIT, POS_LIMIT),
    r: num(o, "r", 0, 1e4),
    n: intOf(o, "n", 0, 64),
    a: num(o, "a", -1000, 1000),
    fl: num(o, "fl", 0, 1e4),
    arm: num(o, "arm", 0, 1e4),
    hp: num(o, "hp", -1, 1e6), mhp: num(o, "mhp", -1, 1e6),
    eid: intOf(o, "eid", -1, Number.MAX_SAFE_INTEGER),
    life: num(o, "life", 0, 1e4), max: num(o, "max", 0, 1e4),
  };
}

function validateWireEvent(v: unknown): WireEvent {
  const o = obj(v, "wireEvent");
  return { id: intOf(o, "id", 1, Number.MAX_SAFE_INTEGER), e: validateEvent(o.e) };
}

const SEAT_STATES: Record<SeatState, true> = { on: true, away: true };
const PVP_DRAFT_TRIGGERS: Record<PvpDraftTrigger, true> = {
  none: true,
  frag: true,
  time: true,
  dedup: true,
};
const OFFER_KINDS = { blessing: true, pvp_draft: true } as const;

function validateWaitWire(v: unknown): WaitWire {
  const o = obj(v, "wait");
  return {
    pid: shortStr(o, "pid", 64),
    s: num(o, "s", 0, 1e4),
    k: inSet(OFFER_KINDS, o.k, "wait.k"),
    tr: inSet(PVP_DRAFT_TRIGGERS, o.tr, "wait.tr"),
    isComeback: boolOf(o, "isComeback"),
  };
}

function validateRosterWire(v: unknown): RosterWire {
  const o = obj(v, "roster");
  let cl: number | null = null;
  if (o.cl !== undefined && o.cl !== null) cl = intOf(o, "cl", 0, 63);
  return {
    pid: shortStr(o, "pid", 64),
    aid: shortStr(o, "aid", 64),
    nm: shortStr(o, "nm", 24),
    cl,
    st: inSet(SEAT_STATES, o.st, "roster.st"),
  };
}

function worldIdOf(o: Record<string, unknown>): string {
  const wid = shortStr(o, "wid", 40);
  if (!isValidWorldId(wid)) throw new ProtocolError("bad wid");
  return wid;
}

function catalogVersionOf(value: WireValue | undefined): ContentCatalogVersion {
  if (value === undefined) return LEGACY_CONTENT_CATALOG_VERSION;
  if (typeof value !== "number" || !Number.isInteger(value) || !isContentCatalogVersion(value)) {
    throw new ProtocolError("bad catalog version");
  }
  return value;
}

// Exhaustive validation of a COMPLETE snapshot object. Shared by the wire decode of a `snap`
// frame and by the client's delta path (which reconstructs a complete snapshot from a baseline
// + delta and runs it through here, so a delta ends up as strictly-validated as a keyframe).
// Reconstructs a fresh canonical object (fixed key order), so the reconstruction's key order or
// list order can never affect the decoded state.
export function validateSnap(o: Record<string, unknown>): Extract<ServerMsg, { t: "snap" }> {
  const exr = arr(o.exr, "exr").map((p) => {
    if (typeof p !== "string" || p.length < 1 || p.length > 64) throw new ProtocolError("bad exr entry");
    return p;
  });
  return {
    t: "snap",
    sseq: intOf(o, "sseq", 0, Number.MAX_SAFE_INTEGER),
    tick: intOf(o, "tick", 0, Number.MAX_SAFE_INTEGER),
    rev: intOf(o, "rev", 0, Number.MAX_SAFE_INTEGER),
    ackSeq: intOf(o, "ackSeq", 0, Number.MAX_SAFE_INTEGER),
    full: boolOf(o, "full"),
    over: boolOf(o, "over"),
    selfId: shortStr(o, "selfId", 64),
    wid: worldIdOf(o),
    roster: arr(o.roster, "roster").map(validateRosterWire),
    wait: arr(o.wait, "wait").map(validateWaitWire),
    ...(o.tok !== undefined ? { tok: shortStr(o, "tok", 64) } : {}),
    seed: intOf(o, "seed", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    cat: catalogVersionOf(o.cat as WireValue | undefined),
    floor: intOf(o, "floor", 1, 1e6),
    pcl: intOf(o, "pcl", 1, 4),
    cleared: boolOf(o, "cleared"),
    exr,
    evTo: intOf(o, "evTo", 0, Number.MAX_SAFE_INTEGER),
    self: o.self === null ? null : validateSelfWire(o.self),
    players: arr(o.players, "players").map(validatePlayerWire),
    enemies: arr(o.enemies, "enemies").map(validateEnemyWire),
    bullets: arr(o.bullets, "bullets").map(validateBulletWire),
    props: arr(o.props, "props").map(validatePropWire),
    pickups: arr(o.pickups, "pickups").map(validatePickupWire),
    chests: arr(o.chests, "chests").map(validateChestWire),
    hzds: arr(o.hzds, "hzds").map(validateHazardWire),
    shop: o.shop === null ? null : validateShopWire(o.shop),
    effs: arr(o.effs, "effs").map(validateEffectWire),
    match: o.match === null || o.match === undefined ? null : validateMatchWire(o.match),
    enc: o.enc === null || o.enc === undefined ? null : validateEncounterWire(o.enc),
    events: arr(o.events, "events").map(validateWireEvent),
  };
}

// A bounded, crash-safe validator for the delta's PARTIAL payload fragments (changed scalars,
// self patch, per-entity partials). The reconstructed COMPLETE snapshot is validated
// exhaustively by validateSnap afterward, so this only has to guarantee it decoded plain,
// finite, non-adversarial JSON (bounded depth, finite numbers, no prototype-polluting keys).
const MAX_DELTA_DEPTH = 6;
function safeWireValue(v: unknown, depth: number): WireValue {
  if (depth > MAX_DELTA_DEPTH) throw new ProtocolError("delta too deep");
  if (v === null) return null;
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new ProtocolError("bad delta number"); return v; }
  if (typeof v === "string") { if (v.length > 256) throw new ProtocolError("bad delta string"); return v; }
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) {
    if (v.length > 4096) throw new ProtocolError("bad delta array");
    return v.map((x) => safeWireValue(x, depth + 1));
  }
  const rec = obj(v, "delta value");
  const out: WireObject = {};
  for (const k of Object.keys(rec)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") throw new ProtocolError("bad delta key");
    out[k] = safeWireValue(rec[k], depth + 1);
  }
  return out;
}
function safeWireObject(v: unknown): WireObject {
  const val = safeWireValue(v, 0);
  if (typeof val !== "object" || val === null || Array.isArray(val)) throw new ProtocolError("bad delta object");
  return val;
}

const REMOVAL_REASONS: Record<RemovalReason, true> = { gone: true, left: true };
function validateKeyedDelta(v: unknown): KeyedDelta {
  const o = obj(v, "keyed delta");
  const out: KeyedDelta = {};
  if (o.u !== undefined) out.u = arr(o.u, "keyed.u").map(safeWireObject);
  if (o.r !== undefined) {
    out.r = arr(o.r, "keyed.r").map((pair) => {
      const p = arr(pair, "keyed.r entry");
      if (p.length !== 2) throw new ProtocolError("bad keyed.r entry");
      const id = p[0];
      if (typeof id !== "number" && typeof id !== "string") throw new ProtocolError("bad keyed.r id");
      const reason = p[1];
      if (typeof reason !== "string" || !Object.prototype.hasOwnProperty.call(REMOVAL_REASONS, reason)) throw new ProtocolError("bad keyed.r reason");
      return [id, reason as RemovalReason];
    });
  }
  return out;
}

function validateSnapd(o: Record<string, unknown>): Extract<ServerMsg, { t: "snapd" }> {
  const out: Extract<ServerMsg, { t: "snapd" }> = {
    t: "snapd",
    q: intOf(o, "q", 0, Number.MAX_SAFE_INTEGER),
    b: intOf(o, "b", 0, Number.MAX_SAFE_INTEGER),
    sc: safeWireObject(o.sc),
    ev: arr(o.ev, "snapd.ev").map(validateWireEvent),
    et: intOf(o, "et", 0, Number.MAX_SAFE_INTEGER),
  };
  if (o.self !== undefined) {
    const s = obj(o.self, "snapd.self");
    const keys = Object.keys(s);
    if (keys.length !== 1) throw new ProtocolError("bad snapd.self");
    switch (keys[0]) {
      case "d":
        if (s.d !== true) throw new ProtocolError("bad snapd.self");
        out.self = { d: true };
        break;
      case "f":
        out.self = { f: validateSelfWire(s.f) };
        break;
      case "p":
        out.self = { p: safeWireObject(s.p) };
        break;
      default:
        throw new ProtocolError("bad snapd.self");
    }
  }
  for (const tag of ["en", "pl", "pr", "pk", "ch", "hz", "ef"] as const) {
    if (o[tag] !== undefined) out[tag] = validateKeyedDelta(o[tag]);
  }
  if (o.w !== undefined) out.w = safeWireObject(o.w);
  return out;
}

function decodeServerMsg(raw: string): ServerMsg {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolError("bad json");
  }
  const o = obj(parsed, "frame");
  switch (o.t) {
    case "snap":
      return validateSnap(o);
    case "snapd":
      return validateSnapd(o);
    case "ping":
      return {
        t: "ping",
        id: intOf(o, "id", 0, Number.MAX_SAFE_INTEGER),
        tick: intOf(o, "tick", 0, Number.MAX_SAFE_INTEGER),
        time: num(o, "time", 0, 1e15),
      };
    case "offer": {
      const choices = arr(o.choices, "offer.choices").map((c) => {
        if (typeof c !== "string" || c.length < 1 || c.length > 48) throw new ProtocolError("bad offer choice");
        return c;
      });
      if (choices.length < 1 || choices.length > 8) throw new ProtocolError("bad offer size");
      return {
        t: "offer",
        id: intOf(o, "id", 1, Number.MAX_SAFE_INTEGER),
        choices,
        k: inSet(OFFER_KINDS, o.k, "offer.k"),
        tr: inSet(PVP_DRAFT_TRIGGERS, o.tr, "offer.tr"),
        isComeback: boolOf(o, "isComeback"),
      };
    }
    case "error":
      return { t: "error", code: shortStr(o, "code", 64), msg: typeof o.msg === "string" && o.msg.length <= 256 ? o.msg : "" };
    default:
      throw new ProtocolError(`unknown server type ${String(o.t)}`);
  }
}

export const jsonCodec: Codec = {
  encodeServer: (msg) => JSON.stringify(msg),
  decodeServer: decodeServerMsg,
  encodeClient: (msg) => JSON.stringify(msg),
  decodeClient: decodeClientMsg,
};

// ---- entity <-> wire conversions ----

// Self projection rides the ONE tested projection/apply boundary (playerSnapshot.ts); these two
// map its full-fidelity field names onto the compact wire keys, 1:1.
export function selfWireFromSnapshot(s: AuthoritativePlayerSnapshot): SelfWire {
  return {
    x: s.x, y: s.y, hp: s.hp, mhp: s.maxHp, inv: s.invuln, dnv: s.dashInvuln,
    dcd: s.dashCd, dti: s.dashTime, ddx: s.dashDx, ddy: s.dashDy, fcd: s.fireCd, chg: s.chargeT, fng: s.fangCd,
    fac: s.facing, down: s.isDown, wit: s.warmthIdleSec, wpx: s.warmthPathPx,
    wch: s.isWarmthChilled, rev: s.reviveProgress, out: false, wpn: s.weapon,
    wpns: s.ownedWeapons,
    wcd: s.ownedWeapons.map((weapon) => s.weaponFireCooldowns[weapon] ?? 0),
    sgc: s.weaponCycles.sluicegate, ogc: s.weaponCycles.oddsmaker, isMds: s.isMuddyRefundSpent,
    rvb: s.reviveBy ?? "",
    items: s.ownedItemIds, mods: s.mods,
    coins: s.coins, kills: s.kills, combo: s.combo, ct: s.comboTimer,
    bcl: s.hasClaimedBossChoice,
    php: s.premiumHpBuys, amc: s.isAmberCacheArmed, amw: s.amberWindfall, brt: s.isBlessingRerollArmed,
    rvt: s.reviveTokens, xsl: s.extraWeaponSlots, tth: s.hpTithe, pfl: s.prospectorFloor,
    kit: s.kitId, uc: s.ultCharge, ura: s.ultReadyAtTick, ovt: s.overdriveT,
    ovh: s.overheatT, osh: s.overshield, pra: s.pulseReadyAtTick, phs: s.phaseSpeed,
    uiv: s.ultInvuln, pst: s.passiveState, rsp: s.respawnT,
    sgr: s.spawnGraceT, ssh: s.spawnShieldT,
    spo: s.spawnProtectionStartedTick,
    sge: s.spawnHardGraceEndsAtTick,
    sse: s.spawnShieldEndsAtTick,
    sfl: s.isSpawnOffenseLatched,
  };
}

export function snapshotFromSelfWire(w: SelfWire): AuthoritativePlayerSnapshot {
  return {
    x: w.x, y: w.y, hp: w.hp, maxHp: w.mhp, invuln: w.inv, dashInvuln: w.dnv,
    dashCd: w.dcd, dashTime: w.dti, dashDx: w.ddx, dashDy: w.ddy, fireCd: w.fcd, chargeT: w.chg, fangCd: w.fng,
    facing: w.fac, isDown: w.down, warmthIdleSec: w.wit, warmthPathPx: w.wpx,
    isWarmthChilled: w.wch, reviveProgress: w.rev, weapon: w.wpn,
    ownedWeapons: w.wpns.slice(),
    weaponFireCooldowns: Object.fromEntries(
      w.wpns.flatMap((weapon, index) => w.wcd[index] > 0 ? [[weapon, w.wcd[index]]] : []),
    ),
    weaponCycles: { sluicegate: w.sgc, oddsmaker: w.ogc },
    isMuddyRefundSpent: w.isMds,
    reviveBy: w.rvb.length > 0 ? w.rvb : null,
    ownedItemIds: w.items.slice(), mods: modsFromWire(w.mods),
    coins: w.coins, kills: w.kills, combo: w.combo, comboTimer: w.ct,
    hasClaimedBossChoice: w.bcl,
    premiumHpBuys: w.php, isAmberCacheArmed: w.amc, amberWindfall: w.amw, isBlessingRerollArmed: w.brt,
    reviveTokens: w.rvt, extraWeaponSlots: w.xsl, hpTithe: w.tth, prospectorFloor: w.pfl,
    kitId: w.kit, ultCharge: w.uc, ultReadyAtTick: w.ura, overdriveT: w.ovt,
    overheatT: w.ovh, overshield: w.osh, pulseReadyAtTick: w.pra, phaseSpeed: w.phs,
    ultInvuln: w.uiv, passiveState: w.pst, respawnT: w.rsp,
    spawnGraceT: w.sgr, spawnShieldT: w.ssh,
    spawnProtectionStartedTick: w.spo,
    spawnHardGraceEndsAtTick: w.sge,
    spawnShieldEndsAtTick: w.sse,
    isSpawnOffenseLatched: w.sfl,
  };
}

export function toSelfWire(p: PlayerSim): SelfWire {
  // `out` is derived from server-only down bookkeeping (never reconciled back — the
  // prediction world has no down counter to apply it to), so it rides beside the
  // snapshot-projected fields.
  return { ...selfWireFromSnapshot(projectPlayer(p)), out: isPlayerOut(p) };
}

// Reset a predicted local player to authoritative server truth (the reconciliation snap). All
// server-owned fields flow through the exhaustive projection; the client keeps only its own
// client-owned fields (aim etc. — see playerSnapshot.ts).
export function applySelfWire(p: PlayerSim, s: SelfWire): void {
  applyPlayerSnapshot(p, snapshotFromSelfWire(s));
}

// Cosmetic identity attached to a player's wire struct. It lives OUTSIDE the sim (the sim
// stays pure gameplay state); the server keeps it per-connection from the verified join
// ticket and passes it in at snapshot-build time.
export interface PlayerIdentity {
  name: string | null;
  colorIndex: number | null;
  // Equipped visual-only overlay cosmetics (optional so pre-cosmetics constructors stay
  // valid). Body renders from the party color at launch; titles never ride the wire.
  hat?: string | null;
  face?: string | null;
  // Equipped visual-only companion pet id (META spec §3), same channel as hat/face.
  pet?: string | null;
}

export function toPlayerWire(p: PlayerSim, identity?: PlayerIdentity): PlayerWire {
  return {
    id: p.id, x: p.x, y: p.y, hp: p.hp, mhp: p.maxHp, fac: p.facing, aim: p.aimAngle, wpn: p.weapon, down: p.isDown,
    isDrain: p.weaponCycles.sluicegate % 2 === 1,
    dti: p.dashTime, ddx: p.dashDx, ddy: p.dashDy, dnv: p.dashInvuln, inv: p.invuln,
    sgr: p.spawnGraceT, ssh: p.spawnShieldT,
    spo: p.spawnProtectionStartedTick, sge: p.spawnHardGraceEndsAtTick, sse: p.spawnShieldEndsAtTick,
    rv: p.reviveProgress,
    rvb: p.reviveBy ?? "",
    out: isPlayerOut(p),
    bcl: p.hasClaimedBossChoice,
    ab: p.isAbsent,
    nm: identity?.name ?? p.id,
    cl: identity?.colorIndex ?? null,
    ht: identity?.hat ?? null,
    fc: identity?.face ?? null,
    pt: identity?.pet ?? null,
    tm: p.team,
  };
}

// Project the pvp match block off the sim's MatchState. Scores + alive are ID-SORTED so the
// wire form is deterministic (and delta-diffs stably) regardless of the players-map order.
export function toMatchWire(m: MatchState, w: WorldState): MatchWire {
  const sc: MatchScoreWire[] = [];
  for (const id of [...w.players.keys()].sort()) {
    const p = w.players.get(id);
    // "alive" requires a PRESENT, un-downed body: a network-absent seat (reserved inside its
    // reconnect grace) reads NOT alive, so a scoreboard never shows a disconnected player still
    // standing. Mirrors the sim's canDamagePlayer/present-roster contract.
    sc.push({ id, f: m.scores.get(id) ?? 0, a: p !== undefined && !p.isAbsent && p.hp > 0 && p.respawnT === 0 });
  }
  return { ph: m.phase, end: m.phaseEndTick, sc, win: m.winner };
}

export function toEnemyWire(e: Enemy): EnemyWire {
  const a = e.attack;
  return {
    id: e.id, kind: e.kind, x: e.x, y: e.y, hp: e.hp, mhp: e.maxHp, r: e.radius, tr: e.tier,
    atk: {
      ph: a.phase,
      mv: a.move,
      wu: a.windup,
      lk: a.isAimLocked,
      la: a.lockedAngle,
      mx: a.markX,
      my: a.markY,
      tm: a.time,
      ac: e.boss?.attackCount ?? 0,
      sc: e.boss?.spinCount ?? 0,
      bp: e.boss?.burstParity ?? 0,
    },
    bph: e.boss ? e.boss.phase : 0,
    brr: e.boss ? e.boss.roar !== null : false,
    mfm: e.boss ? e.boss.mirrorFamily : -1,
    aux: e.aux,
    afx: e.rollAffix,
    afs: e.affixState,
    mir: e.mirrorOf ?? "",
    burn: e.burn, chill: e.chill, shock: e.shock, mkt: e.markT,
  };
}

export function toBulletWire(b: Bullet): BulletWire {
  return {
    x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: b.radius,
    friend: b.friendly, color: b.color, fx: b.fx ?? null,
    sm: b.sluiceMode ?? null,
    go: b.oddsmakerOutcome ?? null,
  };
}

// Build a render-ready Enemy from a wire struct at an (interpolated) position. Scratch fields
// the renderer never reads are defaulted; the client's cosmetic anim is keyed by id elsewhere.
export function enemyFromWire(w: EnemyWire, x: number, y: number): Enemy {
  return {
    id: w.id, kind: w.kind, x, y, vx: 0, vy: 0, radius: w.r, hp: w.hp, maxHp: w.mhp, dead: false,
    tier: w.tr, isSummoned: false, kbResist: 1, surgeDelay: 0, surgeTime: 0,
    rollAffix: w.afx, affixState: w.afs, affixClock: 0,
    aux: w.aux, seq: 0, panicTime: 0, echoTime: 0, echoAngle: 0,
    speed: 0, touchDamage: 0, zig: 0, hopClock: 0, hopMove: 0, spawnTimer: 0, stuckTimer: 0,
    avoidSide: 0, avoidTime: 0,
    burn: w.burn, burnDmg: 0, chill: w.chill, shock: w.shock, markT: w.mkt, revealT: 0, statusTick: 0, burnOwner: null,
    mirrorOf: w.mir.length > 0 ? w.mir : null,
    attack: {
      phase: w.atk.ph, time: w.atk.tm, move: w.atk.mv, windup: w.atk.wu, cooldown: 0,
      lockedAngle: w.atk.la, isAimLocked: w.atk.lk, markX: w.atk.mx, markY: w.atk.my,
    },
    boss: w.bph > 0
      ? {
        // The transition beat is a boolean on the wire (brr); the client rebuilds a marker
        // roar object so `boss.roar !== null` reads identically to the sim (transition-beat +
        // Quorum merge-fuse VFX bind to it). The banked floorHp/queued/queuedBy are
        // sim-internal (they never travel — the client only renders the beat, never resolves it).
        phase: w.bph, transitionsDone: 0, roar: w.brr ? { floorHp: 0, queued: 0, queuedBy: null } : null,
        addTimer: 0, attackCount: w.atk.ac,
        isNextRadial: false, burstParity: w.atk.bp, beatAddIds: [], spinCount: w.atk.sc,
        // Earned windows: the exposed remainder rides the aux channel (the render key), restored
        // into boss.exposed so the client's guard/expose art reads the SAME flag as the damage
        // gate (isBossExposed). The bank + mechanic id lists are sim-internal and never travel.
        exposed: w.aux, windowBank: 0, windowAddIds: [], laneKnotId: 0, lastAddPick: -1, mirrorFamily: w.mfm,
        mirrorLastFamily: -1,
        // Husk lifecycle flags are sim-internal spawn/guard bookkeeping (the client reads husk
        // liveness off the husks' own wires); defaulted on the render-only reconstruction.
        huskRaised: false, huskGuardUp: true, huskReformTimer: 0,
        phaseTime: 0, enrage: 0, isSurpriseSpent: false, affixCd: 0,
        // GORGE shell-peel scratch is sim-internal (the client reads the shell phase off bph and
        // the exposed remainder off aux); defaulted on the render-only reconstruction.
        seamLife: 0,
      }
      : null,
  };
}

export function toPropWire(p: Prop): PropWire {
  return { id: p.id, kind: p.kind, x: p.x, y: p.y, brk: p.breakT ?? -1 };
}
export function toEncounterWire(e: EncounterState): EncounterWire {
  return {
    k: e.kind,
    a: e.active,
    sk: e.structureKind,
    cr: e.currentRoomId,
    re: e.routeEdgeId === null ? -1 : e.routeEdgeId,
    cp: e.checkpoint,
    op: e.objectiveProgress,
    ca: e.carrierPlayerId ?? "",
    fc: e.failureCount,
    co: e.completed,
    fa: e.failed,
  };
}

export function toShopWire(s: ShopState, viewerId?: PlayerId): ShopWire {
  return {
    md: s.mode, kx: s.keeperX, ky: s.keeperY, ru: s.rerollsUsed,
    slots: s.slots.map((baseSlot): ShopSlotWire => {
      const slot = viewerId === undefined ? baseSlot : shopSlotForViewer(s, baseSlot, viewerId);
      return {
        id: slot.id, k: slot.kind, sh: slot.isShared,
        // A mystery pedestal's identity NEVER rides the wire (a tampered client must not
        // be able to peek the gamble); the buy flips isMystery false, revealing it.
        wpn: slot.isMystery ? null : slot.weapon, it: slot.itemId, pr: slot.price,
        x: slot.x, y: slot.y, sold: slot.soldTo, by: slot.buyers.slice(),
        myst: slot.isMystery,
      };
    }),
  };
}
export function shopFromWire(
  w: ShopWire,
  selfServerId?: PlayerId | null,
  catalogVersion: ContentCatalogVersion = LEGACY_CONTENT_CATALOG_VERSION,
): ShopState {
  // Field order mirrors buildShopState so a decoded shop is byte-identical to the sim's
  // on its wire projection (the shop suite locks toShopWire round-trips; a mystery
  // slot's hidden identity/twist are sim secrets and never reconstructable here).
  return {
    catalogVersion,
    mode: w.md,
    keeperX: w.kx, keeperY: w.ky,
    slots: w.slots.map((s): ShopSlot => ({
      id: s.id, kind: s.k, isShared: s.sh,
      weapon: s.wpn, itemId: s.it, price: s.pr,
      x: s.x,
      y: s.y,
      soldTo: selfServerId != null && s.sold === selfServerId ? LOCAL_ID : s.sold,
      buyers: s.by.map((pid) => selfServerId != null && pid === selfServerId ? LOCAL_ID : pid),
      isMystery: s.myst, twist: null,
    })),
    viewerStock: {},
    rerollsUsed: w.ru,
  };
}
export function toPickupWire(p: Pickup): PickupWire {
  return {
    id: p.id, kind: p.kind, x: p.x, y: p.y,
    // A mystery pickup's baked identity stays sim-side until the authoritative reveal.
    wpn: p.isMystery ? null : p.weapon,
    val: p.value ?? -1, bch: p.isBossChoice ?? false, myst: p.isMystery ?? false,
  };
}
export function toChestWire(c: Chest): ChestWire {
  return { id: c.id, kind: c.kind, x: c.x, y: c.y, op: c.opened, opt: c.openT ?? -1 };
}
export function toHazardWire(h: Hazard): HazardWire {
  return { id: h.id, k: h.kind, x: h.x, y: h.y, r: h.radius, life: h.life, max: h.maxLife };
}

// Weapon effect entities: one flat wire struct, kind-relevant fields filled, the rest at
// their defaults (0 / -1). Sim-internal scratch (rehit cooldowns, sentry fire cadence,
// tether phase timers) stays OFF the wire — the client only renders.
export function toEffectWire(e: Effect): EffectWire {
  const base: EffectWire = {
    id: e.id, k: e.kind, o: e.owner ?? "", fx: e.fx, x: e.x, y: e.y,
    x2: 0, y2: 0, r: 0, n: 0, a: 0, fl: 0, arm: 0, hp: -1, mhp: -1, eid: -1,
    life: e.life, max: e.maxLife,
  };
  switch (e.kind) {
    case "zone":
      base.r = e.radius;
      break;
    case "wire":
      base.x2 = e.x2; base.y2 = e.y2; base.r = e.width; base.arm = e.arm;
      break;
    case "orbit":
      base.r = e.ring; base.n = e.blades; base.a = e.angle; base.fl = e.flare;
      base.x2 = e.bladeRadius; // blade contact radius rides the spare span slot
      break;
    case "sentry":
      base.r = e.radius; base.hp = e.hp; base.mhp = e.maxHp;
      break;
    case "tether":
      base.eid = e.eid; base.r = e.reach;
      break;
    case "sanctuary":
      base.r = e.radius; // healRate is sim-internal; the client renders the zone by kind
      break;
    case "aegis":
      base.r = e.radius; base.hp = e.hp; base.mhp = e.maxHp; // the dome's remaining barrier budget
      break;
  }
  return base;
}

// Build a render-ready Effect from the wire (scratch fields the renderer never reads are
// defaulted; damage/cadence are authoritative-only and irrelevant client-side).
export function effectFromWire(w: EffectWire): Effect {
  const owner = w.o.length > 0 ? w.o : null;
  const base = { id: w.id, owner, fx: w.fx, x: w.x, y: w.y, life: w.life, maxLife: w.max };
  switch (w.k) {
    case "zone":
      return { ...base, kind: "zone", radius: w.r, chillRate: 0, isPaved: w.fx === "pathmaker" };
    case "wire":
      return { ...base, kind: "wire", x2: w.x2, y2: w.y2, width: w.r, arm: w.arm, damage: 0 };
    case "orbit":
      return {
        ...base, kind: "orbit", angle: w.a, ring: w.r, blades: w.n, bladeRadius: w.x2,
        speed: 0, flare: w.fl, damage: 0, rehit: new Map(),
      };
    case "sentry":
      return {
        ...base, kind: "sentry", radius: w.r, hp: w.hp, maxHp: w.mhp, fireCd: 0, range: 0,
        boltSpeed: 0, boltRadius: 0, boltDamage: 0, boltPierce: 0, contactCd: 0, targetEid: -1,
      };
    case "tether":
      return {
        ...base, kind: "tether", eid: w.eid, phase: "hold", isPlayerPulled: false,
        pullSpeed: 0, holdDist: 0, holdTime: 0, pullTime: 0, damage: 0, reach: w.r,
      };
    case "sanctuary":
      return { ...base, kind: "sanctuary", radius: w.r, healRate: 0 };
    case "aegis":
      return { ...base, kind: "aegis", radius: w.r, hp: w.hp, maxHp: w.mhp };
  }
}

// Radius reconstructed from kind so the wire stays tiny. Matches the sim's placement radii
// (constants.PROP_RADIUS for props; pickups 13/16; chests 16/18) so client collision +
// pickup ranges agree with the server.
export function propFromWire(w: PropWire): Prop {
  return { id: w.id, kind: w.kind, x: w.x, y: w.y, radius: PROP_RADIUS, hp: 1, dead: w.brk >= 0, breakT: w.brk < 0 ? undefined : w.brk };
}
export function pickupFromWire(w: PickupWire): Pickup {
  const radius = w.kind === "weapon" ? 16 : 13;
  return {
    id: w.id, kind: w.kind, x: w.x, y: w.y, radius, weapon: w.wpn,
    value: w.val < 0 ? undefined : w.val, isBossChoice: w.bch || undefined,
    isMystery: w.myst || undefined,
  };
}
export function chestFromWire(w: ChestWire): Chest {
  return { id: w.id, kind: w.kind, x: w.x, y: w.y, radius: w.kind === "boss" ? 18 : 16, opened: w.op, openT: w.opt < 0 ? undefined : w.opt };
}
export function hazardFromWire(w: HazardWire): Hazard {
  return { id: w.id, kind: w.k, x: w.x, y: w.y, radius: w.r, life: w.life, maxLife: w.max };
}

export function bulletFromWire(b: BulletWire): Bullet {
  return {
    x: b.x, y: b.y, vx: b.vx, vy: b.vy, radius: b.r, life: 1, friendly: b.friend,
    owner: null, damage: 0, color: b.color, pierce: 0, hitList: null, isCrit: false,
    fx: b.fx ?? undefined,
    sluiceMode: b.sm ?? undefined,
    oddsmakerOutcome: b.go ?? undefined,
  };
}

// ---- interest view (per-client, with enter/exit hysteresis) ----

// An entity ENTERS a client's view inside interestRadius and LEAVES only beyond
// interestRadius * INTEREST_EXIT_FACTOR, so an entity hovering at the boundary doesn't flicker
// in/out of the snapshot (and the client's collision/interp state doesn't pop) every tick.
export const INTEREST_EXIT_FACTOR = 1.15;

// The per-client view membership, keyed by STABLE entity ids. rev-scoped: a new floor (new
// world revision) invalidates every set. Bullets are excluded on purpose — they are fast,
// short-lived, and id-less; plain radius filtering is correct for them. Players are excluded
// too: the party (≤4 members) is a shared objective and always rides every snapshot.
export interface InterestView {
  rev: number;
  enemies: Set<number>;
  props: Set<number>;
  pickups: Set<number>;
  chests: Set<number>;
}

export function createInterestView(): InterestView {
  return { rev: -1, enemies: new Set(), props: new Set(), pickups: new Set(), chests: new Set() };
}

// Snapshot the current server world into a full ServerMsg body for one client. The client's
// own player becomes `self`; everyone else becomes a PlayerWire. events are supplied by the
// caller (per-client reliable stream); evTo is the room's highest committed event id.
export interface SnapshotOpts {
  // The authoritative world id this snapshot describes (REQUIRED — the client asserts it
  // against the room it expected to join; see the v4 protocol note).
  worldId: string;
  // The per-connection monotonic snapshot sequence (v24): the ack target + delta baseline id.
  // Omitted => 0 (direct test callers that don't exercise the delta channel).
  sseq?: number;
  // Every seat in this world (verified identities + on/away), independent of interest
  // filtering. Omitted => empty (direct test callers that don't exercise readiness).
  roster?: RosterWire[];
  // Single-use resume token for the receiving connection (full snapshots only).
  resumeToken?: string;
  // Interest radius in px around the client's view center. Entities outside it are omitted from
  // this client's snapshot (the primary bandwidth + CPU lever). <= 0 disables the filter (send
  // everything) — the default, so direct callers/tests keep full snapshots.
  interestRadius?: number;
  // The client's persistent view membership (enter/exit hysteresis). Omitted => no hysteresis
  // (pure radius filter), which full/bootstrap snapshots and tests use.
  view?: InterestView;
  // Per-player cosmetic identity (verified name/color from each join ticket), keyed by the
  // world-scoped player id. Omitted / missing entries fall back to id-as-name, no color.
  identities?: ReadonlyMap<PlayerId, PlayerIdentity>;
  // The interest view center, when it is NOT the client's own player: a downed spectator's
  // view follows the teammate they are watching, so their snapshots stay coherent with what
  // their camera shows. Omitted => centered on self (the ordinary case).
  viewCenter?: { x: number; y: number };
}

// The party-wait state straight off the sim's pending-blessing map, identical for every
// client (sorted for determinism; whole seconds — a countdown readout, not a timer source).
function partyWait(w: WorldState): WaitWire[] {
  if (w.pendingBlessings.size === 0) return [];
  const out: WaitWire[] = [];
  for (const [pid, left] of w.pendingBlessings) {
    const player = w.players.get(pid);
    const isDraft = w.mode === "pvp" && player?.pvpDraftTrigger !== "none";
    out.push({
      pid,
      s: Math.max(0, Math.ceil(left)),
      k: isDraft ? "pvp_draft" : "blessing",
      tr: isDraft ? player?.pvpDraftTrigger ?? "none" : "none",
      isComeback: isDraft && (player?.pvpDraftTierBump ?? 0) > 0,
    });
  }
  out.sort((a, b) => a.pid.localeCompare(b.pid));
  return out;
}

// Interest management: a client always receives its OWN player, EVERY party member (the
// party is a shared objective — spectate/roster/revive prompts need all of it), globally-
// relevant state (the boss enemy and the boss chest), and, in addition, the nearby
// enemies/bullets/props/pickups/chests within its interest radius (with exit hysteresis).
// A simple distance filter is enough for a single bounded floor.
export function buildSnapshot(
  w: WorldState,
  selfPid: PlayerId,
  ackSeq: number,
  events: WireEvent[],
  evTo: number,
  full: boolean,
  opts: SnapshotOpts,
): ServerMsg {
  const self = w.players.get(selfPid);
  const r = opts.interestRadius ?? 0;
  const r2 = r * r;
  const rExit = r * INTEREST_EXIT_FACTOR;
  const rExit2 = rExit * rExit;
  const center = opts.viewCenter ?? (self ? { x: self.x, y: self.y } : null);
  const view = opts.view;
  if (view && view.rev !== w.rev) {
    view.rev = w.rev;
    view.enemies.clear(); view.props.clear(); view.pickups.clear(); view.chests.clear();
  }
  // No radius, or we don't know where this client is looking yet -> send everything.
  const near = (x: number, y: number, wasKnown: boolean): boolean => {
    if (r <= 0 || center === null) return true;
    const dx = x - center.x, dy = y - center.y;
    const d2 = dx * dx + dy * dy;
    return d2 <= r2 || (wasKnown && d2 <= rExit2);
  };

  const players: PlayerWire[] = [];
  for (const p of w.players.values()) {
    if (p.id === selfPid) continue;
    players.push(toPlayerWire(p, opts.identities?.get(p.id)));
  }
  const enemies: EnemyWire[] = [];
  const keepEnemies = new Set<number>();
  for (const e of w.enemies) {
    if (isBossKind(e.kind) || near(e.x, e.y, view?.enemies.has(e.id) ?? false)) { enemies.push(toEnemyWire(e)); keepEnemies.add(e.id); }
  }
  const bullets: BulletWire[] = [];
  for (const b of w.bullets) if (near(b.x, b.y, false)) bullets.push(toBulletWire(b));
  const props: PropWire[] = [];
  const keepProps = new Set<number>();
  for (const p of w.props) {
    if (near(p.x, p.y, view?.props.has(p.id) ?? false)) { props.push(toPropWire(p)); keepProps.add(p.id); }
  }
  const pickups: PickupWire[] = [];
  const keepPickups = new Set<number>();
  for (const p of w.pickups) {
    if (near(p.x, p.y, view?.pickups.has(p.id) ?? false)) { pickups.push(toPickupWire(p)); keepPickups.add(p.id); }
  }
  const chests: ChestWire[] = [];
  const keepChests = new Set<number>();
  for (const c of w.chests) {
    if (c.kind === "boss" || near(c.x, c.y, view?.chests.has(c.id) ?? false)) { chests.push(toChestWire(c)); keepChests.add(c.id); }
  }
  if (view) {
    view.enemies = keepEnemies;
    view.props = keepProps;
    view.pickups = keepPickups;
    view.chests = keepChests;
  }

  return {
    t: "snap",
    sseq: opts.sseq ?? 0,
    tick: w.tick,
    rev: w.rev,
    ackSeq,
    full,
    over: w.isRunOver,
    selfId: selfPid,
    wid: opts.worldId,
    roster: opts.roster ?? [],
    wait: partyWait(w),
    ...(opts.resumeToken !== undefined ? { tok: opts.resumeToken } : {}),
    seed: w.seed,
    cat: w.catalogVersion,
    floor: w.floor,
    pcl: w.floorDescriptor.playerCountAtLock,
    cleared: isFloorCleared(w),
    exr: playersAtExit(w),
    evTo,
    self: self ? toSelfWire(self) : null,
    players,
    enemies,
    bullets,
    props,
    pickups,
    chests,
    // Unfiltered by design: hazards are hard-capped in the sim, and PREDICTED movement
    // must know about a web before the player walks into interest range of its center.
    hzds: w.hazards.map(toHazardWire),
    // Unfiltered too: the stall is a shared objective (≤5 slots, shop floors only) whose
    // SOLD/claim state every client must agree on regardless of where they stand.
    shop: w.shop ? toShopWire(w.shop, selfPid) : null,
    // Effects share the hazard rule: hard sim caps per family, so the list stays small.
    effs: w.effects.map(toEffectWire),
    // pvp match block (one small object; null in co-op).
    match: w.match ? toMatchWire(w.match, w) : null,
    enc: w.encounter ? toEncounterWire(w.encounter) : null,
    events,
  };
}
