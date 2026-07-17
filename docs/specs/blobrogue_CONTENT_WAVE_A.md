# BlobRogue Content Wave A — Owner Canon

Status: owner-ratified. Names and verbs are locked.

## Weapons

| Name | Canonical verb |
|---|---|
| MOORING NAIL | ANCHOR / GRAPPLE |
| SLUICEGATE | MODESHIFT |
| ODDSMAKER | GAMBLE |
| PATHMAKER | CLEANSE / PAVE |

SLUICEGATE has no alternate-control input. Its authoritative next mode is the persisted
two-shot FLOOD/DRAIN cycle; a refused trigger does not advance it.

ODDSMAKER commits one independent deterministic payload per shot. Added pellets share that
payload. Outcomes cannot be demanded and consecutive repeats are possible.

MOORING NAIL admits one central anchor pellet per committed shot. Its previewed wall bite and
destination use the same collision-safe swept route as the authoritative pull. Dynamic and
floor hazards remain dangerous during travel.

PATHMAKER safety applies only when a player center is inside a live paved zone. A transient
web, cinder, or corruption circle is cleansed only when its full authoritative footprint is
contained by the newly painted circle. Paving never clears boss state or resurrects deleted
hazards after expiry. The total zone budget is 48: Frostline reserves 32 and paving reserves
16, with at most 8 live pave zones per owner and 8 admitted zones per committed shot.

## Blessings

- HOLD FAST
- NOTHING WASTED
- SECOND BREATH MUDDY
- ON THE BEAT
- SHARED ROPE

HOLD FAST and SHARED ROPE are intentionally restrained stat-lean sidegrades. NOTHING WASTED
reclaims only a true enemy miss. SECOND BREATH MUDDY refunds once per dash that clears silk.
ON THE BEAT remains bounded by the existing 1.8 fire-rate cap. SHARED ROPE changes only its
owner's revive radius and channel rate; one authoritative reviver owns each channel.

## Catalog migration

- Catalog `0` is the immutable pre-Wave-A pickup and normal-blessing pool cut at `e501819`.
- Catalog `1` is Wave A and is selected by server/run authority for genuinely fresh runs.
- A run keeps one catalog version through floors, reconnect, resume, and replay.
- Missing catalog fields in old snapshots decode as catalog `0`; unknown versions fail closed.
- Browser input, tickets, profiles, URLs, loadouts, and client commands cannot select a catalog.
- Future content adds a new catalog version. Existing catalog arrays are never edited.

Boss signature and permanent reward mappings are outside this manifest and remain unchanged.
Art, audio, and human play approval remain external gates.

## Authority and protocol

Each owned weapon has an authoritative remaining cooldown. Switching saves the outgoing
cooldown and restores the incoming weapon's cooldown; inactive cooldowns continue to decay.
A newly acquired weapon starts ready, while swapping back to a previously fired weapon resumes
its remaining cadence. Cooldowns survive snapshots, deltas, reconnect, floor transitions, and
resume.

Protocol v34 belongs to PR #142 and carries catalog version, weapon cooldowns/cycles,
SLUICEGATE observer mode, ODDSMAKER bullet outcome, Muddy dash state, and revive channel owner.
Pale PR #140 rebases after #142 as v35. PvP work follows the latest merged protocol and only
allocates another version when it changes the wire.

The main agent still owes approved held/pickup/pave art and authored audio takes. Current audio
rows are typed silent hooks; runtime oscillators and generated placeholder binaries are banned.
