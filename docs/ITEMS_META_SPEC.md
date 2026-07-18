# blobrogue items + meta-progression spec (game designer) — build-ready

Plugs into: coins (currently ZERO use → shop gives purpose), boss every 5 floors, descend heals +2,
single swappable weapon slot, profile persists deepestFloor/totalKills/totalCoins/gamesPlayed.

## Architecture
`player.mods` bag, recomputed when items change (sum over held items). Apply at POINT-OF-USE, never mutate base tables.
mods = { damageMult, fireRateMult, moveSpeedMult, maxHpAdd, bulletSpeed/Life/SizeMult, pierce, bounce,
extraPellets, spreadAdd, crit, critMult, lifestealChance, thorns, dashCdMult, iframeAdd, pickupRadiusMult,
coinDropMult, explosive/explRadius/explDmgFrac }.
Hooks: dmg=weapon.damage*damageMult (crit→*critMult); fireCd=weapon.fireCd/fireRateMult CLAMP≥.045;
pellets/spread/pierce/bounce/explosive/size from mods; move=200*moveSpeedMult CLAMP≤1.6; dashcd=0.7*dashCdMult;
ifr+=iframeAdd; maxHp=6+maxHpAdd; onKill lifesteal+coinMult; onContact thorns.
ITEMS table: {id:{name,rarity,tags,unique?,apply(mods),onKill?,onHit?,active?{key,cd,fn}}}.

## 16 items (rarity → drop weight)
COMMON(w60): Quick Powder fireRate×1.15 | Heavy Rounds dmg×1.20/bulletSpd×0.90 | Running Shoes move×1.12 |
Tin Heart maxHp+2 | Long Barrel bulletSpd×1.3/life×1.3 | Lucky Spurs coinDrop×1.6/pickupR×1.5 | Worn Grip dashCd×0.8.
UNCOMMON(w30): Side Channel: dash or hard aim flick arms a 55%-damage shot along the previous aim | Hollow Points pierce+1 | Ricochet bounce+1 |
Glass Cannon dmg×1.5/maxHp−2(unique) | Vampiric Fang 10% on-kill heal1 | Adrenaline @HP≤2 move+fireRate×1.25.
RARE(w10): Boomstick explosive r55/60% AoE | Crit Charm crit.25/×2.5 | [ACTIVE] Blink Engine (Space cd6s: tp180px+0.6s ifr).
Optional: Turret Totem (active), Twin Hearts (1 revive/run + shortens co-op bleed-out).
Stacking: mults multiply, adds add. CLAMPS fireCd≥.045/move≤1.6/pierce≤5/bounce≤3/dmg uncapped. Unique removed once dropped. ONE active slot.

## 3 signature synergies (emergent, no special-casing)
- OFF ANGLE = Side Channel + Hollow Points + Quick Powder.
- DEMOLITION = Boomstick + Heavy Rounds + Crit Charm.
- GLASS ASSASSIN = Glass Cannon + Vampiric Fang + Worn Grip + Blink.
Need `tags` on items so UI/AD can color-theme cards.

## Drops (tie into floor loop)
1. CHESTS (primary, free): 1 guaranteed/non-boss floor in dead-end room (reuse placeWeaponPickups room-pick). Open=DRAFT 1-of-3. Rarity per weight +1%rare/floor luck.
2. SHOP (coin sink): shop room every 3rd floor (3,6,9). 3 pedestals Common8c/Uncommon15c/Rare28c + Heart-refill 6c + reroll 5c. (income ~3-6 coins/floor).
3. BOSS REWARD (5,10,15): guaranteed Rare, choice-of-2 + heart/coins.

## Between-run META (Amber currency, on existing profile + unlocks[])
Earn EVEN ON LOSS: amber += floorsReached + kills/10 + bossKills*5.
Spend pre-run at "Blob Camp": (a) POOL UNLOCKS — start ~8/16 items, buy spicier Rares/actives into pool 20-60A;
(b) META PERKS hard-capped: Start+1HP 40A, Start+5coins 25A, +5%rare-luck 50A, 2nd starting-weapon 60A (cap total ~+1 item's worth so skill dominates).
Future: tintedHero/drawChar already supports tinted heroes → alt characters = Amber sink + cosmetic/character-DLC path.

## Sellable tie-in (demo/full split)
Web free demo = floors 1-5 + ~8 items + low Amber cap. Steam paid = full pool + all meta + characters.
Sells "progression tree behind paywall" WITHOUT gating fun (core loop complete in demo). Wishlist driver.

## Build order (AFTER combat)
1. mods bag + hooks + 7 commons + chest drafting (MVP of depth — ship & playtest). ~80% of "why replay" for ~30% work.
2. Uncommons/Rares + synergies + boss-reward drop.
3. Shop (coin purpose).
4. Amber meta + Blob Camp screen.

---
## CANONICAL PLAYTEST OVERRIDE (see `docs/PROGRESSION_SPEC.md` §10)
- Blessing duplicates are explicit LV2/LV3 upgrades, max Lv3 then removed from pool; chooser prioritizes new items 3× but may show clearly labeled upgrades. PlayerMods recomputes from item-level state. Exact per-item level effects are canonical in PROGRESSION_SPEC.
- Coin Magnet: Lv1 radius90/pull240px/s; Lv2 radius240/pull480; Lv3 radius900/pull900 (add coinMagnetPull mod).
- Coins are temporary Dealer-room currency; Amber alone is persistent.
- Duplicate owned weapon pickups stay on floor and never auto-switch/consume.
- First melee is guaranteed floors2–3; Dealer carries melee until account flag `discover:melee`.
Any older duplicate/drop/economy wording in this document is superseded by PROGRESSION_SPEC §10.

- Fang canonical sustain reset: Lv1/Lv2/Lv3 = 8/13/17%, shared 1.25s proc cooldown, trivial summons excluded. Dash iframe canonical 0.18s; Second Wind remains ×.65/.55/.50 with no iframe overlap/refresh.
