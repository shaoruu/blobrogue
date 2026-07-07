import { ConvexHttpClient } from "convex/browser";
import type { ConvexClient } from "convex/browser";
import { api } from "./api.js";

// Vanilla Convex Auth client.
//
// @convex-dev/auth ships only React bindings (ConvexAuthProvider / useAuthActions),
// but its actual protocol is framework-agnostic: a couple of Convex actions plus
// localStorage token bookkeeping. blobrogue is a vanilla-TS canvas game, so this
// class reimplements exactly what the React provider does, against the same action
// references and the same storage keys/namespace (so a future React migration would
// interoperate seamlessly):
//   - signIn("google")           -> action "auth:signIn" returns an OAuth { redirect }
//   - browser redirects to Google, then back to us with `?code=...`
//   - on boot we exchange the code -> { tokens } (JWT + refresh token), stored locally
//   - client.setAuth(fetchToken) attaches the JWT to every Convex call, refreshing
//     via the refresh token when the server rejects a stale JWT.
//
// It is defensive by construction: if the auth backend isn't deployed yet, sign-in
// simply throws (caught by the caller) and the rest of the game keeps working.

const JWT_KEY = "__convexAuthJWT";
const REFRESH_KEY = "__convexAuthRefreshToken";
const VERIFIER_KEY = "__convexAuthOAuthVerifier";

type Tokens = { token: string; refreshToken: string };

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}
function safeRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* private mode */ }
}

export class AuthClient {
  private client: ConvexClient;
  private http: ConvexHttpClient;
  private namespace: string;
  private token: string | null = null;
  private listeners = new Set<() => void>();

  constructor(client: ConvexClient, convexUrl: string) {
    this.client = client;
    // A separate, unauthenticated client for the code-exchange and token-refresh
    // calls — mirrors the React provider, and avoids re-entering our own fetchToken.
    this.http = new ConvexHttpClient(convexUrl);
    this.namespace = convexUrl.replace(/[^a-zA-Z0-9]/g, "");
  }

  get isSignedIn(): boolean {
    return this.token !== null;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  private key(name: string): string {
    return `${name}_${this.namespace}`;
  }

  private setTokens(tokens: Tokens | null): void {
    if (tokens === null) {
      this.token = null;
      safeRemove(this.key(JWT_KEY));
      safeRemove(this.key(REFRESH_KEY));
    } else {
      this.token = tokens.token;
      safeSet(this.key(JWT_KEY), tokens.token);
      safeSet(this.key(REFRESH_KEY), tokens.refreshToken);
    }
    this.notify();
  }

  private fetchToken = async ({ forceRefreshToken }: { forceRefreshToken: boolean }): Promise<string | null> => {
    if (!forceRefreshToken) return this.token;
    const refreshToken = safeGet(this.key(REFRESH_KEY));
    if (!refreshToken) {
      this.setTokens(null);
      return null;
    }
    try {
      const res = await this.http.action(api.auth.signIn, { refreshToken });
      if (res.tokens) {
        this.setTokens(res.tokens);
        return res.tokens.token;
      }
      this.setTokens(null);
      return null;
    } catch {
      // A transient failure shouldn't destroy the session; keep the current token.
      return this.token;
    }
  };

  private onAuthConfirmed = (): void => {
    this.notify();
  };

  private wireClientAuth(): void {
    this.client.setAuth(this.fetchToken, this.onAuthConfirmed);
  }

  // Call once on boot. Completes any pending OAuth redirect (consuming `?code=`),
  // restores a stored session, and attaches auth to the live Convex client.
  async init(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (code) {
      this.stripCodeFromUrl();
      const verifier = safeGet(this.key(VERIFIER_KEY)) ?? undefined;
      safeRemove(this.key(VERIFIER_KEY));
      try {
        const res = await this.http.action(api.auth.signIn, { params: { code }, verifier });
        if (res.tokens) this.setTokens(res.tokens);
      } catch (err) {
        console.warn("[auth] could not complete Google sign-in", err);
      }
    } else {
      this.token = safeGet(this.key(JWT_KEY));
    }
    this.wireClientAuth();
    this.notify();
  }

  private stripCodeFromUrl(): void {
    const url = new URL(window.location.href);
    url.searchParams.delete("code");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  }

  // Kick off Google OAuth. Redirects the whole page to Google; control returns via
  // the `?code=` handled in init(). Throws if the auth backend isn't deployed yet.
  async signInWithGoogle(): Promise<void> {
    const verifier = safeGet(this.key(VERIFIER_KEY)) ?? undefined;
    safeRemove(this.key(VERIFIER_KEY));
    const res = await this.client.action(api.auth.signIn, { provider: "google", params: {}, verifier });
    if (res.redirect) {
      if (res.verifier) safeSet(this.key(VERIFIER_KEY), res.verifier);
      window.location.href = res.redirect;
      return;
    }
    if (res.tokens) this.setTokens(res.tokens);
  }

  async signOut(): Promise<void> {
    try {
      await this.client.action(api.auth.signOut, {});
    } catch {
      // Usually just means we were already signed out — fine.
    }
    this.setTokens(null);
    // Re-arm the fetcher so the live client drops its cached auth immediately.
    this.wireClientAuth();
  }
}
