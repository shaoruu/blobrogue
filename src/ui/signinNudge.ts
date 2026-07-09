// The contextual sign-in nudge policy: after meaningful guest progress (a recorded run —
// and with extra pull when the run just earned a cosmetic), offer Google sign-in ONCE, with
// a dismissal that sticks. Pure decision logic over an injected key-value store + clock so
// the whole policy is unit-testable; the menu owns the DOM.
//
// Anti-spam contract (the documented cooldown policy):
//   - at most ONE prompt per browser session (the session latch), no matter how many runs,
//     unlocks, or routes trigger the check
//   - merely SEEING the prompt (without dismissing) starts a shown-cooldown
//     (NUDGE_SHOWN_COOLDOWN_MS) so a multi-run day isn't nagged every sitting
//   - "not now" starts the longer dismissal cooldown (NUDGE_COOLDOWN_MS) across sessions
//   - never shown to signed-in players, never when sign-in isn't available, and never a
//     substitute for the ALWAYS-available manual sign-in (home identity card + Profile)

export const NUDGE_DISMISSED_AT_KEY = "blobrogue.signinNudge.dismissedAt";
export const NUDGE_SHOWN_AT_KEY = "blobrogue.signinNudge.shownAt";
export const NUDGE_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;  // after an explicit "not now"
export const NUDGE_SHOWN_COOLDOWN_MS = 12 * 60 * 60 * 1000; // after merely seeing it

export interface NudgeStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface NudgeContext {
  isSignInAvailable: boolean;
  isSignedIn: boolean;
  // Meaningful progress this moment: a run was just recorded / a cosmetic was just earned.
  hasMeaningfulProgress: boolean;
  isShownThisSession: boolean;
}

function storedTime(store: NudgeStore, key: string): number | null {
  try {
    const raw = store.getItem(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function shouldShowSigninNudge(store: NudgeStore, ctx: NudgeContext, now = Date.now()): boolean {
  if (!ctx.isSignInAvailable || ctx.isSignedIn) return false;
  if (!ctx.hasMeaningfulProgress) return false;
  if (ctx.isShownThisSession) return false;
  const dismissed = storedTime(store, NUDGE_DISMISSED_AT_KEY);
  if (dismissed !== null && now - dismissed < NUDGE_COOLDOWN_MS) return false;
  const shown = storedTime(store, NUDGE_SHOWN_AT_KEY);
  if (shown !== null && now - shown < NUDGE_SHOWN_COOLDOWN_MS) return false;
  return true;
}

// Record that the prompt was DISPLAYED (starts the shown-cooldown; call on render).
export function recordNudgeShown(store: NudgeStore, now = Date.now()): void {
  try { store.setItem(NUDGE_SHOWN_AT_KEY, String(now)); } catch { /* private mode */ }
}

export function recordNudgeDismissed(store: NudgeStore, now = Date.now()): void {
  try { store.setItem(NUDGE_DISMISSED_AT_KEY, String(now)); } catch { /* private mode */ }
}

// Benefit copy shared by the title CTA and the post-run nudge, so the pitch stays one voice.
export const SIGNIN_BENEFITS = "save your progress, cosmetics & leaderboard runs — play across devices";
