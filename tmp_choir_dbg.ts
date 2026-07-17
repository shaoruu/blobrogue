
import { createWorld, stepWorld, loadFloorIntoWorld } from "./src/sim/world.js";
import { LOCAL_ID } from "./src/sim/input.js";
import { FIXED_DT } from "./src/net/protocol.js";
import type { InputCmd } from "./src/sim/input.js";
const idle = (seq: number): InputCmd => ({ seq, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false });
const w = createWorld(0xC460, 60, {});
w.isGodMode = true;
loadFloorIntoWorld(w, 60);
const boss = w.enemies.find(e => e.kind === "choirmaster")!;
const p = w.players.get(LOCAL_ID)!;
p.x = boss.x + 20; p.y = boss.y;
for (let i = 0; i < 60; i++) stepWorld(w, new Map([[LOCAL_ID, idle(i)]]), FIXED_DT);
console.log({ active: w.encounter?.active, spawnTimer: boss.spawnTimer, pillars: w.enemies.filter(e=>e.kind==="choir_pillar").length,
  live: w.encounter?.flags.livePillarId, lastAddPick: boss.boss?.lastAddPick, cd: boss.attack.cooldown, move: boss.attack.move, phase: boss.attack.phase, exposed: boss.boss?.exposed });
boss.spawnTimer = 0;
boss.boss!.lastAddPick = 0;
boss.attack.cooldown = 0;
for (let i = 0; i < 10; i++) {
  stepWorld(w, new Map([[LOCAL_ID, idle(100+i)]]), FIXED_DT);
  console.log("after force", i, boss.attack.move, boss.attack.phase, boss.boss!.lastAddPick, w.encounter?.flags.lastNotePhase, w.encounter?.flags.livePillarId);
}
