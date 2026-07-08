# blobrogue — BIOME HUE LANES (Creative Director's palette direction)
Prompted by the user's "the game reads same-y" flag + the AD's measurement (64% of pixels dark+purple, environment 63% purple). This is a world-palette call and it's the right one. Endorsed, with refinements + the guardrails that make it work.

## The call: YES — give each biome its own hue lane
- **Verdant Hollow = GREEN** (alive, deceptively safe — the tutorial world)
- **Sunless Caves = BLUE** (cold, lonely, the light's gone)
- **The Deep = PURPLE — KEEP** (wrong, cursed, this is where it turns)
- **Emberreach = RED/ORANGE** (hell, heat, the climax)

Right now purple is the *whole game's* wallpaper, which does two bad things: it flattens variety (the same-y read), AND it wastes purple. Purple should MEAN something. Making it **The Deep's signature** kills both birds — the world gets variety, and the Hollow/Fracture identity hits *harder by contrast* because now violet only shows up where things are genuinely wrong. The Light Goes Out presentation especially: a black-violet ultimate erupting in a GREEN forest reads 10x more "holy shit" than violet-on-violet. This change makes our flagship look better for free.

## Why it also serves the throughline (not just variety)
The hue lanes double as an **emotional descent arc** that IS our core identity ("a world slowly going wrong"):
GREEN (alive) → BLUE (cold/abandoned) → PURPLE (cursed/wrong) → RED (burning/climax).
The player literally watches the world's color drain from life to hell as they descend. That's the vision doc's "soft hero, world going sharp" told through palette alone. Lean into it — the transitions between contiguous biomes should feel like the color *bleeding* from one lane to the next.

## The THREE guardrails that keep this from just being "4 monochrome levels"
This is the part that makes or breaks it — a biome that's 90% one hue is the same same-y trap, just greener.

1. **The hero stays AMBER/warm in EVERY biome — non-negotiable.** This is the soft-warm-hero rule (vision doc pillar 1). The blob must pop against green, blue, purple, AND red. Amber is warm and mid-bright, so it reads against all four — but VERIFY the blob's contrast in the blue and red lanes specifically (amber-on-red is the risky one; may need a subtle cool rim-light on the blob in Emberreach so it doesn't melt into the background). The hero is the one color constant; the world changes around it.

2. **Every biome needs a HOSTILE-ACCENT that fights its lane.** A green forest where the enemies are also green = unreadable. Danger reads cold+angular (vision rule), so each lane needs a contrasting threat color: Verdant(green) → enemies/tells in cold violet or red; Sunless(blue) → hostile amber/orange tells; The Deep(purple) → sickly green (the Molt lives here — its rot-green pops beautifully against purple); Emberreach(red) → cold cyan/white tells. The rule: **the floor tells you where you ARE (lane hue); the bright hostile accent tells you where the DANGER is.** Readability first, always.

3. **Value/contrast structure stays constant across all four.** Only the HUE rotates — the light/dark composition (dark floor, mid props, bright hazards, bright hero) stays identical biome to biome so the game stays readable and fair. We're rotating the color wheel, not rebuilding the lighting per biome. Cheap to build (mostly tint-lane swaps on existing masks, exactly our pipeline), and it keeps combat legibility rock-solid.

## Weapon-school ↔ biome resonance (a nice free win)
The schools already have spiritual homes; the hue lanes reinforce them: **Goldwork** (amber/gold) glows warm in any lane but especially the Verdant green; **The Choir** (cyan) pops against Emberreach red; **The Molt** (rot-green) is The Deep's native horror against purple; **The Hollow** (soot/cold blue/dead amber) is *of* The Deep — finding Hollow weapons in The Deep makes material sense, while carrying their soot-black/cold-blue warmth-drain into Verdant green makes the loss of warmth hit harder. Don't hard-gate schools to biomes, but let the resonance guide where each is *most likely* to drop.

## Verdict for Ian
Strong yes, and it's low-risk: it's a tint-lane pass on the existing mask pipeline (not new art), it fixes the same-y read he flagged, it makes the Hollow/Resonance flagship hit *harder*, and it turns the four biomes into an emotional descent (alive → cold → cursed → burning) that tells our core story through color. The only real work is verifying hero contrast in the blue/red lanes and assigning each biome its hostile-accent. Recommend green-lighting; I'll gate the hero-contrast check + the per-biome accent palette with the AD.

## Routing note (locked)
This is a Creative Director recommendation to the main blobrogue project runner, who owns the decision and rollout. Do not gate it on Ian approval. Recommended execution remains: prototype Verdant as one vertical slice, gate readability with the project runner, then extend the proven system.

---
## POST-SERVER SUPERSESSION: REAL LIGHTING
Hue lanes remain palette support, but are NOT sufficient biome/depth identity. After authoritative Stage C, use `blobrogue_POST_SERVER_LIGHTING_spec.md`: material/ecology/room grammar + real authored light sources and darkness behavior. Preserve this doc's contrast/accessibility intent; do not treat its old "constant value structure" as a ban on authored light variation. Player/tells/objectives retain a readability floor.
