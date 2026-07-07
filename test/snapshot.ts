// Canonical per-tick simulation snapshot. Both the pre-extraction oracle and the
// refactored-sim test build this identical shape from their respective state so the
// golden diff is apples-to-apples. Floats are rounded to 1e-4 to absorb harmless FP
// noise; entity ARRAY ORDER is significant (creation/compaction order is preserved by
// the extraction, so enemies/bullets/etc. line up index-for-index).

export function r(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

export interface PlayerView {
  x: number; y: number; hp: number; maxHp: number;
  fireCd: number; dashCd: number; dashTime: number; invuln: number;
  weapon: string; kills: number; coins: number; combo: number; comboTimer: number;
  shotSeq: number; facing: number;
  // item mods that shots read (proves synergies applied identically)
  damageMult: number; fireRateMult: number; extraPellets: number; pierce: number;
  critChance: number; maxHpBonus: number;
}

export interface EnemyView {
  kind: string; x: number; y: number; hp: number; maxHp: number; vx: number; vy: number;
  zig: number; spawnTimer: number; stuckTimer: number;
  burn: number; burnDmg: number; chill: number; shock: number; statusTick: number;
  phase: string; atkTime: number; move: string; windup: number; cooldown: number;
  lockedAngle: number; isAimLocked: boolean; markX: number; markY: number;
  bossPhase: number; minionTimer: number; isNextRadial: boolean; burstParity: number;
}

export interface BulletView {
  x: number; y: number; vx: number; vy: number; life: number; radius: number;
  friendly: boolean; damage: number; pierce: number; isCrit: boolean;
  bounce: number; homing: number; chain: number;
  burn: number; chill: number; shock: number;
}

export interface PickupView { kind: string; x: number; y: number; value: number; weapon: string }
export interface PropView { kind: string; x: number; y: number; dead: boolean; hp: number; breakT: number }
export interface ChestView { kind: string; x: number; y: number; opened: boolean; openT: number }

export interface TickSnapshot {
  tick: number;
  player: PlayerView;
  enemies: EnemyView[];
  bullets: BulletView[];
  pickups: PickupView[];
  props: PropView[];
  chests: ChestView[];
}

// A player-ish source (fields read via bracket access from either representation).
type Anyish = Record<string, unknown>;

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

export function playerView(p: Anyish, mods: Anyish): PlayerView {
  return {
    x: r(num(p.x)), y: r(num(p.y)), hp: r(num(p.hp)), maxHp: r(num(p.maxHp)),
    fireCd: r(num(p.fireCd)), dashCd: r(num(p.dashCd)), dashTime: r(num(p.dashTime)), invuln: r(num(p.invuln)),
    weapon: String(p.weapon), kills: num(p.kills), coins: num(p.coins), combo: num(p.combo), comboTimer: r(num(p.comboTimer)),
    shotSeq: num(p.shotSeq), facing: num(p.facing),
    damageMult: r(num(mods.damageMult)), fireRateMult: r(num(mods.fireRateMult)),
    extraPellets: num(mods.extraPellets), pierce: num(mods.pierce), critChance: r(num(mods.critChance)),
    maxHpBonus: num(mods.maxHpBonus),
  };
}

export function enemyView(e: Anyish): EnemyView {
  const a = e.attack as Anyish;
  const boss = (e.boss as Anyish) ?? null;
  return {
    kind: String(e.kind), x: r(num(e.x)), y: r(num(e.y)), hp: r(num(e.hp)), maxHp: r(num(e.maxHp)),
    vx: r(num(e.vx)), vy: r(num(e.vy)), zig: r(num(e.zig)), spawnTimer: r(num(e.spawnTimer)), stuckTimer: r(num(e.stuckTimer)),
    burn: r(num(e.burn)), burnDmg: r(num(e.burnDmg)), chill: r(num(e.chill)), shock: r(num(e.shock)), statusTick: r(num(e.statusTick)),
    phase: String(a.phase), atkTime: r(num(a.time)), move: String(a.move), windup: r(num(a.windup)),
    cooldown: r(num(a.cooldown)), lockedAngle: r(num(a.lockedAngle)), isAimLocked: Boolean(a.isAimLocked),
    markX: r(num(a.markX)), markY: r(num(a.markY)),
    bossPhase: boss ? num(boss.phase) : 0, minionTimer: boss ? r(num(boss.minionTimer)) : 0,
    isNextRadial: boss ? Boolean(boss.isNextRadial) : false, burstParity: boss ? num(boss.burstParity) : 0,
  };
}

export function bulletView(b: Anyish): BulletView {
  return {
    x: r(num(b.x)), y: r(num(b.y)), vx: r(num(b.vx)), vy: r(num(b.vy)), life: r(num(b.life)), radius: r(num(b.radius)),
    friendly: Boolean(b.friendly), damage: r(num(b.damage)), pierce: num(b.pierce), isCrit: Boolean(b.isCrit),
    bounce: num(b.bounce), homing: num(b.homing), chain: num(b.chain),
    burn: r(num(b.burn)), chill: r(num(b.chill)), shock: r(num(b.shock)),
  };
}

export function pickupView(p: Anyish): PickupView {
  return { kind: String(p.kind), x: r(num(p.x)), y: r(num(p.y)), value: num(p.value), weapon: p.weapon ? String(p.weapon) : "" };
}

export function propView(p: Anyish): PropView {
  return { kind: String(p.kind), x: r(num(p.x)), y: r(num(p.y)), dead: Boolean(p.dead), hp: r(num(p.hp)), breakT: p.breakT === undefined ? -1 : r(num(p.breakT)) };
}

export function chestView(c: Anyish): ChestView {
  return { kind: String(c.kind), x: r(num(c.x)), y: r(num(c.y)), opened: Boolean(c.opened), openT: c.openT === undefined ? -1 : r(num(c.openT)) };
}

// Compare two snapshot streams; returns a human-readable divergence or null if identical.
export function diffStreams(a: TickSnapshot[], b: TickSnapshot[]): string | null {
  if (a.length !== b.length) return `tick count differs: ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    const sa = JSON.stringify(a[i]);
    const sb = JSON.stringify(b[i]);
    if (sa !== sb) return localizeDiff(a[i], b[i]);
  }
  return null;
}

function localizeDiff(a: TickSnapshot, b: TickSnapshot): string {
  const out: string[] = [`divergence at tick ${a.tick}:`];
  const pa = JSON.stringify(a.player);
  const pb = JSON.stringify(b.player);
  if (pa !== pb) out.push(`  player: ${fieldDiff(a.player as Anyish, b.player as Anyish)}`);
  compareArr("enemies", a.enemies as Anyish[], b.enemies as Anyish[], out);
  compareArr("bullets", a.bullets as Anyish[], b.bullets as Anyish[], out);
  compareArr("pickups", a.pickups as Anyish[], b.pickups as Anyish[], out);
  compareArr("props", a.props as Anyish[], b.props as Anyish[], out);
  compareArr("chests", a.chests as Anyish[], b.chests as Anyish[], out);
  return out.join("\n");
}

function compareArr(name: string, a: Anyish[], b: Anyish[], out: string[]): void {
  if (a.length !== b.length) {
    out.push(`  ${name}: length ${a.length} vs ${b.length}`);
    return;
  }
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
      out.push(`  ${name}[${i}]: ${fieldDiff(a[i], b[i])}`);
    }
  }
}

function fieldDiff(a: Anyish, b: Anyish): string {
  const diffs: string[] = [];
  for (const k of Object.keys(a)) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push(`${k}=${JSON.stringify(a[k])}→${JSON.stringify(b[k])}`);
  }
  return diffs.join(", ");
}
