// What the simulation EMITS each step (data only). The client replays each event into the
// exact existing FX body (particles/sound/trauma/...), so the juice is byte-identical
// — only the trigger path changed. The server (Stage B) ignores most of these.
//
// Design: mostly SEMANTIC events (one per FX cluster). A few generic atoms (flash/puff/
// trauma) mop up residual one-off effects. isNearCamera gating is a CLIENT concern applied
// in the handler; the sim emits unconditionally. Remote-player FX (revive/remote-shot/
// remote-hurt) are presence-driven CLIENT-only and are NOT SimEvents in Stage A.

import type { PlayerId } from "./input.js";
import type { WeaponId, EnemyKind, PickupKind, PropKind, FloorHazardKind } from "./types.js";
import type { ShopSlotKind } from "./shop.js";

export type SimEvent =
  // combat — player
  // chg: the released charge fraction (0..1) on hold-release weapons, 0 on everything
  // else — the client picks the TIER release cue (distinct stems, never pitch tiers).
  | { t: "shot"; pid: PlayerId; weapon: WeaponId; x: number; y: number; aim: number; px: number; py: number; chg: number }
  | { t: "meleeSwing"; pid: PlayerId; weapon: WeaponId; x: number; y: number; aim: number; bx: number; by: number }
  // combat — enemy damage
  | { t: "enemyHit"; eid: number; dmgX: number; dmgY: number; dmg: number; crit: boolean; puffX: number; puffY: number; puffColor: string; melee: boolean; closeShotgun: boolean; killed: boolean }
  | { t: "thornsHit"; eid: number; x: number; y: number; radius: number; dmg: number; tint: string }
  | { t: "burnTick"; x: number; y: number; radius: number; dmg: number }
  | { t: "shockArc"; eid: number; x: number; y: number; tx: number; ty: number; tRadius: number; dmg: number; color: string; killed: boolean }
  | { t: "enemyKill"; eid: number; kind: EnemyKind; tier: string; x: number; y: number; combo: number }
  | { t: "heal"; pid: PlayerId; x: number; y: number }
  // player movement / state
  | { t: "dashStart"; pid: PlayerId; x: number; y: number }
  | { t: "dashTrail"; pid: PlayerId; x: number; y: number }
  | { t: "playerHurt"; pid: PlayerId; x: number; y: number }
  | { t: "itemPicked"; pid: PlayerId; x: number; y: number; tint: string }
  // rare: the boss-chest reward replaces the floor's pick with a Rare-pool offer.
  | { t: "offerBlessing"; pid: PlayerId; rare: boolean }
  // The offer's TTL ran out unanswered: the pick is forfeited, the player's pause/shield
  // lifts, and the party's descend gate releases. The server clears the matching
  // connection/seat offer on this event; the owning client closes its overlay.
  | { t: "blessingExpired"; pid: PlayerId }
  | { t: "revive"; pid: PlayerId; by: PlayerId; x: number; y: number } // downed player brought back by a teammate
  // Friendly-fire "playful bonk": a teammate's DIRECT projectile grazed a friend. Zero
  // damage, zero i-frames — a pure positional impulse the sim applies deterministically
  // (server-authoritative), plus the comedic bonk FX every nearby client replays. dir is
  // the (normalized) bullet vector the nudge pushes along; x,y is the contact point.
  | { t: "friendlyNudge"; shooterId: PlayerId; targetId: PlayerId; x: number; y: number; dirX: number; dirY: number }
  // pickups / loot
  | { t: "pickup"; pid: PlayerId; kind: PickupKind; x: number; y: number }
  | { t: "lootDrop"; x: number; y: number; color: string }
  // A mystery ("???") weapon revealed its identity on pickup/purchase: the collector and
  // everyone nearby see the same reveal moment (name flash + twist flavor). `twist` is
  // the baked blessed/cursed/plain outcome — the state change itself rides the sim.
  | { t: "mysteryReveal"; pid: PlayerId; weapon: WeaponId; twist: string; x: number; y: number }
  // A validated shop purchase landed (Patch's room): positional register-chime juice for
  // everyone browsing the stall. kind selects the buyer-side flavor (heart vs weapon vs
  // blessing vs reroll vs the premium sinks); the authoritative outcome itself rides
  // STATE, never this event.
  | { t: "shopBuy"; pid: PlayerId; slot: number; kind: ShopSlotKind; x: number; y: number }
  // a player deliberately dropped an owned weapon back into the world (Q / inventory UI);
  // clients near the spot play a small pop + a weapon-name label over the new pickup.
  // Positional like lootDrop — no pid, so EVERY nearby client (not just the dropper) sees it
  | { t: "weaponDrop"; weapon: WeaponId; x: number; y: number }
  // weapon effects (the effect wave). All positional: nearby clients replay the juice;
  // the entities themselves ride the snapshot's effect list.
  | { t: "wirePlanted"; x: number; y: number; tx: number; ty: number }
  // The arm delay elapsed: the wire is LIVE (the trap's ready tell).
  | { t: "wireArmed"; x: number; y: number }
  | { t: "wireSnap"; x: number; y: number; tx: number; ty: number }
  // The wire decayed unspent (expire =/= trigger — different sound, different lesson).
  | { t: "wireExpired"; x: number; y: number }
  // A plant was refused (facing a wall): the fail state reads out loud.
  | { t: "wireRefused"; x: number; y: number }
  // The Razor Halo's active expansion (r = the flared ring radius for the shockwave).
  | { t: "haloFlare"; x: number; y: number; r: number }
  | { t: "sentryPlaced"; x: number; y: number }
  // The turret locked a NEW target (per-target, not per-bolt).
  | { t: "sentryAcquire"; x: number; y: number }
  | { t: "sentryShot"; x: number; y: number; aim: number }
  // The turret took damage (enemy contact chew or enemy fire).
  | { t: "sentryHit"; x: number; y: number }
  // why: "destroyed" (chewed to zero) vs "timeout" (deploy duration ran out) — the
  // deployable's two endings sound different by contract.
  | { t: "sentryDown"; x: number; y: number; why: string }
  // eid -1 = the lash whiffed (tx/ty is the scan end the chain snapped back from).
  // inv: the INVERTED pull (a heavy body reels the owner in — the danger cue).
  | { t: "tetherLatch"; eid: number; x: number; y: number; tx: number; ty: number; inv: boolean }
  // The pull resolved into the hold window (the chain snaps taut; sweep is armed).
  | { t: "tetherHold"; x: number; y: number }
  | { t: "tetherSweep"; x: number; y: number; r: number }
  // ---- the shared status library (apply on FIRST application; DoT ticks stay silent) ----
  | { t: "statusApplied"; eid: number; x: number; y: number; kind: string }
  | { t: "frozeSolid"; eid: number; x: number; y: number }
  | { t: "freezeBroke"; eid: number; x: number; y: number }
  // bullets / world
  | { t: "bulletWall"; x: number; y: number; aim: number }
  | { t: "bulletBounce"; x: number; y: number; aim: number; color: string }
  | { t: "bulletExpire"; x: number; y: number; color: string }
  // A guard swallowed a round (aim = the direction the shot came from). `kind` names the
  // blocker so the client can voice the block in the right MATERIAL (shielder wood, a
  // rootward's living root, a bulwark plate) — the bestiary audio contract.
  | { t: "bulletBlocked"; kind: EnemyKind; x: number; y: number; aim: number }
  | { t: "propHit"; propId: number; kind: PropKind; x: number; y: number }
  | { t: "propBreak"; kind: PropKind; x: number; y: number }
  // src: what detonated ("barrel", or the authoring WeaponId) — routes the impact voice.
  | { t: "explosion"; x: number; y: number; r: number; src: string }
  // The Lodestone's implosion: the inward-collapse FX twin of `explosion`.
  | { t: "implosion"; x: number; y: number; r: number }
  | { t: "chestOpen"; kind: string; x: number; y: number }
  // A floor hazard damaged a player (kind selects the client's impact FX flavor).
  | { t: "hazardHit"; pid: PlayerId; kind: FloorHazardKind; x: number; y: number }
  // ---- KIT ULTIMATES (spec §7): the server validates + resolves each ult and emits ONE of
  // these; clients render off the event only (no client-authoritative heal/shield/teleport/
  // invuln). Each carries only integers/fixed-point + the caster id. The Sanctuary zone and
  // Aegis dome themselves are sim entities on the effect list (reconciled from the snapshot);
  // these events are the CAST moment's juice + the deterministic parameters.
  | { t: "ultOverdrive"; pid: PlayerId; x: number; y: number; durationTicks: number }
  | { t: "ultSanctuary"; pid: PlayerId; x: number; y: number; radius: number; lifetimeTicks: number }
  | { t: "ultAegis"; pid: PlayerId; x: number; y: number; radius: number; hpBudget: number; lifetimeTicks: number }
  // PHASE affects the caster + nearby allies; the per-player invuln/speed ride each affected
  // player's own authoritative state (reconciled via SelfWire), so the event carries the AoE
  // (x,y,radius) + the window lengths for the shared cast FX rather than a player-id array.
  | { t: "ultPhase"; pid: PlayerId; x: number; y: number; radius: number; invulnTicks: number; speedTicks: number }
  // enemies / boss
  | { t: "spitMuzzle"; x: number; y: number }
  | { t: "lungeTrail"; x: number; y: number }
  // A rushing enemy (charger / Marrow) slammed into a wall and stunned itself.
  | { t: "chargeCrash"; x: number; y: number }
  // Burrower cycle: the submerge puff, then the marked eruption burst.
  | { t: "burrowDive"; x: number; y: number }
  | { t: "burrowErupt"; x: number; y: number; r: number }
  | { t: "bossSlam"; x: number; y: number }
  | { t: "radialBurst"; x: number; y: number }
  // A boss released an aimed fan/volley from this point (MARROW's bone shards, the
  // Choir's wails).
  | { t: "bossVolley"; x: number; y: number }
  // The Weaver planted a web slow-zone (the hazard itself rides world/snapshot state).
  | { t: "webPlaced"; x: number; y: number; r: number }
  | { t: "bossAddSpawn"; eid: number; x: number; y: number; mx: number; my: number; spawned: boolean }
  | { t: "bossPhase"; eid: number; x: number; y: number }
  // Transition telemetry (§5/§7 gate 2): enter/exit of each 1.2s roar beat with the queued
  // overflow, so the ≥20s anti-burst floor stays observable in logs and tests.
  | { t: "bossTransition"; eid: number; phase: number; entering: boolean; queued: number; hpFrac: number }
  // A reinforcement wave release or an elite split coming active (client plays a spawn puff).
  | { t: "enemySpawn"; eid: number; kind: EnemyKind; tier: string; x: number; y: number }
  // flow / run
  | { t: "descend"; toFloor: number }
  | { t: "reachExit"; toFloor: number } // co-op: client requests a shared-floor descend
  | { t: "gameOver"; pid: PlayerId }
  // PVP (frag-limit deathmatch): a reliable, id-tagged elimination — `by` is the killer
  // (bullet.owner / melee owner; "" = unattributed), `victim` the fragged player. Reliable so a
  // dropped snapshot never loses a kill (the scoreboard rides the match block; this is the juice).
  | { t: "pvpKill"; by: PlayerId; victim: PlayerId; x: number; y: number }
  // PVP lethal-pit elimination. `by` is the recent attacker receiving credit, or "" for a
  // neutral suicide outside the environmental-credit window.
  | { t: "pvpRingOut"; by: PlayerId; victim: PlayerId; x: number; y: number }
  // PVP presentation-only chain-frag event. It grants no stat or power reward.
  | { t: "pvpChainFrag"; by: PlayerId; chain: number; x: number; y: number }
  // A protected player committed their first legal offense. Emitted before its attack event.
  | { t: "pvpShieldBreak"; pid: PlayerId; x: number; y: number }
  // A hard-grace offense input was suppressed. Rate-limited per press for arming feedback.
  | { t: "pvpSpawnAttackBlocked"; pid: PlayerId; x: number; y: number }
  // PVP presentation-only match-point/final-clock crescendo.
  | { t: "pvpSuddenDeath"; leader: PlayerId }
  // PVP: the match resolved — `winner` is the frag leader (id-sorted tiebreak; "" = no winner).
  | { t: "pvpMatchOver"; winner: PlayerId }
  // generic atoms (residual one-off FX)
  | { t: "flash"; eid: number }
  | { t: "puff"; x: number; y: number; n: number; color: string }
  | { t: "trauma"; amount: number }
  // positional near-cam sound cue (+ optional near-cam trauma) for AI telegraph tells
  | { t: "cue"; name: string; x: number; y: number; rate: number; gain: number; trauma: number };
