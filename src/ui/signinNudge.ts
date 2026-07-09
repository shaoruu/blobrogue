// The contextual sign-in nudge policy: after meaningful guest progress (a recorded run —
// and with extra pull when the run just earned a cosmetic), offer Google sign-in ONCE, with
// a dismissal that sticks. Pure decision logic over an injected key-value store + clock so
// the whole policy is unit-testable; the menu owns the DOM.
//
// Anti-spam contract:
//   - at most one nudge per browser session (the session latch)
//   - "not now" starts a persistent cooldown (NUDGE_COOLDOWN_MS) across sessions
//   - never shown to signed-in players, and never when sign-in isn't available

export const NUDGE_DISMISSED_AT_KEY = "blobrogue.signinNudge.dismissedAt";
export const NUDGE_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

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

function dismissedAt(store: NudgeStore): number | null {
  try {
    const raw = store.getItem(NUDGE_DISMISSED_AT_KEY);
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
  const at = dismissedAt(store);
  if (at !== null && now - at < NUDGE_COOLDOWN_MS) return false;
  return true;
}

export function recordNudgeDismissed(store: NudgeStore, now = Date.now()): void {
  try { store.setItem(NUDGE_DISMISSED_AT_KEY, String(now)); } catch { /* private mode */ }
}

// Benefit copy shared by the title CTA and the post-run nudge, so the pitch stays one voice.
export const SIGNIN_BENEFITS = "save your progress, cosmetics & leaderboard runs — play across devices";
