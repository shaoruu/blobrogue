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
export type ResourceModel = "none" | "hold" | "placement" | "position" | "health-risk";
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
    metrics: ["lane"],
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
};
