# Depth-scaling coin sinks + vendor ecology (APPROVED SPEC)
Source: balancer (t892, price curve) + game designer (t893, WHAT/WHERE), approved by Ian 2026-07-09.
RULE: everything is COINS (per-run). NEVER cross into Amber/persistent meta. Nothing skips a boss mechanic.

## Income reality (for pricing)
Cumulative GROSS by depth (no-Greed / Greedy): F10 ~90/175, F15 ~165/325, F20 ~255/510, F25 ~355/720, F30 ~475/980.
"Big splurge" pool after normal Dealer spend: F15 ~100/210, F20 ~170/360, F25 ~250/500, F30 ~340/700.
Intent: AVERAGE run affords ONE premium sink per ~5 floors; a great/greedy run affords a big-ticket + a splurge. Nothing guaranteed.

## Price model
PRICE = base x depthMult(floor), depthMult = 1 + 0.09*(floor - F_intro), round to 5.
Premium Shop room at F10/15/20/25/30 (replaces one normal room, never on boss/gauntlet floors). Visible-but-locked: always render unaffordable premium items greyed with price so the "save for it" goal forms.

## Vendor ecology (build order = impact/effort)
1. Standard Shop rarity ceiling rises by region (Amberwild common/uncommon -> mid rare -> late one legendary slot). CHEAPEST, big feel win. BUILD FIRST.
2. "Spoils" boss-reward vendor after each boss (1-3 premium items; natural fat-wallet spike). Reuses shop UI. BUILD SECOND.
3. Guaranteed climax vendor (fixed deep floor pre-final-boss) stocks top tier: Heart Container + Revive Token + Legendary/Mystery weapon + Panacea + Weapon Upgrade. BUILD THIRD.
4. High Roller room (rare, chance rises with depth) — marquee big-ticket. Backlog.
5. Weapon Upgrade Station (rare) — elevate an OWNED gun one rarity tier, cost scales with target tier. Backlog.

## Catalog (all Coin-priced, all respect existing caps)
Premium weapons: Legendary (identified, max 1/pool), Mystery (gamble, rolls rare+), Artifact (hearts-price at High Roller, 1-2 containers, cap 1/run), Upgrade Station purchase.
Per-run upgrades: Heart Container +1 (vs +4 cap, price x1.6 each buy), Core Infusion (single-stat bump vs raw caps), Extra Dash Charge (cap 1), Extra Item/Blessing Slot (cap 1, expensive), Revive Token (co-op, cap 1, steep).
Splurge consumables: Panacea (full heal, NOT on boss floors, no iframes), Reweave (shop reroll, +50%/use), Guaranteed Rare Blessing, Prospector's Draught (+coins this floor).

## Sink prices (base, pre-depthMult)
Mystery weapon: F10 45/F15 70/F20 100/F25 135/F30 170. Legendary: F15 130/F20 190/F25 260/F30 330. Rare blessing: F10 40..F30 140. +1 MaxHP: F10 55..F30 180 (x1.6 each). Full heal: F10 30..F30 100. Reroll-all: F10 35..F30 125 (+50%/use).
MYTHIC slot (F20/25/30 only, "spend everything" capstone): F20 300/F25 430/F30 600. Options: Fusion-tier weapon / rare-blessing trio pick-1 / Amber windfall +8. F30 ~600 vs greedy pool ~700.

## Guardrails
No boss-floor shop; no invuln/phase-skip purchase; full heal never during boss; mid-fight shop disabled. All caps hold: weapon <=1.35 PU ideal, blessing raw caps (damage2.25/fire1.8/status50), maxHP+4, permanent <30% Foundation (coins never touch it). Coins CANNOT buy permanent power; leftover coins -> tiny Amber trickle only (<= +2 Amber/100 unspent, cap +5/run). Co-op: stock per player max(2,P) distinct, purchases personal non-depleting, prices unchanged by P, Mythic one per party per shop. Coin income per-player (no shared pool). Target buy-rate <=1 premium/5 floors avg; Mythic afford 8-20% greedy, <3% no-Greed.
