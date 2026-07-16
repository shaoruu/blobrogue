// The ARSENAL MANIFEST: one canonical QA row per weapon. This is the authored contract
// the arsenal gates (test/arsenal.test.ts) hold every weapon to:
//
//  - role            unique room job (a duplicate role is a MAJOR reject);
//  - idealRange +    the variant fingerprint: together with the weapon's MECHANIC
//    target          signature (behavior flags in weapons.ts) every weapon must be
//                    distinguishable from every other by more than damage/rate/color;
//  - strength /      the authored promise and the authored cost. Both are PROVEN, not
//    weakness        prose: excelRoom must clear under the QA cap, weakRoom must fail
//                    it or degrade hard against the field (a weakness that never
//                    matters in any room is a dominance flag, not a weakness);
//  - resource        the weapon's cost model. The arsenal contract is INFINITE RESERVE:
//                    no global ammo/meter — costs are hold time, placement, position,
//                    or health risk;
//  - status          innate status identity (blessings can add the rest to any weapon);
//  - modifiers       how the universal mods map onto this archetype (and which tooltip
//                    lines are deliberately omitted);
//  - audio / visual  canonical identity hooks (validated against the wave manifest /
//                    legacy sample names and the weapon table's color+art hooks);
//  - authority       which SERVER-OWNED state carries the weapon's output — everything
//                    a client renders is one of these channels, never a client claim.
//
// Pure data (sim-clean). Rooms are authored in the QA harness; ids here name them.

import type { WeaponId } from "./types.js";

export type RoomId = "swarm" | "anchor" | "brawl" | "lane" | "cover" | "kite" | "ambush" | "door" | "secondlane";
// A declared performance metric (balancer envelope): the room clear times plus the
// cross-room aggregates. Each weapon declares 1-2 metrics it beats the arsenal median
// on by >=15% (proven in test/arsenal.test.ts) — its authored, measurable identity.
export type MetricId = RoomId | "safety" | "control" | "boss";
export type RangeBand = "point-blank" | "close" | "mid" | "long" | "self" | "placed";
export type TargetProfile = "swarm" | "single" | "pack" | "lane" | "anchor" | "control" | "mixed";
// "coin-fed" (the Midas): the run economy amplifies the shot — never gates it. The
// INFINITE RESERVE contract holds: a broke trigger still fires an honest base round, so
// the cost model is a power tradeoff against the shop/hearts/rerolls, not ammo.
export type ResourceModel = "none" | "hold" | "placement" | "position" | "health-risk" | "coin-fed";
export type StatusIdentity = "none" | "burn" | "chill";
// The server-owned state channels a weapon's output may ride. Closed set: the QA gate
// rejects an authority claim that names state the sim does not actually own.
export type AuthorityChannel =
  | "bullets" | "meleeSwing" | "chargeT"
  | "effects:zone" | "effects:wire" | "effects:orbit" | "effects:sentry" | "effects:tether";

// The creative-gate audit axes: an addition must change at least one of these play
// dimensions vs its nearest roster neighbor — straight bullet/color/status reskins
// (numbers-only variants) are rejected at the gate.
export type NoveltyAxis = "positioning" | "geometry" | "priority" | "timing";

export interface WeaponNovelty {
  nearest: WeaponId | null; // the closest existing roster slot (null = the baseline itself)
  axes: readonly NoveltyAxis[];
  note: string;
}

export interface WeaponManifestEntry {
  role: string;
  // The 1-2 declared metrics this weapon beats the arsenal median on by >=15%.
  metrics: readonly MetricId[];
  // The creative audit (REQUIRED on every post-cluster addition): what this weapon
  // changes about play vs its nearest neighbor. The named legacy overlap clusters
  // (Rapid/Hornet, Shotgun/Boomstick, Rebound/Nailer, precision slugs, seekers,
  // status cones) are differentiated by range-band/target fingerprints; new slots
  // must move a whole dimension.
  novelty?: WeaponNovelty;
  idealRange: RangeBand;
  target: TargetProfile;
  strength: string;
  weakness: string;
  resource: ResourceModel;
  status: StatusIdentity;
  modifiers: string;
  audio: string;   // canonical trigger sound id (WaveEventId or legacy SfxName)
  visual: string;  // canonical color/art/fx identity note
  authority: readonly AuthorityChannel[];
  excelRoom: RoomId;
  weakRoom: RoomId;
}

export const ARSENAL: Record<WeaponId, WeaponManifestEntry> = {
  pistol: {
    role: "baseline sidearm: the honest mid-range answer you always own",
    metrics: ["anchor", "lane"],
    idealRange: "mid", target: "mixed",
    strength: "No-conditions reliability at any band.",
    weakness: "Never the best tool for any specific room shape.",
    resource: "none", status: "none",
    modifiers: "Full standard mapping (damage/rate/size/speed/life/pellets/pierce/crit/status).",
    audio: "shootPistol",
    visual: "#ffd27a amber tracer rounds; held_pistol/weapon_pistol",
    authority: ["bullets"],
    excelRoom: "anchor", weakRoom: "brawl",
  },
  shotgun: {
    role: "close cone burst: punish what walks into the fan",
    metrics: ["brawl", "swarm"],
    idealRange: "close", target: "pack",
    strength: "Full five-pellet fan deletes a close pack.",
    weakness: "Pellet spread starves it at range.",
    resource: "none", status: "none",
    modifiers: "Pellets/spread mods widen the fan; standard mapping otherwise.",
    audio: "shootShotgun",
    visual: "#ffb43b wide muzzle bloom + barrel smoke; held_shotgun",
    authority: ["bullets"],
    excelRoom: "brawl", weakRoom: "anchor",
  },
  rapid: {
    role: "light stream: hose down soft crowds",
    metrics: ["lane", "door"],
    idealRange: "close", target: "swarm",
    strength: "Constant uptime shreds low-HP bodies.",
    weakness: "Feeble single hits stall on tough bodies.",
    resource: "none", status: "none",
    modifiers: "Full standard mapping; fire-rate mods compound its identity.",
    audio: "shootRapid",
    visual: "#8affe0 mint micro-tracers; held_rapid",
    authority: ["bullets"],
    excelRoom: "swarm", weakRoom: "anchor",
  },
  smg: {
    role: "tight suppression stream: hold one lane of fire on one body",
    metrics: ["anchor", "door"],
    idealRange: "mid", target: "single",
    strength: "Near-zero spread keeps every round on the mark.",
    weakness: "One lane only — packs flank it.",
    resource: "none", status: "none",
    modifiers: "Full standard mapping.",
    audio: "smg",
    visual: "#b6ff6a acid tracer line; held_smg",
    authority: ["bullets"],
    excelRoom: "anchor", weakRoom: "brawl",
  },
  cannon: {
    role: "heavy line breaker: one slug through the column",
    metrics: ["lane", "cover"],
    idealRange: "mid", target: "lane",
    strength: "Intrinsic 2-pierce + massive knockback breaks formations.",
    weakness: "The 0.72s cycle gets swarmed at handshake range.",
    resource: "none", status: "none",
    modifiers: "Pierce stacks on the intrinsic 2; standard mapping otherwise.",
    audio: "cannon",
    visual: "#ff8a3b heavy slug + smoke; held_cannon",
    authority: ["bullets"],
    excelRoom: "lane", weakRoom: "brawl",
  },
  burst: {
    role: "precision fan volley: three answers per trigger at mid range",
    metrics: ["swarm", "brawl"],
    idealRange: "mid", target: "pack",
    strength: "Simultaneous 3-pellet volley fronts well against spread packs.",
    weakness: "Fan gaps miss at long range; volley cadence stalls point-blank crowds.",
    resource: "none", status: "none",
    modifiers: "Pellet mods widen the fan; standard mapping otherwise.",
    audio: "burst",
    visual: "#6ad0ff triple azure tracers; held_burst",
    authority: ["bullets"],
    excelRoom: "swarm", weakRoom: "cover",
  },
  ricochet: {
    role: "wall banker: shoot the corner, not the body",
    // Recalibrated with the legendary wave aboard: the 30-weapon lane median tightened
    // past the bank's lane time; its single-lane edge now reads on the anchor metric.
    metrics: ["anchor"],
    idealRange: "mid", target: "pack",
    strength: "Two wall banks reach around geometry and double-dip rooms.",
    weakness: "Open ground wastes the banks entirely.",
    resource: "none", status: "none",
    modifiers: "Life mods extend bank travel; standard mapping otherwise.",
    audio: "ricochet",
    visual: "#c98bff violet banking rounds; held_ricochet",
    authority: ["bullets"],
    excelRoom: "brawl", weakRoom: "anchor",
  },
  homing: {
    role: "seeker: guaranteed contact on scattered movers",
    metrics: ["kite"],
    idealRange: "mid", target: "swarm",
    strength: "Rounds steer themselves onto erratic bodies.",
    weakness: "Weak individual hits; overkill-prone on packs.",
    resource: "none", status: "none",
    modifiers: "Speed mods trade tracking agility for travel; standard mapping otherwise.",
    audio: "homing",
    visual: "#8affe0 drifting wisp rounds; held_homing",
    authority: ["bullets"],
    excelRoom: "kite", weakRoom: "anchor",
  },
  tesla: {
    role: "pack arcer: hit one, tax three more",
    metrics: ["swarm", "ambush"],
    idealRange: "mid", target: "pack",
    strength: "Chain lightning multiplies every hit across a bunched pack.",
    weakness: "Chains starve against a lone body.",
    resource: "none", status: "none",
    modifiers: "Chain count/range are authored (never modded); standard mapping otherwise.",
    audio: "tesla",
    visual: "#7fe9ff arc chains between bodies; held_tesla",
    authority: ["bullets"],
    excelRoom: "swarm", weakRoom: "anchor",
  },
  sawnoff: {
    role: "point-blank devastator: a wall of lead at handshake distance",
    metrics: ["brawl"],
    idealRange: "point-blank", target: "pack",
    strength: "Eight pellets in one roar — nothing survives the handshake.",
    weakness: "Pellets die 0.22s out; anything past arm's reach is safe.",
    resource: "position", status: "none",
    modifiers: "Pellet mods thicken the wall; life mods barely stretch its reach.",
    audio: "shootShotgun",
    visual: "#ff7a3b massive muzzle roar + hard self-knockback; held_sawnoff",
    authority: ["bullets"],
    excelRoom: "brawl", weakRoom: "anchor",
  },
  railgun: {
    role: "long-range executioner: one perfect shot, slowly",
    metrics: ["anchor", "boss"],
    idealRange: "long", target: "single",
    strength: "Near-hitscan slug lands the biggest single hit in the arsenal.",
    weakness: "0.85s cycle is an eternity inside a swarm.",
    resource: "none", status: "none",
    modifiers: "Pierce mods turn it into a lane tool; standard mapping otherwise.",
    audio: "cannon",
    visual: "#e8f0ff white-hot rail streak; held_railgun",
    authority: ["bullets"],
    excelRoom: "anchor", weakRoom: "swarm",
  },
  nailer: {
    role: "ricochet stream: full-auto that works the walls",
    metrics: ["door", "lane"],
    idealRange: "close", target: "swarm",
    strength: "Fast nails with a wall bank keep corridors saturated.",
    weakness: "Tiny rounds barely dent armor-grade HP.",
    resource: "none", status: "none",
    modifiers: "Standard mapping; the single bank is authored.",
    audio: "shootRapid",
    visual: "#d9d2c0 bone-white nails; held_nailer",
    authority: ["bullets"],
    excelRoom: "swarm", weakRoom: "anchor",
  },
  flamer: {
    role: "burn hose: paint bodies, let the fire do the work",
    metrics: ["brawl", "swarm"],
    idealRange: "close", target: "pack",
    strength: "Every puff stamps burn — the DoT clears what the cone touches.",
    weakness: "Tiny direct hits and short reach demand dangerous proximity.",
    resource: "position", status: "burn",
    modifiers: "Life mods stretch the cone; burn is innate (blessings add the rest).",
    audio: "shootRapid",
    visual: "#ff8a3b rolling flame puffs + embers; held_flamer",
    authority: ["bullets"],
    excelRoom: "brawl", weakRoom: "anchor",
  },
  mortar: {
    role: "area converter: turn a pack into a blast zone",
    metrics: ["door", "safety"],
    idealRange: "mid", target: "pack",
    strength: "One shell converts a bunched pack (and chains barrels).",
    weakness: "No direct hit at all — one tough lone body outlasts the shelling.",
    resource: "none", status: "none",
    modifiers: "Life mods stretch the arc; blast radius is authored.",
    audio: "shootMortar",
    visual: "#ffc46a lobbed shell + explosion ring; held_thumper",
    authority: ["bullets"],
    excelRoom: "swarm", weakRoom: "anchor",
  },
  beam: {
    role: "tracking lance: hold the line on one body and melt it",
    metrics: ["anchor", "lane"],
    idealRange: "mid", target: "single",
    strength: "Zero travel time and 100% uptime — nothing dodges a held lance.",
    weakness: "One lane, one body deep — a surround eats the wielder.",
    resource: "none", status: "none",
    modifiers: "Life mods extend the lance; pierce past the intrinsic 1 via blessings.",
    audio: "beamLoop",
    visual: "#ffe6a0 continuous amber ray (fx/beam_ray); held_beam2_px",
    authority: ["bullets"],
    excelRoom: "anchor", weakRoom: "brawl",
  },
  sword: {
    role: "quick blade: fast sweeps that also break the furniture",
    metrics: ["kite"],
    idealRange: "close", target: "swarm",
    strength: "Fast cadence arcs with heavy knockback own small crowds.",
    weakness: "48px reach: anything that stands off is untouchable.",
    resource: "position", status: "none",
    modifiers: "Damage/rate/crit/status map; range/pellet lines omitted (no projectile).",
    audio: "meleeSwing",
    visual: "#c8e0ff cutlass arc + slash wind; held_cutlass",
    authority: ["meleeSwing"],
    excelRoom: "brawl", weakRoom: "anchor",
  },
  longsword: {
    role: "heavy crowd sweep: one slow arc through the whole front",
    metrics: ["brawl", "safety"],
    idealRange: "close", target: "pack",
    strength: "106-degree heavy arc staggers everything in front at once.",
    weakness: "Slow swings leave gaps fast enemies slip through.",
    resource: "position", status: "none",
    modifiers: "Damage/rate/crit/status map; range/pellet lines omitted (no projectile).",
    audio: "heavySwing",
    visual: "#d8dce8 claymore arc, biggest slash wind; held_claymore",
    authority: ["meleeSwing"],
    excelRoom: "brawl", weakRoom: "anchor",
  },
  spear: {
    role: "reach thruster: fence from outside their arms",
    metrics: ["brawl", "safety"],
    idealRange: "close", target: "lane",
    strength: "74px thrust line hits through a file of bodies from relative safety.",
    weakness: "74px of reach is still not range — a parked shooter never gets fenced.",
    resource: "position", status: "none",
    modifiers: "Damage/rate/crit/status map; range/pellet lines omitted (no projectile).",
    audio: "meleeSwing",
    visual: "#9ee8c8 pike thrust + lunge knockback; held_pike",
    authority: ["meleeSwing"],
    excelRoom: "brawl", weakRoom: "anchor",
  },
  // ---- the effect wave ----
  lastlight: {
    role: "risk hand cannon: trade your health bar for the kill payoff",
    metrics: ["anchor"],
    novelty: {
      nearest: "railgun",
      axes: ["timing", "positioning"],
      note: "The commit rhythm follows the player's OWN health state, not a cooldown: positioning becomes risk management, and the kill payoff opens exactly when standing still is most dangerous.",
    },
    idealRange: "mid", target: "single",
    strength: "At one heart it out-hits everything in its class.",
    weakness: "A mediocre slug at full health — and staying hurt inside a converging crowd is how you die.",
    resource: "health-risk", status: "none",
    modifiers: "Standard mapping; the missing-HP curve is authored (stated in special copy, never a stat line).",
    audio: "shootLastlight",
    visual: "#ff6a5a ember slug, heavier as HP drops; held_lastlight (hook)",
    authority: ["bullets"],
    excelRoom: "anchor", weakRoom: "swarm",
  },
  breach: {
    role: "charged artillery: erase the anchor propping the room up",
    metrics: ["cover", "door"],
    novelty: {
      nearest: "mortar",
      axes: ["geometry", "positioning"],
      note: "The Thumper is a contact-fused lob; the Breach is charged ARTILLERY — the player authors the landing point, shells sail over bodies AND cover, and a full charge walks a line of blasts along the approach instead of a point.",
    },
    idealRange: "long", target: "anchor",
    strength: "Charged shells sail OVER the pack and cover onto the back line.",
    weakness: "Charging slows you and nothing fires until you release.",
    resource: "hold", status: "none",
    modifiers: "Life maps to landing span, speed to flight time; blast is authored; RATE line omitted (hold-release).",
    audio: "shootBreach",
    visual: "#ffb06a charge ring + dashed landing marker + lobbed shell; held_breach (hook)",
    authority: ["bullets", "chargeT"],
    excelRoom: "cover", weakRoom: "kite",
  },
  snapwire: {
    role: "doorway trap: arm the chokepoint before the fight arrives",
    metrics: ["kite"],
    novelty: {
      nearest: "mortar",
      axes: ["geometry", "timing"],
      note: "Damage placed BEFORE the fight crosses it: a line, not a radius, paid for with an arm delay — the first pre-commitment weapon in the roster.",
    },
    idealRange: "placed", target: "control",
    strength: "A snapped wire hits everything in the band at once — for free, later.",
    weakness: "Zero direct damage; a target that never crosses is never hit.",
    resource: "placement", status: "none",
    modifiers: "Size maps to band width, speed to arm time, life to duration, pellets to max wires; RATE/RANGE lines omitted.",
    audio: "wirePlant",
    visual: "#e8e05a taut blinking wire between posts (fx/wire_post hook)",
    authority: ["effects:wire"],
    excelRoom: "ambush", weakRoom: "anchor",
  },
  frostline: {
    role: "lane painter: cut the room in two with cold ground",
    metrics: ["control"],
    novelty: {
      nearest: "flamer",
      axes: ["geometry", "priority"],
      note: "The Dragon's cone is transient damage-with-status; the Frostline paints PERSISTENT ground that re-shapes enemy approach lanes — target priority inverts (paint where they WILL be, not where they are).",
    },
    idealRange: "mid", target: "control",
    strength: "The painted lane slows and freezes everything that crosses it.",
    weakness: "Feeble direct damage — the floor is the whole payload.",
    resource: "none", status: "chill",
    modifiers: "Size maps to zone footprint, life to trail duration; TRAIL line added, innate chill authored.",
    audio: "shootFrostline",
    visual: "#9fd8ff frost beads painting glowing ground discs (fx/frost_zone hook)",
    authority: ["bullets", "effects:zone"],
    excelRoom: "ambush", weakRoom: "anchor",
  },
  halo: {
    role: "personal-space enforcer: blades for everything that presses in",
    metrics: ["brawl", "swarm"],
    novelty: {
      nearest: "sword",
      axes: ["positioning"],
      note: "Melee with the aim inverted: the weapon is worn, not swung — the player's BODY is the cursor, and every movement decision is simultaneously an attack decision.",
    },
    idealRange: "self", target: "pack",
    strength: "Automatic contact damage all around you, hands-free; the flare bites outward.",
    weakness: "Zero reach — you must stand where it hurts.",
    resource: "position", status: "none",
    modifiers: "Pellets map to blades (cap 6), speed to orbit speed, size to blade size; RANGE line omitted.",
    audio: "haloFlare",
    visual: "#d8f0e8 orbiting blade ring + flare shockwave (fx/halo_blade hook)",
    authority: ["effects:orbit"],
    excelRoom: "brawl", weakRoom: "anchor",
  },
  sentry: {
    role: "second-lane holder: a turret watches the door you can't",
    metrics: ["secondlane"],
    novelty: {
      nearest: "homing",
      axes: ["positioning", "priority"],
      note: "The Wisp forgives aim on one lane; the turret is a SECOND POSITION on the map with its own target priority — the player splits the room instead of tracking it.",
    },
    idealRange: "placed", target: "lane",
    strength: "Autonomous owner-credited fire on a lane you are not looking at.",
    weakness: "Parked DPS: alone it is the slowest killer in the arsenal, and it can be chewed down.",
    resource: "placement", status: "none",
    modifiers: "Speed/size map to bolts, life to deploy duration, pierce to bolt pierce; RATE line omitted (redeploy cadence).",
    audio: "sentryPlace",
    visual: "#c8a8ff crystal turret with HP pips + bolt tracers (fx/sentry_core hook)",
    authority: ["effects:sentry", "bullets"],
    excelRoom: "secondlane", weakRoom: "anchor",
  },
  crook: {
    role: "threat repositioner: the fight happens where YOU decide",
    metrics: ["swarm", "ambush"],
    novelty: {
      nearest: "spear",
      axes: ["priority", "positioning"],
      note: "Every other weapon kills where enemies stand; the chain EDITS THE FORMATION first — pick the body that matters, move it (or be moved by it), then resolve.",
    },
    idealRange: "close", target: "single",
    strength: "Reels the dangerous body out of its formation and into your sweep.",
    weakness: "Brutes, elites and bosses reel YOU in instead — the tool bites back.",
    resource: "position", status: "none",
    modifiers: "Speed maps to pull, size to sweep reach, life to the hold duration; RATE line omitted (latch/sweep pair).",
    audio: "tetherLatch",
    visual: "#c9b06a sagging chain links to the latched body (fx/chain_link hook)",
    authority: ["effects:tether"],
    excelRoom: "brawl", weakRoom: "lane",
  },
  // ---- the legendary wave: one signature mechanic each, priced by a real tradeoff ----
  reaper: {
    role: "momentum harvester: the first kill starts the avalanche",
    metrics: ["kite"],
    novelty: {
      nearest: "tesla",
      axes: ["priority", "timing"],
      note: "The Tesla taxes every HIT across a pack; the Reaper pays out on KILLS — target priority inverts (finish the weakest body first to seed the cascade), and the payoff compounds over the fight instead of per trigger pull.",
    },
    idealRange: "mid", target: "pack",
    strength: "Kill shards seek and cascade — one finished body dominoes a bunched room.",
    weakness: "No kills, no shards: a lone tough body faces a modest mid-tempo rifle.",
    resource: "none", status: "none",
    modifiers: "Standard mapping; shard count/decay are authored (never modded).",
    audio: "cannon",
    visual: "#b8ffd9 pale soul tracers, shard fans off corpses; held_reaper/weapon_reaper",
    authority: ["bullets"],
    excelRoom: "kite", weakRoom: "anchor",
  },
  swarm: {
    role: "alpha strike: one slow commitment releases five hunters",
    metrics: ["anchor"],
    novelty: {
      nearest: "homing",
      axes: ["timing", "geometry"],
      note: "The Wisp is a steady seeker stream; the Hive is a 1.15s VOLLEY commitment whose darts launch lazy and accelerate — the decision moves from tracking to timing the release beat, and the volley fans a whole arc instead of one lane.",
    },
    idealRange: "long", target: "swarm",
    strength: "Five accelerating seekers arrive together — a committed volley that runs down distant bodies.",
    weakness: "Darts launch slow and the cycle is a real beat — point-blank panic fire gets you killed.",
    resource: "none", status: "none",
    modifiers: "Pellet mods add darts; speed maps to launch velocity (acceleration is authored).",
    audio: "homing",
    visual: "#ffe86a wasp-gold darts that visibly pick up speed; held_hive/weapon_hive",
    authority: ["bullets"],
    excelRoom: "kite", weakRoom: "brawl",
  },
  midas: {
    role: "coin-fed cannon: your purse is the magazine",
    metrics: ["anchor"],
    novelty: {
      nearest: "smg",
      axes: ["priority"],
      note: "Mechanically a suppression stream, economically a NEW resource loop: every fed shot bids the run economy (shop, hearts, rerolls compete for the same coins), so the priority decision lives outside the room entirely.",
    },
    idealRange: "mid", target: "single",
    strength: "Fed, it is a premium suppression stream that melts a marked body.",
    weakness: "Broke, it fires the weakest round in the arsenal — the purse IS the power.",
    resource: "coin-fed", status: "none",
    modifiers: "Full standard mapping; the coin feed multiplies the damage line only.",
    audio: "shootPistol",
    visual: "#ffd700 gilded tracers that gleam brighter when fed; held_midas/weapon_midas",
    authority: ["bullets"],
    excelRoom: "anchor", weakRoom: "swarm",
  },
  phase: {
    role: "cover denier: the room's geometry belongs to nobody",
    metrics: ["anchor"],
    novelty: {
      nearest: "railgun",
      axes: ["geometry", "positioning"],
      note: "The Longshot deletes what it can SEE; the Umbra ignores sight lines entirely — walls and crates stop being cover for either side, so the play is standing where the room thinks you cannot shoot from.",
    },
    idealRange: "long", target: "control",
    strength: "Rounds pass through walls and props — pre-thin the pack from total safety.",
    weakness: "Slow cadence, zero pierce, mid damage: in the open it is strictly a lesser slug.",
    resource: "position", status: "none",
    modifiers: "Full standard mapping; pierce mods still apply (bodies, never geometry).",
    audio: "tesla",
    visual: "#9a7fff umbral bolts that dim through geometry; held_umbra/weapon_umbra",
    authority: ["bullets"],
    excelRoom: "door", weakRoom: "brawl",
  },
  vortex: {
    role: "pack gatherer: yank the room into one clump",
    metrics: ["swarm"],
    novelty: {
      nearest: "mortar",
      axes: ["positioning", "geometry"],
      note: "The Thumper converts a clump into damage; the Lodestone CREATES the clump — the implosion pulls scattered bodies onto the impact point, so its output is formation editing for your follow-up, not the kill itself.",
    },
    idealRange: "mid", target: "pack",
    strength: "Every shot drags the nearby pack onto one point and splashes it.",
    weakness: "Modest splash and a heavy body barely budges — alone against an anchor it stalls.",
    resource: "none", status: "none",
    modifiers: "Size maps to the round, life to travel; the implosion radius is authored.",
    audio: "cannon",
    visual: "#7fb0ff cold-blue rounds collapsing inward on impact; held_lodestone/weapon_lodestone",
    authority: ["bullets"],
    excelRoom: "swarm", weakRoom: "anchor",
  },
  // ---- the content wave ----
  cleaver: {
    role: "line shredder: one slow disc through a whole file of bodies",
    metrics: ["lane"],
    novelty: {
      nearest: "cannon",
      axes: ["geometry", "timing"],
      note: "The Thunderbolt is a fast slug that stops at two bodies; the Cleaver is a slow, wide disc that punches the WHOLE column — the play is lining bodies up and eating a slow cadence for a total line clear.",
    },
    idealRange: "close", target: "pack",
    strength: "Deep pierce cuts an entire lined-up file in one slow disc.",
    weakness: "A slow, low-per-hit disc barely dents one lone tough body.",
    resource: "none", status: "none",
    modifiers: "Pierce stacks on the intrinsic 5; standard mapping otherwise.",
    audio: "cannon",
    visual: "#cfe8ff pale spinning saw disc; held_cleaver",
    authority: ["bullets"],
    excelRoom: "lane", weakRoom: "anchor",
  },
  scrapper: {
    role: "spray hose: a wide twin-pellet stream over a soft crowd",
    metrics: ["brawl"],
    novelty: {
      nearest: "smg",
      axes: ["geometry"],
      note: "The Hornet holds one tight lane; the Scrapper fronts a WIDE twin-pellet spread — the play flips from tracking one body to washing a whole arc of soft movers.",
    },
    idealRange: "mid", target: "swarm",
    strength: "Two pellets a shot at a fast cadence wash a soft crowd off the floor.",
    weakness: "Feeble spread pellets stall on a single tough body.",
    resource: "none", status: "none",
    modifiers: "Pellet/spread mods widen the wash; standard mapping otherwise.",
    audio: "shootRapid",
    visual: "#b6d36a twin acid-green tracers; held_scrapper",
    authority: ["bullets"],
    excelRoom: "swarm", weakRoom: "anchor",
  },
  skipper: {
    role: "corner scatter: buckshot that banks a room from the doorway",
    metrics: ["brawl"],
    novelty: {
      nearest: "sawnoff",
      axes: ["geometry", "positioning"],
      note: "The Boomstick is a point-blank wall of lead; the Skipper's fan BANKS off walls — the play is shooting the corner from cover so the ricochet fills the room you cannot see into.",
    },
    idealRange: "close", target: "pack",
    strength: "A bouncing fan wraps corners and chokepoints from safety.",
    weakness: "Open ground wastes the banks, and the spread starves at range.",
    resource: "none", status: "none",
    modifiers: "Pellet mods thicken the fan; the single bank is authored.",
    audio: "shootShotgun",
    visual: "#ffd08a warm banking buckshot; held_skipper",
    authority: ["bullets"],
    excelRoom: "brawl", weakRoom: "anchor",
  },
  arcbolt: {
    role: "pack taxer: shock a bunched crowd with amp + arc",
    metrics: ["brawl"],
    novelty: {
      nearest: "tesla",
      axes: ["priority", "timing"],
      note: "The Tesla's chain jumps unconditionally on every hit; the Arcbolt stamps SHOCK — an amp that compounds the follow-up plus a single arc — so the play is softening a pack and cashing the amped second hits, not one instant chain.",
    },
    idealRange: "close", target: "pack",
    strength: "Shock amps every follow-up and arcs to a neighbour in a bunched pack.",
    weakness: "Short range — a lone body parked at distance is untouchable.",
    resource: "none", status: "none",
    modifiers: "Full standard mapping; the shock stamp is innate (blessings add the rest).",
    audio: "tesla",
    visual: "#7fe9ff crackling azure bolt; held_arcbolt",
    authority: ["bullets"],
    excelRoom: "brawl", weakRoom: "anchor",
  },
  cryobolt: {
    role: "on-demand freezer: chill the body, not the floor",
    metrics: ["control"],
    novelty: {
      nearest: "frostline",
      axes: ["priority", "timing"],
      note: "The Frostline paints PERSISTENT ground you route enemies across; the Cryobolt chills the BODY it hits on demand — the play is picking who freezes right now instead of shaping where they'll walk.",
    },
    idealRange: "mid", target: "control",
    strength: "Sustained fire locks a body down and freezes it solid.",
    weakness: "Feeble single-lane damage — a converging crowd overruns it before it freezes them.",
    resource: "none", status: "chill",
    modifiers: "Standard mapping; innate chill authored (blessings add the rest).",
    audio: "shootRapid",
    visual: "#9fd8ff pale-blue frost shards; held_cryobolt",
    authority: ["bullets"],
    excelRoom: "anchor", weakRoom: "swarm",
  },
  firebomb: {
    role: "burning chokepoint: a shell that lands, bursts, and leaves fire",
    metrics: ["door"],
    novelty: {
      nearest: "mortar",
      axes: ["timing", "priority"],
      note: "The Thumper is a clean one-shot AoE; the Firebomb trades raw blast for a lingering BURN across everything it catches — the play is committing area denial that keeps working after the flash.",
    },
    idealRange: "mid", target: "pack",
    strength: "One shell converts a chokepoint into a burning blast zone.",
    weakness: "A short-armed lob can't reach a lone body parked at distance.",
    resource: "none", status: "burn",
    modifiers: "Life stretches the arc; blast/burn are authored (blessings stack more).",
    audio: "cannon",
    visual: "#ff7a3b lobbed shell + rolling flame burst; held_firebomb",
    authority: ["bullets"],
    excelRoom: "door", weakRoom: "anchor",
  },
  tracker: {
    role: "single hunter: one heavy seeker for the body that keeps slipping",
    metrics: ["kite"],
    novelty: {
      nearest: "homing",
      axes: ["priority"],
      note: "The Wisp sprays a stream of soft seekers; the Tracker commits ONE heavy hunter per cycle — the play is a hard single-target lock on a runner, not chip across a crowd.",
    },
    idealRange: "long", target: "single",
    strength: "A heavy round that steers itself onto the runner and never misses.",
    weakness: "One slow round at a time is swarmed at point-blank range.",
    resource: "none", status: "none",
    modifiers: "Speed trades tracking for travel; standard mapping otherwise.",
    audio: "homing",
    visual: "#8affe0 heavy mint seeker; held_tracker",
    authority: ["bullets"],
    excelRoom: "kite", weakRoom: "brawl",
  },
  // ---- legendary ----
  singularity: {
    role: "collapse and detonate: gather the pack, then nova the clump",
    metrics: ["door"],
    novelty: {
      nearest: "vortex",
      axes: ["timing", "geometry"],
      note: "The Lodestone only GATHERS — its output is setup for a follow-up; the Singularity gathers AND finishes: a beat after the implosion a nova bursts on the clump, so one shot both editing formation and cashing it in.",
    },
    idealRange: "long", target: "pack",
    strength: "Yanks the scattered pack onto one point, then a nova finishes the clump.",
    weakness: "A slow cycle and modest per-body damage — a lone anchor barely budges.",
    resource: "none", status: "none",
    modifiers: "Size maps to the round, life to travel; implosion + nova radii are authored.",
    audio: "cannon",
    visual: "#c58bff violet round collapsing inward, then a bursting nova; held_singularity",
    authority: ["bullets"],
    excelRoom: "swarm", weakRoom: "anchor",
  },
  mooring_nail: {
    role: "wall grappler: nail the room and pull yourself onto a new line",
    metrics: ["safety"],
    novelty: {
      nearest: "crook",
      axes: ["positioning", "geometry"],
      note: "The Crooked Chain moves a body relative to the player; the Mooring Nail bites room geometry and moves the player to the anchor.",
    },
    idealRange: "long", target: "lane",
    strength: "A wall hit crosses danger and opens a firing angle while the deep-piercing nail clears its path.",
    weakness: "Open ground offers no anchor, and the modest nail stalls on a lone heavy body.",
    resource: "position", status: "none",
    modifiers: "Life and speed extend anchor reach; damage, pierce, crit, and status map to the nail.",
    audio: "shootMooringNail",
    visual: "#d6c7a1 pale iron nail and taut anchor trail; held_mooring_nail hook",
    authority: ["bullets"],
    excelRoom: "cover", weakRoom: "anchor",
  },
  sluicegate: {
    role: "alternating gate: flood the near pack, then drain the long lane",
    metrics: ["brawl", "lane"],
    novelty: {
      nearest: "burst",
      axes: ["timing", "geometry"],
      note: "Its geometry changes every committed shot: a short wide fan and a long piercing lance form a fixed two-beat sequence.",
    },
    idealRange: "mid", target: "mixed",
    strength: "The fixed two-beat sequence answers a crowd and its back-line anchor without changing weapons.",
    weakness: "The wrong half of the cycle is deliberately poor for the current room shape.",
    resource: "none", status: "none",
    modifiers: "Damage, rate, size, pellets, pierce, crit, and status apply independently to both modes.",
    audio: "shootSluicegate",
    visual: "#78cbd1 wide flood fan alternating with a narrow drain lance; held_sluicegate hook",
    authority: ["bullets"],
    excelRoom: "lane", weakRoom: "kite",
  },
  oddsmaker: {
    role: "payload gambler: commit before knowing how the room will bend",
    metrics: ["swarm"],
    novelty: {
      nearest: "midas",
      axes: ["timing", "priority", "geometry"],
      note: "Midas prices a known shot with coins; Oddsmaker deterministically rolls one of four spatial payloads per owner and shot.",
    },
    idealRange: "mid", target: "mixed",
    strength: "Every outcome edits the room differently: bank, seek, blast, or pierce.",
    weakness: "No outcome can be demanded twice; a poor roll against the current shape costs the full cycle.",
    resource: "none", status: "none",
    modifiers: "Standard shot modifiers apply; the four equally weighted payload verbs remain authored.",
    audio: "shootOddsmaker",
    visual: "#efb85f brass die chamber with four payload tracer reads; held_oddsmaker hook",
    authority: ["bullets"],
    excelRoom: "swarm", weakRoom: "anchor",
  },
  pathmaker: {
    role: "safe-route painter: cleanse hostile ground and pave the crossing",
    metrics: ["control", "safety"],
    novelty: {
      nearest: "frostline",
      axes: ["geometry", "positioning"],
      note: "Frostline controls enemy travel; Pathmaker edits the players' route by removing hostile residue and paving safe ground across floor hazards.",
    },
    idealRange: "mid", target: "control",
    strength: "A bead trail opens a stable route through silk, cinders, corruption, and dangerous floor tiles.",
    weakness: "Its direct hit is intentionally feeble and paved ground does not control enemies.",
    resource: "none", status: "none",
    modifiers: "Size maps to paved width and life to route duration; standard shot damage and status modifiers still apply.",
    audio: "shootPathmaker",
    visual: "#a8d7a0 pale safe-route plates under a quiet bead; held_pathmaker hook",
    authority: ["bullets", "effects:zone"],
    excelRoom: "cover", weakRoom: "anchor",
  },
};
