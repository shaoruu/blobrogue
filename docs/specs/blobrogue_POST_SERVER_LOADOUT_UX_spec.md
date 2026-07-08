# blobrogue — POST-SERVER LOADOUT / ADDON / INSPECTION UX (design-only)
**Gate:** no implementation before authoritative Stage A→B→C is production-green. Reads/writes authoritative PlayerSim/loadout state; no client-only inventory truth.

## Bottom-center combat HUD (locked location)
A compact persistent bottom-center strip:
- **Primary weapon slot** + **Secondary weapon slot** (large, side-by-side; equipped one raised/bright).
- **Addon A / Addon B** (smaller sockets adjacent/below; these are the two trinket/addon slots from Progression, not extra gear systems).
- Per-weapon local rhythm is INSIDE its slot: cylinder pips/reload, charge fill, heat, every-third Bleakseed cost, etc. No extra global meters.
- Key/controller labels visible until learned; swap animation short and non-blocking.
- Resonance remains by combo/HP as the one global signature meter; addons never add meters.

## In-world pickup focus / inspect
When player enters weapon/addon focus radius (or hovers with cursor/gamepad focus):
- Do NOT pause combat by default. Show compact card anchored near pickup but clamped to screen.
- Header: name, family, rarity, `NEW`/`OWNED` status.
- One prominent **room verb** (`BREAK LINE`, `SEEK`, `BANK`, etc.).
- Actual-game stats from authoritative definitions, not marketing bars: Damage, cadence (shots/s or cooldown), range/life, pellets/arc/reach, pierce/bounce/homing/chain/status, knockback; charge/cylinder constraint where relevant.
- Compare vs currently equipped same slot: signed exact deltas (e.g. `Damage +3`, `Cadence −0.4/s`, `Pierce +2`). Mechanical lines use plain verbs, max 4 rows before “details.”
- Addon card states condition + exact effect + tradeoff; no vague “greatly.”
- Duplicate owned weapon remains physical/uncollected, card says `OWNED · AVAILABLE FOR ALLY`; no switch or conversion.

## Weapon details / discovered arsenal
At Training station / Armorer in Amber Camp, inspect any discovered weapon using the actual same WeaponDef/GearDef data. Shows room verb, stats, family/Resonance, compatible interactions, mastery challenges. Locked entries are diegetic silhouettes/clues, not a giant grey grid.

## Addon contract
“Addon” is presentation language for the existing two trinket slots—NOT a fifth progression layer.
- Max2 equipped, max2 affixes each, persistent sidegrades under Progression caps.
- No addon levels/gear score. Rarity means mechanical complexity.
- Addon effects must modify universal hooks (projectile behavior/status/positioning/recovery/economy), not add currencies/meters.

## Server/client split
- Server owns inventory, loadout, equipped index, pickup eligibility, authoritative WeaponDef/GearDef version.
- Client owns focus detection prediction/card animation but confirms pickup/equip through server result; card stats come from versioned shared definitions.
- Snapshot contains compact equipped ids/rhythm state; no whole inventory every tick.

## Accessibility / readability
Readable at 1280×720, controller focus, no reliance on color for rarity/deltas. Bottom strip never obscures player/telegraphs. Hide/fade strip only in authored cinematics; not during combat.

## Acceptance
- Tester identifies current two weapons/addons without opening a menu.
- Pickup comparison understood in <3s; actual simulated stat matches shown value.
- No new global meter/currency/slot beyond 2 weapons +2 addons.
- Duplicate pickup/ally behavior is explicit.
