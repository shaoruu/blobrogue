# blobrogue — BIOME HUE LANES (Creative Director's palette direction)
Prompted by the user's "the game reads same-y" flag + the AD's measurement (64% of pixels dark+purple, environment 63% purple). This is a world-palette call and it's the right one. Endorsed, with refinements + the guardrails that make it work.

## The call: six approved region lanes (palette supports material, never defines alone)
- **Amberwild = GREEN / living sap**
- **Rootbound Warrens = deep GREEN-BROWN / braided roots + amber channels**
- **Sunless Caves = cold BLUE-GREY / shale and bone**
- **The Deep = PURPLE-BLACK / jet resin and fracture**
- **Gilded Archive = rigid AMBER/BRASS + cold mineral**
- **Emberreach = RED/ORANGE + cold CYAN stress cores**
Purple remains specific to The Deep. Rootbound is denser material/room grammar, not a duplicate hue filter; Gilded Archive is rigid/cold amber, not warm Camp gold.
## Why it also serves the throughline
The visual descent is: living boundary → dense root formations → warmth absent/sound → material fracture → rigid amber order → false pressure-heat. Color participates in that story, but silhouettes, room grammar, props, and lighting carry equal weight. Transitions should look like material states changing, not six color filters.
## The THREE guardrails that keep this from just being "4 monochrome levels"
This is the part that makes or breaks it — a biome that's 90% one hue is the same same-y trap, just greener.

1. **The hero stays AMBER/warm in EVERY biome — non-negotiable.** This is the soft-warm-hero rule (vision doc pillar 1). The blob must pop against living green, root-brown, blue-grey, purple-black, rigid amber, AND red/cyan. Amber is warm and mid-bright, so it reads across all six — but VERIFY the blob's contrast in the blue and red lanes specifically (amber-on-red is the risky one; may need a subtle cool rim-light on the blob in Emberreach so it doesn't melt into the background). The hero is the one color constant; the world changes around it.

2. **Every biome needs a HOSTILE-ACCENT that fights its lane.** A green forest where the enemies are also green = unreadable. Danger reads cold+angular (vision rule), so each lane needs a contrasting threat color: Amberwild(green) → cold violet/red tells; Rootbound(green-brown) → bone-white/red formation tells; Sunless(blue-grey) → bone-white/red momentum tells; The Deep(purple-black) → sickly green/cold white; Gilded Archive(rigid amber) → cold cyan/black pressure; Emberreach(red/orange) → cold cyan/white stress cores. The rule: **the floor tells you where you ARE (lane hue); the bright hostile accent tells you where the DANGER is.** Readability first, always.

3. **Value/contrast structure stays constant across all six.** Only the HUE rotates — the light/dark composition (dark floor, mid props, bright hazards, bright hero) stays identical biome to biome so the game stays readable and fair. We're rotating the color wheel, not rebuilding the lighting per biome. Cheap to build (mostly tint-lane swaps on existing masks, exactly our pipeline), and it keeps combat legibility rock-solid.

## Weapon-school ↔ biome resonance (a nice free win)
The schools already have spiritual homes; the hue lanes reinforce them: **Goldwork** (living amber/gold) contrasts most strongly with Gilded Archive’s rigid cold amber and still reads in Amberwild; **The Choir** (cyan) pops against Emberreach red; **The Molt** (rot-green) is The Deep's native horror against purple; **The Hollow** (soot/cold blue/dead amber) is *of* The Deep — finding Hollow weapons in The Deep makes material sense, while carrying their soot-black/cold-blue warmth-drain into Amberwild green makes the loss of warmth hit harder. Don't hard-gate schools to biomes, but let the resonance guide where each is *most likely* to drop.

## Verdict for Ian
Strong yes, and it's low-risk: it's a tint-lane pass on the existing mask pipeline (not new art), it fixes the same-y read he flagged, it makes the Hollow/Resonance flagship hit *harder*, and it supports the six-region descent (alive → rootbound → cold → fractured → rigid order → false heat) that tells our core story through color. The only real work is verifying hero contrast in the blue/red lanes and assigning each biome its hostile-accent. Recommend green-lighting; I'll gate the hero-contrast check + the per-biome accent palette with the AD.

## Routing note (locked)
This is a Creative Director recommendation to the main blobrogue project runner, who owns the decision and rollout. Do not gate it on Ian approval. Recommended execution remains: prototype Amberwild as one vertical slice, gate readability with the project runner, then extend the proven system.

---
## POST-SERVER SUPERSESSION: REAL LIGHTING
Hue lanes remain palette support, but are NOT sufficient biome/depth identity. After authoritative Stage C, use `blobrogue_POST_SERVER_LIGHTING_spec.md`: material/ecology/room grammar + real authored light sources and darkness behavior. Preserve this doc's contrast/accessibility intent; do not treat its old "constant value structure" as a ban on authored light variation. Player/tells/objectives retain a readability floor.
