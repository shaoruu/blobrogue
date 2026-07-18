import type { PlayerId } from "./input.js";
import type { EnemyTier } from "./balance.js";

export interface Vec2 { x: number; y: number; }

export interface Entity {
  x: number; y: number;
  vx: number; vy: number;
  radius: number;
  hp: number;
  maxHp: number;
  dead: boolean;
}

export type EnemyKind =
  | "slime" | "bat" | "skeleton" | "ghost" | "spitter" | "charger" | "burrower"
  | "orbiter" | "shielder"
  // The bestiary expansion's first wave (see enemies.ts for each identity):
  //  - rootward: slow formation anchor with a slow-turning frontal guard (flank/melee/pierce);
  //  - echojack: fleeing trickster that plants a false-noise decoy, then blinks sideways;
  //  - seamcutter (the SILT KEEL): previews an oblique wall-to-wall seam, then plows it,
  //    raising ONE persistent berm of destructible silt mounds beside the furrow;
  //  - caskbellows: stationary lane sentry — locked 3-shot volleys, rear-crank stagger;
  //  - sinderling: consumes environmental heat to arm a flame-jet dash + a death burst;
  //  - fragment: tethers to another enemy; the tether is the attack lane (kill/LOS-break defuses).
  //  - mason (the CLINKER MASON, Emberreach worker): builds one handed L-corner of
  //    destructible clinker bricks around a heat vent — persistent topology, replaced
  //    whenever it builds anew.
  | "rootward" | "echojack" | "seamcutter" | "caskbellows" | "sinderling" | "fragment"
  | "mason"
  // Summon-only bodies (never in the floor planner):
  //  - echo: the echojack's 1-HP false-noise decoy — soaks homing/attention, expires quietly;
  //  - knell: The Toll's noise-lure bomb — shoot it before it tolls, or leave its radius.
  //  - knot: the Weaver's lattice ANCHOR NODE — the glowing crossing its thread-lines
  //    meet at, and the anchor of a strung silk LANE. Shooting it collapses the lane
  //    (P1 it EXPOSES the Weaver; P3 the broken lane is the dash-overshoot bait).
  //  - sac: the Weaver's P2 EGG-SAC — bloomed in on an omen tell while she climbs.
  //    Destroying every sac of a clutch forces her down for the earned window.
  | "echo" | "knell" | "knot" | "sac"
  // Miniboss templates (captain machinery, seeded mid-band cadence — see minibossKindForFloor):
  | "marshal" | "toll"
  | "boss" | "marrow" | "choir" | "weaver" | "gilded"
  // Wave 1 deep-floor bosses (THE UNMAKING / The Sump, F35–45 — see world.ts):
  //  - jet (F35): the corrupted MIRROR of the party — casts a frozen archetype-based
  //    MIRROR pool (never live inventory), spent after each corrupted-Resonance salvo
  //    (the exposed window). 3 phases swap the phase body (jet/jet_phase2/jet_phase3).
  //  - tithe (F40): the armored FEEDER — builds a feeding SLAB and re-armors behind it;
  //    destroy the slab before the re-armor channel closes for the exposed window.
  //  - tithe_slab: the Tithe's SEPARATE destructible feeding slab (a mechanic body, not
  //    the feeder), 2-state (intact → cracked) as its HP drops; killing it opens the window.
  //  - quorum (F45): the shared-pool CORE — untargetable behind its three husks until the
  //    telegraphed merge, then the merge-form with its own widened-recover window.
  //  - quorum_shield/heal/dmg: the three role-husks sharing the core's ONE pool + ONE
  //    telegraph; roles gate kill-order (shield guards, heal regens, dmg attacks).
  | "jet" | "tithe" | "tithe_slab"
  | "quorum" | "quorum_shield" | "quorum_heal" | "quorum_dmg"
  // Wave 1 deep-boss SURPLUS adds (4p difficulty — simple chasers on telegraphs that
  // threaten the TASK, not just HP; counted vs the active-threat cap, never complex movers):
  //  - tithe_tribute: a slow amber-glob crawler that shuffles toward the feeding SLAB and
  //    REINFORCES it (heals/thickens) if it reaches it — intercept it or lose slab-break
  //    progress (it is not a threat to the player). Off the Tithe's feed-add surplus path.
  //  - quorum_splinter: a role-echo shard that breaks off a husk WHEN IT DIES, carrying a
  //    WEAK version of its parent's role (heal-trickle / dmg-pip / shield body) — clear the
  //    wave (the kill-order lesson at small scale) before the pool window.
  //  - jet_echo: JET's telegraphed MIRROR-IMAGE of a targeted player — a cold jet-black
  //    reflection that arrives on the fair-ambush omen, fires ONE mirrored-school salvo,
  //    then dissolves into resin flecks. Fragile + brief (dodge your own reflected
  //    aggression, never "fight two Jets"); which player it mirrors rides Enemy.mirrorOf.
  | "tithe_tribute" | "quorum_splinter" | "jet_echo"
  // GORGE (F50 GIANT #1 — the Sump cap, the LOCKED giant template): a colossal ~192px
  // STATIONARY front-facing set-piece pinned to floor 50 (never in the seeded deep rotation).
  // A multi-phase SHELL-PEEL: it fights GUARDED behind a shell (rind → chitin → core) that it
  // sloughs one layer per phase (the sprite swaps off boss.phase). The peel VERB is destroying
  // its telegraphed tectonic WEAK-POINTS (gorge_seam) — clearing a whole exposure routes through
  // the shipped openBossWindow earned-window plumbing (guard chip, window bank, calibration).
  // Its threat is space-control (rings/zones/spokes), never chasing.
  //  - gorge_seam: a tectonic WEAK-POINT that juts out of the current shell — a destructible
  //    mechanic body (like the Weaver's knot / Tithe's slab: no loot, no combo). Destroy the
  //    whole exposed set to crack the shell and open the exposed window on the bared material.
  | "gorge" | "gorge_seam"
  // SEVER (F55 HUNT/INTERCEPT — Batch1 OWNER LOCK): ONE isBossKind chase core that flees
  // through RoomEdges across 3 checkpoints. Signature move WORLDSPLIT (wire: "worldsplit").
  //  - sever_anchor: resin ANCHOR tooth (mechanic body) — destroy 2 per checkpoint room to
  //    trap both exits and open the intercept damage window. Never a boss kind.
  | "sever" | "sever_anchor"
  // HOLLOW CHOIRMASTER (F60 SPLIT/SILENCE — Batch2A OWNER LOCK): ONE isBossKind conductor in
  // a multi-lobed super-room (structureKind 'split'). Signature move THE LAST NOTE (wire:
  // "last_note"). Pillars / sheet fronts are mechanic bodies — never a second boss core.
  //  - choir_pillar: resonating pillar (mechanic body) in a linked lobe — silence the CURRENT
  //    live pillar to advance the phrase; wrong/dormant wakes pressure, never a wipe.
  | "choirmaster" | "choir_pillar"
  // UNDERTOW (F65 STEAL/ESCAPE — Batch2B OWNER LOCK): ONE isBossKind when manifested.
  // Reverse-floor pursuit (structureKind 'escape'). Signature THE RIVER COMES BACK
  // (wire: "river_comes_back"). BLACK_TIDE retired — never revive.
  //  - warm_pulse: carried Warm Pulse prop (mechanic body / world-pickup) — steal then deposit.
  //  - relief_vent: highlighted deposit / relief vent along the reverse route (mechanic).
  //  - flood_front: untargetable advancing flood marker (mechanic, never a second boss core).
  | "undertow" | "warm_pulse" | "relief_vent" | "flood_front"
  // CLAIMANT (F70 PASS-THE-CLAIM — Batch3A OWNER LOCK): ONE isBossKind guarded core in a
  // compact coordination arena (structureKind 'arena'). Verb PASS-THE-CLAIM: one player
  // carries a claim-token (the marked target); carrier fire cannot break the Claimant's
  // guard, so the team must deliberately pass. Signature ALL THINGS OWED (wire:
  // "all_things_owed"). CROWNFALL retired — never revive.
  //  - claim_token: carried/socketed/world-pickup coordination token (mechanic body).
  //  - claim_socket: deposit socket; exactly one lights after aim lock as the Owed counter.
  | "claimant" | "claim_token" | "claim_socket"
  // THE WAKE (F80 PROTECT/ADVANCE — Batch3B OWNER LOCK): ONE isBossKind guarded shadow that
  // manifests at thresholds (structureKind 'escort'). Verb PROTECT/ADVANCE: an autonomous
  // last-light convoy advances spawn→exit across RoomEdges; the team escorts it inside a
  // continuous warmth corridor, clearing one highlighted blocker before each threshold while a
  // dark front follows from behind. Signature THE LAST PROCESSION (wire: "last_procession").
  // NIGHTFALL_PROCESSION retired — never revive.
  //  - warm_bier: the autonomous convoy body / continuous safe corridor (mechanic body).
  //  - convoy_blocker: the ONE highlighted blocker before a threshold (peel target, mechanic).
  //  - shadow_front: the untargetable dark front that follows the convoy from behind (mechanic).
  | "wake" | "warm_bier" | "convoy_blocker" | "shadow_front"
  // PALE THRONE (F75 GIANT #2 — the Pale region cap): the SECOND giant, inheriting the Gorge
  // shell-peel grammar EXACTLY (a ~192px STATIONARY front-facing set-piece pinned to floor 75,
  // shared giant-encounter core), with the MATERIAL swapped to COLD warmth-drain (a blazing
  // ABSENCE of warmth — cold-blue seams + a cold-white/blue crystalline throne-core — never
  // amber). pale_seam is its cold weak-point, the peel-verb mechanic body (= gorge_seam).
  | "pale" | "pale_seam";

// Telegraphed-attack state machine. Committed attacks read as
// CHASE -> WINDUP (telegraph, aim locks partway) -> ACTIVE -> RECOVER -> cooldown.
export type AttackPhase = "none" | "windup" | "active" | "recover";
// Which move an attacker is mid-executing. The bosses own several; others own one or two.
// Shared grammar is deliberately reused across bodies so reads transfer:
//  - "rush"/"crash": a telegraphed straight rush (charger + MARROW) whose wall impact swaps
//    the move to "crash" for the longer, punishable stun recover.
//  - "dive"/"erupt": the burrower's underground cycle.
//  - "volley"/"spin"/"shield": MARROW's fans, spiral barrage, and husk-shield beat.
//  - "fade"/"wail"/"split": the Hollow Choir's intangible drift, homing wails, and
//    wisp-split transition beat.
//  - "pounce"/"weave": the Weaver's marked leap and web-planting.
//  - "slam"/"sweep": the Gilded Warden's in-place marked quake and heavy ring waves
//    (its sanctify beat reuses "roar" — same fixed-beat semantics as the King).
//  - "decoy"/"blink": the echojack's plant-a-false-noise beat and its perpendicular
//    relocation dash (blink is the visible escape, never a teleport).
//  - "seam": the seamcutter's full lane — windup previews the wall-to-wall cut, active
//    travels it, recover is the punish window at the far wall.
//  - "stoke": the sinderling's self-arming channel when no environmental heat is near.
//  - "harmonize": the fragment's tether pulse — the line to its source becomes the lane.
//  - "knell": The Toll's ring — a radial sound wave (its aimed lane reuses "volley").
//  - "volley" is shared grammar: MARROW's fan, the caskbellows' 3-shot lane, The Toll's
//    aimed peal, the marshal's P2 fan — one read (aimed ranged commitment) everywhere.
//  - "crash" is shared grammar for every punishable self-stun: wall crashes AND the
//    caskbellows' rear-crank stagger.
//  - "roar" is shared fixed-beat grammar: boss transitions AND the commander elite's rally.
export type AttackMove =
  | "none" | "lunge" | "spit" | "hopslam" | "radial" | "roar" | "squeeze"
  | "rush" | "crash" | "dive" | "erupt" | "volley" | "spin" | "shield"
  | "fade" | "wail" | "split" | "pounce" | "weave" | "slam" | "sweep" | "brace"
  | "decoy" | "blink" | "seam" | "stoke" | "harmonize" | "knell"
  // The worker verb: a long stationary tell, then ONE persistent construction is raised
  // (the bailiff's root divider, the mason's clinker L-corner, the Tithe's feeding slab).
  // Never aimed at a body — the site is the mark.
  | "build"
  // JET's corrupted-Resonance salvo: the telegraphed multi-verb barrage drawn from its
  // frozen archetype MIRROR pool; the spent recover after it is the exposed window.
  | "mirror"
  // QUORUM's telegraphed 1.2s NON-invuln transition: the three husks fuse into the
  // merge-form (the shared telegraph the whole fight builds toward).
  | "merge"
  // Wave 1 rework — the deep bosses' interleaved pressure moves (no lone strafable shots):
  //  - "tracer": JET's dash-punish motes — they lock, hover, then SNAP to the mark;
  //  - "beam":   a laser CORRIDOR telegraph (JET's overclock feint + P3 corruption, Quorum
  //    crossfire) — cover the lane, dodge through the authored gap;
  //  - "spew":   the Tithe's two-stage arcing-pool barrage (read wave 1, then its gaps);
  //  - "hurl":   the Tithe throws its own slab as a line projectile (leaving a side open);
  //  - "rip":    the Tithe's P3 SIGNATURE — it rips ALL its plating into a slow rotating
  //    barrage wheel, then collapses into a long exposed window (a dedicated move so the
  //    debris-wheel VFX binds to a real signal, not shared with MARROW's "spin").
  | "tracer" | "beam" | "spew" | "hurl" | "rip"
  // SEVER F55 signature — WORLDSPLIT: 1.5s blade-plant tell → 1.2s moving fracture → 3.0s
  // reel-back punish. Display name is always WORLDSPLIT; wire id is the closed AttackMove.
  | "worldsplit"
  // PALE THRONE F75 signature — THE LAST LIGHT FALLS: 1.8s ceiling/meteor tell → three
  // sequential scar relights (≥0.65s each, one active) → 1.0s redirected fall → 4.0s core
  // punish. Display name THE LAST LIGHT FALLS; wire id is the closed AttackMove.
  | "last_light"
  // HOLLOW CHOIRMASTER F60 signature — THE LAST NOTE: 1.6s silent inhale/gesture →
  // directional pressure sheet advances ~0.7s per linked span → 4.0s voiceless punish.
  // Display name THE LAST NOTE; wire id is the closed AttackMove.
  | "last_note"
  // UNDERTOW F65 signature — THE RIVER COMES BACK: 1.6s flood tell → 1.2s advancing front →
  // 3.5s punish window. Display name THE RIVER COMES BACK; wire id is the closed AttackMove.
  // BLACK_TIDE retired — never revive.
  | "river_comes_back"
  // CLAIMANT F70 signature — ALL THINGS OWED: 1.4s angular crown/beam tell → aim locks at
  // 0.84s (60% of the tell) → 0.6s descent → 3.0s kneel punish. The crown-lane targets the
  // claim-token carrier; exactly one socket lights after the lock. Display name ALL THINGS
  // OWED; wire id is the closed AttackMove. CROWNFALL retired — never revive.
  | "all_things_owed"
  // THE WAKE F80 signature — THE LAST PROCESSION: 1.5s blackout/flood tell → a dark front
  // follows the convoy to the threshold (moving-front) → 4.0s light-bound manifestation punish.
  // Success = escort the convoy across the threshold in the warmth corridor with the highlighted
  // blocker cleared → the Wake is forced into light. Display name THE LAST PROCESSION; wire id is
  // the closed AttackMove. NIGHTFALL_PROCESSION retired — never revive.
  | "last_procession";

// Grouped so the whole attack subsystem lives in one cohesive place per enemy
// (allocated once at spawn, never per frame).
export interface AttackState {
  phase: AttackPhase;
  time: number;        // seconds elapsed in the current phase
  move: AttackMove;
  windup: number;      // 0..1 telegraph progress; drives tint pulse / aim line / marker
  cooldown: number;    // seconds until this enemy may commit again
  lockedAngle: number; // aim direction captured partway through the windup
  isAimLocked: boolean;// whether lockedAngle has been captured this windup
  markX: number;       // world-space AoE marker point (locked hop-slam tile)
  markY: number;
}

// A live phase-transition roar (the anti-burst beat): hard HP floor + queued overflow that
// applies only after the roar exits. queuedBy remembers the last damaging actor so an
// overflow kill still credits a player.
export interface BossRoar {
  floorHp: number;
  queued: number;
  queuedBy: PlayerId | null;
}

// Boss-only extra state (HP-phase tracking + add/attack pacing), shared by every boss.
// Phase transitions are driven by damage events (checked after every authoritative hit),
// never idle polling. The transition beat — the King's roar, MARROW's shield, the Choir's
// split, the Weaver's molt, the Warden's sanctify — is ONE anti-burst mechanism
// (reduction + HP floor + queued overflow), five presentations.
export interface BossState {
  phase: number;           // 1..3
  transitionsDone: number; // 0..2 — which of the two transition beats have fired
  roar: BossRoar | null;   // non-null while a transition beat is active
  addTimer: number;        // countdown until the next cadence add spawn
  attackCount: number;     // attacks committed in the current phase (special-move cadence)
  isNextRadial: boolean;   // per-boss two-move alternation flag (hop/radial, rush/volley, …)
  burstParity: number;     // per-boss parity scratch (radial offset, spiral direction, …)
  // Interactive transition beats (MARROW husks, Choir wisps): the beat's summoned add ids —
  // killing them ALL drops the beat early. Empty on fixed-duration beats (King/Weaver/Warden).
  beatAddIds: number[];
  // Sequenced-emission scratch: shard pairs fired this spiral (MARROW), waves released this
  // sweep (Gilded Warden), pounces chained this commitment (Weaver).
  spinCount: number;
  // ---- EARNED WINDOWS (deep bosses: Weaver / Warden / MARROW / Choir) ----
  // By default an earned-window boss is GUARDED (damage chipped to its guardMult, never
  // immunity). Performing the phase's mechanic — breaking a lattice knot, baiting the
  // pounce onto thread debris, silencing the Choir fragments, punishing the wall crash —
  // opens a fixed EXPOSED window of full damage. Seconds left in that window (0 = guarded).
  exposed: number;
  // Per-window damage bank: what the CURRENT window may still remove before it slams
  // shut early. Armed when a fresh window opens (bankFrac × maxHp — the phase chunk), so
  // stacked firepower converts a window harder but can never one-shot a phase through it.
  windowBank: number;
  // Mechanic adds gating the NEXT window (the Choir's fragments): killing every one
  // opens the window. Empty when no silence set is live. Distinct from beatAddIds —
  // those belong to the transition beat, these to the earned-window loop.
  windowAddIds: number[];
  // The Weaver's committed lane: the knot id (+1) whose thread it is traveling — the
  // P1 blink (shoot the knot to SNAG it) and the P3 charge-dash (a dead knot can't
  // brake it: the overshoot) both ride it. 0 = no lane committed.
  laneKnotId: number;
  // Fair surprise §1: the add pool's previous draw index (-1 = none yet) — weighted
  // selection never repeats the exact entry twice in a row, so waves can't be rote.
  lastAddPick: number;
  // QUORUM only, P1 husk lifecycle — a LOOP (not one-way): the trio cycles three-husk/tether-up
  // -> husks die by priority (shield->heal->dmg) -> all-dead/pool-EXPOSED -> RESPAWN -> repeat,
  // until the merge at 45% (state 4, the sole one-way terminal transition).
  //  - huskRaised: the trio has been raised at least once (distinguishes the FIRST raise from a
  //    post-clear RE-FORM, so the initial raise isn't preceded by a phantom tether-snap);
  //  - huskGuardUp: a husk still guards the core (its beams ARE the guard). True while any husk
  //    stands; drops when the trio is cleared (the core is then EXPOSED — targetable + full
  //    damage — for the reform delay); back true when the fresh trio re-forms;
  //  - huskReformTimer: seconds left in the pool-EXPOSED window before the trio re-forms.
  huskRaised: boolean;
  huskGuardUp: boolean;
  huskReformTimer: number;
  // JET only: the current MIRROR salvo's lead Resonance-family index (into RESONANCE_FAMILIES),
  // or -1 when the current commitment isn't a mirror salvo. Rides the wire (EnemyWire.mfm) so the
  // client draws the copied weapon's SHAPE (fan/lane/ring/parabola/wedge) and its OWN family hue
  // (the "recognize your gun" read) — the same enum the sim colors the mirrored shards with.
  mirrorFamily: number;
  // JET only (fair surprise §5g B1): the RESONANCE_FAMILIES index of the PREVIOUS mirror
  // salvo's lead school (-1 = none yet). The next salvo's weighted draw excludes it, so
  // JET never turns the SAME of your guns on you back-to-back (the drawFromAddPool
  // lastAddPick non-repeat law, applied to the verb draw). Sim-internal scratch, never wired.
  mirrorLastFamily: number;
  // ---- the R framework (party+gear-aware scaling; see balance.ts POWER) ----
  // Seconds spent in the CURRENT phase — the soft-enrage yardstick.
  phaseTime: number;
  // 1 while the current phase carries its authored extra PATTERN (the "you skipped
  // the lesson" beat: the previous phase was burned faster than burnFrac × its
  // R-scaled budget). Never damage, never HP, never invuln — one more readable
  // pattern in the rotation. 0 otherwise.
  enrage: number;
  // The phase's one surprise wave (R ≥ surpriseMinR) has been spent. Reset each phase.
  isSurpriseSpent: boolean;
  // Wave 1 boss-affix cadence: seconds until the next affix beat (the deep-boss extra
  // telegraphed pattern from FloorDescriptor.bossAffix). Sim-internal — never on the wire (the
  // affix expresses through the telegraphed "charge" hazards it blooms, which ride hzds).
  affixCd: number;
  // ---- GIANT (F50 Gorge / F75 Pale Throne / F100 Unmaker) shell-peel scratch (sim-internal; the
  // wire needs none of it — the shell phase rides bph, the exposed remainder rides aux, the seam
  // bodies ride their own EnemyWire). The exposure CADENCE reuses the generic addTimer (the giant
  // runs no add drip); the live seam ids ride the shared windowAddIds list (the "kill all to open
  // the window" set, exactly the Choir's fragment contract). This is the ONE giant-specific field: ----
  // Seconds left before the current weak-point exposure RETRACTS unspent (the CORE's short
  // window is the execution test). 0 while the shell is sealed. Clearing the whole set before it
  // elapses cracks the shell → openBossWindow (peels re-seal + re-expose until the shell's HP
  // chunk is spent, when the layer SLOUGHS at the phase transition).
  seamLife: number;
}

export interface Enemy extends Entity {
  id: number;          // stable per-world id (client keys its cosmetic anim map by this)
  kind: EnemyKind;
  // Variety tier (§4): swarm/standard/brute/elite stat + cost + render-scale profile.
  tier: EnemyTier;
  // Boss-spawned / elite-split adds: excluded from natural heart drops and Fang procs so
  // summons are pressure, never a sustain farm.
  isSummoned: boolean;
  speed: number;
  touchDamage: number;
  // Knockback divisor, baked at spawn (archetype × tier × co-op stagger resist).
  kbResist: number;
  // Boss P2 pack-surge scratch: a delayed order (surgeDelay counts down) followed by a
  // short burst of chase speed (surgeTime). Zero on everything untouched by the order.
  surgeDelay: number;
  surgeTime: number;
  // Gauntlet captains (corrected gate §3): 1 before the 50% split, 2 after. Undefined on
  // every ordinary enemy — the two-phase check runs only on captains.
  captainPhase?: number;
  // The elite brace affix's cooldown (keeps its duty cycle ≤35%). Only elites tick it.
  braceCd?: number;
  // The ROLLED elite affix (Wave 1 randomness layer), assigned to deep-floor (F31+) elites by
  // ascending spawn ordinal from the frozen FloorDescriptor.eliteAffixes — a RollAffixId
  // ("splits"/"shielded"/"hazardTrail"/"reflect"/"enrage") or "" for none. Orthogonal to the
  // kind-baseline elite identity (ELITE_AFFIXES): the rolled affix is the fresh-run variety
  // layer, ≤1 per elite, and rides the wire (EnemyWire.afx) so clients draw its material tell.
  rollAffix: string;
  // The rolled affix's per-body SCALAR (its OWN channel, distinct from `aux` so it never collides
  // with a kind's aux mechanic — sinderling armed flag, fragment tether id, bulwark plate): a
  // shielded slab's remaining HP, or a reflect facet's armed state (>0 = armed, 0 = cracked).
  // Rides the wire (EnemyWire.afs) so clients render armed/slab state. 0 for other affixes.
  affixState: number;
  // hazardTrail drip accumulator (seconds since the last cinder drop); reflect crack cooldown
  // (seconds a cracked facet stays disarmed). Both sim-internal — the client reads afs/rollAffix.
  affixClock: number;
  // The one per-kind/per-affix AUXILIARY channel that rides the wire (EnemyWire.aux) so
  // the client can render authoritative special state without a bespoke field per kind:
  //  - sinderling: 0 = unarmed, 1 = armed (stoked — jet + death burst live);
  //  - echo/knell: remaining decoy life in seconds (drives the client fade/fuse);
  //  - knot: remaining lattice life in seconds; sac: 0 (its read is the body itself);
  //  - fragment: tethered source enemy id + 1 (0 = untethered — the simplified pattern);
  //  - bulwark elites: remaining plate HP (0 = shattered);
  //  - earned-window bosses (Weaver/Warden/MARROW/Choir): seconds left in the current
  //    EXPOSED window (0 = guarded) — the client's guard/exposed render keys off it;
  //  - everyone else: 0.
  aux: number;
  // Generic per-behavior sequence counter (sim-internal, never on the wire): the
  // seamcutter's sweep emissions, the caskbellows' volley shots, the sinderling's wedge
  // drops, the marshal/toll attack alternation. Reset by each move's begin. The
  // Weaver's mechanic bodies (knot/sac) never attack and carry their CASTER's enemy
  // id + 1 here instead (a lattice always belongs to the weaver that spun it).
  seq: number;
  // Commander-elite pack panic: seconds this body flees leaderless (no attack triggers
  // from idle while it runs). Sim-internal — clients read the movement itself.
  panicTime: number;
  // Echoed-elite scratch: a scheduled repeat of the last ranged release (echoTime counts
  // down; echoAngle is the locked bearing it refires along). Sim-internal.
  echoTime: number;
  echoAngle: number;
  // Per-behavior scratch state.
  zig: number;         // heading offset used by the bat's erratic drift
  // Deterministic slime hop-cadence clock. The slime pulses its speed off sin(hopClock);
  // hopMove eases 0..1 with movement to modulate the clock rate. Seeded from the sim Rng
  // (not the cosmetic anim clock) so movement stays reproducible. Mirrors the anim clock's
  // old evolution exactly, so behavior is unchanged.
  hopClock: number;
  hopMove: number;
  spawnTimer: number;  // spawn-in grace: counts to 0 before the enemy may attack
  // Anti-stuck safety net: seconds a chaser has been trying to move but barely
  // progressing (wedged on geometry / another body). Nudged perpendicular once it trips.
  stuckTimer: number;
  // Prop-avoidance side commitment: which way this chaser is detouring around the prop
  // blocking its path (-1/+1; 0 = none). Held for a short window after the last block so a
  // dead-on approach can't ping-pong left/right into the prop every tick.
  avoidSide: number;
  avoidTime: number;   // seconds the current side commitment persists after the last block
  // Elemental status scratch (allocated at spawn, ticked in updateEnemies). Same local
  // per-enemy model as hp/knockback — driven by bullets, so co-op stays desync-free.
  burn: number;       // seconds of burn DoT left
  burnDmg: number;    // burn damage per second (stacks up to a cap)
  chill: number;      // seconds of slow left (high stacks freeze solid)
  meleeSlowT: number;
  meleeSlowMult: number;
  meleeSlowAppliedTick: number;
  shock: number;      // seconds the shocked tag is active (amp + on-hit arc)
  // PHANTOM MARK (Wave 2): seconds the +vuln dash-through mark is live (0 = unmarked). A shared
  // authoritative vulnerability the whole team's damage reads; against boss-grade bodies it shares
  // the BOSS_VULN_CAP with the crit channel (never additive on top). Rides the wire (EnemyWire.mkt)
  // so every client draws the marked glow. Decays in tickStatuses.
  markT: number;
  // Cat STALK info mark (PROTOCOL 46): seconds an INFO pip stays over this body (0 = unmarked).
  // Purely a readout — it never amplifies damage, stuns, phases, or reveals; the whole point of a
  // separate field from `markT` is that it carries NO gameplay effect. Rides the wire
  // (EnemyWire.pmk) so every client draws the pip. Decays in tickStatuses.
  petMarkT: number;
  // Known by Touch (Wave B): seconds a body stays REVEALED — an evasion-untargetable body
  // (a diving burrower, a faded choir, a blinking weaver) can be hit while this is live.
  // Sim-internal, transient, never on the wire.
  revealT: number;
  statusTick: number; // burn DoT accumulator (fires a tick every 0.25s)
  // Who applied the current burn (authoritative kill attribution for the DoT). Solo: always
  // the single local player. Multiplayer: the shooter/exploder who lit the enemy, so the burn
  // tick that finishes a kill credits the correct player's combo/loot. null before any burn.
  burnOwner: PlayerId | null;
  // JET mirror-image echo (kind "jet_echo"): WHICH player this reflection mirrors. The
  // targeted player reads it as "that's ME"; teammates read "[name]'s reflection". Rides
  // the wire (EnemyWire.mir) so every client draws the co-op read authoritatively. null on
  // every non-echo body (same local per-body ownership model as burnOwner).
  mirrorOf: PlayerId | null;
  attack: AttackState;
  boss: BossState | null; // set only on the boss
}

export type WeaponId =
  | "pistol" | "shotgun" | "rapid"
  | "smg" | "cannon" | "burst" | "ricochet" | "homing" | "tesla"
  | "sawnoff" | "railgun" | "nailer" | "flamer" | "mortar" | "beam"
  | "sword" | "longsword" | "spear"
  // The effect wave: seven non-projectile room verbs built on four shared primitives
  // (PlacedEffect zone/wire, OrbitEffect, DeployableEffect, Tether — see Effect below).
  | "lastlight" | "breach" | "snapwire" | "frostline" | "halo" | "sentry" | "crook"
  // The legendary wave — each is ONE signature mechanic, never bigger numbers:
  //  - reaper: kills burst into seeking soul shards that cascade through the pack;
  //  - swarm: one slow trigger pull releases a volley of accelerating seeker darts;
  //  - midas: eats a coin per shot to hit far harder (fires weak when broke);
  //  - phase: rounds pass straight through walls — cover is the player's, never the room's;
  //  - vortex: shots implode, dragging every nearby body onto the impact point.
  | "reaper" | "swarm" | "midas" | "phase" | "vortex"
  // The content wave — new guns built entirely on the existing one-behavior-field pattern
  // (cleaver/scrapper/skipper/arcbolt/cryobolt/firebomb/tracker) plus one legendary that
  // carries a single new isolated field (singularity: implode THEN a delayed nova blast).
  | "cleaver" | "scrapper" | "skipper" | "arcbolt" | "cryobolt" | "firebomb" | "tracker"
  | "singularity"
  | "mooring_nail" | "sluicegate" | "oddsmaker" | "pathmaker"
  // Content Wave B — four more room verbs on the same one-isolated-field pattern:
  //  - resonant_fork: TUNE — a hit links its target to a nearest neighbor, resonating it;
  //  - red_pen: SET / REWRITE — ink marks a body, a snap consumes the mark for burst;
  //  - margin_call: COPY-ONE — stores one payload class off another weapon and echoes it;
  //  - sidewinder: ENCIRCLE / FLANK — a two-arc volley that curves in to hit the flank.
  | "resonant_fork" | "red_pen" | "margin_call" | "sidewinder"
  // Content Wave C — four guns-only room verbs (catalog 3), same isolated-field pattern:
  //  - hushiron: ROOT / RAMP — standing still ramps stance stacks that tighten spread + pierce;
  //  - backtalk: PARRY / RETURN — a frontal window catches an enemy shot and fires it back;
  //  - lamplighter: RELIGHT — a shot through warm light gains pierce and plants a safe patch;
  //  - faultlink: LINK / SHARE — marks two bodies and echoes primary damage between them.
  | "hushiron" | "backtalk" | "lamplighter" | "faultlink";

// Drop-quality tier. Drives drop weighting (legendaries are genuinely rare and gated off
// the earliest floors), the pickup/hotbar/tooltip rarity treatment, and shop pricing.
export type WeaponRarity = "common" | "rare" | "legendary";
export type SluiceMode = "flood" | "drain";
export type OddsmakerOutcome = "ricochet" | "seeker" | "blast" | "pierce";
// Margin Call's storeable payload classes — exactly one is captured off the owner's
// previous committed shot; `gamble` (the Oddsmaker) is explicitly NOT storeable.
export type MarginCategory = "slug" | "spread" | "pierce" | "blast" | "seeker" | "status";

// A mystery pickup's baked reveal twist: a small buff or a small drawback rolled at spawn
// (deterministic from the seed), so opening one is a real gamble — never a dead result.
export type MysteryTwist = "plain" | "blessed" | "cursed";

// ---- weapon effect entities (the effect wave's shared authoritative primitives) ----
// Every non-projectile weapon output lives in ONE world list (w.effects), stepped in
// updateEffects on the fixed world phase — server-owned, deterministic, and serialized on
// the snapshot like bullets/hazards. Each entity carries its owner for the same immutable
// attribution contract bullets follow (a departed owner's effect keeps working, credits
// no one) and `fx` — the authoring weapon — for knockback profile, boss coefficient and
// the client render recipe.

export type EffectKind = "zone" | "wire" | "orbit" | "sentry" | "tether" | "sanctuary" | "aegis";

export interface EffectBase {
  id: number;              // stable per-floor id (wire identity + client anim keying)
  kind: EffectKind;
  owner: PlayerId | null;  // authoritative attribution (kills/combo credit this player)
  fx: WeaponId;            // authoring weapon: KB profile, boss coef, render recipe
  x: number; y: number;
  life: number;            // seconds until the effect expires
  maxLife: number;         // authored duration (drives the client's fade render)
}

// A painted ground zone (the Frostline's chill trail): standing enemies accumulate chill
// (slow, then freeze — bosses slow but never freeze, same as the Cryo blessing).
export interface ZoneEffect extends EffectBase {
  kind: "zone";
  radius: number;
  chillRate: number; // seconds of chill applied per second an enemy stands inside
  isPaved: boolean;
}

// An armed line trap (the Snapwire): a wire strung from (x,y) to (x2,y2) that snaps on
// the first body crossing it once armed, striking EVERY enemy in the band.
export interface WireEffect extends EffectBase {
  kind: "wire";
  x2: number; y2: number;
  width: number;  // trigger band around the segment (px)
  arm: number;    // seconds until armed (0 = live); planting is never a free point-blank hit
  damage: number; // base snap damage (the owner's live damage mult applies at snap time)
}

// Orbiting blades around the owner (the Razor Halo): contact damage on a per-enemy re-hit
// cadence; the active flares the ring outward for a beat.
export interface OrbitEffect extends EffectBase {
  kind: "orbit";
  angle: number;       // shared blade phase (rad)
  ring: number;        // current ring radius px (eases toward base/flare target)
  blades: number;
  bladeRadius: number;
  speed: number;       // orbit angular speed (rad/s)
  flare: number;       // seconds of active expansion left
  damage: number;      // base per-blade contact damage
  // Per-enemy re-hit cooldowns (sim-internal scratch, never on the wire): a body inside
  // the ring is struck on a readable cadence, not once per tick.
  rehit: Map<number, number>;
  // PVP-only per-FOE-PLAYER re-hit cadence (string player ids can't share the numeric `rehit`
  // map). Sim-internal, lazily allocated, never on the wire; undefined in co-op.
  rehitP?: Map<PlayerId, number>;
}

// A destructible lane-holding turret (the Prism Sentry): acquires the nearest enemy in
// line of sight and fires owner-attributed bolts; enemy fire and contact chew it down.
export interface SentryEffect extends EffectBase {
  kind: "sentry";
  radius: number;     // body radius (enemy bullets/contact test against it)
  hp: number; maxHp: number;
  fireCd: number;
  range: number;
  boltSpeed: number;
  boltRadius: number;
  boltDamage: number; // base bolt damage (owner's live damage mult applies at fire time)
  boltPierce: number;
  contactCd: number;  // cadence gate for enemy-contact damage (sim-internal)
  targetEid: number;  // last acquired target id (-1 = none) — drives the acquire cue
}

// A latched chain (the Crooked Chain): pulls the target to the owner — or, against a
// brute/elite/boss, pulls the OWNER to the target — then holds a short sweep window.
export interface TetherEffect extends EffectBase {
  kind: "tether";
  eid: number;              // tethered enemy id
  phase: "pull" | "hold";
  isPlayerPulled: boolean;  // heavy bodies invert the pull (the risk half of the verb)
  pullSpeed: number;
  holdDist: number;
  holdTime: number;         // authored hold window entered once the pull resolves
  pullTime: number;         // remaining pull budget (bounds the yank)
  damage: number;           // base sweep damage
  reach: number;            // sweep radius around the owner
}

// The MENDER's SANCTUARY ult zone (spec §2.2): a deterministic ground zone with a fixed
// lifetime that heals allies standing inside on a capped cadence (never past maxHp, never
// out-healing all incoming damage). Server-owned + reconciled from the snapshot like every
// other effect entity. healRate is sim-internal (the client renders by kind, not by rate).
export interface SanctuaryEffect extends EffectBase {
  kind: "sanctuary";
  radius: number;
  healRate: number; // HP/sec target (sim-internal; the cap is enforced by the heal cadence)
}

// The BULWARK's AEGIS ult dome (spec §2.3): a deterministic barrier that BLOCKS enemy
// projectiles crossing inward (allies shoot OUT freely) until its HP budget is spent OR its
// duration elapses, whichever first — cover, never invuln. Server-owned + reconciled.
export interface AegisEffect extends EffectBase {
  kind: "aegis";
  radius: number;
  hp: number; maxHp: number; // barrier HP budget: each blocked enemy projectile costs 1
}

export type Effect = ZoneEffect | WireEffect | OrbitEffect | SentryEffect | TetherEffect | SanctuaryEffect | AegisEffect;

export interface Bullet {
  x: number; y: number;
  vx: number; vy: number;
  radius: number;
  life: number;
  friendly: boolean;
  // The player who fired this bullet (authoritative attribution: kills/coins/combo/lifesteal go
  // here). null for enemy fire. Solo: always the single local player, so behavior is unchanged.
  owner: PlayerId | null;
  damage: number;
  color: string;
  pierce: number;          // remaining enemies this bullet can punch through
  hitList: Enemy[] | null; // enemies already struck (only allocated for piercing shots)
  isCrit: boolean;         // rolled at fire time; drives the brighter hit feedback
  // The crit multiplier baked into damage when isCrit (the boss vulnerability channel
  // divides it back out at strike time). Undefined = 1.
  critX?: number;
  // Boss-facing pellet/weapon coefficient baked at fire time (rooms take full damage).
  // Undefined = 1.
  bossCoef?: number;
  // Optional per-weapon behaviors. Undefined for the base weapons, so their bullets
  // take the exact same paths they always did.
  bounce?: number;         // ricochet: wall reflections left before the bullet dies
  homing?: number;         // homing: steering turn rate (rad/s) toward the nearest enemy
  chain?: number;          // tesla: lightning jumps left after the first hit
  chainRange?: number;     // tesla: max px a chain jump can reach
  blast?: number;          // mortar: AoE radius — the shell detonates on impact/expiry
  // The Weaver's aimed SILK (sim-internal, enemy fire only): the bolt WEBS where it
  // dies — wall, floor or the player it caught. Undefined on every other round.
  isSilk?: boolean;
  // Breach shell: an artillery lob that sails OVER bodies (the enemy-collision loop skips
  // it) and detonates only at its charged landing point (end of life) or on a wall face.
  isLob?: boolean;
  // The lob's released charge fraction (0..1). At BREACH_LINE_TIER+ the detonation walks
  // a LINE of blasts back along the approach (the full charge changes geometry).
  lobT?: number;
  // Persistent-source round (a sentry bolt): against boss-grade bodies its damage draws
  // from the party's shared persistent budget (see drawPersistentBossBudget). Sim-internal
  // — never on the wire.
  isPersistent?: boolean;
  // Frostline painting: every `paintSpacing` px of travel the bead drops a chill zone
  // (radius/life/rate authored by the weapon's paint spec, mods applied at fire time).
  // paintDist is the travel accumulator (sim-internal, never on the wire).
  paintSpacing?: number;
  paintRadius?: number;
  paintLife?: number;
  paintRate?: number;
  paintDist?: number;
  isPaving?: boolean;
  grapplePull?: number;
  reclaimedBounceDamage?: number;
  paintZonesLeft?: number;
  shotSeq?: number;
  enemyHits?: number;
  sluiceMode?: SluiceMode;
  oddsmakerOutcome?: OddsmakerOutcome;
  // Wave B round channels (undefined on every other round; sim-internal unless noted).
  isForkPrimary?: boolean;  // resonant_fork: a primary hit opens/refreshes the owner's tune link
  isPenInk?: boolean;       // red_pen: an ink round marks the body it hits
  isPenSnap?: boolean;      // red_pen: the REWRITE snap burst (consumes a mark)
  isMarginCopy?: boolean;   // margin_call: a stored-payload echo (never re-storeable)
  sidewinderArc?: number;   // sidewinder: authored arc index 0..1 (curving flank round)
  sidewinderTurn?: number;  // sidewinder: signed turn rate (rad/s) the arc curves at
  sidewinderAim?: number;   // sidewinder: the original aim, for the flank-angle test
  crosscurrentJumps?: number;   // crosscurrent: chain jumps this round still owns
  crosscurrentRange?: number;   // crosscurrent: max px a jump may reach
  crosscurrentCoef?: number;    // crosscurrent: jump damage vs the prior hit
  crosscurrentPreferNew?: boolean; // crosscurrent Lv3: prefer an unhit target
  crosscurrentTax?: number;     // crosscurrent combo tax multiplier on jump damage (1 = none)
  // Wave C round channels (undefined on every other round; sim-internal unless noted).
  isHushSlug?: boolean;     // hushiron: a stance-ramp slug (tracks lit-travel distance for FX)
  isBacktalkReturn?: boolean; // backtalk: the caught-and-returned round (1.15x caught dmg)
  isLampShot?: boolean;     // lamplighter: a relight round (accrues lit-travel for pierce/patch)
  lampLitDist?: number;     // lamplighter: px this round has travelled through warm/objective light
  lampLit?: boolean;        // lamplighter: latched once the lit-path threshold is crossed
  isFaultPrimary?: boolean; // faultlink: a primary round that marks the body it hits
  isFaultEcho?: boolean;    // faultlink: a shared echo round (no crit/status/proc/recurse)
  isSideChannelGhost?: boolean;
  // Elemental status a bullet stamps on the enemy it hits (see applyBulletStatuses).
  // Undefined on plain rounds; the value is the status duration in seconds.
  burn?: number;           // seconds of burn DoT the round applies
  chill?: number;          // seconds of chill the round applies
  shock?: number;          // seconds of shock the round applies
  // Legendary gimmick channels (undefined on every non-legendary round):
  killShards?: number;     // reaper: seeking shards released when this round KILLS
  accel?: number;          // swarm: px/s² the round gains in flight
  isPhase?: boolean;       // phase: the round ignores walls (and destructible props) entirely
  phaseFireX?: number;     // immutable phase-round origin for wall-line damage pricing
  phaseFireY?: number;
  implode?: number;        // vortex: implosion radius — the payload pulls the pack inward
  // singularity (legendary): the SECOND stage. An imploding round that carries `nova`
  // spawns a short-fused friendly blast at the collapse point once the pull has clumped
  // the pack — the value is that nova blast radius. Sim-internal (never on the wire): the
  // nova itself is an ordinary blast bullet, which the client already renders.
  nova?: number;
  // Render recipe tag (the firing weapon). Selects the layered sprite FX in
  // renderBullets; absent on enemy fire, which keeps its own halo-and-core look.
  fx?: WeaponId;
  // Lag compensation anchored at FIRE time (not collision time). bornTick is the world tick the
  // shot was fired; lagRewind is the shooter's rewind depth (ticks) at that moment. The effective
  // rewind used for a hit test decays as the projectile travels (max(0, lagRewind - age)), so a
  // slow projectile that collides many ticks later is tested against PRESENT positions, while a
  // near-instant hit is tested against the shooter's fire-time view. Undefined/0 in solo.
  bornTick?: number;
  lagRewind?: number;
  // Position before this tick's move (stamped by updateBullets): the swept-collision segment
  // [prev -> current] is what hit tests check, so a fast round (the Longshot's 1400px/s slug
  // crosses ~70px per 20Hz tick) can never tunnel between endpoint samples. Sim-internal
  // scratch — never on the wire. Undefined only before the bullet's first move.
  prevX?: number;
  prevY?: number;
  // PVP-only: player ids this round has already struck (the player twin of hitList, which only
  // holds enemies). Keeps a piercing round from re-hitting the same foe across ticks. Undefined
  // in co-op/solo (never allocated), so the golden path is untouched.
  hitPids?: PlayerId[];
}

// Free world loot only. Anything PRICED lives in Patch's shop room (src/sim/shop.ts)
// behind an explicit buy command — walking over a pickup never spends a coin.
export type PickupKind = "heart" | "coin" | "weapon";

export interface Pickup {
  id: number;      // stable per-floor id (wire identity: interest view + client anim keying)
  kind: PickupKind;
  x: number; y: number;
  radius: number;
  weapon: WeaponId | null; // set when kind === "weapon"
  // Coins: the coin worth baked in at drop time (combo multiplier applied then); undefined
  // falls back to the collector's base coin gain, so non-kill coins stay at face value.
  value?: number;
  // Boss weapon reward (studio gate §4): one of the chest's P+1 personal CHOICES. Each
  // player claims exactly one; a claim never removes a teammate's options, so the pedestal
  // persists until every living player has claimed.
  isBossChoice?: boolean;
  // Mystery pickup: `weapon` holds the ACTUAL identity (baked deterministically at spawn)
  // but it is hidden from every client until the reveal — the wire sends null (see
  // toPickupWire) and the renderer shows the "???" treatment. Collection reveals + grants
  // (rerolled distinct if already owned) and applies the twist. Never a boss choice.
  isMystery?: boolean;
  twist?: MysteryTwist;
}

// Destructible / atmosphere world props. Placed deterministically per floor (seeded Rng)
// so co-op clients agree on layout; destruction resolves via bullets/explosions on the
// shared floor state, exactly like enemies. `breakT` is set the moment a prop is
// destroyed and drives its one-shot break animation before it's removed.
// root_wall / silt_mound / clinker_brick are WORKER CONSTRUCTIONS (the ecology gate's
// persistent topology edits): raised by living workers, destructible by either side,
// replaced when their owner builds anew.
export type PropKind =
  | "crate" | "pot" | "barrel" | "barrel_explosive" | "brazier"
  | "root_wall" | "silt_mound" | "clinker_brick"
  // The GORGE giant's sloughed SHELL DEBRIS: a chunk of the peeled layer that piles at the
  // giant's base as material evidence AND reusable destructible cover (line-of-sight + movement
  // cover, like the marshal's shatter-crates / the Warden's clinker ring). Deterministic + cheap.
  | "gorge_debris"
  // The PALE THRONE giant's sloughed SHELL DEBRIS (F75) — the same cover primitive as gorge_debris,
  // a chunk of the peeled cold-stone shell that piles at the giant's base.
  | "pale_debris";

export interface Prop {
  id: number;      // stable per-world id (client keys its cosmetic anim map by this)
  kind: PropKind;
  x: number; y: number;
  radius: number;
  hp: number;
  dead: boolean;
  breakT?: number; // seconds into the break clip once destroyed (undefined = intact)
  // Worker constructions carry their builder's enemy id (sim-internal, not on the wire):
  // the replacement rule — a worker raising anew crumbles everything it owns first.
  owner?: number;
}

// Authored ground hazards. Shared, authoritative floor state like props: placed by
// enemy/boss moves, expire on a timer, rebuilt empty on every floor load.
//  - web: the Weaver's slow-zone — slows players standing inside (never enemies); it
//    never damages, so the pressure is routing, not attrition.
//  - cinder: the sinderling's burning wake — 1 damage to a standing player, gated by the
//    same protection rules as enemy contact. Enemies are immune (their fire).
//  - charge: a volatile elite's death fuse — harmless while it burns (life > 0), then
//    detonates a SHARED-risk burst (players 1, enemies more) when it expires.
//  - omen: an AMBUSH pre-spawn tell (fair surprise §2) — a harmless marked bloom
//    (burst web / dust / egg-sac swell) that stands for its whole life BEFORE the body
//    it announces exists; the spawn resolves where the omen stood when it expires.
// `corrupt` is JET's per-phase arena-corruption drain zone (the "The Light Goes Out"
// reshape, §5g B3): a persistent cold black-resin patch that creeps in from the edges as
// JET wins and drains a player standing in it. It ALWAYS carries a bright authored edge
// (dead-amber crack-lines / cold-frost rim) so "don't stand here" reads on a dark floor —
// the corruption creep is mood, the bright edge is the fairness cue.
// `slime` is the pet-authored floor patch (Baby Slime SLIMETRAIL): a purely enemy-slowing area
// that deals ZERO damage to anyone. It rides the shared hazard list for its position/life/render
// but has no player-damage branch in updateHazards, so it is inert to every existing hazard path.
// `tar` and `spark` are the PVP WAVE 2 ring-weather ground hazards (Pillar B, pvp-only, behind the
// arena director): `tar` is the tar_bloom slow patch — ambient, ZERO damage, it only drags the
// walk (like a web) for anyone standing in it. `spark` is the spark_mine's telegraph fuse — a
// growing tell ring that detonates ONCE on expiry (a flat capped chip + micro knockback), the
// `charge` pattern retargeted to the pvp funnel. Both are inert off the pvp path (nothing spawns
// them in co-op). The cinder_gust wind is director-state-only (no hazard entity on this list).
export type HazardKind = "web" | "cinder" | "charge" | "omen" | "corrupt" | "slime" | "tar" | "spark";

export interface Hazard {
  id: number;      // stable per-floor id (wire identity + client anim keying)
  kind: HazardKind;
  x: number; y: number;
  radius: number;
  life: number;    // seconds until it fades
  maxLife: number; // authored duration (drives the client's fade render)
  // Omen payload (sim-internal, never on the wire): the ambush body this tell
  // announces, spawned at the omen's spot when its life expires. The spawned add keeps
  // its ordinary spawn grace on top — tell, then body, then teeth.
  spawnKind?: EnemyKind;
  spawnTier?: EnemyTier;
  // The summoning boss's enemy id + 1 (0/undefined = none): a Choir verse omen feeds
  // its fragment into the summoner's silence set when it resolves.
  forBossId?: number;
  // Extra per-body spawn payload the resolve applies (kind-specific). The Quorum splinter
  // rides its parent husk's ROLE here (0 shield / 1 heal / 2 dmg) so the fair-ambush omen
  // can plant the tell before the body exists, then stamp the role when it resolves.
  spawnAux?: number;
  // Per-hazard drift velocity (px/s), sim-internal — the PALE THRONE slag pools CREEP outward (the
  // P2 motion axis). Undefined on every other hazard (static, unchanged); the drifted x/y ride the
  // existing HazardWire x/y, so no new wire field. Set at plant, integrated in updateHazards.
  vx?: number; vy?: number;
}

// Environmental FLOOR hazards — the depth-escalation danger layer, DISTINCT from the
// dynamic boss hazards above: placed deterministically per floor (seeded from
// seed+floor+difficulty, like props) so every client and the server derive the SAME
// layout with zero wire cost — they never ride the snapshot. All floor hazards are
// tile-bound (readable, dodgeable areas). Pulse hazards (spikes/vent/rift) cycle
// idle -> telegraph -> active off the shared floor-hazard clock; pools are static,
// always-visible damage floors. Cycle math lives in src/sim/hazards.ts.
export type FloorHazardKind = "spikes" | "toxic_pool" | "fire_vent" | "void_rift";

export interface FloorHazard {
  id: number;
  kind: FloorHazardKind;
  tx: number; ty: number; // tile coords (damage area = exactly this tile)
  // Pulse phase offset in seconds. Hazards placed as one formation share a group so their
  // offsets step together (rows of spikes fire as a travelling wave, a vent channel erupts
  // in unison) — authored-feeling rhythm instead of random noise.
  phase: number;
  group: number;
}

// Touch-to-open treasure. Placement is seeded (shared layout); `opened` + `openT` are
// local, so each client opens their own chest and gets their own blessing pick, while
// the coins/hearts/weapons it spawns are ordinary first-come world pickups.
export type ChestKind = "wood" | "boss";

export interface Chest {
  id: number;      // stable per-floor id (wire identity: interest view + client anim keying)
  kind: ChestKind;
  x: number; y: number;
  radius: number;
  opened: boolean;
  openT?: number; // seconds into the open clip once opened (undefined = closed)
  // Baked contents: the floor's weapon drops live in chests, never loose on the floor.
  // Opening ejects it as a real pickup. Sim-side only (not on the wire) — contents stay
  // hidden until the open. undefined = the ordinary loot roll only.
  weapon?: WeaponId;
  // Mystery pedestal: the baked weapon ejects as an UNIDENTIFIED pickup (see Pickup).
  isMystery?: boolean;
  twist?: MysteryTwist;
}

export type ParticleKind = "dot" | "gib" | "spark" | "puff" | "shell" | "sparkfx";

export interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  color: string;
  size: number;
  kind: ParticleKind;
  rot: number;     // current rotation (rad) — only spun kinds (gib/shell) render rotated
  vr: number;      // angular velocity (rad/s)
  gravity: number; // downward acceleration (px/s²)
  drag: number;    // per-frame velocity multiplier (0.92 == the classic dot puff)
}

// A floating damage number that rises off an enemy on hit and fades out. Purely a visual
// readout of damage already dealt — never touches balance/logic. Updated/drawn like Particle.
export interface DmgNumber {
  x: number; y: number;
  vy: number;      // upward drift (negative = up); eased toward 0 each frame
  life: number; maxLife: number;
  value: number;   // the (already-rounded) damage shown
  crit: boolean;   // crits render bigger + gold + a "!"
  color: string;
}

// A teammate as the local client sees them (mapped from Convex presence rows).
export interface RemotePlayer {
  playerId: string;
  name: string;
  x: number; y: number;
  facing: number;
  hp: number; maxHp: number;
  weapon: WeaponId;
  isSluiceDrain: boolean;
  floor: number;
  isDown: boolean;
  // Authoritative revive-channel progress on THIS (downed) player, in seconds — drives the
  // reviver-side progress ring. 0 when up / not being revived / on the legacy co-op path.
  reviveProgress: number;
  reviveBy: PlayerId | null;
  // Past the floor's down limit (gate §1): down AND unrevivable until the descent rescue —
  // teammates stop being prompted to revive. Always false on the legacy co-op path.
  isOut: boolean;
  // Network-absent: their connection dropped and the server is holding their body for the
  // reconnect grace window. Rendered as a ghost with an explicit RECONNECTING label.
  isAbsent: boolean;
  // Authoritative dash readout (never predicted): isDashing is ALIGNED with the rendered
  // (interpolated) position, so afterimages/dust/sfx play where and when the blob visibly
  // lunges; the direction and the two invuln windows ride the latest snapshot. The invuln
  // seconds drive the same i-frame flicker the local player renders. All zero/false on the
  // legacy co-op seam (its presence rows carry no dash state).
  isDashing: boolean;
  dashDirX: number;
  dashDirY: number;
  invuln: number;
  dashInvuln: number;
  spawnGraceT: number;
  spawnShieldT: number;
  spawnProtectionStartedTick: number;
  spawnHardGraceEndsAtTick: number;
  spawnShieldEndsAtTick: number;
  authoritativeTick: number;
  aimAngle: number;
  shotSeq: number;    // increments each time they fire, so we can flash a tracer
  // The player's AUTHORITATIVE identity color (verified ticket claim / presence row).
  // null = not resolved yet (claimless legacy/dev ticket) — renderers show an explicit
  // neutral placeholder, NEVER a locally-guessed color that would pop to the real one.
  colorIndex: number | null;
  // Equipped visual-only cosmetics from the verified ticket identity (plain id labels here —
  // the sim never interprets them; the renderer maps ids to overlay art). null = none.
  hat: string | null;
  face: string | null;
  // Equipped cosmetic COMPANION pet id (META spec §3), from the verified ticket identity —
  // same visual-only channel as hat/face. The sim never interprets it; the client renders a
  // follower that cannot die, deal damage, block, or be targeted. null = no pet.
  pet: string | null;
  updatedAt: number;
}

export const TILE = 48;
export type TileKind = 0 | 1 | 2; // 0 = floor, 1 = wall, 2 = walkable lethal void

// Sprite-atlas keys. These are cosmetic (the client's asset loader maps them to images), but
// the enemy archetype table in the pure sim references its own sprite by name, so the union
// lives here in the pure types module rather than in the client's asset loader. That keeps
// src/sim free of any import into src/game (which pulls in DOM types). The client re-exports
// this from assets.ts for its render call sites.
export type SpriteName =
  | "hero"
  // The BALD hero body (canonical body, no baked-in cowboy hat), rendered under any equipped
  // head cosmetic so the worn hat is a separate anchored layer over a fixed body instead of a
  // second hat stacked on the baked one. A pure client render key mapping to a swappable
  // placeholder asset (the AD finalizes the art later); the sim never references it (players
  // ride the wire as "hero").
  | "hero_bald"
  | "slime" | "bat" | "skeleton" | "ghost" | "spitter" | "charger" | "burrower"
  | "orbiter" | "shielder"
  | "rootward" | "echojack" | "seamcutter" | "caskbellows" | "sinderling" | "fragment" | "mason"
  | "echo" | "knell" | "knot" | "sac" | "marshal" | "toll"
  | "boss" | "marrow" | "choir" | "weaver" | "gilded"
  // Wave 1 deep bosses. JET's body is directional ("jet"); the phase bodies are single-frame
  // escalation swaps. The Tithe feeder is directional; its slab is a 2-state destructible
  // (base "tithe_slab" = intact, swapped to "tithe_slab_cracked" as its HP drops). The
  // Quorum husks are directional; the merge-form is the core's single sprite ("quorum").
  | "jet" | "jet_phase2" | "jet_phase3"
  // The guard/expose visuals are the base phase sprite + a REUSABLE overlay composited on
  // top the instant the guard flag flips (a hard swap, no tween). "jet_expose" is ONE
  // crack+desaturate overlay reused across every phase body; "tithe_exposed" is the Tithe's
  // single slumped-exposed body pose (its dome shimmer toggles separately). Both are
  // zero-code art drop points (register the path, ship the PNG) — see assets.ts.
  | "jet_expose"
  | "tithe" | "tithe_slab" | "tithe_slab_cracked" | "tithe_exposed"
  | "quorum" | "quorum_shield" | "quorum_heal" | "quorum_dmg"
  // Wave 1 surplus adds (placeholder art: the tribute reuses the feeder walk, the splinter
  // reuses the dmg-husk walk — the art director ships dedicated sprites later).
  | "tithe_tribute" | "quorum_splinter"
  // JET's mirror-image echo reuses JET's own hero-derived walk sheets (drawn COLD +
  // translucent + hollow-eyed client-side so it never reads as a warm teammate).
  | "jet_echo"
  // GORGE (F50 GIANT): the AD-LOCKED committed art — three single-frame SHELL states the client
  // swaps off boss.phase. "gorge" is the base/idle body (the rind, P1); "gorge_shell_chitin"/
  // "gorge_shell_core" are the P2/P3 escalation swaps (like JET's jet_phase2/3), a 96% shared
  // silhouette peeling open. core is the ONE bright warm amber on an enemy (additive glow, P3
  // only). "gorge_seam" is the tectonic weak-point's small crack-chunk (the molten core material
  // showing through the shell), drawn small + additively lit as a peel target.
  | "gorge" | "gorge_shell_chitin" | "gorge_shell_core" | "gorge_seam"
  // SEVER (F55): placeholder art hooks only (reuse Weaver sheets) — no art generation this batch.
  | "sever" | "sever_anchor"
  // HOLLOW CHOIRMASTER (F60): placeholder art hooks only (reuse Choir sheets) — no art generation.
  | "choirmaster" | "choir_pillar"
  // PALE THRONE (F75 GIANT #2): the AD-LOCKED committed COLD-material art — three single-frame
  // SHELL states swapped off boss.phase, inheriting the gorge peel-reveal shape. "pale" is the
  // base/idle body (pale_shell_stone, P1: frost-pale petrified dark stone, dormant/cold);
  // "pale_shell_cracked"/"pale_shell_core" are the P2/P3 escalation swaps (cold-blue seams glow
  // through → brilliant cold-white/blue crystalline throne-core). The core is a "blazing ABSENCE
  // of warmth" (additive COLD glow, P3 only) — never amber. "pale_seam" is the small cold
  // weak-point crack-chunk, drawn small + additively lit as a peel target.
  | "pale" | "pale_shell_cracked" | "pale_shell_core" | "pale_seam"
  // UNDERTOW (F65): placeholder art hooks only (reuse Weaver/Choir sheets) — no art generation.
  // Signature display THE RIVER COMES BACK; mechanic bodies warm_pulse / relief_vent / flood_front.
  | "undertow" | "warm_pulse" | "relief_vent" | "flood_front"
  // CLAIMANT (F70): placeholder art hooks only (reuse Weaver/Choir sheets) — no art generation.
  // Signature display ALL THINGS OWED; mechanic bodies claim_token / claim_socket.
  | "claimant" | "claim_token" | "claim_socket"
  // THE WAKE (F80): placeholder art hooks only (reuse Weaver/Choir sheets) — no art generation.
  // Signature display THE LAST PROCESSION; mechanic bodies warm_bier / convoy_blocker / shadow_front.
  | "wake" | "warm_bier" | "convoy_blocker" | "shadow_front"
  | "patch"
  // Client-side cosmetic companion pets (META spec §3). A pure render key mapping to a
  // swappable placeholder asset; the sim never references it (pets are OUT of the sim). The
  // slime companion's key is "slime_pet" so it never collides with the "slime" ENEMY sprite.
  // Pack #2 (wick/pebble/clatter/nullfin) are the same purely-cosmetic render keys.
  | "doggie" | "cat" | "dragon" | "slime_pet"
  | "wick" | "pebble" | "clatter" | "nullfin"
  | "heart" | "coin" | "gun" | "spit";
