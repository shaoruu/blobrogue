# blobrogue toolchain

The asset + QA pipeline that lets this game (and future studio projects) generate,
process, and verify content reproducibly from the box. All run from the repo root
after `source /workspace/.secrets/env.sh` (loads FAL_KEY etc.).

## Art generation (fal.ai)
- **`gen-sprites.mjs <name...>`** — generate a game sprite from the built-in SUBJECTS
  prompt table via flux, auto background-removed (birefnet) → `/workspace/fal-art/<name>-cut.png`.
- **`falgen.mjs --provider <flux|recraft|ideogram|...> --prompt "...plain white bg..." --out x.png`**
  — general text→image. recraft is best for clean icons.
- **`falrmbg.mjs <in.png> <out.png>`** — background removal (birefnet) → clean transparency.
- **`keyout.py <in.png> <out.png> [size]`** — flood-fill remove light bg, trim, center, resize.
- **`pixelize.py <in.png> <out.png> [--grid N]`** — enforce the art bible: downscale to a
  pixel grid, snap to the locked ~30-color palette, 1px outline, export at 64px NEAREST.
  ⚠️ Do NOT run on an already-assembled multi-frame STRIP (it collapses the sheet — this
  caused the slime_walk bug). Pixelize single frames, then assemble the strip.
- **`add_shadow.py`**, **`faledit.mjs`** — grounding shadow / fal image edit helpers.

## Audio generation (fal → ElevenLabs / Stable Audio)
- **`falsfx.mjs --type sfx --prompt "..." --out x.mp3 --dur 0.6 [--infl 0.3]`** — one-shot SFX
  via `fal-ai/elevenlabs/sound-effects/v2`. Append the DRY SUFFIX (see GEN_AUDIO_PROMPTS_EL.md)
  for punchy game sounds. Re-run for variants (EL has no seed).
- **`falsfx.mjs --type music --prompt "..." --out x.mp3 --ms 90000`** — looping instrumental
  music via `fal-ai/elevenlabs/music` (force_instrumental).
- **`gen_audio_batch.mjs`** — batch-generate the whole SFX set from `/workspace/audio-gen/manifest.json`.
- Post: normalize with `ffmpeg -af "silenceremove=...,loudnorm=I=-16:TP=-2:LRA=11,alimiter=limit=0.89"`;
  loop music by trimming fades + equal-power crossfade tail→head. Export ogg + mp3 to public/audio/.

## QA / verification
- **`audit-sprites.py`** — scans every spritesheet, flags degenerate frames (skinny/empty/wrong
  dims). RUN BEFORE EVERY ART SHIP. Exit 1 on any flag. Catches the "squashed slime" class of bug.
- **`/workspace/qa/capture-gameplay.sh [secs] [out.mp4]`** — record live gameplay on display :1
  for videoReview (motion/feel QA that screenshots can't do).

## Golden rules (learned the hard way)
1. AD "committed to the repo" ≠ in git — always `git status public/sprites` and commit untracked
   assets BEFORE launching a cloud agent that wires them (agents build from GitHub, not the box).
2. Every spritesheet frame must share the same bbox scale. Run audit-sprites.py.
3. `vite preview` dies when backgrounded on the box; serve dist/ with `python3 -m http.server`
   via a tool-managed background shell (block_until_ms:0), or playtest the live Vercel deploy.
4. Box has no audio sink — can't hear audio; verify the pipeline (files serve, WebAudio inits) +
   let Ian judge sound by ear.
