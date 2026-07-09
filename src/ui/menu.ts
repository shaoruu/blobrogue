import type { ConvexClient } from "convex/browser";
import type { Session } from "../net/session.js";
import type { AuthClient } from "../net/auth.js";
import type { ProfileDoc, LeaderboardEntryDoc } from "../net/api.js";
import { api } from "../net/api.js";
import { OnlineLobby } from "../net/onlineLobby.js";
import type { LobbyPlayer } from "../net/onlineLobby.js";
import type { RunResult } from "../game/game.js";
import { playerColor, PLAYER_COLORS } from "../game/assets.js";
import { WEAPONS } from "../sim/weapons.js";
import { itemById } from "../sim/items.js";
import { COSMETIC_SLOTS, cosmeticsForSlot, cosmeticById, isCosmeticOwned, bodyPaletteIndex } from "../game/cosmetics.js";
import type { CosmeticSlot, CosmeticDef, CosmeticLoadout } from "../game/cosmetics.js";
import { cosmeticOverlay } from "../game/cosmeticArt.js";
import { createBlobPreview } from "./blobPreview.js";
import type { BlobLook } from "./blobPreview.js";
import { createSettingsControls } from "./settings.js";
import { shouldShowSigninNudge, recordNudgeDismissed, SIGNIN_BENEFITS } from "./signinNudge.js";
import { READY_LABEL, NOT_READY_LABEL, START_ANYWAY_IDLE, START_ANYWAY_HOLD_MS, startAnywayHoldLabel } from "./onlineCopy.js";

// ONE multiplayer product path: authoritative PLAY ONLINE. The legacy peer-synced classic
// co-op ran a separate simulation per client (different enemies/drops while players believed
// they shared a room — the Sev-0), so the menu deliberately has NO way to start it.
export interface MenuHost {
  startSolo(profile: ProfileDoc | null): void;
  // isPartyStart: the run begins from a lobby START (gate gameplay on the whole party
  // joining the world) vs dropping into an already-live run (no gate).
  startOnline(lobby: OnlineLobby, profile: ProfileDoc | null, isPartyStart: boolean): void;
}

// Context for the game-over screen: which flow the run came from decides the retry action.
export interface GameOverContext {
  isNewBest: boolean;
  online: OnlineLobby | null;
  // Cosmetic ids this run just earned (unlocks diff before/after recordRun) — celebrated on
  // the results screen and folded into the guest sign-in nudge's pitch.
  newUnlocks?: string[];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const CONTROLS = "WASD move \u00b7 Mouse aim \u00b7 Click shoot \u00b7 Shift dash \u00b7 hold TAB for stats";
// The title preview stays a GLANCE, not a dashboard: three quiet rows under Play.
const LB_PREVIEW_ROWS = 3;
const LB_FULL_ROWS = 10;
// An unreachable backend never REJECTS (the Convex client retries forever) — it just never
// resolves. After this long, hydrating regions surface their honest unavailable state (a
// content swap inside the same reserved geometry); a late success still fills in place.
const HYDRATE_TIMEOUT_MS = 8000;

function onHydrateTimeout<T>(promise: Promise<T>, showUnavailable: () => void): Promise<T> {
  const timer = setTimeout(showUnavailable, HYDRATE_TIMEOUT_MS);
  return promise.finally(() => clearTimeout(timer));
}

function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Where keyboard focus should land after a Back/Escape return to the title: the exact
// destination that opened the screen (screens are rebuilt on return, so restore is by NAME,
// not by node — deterministic even though the original button no longer exists).
export interface TitleFocus {
  dest?: "online" | "leaderboard" | "profile" | "settings";
  lbRow?: number;
}

// The render look for a loadout: the cosmetic body palette wins the tint, the PARTY color
// is the fallback (and always keeps owning name/minimap/roster identity elsewhere).
function lookOf(loadout: CosmeticLoadout, partyColorIndex: number | null): BlobLook {
  const hasTint = loadout.body !== null || partyColorIndex !== null;
  return {
    colorIndex: hasTint ? bodyPaletteIndex(loadout.body, partyColorIndex ?? 0) : null,
    hat: loadout.hat,
    face: loadout.face,
  };
}

// A worn title's display text (quoted), or empty for the bare slot. A RETIRED id (recorded
// on an old leaderboard row, no longer in the catalog) safely renders as no title at all —
// never a raw internal id on a public surface.
function titleTextOf(title: string | null): string {
  if (title === null) return "";
  const def = cosmeticById(title);
  return def ? `\u201c${def.name}\u201d` : "";
}

function weaponName(id: string): string {
  return (WEAPONS as Record<string, { name: string } | undefined>)[id]?.name ?? id;
}

// Drives everything shown in #overlay: the title/menu, the settings/leaderboard/profile
// destinations, the online lobby, and the game-over screen. It is the only place that knows
// whether multiplayer exists.
export class Menu {
  private overlay: HTMLElement;
  private session: Session;
  private client: ConvexClient | null;
  private auth: AuthClient | null;
  private host: MenuHost;
  private unsub: (() => void) | null = null;
  private countupRaf = 0;
  private gameOverKeys: ((e: KeyboardEvent) => void) | null = null;
  private menuKeys: ((e: KeyboardEvent) => void) | null = null;
  private syncColorRow: (() => void) | null = null;
  // A leaderboard row index waiting to receive focus once the next fill enables it
  // (Back/Escape from a player profile restores focus to the exact row that opened it).
  private pendingLbRowFocus: number | null = null;
  // Last fetched leaderboard, kept for the session so revisits paint instantly (a background
  // refresh still runs) — the cached/uncached paths render the SAME fixed geometry.
  private lbCache: LeaderboardEntryDoc[] | null = null;
  // The per-session latch of the post-run sign-in nudge (never nag twice in one sitting).
  private isNudgeShownThisSession = false;

  constructor(overlay: HTMLElement, session: Session, client: ConvexClient | null, auth: AuthClient | null, host: MenuHost) {
    this.overlay = overlay;
    this.session = session;
    this.client = client;
    this.auth = auth;
    this.host = host;
  }

  hide() {
    this.teardownLobby();
    this.overlay.classList.add("hidden");
  }

  private show(...nodes: HTMLElement[]) {
    this.teardownLobby();
    this.overlay.classList.remove("hidden");
    this.overlay.replaceChildren(...nodes);
  }

  private teardownLobby() {
    if (this.unsub) { this.unsub(); this.unsub = null; }
    if (this.countupRaf) { cancelAnimationFrame(this.countupRaf); this.countupRaf = 0; }
    if (this.gameOverKeys) { window.removeEventListener("keydown", this.gameOverKeys); this.gameOverKeys = null; }
    if (this.menuKeys) { window.removeEventListener("keydown", this.menuKeys); this.menuKeys = null; }
    this.pendingLbRowFocus = null;
  }

  // Escape mirrors the screen's Back action (registered per screen, cleared on every
  // transition by teardownLobby). Only for non-destructive returns — the room lobby's
  // "leave" stays an explicit click, never a stray keypress.
  private bindEscape(onBack: () => void) {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onBack(); }
    };
    this.menuKeys = handler;
    window.addEventListener("keydown", handler);
  }

  // ---- TITLE ------------------------------------------------------------------------
  //
  // The title is a LAUNCHPAD, not a control panel. Attention hierarchy (explicit, in order):
  //   1. PLAY ONLINE / PLAY SOLO — the only dominant warm actions, top-left, first in tab
  //      order. Nothing else on the surface wears the amber.
  //   2. The compact fixed-height identity/progress strip (guest sign-in CTA or account
  //      chip + the blob/stat readout) and the deliberately quiet top-runs glance under
  //      Play — supporting context, hairline chrome, muted ink.
  //   3. The explicit destinations — LEADERBOARD / PROFILE / SETTINGS — and the footline.
  //      The full settings panel lives entirely off this surface.
  // Every async-hydrated region (auth, stats, leaderboard) renders its FINAL geometry from
  // first paint — skeletons fill in place, so nothing below them ever moves.

  async showTitle(focus?: TitleFocus) {
    const wrap = el("div", "menu title");
    const focusTargets = new Map<string, HTMLButtonElement>();

    // Hero banner: logo + tagline, divider under it.
    const hero = el("div", "hero");
    const logo = document.createElement("img");
    logo.src = "/ui/logo.png";
    logo.className = "logo-img";
    logo.alt = "BLOBROGUE";
    hero.appendChild(logo);
    hero.appendChild(el("p", "tag", "An amber cowboy-blob lost in the depths. Blast your way down as far as you can \u2014 solo, or with friends."));
    wrap.appendChild(hero);

    if (!this.client) {
      // Offline build: no profile/multiplayer — single centered actions column, no split.
      const colA = el("div", "col-actions");
      colA.appendChild(this.soloButton("\u25be  PLAY"));
      colA.appendChild(el("p", "muted", "multiplayer offline \u2014 no server configured for this build"));
      const nav = el("div", "navrow");
      const profileBtn = this.navButton("PROFILE", () => void this.showProfile());
      const settingsBtn = this.navButton("SETTINGS", () => void this.showSettings());
      focusTargets.set("profile", profileBtn);
      focusTargets.set("settings", settingsBtn);
      nav.append(profileBtn, settingsBtn);
      colA.appendChild(nav);
      wrap.appendChild(colA);
    } else {
      const body = el("div", "body");

      // LEFT column: the play actions own the top; the quiet top-runs glance fills the
      // space under them (hairline chrome, fixed row geometry, subordinate to Play).
      const colA = el("div", "col-actions");
      colA.appendChild(el("div", "col-h", "Play"));
      const onlineBtn = el("button", "btn-quick primary");
      onlineBtn.appendChild(el("span", "", "\u25b6 PLAY ONLINE"));
      onlineBtn.appendChild(el("span", "sub", "rooms & quick play on the live server"));
      onlineBtn.addEventListener("click", () => void this.showOnlineHome());
      focusTargets.set("online", onlineBtn);
      colA.appendChild(onlineBtn);
      const solo = this.soloButton("PLAY SOLO");
      solo.classList.add("play-solo");
      colA.appendChild(solo);
      colA.appendChild(this.leaderboardPreview());
      body.appendChild(colA);

      // RIGHT column: the reserved identity card, the passive identity/progress strip,
      // then the explicit destinations.
      const colB = el("div", "col-side");
      colB.appendChild(this.identitySection());
      const you = this.youStrip();
      colB.appendChild(you.strip);
      const nav = el("div", "navrow");
      const lbBtn = this.navButton("LEADERBOARD", () => void this.showLeaderboard());
      const profileBtn = this.navButton("PROFILE", () => void this.showProfile());
      const settingsBtn = this.navButton("SETTINGS", () => void this.showSettings());
      focusTargets.set("leaderboard", lbBtn);
      focusTargets.set("profile", profileBtn);
      focusTargets.set("settings", settingsBtn);
      nav.append(lbBtn, profileBtn, settingsBtn);
      colB.appendChild(nav);
      body.appendChild(colB);

      wrap.appendChild(body);
      void this.hydrateTitle(you);
    }

    wrap.appendChild(el("p", "foot", CONTROLS));
    this.show(wrap);
    // Back/Escape focus restore: land keyboard focus on the destination that was used
    // (or arm the leaderboard-row restore, consumed once the preview fill enables it).
    if (focus?.dest) focusTargets.get(focus.dest)?.focus();
    if (focus?.lbRow !== undefined) this.pendingLbRowFocus = focus.lbRow;
  }

  // One hydration pass for the title: login/refresh the profile (fills the you-card stats in
  // place) — never lets an unreachable backend break the title screen. A hang surfaces the
  // unavailable state after the timeout; a late answer still fills the same box.
  private async hydrateTitle(you: { setProfile: (p: ProfileDoc | null, isError?: boolean) => void }) {
    let profile: ProfileDoc | null = null;
    try {
      const signedIn = this.auth?.isSignedIn ?? false;
      const load = (this.session.name || signedIn)
        ? this.session.login(this.session.name || "blob")
        : this.session.refreshProfile();
      profile = await onHydrateTimeout(load, () => you.setProfile(null, true));
    } catch {
      you.setProfile(null, true);
      return;
    }
    this.syncColorRow?.();
    you.setProfile(profile);
  }

  private navButton(label: string, go: () => void): HTMLButtonElement {
    const btn = el("button", "secondary nav-btn", label);
    btn.addEventListener("click", go);
    return btn;
  }

  // The passive identity/progress strip: live blob preview + name + a one-line stat
  // readout. Pure display (the PROFILE destination below is the door — one obvious way in,
  // no competing click target). Fixed height; the stat line hydrates in place.
  private youStrip(): { strip: HTMLElement; setProfile: (p: ProfileDoc | null, isError?: boolean) => void } {
    const strip = el("div", "you-strip");
    const preview = createBlobPreview(lookOf(this.session.cosmetics, this.session.colorIndex), 48);
    const info = el("div", "you-info");
    const name = el("span", "you-name", this.session.name || "blob");
    const stats = el("span", "you-stats skel", "\u2014");
    info.append(name, stats);
    strip.append(preview.el, info);
    const setProfile = (p: ProfileDoc | null, isError = false) => {
      stats.classList.remove("skel");
      if (p) {
        name.textContent = p.name;
        stats.textContent = p.gamesPlayed > 0
          ? `deepest ${p.deepestFloor} \u00b7 ${p.gamesPlayed} runs`
          : "no runs yet";
        preview.setLook(lookOf(p.cosmetics, p.colorIndex ?? this.session.colorIndex));
      } else {
        // No profile row yet is a fresh blob, not a failure; only a thrown fetch is.
        stats.textContent = isError ? "stats unavailable" : "no runs yet";
      }
    };
    return { strip, setProfile };
  }

  private nameRow(): HTMLElement {
    const row = el("div", "namerow");
    const label = el("label", "", "name");
    const input = el("input");
    input.type = "text";
    input.maxLength = 20;
    input.placeholder = "your blob name";
    input.value = this.session.name;
    input.addEventListener("change", () => void this.session.login(input.value.trim() || "blob").catch(() => {}));
    row.append(label, input);
    return row;
  }

  // The blob-color pick: one swatch per palette slot. Slot 0 (amber) is the natural
  // sprite; any other pick tints your blob everywhere (solo + online) and is persisted
  // (locally always, onto the profile when the backend is reachable).
  private colorRow(onPick?: () => void): HTMLElement {
    const row = el("div", "namerow");
    row.appendChild(el("label", "", "blob color"));
    const swatches = el("div", "swatches");
    const buttons: HTMLButtonElement[] = [];
    const sync = () => {
      const current = this.session.colorIndex ?? 0;
      buttons.forEach((b, i) => {
        b.classList.toggle("sel", i === current);
        b.setAttribute("aria-pressed", String(i === current));
      });
    };
    for (let i = 0; i < PLAYER_COLORS.length; i++) {
      const b = el("button", "swatch");
      b.type = "button";
      b.style.background = PLAYER_COLORS[i];
      b.title = i === 0 ? "amber (classic)" : "";
      // Icon-only button: the swatch has no text, so name it for screen readers.
      b.setAttribute("aria-label", i === 0 ? "blob color amber (classic)" : `blob color ${i + 1}`);
      b.addEventListener("click", () => { this.session.setColorIndex(i); sync(); onPick?.(); });
      buttons.push(b);
      swatches.appendChild(b);
    }
    sync();
    this.syncColorRow = sync;
    row.appendChild(swatches);
    return row;
  }

  // The right-column identity card. Signed in: the Google account chip + a quiet
  // confirmation of what the account holds. Signed out: the guest name input plus the
  // sign-in CTA with its concrete benefits. Both states render inside the SAME reserved
  // geometry (.identity min-height), and guest play is never gated on signing in.
  private identitySection(): HTMLElement {
    const wrap = el("div", "identity");
    if (this.auth && this.auth.isSignedIn) {
      wrap.appendChild(this.accountChip());
      wrap.appendChild(el("p", "id-note", "progress, cosmetics & leaderboard runs are saved to this account"));
    } else {
      wrap.appendChild(this.nameRow());
      if (this.auth) wrap.appendChild(this.googleCta());
    }
    return wrap;
  }

  private accountChip(): HTMLElement {
    const box = el("div", "account");
    const av = document.createElement("img");
    av.className = "account-av";
    av.alt = "";
    av.width = 32;
    av.height = 32;
    const info = el("div", "account-info");
    const name = el("div", "account-name", this.session.name || "signed in");
    const sub = el("div", "account-sub", "google account");
    info.append(name, sub);
    const out = el("button", "secondary account-out", "sign out");
    out.addEventListener("click", () => void this.doSignOut());
    box.append(av, info, out);
    void this.hydrateAccount(av, name);
    return box;
  }

  private async hydrateAccount(av: HTMLImageElement, name: HTMLElement) {
    if (!this.client) return;
    try {
      const user = await this.client.query(api.players.currentUser, {});
      if (!user) return;
      if (user.name) name.textContent = user.name;
      if (user.image) { av.src = user.image; av.classList.add("has-img"); }
    } catch {
      // Backend not ready — keep the placeholder chip, don't crash the menu.
    }
  }

  // The guest sign-in CTA: one strong, honest pitch in the identity card. The error line
  // reserves its height so a failed attempt never shifts the card.
  private googleCta(): HTMLElement {
    const wrap = el("div", "gcta");
    const btn = el("button", "secondary btn-google");
    btn.appendChild(googleMark());
    btn.appendChild(el("span", "", "Sign in with Google"));
    const benefits = el("p", "gcta-benefits", SIGNIN_BENEFITS);
    const status = el("p", "muted auth-status");
    btn.addEventListener("click", () => void this.doSignIn(status));
    wrap.append(btn, benefits, status);
    return wrap;
  }

  private async doSignIn(status: HTMLElement) {
    if (!this.auth) return;
    status.textContent = "";
    try {
      await this.auth.signInWithGoogle();
      // On success the browser navigates to Google; control returns via ?code=.
    } catch (err) {
      status.textContent = "sign-in unavailable \u2014 server not configured yet";
      console.warn("[menu] Google sign-in failed", err);
    }
  }

  private async doSignOut() {
    if (!this.auth) return;
    await this.auth.signOut();
    // Flush the cached profile so no prior-account data (name/stats/cosmetics/unlocks)
    // survives into the guest render — the title hydrate refills from the guest row.
    this.session.clearProfile();
    await this.showTitle();
  }

  private soloButton(label: string): HTMLButtonElement {
    const btn = el("button", "", label);
    btn.addEventListener("click", () => this.doSolo());
    return btn;
  }

  private doSolo() {
    // Solo must never block on the network: kick off the (optional) identity
    // upsert in the background and start immediately with whatever profile we have.
    if (this.client) void this.session.login(this.session.name || "blob").catch(() => {});
    this.host.startSolo(this.session.profile);
  }

  // ---- LEADERBOARD ------------------------------------------------------------------
  //
  // Both surfaces (the title preview and the full screen) build their FINAL row geometry
  // up front — fixed-height skeleton rows that fill in place — so hydration can never move
  // the play buttons or steal focus. Rows are disabled until they hold a real entry.

  private leaderboardRows(count: number): { box: HTMLElement; rows: HTMLButtonElement[]; note: HTMLElement } {
    const box = el("div", "lb-rows");
    const rows: HTMLButtonElement[] = [];
    for (let i = 0; i < count; i++) {
      const row = el("button", "lb-row");
      row.type = "button";
      row.disabled = true;
      row.append(
        el("span", "lb-rank", String(i + 1)),
        el("span", "lb-dot"),
        el("span", "lb-name skel", "\u2014"),
        el("span", "lb-floor", ""),
      );
      rows.push(row);
      box.appendChild(row);
    }
    const note = el("p", "muted lb-note", "");
    return { box, rows, note };
  }

  private fillLeaderboardRows(rows: HTMLButtonElement[], note: HTMLElement, entries: LeaderboardEntryDoc[] | null, backTo: (rowIndex: number) => void) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const [rank, dot, name, floor] = Array.from(row.children) as HTMLElement[];
      name.classList.remove("skel");
      const entry = entries?.[i];
      if (!entry) {
        rank.textContent = String(i + 1);
        dot.style.background = "";
        name.textContent = "\u2014";
        floor.textContent = "";
        row.disabled = true;
        continue;
      }
      rank.textContent = String(i + 1);
      dot.style.background = playerColor(entry.colorIndex ?? 0);
      name.textContent = entry.name;
      floor.textContent = `FL ${entry.floor}`;
      row.disabled = false;
      row.setAttribute("aria-label", `${entry.name} \u2014 floor ${entry.floor} \u2014 view profile`);
      row.onclick = () => this.showPlayerProfile(entry, () => backTo(i));
    }
    if (entries === null) note.textContent = "leaderboard unavailable \u2014 check your connection";
    else if (entries.length === 0) note.textContent = "no runs on the board yet \u2014 yours could be first";
    else note.textContent = "";
    // A pending Back/Escape restore lands on its row the moment the fill enables it.
    const pending = this.pendingLbRowFocus;
    if (pending !== null && rows[pending] !== undefined && !rows[pending].disabled) {
      this.pendingLbRowFocus = null;
      rows[pending].focus();
    }
  }

  private async fetchLeaderboard(onStall: () => void): Promise<LeaderboardEntryDoc[] | null> {
    if (!this.client) return null;
    try {
      this.lbCache = await onHydrateTimeout(this.client.query(api.leaderboard.top, { limit: LB_FULL_ROWS }), onStall);
      return this.lbCache;
    } catch {
      return this.lbCache; // a failed refresh keeps the cached board (or null -> error note)
    }
  }

  // The title's compact preview: header + view action, then the fixed top-run rows.
  private leaderboardPreview(): HTMLElement {
    const panel = el("div", "lb-preview");
    const head = el("div", "lb-head");
    head.appendChild(el("span", "col-h", "Top runs \u2014 global"));
    const view = el("button", "secondary lb-view", "VIEW LEADERBOARD \u25b8");
    view.addEventListener("click", () => void this.showLeaderboard());
    head.appendChild(view);
    panel.appendChild(head);
    const { box, rows, note } = this.leaderboardRows(LB_PREVIEW_ROWS);
    panel.append(box, note);
    const backTo = (rowIndex: number) => void this.showTitle({ lbRow: rowIndex });
    if (this.lbCache) this.fillLeaderboardRows(rows, note, this.lbCache, backTo);
    // A stalled fetch (backend unreachable — never rejects, just hangs) surfaces the
    // unavailable note in place unless a cached board is already showing.
    const onStall = () => { if (!this.lbCache) this.fillLeaderboardRows(rows, note, null, backTo); };
    void this.fetchLeaderboard(onStall).then((entries) => this.fillLeaderboardRows(rows, note, entries, backTo));
    return panel;
  }

  // The full leaderboard destination. `focusRow` restores keyboard focus to the row a
  // player-profile visit came from.
  async showLeaderboard(focusRow?: number) {
    if (!this.client) { await this.showTitle(); return; }
    const wrap = el("div", "menu");
    wrap.appendChild(el("h1", "", "LEADERBOARD"));
    wrap.appendChild(el("p", "", "The deepest runs on record. Pick a blob to see their look and their run's build."));
    const { box, rows, note } = this.leaderboardRows(LB_FULL_ROWS);
    box.classList.add("lb-rows-full");
    wrap.append(box, note);
    const row = el("div", "btnrow");
    const goBack = () => void this.showTitle({ dest: "leaderboard" });
    const back = el("button", "secondary", "back");
    back.addEventListener("click", goBack);
    row.appendChild(back);
    wrap.appendChild(row);
    this.show(wrap);
    this.bindEscape(goBack);
    if (focusRow !== undefined) this.pendingLbRowFocus = focusRow;
    const backTo = (rowIndex: number) => void this.showLeaderboard(rowIndex);
    if (this.lbCache) this.fillLeaderboardRows(rows, note, this.lbCache, backTo);
    const onStall = () => { if (!this.lbCache) this.fillLeaderboardRows(rows, note, null, backTo); };
    void this.fetchLeaderboard(onStall).then((entries) => this.fillLeaderboardRows(rows, note, entries, backTo));
  }

  // A leaderboard player's public profile: their blob's look and that run's build. Only
  // leaderboard-entry data renders here — name/appearance/run stats, nothing account-side.
  showPlayerProfile(entry: LeaderboardEntryDoc, onBack: () => void) {
    const wrap = el("div", "menu");
    wrap.appendChild(el("h1", "", entry.name.toUpperCase()));
    // The worn title (a reserved line even when bare — the header never shifts between
    // titled and untitled players), then the context line.
    wrap.appendChild(el("p", "worn-title", titleTextOf(entry.title)));
    wrap.appendChild(el("p", "muted", "best run on the global leaderboard"));

    const top = el("div", "pp-top");
    const look = lookOf({ hat: entry.hat, face: entry.face, body: entry.body, title: entry.title }, entry.colorIndex);
    const preview = createBlobPreview(look, 96);
    top.appendChild(preview.el);
    const grid = el("div", "profile-grid");
    const stat = (label: string, value: string, isAmber = false) => {
      const cell = el("div", "stat");
      const v = el("span", "stat-value", value);
      if (isAmber) v.classList.add("amber");
      cell.append(v, el("span", "stat-label", label));
      grid.appendChild(cell);
    };
    stat("floor", String(entry.floor), true);
    stat("kills", String(entry.kills));
    stat("coins", String(entry.coins));
    stat("time", entry.durationMs > 0 ? fmtClock(entry.durationMs / 1000) : "\u2014");
    top.appendChild(grid);
    wrap.appendChild(top);

    wrap.appendChild(el("div", "col-h", "that run's build"));
    const build = el("div", "build-strip");
    for (const id of entry.weapons) build.appendChild(el("span", "build-chip weapon", weaponName(id)));
    for (const it of entry.items) {
      const def = itemById(it.id);
      const label = def ? (it.count > 1 ? `${def.name} Lv${it.count}` : def.name) : it.id;
      const chip = el("span", "build-chip", label);
      if (def) chip.style.setProperty("--t", def.tint);
      build.appendChild(chip);
    }
    if (entry.weapons.length === 0 && entry.items.length === 0) {
      build.appendChild(el("span", "muted", "no build recorded for this run"));
    }
    wrap.appendChild(build);

    const row = el("div", "btnrow");
    const back = el("button", "secondary", "back");
    back.addEventListener("click", () => onBack());
    row.appendChild(back);
    wrap.appendChild(row);
    this.show(wrap);
    this.bindEscape(onBack);
  }

  // ---- OWN PROFILE + WARDROBE ----------------------------------------------------------
  //
  // The player's own destination: all-time stats plus the wardrobe — every SHIPPED cosmetic
  // slot (COSMETIC_SLOTS: body color, hats, face, titles) with explicit equipped/owned/
  // locked states. Cosmetics are trophies you wear: purely visual, achievement-unlocked,
  // never currency or power. Equipping persists locally at once and onto the profile in the
  // background (multiplayer identity picks the overlays up at the next ticket mint). The
  // wardrobe lives HERE, off the launch menu, by design.

  async showProfile() {
    const wrap = el("div", "menu");
    wrap.appendChild(el("h1", "", "YOUR BLOB"));
    // The worn title, reserved even when bare so equipping never shifts the header.
    const ownTitle = el("p", "worn-title", titleTextOf(this.session.cosmetics.title));
    wrap.appendChild(ownTitle);

    const top = el("div", "pp-top");
    const preview = createBlobPreview(lookOf(this.session.cosmetics, this.session.colorIndex), 96);
    top.appendChild(preview.el);
    const grid = el("div", "profile-grid");
    const cells = new Map<string, HTMLElement>();
    for (const label of ["deepest", "kills", "coins", "runs"]) {
      const cell = el("div", "stat");
      const v = el("span", "stat-value skel", "\u2014");
      if (label === "deepest") v.classList.add("amber");
      cell.append(v, el("span", "stat-label", label));
      cells.set(label, v);
      grid.appendChild(cell);
    }
    top.appendChild(grid);
    wrap.appendChild(top);

    const accountLine = el("p", "muted id-note",
      this.auth?.isSignedIn
        ? "saved to your google account \u2014 every device sees this blob"
        : this.client
          ? "playing as guest \u2014 sign in from the title screen to keep this blob across devices"
          : "offline build \u2014 your closet is saved on this device");
    wrap.appendChild(accountLine);

    // ---- the wardrobe: exactly the shipped slots, in catalog order ----
    const note = el("p", "muted closet-note", "");
    const syncPreview = () => {
      preview.setLook(lookOf(this.session.cosmetics, this.session.colorIndex));
      ownTitle.textContent = titleTextOf(this.session.cosmetics.title);
    };
    // A locked pick previews the TENTATIVE loadout on the mirror (visual slots) without
    // ever equipping it.
    const previewLoadout = (tentative: CosmeticLoadout) => preview.setLook(lookOf(tentative, this.session.colorIndex));

    const syncFns: Array<() => void> = [];
    for (const slotDef of COSMETIC_SLOTS) {
      if (slotDef.slot === "body") {
        // Body color renders as the swatch row (one pick drives the cosmetic body item
        // AND the party color at launch — see Session.setColorIndex).
        wrap.appendChild(this.colorRow(syncPreview));
        continue;
      }
      wrap.appendChild(el("div", "col-h", slotDef.label));
      const { rowEl, sync } = this.closetRow(slotDef.slot, slotDef.noneLabel, note, syncPreview, previewLoadout);
      syncFns.push(sync);
      wrap.appendChild(rowEl);
    }
    wrap.appendChild(note);

    const row = el("div", "btnrow");
    const goBack = () => void this.showTitle({ dest: "profile" });
    const back = el("button", "secondary", "back");
    back.addEventListener("click", goBack);
    row.appendChild(back);
    wrap.appendChild(row);
    this.show(wrap);
    this.bindEscape(goBack);

    // Hydrate stats + unlock states in place (fixed geometry; a dead backend just leaves
    // the placeholders and the locked states, never an error screen).
    if (this.client) {
      try {
        const profile = await this.session.login(this.session.name || "blob");
        if (profile) {
          cells.forEach((v) => v.classList.remove("skel"));
          cells.get("deepest")!.textContent = String(profile.deepestFloor);
          cells.get("kills")!.textContent = String(profile.totalKills);
          cells.get("coins")!.textContent = String(profile.totalCoins);
          cells.get("runs")!.textContent = String(profile.gamesPlayed);
        }
        this.syncColorRow?.();
        for (const sync of syncFns) sync();
        syncPreview();
      } catch {
        // placeholders stand
      }
    }
  }

  // One wardrobe row: the empty-slot tile plus a tile per catalog item, with explicit
  // EQUIPPED / owned / LOCKED states. Locked tiles PREVIEW on the mirror (with the exact
  // configured unlock condition in the reserved note line) but never equip.
  private closetRow(
    slot: CosmeticSlot,
    noneLabel: string,
    note: HTMLElement,
    syncPreview: () => void,
    previewLoadout: (tentative: CosmeticLoadout) => void,
  ): { rowEl: HTMLElement; sync: () => void } {
    const rowEl = el("div", "closet-row");
    const unlocks = () => this.session.profile?.unlocks ?? [];
    const equippedId = () => this.session.cosmetics[slot];

    interface Tile { btn: HTMLButtonElement; state: HTMLElement; def: CosmeticDef | null }
    const tiles: Tile[] = [];

    const sync = () => {
      for (const t of tiles) {
        const id = t.def?.id ?? null;
        const isEquipped = equippedId() === id;
        const isLocked = t.def !== null && !isCosmeticOwned(t.def, unlocks());
        t.btn.classList.toggle("sel", isEquipped);
        t.btn.classList.toggle("locked", isLocked);
        t.btn.setAttribute("aria-pressed", String(isEquipped));
        t.state.textContent = isEquipped ? "EQUIPPED" : isLocked ? "LOCKED" : "";
      }
    };

    const addTile = (def: CosmeticDef | null, label: string) => {
      const btn = el("button", "cos-tile");
      btn.type = "button";
      const icon = el("span", "cos-icon");
      const art = def ? cosmeticOverlay(def.id) : null;
      if (art) {
        const mini = document.createElement("canvas");
        mini.width = 40; mini.height = 40;
        const g = mini.getContext("2d");
        if (g) { g.imageSmoothingEnabled = false; g.drawImage(art, 0, 0, 40, 40); }
        icon.appendChild(mini);
      } else {
        // Artless slots: titles wear the honor glyph, the empty slot a plain dot.
        icon.textContent = def?.slot === "title" ? "\u2726" : "\u25cf";
      }
      const name = el("span", "cos-name", label);
      const state = el("span", "cos-state", "");
      btn.append(icon, name, state);
      btn.setAttribute("aria-label", `${slot}: ${label}`);
      btn.addEventListener("click", () => {
        if (def && !isCosmeticOwned(def, unlocks())) {
          // Locked: preview only, exposing the exact configured unlock condition.
          note.textContent = `${def.name} is locked \u2014 ${def.hint ?? "earn it in the depths"} (preview only)`;
          previewLoadout({ ...this.session.cosmetics, [slot]: def.id });
          return;
        }
        note.textContent = "";
        this.session.setCosmetic(slot, def?.id ?? null);
        sync();
        syncPreview();
      });
      tiles.push({ btn, state, def });
      rowEl.appendChild(btn);
    };

    addTile(null, noneLabel);
    for (const def of cosmeticsForSlot(slot)) addTile(def, def.name);
    sync();
    return { rowEl, sync };
  }

  // ---- SETTINGS -----------------------------------------------------------------------

  // The full settings destination (also reachable mid-run via pause, which embeds the same
  // controls — one source of truth in src/game/settings.ts).
  async showSettings() {
    const wrap = el("div", "menu settings-screen");
    wrap.appendChild(el("h1", "", "SETTINGS"));
    wrap.appendChild(el("p", "muted", "everything saves instantly \u2014 the pause menu carries the same controls"));
    wrap.appendChild(createSettingsControls());
    const row = el("div", "btnrow");
    const goBack = () => void this.showTitle({ dest: "settings" });
    const back = el("button", "secondary", "back");
    back.addEventListener("click", goBack);
    row.appendChild(back);
    wrap.appendChild(row);
    this.show(wrap);
    this.bindEscape(goBack);
  }

  // ---- ONLINE (authoritative server): rooms + quick play -----------------------------

  // The online home: quick play into the public pool, create a private room (shareable
  // code), or join a friend's code. Every action stays on this screen until it succeeds,
  // so a failed backend just writes a status line — never a dead end.
  async showOnlineHome(note = "") {
    if (!this.client) { await this.showTitle(); return; }
    const wrap = el("div", "menu");
    wrap.appendChild(el("h1", "", "PLAY ONLINE"));
    wrap.appendChild(el("p", "", "Server-run worlds. Drop into the public pool, or make a room and share its code."));

    const colA = el("div", "col-actions");
    const quick = el("button", "btn-quick primary");
    quick.appendChild(el("span", "", "\u25b6 QUICK PLAY"));
    quick.appendChild(el("span", "sub", "drop into an open public room"));
    colA.appendChild(quick);
    const actrow = el("div", "actrow");
    const create = el("button", "secondary", "CREATE ROOM");
    const join = el("button", "secondary", "JOIN CODE");
    actrow.append(create, join);
    colA.appendChild(actrow);
    wrap.appendChild(colA);

    // Status/failure line with reserved height: retries and errors swap text inside the
    // same box, so the back button below never moves.
    const status = el("p", "muted status-line", note);
    wrap.appendChild(status);

    const row = el("div", "btnrow");
    const goBack = () => void this.showTitle({ dest: "online" });
    const back = el("button", "secondary", "back");
    back.addEventListener("click", goBack);
    row.appendChild(back);
    wrap.appendChild(row);

    const buttons = [quick, create, join];
    const setBusy = (isBusy: boolean, text: string) => {
      buttons.forEach((b) => (b.disabled = isBusy));
      status.textContent = text;
    };
    quick.addEventListener("click", () => void this.doQuickPlayOnline(setBusy));
    create.addEventListener("click", () => void this.doCreateOnline(setBusy));
    join.addEventListener("click", () => void this.showJoinScreen({
      title: "JOIN ROOM",
      hint: "Enter the 4-letter room code your friend shared.",
      onBack: () => void this.showOnlineHome(),
      onJoin: (code, joinStatus) => void this.doJoinOnline(code, joinStatus),
    }));

    this.show(wrap);
    this.bindEscape(goBack);
  }

  private async doQuickPlayOnline(setBusy: (b: boolean, t: string) => void) {
    if (!this.client) return;
    setBusy(true, "finding a room\u2026");
    try {
      const profile = await this.session.login(this.session.name || "blob");
      const lobby = new OnlineLobby(this.client, this.session);
      await lobby.quickPlay();
      // The public pool has no start gate: the room is live, drop straight in.
      this.launchOnline(lobby, profile, false);
    } catch (err) {
      setBusy(false, this.cleanErr(err instanceof Error ? err.message : "could not find a room"));
    }
  }

  private async doCreateOnline(setBusy: (b: boolean, t: string) => void) {
    if (!this.client) return;
    setBusy(true, "creating room\u2026");
    try {
      const profile = await this.session.login(this.session.name || "blob");
      const lobby = new OnlineLobby(this.client, this.session);
      await lobby.create();
      this.showOnlineLobby(lobby, profile);
    } catch (err) {
      setBusy(false, this.cleanErr(err instanceof Error ? err.message : "could not create room"));
    }
  }

  private async doJoinOnline(code: string, status: HTMLElement) {
    if (!this.client || code.trim().length < 4) { status.textContent = "enter a valid code"; return; }
    status.textContent = "joining\u2026";
    try {
      const profile = await this.session.login(this.session.name || "blob");
      const lobby = new OnlineLobby(this.client, this.session);
      await lobby.join(code);
      // A live room means the run is on — drop straight in; otherwise wait in the lobby.
      if (lobby.status === "playing") this.launchOnline(lobby, profile, false);
      else this.showOnlineLobby(lobby, profile);
    } catch (err) {
      status.textContent = this.cleanErr(err instanceof Error ? err.message : "could not join");
    }
  }

  private launchOnline(lobby: OnlineLobby, profile: ProfileDoc | null, isPartyStart: boolean) {
    this.teardownLobby();
    this.host.startOnline(lobby, profile, isPartyStart);
  }

  // The room lobby: the shareable code, who's here (names + colors, host tag) with each
  // member's live readiness (LOBBY / CONNECTING\u2026 / CONNECTED TO WORLD — mirrored from the
  // authoritative server, not assumed), and the start/waiting/rejoin control. Re-renders on
  // every roster/status change.
  showOnlineLobby(lobby: OnlineLobby, profile: ProfileDoc | null, note = "") {
    let prevStatus = lobby.status;
    const render = () => {
      if (lobby.status === "ended") { lobby.leave(); void this.showTitle(); return; }
      // The host pressing START flips the room live; everyone waiting launches together —
      // into the readiness veil, which reveals gameplay only once the whole party joined.
      // (Only on the transition — re-opening this screen mid-run shows REJOIN instead.)
      if (lobby.status === "playing" && prevStatus === "lobby") { this.launchOnline(lobby, profile, true); return; }
      prevStatus = lobby.status;

      const wrap = el("div", "menu");
      wrap.appendChild(el("h1", "", "ROOM " + lobby.code));
      wrap.appendChild(el("p", "", "Share this code \u2014 friends pick PLAY ONLINE \u2192 JOIN CODE to join you."));
      wrap.appendChild(el("div", "code-badge", lobby.code));

      const players = lobby.players();
      const list = el("div", "playerlist");
      for (const p of players) {
        const rowEl = el("div", "playerrow");
        const dot = el("span", "dot");
        dot.style.background = playerColor(p.colorIndex);
        const you = p.playerId === lobby.selfId ? " (you)" : "";
        rowEl.append(dot, el("span", "", `${p.name}${you}${p.isHost ? " \u2014 host" : ""}`));
        rowEl.appendChild(this.memberStatusChip(lobby, p));
        list.appendChild(rowEl);
      }
      wrap.appendChild(list);
      wrap.appendChild(el("p", "muted", `${players.length} player${players.length === 1 ? "" : "s"} in the room`));

      const row = el("div", "btnrow");
      if (lobby.status === "playing") {
        // A run is live in this room (e.g. you stepped out mid-run) — jump back in.
        const rejoin = el("button", "", "\u25be  REJOIN RUN");
        rejoin.addEventListener("click", () => this.launchOnline(lobby, profile, false));
        row.appendChild(rejoin);
      } else if (lobby.isHost) {
        row.appendChild(this.hostStartButton(lobby));
      } else {
        row.appendChild(this.readyToggleButton(lobby));
        wrap.appendChild(el("p", "muted", "waiting for the host to start\u2026"));
      }
      const leave = el("button", "secondary", "leave");
      leave.addEventListener("click", () => { lobby.leave(); void this.showTitle(); });
      row.appendChild(leave);
      wrap.appendChild(row);
      if (note) wrap.appendChild(el("p", "muted", note));
      wrap.appendChild(el("p", "hint", CONTROLS));

      this.overlay.classList.remove("hidden");
      this.overlay.replaceChildren(wrap);
    };

    this.teardownLobby();
    this.unsub = lobby.onChange(render);
    render();
  }

  // A member's roster chip. In the lobby it is the readiness consent (READY / NOT READY,
  // host implicit) + their measured ping; while the run is live it is their state against
  // the AUTHORITATIVE world (CONNECTED TO WORLD / CONNECTING…), mirrored from the server's
  // own snapshot.
  private memberStatusChip(lobby: OnlineLobby, p: LobbyPlayer): HTMLElement {
    const ping = p.pingMs !== null ? ` \u00b7 ${p.pingMs}ms` : "";
    let label: string;
    let color: string;
    if (lobby.status === "playing") {
      const isConnected = p.gsWorldId === lobby.expectedWorldId();
      label = isConnected ? "CONNECTED TO WORLD" : "CONNECTING\u2026";
      color = isConnected ? "#7CFC98" : "#ffb43b";
    } else if (p.isHost) {
      label = "HOST";
      color = "#8f87a8";
    } else {
      label = p.isReady ? READY_LABEL : NOT_READY_LABEL;
      color = p.isReady ? "#7CFC98" : "#ffb43b";
    }
    const chip = el("span", "member-status", `${label}${ping}`);
    chip.style.marginLeft = "auto";
    chip.style.fontSize = "10px";
    chip.style.letterSpacing = "1px";
    chip.style.color = color;
    return chip;
  }

  // A non-host member's readiness consent toggle.
  private readyToggleButton(lobby: OnlineLobby): HTMLButtonElement {
    const isReady = lobby.isSelfReady;
    const btn = el("button", isReady ? "secondary" : "", isReady ? "\u2713 READY \u2014 tap to unready" : "\u25be  READY UP");
    btn.addEventListener("click", () => lobby.setReady(!lobby.isSelfReady));
    return btn;
  }

  // The host's start control. All members ready -> plain START RUN. Someone not ready ->
  // START ANYWAY, armed only by a full 3s HOLD (releasing cancels) so a party can never be
  // yanked into a run by a slipped click.
  private hostStartButton(lobby: OnlineLobby): HTMLButtonElement {
    if (lobby.isPartyReady) {
      const start = el("button", "", "\u25be  START RUN");
      start.addEventListener("click", () => void lobby.start().catch(() => {}));
      return start;
    }
    const btn = el("button", "secondary", START_ANYWAY_IDLE);
    let holdTimer: ReturnType<typeof setInterval> | null = null;
    let holdStartedAt = 0;
    const cancelHold = () => {
      if (holdTimer !== null) clearInterval(holdTimer);
      holdTimer = null;
      btn.textContent = START_ANYWAY_IDLE;
    };
    btn.addEventListener("pointerdown", () => {
      holdStartedAt = Date.now();
      cancelHold();
      holdTimer = setInterval(() => {
        const heldMs = Date.now() - holdStartedAt;
        if (heldMs >= START_ANYWAY_HOLD_MS) {
          cancelHold();
          void lobby.start().catch(() => {});
          return;
        }
        btn.textContent = startAnywayHoldLabel(heldMs);
      }, 100);
    });
    btn.addEventListener("pointerup", cancelHold);
    btn.addEventListener("pointerleave", cancelHold);
    btn.addEventListener("pointercancel", cancelHold);
    return btn;
  }

  // The join-by-code screen for online rooms.
  private showJoinScreen(opts: {
    title: string;
    hint: string;
    onBack: () => void;
    onJoin: (code: string, status: HTMLElement) => void;
  }) {
    const wrap = el("div", "menu");
    wrap.appendChild(el("h1", "", opts.title));
    wrap.appendChild(el("p", "", opts.hint));
    const input = el("input", "code-input");
    input.type = "text";
    input.maxLength = 4;
    input.placeholder = "CODE";
    input.autocapitalize = "characters";
    input.addEventListener("input", () => (input.value = input.value.toUpperCase()));
    wrap.appendChild(input);
    const status = el("p", "muted status-line");
    const row = el("div", "btnrow");
    const go = el("button", "", "join");
    go.addEventListener("click", () => opts.onJoin(input.value, status));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") opts.onJoin(input.value, status); });
    const back = el("button", "secondary", "back");
    back.addEventListener("click", () => opts.onBack());
    row.append(go, back);
    wrap.append(row, status);
    this.show(wrap);
    this.bindEscape(() => opts.onBack());
    input.focus();
  }

  showGameOver(result: RunResult, profile: ProfileDoc | null, ctx: GameOverContext) {
    const wrap = el("div", "menu");
    wrap.appendChild(el("h1", "died", "YOU DIED"));
    const flavor = ctx.online
      ? "The run is over \u2014 regroup and go again."
      : "The depths claim another blob.";
    wrap.appendChild(el("p", "", flavor));

    // A run summary that counts its numbers up. Each cell reserves width so the
    // count-up never nudges the layout (tabular-nums keeps digits fixed-width too).
    const grid = el("div", "profile-grid");
    const counts: Array<{ node: HTMLElement; to: number; fmt: (v: number) => string }> = [];
    const asInt = (v: number) => String(Math.round(v));
    const stat = (label: string, to: number, fmt: (v: number) => string) => {
      const cell = el("div", "stat");
      cell.style.minWidth = "72px";
      const value = el("span", "stat-value", fmt(0));
      cell.append(value, el("span", "stat-label", label));
      grid.appendChild(cell);
      counts.push({ node: value, to, fmt });
    };
    stat("floor", result.floor, asInt);
    stat("kills", result.kills, asInt);
    stat("coins", result.coins, asInt);
    stat("time", result.durationMs / 1000, fmtClock);
    wrap.appendChild(grid);

    if (ctx.isNewBest) {
      const best = el("p", "", "\u2605 NEW BEST \u2014 your deepest run yet");
      best.style.color = "#ffb43b";
      best.style.fontWeight = "700";
      best.style.letterSpacing = "1px";
      wrap.appendChild(best);
    }
    for (const id of ctx.newUnlocks ?? []) {
      const def = cosmeticById(id);
      if (!def) continue;
      const line = el("p", "unlock-line", `\u2726 NEW COSMETIC UNLOCKED \u2014 ${def.name} (equip it in your closet)`);
      wrap.appendChild(line);
    }
    if (profile) {
      wrap.appendChild(el("p", "muted", `all-time \u2014 deepest floor ${profile.deepestFloor} \u00b7 ${profile.totalKills} kills \u00b7 ${profile.totalCoins} coins \u00b7 ${profile.gamesPlayed} runs`));
    }

    const row = el("div", "btnrow");
    let primary: () => void;
    let hint: string;
    const online = ctx.online;
    if (online && online.isActive && !online.isQuickPlay) {
      // Private room: the party regroups in the same lobby, same code, ready to go again.
      primary = () => { void online.reopen(); this.showOnlineLobby(online, profile); };
      const backBtn = el("button", "", "back to lobby \u21b5");
      backBtn.addEventListener("click", () => primary());
      const leaveBtn = el("button", "secondary", "leave room");
      leaveBtn.addEventListener("click", () => { online.leave(); void this.showTitle(); });
      row.append(backBtn, leaveBtn);
      hint = "press ENTER for the lobby";
    } else if (online) {
      // Quick play (or a room that ended underneath us): matchmake again.
      primary = () => void this.retryQuickPlayOnline(online);
      const again = el("button", "", "play again \u21b5");
      again.addEventListener("click", () => primary());
      const back = el("button", "secondary", "back to menu \u25b8");
      back.addEventListener("click", () => { online.leave(); void this.showTitle(); });
      row.append(again, back);
      hint = "press ENTER to play again";
    } else {
      // Solo: "play again" restarts a fresh solo run (the one-key retention loop).
      primary = () => this.doSolo();
      const again = el("button", "", "play again \u21b5");
      again.addEventListener("click", () => primary());
      const back = el("button", "secondary", "back to menu \u25b8");
      back.addEventListener("click", () => void this.showTitle());
      row.append(again, back);
      hint = "press ENTER or R to play again";
    }
    wrap.appendChild(row);

    // Contextual sign-in nudge: guests who just banked meaningful progress (a saved run —
    // extra pull when it earned a cosmetic) get ONE quiet pitch, session-latched and
    // cooldown-guarded. It renders with the screen (zero shift) and never takes focus.
    const nudge = this.signinNudgeBlock(profile, ctx);
    if (nudge) wrap.appendChild(nudge);

    wrap.appendChild(el("p", "hint", hint));

    this.show(wrap);
    this.runCountups(counts);

    // One-key retention loop: ENTER always triggers the primary action (R also, solo only).
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === "enter" || (k === "r" && !ctx.online)) { e.preventDefault(); primary(); }
    };
    this.gameOverKeys = onKey;
    window.addEventListener("keydown", onKey);
  }

  // The post-run guest nudge block, or null when the policy says stay quiet. Dismissing
  // swaps the content INSIDE the reserved block (no shift) and starts the persistent
  // cooldown; the buttons never receive focus automatically.
  private signinNudgeBlock(profile: ProfileDoc | null, ctx: GameOverContext): HTMLElement | null {
    const isEligible = shouldShowSigninNudge(localStorage, {
      isSignInAvailable: this.auth !== null,
      isSignedIn: this.auth?.isSignedIn ?? false,
      // Meaningful progress = the run actually saved (a dead backend makes the pitch hollow).
      hasMeaningfulProgress: profile !== null,
      isShownThisSession: this.isNudgeShownThisSession,
    });
    if (!isEligible) return null;
    this.isNudgeShownThisSession = true;

    const box = el("div", "nudge");
    const earned = (ctx.newUnlocks ?? []).map((id) => cosmeticById(id)?.name).filter((n): n is string => n !== undefined);
    const pitch = earned.length > 0
      ? `that ${earned[0]} you just earned only lives in this browser \u2014 ${SIGNIN_BENEFITS}`
      : `this run only lives in this browser \u2014 ${SIGNIN_BENEFITS}`;
    box.appendChild(el("p", "nudge-copy", pitch));
    const row = el("div", "nudge-row");
    const status = el("p", "muted auth-status");
    const signin = el("button", "secondary btn-google");
    signin.appendChild(googleMark());
    signin.appendChild(el("span", "", "Sign in with Google"));
    signin.addEventListener("click", () => void this.doSignIn(status));
    const later = el("button", "secondary nudge-later", "not now");
    later.addEventListener("click", () => {
      recordNudgeDismissed(localStorage);
      box.replaceChildren(el("p", "nudge-copy", "no problem \u2014 you can sign in anytime from the title screen"));
    });
    row.append(signin, later);
    box.append(row, status);
    return box;
  }

  // Leave the finished quick-play room and matchmake a fresh one in one motion.
  private async retryQuickPlayOnline(old: OnlineLobby) {
    if (!this.client) { await this.showTitle(); return; }
    old.leave();
    await this.showOnlineHome("finding a room\u2026");
    try {
      const profile = await this.session.login(this.session.name || "blob");
      const lobby = new OnlineLobby(this.client, this.session);
      await lobby.quickPlay();
      this.launchOnline(lobby, profile, false);
    } catch (err) {
      await this.showOnlineHome(this.cleanErr(err instanceof Error ? err.message : "could not find a room"));
    }
  }

  private runCountups(items: Array<{ node: HTMLElement; to: number; fmt: (v: number) => string }>, durationMs = 700) {
    cancelAnimationFrame(this.countupRaf);
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic — quick then settles
      for (const it of items) it.node.textContent = it.fmt(eased * it.to);
      if (t < 1) this.countupRaf = requestAnimationFrame(tick);
      else this.countupRaf = 0;
    };
    this.countupRaf = requestAnimationFrame(tick);
  }

  private cleanErr(msg: string): string {
    return msg.replace(/^\[.*?\]\s*/, "").replace(/^Uncaught Error:\s*/, "");
  }
}

// The Google "G" mark, inline so it needs no network fetch and stays crisp at any DPI.
function googleMark(): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 48 48");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const paths: Array<[string, string]> = [
    ["#EA4335", "M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"],
    ["#4285F4", "M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"],
    ["#FBBC05", "M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"],
    ["#34A853", "M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"],
  ];
  for (const [fill, d] of paths) {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("fill", fill);
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}
