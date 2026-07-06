# blobrogue art bible (art director)

## Core principle
Environment = the STAGE, cast = the ACTORS. Everything in the environment sits BEHIND sprites:
lower contrast, no black outline, muted, so outlined saturated characters always pop.
Contrast ladder (brightest→dullest): **exit portal > cast sprites > props > walls > floor.**

## Sprites (cast) — 28-color palette, LOCKED
Palette: 05030b(outline) 0e0b1a 171227 2a2140 46356b | 7a3d12 c77320 ffb43b ffd166 ffe9b0 |
5a1020 c0243a ff5a5f | 1f5a2e 3fbf5f 8fffa8 | 6b6f8a c9c9de ffffff | 2a5fa0 57b6ff bfeaff |
6a2fb0 a24bff d9a6ff | 301c0e 6b401e 9c6633 (leather brown).
- 32px grid → 64px NEAREST (boss 48→96). Mandatory 1px #05030b outline, binary alpha, one top-left light.
- Grounding shadow #261a14 ~4px ellipse under every sprite (palette-exempt contact tone), identical across set.
- Enemies: stay in assigned family + outline + small #ffffff accents only. No hero-material (brown) bleed. base≥dark.
- Family assignments: hero=amber, slime=green(1f5a2e/3fbf5f/8fffa8), bat=red(5a1020/c0243a/ff5a5f),
  skeleton=bone(6b6f8a/c9c9de/ffffff white-DOMINANT), ghost=blue(2a5fa0/57b6ff/bfeaff), boss=purple(6a2fb0/a24bff/d9a6ff).
- Silhouette separation gate (IoU<0.6). Interior darks must be DELIBERATE (#05030b sockets), never leaked tile color.

## Floor tiles
- 16px grid → 48px (3x NEAREST). Lower detail than sprites (density hierarchy).
- 4 base tiles (near-identical, #171227 dominant + subtle 0e0b1a/2a2140 speckle to kill checker) + 3 detail tiles (crack/grate/moss), detail ~1 in 12 tiles MAX.
- Dungeon ramp ONLY (05030b/0e0b1a/171227/2a2140/46356b). No amber/family colors on floor. Tight value band.
- Depth: tint rows slightly darker toward top (far), lighter near bottom — 1 ramp step, not gradient.
- NO outline. Soft 1px #0e0b1a grout lines between tiles.

## Walls — fake 2.5D (kills the flatness)
- Two visible parts: TOP SURFACE (lit #46356b, #2a2140 mortar) + FRONT FACE below (#2a2140, ~0.7 tile tall) revealing height.
- Top edge highlight lip (#3a2c5c/#46356b) top-left light. Face darker. Face bottom darkest (#0e0b1a).
- CAST SHADOW: 1-tile #0e0b1a shadow onto floor below (non-negotiable, grounds the wall).
- NO #05030b outline — different edge language (internal value steps + top lip) so walls read as architecture not sprite.
- Author 16px, as 3-tile vertical set (wall-top / wall-face / wall-base+shadow), composes to any height.

## Props (DO get sprite treatment — near-cast objects)
- Props get #05030b outline + grounding shadow SAME as sprites (contrast lever = outlined props read interactive).
- Torch: brown bracket (301c0e/6b401e), amber flame (ffb43b core/ffd166 tip), 2-3 frame flicker. Amber glow pool (~40 alpha c77320 ellipse) — only place amber touches floor, it's a light effect not a tile.
- Crate: leather-brown ramp + outline + X-brace.
- Rubble/bones: small bone-white pips (#c9c9de) + outline, low density.
- Exit portal: amber ring (ffb43b outer, c77320 fill, ffd166 inner rim). Brightest thing on screen = goal read.

## fal approach
- Sprites/props: nano-banana edit from locked hero anchor → birefnet → pixelize.py --sprite (outline + shadow assert).
- Tiles: recraft v3 digital_illustration/pixel_art, "seamless dungeon floor tileset 16px top-down dark purple stone", 4x4 sheet → slice → pixelize.py --tile (NO outline, seamless edge-wrap check, dungeon-ramp clamp).
- TWO enforce profiles: --sprite (outline+shadow, current default) and --tile (no outline, seamless edges, dungeon-only palette). [TODO: add --tile to pixelize.py before environment work]

## Redo order
Cast: hero✓ slime✓ bat✓ skeleton(pending) ghost(pending) → coin/heart/gun/boss. THEN environment: floor tileset → walls → props.
