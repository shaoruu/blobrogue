import { writeFileSync } from "node:fs";
import { PVP, pvpHitDamage, pvpPerHitCap } from "../src/sim/pvp.js";
import {
  createMods,
  itemById,
  itemMaxLevel,
  recomputeMods,
} from "../src/sim/items.js";
import { WEAPONS } from "../src/sim/weapons.js";
import { CAPS } from "../src/sim/balance.js";

interface PvpDraftEnvelopeRow {
  itemId: string;
  level: number;
  weaponId: string;
  expectedDps: number;
  boundedDps: number;
  modeledTtkSec: number;
  worstTickDamage: number;
}

interface PvpDraftEnvelopeReport {
  generatedFrom: string;
  model: string;
  caps: {
    fixedHp: number;
    damageMult: number;
    fireRateMult: number;
    moveSpeedMult: number;
    pierce: number;
    elementalChance: number;
    maxTickDamage: number;
    ttkFloorSec: number;
    medianTtkBandSec: readonly [number, number];
  };
  summary: {
    legalBuilds: number;
    weapons: number;
    rows: number;
    medianTtkSec: number;
    maxTickDamage: number;
    isMedianInBand: boolean;
    isEveryTickCapped: boolean;
    isEveryRawCapClean: boolean;
  };
  rows: PvpDraftEnvelopeRow[];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function median(values: readonly number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function buildPvpDraftEnvelopeReport(): PvpDraftEnvelopeReport {
  const rows: PvpDraftEnvelopeRow[] = [];
  let legalBuilds = 0;
  let isEveryRawCapClean = true;
  for (const itemId of PVP.blessingPool) {
    const item = itemById(itemId);
    if (item === undefined) throw new Error(`missing PVP blessing: ${itemId}`);
    for (let level = 1; level <= itemMaxLevel(item); level++) {
      legalBuilds++;
      const owned = Array.from({ length: level }, () => itemId);
      const mods = createMods();
      recomputeMods(mods, owned, PVP.kit);
      if (mods.damageMult > CAPS.damageMult
        || mods.fireRateMult > CAPS.fireRateMult
        || mods.moveSpeedMult > CAPS.moveSpeedMult
        || mods.pierce > CAPS.pierce
        || mods.burnChance > CAPS.elementalChance
        || mods.chillChance > CAPS.elementalChance
        || mods.shockChance > CAPS.elementalChance) {
        isEveryRawCapClean = false;
      }
      for (const weapon of Object.values(WEAPONS)) {
        const pellets = weapon.melee === undefined
          ? Math.max(1, weapon.pellets + mods.extraPellets)
          : 1;
        const expectedCrit = 1 + mods.critChance * Math.max(0, mods.critMult - 1);
        const expectedTriggerDamage = pvpHitDamage(
          weapon.id,
          weapon.damage * mods.damageMult * pellets * expectedCrit,
        );
        const expectedDps = expectedTriggerDamage * mods.fireRateMult / weapon.fireCd;
        const boundedDps = Math.min(expectedDps, PVP.maxHp / PVP.ttkMinSec);
        const worstTriggerDamage = pvpHitDamage(
          weapon.id,
          weapon.damage * mods.damageMult * pellets * mods.critMult,
        );
        const outputScale = expectedDps > boundedDps ? boundedDps / expectedDps : 1;
        rows.push({
          itemId,
          level,
          weaponId: weapon.id,
          expectedDps: round(expectedDps),
          boundedDps: round(boundedDps),
          modeledTtkSec: round(PVP.maxHp / Math.max(0.001, boundedDps)),
          worstTickDamage: round(Math.min(pvpPerHitCap(), worstTriggerDamage * outputScale)),
        });
      }
    }
  }
  const medianTtkSec = median(rows.map((row) => row.modeledTtkSec));
  const maxTickDamage = Math.max(...rows.map((row) => row.worstTickDamage));
  return {
    generatedFrom: "BlobRogue policy-bound PVP draft",
    model: "full-HP expected direct output with runtime TTK scaler and per-victim tick cap",
    caps: {
      fixedHp: PVP.maxHp,
      damageMult: CAPS.damageMult,
      fireRateMult: CAPS.fireRateMult,
      moveSpeedMult: CAPS.moveSpeedMult,
      pierce: CAPS.pierce,
      elementalChance: CAPS.elementalChance,
      maxTickDamage: pvpPerHitCap(),
      ttkFloorSec: PVP.ttkMinSec,
      medianTtkBandSec: [PVP.ttkMinSec, PVP.ttkMaxSec],
    },
    summary: {
      legalBuilds,
      weapons: Object.keys(WEAPONS).length,
      rows: rows.length,
      medianTtkSec: round(medianTtkSec),
      maxTickDamage: round(maxTickDamage),
      isMedianInBand: medianTtkSec >= PVP.ttkMinSec && medianTtkSec <= PVP.ttkMaxSec,
      isEveryTickCapped: rows.every((row) => row.worstTickDamage <= pvpPerHitCap()),
      isEveryRawCapClean,
    },
    rows,
  };
}

const report = buildPvpDraftEnvelopeReport();
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const outputPath = outputArg?.slice("--output=".length);
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) writeFileSync(outputPath, serialized);
else process.stdout.write(serialized);

if (!report.summary.isMedianInBand
  || !report.summary.isEveryTickCapped
  || !report.summary.isEveryRawCapClean) {
  process.exitCode = 1;
}
