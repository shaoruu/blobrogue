// Remote interpolation suite: the classic lerp contract for ordinary movement, and the v9
// dash special case — a keyframe recorded mid-dash marks dash MOVEMENT, and its segment is
// rendered as a snap to the keyframe (a crisp fast move aligned with the dash FX) instead of
// the render-delayed linear glide that smeared the blink. Ordinary segments before and after
// a dash are untouched (no rubber-banding), and a dash is never extrapolated past its newest
// keyframe (no overshoot into walls).
//
// Run: npm run test:interp

import { RemoteInterp, RENDER_DELAY_MS } from "../src/net/interp.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

const SNAP_MS = 50; // the authoritative 20Hz snapshot cadence

// Feed a run of samples at the fixed cadence starting at t0; sample i arrives at t0 + i*50.
interface Key { x: number; y: number; aim?: number; dash?: boolean }
function feed(interp: RemoteInterp, id: string, t0: number, keys: Key[]): void {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    interp.ingest(id, i + 1, k.x, k.y, k.aim ?? 0, t0 + i * SNAP_MS, k.dash ?? false);
  }
}

function ordinaryMotionTests(): void {
  section("ordinary movement: the classic delayed lerp is unchanged");
  const interp = new RemoteInterp();
  const t0 = 10_000;
  feed(interp, "p", t0, [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 },
  ]);
  // Render clock = now - delay; aim it at the exact midpoint of the second segment.
  const mid = interp.sample("p", t0 + SNAP_MS * 1.5 + RENDER_DELAY_MS)!;
  check("midpoint of a walk segment lerps halfway", Math.abs(mid.x - 15) < 1e-9, `x=${mid.x}`);
  check("a walk segment never reads as dashing", mid.isDashing === false);
  const q = interp.sample("p", t0 + SNAP_MS * 2.25 + RENDER_DELAY_MS)!;
  check("quarter point lerps proportionally", Math.abs(q.x - 22.5) < 1e-9, `x=${q.x}`);
}

function dashSegmentTests(): void {
  section("a dash segment renders as a crisp snap to its keyframe, not a smear");
  const interp = new RemoteInterp();
  const t0 = 20_000;
  // Walk, then a 3-keyframe dash burst (~31px per snapshot at 620px/s), then walk again.
  feed(interp, "p", t0, [
    { x: 0, y: 0 },                 // k0 walk
    { x: 5, y: 0 },                 // k1 walk
    { x: 36, y: 0, dash: true },    // k2 dash
    { x: 67, y: 0, dash: true },    // k3 dash
    { x: 98, y: 0, dash: true },    // k4 dash (the blink lands ~99px out)
    { x: 100, y: 0 },               // k5 walk resumes
  ]);
  const at = (frac: number) => interp.sample("p", t0 + SNAP_MS * frac + RENDER_DELAY_MS)!;

  // Anywhere inside a dash segment the pose sits EXACTLY on the segment's end keyframe —
  // the dash reads as fast discrete steps, never a glide that lands late.
  const early = at(1.2), late = at(1.8);
  check("entering the dash segment snaps straight to its keyframe", early.x === 36 && late.x === 36, `x=${early.x},${late.x}`);
  check("the dash segment reports isDashing (drives the observer's dash FX)", early.isDashing && late.isDashing);
  check("the second dash segment steps to ITS keyframe", at(2.5).x === 67 && at(2.5).isDashing);
  check("the third dash segment steps to the dash end", at(3.5).x === 98 && at(3.5).isDashing);

  // A smear would put the pose strictly between keyframes mid-segment; prove the full dash
  // distance is covered by the time the last dash segment is entered — not RENDER_DELAY late.
  check("the full ~99px blink is on screen as soon as the last dash segment starts",
    at(3.05).x === 98, `x=${at(3.05).x}`);

  // The segment OUT of the dash (k4 -> k5, dash=false) lerps normally: no rubber-banding.
  const out = at(4.5);
  check("the post-dash walk segment lerps from the dash end", Math.abs(out.x - 99) < 1e-9 && !out.isDashing, `x=${out.x}`);
}

function dashEdgeTests(): void {
  section("dash edges: no extrapolation overshoot; teleports still snap; enemies unaffected");
  const interp = new RemoteInterp();
  const t0 = 30_000;
  feed(interp, "p", t0, [
    { x: 0, y: 0 }, { x: 31, y: 0, dash: true }, { x: 62, y: 0, dash: true },
  ]);
  // Past the newest keyframe a WALK extrapolates; a dash must hold at its frontier instead
  // (projecting 620px/s forward would overshoot the dash end and rubber-band back).
  const ahead = interp.sample("p", t0 + SNAP_MS * 2 + 100 + RENDER_DELAY_MS)!;
  check("a dash is never extrapolated past its newest keyframe", ahead.x === 62, `x=${ahead.x}`);
  check("the held frontier still reads as dashing", ahead.isDashing === true);

  // Ordinary extrapolation is unchanged for walks.
  const w = new RemoteInterp();
  feed(w, "p", t0, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }]);
  const proj = w.sample("p", t0 + SNAP_MS * 2 + 100 + RENDER_DELAY_MS)!;
  check("a walk still extrapolates briefly past the newest keyframe", proj.x > 20, `x=${proj.x}`);

  // A teleport-sized jump (descend/respawn) still clears history and snaps, dash or not.
  const tp = new RemoteInterp();
  feed(tp, "p", t0, [{ x: 0, y: 0 }, { x: 5, y: 0 }]);
  tp.ingest("p", 3, 2000, 2000, 0, t0 + 2 * SNAP_MS, false);
  const snapped = tp.sample("p", t0 + 2 * SNAP_MS + RENDER_DELAY_MS)!;
  check("a teleport jump still snaps to the new spot", snapped.x === 2000 && snapped.y === 2000);

  // The default ingest (enemies pass no dash flag) never marks a dash.
  const e = new RemoteInterp();
  e.ingest("e1", 1, 0, 0, 0, t0);
  e.ingest("e1", 2, 10, 0, 0, t0 + SNAP_MS);
  const ep = e.sample("e1", t0 + SNAP_MS * 0.5 + RENDER_DELAY_MS)!;
  check("dashless ingest lerps and never reads as dashing", Math.abs(ep.x - 5) < 1e-9 && !ep.isDashing);
}

function main(): void {
  ordinaryMotionTests();
  dashSegmentTests();
  dashEdgeTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll remote interpolation assertions passed.\n");
}

main();
