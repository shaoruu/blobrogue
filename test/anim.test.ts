// Cosmetic anim regression suite. Locks the fix for the "stuck white hit flash" bug (Ian:
// "i hit something with a bullet and it just turns white. never goes away"). Root cause was
// that after the Stage A sim extraction, client-owned entity Anim maps stopped being stepped,
// so `flash` was set to 1 by a hit and never decayed. These assert the decay contract directly.
//
// Run: npx tsx test/anim.test.ts
import { createAnim, stepAnim, triggerFlash, resetAnim } from "../src/game/anim.js";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// 1) A triggered flash decays to exactly 0 within a bounded time when stepped (the bug: it never did).
{
  const a = createAnim();
  triggerFlash(a);
  check("flash starts at 1 on hit", a.flash === 1);
  // step at 60fps; decay rate is dt*7, so from 1 it must reach 0 within ~1/7s ≈ 0.15s.
  let t = 0;
  for (let i = 0; i < 30 && a.flash > 0; i++) { stepAnim(a, 1 / 60, false, 0); t += 1 / 60; }
  check("flash decays to 0 when stepped (no permanent white)", a.flash === 0, `cleared in ${t.toFixed(3)}s`);
  check("flash cleared within 0.2s", t <= 0.2);
}

// 2) Flash never goes negative and stays clamped at 0 once decayed.
{
  const a = createAnim();
  triggerFlash(a);
  for (let i = 0; i < 100; i++) stepAnim(a, 1 / 60, false, 0);
  check("flash clamps at 0 (never negative)", a.flash === 0);
}

// 3) A large dt (e.g. a stall/tab-refocus) still fully clears the flash, never leaves it pinned.
{
  const a = createAnim();
  triggerFlash(a);
  stepAnim(a, 1.0, false, 0); // one huge step
  check("flash clears on a large dt step (no pin after a stall)", a.flash === 0);
}

// 4) Re-triggering re-flashes and then decays again (repeated hits behave, don't accumulate stuck state).
{
  const a = createAnim();
  triggerFlash(a);
  for (let i = 0; i < 20; i++) stepAnim(a, 1 / 60, false, 0);
  check("first flash cleared", a.flash === 0);
  triggerFlash(a);
  check("re-flash sets back to 1", a.flash === 1);
  for (let i = 0; i < 20; i++) stepAnim(a, 1 / 60, false, 0);
  check("second flash also clears", a.flash === 0);
}

// 5) resetAnim clears a pinned flash (entity reuse / pooling can't carry a stale white pop).
{
  const a = createAnim();
  triggerFlash(a);
  resetAnim(a);
  check("resetAnim clears flash (no stale flash on entity reuse)", a.flash === 0);
}

console.log(`\n${pass} checks passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log("Cosmetic anim (hit-flash decay) regressions hold.");
