// Central sprite registry. Every sprite is a 64x64 transparent PNG in /public/sprites.

import type { WeaponId, SpriteName, FloorHazardKind } from "../sim/types.js";
import { resolveClip } from "./facing.js";
import type { SelectableClip, MovePhaseClip, EnemyPose, ClipChoice, Facing4 } from "./facing.js";

// Re-exported so the many render call sites keep importing SpriteName from assets; the union
// itself now lives in the pure sim types module (see src/sim/types.ts) so the sim never
// imports into src/game.
export type { SpriteName };

// Animation clip an entity can request. When a matching sheet is registered below it
// plays frame-by-frame; otherwise the draw path falls back to procedural juice.
// SelectableClip is the render-contract set (legacy idle/walk + directional walk_* /
// attack_* — see src/game/facing.ts for the resolution ladder); "death" is a one-shot
// clip played over a corpse (see game.ts renderCorpses).
export type SheetClip = SelectableClip | "death";

export const FRAME = 64; // px per frame in a horizontal strip spritesheet

export interface SheetDef { src: string; fps: number; }

// Optional frame-based spritesheets, keyed by `${SpriteName}.${SheetClip}`.
// EMPTY BY DEFAULT so nothing extra is fetched (no 404s). Drop a horizontal 1xN
// strip (64px per frame) into public/sprites and add an entry to light it up.
// See ART.md for the format. Example:
//   "hero.walk": { src: "/sprites/hero_walk.png", fps: 10 },
export const SHEETS: Partial<Record<string, SheetDef>> = {
  "hero.walk": { src: "/sprites/hero_walk.png", fps: 10 },
  "slime.walk": { src: "/sprites/slime_walk.png", fps: 10 },
  "bat.walk": { src: "/sprites/bat_walk.png", fps: 12 },
  "skeleton.walk": { src: "/sprites/skeleton_walk.png", fps: 11 },
  "ghost.walk": { src: "/sprites/ghost_walk.png", fps: 6 },
  "boss.walk": { src: "/sprites/boss_walk.png", fps: 4 },
  "boss.idle": { src: "/sprites/boss_walk.png", fps: 4 },
  // One-shot death clips, played once over the corpse. Ghost/spitter have none and keep
  // the procedural corpse fade. Boss is 8 frames (768x96); the rest 5 frames (320x64).
  "slime.death": { src: "/sprites/slime_death.png", fps: 12 },
  "skeleton.death": { src: "/sprites/skeleton_death.png", fps: 12 },
  "bat.death": { src: "/sprites/bat_death.png", fps: 12 },
  "boss.death": { src: "/sprites/boss_death.png", fps: 12 },
};

// One-line registration for an AD directional set (the art/render contract convention).
// Side sheets are authored facing RIGHT (the renderer mirrors for left); frame 0 of each
// walk sheet doubles as that facing's idle pose. Registration happens once the PNGs are
// approved with exact names — the clip-selection ladder (facing.ts resolveClip) routes
// around any sheet that has not landed/loaded yet, so a set can ship file-by-file.
export interface DirectionalSetDef {
  walkFps: number;
  // Registers the attack sheet(s) when set: the `<base>_attack_<facing>.png` variants
  // with isDirectionalAttack, or one omni `<base>_attack.png` without it.
  attackFps?: number;
  isDirectionalAttack?: boolean;
  // AD-versioned finals whose file stem differs from the sprite name (e.g. weaver2_px).
  fileBase?: string;
  // The APPROVED facings only (defaults to all three). A body whose side profile is
  // blocked at the art gate registers ["down", "up"]; the selection ladder's vertical
  // hold covers its horizontal movement (facing.ts — never a mirrored side fake).
  facings?: readonly Facing4[];
}

const ALL_FACINGS: readonly Facing4[] = ["down", "up", "side"];

export function registerDirectionalSet(name: SpriteName, def: DirectionalSetDef): void {
  const base = def.fileBase ?? name;
  const facings = def.facings ?? ALL_FACINGS;
  for (const facing of facings) {
    SHEETS[`${name}.walk_${facing}`] = { src: `/sprites/${base}_walk_${facing}.png`, fps: def.walkFps };
  }
  if (def.attackFps === undefined) return;
  if (def.isDirectionalAttack) {
    for (const facing of facings) {
      SHEETS[`${name}.attack_${facing}`] = { src: `/sprites/${base}_attack_${facing}.png`, fps: def.attackFps };
    }
  } else {
    SHEETS[`${name}.attack`] = { src: `/sprites/${base}_attack.png`, fps: def.attackFps };
  }
}

// Move-specific telegraph sheets (the multi-move boss contract): registers
// `<sprite>.<move>_<phase>[_<facing>]` -> `/sprites/<base>_<move>_<phase>[_<facing>].png`,
// which OUTRANKS the generic attack tiers in the selection ladder (facing.ts). Entirely
// optional and per-sheet: author only the beats that need bespoke poses (a charge windup,
// a quake active, a crash-stun recover) and everything else keeps resolving through the
// generic set. `phase` spans windup/active/recover.
export function registerMoveSheet(
  name: SpriteName,
  clip: MovePhaseClip,
  fps: number,
  opts: { isDirectional?: boolean; fileBase?: string } = {},
): void {
  const base = opts.fileBase ?? name;
  if (opts.isDirectional) {
    SHEETS[`${name}.${clip}_down`] = { src: `/sprites/${base}_${clip}_down.png`, fps };
    SHEETS[`${name}.${clip}_up`] = { src: `/sprites/${base}_${clip}_up.png`, fps };
    SHEETS[`${name}.${clip}_side`] = { src: `/sprites/${base}_${clip}_side.png`, fps };
  } else {
    SHEETS[`${name}.${clip}`] = { src: `/sprites/${base}_${clip}.png`, fps };
  }
}

// AD-approved directional sets (final art gate): exact file stems per the content
// manifest — Ian copies the approved box files onto these names, no code changes.
// Fps values are start points the AD can tune per line.
registerDirectionalSet("charger", { walkFps: 10, attackFps: 12, isDirectionalAttack: true });
registerDirectionalSet("burrower", { walkFps: 10, attackFps: 12, isDirectionalAttack: true });
registerDirectionalSet("orbiter", { walkFps: 12, attackFps: 12, isDirectionalAttack: true });
registerDirectionalSet("shielder", { walkFps: 8, attackFps: 12, isDirectionalAttack: true });
registerDirectionalSet("marrow", { walkFps: 8, attackFps: 10, isDirectionalAttack: true });
registerDirectionalSet("weaver", { walkFps: 12, attackFps: 12, isDirectionalAttack: true, fileBase: "weaver2_px" });
// THE GILDED WARDEN's side profile is BLOCKED at the art gate (failed twice — stop):
// approved DOWN+UP sets only, plus the approved generic attack strip as the side-facing
// attack catch-all. Its horizontal movement holds the nearest vertical sheet via the
// ladder's vertical hold — no gilded_*_side file is ever requested.
registerDirectionalSet("gilded", { walkFps: 6, attackFps: 10, isDirectionalAttack: true, facings: ["down", "up"] });
SHEETS["gilded.attack"] = { src: "/sprites/gilded_attack.png", fps: 10 };
// The Hollow Choir is the stationary drifting mass: one breathing idle loop + one omni
// attack sheet (no walk triplet — the selection ladder falls from walk to idle for it).
SHEETS["choir.idle"] = { src: "/sprites/choir_idle.png", fps: 6 };
SHEETS["choir.attack"] = { src: "/sprites/choir_attack.png", fps: 10 };
// PATCH's authored poses (art gate — exact hooks, generated separately; nothing here is
// procedural). idle: the breathing keeper loop behind the counter. attack REPURPOSED as
// the one-shot HANDOVER pose (Patch never fights): played over a purchase. Facing is
// fixed (the stall faces down-room), so both are omni single strips.
SHEETS["patch.idle"] = { src: "/sprites/patch_idle.png", fps: 6 };
SHEETS["patch.attack"] = { src: "/sprites/patch_handover.png", fps: 10 };

// Directional hooks for the LEGACY roster (slime/bat/skeleton/ghost/spitter): the full
// walk contract is registered so approved directional finals are pure file drops, while
// the selection ladder keeps every one of them on its existing single walk strip until
// the new sheets actually load — current final art is preserved byte-for-byte.
registerDirectionalSet("slime", { walkFps: 10 });
registerDirectionalSet("bat", { walkFps: 12 });
registerDirectionalSet("skeleton", { walkFps: 11, attackFps: 12, isDirectionalAttack: true });
registerDirectionalSet("ghost", { walkFps: 6 });
registerDirectionalSet("spitter", { walkFps: 10, attackFps: 12, isDirectionalAttack: true });

// Bestiary-wave directional hooks. Same drop-in contract; fps are starting points.
// The bailiff (rootward) and the mason are WORKERS: their attack sheets are the raise —
// arms up, construction rising — not a strike.
registerDirectionalSet("rootward", { walkFps: 8, attackFps: 8, isDirectionalAttack: true });
registerDirectionalSet("mason", { walkFps: 9, attackFps: 8, isDirectionalAttack: true });
registerDirectionalSet("echojack", { walkFps: 12, attackFps: 12, isDirectionalAttack: true });
registerDirectionalSet("seamcutter", { walkFps: 10, attackFps: 12, isDirectionalAttack: true });
registerDirectionalSet("caskbellows", { walkFps: 8, attackFps: 12, isDirectionalAttack: true });
registerDirectionalSet("sinderling", { walkFps: 12, attackFps: 12, isDirectionalAttack: true });
registerDirectionalSet("marshal", { walkFps: 8, attackFps: 10, isDirectionalAttack: true });
// The fragment and The Toll are drifting/stationary masses (the Choir's contract):
// a breathing idle loop + one omni attack sheet, no walk triplet.
SHEETS["fragment.idle"] = { src: "/sprites/fragment_idle.png", fps: 6 };
SHEETS["fragment.attack"] = { src: "/sprites/fragment_attack.png", fps: 10 };
SHEETS["toll.idle"] = { src: "/sprites/toll_idle.png", fps: 5 };
SHEETS["toll.attack"] = { src: "/sprites/toll_attack.png", fps: 10 };
// Decoys are stationary props-with-a-pulse: one idle loop each.
SHEETS["echo.idle"] = { src: "/sprites/echo_idle.png", fps: 6 };
SHEETS["knell.idle"] = { src: "/sprites/knell_idle.png", fps: 8 };

// Tintable bullet-FX primitives (public/sprites/fx). Authored pure white with all
// intensity in the alpha channel so a single source-in fill recolors them and they
// composite additively. Sizes are baked into the art; the renderer scales per bullet.
export type FxName =
  | "glow_round" | "core_dot" | "trail_streak" | "slug" | "spark"
  | "comet_trail" | "crackle" | "arc_chain" | "smoke_puff"
  // Elemental status masks (public/sprites/fx). Authored by the AD; until the PNGs land
  // fxTinted returns null and the status/flame render falls back to glow_round + tint.
  | "ember" | "frost" | "freeze_shell" | "flame_puff" | "shock_ring"
  // The Sunlance's dedicated ray mask (pure white, code-tinted like every fx primitive);
  // the beam recipe falls back to trail_streak until it lands.
  | "beam_ray"
  // Effect-wave masks (frost zone disc, snapwire post, halo blade, sentry body, chain
  // link). Authored by the AD via the locked fal recipe; until the PNGs land fxTinted
  // returns null and each renderer keeps its readable primitive fallback.
  | "frost_zone" | "wire_post" | "halo_blade" | "sentry_core" | "chain_link";

const FX_SOURCES: Record<FxName, string> = {
  glow_round: "/sprites/fx/glow_round.png",
  core_dot: "/sprites/fx/core_dot.png",
  trail_streak: "/sprites/fx/trail_streak.png",
  slug: "/sprites/fx/slug.png",
  spark: "/sprites/fx/spark.png",
  comet_trail: "/sprites/fx/comet_trail.png",
  frost_zone: "/sprites/fx/frost_zone.png",
  wire_post: "/sprites/fx/wire_post.png",
  halo_blade: "/sprites/fx/halo_blade.png",
  sentry_core: "/sprites/fx/sentry_core.png",
  chain_link: "/sprites/fx/chain_link.png",
  crackle: "/sprites/fx/crackle.png",
  arc_chain: "/sprites/fx/arc_chain.png",
  smoke_puff: "/sprites/fx/smoke_puff.png",
  ember: "/sprites/fx/ember.png",
  frost: "/sprites/fx/frost.png",
  freeze_shell: "/sprites/fx/freeze_shell.png",
  flame_puff: "/sprites/fx/flame_puff.png",
  shock_ring: "/sprites/fx/shock_ring.png",
  beam_ray: "/sprites/fx/beam_ray.png",
};

// World props (destructibles + atmosphere) and the treasure chest, all in /public/sprites.
// The break/chest sheets are 3-frame 192x64 horizontal strips (frame 0 = intact/closed);
// barrel_explosive + brazier are 64x64 statics. The renderer slices frames itself, so no
// SpriteName/SheetClip unions are polluted and nothing extra is fetched if unused.
//
// SHOP FURNITURE HOOKS (art gate — Patch's waystation): patch_stall is the fold-out
// salvage cabinet (96x64: built from recovered doors/prop pieces, warm amber, counter
// front), shop_pedestal a 64x64 stone display pedestal, shop_heart_station a 64x64
// heart-glass dispenser, shop_reroll_post a 64x64 salvage-tag signpost. Until the
// approved PNGs land, the renderer draws each station as a clean flat primitive that
// makes no claim to final art (see game.ts renderShop).
export type PropSpriteName =
  | "crate_break" | "pot_break" | "barrel_break" | "barrel_explosive_break"
  | "barrel_explosive" | "brazier" | "chest_open"
  // Worker constructions (ecology gate): frame 0 = intact, frames 1-2 = breaking.
  | "root_wall_break" | "silt_mound_break" | "clinker_brick_break"
  | "patch_stall" | "shop_pedestal" | "shop_heart_station" | "shop_reroll_post";

const PROP_SOURCES: Record<PropSpriteName, string> = {
  crate_break: "/sprites/crate_break.png",
  root_wall_break: "/sprites/root_wall_break.png",
  silt_mound_break: "/sprites/silt_mound_break.png",
  clinker_brick_break: "/sprites/clinker_brick_break.png",
  pot_break: "/sprites/pot_break.png",
  barrel_break: "/sprites/barrel_break.png",
  barrel_explosive_break: "/sprites/barrel_explosive_break.png",
  barrel_explosive: "/sprites/barrel_explosive.png",
  brazier: "/sprites/brazier.png",
  chest_open: "/sprites/chest_open.png",
  patch_stall: "/sprites/patch_stall.png",
  shop_pedestal: "/sprites/shop_pedestal.png",
  shop_heart_station: "/sprites/shop_heart_station.png",
  shop_reroll_post: "/sprites/shop_reroll_post.png",
};

const SOURCES: Record<SpriteName, string> = {
  hero: "/sprites/hero.png",
  slime: "/sprites/slime.png",
  bat: "/sprites/bat.png",
  skeleton: "/sprites/skeleton.png",
  ghost: "/sprites/ghost.png",
  spitter: "/sprites/spitter.png",
  // Sprite hooks for the content-wave enemies + boss roster: generate via the locked fal
  // recipe (tools/gen-sprites.mjs charger burrower orbiter shielder marrow choir weaver
  // gilded) and drop the cutouts here. Until the art lands, drawChar's tinted-disc
  // fallback keeps every one of them rendering in its identity color.
  charger: "/sprites/charger.png",
  burrower: "/sprites/burrower.png",
  orbiter: "/sprites/orbiter.png",
  shielder: "/sprites/shielder.png",
  // Bestiary-wave hooks (same contract: fal recipe -> cutout drop-in; the tinted-disc
  // fallback carries each identity color until then).
  rootward: "/sprites/rootward.png",
  echojack: "/sprites/echojack.png",
  seamcutter: "/sprites/seamcutter.png",
  caskbellows: "/sprites/caskbellows.png",
  sinderling: "/sprites/sinderling.png",
  mason: "/sprites/mason.png",
  fragment: "/sprites/fragment.png",
  echo: "/sprites/echo.png",
  knell: "/sprites/knell.png",
  marshal: "/sprites/marshal.png",
  toll: "/sprites/toll.png",
  boss: "/sprites/boss.png",
  marrow: "/sprites/marrow.png",
  choir: "/sprites/choir.png",
  // AD-approved final base (content manifest: weaver2_px) — drop-in exact filename.
  weaver: "/sprites/weaver2_px.png",
  gilded: "/sprites/gilded.png",
  // PATCH — the Dealer NPC (studio coherence gate: warm amber salvage-hauler). ART GATE:
  // generated separately via the locked FAL recipe; until patch.png lands the renderer
  // shows the flagged placeholder silhouette (never procedural character art). Poses ship
  // as SHEETS hooks — see the registrations below + ART.md "Patch & the waystation".
  patch: "/sprites/patch.png",
  heart: "/sprites/heart.png",
  coin: "/sprites/coin.png",
  gun: "/sprites/gun.png",
  spit: "/sprites/spit.png",
};

export interface LoadedSheet { img: HTMLImageElement; fps: number; }

// Held-weapon overlay sprites drawn over the hero, rotating to aim. Each is authored
// 40px with the gun centered in the file, pointing +X (0 rad). Opt-in registry like
// SHEETS: only weapons with real art are listed, so nothing else is fetched (no 404s).
// Weapons absent here fall back at draw time (see game.ts renderHeldWeapon).
const HELD_SOURCES: Partial<Record<WeaponId, string>> = {
  pistol: "/sprites/held_pistol.png",
  shotgun: "/sprites/held_shotgun.png",
  rapid: "/sprites/held_rapid.png",
  smg: "/sprites/held_smg.png",
  cannon: "/sprites/held_cannon.png",
  burst: "/sprites/held_burst.png",
  ricochet: "/sprites/held_ricochet.png",
  homing: "/sprites/held_homing.png",
  tesla: "/sprites/held_tesla.png",
  sawnoff: "/sprites/held_sawnoff.png",
  railgun: "/sprites/held_railgun.png",
  nailer: "/sprites/held_nailer.png",
  flamer: "/sprites/held_flamer.png",
  // AD-approved finals (content manifest) — drop-in exact filenames.
  mortar: "/sprites/held_thumper.png",
  beam: "/sprites/held_beam2_px.png",
  // Melee (WeaponId -> AD's blade art: cutlass/claymore/pike).
  sword: "/sprites/held_cutlass.png",
  longsword: "/sprites/held_claymore.png",
  spear: "/sprites/held_pike.png",
  // Effect wave hooks — exact drop-in filenames for the generation pipeline
  // (tools/gen-sprites.mjs). Until the art lands, missing files 404 visibly in dev and
  // the held-weapon draw path falls back exactly like every other unregistered weapon.
  lastlight: "/sprites/held_lastlight.png",
  breach: "/sprites/held_breach.png",
  snapwire: "/sprites/held_snapwire.png",
  frostline: "/sprites/held_frostline.png",
  halo: "/sprites/held_halo.png",
  sentry: "/sprites/held_sentry.png",
  crook: "/sprites/held_crook.png",
};

// Floor-pickup art (64px side-profile) per weapon. Mirrors HELD_SOURCES: a weapon
// without an entry falls back to the generic "gun" sprite in renderPickups. The HUD
// hotbar reuses the same art as slot icons (see weaponIconSrc).
const PICKUP_SOURCES: Partial<Record<WeaponId, string>> = {
  pistol: "/sprites/weapon_pistol.png",
  shotgun: "/sprites/weapon_shotgun.png",
  rapid: "/sprites/weapon_rapid.png",
  smg: "/sprites/weapon_smg.png",
  cannon: "/sprites/weapon_cannon.png",
  burst: "/sprites/weapon_burst.png",
  ricochet: "/sprites/weapon_ricochet.png",
  homing: "/sprites/weapon_homing.png",
  tesla: "/sprites/weapon_tesla.png",
  sawnoff: "/sprites/weapon_sawnoff.png",
  railgun: "/sprites/weapon_railgun.png",
  nailer: "/sprites/weapon_nailer.png",
  flamer: "/sprites/weapon_flamer.png",
  // AD-approved finals (content manifest) — drop-in exact filenames.
  mortar: "/sprites/weapon_thumper.png",
  beam: "/sprites/beam2_px.png",
  sword: "/sprites/weapon_cutlass.png",
  longsword: "/sprites/weapon_claymore.png",
  spear: "/sprites/weapon_pike.png",
  // Effect wave hooks (same contract as the held set above).
  lastlight: "/sprites/weapon_lastlight.png",
  breach: "/sprites/weapon_breach.png",
  snapwire: "/sprites/weapon_snapwire.png",
  frostline: "/sprites/weapon_frostline.png",
  halo: "/sprites/weapon_halo.png",
  sentry: "/sprites/weapon_sentry.png",
  crook: "/sprites/weapon_crook.png",
};

// The weapon's icon art for DOM HUD surfaces (the hotbar): its pickup side profile.
// Null for a weapon without pickup art; callers fall back to the generic pixel gun.
export function weaponIconSrc(id: WeaponId): string | null {
  return PICKUP_SOURCES[id] ?? null;
}

export class Sprites {
  private images = new Map<SpriteName, HTMLImageElement>();
  private tintCache = new Map<string, HTMLCanvasElement>();
  private sheetTintCache = new Map<string, HTMLCanvasElement>();
  private flashCache = new Map<SpriteName, HTMLCanvasElement>();
  private sheets = new Map<string, LoadedSheet>();
  private heldImages = new Map<WeaponId, HTMLImageElement>();
  private pickupImages = new Map<WeaponId, HTMLImageElement>();
  private fxImages = new Map<FxName, HTMLImageElement>();
  private fxTintCache = new Map<string, HTMLCanvasElement>();
  private propImages = new Map<PropSpriteName, HTMLImageElement>();
  private propFlashCache = new Map<PropSpriteName, HTMLCanvasElement>();

  constructor() {
    for (const name of Object.keys(SOURCES) as SpriteName[]) {
      const img = new Image();
      img.src = SOURCES[name];
      this.images.set(name, img);
    }
    for (const key of Object.keys(SHEETS)) {
      const def = SHEETS[key];
      if (!def) continue;
      const img = new Image();
      img.src = def.src;
      this.sheets.set(key, { img, fps: def.fps });
    }
    for (const id of Object.keys(HELD_SOURCES) as WeaponId[]) {
      const src = HELD_SOURCES[id];
      if (!src) continue;
      const img = new Image();
      img.src = src;
      this.heldImages.set(id, img);
    }
    for (const id of Object.keys(PICKUP_SOURCES) as WeaponId[]) {
      const src = PICKUP_SOURCES[id];
      if (!src) continue;
      const img = new Image();
      img.src = src;
      this.pickupImages.set(id, img);
    }
    for (const name of Object.keys(FX_SOURCES) as FxName[]) {
      const img = new Image();
      img.src = FX_SOURCES[name];
      this.fxImages.set(name, img);
    }
    for (const name of Object.keys(PROP_SOURCES) as PropSpriteName[]) {
      const img = new Image();
      img.src = PROP_SOURCES[name];
      this.propImages.set(name, img);
    }
  }

  // A loaded prop/chest image (break sheet or static), or null while it streams in so the
  // renderer can fall back to a plain box.
  prop(name: PropSpriteName): HTMLImageElement | null {
    const img = this.propImages.get(name);
    return img && img.complete && img.naturalWidth > 0 ? img : null;
  }

  // A cached fully-white silhouette of a prop image, used to flash it white on a hit.
  // Drawing a sub-rect of this yields the white silhouette of that sheet frame.
  propFlash(name: PropSpriteName): HTMLCanvasElement | null {
    const cached = this.propFlashCache.get(name);
    if (cached) return cached;
    const img = this.propImages.get(name);
    if (!img || !img.complete || img.naturalWidth === 0) return null;
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d");
    if (!g) return null;
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = "source-atop";
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    this.propFlashCache.set(name, c);
    return c;
  }

  fxTinted(name: FxName, color: string): HTMLCanvasElement | null {
    // White art carries its shape in alpha, so a single source-in fill recolors it once;
    // callers draw the result with globalCompositeOperation 'lighter'. Cached per
    // name+color, so steady state never allocates. Null until the source image has loaded,
    // letting the bullet renderer fall back to a plain circle.
    const key = `${name}|${color}`;
    const cached = this.fxTintCache.get(key);
    if (cached) return cached;
    const img = this.fxImages.get(name);
    if (!img || !img.complete || img.naturalWidth === 0) return null;
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d");
    if (!g) return null;
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = "source-in";
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    this.fxTintCache.set(key, c);
    return c;
  }

  // A loaded held-weapon overlay for this weapon, or null to skip / fall back.
  heldWeapon(id: WeaponId): HTMLImageElement | null {
    const img = this.heldImages.get(id);
    return img && img.complete && img.naturalWidth > 0 ? img : null;
  }

  weaponPickup(id: WeaponId): HTMLImageElement | null {
    const img = this.pickupImages.get(id);
    return img && img.complete && img.naturalWidth > 0 ? img : null;
  }

  get(name: SpriteName): HTMLImageElement {
    return this.images.get(name)!;
  }

  ready(name: SpriteName): boolean {
    const img = this.images.get(name);
    return !!img && img.complete && img.naturalWidth > 0;
  }

  // A loaded spritesheet for this clip, or null to fall back to procedural animation.
  sheet(name: SpriteName, clip: SheetClip): LoadedSheet | null {
    const s = this.sheets.get(`${name}.${clip}`);
    if (s && s.img.complete && s.img.naturalWidth > 0) return s;
    return null;
  }

  // The render-contract clip pick for a body's pose this frame (see facing.ts for the
  // fallback ladder). Availability is LOADED sheets, so a registered-but-streaming
  // directional set degrades to the legacy tier until its pixels arrive.
  selectClip(name: SpriteName, pose: EnemyPose): ClipChoice {
    return resolveClip((clip) => this.sheet(name, clip) !== null, pose);
  }

  // A cached fully-white silhouette of a sprite, used to flash it on hit.
  flashSprite(name: SpriteName): HTMLCanvasElement | null {
    const img = this.images.get(name);
    if (!img || !img.complete || img.naturalWidth === 0) return null;
    const cached = this.flashCache.get(name);
    if (cached) return cached;
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d");
    if (!g) return null;
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = "source-atop";
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    this.flashCache.set(name, c);
    return c;
  }

  // Recolor a loaded image to a player's hue while keeping the sprite's shading. A flat 50%
  // color overlay would drag every hue toward the strongly-amber base and make teammates look
  // alike ("all blue"); instead: strip to grayscale (a zero-saturation pass keeps only
  // luminance), multiply the target color through it — light/dark shading survives but the
  // hue reads true — then mask back to the silhouette, since the full-rect passes also cover
  // the transparent margin.
  private recolor(img: HTMLImageElement, color: string): HTMLCanvasElement | null {
    if (!img.complete || img.naturalWidth === 0) return null;
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d");
    if (!g) return null;
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = "saturation";
    g.fillStyle = "hsl(0, 0%, 50%)";
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = "multiply";
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = "destination-in";
    g.drawImage(img, 0, 0);
    return c;
  }

  // A recolored base sprite (cached per name+color); null while the source streams in.
  tintedSprite(name: SpriteName, color: string): HTMLCanvasElement | null {
    const key = `${name}|${color}`;
    const cached = this.tintCache.get(key);
    if (cached) return cached;
    const img = this.images.get(name);
    if (!img) return null;
    const c = this.recolor(img, color);
    if (c) this.tintCache.set(key, c);
    return c;
  }

  tintedHero(color: string): HTMLCanvasElement | null {
    return this.tintedSprite("hero", color);
  }

  // A recolored animation sheet, pixel-identical in layout to the source strip so callers can
  // slice frames with the ORIGINAL sheet's metrics. Lets a color-picked hero keep its real
  // walk animation instead of degrading to the static tinted base.
  tintedSheetCanvas(name: SpriteName, clip: SheetClip, color: string): HTMLCanvasElement | null {
    const key = `${name}.${clip}|${color}`;
    const cached = this.sheetTintCache.get(key);
    if (cached) return cached;
    const sheet = this.sheets.get(`${name}.${clip}`);
    if (!sheet) return null;
    const c = this.recolor(sheet.img, color);
    if (c) this.sheetTintCache.set(key, c);
    return c;
  }
}

// Environment tiles + props. Every PNG is 48x48 (torch_glow is 96x96) and lives in
// /public/tiles. Kept as a tiny parallel loader to Sprites so the tile renderer can
// draw real art with a graceful fillRect fallback while images stream in.
export type TileName =
  | "floor" | "floor2" | "floor3" | "floor4"
  | "floor_crack" | "floor_grate" | "floor_moss"
  | "wall_top" | "wall_face" | "wall_shadow"
  | "torch_f0" | "torch_f1" | "torch_f2" | "torch_glow"
  | "portal_f0" | "portal_f1"
  | "stairs_f0" | "stairs_f1"
  | "wf_top" | "wf_N" | "wf_E" | "wf_S" | "wf_W" | "wf_NE" | "wf_ES" | "wf_SW" | "wf_NW" | "wf_EW" | "wf_NS" | "wf_NES" | "wf_ESW" | "wf_NEW" | "wf_NSW" | "wf_NESW";

export const TILE_SOURCES: Record<TileName, string> = {
  floor: "/tiles/floor.png",
  floor2: "/tiles/floor2.png",
  floor3: "/tiles/floor3.png",
  floor4: "/tiles/floor4.png",
  floor_crack: "/tiles/floor_crack.png",
  floor_grate: "/tiles/floor_grate.png",
  floor_moss: "/tiles/floor_moss.png",
  wall_top: "/tiles/wall_top.png",
  wall_face: "/tiles/wall_face.png",
  wall_shadow: "/tiles/wall_shadow.png",
  torch_f0: "/tiles/props/torch_f0.png",
  torch_f1: "/tiles/props/torch_f1.png",
  torch_f2: "/tiles/props/torch_f2.png",
  torch_glow: "/tiles/props/torch_glow.png",
  portal_f0: "/tiles/props/portal_f0.png",
  portal_f1: "/tiles/props/portal_f1.png",
  stairs_f0: "/sprites/stairs_f0.png",
  stairs_f1: "/sprites/stairs_f1.png",
  wf_top: "/sprites/walls_full/wall_top.png",
  wf_N: "/sprites/walls_full/wall_N.png",
  wf_E: "/sprites/walls_full/wall_E.png",
  wf_S: "/sprites/walls_full/wall_S.png",
  wf_W: "/sprites/walls_full/wall_W.png",
  wf_NE: "/sprites/walls_full/wall_NE.png",
  wf_ES: "/sprites/walls_full/wall_ES.png",
  wf_SW: "/sprites/walls_full/wall_SW.png",
  wf_NW: "/sprites/walls_full/wall_NW.png",
  wf_EW: "/sprites/walls_full/wall_EW.png",
  wf_NS: "/sprites/walls_full/wall_NS.png",
  wf_NES: "/sprites/walls_full/wall_NES.png",
  wf_ESW: "/sprites/walls_full/wall_ESW.png",
  wf_NEW: "/sprites/walls_full/wall_NEW.png",
  wf_NSW: "/sprites/walls_full/wall_NSW.png",
  wf_NESW: "/sprites/walls_full/wall_NESW.png",
};

// ---- per-biome tile art (opt-in, like SHEETS) ----
// Keyed by Biome.tileKey (src/sim/biomes.ts). A biome without an entry renders the
// shared tile set graded by its palette (the renderer's fallback); a listed biome lights
// up the moment its PNGs exist — no other code changes. Loading is graceful: a listed
// but not-yet-copied file just 404s once and the fallback holds.
//
// The entries below are the AD's APPROVED set (filenames verbatim from the approval, so
// the ship step is exactly `cp /workspace/fal-art/biomes/*.png public/tiles/biomes/`).
// Band mapping per the canon re-band: the approved "verdant" art IS the Amberwild band's
// living-roots identity. Rootbound (same ecology per curriculum §10) and Gilded Archive
// have no approved art yet and stay on the graded fallback; the approved fracture_* set
// predates the re-band and stays uncopied unless the AD re-purposes it.
export interface BiomeTileArt {
  floors: string[];    // floor variants, hash-picked per tile (>= 1)
  wallTop?: string;    // 48x48 wall block used when the full autotile set is absent
}

export const BIOME_TILE_SOURCES: Partial<Record<string, BiomeTileArt>> = {
  amberwild: { floors: ["/tiles/biomes/verdant_floor_px.png"], wallTop: "/tiles/biomes/verdant_wall_px.png" },
  sunless: { floors: ["/tiles/biomes/sunless_floor_px.png"], wallTop: "/tiles/biomes/sunless_wall_px.png" },
  deep: { floors: ["/tiles/biomes/deep_floor_px.png"], wallTop: "/tiles/biomes/deep_wall2_final_px.png" },
  ember: { floors: ["/tiles/biomes/ember_floor_px.png"], wallTop: "/tiles/biomes/ember_wall2_final_px.png" },
  nullvoid: { floors: ["/tiles/biomes/nullvoid_floor2_final_px.png"], wallTop: "/tiles/biomes/nullvoid_wall2_final_px.png" },
};

// ---- hazard body art (opt-in) ----
// 64x64 PNG (or a 1xN 64px strip; frame count inferred from width) per hazard kind:
//   spikes: 3 frames (retracted / arming / extended), toxic_pool: 2-frame slow boil,
//   fire_vent: 3 frames (grate / smolder / erupting base), void_rift: 2-frame maw.
// Approved sheets (ship step: `cp /workspace/fal-art/hazards/*.png public/tiles/hazards/`).
// Until the copy lands, the renderer draws each hazard in the same primitive telegraph
// language as the boss slam marker (see game.ts renderHazards).
export const HAZARD_SOURCES: Partial<Record<FloorHazardKind, string>> = {
  spikes: "/tiles/hazards/spikes_sheet.png",
  fire_vent: "/tiles/hazards/fire_vent_sheet.png",
  toxic_pool: "/tiles/hazards/toxic2_sheet.png",
  void_rift: "/tiles/hazards/rift2_sheet.png",
};

export class TileSet {
  private images = new Map<TileName, HTMLImageElement>();
  private biomeFloors = new Map<string, HTMLImageElement[]>();
  private biomeWallTops = new Map<string, HTMLImageElement>();
  private hazardImages = new Map<FloorHazardKind, HTMLImageElement>();
  private tintCache = new Map<string, HTMLCanvasElement>();

  constructor() {
    for (const name of Object.keys(TILE_SOURCES) as TileName[]) {
      const img = new Image();
      img.src = TILE_SOURCES[name];
      this.images.set(name, img);
    }
    for (const key of Object.keys(BIOME_TILE_SOURCES)) {
      const art = BIOME_TILE_SOURCES[key];
      if (!art) continue;
      this.biomeFloors.set(key, art.floors.map((src) => {
        const img = new Image();
        img.src = src;
        return img;
      }));
      if (art.wallTop) {
        const img = new Image();
        img.src = art.wallTop;
        this.biomeWallTops.set(key, img);
      }
    }
    for (const kind of Object.keys(HAZARD_SOURCES) as FloorHazardKind[]) {
      const src = HAZARD_SOURCES[kind];
      if (!src) continue;
      const img = new Image();
      img.src = src;
      this.hazardImages.set(kind, img);
    }
  }

  get(name: TileName): HTMLImageElement {
    return this.images.get(name)!;
  }

  ready(name: TileName): boolean {
    const img = this.images.get(name);
    return !!img && img.complete && img.naturalWidth > 0;
  }

  // A loaded biome floor variant (hash-picked), or null to fall back to the shared set.
  biomeFloor(tileKey: string, pick: number): HTMLImageElement | null {
    const list = this.biomeFloors.get(tileKey);
    if (!list || list.length === 0) return null;
    const img = list[Math.abs(pick) % list.length];
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  biomeWallTop(tileKey: string): HTMLImageElement | null {
    const img = this.biomeWallTops.get(tileKey);
    return img && img.complete && img.naturalWidth > 0 ? img : null;
  }

  // A loaded hazard body sheet for this kind, or null for the primitive fallback.
  hazard(kind: FloorHazardKind): HTMLImageElement | null {
    const img = this.hazardImages.get(kind);
    return img && img.complete && img.naturalWidth > 0 ? img : null;
  }

  // A recolored copy of a tile/prop image (shape from alpha, hue from `color`), cached
  // per name+color. Lets one authored glow/detail asset serve every biome palette.
  tinted(name: TileName, color: string): HTMLCanvasElement | null {
    const key = `${name}|${color}`;
    const cached = this.tintCache.get(key);
    if (cached) return cached;
    const img = this.images.get(name);
    if (!img || !img.complete || img.naturalWidth === 0) return null;
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d");
    if (!g) return null;
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = "source-in";
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    this.tintCache.set(key, c);
    return c;
  }
}

// A stable, readable palette for co-op players (host first).
export const PLAYER_COLORS = [
  "#ffb43b", // amber (you / host)
  "#5ad1ff", // cyan
  "#7CFC98", // green
  "#ff7ad1", // pink
  "#c98bff", // violet
  "#ff8a5a", // orange
] as const;

export function playerColor(index: number): string {
  return PLAYER_COLORS[index % PLAYER_COLORS.length];
}

// The explicit "identity not resolved yet" grey for teammate surfaces (dots, rings, labels).
// Deliberately OUTSIDE the player palette: an unresolved color must read as unresolved,
// never as somebody's actual pick.
export const NEUTRAL_PLAYER_COLOR = "#8f87a8";

// A teammate's identity color, or the neutral placeholder while it is unresolved (null).
// The one nullable-color entry point every roster/minimap/label surface goes through, so a
// missing claim can never fall back to a guessed palette slot.
export function playerColorOr(index: number | null): string {
  return index === null ? NEUTRAL_PLAYER_COLOR : playerColor(index);
}

// ---- dev sprite-viewer manifest (?dev=sprites) ----
// A read-only listing of the registered art, used only by the dev sprite/anim viewer.
// Nothing in a normal run calls these; they just re-expose the private source maps above
// as a tidy, labeled surface so the viewer never has to reach into engine internals.
export interface DevAssetEntry { label: string; src: string; group: string; }
export interface DevSheetEntry { key: string; src: string; fps: number; }

export function devSpriteManifest(): DevAssetEntry[] {
  const out: DevAssetEntry[] = [];
  for (const name of Object.keys(SOURCES) as SpriteName[]) out.push({ label: name, src: SOURCES[name], group: "sprites" });
  for (const id of Object.keys(HELD_SOURCES) as WeaponId[]) {
    const src = HELD_SOURCES[id];
    if (src) out.push({ label: `held ${id}`, src, group: "held weapons" });
  }
  for (const id of Object.keys(PICKUP_SOURCES) as WeaponId[]) {
    const src = PICKUP_SOURCES[id];
    if (src) out.push({ label: `pickup ${id}`, src, group: "weapon pickups" });
  }
  for (const name of Object.keys(PROP_SOURCES) as PropSpriteName[]) out.push({ label: name, src: PROP_SOURCES[name], group: "props" });
  for (const name of Object.keys(FX_SOURCES) as FxName[]) out.push({ label: name, src: FX_SOURCES[name], group: "bullet fx" });
  return out;
}

export function devSheetManifest(): DevSheetEntry[] {
  const out: DevSheetEntry[] = [];
  for (const key of Object.keys(SHEETS)) {
    const def = SHEETS[key];
    if (def) out.push({ key, src: def.src, fps: def.fps });
  }
  return out;
}
