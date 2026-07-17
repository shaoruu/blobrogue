# Claimant ALL THINGS OWED remaster (PR #175)

Params (all `public/audio/boss/claimant_owed_*.ogg` + matching `.mp3`):

- `loudnorm=I=-14:TP=-1.5:LRA=11,alimiter=limit=0.89:level=disabled`
- encode: libvorbis `-q:a 5` → libmp3lame `-q:a 4` from remastered ogg
- late-onset trim (~10ms pad) when crest-relative onset >50ms
- trailing silence trim (keep ~15ms) on near-empty stems

Source swaps from closed #170 (`ian/claimant-owed-audio-f70`):

- `claimant_owed_deposit` ← denser `deposit_v1` (was selected `deposit_v2`, late crest)

No denser alts existed for lock / overcommit / token_drop (single takes); densified via onset/trail trim.
Target: max_volume ≤ -1.0 dB / peak < 0.89 linear on every stem.
