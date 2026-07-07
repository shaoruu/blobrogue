# blobrogue — STAGE A: ISOMORPHIC SIM EXTRACTION (cursor-agent-ready)
The linchpin. Extract the simulation into `src/sim/` (pure, node+browser, deterministic), leaving game.ts a thin client (input → predict → render → replay events). NO server yet, NO behavior change: after Stage A the game plays byte-for-byte identically in solo. This is a behavior-preserving refactor guarded by a golden-master oracle. Grounded in the REAL game.ts (I inventoried every state field + all ~104 FX call sites with line numbers below).

## The audit result that shapes this (from reading the real files)
- **Already-pure modules (ZERO browser refs, move as-is):** enemies.ts, pathfind.ts, dungeon.ts, rng.ts, anim.ts, items.ts, weapons.ts, types.ts, biomes.ts. These MOVE into src/sim/ unchanged (just fix import paths). anim.ts is pure but is COSMETIC — see note in §1.
- **game.ts state cleanly self-classifies** (I pulled the field list): SIM state (px/py/pr/hp/maxHp/mods/invuln/dash*/fireCd/facing/weapon/aimAngle/shotSeq/isDown/enemies/bullets/pickups/props/chests/dungeon/floor/seed/kills/coins/combo/comboTimer/flow*) vs CLIENT-ONLY state (particles/dmgNumbers/corpses/decals/afterimages/muzzle/cam/trauma/kickX/kickY/hurtFlash/playerAnim/remote*/keys/mouse/ctx/canvas/sprites/hud/minimap). The split is clean — almost no field is ambiguous.
- **The coupling to sever is exactly the FX calls** — every one is inventoried in §3. Sever them → the sim methods become pure.

===============================================================
# 1. EXACT MODULE MOVES
===============================================================
## Move as-is into src/sim/ (fix import paths only)
```
src/game/rng.ts      → src/sim/rng.ts        (pure; the deterministic RNG — critical, keep the exact algorithm)
src/game/types.ts    → src/sim/types.ts      (all the data interfaces; game.ts re-exports for render code)
src/game/dungeon.ts  → src/sim/dungeon.ts    (generateDungeon — pure)
src/game/enemies.ts  → src/sim/enemies.ts    (createEnemy, spawnFloorEnemies, ENEMY_ARCHETYPES, AI helpers — pure)
src/game/pathfind.ts → src/sim/pathfind.ts   (FlowField — pure)
src/game/items.ts    → src/sim/items.ts      (PlayerMods, ITEMS, createMods, rollItemChoices — pure)
src/game/weapons.ts  → src/sim/weapons.ts    (WEAPONS, fire(), ShotSpec — pure)
src/game/biomes.ts   → src/sim/biomes.ts     (biomeForFloor etc — pure data)
```
## anim.ts — SPECIAL CASE (pure but cosmetic)
anim.ts (createAnim/stepAnim/triggerFlash/triggerRecoil) is pure TS but it's PRESENTATION (squash/bob/flash). The SIM does not need it. Keep anim.ts CLIENT-SIDE (src/game/ or src/client/). The sim's enemy/player structs must NOT carry an `anim` field. → This is the one type change: split the current `Enemy`/player structs into a sim struct (no anim) + the client attaches anim in a parallel map keyed by entity id. (See §2 note.) Rationale: anim is driven by render, and putting it in WorldState would pollute the golden-master comparison with cosmetic noise.

## New files
```
src/sim/world.ts      — WorldState type + stepWorld() + all extracted sim methods (§2)
src/sim/events.ts     — the SimEvent union (§3)
src/sim/input.ts      — InputCmd type (§2)
src/client/transport.ts — Transport interface + LocalTransport (§4)
src/client/fx.ts      — the event→FX handler (§3) [or keep in game.ts initially]
```
## What STAYS in game.ts (becomes the thin client)
All render* / draw* methods, spawnParticles/spawnPuff/spawnGibs/spawnSparks/spawnShell/spawnDmgNumber/addDecal (the FX BODIES — the event handler calls these), addTrauma/addFreeze/hurtFlash/kick, camera, bindInput, the raf loop, hud/minimap, audio, anim stepping, remote-player render. game.ts imports src/sim and drives it.

===============================================================
# 2. WorldState + stepWorld
===============================================================
## WorldState (plain data, serializable, no methods, no browser types)
```ts
// src/sim/world.ts
export interface PlayerSim {
  id: PlayerId;              // string; local player + (later) remotes all live here
  x: number; y: number; pr: number;
  hp: number; maxHp: number;
  mods: PlayerMods;          // from items.ts
  invuln: number;
  dashCd: number; dashTime: number; dashDx: number; dashDy: number;
  fireCd: number;
  facing: number; aimAngle: number; weapon: WeaponId;
  shotSeq: number; isDown: boolean;
  kills: number; coins: number; combo: number; comboTimer: number;
  ownedItemIds: string[];    // ids into ITEMS (not the ItemDef objects — keep it plain-data)
}
export interface WorldState {
  tick: number;
  seed: number; floor: number;
  players: Map<PlayerId, PlayerSim>;   // Stage A: exactly one entry (the local player)
  enemies: EnemySim[];                 // Enemy struct MINUS anim (see §1)
  bullets: Bullet[];
  props: Prop[]; pickups: Pickup[]; chests: Chest[];
  dungeon: Dungeon;
  flow: FlowFieldState;                // pathfind state (plain data)
}
```
NOTE — the `this.px/py` → players-map change: today game.ts holds a single implicit player (this.px, this.py, this.hp, this.weapon...). Extract those fields into a PlayerSim and store it in `players` under the local id. Every sim method that read `this.px` now reads `player.x` for the player it's stepping. This is the single biggest mechanical edit; it's what makes the sim N-player from day one (Stage A still runs one, but the shape is multiplayer-ready). Do it with a codemod-style pass: `this.px`→`p.x`, `this.py`→`p.y`, `this.hp`→`p.hp`, etc., inside the moved sim methods, threading `p` (the current player) as a param.

## stepWorld signature
```ts
// Pure: same (state, inputs, dt, seed-derived rng) → same (mutated state, events). No Date.now,
// no Math.random in prediction-relevant paths (see determinism note), no I/O.
export function stepWorld(state: WorldState, inputs: Map<PlayerId, InputCmd>, dt: number): SimEvent[];
```
It is today's `update(dt)` reorganized: for each player apply its InputCmd (updatePlayer/updateShooting/dash logic reading inputs.get(pid) instead of this.keys/mouse), then updateBullets, updateEnemies (AI/attacks/collision — already remote-aware via the players map), updatePickups, prop/chest/status updates. Every FX call inside becomes `events.push(...)` (§3). Returns the event list for the client to replay.

## InputCmd
```ts
// src/sim/input.ts
export interface InputCmd {
  seq: number;               // client input sequence (reconciliation later; unused in solo)
  moveX: number; moveY: number; // -1..1 (game.ts already derives ix/iy from keys — feed those)
  aim: number;               // radians (from mouse→world angle, computed client-side)
  firing: boolean;           // mouse.isDown or autofire state (client resolves autofire → firing)
  dash: boolean;             // shift edge (client resolves the key-edge → a one-tick dash intent)
}
```
The client builds one InputCmd per tick from keys/mouse/settings (the autofire + dash-edge resolution stays client-side; the sim just sees `firing`/`dash` booleans). updatePlayer's `ix/iy` become moveX/moveY; updateShooting's `isFiring` becomes `input.firing`; the dash branch reads `input.dash`.

## Determinism note (must hold for later prediction + golden-master now)
- Thread the seeded Rng (rng.ts) through stepWorld for ANY sim randomness that must be reproducible: createEnemy's `zig`, fire()'s pellet jitter, dropLoot rolls, spawn placement. Today several use Math.random() — for golden-master determinism, route them through a per-world seeded Rng advanced deterministically each tick. (This is REQUIRED for the oracle in §5 to be reproducible, and it's the same change that later lets clients predict without divergence.)
- No Date.now()/performance.now() inside stepWorld — time is the passed `dt` + `state.tick`. (game.ts keeps wall-clock for cosmetic anim only.)

===============================================================
# 3. THE SimEvent ENUM + EXHAUSTIVE FX CALL-SITE MAPPING
===============================================================
Principle: the sim EMITS what happened (data only); the client replays each event into the EXISTING FX body (spawnParticles/sfx/addTrauma/etc — those functions do NOT move, they stay in game.ts and get called by the event handler instead of inline). So the juice is byte-identical; only the trigger path changes. Two important realities from the audit:
- Some call sites are ALREADY gated by `isNearCamera(x,y)` (e.g. sfx at 1724/1898/2300, addTrauma at 1472). That gate is a CLIENT concern (is it on my screen) → it moves to the client event handler, NOT the sim. The sim emits the event unconditionally; the client decides whether to play it based on camera. Keep that behavior.
- A few "FX" calls also mutate SIM state and must be split: `triggerFlash(e.anim)` is cosmetic (→ event) BUT sits next to real hp changes (stay in sim). `spawnDmgNumber` is purely visual (→ event). `this.hp++` on lifesteal/heart is SIM (stays). Read each mapping below carefully — the rule is: state mutation stays in sim, the visual/audio spawn becomes an event.

## The SimEvent union (src/sim/events.ts)
```ts
export type SimEvent =
  // combat
  | { t:"shot"; pid:PlayerId; weapon:WeaponId; x:number; y:number; aim:number }   // muzzle+shell+sfx+recoil+trauma+kick
  | { t:"meleeSwing"; pid:PlayerId; x:number; y:number; aim:number; weapon:WeaponId }
  | { t:"enemyHit"; x:number; y:number; color:string; crit:boolean; dmg:number; melee:boolean } // puff+dmgNumber+sfx+flash+(shotgun freeze)
  | { t:"enemyFlash"; eid:number }                                              // triggerFlash only (no puff), e.g. thorns/chain/boss
  | { t:"enemyKill"; kind:EnemyKind; x:number; y:number; big:boolean; comboRate:number } // gibs+particles+decal+sfx+freeze+trauma
  | { t:"burnTick"; x:number; y:number; dmg:number }                            // dmgNumber (orange)
  | { t:"shockArc"; x:number; y:number; tx:number; ty:number; dmg:number; color:string } // dmgNumber+puff on target
  | { t:"lungeTrail"; x:number; y:number }                                      // 1-particle skeleton lunge trail
  // player
  | { t:"dashStart"; pid:PlayerId; x:number; y:number }                         // sfx("dash")+takeoff puff(10)
  | { t:"dashTrail"; pid:PlayerId; x:number; y:number }                         // 1-particle dash trail + afterimage
  | { t:"playerHurt"; pid:PlayerId; x:number; y:number }                        // sfx+hurtFlash=1+flash+freeze+trauma+particles(10)
  | { t:"itemPicked"; pid:PlayerId; x:number; y:number; tint:string }           // particles(20,tint)+sfx("weapon")+trauma
  // pickups
  | { t:"pickup"; pid:PlayerId; kind:PickupKind; x:number; y:number; weapon?:WeaponId } // per-kind particles+sfx (coin/heart/weapon)
  // enemies / boss
  | { t:"bossSpawn"; x:number; y:number }                                       // sfx("bossSpawn")+trauma
  | { t:"bossSlam"; x:number; y:number; r:number }                             // particles+sparks+decal+freeze+trauma(+near-cam sfx)
  | { t:"bossAddSpawn"; x:number; y:number }                                    // particles(a855f7)
  | { t:"enemySpawnPop"; eid:number; x:number; y:number }                       // triggerRecoil(anim)+near-cam sfx+trauma
  | { t:"radialBurst"; x:number; y:number }                                     // particles(c98bff)
  | { t:"spitMuzzle"; x:number; y:number }                                      // puff(ff5a7a)
  // world / props
  | { t:"bulletWall"; x:number; y:number; aim:number }                          // sparks(5)
  | { t:"bulletExpire"; x:number; y:number; color:string }                      // puff(6) enemy-bullet-vs-player etc
  | { t:"propHit"; kind:PropKind; x:number; y:number }                          // puff + flash
  | { t:"propBreak"; kind:PropKind; x:number; y:number }                        // gibs+puff per kind (crate/pot/barrel...)
  | { t:"explosion"; x:number; y:number; r:number }                            // gibs+sparks+particles+decal+freeze+trauma; per-enemy puff
  | { t:"chestOpen"; kind:string; x:number; y:number }                          // sfx("chest")+particles+decal+trauma
  // flow / run
  | { t:"descend"; toFloor:number }                                            // sfx("descend")+trauma
  | { t:"heal"; pid:PlayerId; x:number; y:number }                             // particles(ff6a9d) lifesteal glow (hp change is SIM)
  | { t:"gameOver"; pid:PlayerId };                                            // sfx("gameOver") (state → run end handled by client)
```
(Remote-player FX at 2280/2297/2300/2314/2315/2332 — revive/remote-shot/remote-hurt — are CLIENT-ONLY today, driven by presence, NOT by local sim. They do NOT become SimEvents in Stage A; they stay exactly as-is in the client's remote-anim code. Only the LOCAL sim's FX become events. Flagging so the agent doesn't wrongly route them.)

## EXHAUSTIVE call-site → event map (every line from the audit)
Format: game.ts line(s) → SimEvent (client handler replays the SAME FX body). "SIM-KEEP" marks state mutations that stay inside stepWorld.

- L630 `sfx("bossSpawn")+addTrauma` → **bossSpawn** (emitted from loadFloor's boss branch).
- L857 spawnDmgNumber, L858 spawnPuff, L870 sfx(enemyHit/meleeHit), L856 triggerFlash, L862-863 shotgun freeze, L866-867 melee trauma/freeze → **enemyHit** (carries crit/dmg/melee; handler does dmgNumber+puff+sfx+flash and, if melee/shotgun, the freeze+trauma). SIM-KEEP: `e.hp -= dmg`, `e.hp<=0 → killEnemy`.
- L939 spawnParticles takeoff, L940 sfx("dash") → **dashStart**. L946 spawnParticles(1)+afterimage, L1030? → **dashTrail**. SIM-KEEP: dash kinematics (dashTime/dashDx/dashCd, invuln).
- L979 triggerRecoil, L981 muzzle particles, L982 spawnShell, L983 sfx(SHOOT), L984 addTrauma, L986-987 kick → **shot** (handler does muzzle+shell+recoil+sfx+trauma+kick). SIM-KEEP: fireCd reset, bullets.push(fire(...)), shotSeq++.
- L1018-1024 (melee variant: recoil+trauma+kick) + startMeleeSwing → **meleeSwing**. SIM-KEEP: meleeSwing hit resolution (the actual enemy strikes go through strikeEnemy → enemyHit events).
- L1120 sfx("weapon"), L1121 spawnParticles(item.tint), L1122 addTrauma → **itemPicked**. SIM-KEEP: item.apply(mods), ownedItemIds.push, maxHp recompute.
- L1161 bullet-wall sparks → **bulletWall**. L1168 enemy-bullet puff → **bulletExpire**. L1212 sparks → **bulletWall** (ricochet bounce spark). SIM-KEEP: bullet life/bounce/pos.
- L1332 burn dmgNumber → **burnTick**. SIM-KEEP: `e.hp -= burnDmg*tick`, death check.
- L1399 addTrauma, L1407 triggerFlash, L1408 dmgNumber, L1409 puff (thorns) → **enemyHit** (or a lean **enemyFlash**+dmgNumber; reuse enemyHit with melee=false). SIM-KEEP: thorns `e.hp -=`.
- L1444 triggerFlash, L1445 dmgNumber, L1446 puff (shock chain/arc) → **shockArc**. SIM-KEEP: chain target hp.
- L1472 near-cam addTrauma, L1480 lunge puff → **lungeTrail** (+ trauma folded in, near-cam gated client-side).
- L1584 spit puff → **spitMuzzle**. SIM-KEEP: enemy bullet spawn.
- L1612 triggerFlash, L1614 addTrauma (boss) → **enemyHit**/**enemyFlash**. L1679-1684 boss slam (freeze+trauma+particles+sparks+decal) → **bossSlam**. L1702-1703 addTrauma+particles → **radialBurst**. L1717 triggerRecoil + L1723 particles + L1724 near-cam sfx+trauma (add spawn) → **bossAddSpawn** / **enemySpawnPop**. SIM-KEEP: all boss state machine + hp.
- L1898 `if(isNearCamera) sfx(name)` — this is the spawnParticles helper's OWN near-cam sfx; becomes part of each event's handler (client near-cam gate). SIM emits the event; client gates.
- L1910-1912 gibs+particles+decal, L1922-1925 sfx+freeze+trauma (killEnemy) → **enemyKill** (carries kind/big/comboRate; handler replays all of it). L1930 lifesteal particles + L1931 sfx("heart") → **heal**. SIM-KEEP: kills++, dead=true, dropLoot, `hp++` lifesteal.
- L1951-1952 decal+puff (a generic small burst helper) → fold into whichever caller emits (likely **enemyHit**/**explosion**).
- L1970 coin (particles+sfx+`coins+=`), L1972 heart (particles+sfx+`hp++`), L1974 weapon (particles+sfx+`weapon=`) → **pickup** (carries kind+weapon). SIM-KEEP: coins/hp/weapon mutations.
- L2000 prop puff, L2026-2027/2033-2034/2039-2040 prop-break gibs/puff → **propHit** (2000) + **propBreak** (per-kind). SIM-KEEP: prop.dead/hp.
- L2056-2061 explosion (freeze+trauma+gibs+sparks+particles+decal), L2066-2067 per-enemy flash+puff → **explosion** (handler does the AoE FX; per-enemy hits emit **enemyHit**). SIM-KEEP: AoE damage application.
- L2102-2105 chest (sfx+particles+decal+trauma) → **chestOpen**. SIM-KEEP: chest.opened, loot spawn.
- L2233-2234 sfx("descend")+trauma → **descend**. SIM-KEEP: floor change, reload.
- L2244-2249 playerHurt (flash+sfx+freeze+trauma+hurtFlash=1) + L2245 particles → **playerHurt**. SIM-KEEP: `hp -=`, invuln set, isDown/gameOver check.
- L2413 sfx("gameOver") → **gameOver**. SIM-KEEP: run-end state (client calls onGameOver).
- L3664 spawnParticles (sandbox/dev enemy spawn) → **enemySpawnPop** (dev-only path; keep behind the sandbox flag).

Count reconciliation: this collapses the ~104 inline calls into ~28 event types (many call sites share an event, e.g. every weapon's shot → one `shot` event; every enemy death → one `enemyKill`). Fewer events than call sites is correct and good — the event is semantic, the handler reproduces the full FX cluster.

## The client event handler (src/client/fx.ts or a method in game.ts)
```ts
handleSimEvents(events: SimEvent[]) {
  for (const e of events) switch (e.t) {
    case "shot":     this.muzzleFlash(e); this.spawnShell(...); triggerRecoil(this.playerAnim, FIRE_RECOIL[e.weapon]);
                     if (this.isNearCamera(e.x,e.y)) sfx(SHOOT_SFX[e.weapon]); this.addTrauma(FIRE_TRAUMA[e.weapon]); this.applyKick(e); break;
    case "enemyHit": this.spawnDmgNumber(e.x,e.y,e.dmg,{crit:e.crit}); this.spawnPuff(e.x,e.y, e.crit?9:5, e.color);
                     if (this.isNearCamera(e.x,e.y)) sfx(e.melee?"meleeHit":"enemyHit"); /* + shotgun/melee freeze */ break;
    case "enemyKill":this.spawnGibs(...); this.spawnParticles(...); this.addDecal(...); if(nearCam) sfx("enemyDeath",...);
                     this.addFreeze(e.big?FREEZE_HEAVY:FREEZE_KILL); this.addTrauma(...); break;
    // ... one case per SimEvent, each calling the EXACT existing FX bodies (which stay in game.ts)
  }
}
```
The bodies are literally the current code, moved from inline into the case. `enemyHit` needs the enemy id or position for the flash — carry `eid` where a specific enemy anim must flash (client looks up its anim by id). Keep the near-camera gate in the handler.

## anim flash reconciliation
`triggerFlash(e.anim)` currently mutates the enemy's anim in the sim loop. Since anim moves client-side (§1), the sim emits `enemyHit`/`enemyFlash` with the enemy id; the client's handler does `triggerFlash(this.animFor(eid))`. Same for player recoil (shot event → triggerRecoil(playerAnim)) and enemySpawnPop (triggerRecoil).

===============================================================
# 4. TRANSPORT INTERFACE + LocalTransport (solo = in-process, unchanged)
===============================================================
The client never calls stepWorld directly — it goes through a Transport, so solo (in-process sim) and multiplayer (WS to server, later) are the SAME client code path. Stage A ships ONLY LocalTransport.
```ts
// src/client/transport.ts
export interface Transport {
  // Client pushes its input for the tick.
  sendInput(cmd: InputCmd): void;
  // Client pulls the latest authoritative-ish snapshot to render + the events since last pull.
  // In solo this is the freshly-stepped local WorldState (always "correct"); later, the WS snapshot.
  poll(): { state: WorldState; events: SimEvent[]; ackSeq: number };
  start(seed: number, floor: number): void;
  stop(): void;
}

// SOLO: runs stepWorld in-process every tick. No serialization, no sockets, no latency, no
// reconciliation (the local sim IS the authority). Byte-for-byte the current game.
export class LocalTransport implements Transport {
  private state: WorldState;
  private pending: InputCmd | null = null;
  private events: SimEvent[] = [];
  private acc = 0; private readonly STEP = 1/60; // solo can step at the render dt or a fixed step
  start(seed, floor) { this.state = createWorld(seed, floor); /* seeds enemies via spawnFloorEnemies */ }
  sendInput(cmd) { this.pending = cmd; }
  // Called from the client's raf loop with real dt; steps the sim and buffers events.
  advance(dt: number) {
    const inputs = new Map([[LOCAL_ID, this.pending ?? IDLE_INPUT]]);
    this.events.push(...stepWorld(this.state, inputs, dt));
  }
  poll() { const ev = this.events; this.events = []; return { state: this.state, events: ev, ackSeq: this.pending?.seq ?? 0 }; }
  stop() {}
}
```
- **Solo step cadence:** solo can call stepWorld with the real frame dt (matches today's variable-dt update) OR a fixed 60Hz accumulator. To keep golden-master reproducible, prefer a FIXED step (accumulate real dt, step in fixed 1/60 chunks) — this also future-proofs for the server's fixed tick. If matching today's exact feel is paramount, keep variable dt for solo and note it; but fixed-step is the cleaner choice and the oracle should be captured at fixed step.
- **game.ts wiring:** the raf loop becomes: build InputCmd from keys/mouse → transport.sendInput → transport.advance(dt) (LocalTransport) → { state, events } = transport.poll() → this.renderFrom(state) + this.handleSimEvents(events). Rendering reads from `state` (enemies/bullets/players/props) instead of `this.enemies` etc. Camera follows `state.players.get(LOCAL_ID)`.
- **Guarantee:** solo runs the identical stepWorld that the server will later run, with zero network in the graph — so solo can't regress vs multiplayer and needs no Convex/WS. Mirrors how CoopBridge already abstracts co-op; same discipline, one seam.
- **StartOptions/main.ts:** solo binds `new LocalTransport()`; nothing else changes in main.ts yet (WSTransport arrives at Stage B). The onGameOver/onExit callbacks fire from the client on the `gameOver` event / run-end state.

===============================================================
# 5. GOLDEN-MASTER TEST PLAN (the safety net for touching 3759-line game.ts)
===============================================================
Goal: prove the extracted sim reproduces the CURRENT game's behavior exactly, so the refactor is verifiably behavior-preserving. Because stepWorld is deterministic (seeded rng, fixed dt, scripted input), the same inputs must yield the same state + event stream every run and across the refactor.

## 5a. Make the CURRENT game capture an oracle (do BEFORE moving code)
- Add a temporary "record mode" to the CURRENT game.ts: run the existing update loop with (a) a FIXED seed, (b) a FIXED dt (e.g. 1/60), (c) a SCRIPTED input sequence (a hardcoded array of per-tick {moveX,moveY,aim,firing,dash}) instead of live keys/mouse, and (d) Math.random replaced by a seeded Rng (the same determinism change §2 requires). 
- Each tick, serialize a CANONICAL sim snapshot: player (x,y,hp,fireCd,dashCd,invuln,weapon,kills,coins,combo), enemies (id,kind,x,y,hp + attack phase/move/cooldown), bullets (x,y,vx,vy,life,pierce,bounce), pickups/props/chests (kind,x,y,dead/opened), plus the ordered list of FX calls that fired that tick (log each sfx/spawnParticles/addTrauma call as a tagged record — this becomes the event-stream oracle). Round floats to a fixed precision (e.g. 1e-4) to avoid FP noise.
- Run several SCENARIOS (scripted input files), each ~30-60s of ticks, seeds fixed:
  1. Movement + dash around an empty-ish floor.
  2. Full combat: approach enemies, fire each weapon type, get hits/kills, take damage, melee.
  3. Boss floor: trigger the boss, its 3 phases, slam/radial/adds.
  4. Items: pick blessings, verify mod-affected shots (pellets/crit/pierce/pierce+bounce).
  5. Props + explosion chain + chest open + pickups (coin/heart/weapon).
  6. Status effects (burn/chill/shock) + combo meter ramp + lifesteal.
- Dump each scenario's per-tick (state snapshot + FX record) to a golden file: `test/golden/<scenario>.jsonl`. THIS IS THE ORACLE. Capture it from the CURRENT code before extraction so it encodes today's exact behavior.

## 5b. Assert the REFACTORED sim reproduces the oracle
- A node test harness loads each scenario's scripted input + seed, runs the NEW stepWorld tick-by-tick, and produces the SAME canonical (state snapshot + emitted SimEvent list) per tick.
- Map SimEvents → the oracle's FX-call records (e.g. a `shot` event must correspond to the muzzle/shell/sfx/recoil records the old code logged that tick; an `enemyKill` → the gibs/particles/decal/sfx/freeze records). Assert equality of BOTH the state stream AND the (mapped) event stream, tick for tick, within float tolerance.
- Green = the refactor is behavior-preserving. A diff pinpoints the exact tick + field that diverged → the bug is localized, not "the game feels different."
- Keep these as permanent regression tests: they guard every future sim change (and become the reconciliation-test substrate at Stage C).

## 5c. Determinism CI check
- Run each scenario TWICE in the new sim; assert identical output (catches any residual nondeterminism — an unseeded random, a Map iteration-order dependency, a Date.now leak). Must be bit-stable (within the float rounding).

## 5d. Manual feel A/B (the human oracle)
- Automated golden-master proves logic; also do a side-by-side playtest of pre- and post-extraction builds (same seed) on the scenarios above. If the numbers match but it "feels" different, the difference is in the CLIENT (render/anim/cam/dt handling) not the sim — narrows the search. (This is where a variable-vs-fixed dt choice would show; §4 note.)

===============================================================
# 6. BUILD / VALIDATION CHECKLIST (executable sub-steps, game stays playable)
===============================================================
Do in order; each sub-step compiles + the game runs. Commit per step.
1. **[oracle first]** In current game.ts add record-mode (fixed seed/dt/scripted input, seeded rng) + canonical snapshot+FX logging. Capture `test/golden/*.jsonl` for all 6 scenarios. Game still fully playable (record-mode is opt-in). COMMIT the goldens.
2. **Move the pure modules** (rng/types/dungeon/enemies/pathfind/items/weapons/biomes) into src/sim/, fix imports across the repo. No logic change. Build + play — identical. COMMIT.
3. **Split anim out of the sim structs:** remove `anim` from the sim Enemy/player structs; add a client-side anim map keyed by entity id; update render + the (still-inline) triggerFlash/recoil calls to use it. Build + play. COMMIT.
4. **Introduce WorldState + PlayerSim; move `this.px/py/hp/...` into a PlayerSim in a players Map.** Mechanical rename pass inside the sim methods (this.px→p.x ...). Keep FX calls inline for now (still in game.ts, operating on the WorldState). Build + play — identical. COMMIT. (Biggest edit; do it isolated.)
5. **Extract the sim methods into stepWorld(state,inputs,dt)** in src/sim/world.ts, reading InputCmd instead of keys/mouse. game.ts calls stepWorld each frame with an InputCmd it builds from keys/mouse, then renders from the returned state. FX STILL inline inside stepWorld temporarily (as direct calls back — or a callback) so you can verify the move independent of the event refactor. Build + play. Run golden-master (5b) — expect green on STATE stream. COMMIT.
6. **Convert FX calls to SimEvents** (§3): replace each inline FX call in stepWorld with events.push; implement handleSimEvents in the client replaying the exact bodies. Build + play. Run golden-master on BOTH state + event streams — green. This is the decoupling payoff. COMMIT.
7. **Introduce Transport + LocalTransport**; route solo through it (client loop uses transport.advance/poll). Build + play. Golden-master still green. COMMIT.
8. **Determinism CI (5c) + manual A/B (5d).** Fix any divergence (diff localizes it). 
9. **Delete the temporary record-mode's inline FX logging** (keep record-mode input scripting for tests). Final build + full playtest of all 6 scenarios. COMMIT — Stage A done.
GATE to Stage B: all golden-master scenarios green (state + events), determinism check bit-stable, manual A/B indistinguishable, solo has zero network in its module graph (verify: `src/sim/` imports nothing from canvas/DOM/audio/net; grep for canvas|document|window|sfx|ConvexClient in src/sim → empty).

## Risk callouts specific to Stage A
- The `this.px→players-map` pass (step 4) is the highest-churn edit — do it ALONE, behind golden-master. Don't combine with the event refactor.
- Determinism: the Math.random→seeded-rng change (needed for the oracle) subtly changes outcomes vs the CURRENT live game (different random sequence). Handle by capturing the oracle AFTER switching current-game to seeded rng (so oracle and refactor share the same rng model) — i.e. do the rng change as part of step 1, verify it feels the same, then capture goldens. Otherwise goldens encode Math.random noise you can't reproduce.
- Keep melee/content branches (shipping in parallel) rebasing onto src/sim/ after step 5 lands, or they'll conflict with the big rename. Coordinate the merge point.

## BOTTOM LINE
Stage A is a mechanical, staged, test-guarded refactor — no new gameplay, no network, no visible change. The audit makes it tractable: 9 pure modules move as-is, the sim/client state split is clean, the ~104 FX calls collapse to ~28 semantic SimEvents whose handlers reuse the existing FX bodies verbatim, and the golden-master oracle (captured from today's game) proves behavior-equivalence tick-for-tick. Solo runs the extracted sim in-process via LocalTransport, byte-for-byte unchanged. Execute the 9-step checklist committing per step; the gate is all-green goldens + a pure src/sim/ graph. Ship it, then Stage B bolts a server onto the same stepWorld.
