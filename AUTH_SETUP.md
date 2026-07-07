# Google sign-in setup (Convex Auth) — operator checklist

The code for optional Google sign-in is **already written and build-clean**. What's
left is the parts an agent can't do: pushing the backend and setting secrets on your
Convex deployment. This is the exact, copy-pasteable list. Do it once per deployment
(dev and prod are separate deployments, so repeat for each).

> **Nothing here breaks guest play.** Until you finish these steps the "Sign in with
> Google" button is simply inert (it says "server not configured yet" if clicked).
> Solo + co-op keep working exactly as before.

Everything runs from the repo root, with your Convex account available to the CLI.

---

## 0. Prerequisites

You need a Convex deployment wired up (this also creates `convex/_generated` and writes
`CONVEX_DEPLOYMENT` + `VITE_CONVEX_URL` into `.env.local`):

```bash
npm install
npx convex dev        # first run: creates/links the project. Leave it running, or Ctrl-C after it prints "Convex functions ready".
```

Note your deployment URL — it's the `VITE_CONVEX_URL` value, e.g. `https://acoustic-panda-123.convex.cloud`.

---

## 1. Initialise Convex Auth (generates the JWT keys)

This one command generates the private/public signing keys Convex Auth needs and sets
`JWT_PRIVATE_KEY` + `JWKS` on the deployment for you. It also prompts for `SITE_URL`.

```bash
npx @convex-dev/auth
```

- When it asks for **`SITE_URL`**, enter the URL where the **game itself** is served
  (this is where Google sends the user back after login):
  - local dev: `http://localhost:5173`
  - production: your deployed origin, e.g. `https://blobrogue.vercel.app`

If you ever need to change it later:

```bash
npx convex env set SITE_URL https://blobrogue.vercel.app
```

---

## 2. Set the Google OAuth secrets

Reuse an existing Google OAuth **Web application** client (or create one in Google Cloud
Console → APIs & Services → Credentials). Then:

```bash
npx convex env set AUTH_GOOGLE_ID   YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com
npx convex env set AUTH_GOOGLE_SECRET  YOUR_GOOGLE_CLIENT_SECRET
```

(Do this against each deployment — run with `--prod` for production:
`npx convex env set --prod AUTH_GOOGLE_ID ...`)

---

## 3. Google Cloud Console — the Authorized redirect URI (the easy-to-miss step)

In Google Cloud Console → your OAuth client → **Authorized redirect URIs**, add the URI
below **exactly**. It points at Convex's callback route (the `.convex.site` domain — note
`.site`, **not** `.cloud`):

```
https://<your-deployment>.convex.site/api/auth/callback/google
```

**How to get `<your-deployment>`:** take your `VITE_CONVEX_URL` (from `.env.local` or the
Convex dashboard) and swap `.convex.cloud` → `.convex.site`, then append
`/api/auth/callback/google`.

Worked example — if `VITE_CONVEX_URL = https://acoustic-panda-123.convex.cloud`, paste:

```
https://acoustic-panda-123.convex.site/api/auth/callback/google
```

Add one line per deployment you use (dev + prod have different subdomains). Save in
Google Console. Changes can take a few minutes to propagate on Google's side.

---

## 4. Deploy the backend

```bash
npx convex deploy
```

Make sure the game's frontend is built/served with `VITE_CONVEX_URL` pointing at the same
deployment (see `MULTIPLAYER.md` for the Vercel env var). Then the "Sign in with Google"
button in the menu goes live.

---

## Env var summary (all set on the Convex deployment, never in the repo)

| Variable             | Who sets it                     | Value                                                        |
| -------------------- | ------------------------------- | ----------------------------------------------------------- |
| `JWT_PRIVATE_KEY`    | `npx @convex-dev/auth` (step 1) | auto-generated                                              |
| `JWKS`               | `npx @convex-dev/auth` (step 1) | auto-generated                                              |
| `SITE_URL`           | `npx @convex-dev/auth` (step 1) | the game's origin (redirect target after login)             |
| `AUTH_GOOGLE_ID`     | you (step 2)                    | Google OAuth client ID                                       |
| `AUTH_GOOGLE_SECRET` | you (step 2)                    | Google OAuth client secret                                   |

`CONVEX_SITE_URL` is injected by Convex automatically — you do **not** set it. No secret
is ever committed to the repo.

---

## Quick verification

- [ ] `npx convex deploy` succeeds with no type errors.
- [ ] Menu shows **"Sign in with Google"** in the right-hand column (needs `VITE_CONVEX_URL`).
- [ ] Click it → Google consent screen → you land back on the game, now showing your
      Google name + avatar and a **"sign out"** button (no more name input).
- [ ] Play a run while signed in → the all-time stats panel updates for your account.
- [ ] Sign out → the guest name input returns and solo/co-op still work.
- [ ] If you played as a guest first, then signed in: your existing all-time stats carried
      over to the account (one-time migration of this browser's guest row).

## How it works (for reviewers)

- **Guests are unchanged.** No token → the client keys stats off the localStorage
  `clientId`, exactly as before.
- **Signed in.** The vanilla auth client (`src/net/auth.ts`) performs the OAuth code
  flow against Convex Auth's HTTP routes and attaches the JWT to the live `ConvexClient`.
  Server functions (`convex/players.ts`) then key stats off the authenticated `userId`.
- **Migration is non-destructive.** On first sign-in, an *unowned* guest row for the
  current browser is adopted onto the account; rows owned by someone else are never
  touched, and nothing is deleted.
