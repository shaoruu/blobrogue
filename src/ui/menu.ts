import type { ConvexClient } from "convex/browser";
import type { Session } from "../net/session.js";
import type { AuthClient } from "../net/auth.js";
import type { ProfileDoc, LeaderboardEntryDoc } from "../net/api.js";
import { api } from "../net/api.js";
import { OnlineLobby } from "../net/onlineLobby.js";
import type { LobbyPlayer } from "../net/onlineLobby.js";
import type { RunResult } from "../game/game.js";
import { playerColor, PLAYER_COLORS } from "../game/assets.js";
import { resolveNameInput, rerollBlobName } from "../net/blobName.js";
import { WEAPONS } from "../sim/weapons.js";
import { itemById } from "../sim/items.js";
import { COSMETIC_SLOTS, cosmeticsForSlot, cosmeticById, isCosmeticOwned, bodyPaletteIndex } from "../game/cosmetics.js";
import type { CosmeticSlot, CosmeticDef, CosmeticLoadout } from "../game/cosmetics.js";
import { cosmeticOverlay } from "../game/cosmeticArt.js";
import { createBlobPreview } from "./blobPreview.js";
import type { BlobLook, BlobPreview } from "./blobPreview.js";
import { FocusScope, currentFocus } from "./focus.js";
import { createSettingsControls } from "./settings.js";
import { shouldShowSigninNudge, recordNudgeShown, recordNudgeDismissed, SIGNIN_BENEFITS } from "./signinNudge.js";
import {
  READY_LABEL, NOT_READY_LABEL, START_ANYWAY_IDLE, START_ANYWAY_HOLD_MS, startAnywayHoldLabel,
  COPY_INVITE_LABEL, INVITE_COPIED_LABEL, INVITE_SHARED_LABEL, INVITE_COPY_FAILED_LABEL, INVITE_SHARE_HINT,
  INVITE_RUN_LIVE_NOTE, INVITE_UNREACHABLE_NOTE, inviteJoiningNote, inviteFailNote,
} from "./onlineCopy.js";
import { inviteUrlFor, shareInviteUrl } from "../net/inviteLink.js";

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
  // A leaderboard row index waiting to receive focus once the next fill enables it
  // (Back/Escape from a player profile restores focus to the exact row that opened it).
  private pendingLbRowFocus: number | null = null;
  // Last fetched leaderboard, kept for the session so revisits paint instantly (a background
  // refresh still runs) — the cached/uncached paths render the SAME fixed geometry.
  private lbCache: LeaderboardEntryDoc[] | null = null;
  // The per-session latch of the post-run sign-in nudge (never nag twice in one sitting).
  private isNudgeShownThisSession = false;
  // The title's live identity region: auth settling (an OAuth exchange finishing after the
  // shell painted) re-renders CONTENT inside this reserved box — never the shell around it.
  private identityMount: HTMLElement | null = null;
  // The title's character stage refresh: identity hydration, auth settle, and every
  // closet equip repaint the blob inside its fixed box (content only — the hero band
  // never moves). The preview handle itself is kept so the idle loop can be paused
  // while the title is hidden (in-run) or covered by the closet overlay.
  private titleStageRefresh: (() => void) | null = null;
  private titleStage: BlobPreview | null = null;
  // The current screen's tab group for controller LB/RB (closet categories, profile views).
  private tabCycle: ((dir: 1 | -1) => void) | null = null;

  constructor(overlay: HTMLElement, session: Session, client: ConvexClient | null, auth: AuthClient | null, host: MenuHost) {
    this.overlay = overlay;
    this.session = session;
    this.client = client;
    this.auth = auth;
    this.host = host;
    // Auth state settles asynchronously only on the post-OAuth boot; swap the identity
    // region's content in place when it does (same reserved geometry, zero layout shift).
    this.auth?.onChange(() => {
      if (this.identityMount) this.renderIdentityInto(this.identityMount);
      // A settled sign-in can carry a different loadout — re-hydrate and repaint the stage.
      if (this.titleStageRefresh) void this.flushTitleIdentity().then(() => this.titleStageRefresh?.());
    });
  }

  hide() {
    this.teardownLobby();
    // The title (and its idle loop) is fully covered while a run plays — park the rAF.
    this.titleStage?.setPaused(true);
    this.overlay.classList.add("hidden");
  }

  private show(...nodes: HTMLElement[]) {
    this.teardownLobby();
    this.identityMount = null;     // the title re-arms it after its own show()
    this.titleStageRefresh = null; // idem
    this.titleStage = null;
    this.tabCycle = null;          // screens with tab groups re-arm after their own show()
    this.overlay.classList.remove("hidden");
    this.overlay.replaceChildren(...nodes);
  }

  // Controller LB/RB entry point (bound by main.ts through the menu gamepad adapter).
  cycleTabs(dir: 1 | -1): void {
    this.tabCycle?.(dir);
  }

  // The always-visible close affordance on the profile surfaces (the mobile-friendly \u2715
  // in the shell corner). Same action as Back/Escape.
  private closeButton(onClose: () => void): HTMLButtonElement {
    const btn = el("button", "secondary panel-close", "\u2715");
    btn.type = "button";
    btn.setAttribute("aria-label", "close");
    btn.onclick = onClose;
    return btn;
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
    // THE canonical home markup (finalized; supersedes every earlier shell variant):
    //   .menu-home                       grid rows 150px / minmax(0,1fr)
    //     .home-hero                     the two-column hero band: .hero-mark (logo +
    //                                    tagline) | .blob-stage (the 132x132 identity
    //                                    showpiece: YOUR blob at 96px via the shared
    //                                    loadout renderer, calm idle, plinth glow +
    //                                    ground shadow — no button chrome, no amber)
    //     .home-body
    //       .home-left                   PLAY ONLINE, PLAY SOLO, fixed .home-status
    //                                    line, fixed leaderboard preview (exactly 3
    //                                    rows + state line)
    //       .home-right                  reserved .identity-card, then the PROFILE and
    //                                    SETTINGS destinations
    //     .stage-customize               the small closet door beside the blob —
    //                                    absolutely anchored into the hero band, DOM-last
    //                                    so PLAY stays first in tab/reading order
    // No home footer, no Controls button, no right-side Leaderboard destination.
    const wrap = el("div", "menu menu-home");
    const focusTargets = new Map<string, HTMLButtonElement>();

    // HERO BAND. Left: the wordmark (intrinsic 1128x192 logo so its box is reserved
    // before the file streams in) + tagline. Right: the blob stage — an identity
    // SHOWPIECE, not a control: no button affordance, no amber fill, no arrow. Play
    // Online below remains the only amber-filled element and the first action.
    const hero = el("div", "home-hero");
    const mark = el("div", "hero-mark");
    const logo = document.createElement("img");
    logo.src = "/ui/logo.png";
    logo.className = "logo-img";
    logo.alt = "BLOBROGUE";
    logo.width = 1128;
    logo.height = 192;
    mark.appendChild(logo);
    mark.appendChild(el("p", "tag", "An amber cowboy-blob lost in the depths. Blast your way down as far as you can \u2014 solo, or with friends."));
    hero.appendChild(mark);
    const stageBox = el("div", "blob-stage");
    stageBox.setAttribute("role", "img");
    stageBox.setAttribute("aria-label", this.stageLabel());
    const stagePreview = createBlobPreview(lookOf(this.session.cosmetics, this.session.colorIndex), 96, { isCalmIdle: true });
    stageBox.appendChild(stagePreview.el);
    hero.appendChild(stageBox);
    wrap.appendChild(hero);
    // The natural place to tap your guy: a small, quiet closet door beside the blob. It
    // opens the closet as an OVERLAY — the title (and Play) never leaves the screen.
    // Appended to the wrap LAST (absolute position anchors it into the hero band).
    const customize = el("button", "secondary stage-customize", "CUSTOMIZE");
    customize.type = "button";
    customize.onclick = () => this.openClosetOverlay();
    // Hydration repaints the blob inside the same fixed bounds — content only, zero shift.
    // (Armed after show(); show() clears the previous screen's hook.)
    const refreshStage = () => {
      stagePreview.setLook(lookOf(this.session.cosmetics, this.session.colorIndex));
      stageBox.setAttribute("aria-label", this.stageLabel());
    };

    if (!this.client) {
      // Offline build: no profile/multiplayer — single actions column under the same
      // hero band (the closet saves on this device).
      const left = el("div", "home-left");
      left.appendChild(this.soloButton("\u25be  PLAY"));
      left.appendChild(el("p", "muted", "multiplayer offline \u2014 no server configured for this build"));
      const nav = el("div", "navrow");
      const profileBtn = this.navButton("PROFILE", "your blob, stats & closet", () => void this.showProfile());
      const settingsBtn = this.navButton("SETTINGS", "controls, audio & accessibility", () => void this.showSettings());
      focusTargets.set("profile", profileBtn);
      focusTargets.set("settings", settingsBtn);
      nav.append(profileBtn, settingsBtn);
      left.appendChild(nav);
      wrap.appendChild(left);
      wrap.appendChild(customize);
      this.show(wrap);
      this.titleStageRefresh = refreshStage;
      this.titleStage = stagePreview;
      if (focus?.dest) focusTargets.get(focus.dest)?.focus();
      return;
    }

    const body = el("div", "home-body");

    // LEFT: the play actions own the top (first in DOM/tab order — the eye drops from
    // the hero blob straight onto them); a fixed status line and the quiet leaderboard
    // glance fill the space under them (fixed row geometry, subordinate to Play).
    const left = el("div", "home-left");
    const onlineBtn = el("button", "btn-quick primary");
    onlineBtn.appendChild(el("span", "", "\u25b6 PLAY ONLINE"));
    onlineBtn.appendChild(el("span", "sub", "rooms & quick play on the live server"));
    onlineBtn.addEventListener("click", () => void this.showOnlineHome());
    focusTargets.set("online", onlineBtn);
    left.appendChild(onlineBtn);
    const solo = this.soloButton("PLAY SOLO");
    solo.classList.add("play-solo");
    left.appendChild(solo);
    // The fixed home status line: reserved from first paint; any boot/exit note swaps
    // content inside it, never the layout around it.
    left.appendChild(el("p", "home-status", ""));
    left.appendChild(this.leaderboardPreview(focusTargets));
    body.appendChild(left);

    // RIGHT: the reserved identity card, then the PROFILE / SETTINGS destinations (the
    // leaderboard's explicit door is the VIEW LEADERBOARD action on the glance itself).
    const right = el("div", "home-right");
    const identity = this.identitySection();
    right.appendChild(identity);
    const nav = el("div", "navrow");
    const profileBtn = this.navButton("PROFILE", "your blob, stats & closet", () => void this.showProfile());
    const settingsBtn = this.navButton("SETTINGS", "controls, audio & accessibility", () => void this.showSettings());
    focusTargets.set("profile", profileBtn);
    focusTargets.set("settings", settingsBtn);
    nav.append(profileBtn, settingsBtn);
    right.appendChild(nav);
    body.appendChild(right);

    wrap.appendChild(body);
    wrap.appendChild(customize);
    this.show(wrap);
    this.identityMount = identity;
    this.titleStageRefresh = refreshStage;
    this.titleStage = stagePreview;
    // Background identity flush (login/adoption) — no home UI depends on its timing; the
    // stage repaints in place once the profile's loadout lands.
    void this.flushTitleIdentity().then(() => this.titleStageRefresh?.());
    // Back/Escape focus restore: land keyboard focus on the destination that was used
    // (or arm the leaderboard-row restore, consumed once the preview fill enables it).
    if (focus?.dest) focusTargets.get(focus.dest)?.focus();
    if (focus?.lbRow !== undefined) this.pendingLbRowFocus = focus.lbRow;
  }

  // The title's one hydration duty: flush/adopt the identity row (name, color, cosmetics)
  // so lobby tickets and the profile surfaces never race a stale write. Never lets an
  // unreachable backend break the home screen. The session always holds a real name (typed
  // or the generated default), so this is a plain login.
  private async flushTitleIdentity() {
    try {
      await this.session.login();
    } catch {
      // the home shell stands
    }
  }

  // The stage's accessible description (the accepted copy, exactly): "Your blob", or
  // "Your blob wearing <hat>, <glasses>" when overlay cosmetics are equipped.
  private stageLabel(): string {
    const loadout = this.session.cosmetics;
    const worn = [loadout.hat, loadout.face]
      .map((id) => (id !== null ? cosmeticById(id)?.name : undefined))
      .filter((name): name is string => name !== undefined);
    return worn.length > 0 ? `Your blob wearing ${worn.join(", ")}` : "Your blob";
  }

  // A 90px home destination card: the label leads (and IS the button's own text, so focus
  // tooling reads it plainly), the sub-copy rides underneath.
  private navButton(label: string, sub: string, go: () => void): HTMLButtonElement {
    const btn = el("button", "secondary nav-btn home-dest", label);
    btn.appendChild(el("span", "dest-sub", sub));
    btn.addEventListener("click", go);
    return btn;
  }

  // The editable blob name on the own Overview. Guests edit + SAVE anytime — the write
  // rides the SAME sanitized session.login path the name gate uses (trim/collapse/strip,
  // cap 20, never empty, never the literal "blob"), so lobby rosters and future
  // leaderboard rows pick the new name up. Signed-in accounts are named by Google on the
  // server (ensurePlayer overwrites with the account name), so the field goes READ-ONLY
  // with honest copy — an editable box that silently reverts would be a lie.
  private nameEditor(onSaved: (name: string) => void): { box: HTMLElement; input: HTMLInputElement } {
    const box = el("div", "pc-nameedit");
    box.appendChild(el("label", "col-h", "blob name"));
    const row = el("div", "pc-namerow");
    const input = el("input", "pc-nameinput");
    input.type = "text";
    input.maxLength = 20;
    input.placeholder = "your blob name";
    input.value = this.session.name;
    const note = el("p", "muted pc-name-note", "");
    if (this.auth?.isSignedIn ?? false) {
      input.disabled = true;
      note.textContent = "named by your Google account";
      row.appendChild(input);
    } else {
      note.textContent = "shows in lobbies & on the leaderboard";
      const save = el("button", "secondary pc-name-save", "SAVE");
      save.type = "button";
      // An emptied/junk input keeps the standing name (typed or generated) — a profile
      // edit can never blank a name or resurrect the literal "blob".
      const commit = async () => {
        const name = resolveNameInput(input.value, this.session.name);
        input.value = name;
        save.disabled = true;
        note.textContent = "saving\u2026";
        const profile = await this.session.login(name).catch(() => null);
        save.disabled = false;
        note.textContent = !this.client
          ? "saved on this device"
          : profile !== null
            ? "saved \u2014 shows in lobbies & future runs"
            : "saved on this device \u2014 syncs when you're online";
        onSaved(this.session.name);
      };
      save.onclick = () => void commit();
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") void commit(); });
      row.append(input, save);
    }
    box.append(row, note);
    return { box, input };
  }

  // The right-column identity card. Signed in: the Google account chip + a quiet
  // confirmation of what the account holds. Signed out: the guest name input plus the
  // sign-in CTA with its concrete benefits. Mid-OAuth (back from Google with ?code=): a
  // quiet "signing you in" placeholder that settles into chip or CTA. ALL states render
  // inside the SAME reserved geometry (.identity min-height), content-swapped in place —
  // and guest play is never gated on signing in.
  private identitySection(): HTMLElement {
    const wrap = el("div", "identity-card");
    this.renderIdentityInto(wrap);
    return wrap;
  }

  // The identity card's states share ONE 112px reserved box (108px mobile), all right-
  // column-only and visually junior to Play (no amber fill, no pulse, no glow):
  //   guest      — SAVE YOUR BLOB / value copy / SIGN IN WITH GOOGLE / "Optional" note
  //   busy       — the CTA reads OPENING GOOGLE… (Play stays enabled throughout)
  //   error      — the note says guest progress is still safe; the CTA becomes TRY AGAIN;
  //                a cancelled sign-in simply restores this guest card — no punishment
  //   signed-in  — avatar/name chip, "Progress saved across devices", VIEW PROFILE
  //                (sign-out lives in Profile, never here)
  private renderIdentityInto(wrap: HTMLElement) {
    wrap.replaceChildren();
    const isSignedIn = this.auth?.isSignedIn ?? false;
    const isPending = !isSignedIn && (this.auth?.isCompletingSignIn ?? false);
    // The guest frame reads STRONGER than an ordinary panel (dun-4 keyline) but stays
    // dark — it can never beat the amber Play stack at thumbnail scale.
    wrap.classList.toggle("guest", !isSignedIn);

    // One 42px+1fr, three-track grid for EVERY state (loading/guest/busy/error/account):
    // the fixed 40px bright patch (Google mark / avatar), the title+value tracks, and the
    // full-width action strip with its note. Content swaps; the grid never moves.
    const patch = el("div", "id-patch");
    const title = el("div", "id-title");
    const value = el("p", "id-value");
    const actions = el("div", "id-actions");
    const note = el("p", "id-note");
    wrap.append(patch, title, value, actions);

    if (isSignedIn) {
      const av = document.createElement("img");
      av.className = "id-avatar";
      av.alt = "";
      av.width = 40;
      av.height = 40;
      patch.appendChild(av);
      title.textContent = this.session.name || "signed in";
      void this.hydrateAccount(av, title);
      value.textContent = "Progress saved across devices";
      const view = el("button", "secondary id-view", "VIEW PROFILE ▸");
      view.type = "button";
      view.onclick = () => void this.showProfile();
      note.textContent = "Signed in with Google";
      actions.append(view, note);
      return;
    }

    patch.appendChild(googleMark(22));
    title.textContent = "SAVE YOUR BLOB";
    value.textContent = isPending
      ? "signing you in with Google…"
      : "Keep progress, cosmetics, and ranked runs across devices.";
    note.textContent = isPending
      ? "back from Google — finishing up."
      : "Optional · Play anytime as guest.";
    if (this.auth) {
      const cta = el("button", "secondary btn-google");
      cta.type = "button";
      const label = el("span", "", isPending ? "SIGNING YOU IN…" : "SIGN IN WITH GOOGLE");
      cta.appendChild(label);
      cta.disabled = isPending;
      cta.onclick = () => void this.doSignIn(cta, label, note);
      actions.appendChild(cta);
    }
    actions.appendChild(note);
  }

  // The account chip is pure DISPLAY (avatar + name). Sign-out lives on the own-profile
  // Overview — account management belongs to the profile surface, not the launchpad.
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
    box.append(av, info);
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

  // Kick off the redirect. Busy/error states swap CONTENT inside the same boxes: the CTA
  // label flips to OPENING GOOGLE\u2026 (Play is never disabled), a failure flips it to TRY
  // AGAIN with the note reassuring that guest progress is untouched.
  private async doSignIn(cta: HTMLButtonElement, label: HTMLElement, note: HTMLElement) {
    if (!this.auth) return;
    label.textContent = "OPENING GOOGLE\u2026";
    cta.disabled = true;
    try {
      await this.auth.signInWithGoogle();
      // On success the browser navigates to Google; control returns via ?code=.
    } catch (err) {
      label.textContent = "TRY AGAIN";
      cta.disabled = false;
      note.textContent = "Sign-in didn\u2019t complete \u2014 your guest progress is still safe.";
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
    if (this.client) void this.session.login().catch(() => {});
    this.host.startSolo(this.session.profile);
  }

  // ---- LEADERBOARD ------------------------------------------------------------------
  //
  // Both surfaces (the title preview and the full screen) build their FINAL row geometry
  // up front — fixed-height skeleton rows that fill in place — so hydration can never move
  // the play buttons or steal focus. Rows are disabled until they hold a real entry.

  private leaderboardRows(count: number): { box: HTMLElement; rows: HTMLButtonElement[] } {
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
        el("span", "lb-arrow", "\u203a"),
      );
      rows.push(row);
      box.appendChild(row);
    }
    return { box, rows };
  }

  private fillLeaderboardRows(rows: HTMLButtonElement[], setNote: (text: string) => void, entries: LeaderboardEntryDoc[] | null, backTo: (rowIndex: number) => void) {
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
      // Safe anonymized fallback: a blank/whitespace name (private or degenerate row)
      // renders as an anonymous blob, never an empty or raw-data label.
      const displayName = entry.name.trim() || "anonymous blob";
      name.textContent = displayName;
      floor.textContent = `FL ${entry.floor}`;
      row.disabled = false;
      row.setAttribute("aria-label", `${displayName} \u2014 floor ${entry.floor} \u2014 view profile`);
      row.onclick = () => this.showPlayerProfile(entry, i + 1, () => backTo(i));
    }
    if (entries === null) setNote("leaderboard unavailable \u2014 check your connection");
    else if (entries.length === 0) setNote("no runs on the board yet \u2014 yours could be first");
    else setNote("");
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

  // The title's compact preview — the accepted FIXED shape (154px total, reserved from
  // first paint): the GLOBAL LEADERBOARD header with the explicit VIEW LEADERBOARD action
  // (also the Back/Escape focus-restore target), exactly LB_PREVIEW_ROWS 28px rows, and ONE
  // 18px state line shared by the board-level states (offline/empty — they win) and the
  // player's own rank when it sits outside the visible rows. Hydration replaces contents
  // only — no node is ever inserted or removed. The preview is NEVER collapsed or hidden:
  // short viewports scroll the home in document order with Play first (see index.html).
  private leaderboardPreview(focusTargets?: Map<string, HTMLButtonElement>): HTMLElement {
    const panel = el("div", "lb-preview");
    const head = el("div", "lb-head");
    head.appendChild(el("span", "col-h", "Global leaderboard"));
    const view = el("button", "secondary lb-view", "VIEW LEADERBOARD \u25b8");
    view.addEventListener("click", () => void this.showLeaderboard());
    focusTargets?.set("leaderboard", view);
    head.appendChild(view);
    panel.appendChild(head);
    const { box, rows } = this.leaderboardRows(LB_PREVIEW_ROWS);
    const stateLine = el("p", "lb-standing", "");
    panel.append(box, stateLine);

    // The shared state line: a board-level message (offline/empty) always outranks the
    // own-rank readout; both write through here so the single 18px box never fights.
    const line = { board: "", rank: "" };
    const renderLine = () => { stateLine.textContent = line.board || line.rank; };
    const setBoardNote = (text: string) => { line.board = text; renderLine(); };
    const setRank = (text: string) => { line.rank = text; renderLine(); };

    const backTo = (rowIndex: number) => void this.showTitle({ lbRow: rowIndex });
    if (this.lbCache) this.fillLeaderboardRows(rows, setBoardNote, this.lbCache, backTo);
    // A stalled fetch (backend unreachable — never rejects, just hangs) surfaces the
    // unavailable note in place unless a cached board is already showing.
    const onStall = () => { if (!this.lbCache) this.fillLeaderboardRows(rows, setBoardNote, null, backTo); };
    void this.fetchLeaderboard(onStall).then((entries) => this.fillLeaderboardRows(rows, setBoardNote, entries, backTo));
    void this.hydrateStanding(setRank);
    return panel;
  }

  // Fill the reserved own-rank readout: only when the caller's charted best sits OUTSIDE
  // the preview rows (inside them, their name is already on the board). Every failure/
  // absence path leaves it empty — the box is fixed either way.
  private async hydrateStanding(setRank: (text: string) => void) {
    if (!this.client) return;
    try {
      const s = await this.client.query(api.leaderboard.standing, { clientId: this.session.clientId });
      if (!s || (s.rank !== null && s.rank <= LB_PREVIEW_ROWS)) { setRank(""); return; }
      setRank(s.rank !== null
        ? `your best \u00b7 FL ${s.floor} \u00b7 rank #${s.rank}`
        : `your best \u00b7 FL ${s.floor} \u00b7 below the top 50`);
    } catch {
      setRank("");
    }
  }

  // The full leaderboard destination. `focusRow` restores keyboard focus to the row a
  // player-profile visit came from.
  async showLeaderboard(focusRow?: number) {
    if (!this.client) { await this.showTitle(); return; }
    const wrap = el("div", "menu");
    wrap.appendChild(el("h1", "", "LEADERBOARD"));
    wrap.appendChild(el("p", "", "The deepest runs on record. Pick a blob to see their look and their run's build."));
    const { box, rows } = this.leaderboardRows(LB_FULL_ROWS);
    box.classList.add("lb-rows-full");
    const note = el("p", "muted lb-note", "");
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
    const setNote = (text: string) => { note.textContent = text; };
    const backTo = (rowIndex: number) => void this.showLeaderboard(rowIndex);
    if (this.lbCache) this.fillLeaderboardRows(rows, setNote, this.lbCache, backTo);
    const onStall = () => { if (!this.lbCache) this.fillLeaderboardRows(rows, setNote, null, backTo); };
    void this.fetchLeaderboard(onStall).then((entries) => this.fillLeaderboardRows(rows, setNote, entries, backTo));
  }

  // ---- the shared profile card -----------------------------------------------------------
  //
  // ONE fixed-geometry surface (~640x430 desktop) for every profile view, own or read-only.
  // Attention order: (1) the 192px appearance stage + name on the left, (2) the ranked Top
  // Run + exact build on the right, (3) lifetime stats last. Every region is reserved from
  // first paint — loading/private/no-snapshot states swap content inside identical boxes.
  private profileCard(look: BlobLook, name: string, title: string | null): {
    card: HTMLElement;
    setLook: (look: BlobLook) => void;
    nameEl: HTMLElement;
    titleEl: HTMLElement;
    rankEl: HTMLElement;
    leftSlot: HTMLElement;
    setTopRun: (entry: { floor: number; kills: number; coins: number; durationMs: number } | null) => void;
    setBuild: (build: { weapons: string[]; items: Array<{ id: string; count: number }> } | null, emptyNote: string) => void;
    setLifetime: (p: { deepestFloor: number; totalKills: number; totalCoins: number; gamesPlayed: number } | { note: string }) => void;
  } {
    const card = el("div", "profile-card");

    // LEFT: the appearance stage (fixed 192), then name / worn title / rank line.
    const left = el("div", "pc-left");
    const stage = el("div", "blob-stage");
    const preview = createBlobPreview(look, 192);
    stage.appendChild(preview.el);
    const nameEl = el("div", "pc-name", (name.trim() || "anonymous blob").toUpperCase());
    const titleEl = el("p", "worn-title", titleTextOf(title));
    const rankEl = el("p", "pc-rank", "");
    const leftSlot = el("div", "pc-left-slot");
    left.append(stage, nameEl, titleEl, rankEl, leftSlot);

    // RIGHT: top run, the exact run build, then lifetime.
    const right = el("div", "pc-right");
    right.appendChild(el("div", "col-h", "top run"));
    const runGrid = el("div", "profile-grid pc-run");
    const runCells = new Map<string, HTMLElement>();
    for (const label of ["floor", "kills", "coins", "time"]) {
      const cell = el("div", "stat");
      const v = el("span", "stat-value skel", "\u2014");
      if (label === "floor") v.classList.add("amber");
      cell.append(v, el("span", "stat-label", label));
      runCells.set(label, v);
      runGrid.appendChild(cell);
    }
    right.appendChild(runGrid);
    right.appendChild(el("div", "col-h", "that run's build"));
    const build = el("div", "build-strip pc-build");
    right.appendChild(build);
    right.appendChild(el("div", "col-h", "lifetime \u2014 all time"));
    const lifetime = el("div", "pc-lifetime");
    right.appendChild(lifetime);

    card.append(left, right);

    const setTopRun = (entry: { floor: number; kills: number; coins: number; durationMs: number } | null) => {
      runCells.forEach((v) => v.classList.remove("skel"));
      runCells.get("floor")!.textContent = entry ? String(entry.floor) : "\u2014";
      runCells.get("kills")!.textContent = entry ? String(entry.kills) : "\u2014";
      runCells.get("coins")!.textContent = entry ? String(entry.coins) : "\u2014";
      runCells.get("time")!.textContent = entry && entry.durationMs > 0 ? fmtClock(entry.durationMs / 1000) : "\u2014";
    };
    const setBuild = (b: { weapons: string[]; items: Array<{ id: string; count: number }> } | null, emptyNote: string) => {
      build.replaceChildren();
      if (!b || (b.weapons.length === 0 && b.items.length === 0)) {
        build.appendChild(el("span", "muted", emptyNote));
        return;
      }
      for (const id of b.weapons) build.appendChild(el("span", "build-chip weapon", weaponName(id)));
      for (const it of b.items) {
        const def = itemById(it.id);
        const label = def ? (it.count > 1 ? `${def.name} Lv${it.count}` : def.name) : it.id;
        const chip = el("span", "build-chip", label);
        if (def) chip.style.setProperty("--t", def.tint);
        build.appendChild(chip);
      }
    };
    const setLifetime = (p: { deepestFloor: number; totalKills: number; totalCoins: number; gamesPlayed: number } | { note: string }) => {
      lifetime.replaceChildren();
      if ("note" in p) {
        lifetime.appendChild(el("p", "muted pc-life-note", p.note));
        return;
      }
      const grid = el("div", "profile-grid pc-life");
      const stat = (label: string, value: number) => {
        const cell = el("div", "stat");
        cell.append(el("span", "stat-value", String(value)), el("span", "stat-label", label));
        grid.appendChild(cell);
      };
      stat("deepest", p.deepestFloor);
      stat("kills", p.totalKills);
      stat("coins", p.totalCoins);
      stat("runs", p.gamesPlayed);
      lifetime.appendChild(grid);
    };

    return { card, setLook: (l) => preview.setLook(l), nameEl, titleEl, rankEl, leftSlot, setTopRun, setBuild, setLifetime };
  }

  // A leaderboard player's READ-ONLY profile: their blob's look and that run's snapshot.
  // Only leaderboard-entry data renders here — name/appearance/run stats, nothing
  // account-side, and no edit controls of any kind.
  showPlayerProfile(entry: LeaderboardEntryDoc, rank: number, onBack: () => void) {
    const wrap = el("div", "menu");
    wrap.appendChild(this.closeButton(() => onBack()));
    wrap.appendChild(el("div", "col-h pc-context", "player profile \u2014 read only"));
    const look = lookOf({ hat: entry.hat, face: entry.face, body: entry.body, title: entry.title }, entry.colorIndex);
    const card = this.profileCard(look, entry.name, entry.title);
    card.rankEl.textContent = `rank #${rank} \u00b7 best FL ${entry.floor}`;
    card.setTopRun(entry);
    // The build is ALWAYS the trusted historical snapshot from the charted run — never the
    // player's current loadout. An old row recorded before build capture says so honestly.
    card.setBuild(entry, "RUN BUILD NOT SAVED");
    // Lifetime stats are each blob's own business — the public schema carries run data only.
    card.setLifetime({ note: "lifetime stats are private to each blob" });
    wrap.appendChild(card.card);

    const row = el("div", "btnrow");
    const back = el("button", "secondary", "back");
    back.addEventListener("click", () => onBack());
    row.appendChild(back);
    wrap.appendChild(row);
    this.show(wrap);
    this.bindEscape(onBack);
  }

  // ---- OWN PROFILE (Overview + Closet on the SAME surface) --------------------------------
  //
  // The player's own destination reuses the read-only profile card, plus what only an owner
  // gets: the CUSTOMIZE BLOB door, the Overview/Closet views, and the account controls
  // (the account chip + sign-out live HERE, not on the title). The Closet carries every
  // SHIPPED cosmetic slot (COSMETIC_SLOTS) with explicit equipped/owned/locked states —
  // trophies you wear, purely visual, achievement-unlocked.

  async showProfile(view: "overview" | "closet" = "overview") {
    const wrap = el("div", "menu");
    const tabs = el("div", "pc-tabs");
    const overviewTab = el("button", `secondary pc-tab${view === "overview" ? " on" : ""}`, "OVERVIEW");
    const closetTab = el("button", `secondary pc-tab${view === "closet" ? " on" : ""}`, "CLOSET");
    tabs.append(overviewTab, closetTab);
    wrap.appendChild(tabs);

    const goBack = () => void this.showTitle({ dest: "profile" });

    // Closing (back, Escape/B, the Overview tab, the close \u2715) just closes: equips are
    // instant and already persisted in the background, so there is never anything to
    // discard and never a confirmation in the way.
    let closetTabCycle: ((dir: 1 | -1) => void) | null = null;
    if (view === "overview") this.buildOwnOverview(wrap);
    else closetTabCycle = this.buildCloset(wrap).cycleCategory;
    wrap.prepend(this.closeButton(goBack));

    overviewTab.onclick = () => { if (view !== "overview") void this.showProfile("overview"); };
    closetTab.onclick = () => { if (view !== "closet") void this.showProfile("closet"); };

    const row = el("div", "btnrow");
    const back = el("button", "secondary", "back");
    back.addEventListener("click", goBack);
    row.appendChild(back);
    wrap.appendChild(row);
    this.show(wrap);
    this.bindEscape(goBack);
    // Controller LB/RB: closet cycles its categories; the Overview toggles the views.
    this.tabCycle = closetTabCycle ?? (() => void this.showProfile("closet"));

    if (view === "overview") void this.hydrateOwnOverview();
    else void this.hydrateCloset();
  }

  // The Overview: the shared profile card with the owner's extras. Every async region
  // hydrates inside its reserved box (top run + build from the caller's own charted entry,
  // lifetime from the profile), and unavailable states stay honest.
  private ownCard: ReturnType<Menu["profileCard"]> | null = null;
  private ownNameInput: HTMLInputElement | null = null;

  private buildOwnOverview(wrap: HTMLElement) {
    const card = this.profileCard(
      lookOf(this.session.cosmetics, this.session.colorIndex),
      this.session.name,
      this.session.cosmetics.title,
    );
    this.ownCard = card;
    // The username editor lives ON the card, right under the appearance stage — the
    // owner's identity block (name + look) in one place, above the closet door.
    const editor = this.nameEditor((name) => {
      card.nameEl.textContent = (name.trim() || "blob").toUpperCase();
    });
    this.ownNameInput = editor.input;
    const customize = el("button", "secondary pc-customize", "CUSTOMIZE BLOB");
    customize.addEventListener("click", () => void this.showProfile("closet"));
    card.leftSlot.append(editor.box, customize);
    wrap.appendChild(card.card);

    // The account region (owner-only): chip + sign-out for accounts, the honest guest /
    // offline line otherwise. Reserved height either way. (Name edits live on the card
    // above — this strip is purely the account relationship.)
    const account = el("div", "pc-account");
    if (this.auth?.isSignedIn) {
      account.appendChild(this.accountChip());
      const out = el("button", "secondary account-out", "sign out");
      out.addEventListener("click", () => void this.doSignOut());
      account.appendChild(out);
    } else {
      // The manual sign-in door is ALWAYS available here regardless of any nudge cooldown.
      if (this.auth) {
        const note = el("p", "muted id-note", "Optional \u00b7 keeps this blob across devices.");
        const cta = el("button", "secondary btn-google pc-signin");
        cta.type = "button";
        cta.appendChild(googleMark());
        const label = el("span", "", "SIGN IN WITH GOOGLE");
        cta.appendChild(label);
        cta.onclick = () => void this.doSignIn(cta, label, note);
        account.append(cta, note);
      } else {
        account.appendChild(el("p", "muted id-note",
          this.client
            ? "playing as guest \u2014 sign in to keep this blob across devices"
            : "offline build \u2014 your closet is saved on this device"));
      }
    }
    wrap.appendChild(account);
  }

  private async hydrateOwnOverview() {
    const card = this.ownCard;
    if (!card) return;
    if (!this.client) {
      card.setTopRun(null);
      card.setBuild(null, "no charted run yet \u2014 go on down");
      card.setLifetime({ note: "stats live on the server \u2014 offline build" });
      return;
    }
    // Lifetime (and identity adoption) from the profile row; card regions fill in place.
    try {
      const profile = await this.session.login();
      if (profile) {
        card.nameEl.textContent = (profile.name.trim() || "anonymous blob").toUpperCase();
        card.titleEl.textContent = titleTextOf(profile.cosmetics.title);
        card.setLook(lookOf(this.session.cosmetics, this.session.colorIndex));
        card.setLifetime(profile);
        // Sync the name editor in place: accounts adopt the server's (Google) name; a
        // guest's field follows the session unless they're mid-edit right now.
        if (this.ownNameInput) {
          if (this.auth?.isSignedIn ?? false) this.ownNameInput.value = profile.name;
          else if (document.activeElement !== this.ownNameInput) this.ownNameInput.value = this.session.name;
        }
      }
    } catch {
      card.setLifetime({ note: "stats unavailable \u2014 check your connection" });
    }
    // The caller's own charted best (same public shape a leaderboard click renders).
    try {
      const mine = await this.client.query(api.leaderboard.mine, { clientId: this.session.clientId });
      if (mine) {
        card.rankEl.textContent = mine.rank !== null
          ? `rank #${mine.rank} \u00b7 best FL ${mine.entry.floor}`
          : `best FL ${mine.entry.floor} \u00b7 below the top 50`;
        card.setTopRun(mine.entry);
        card.setBuild(mine.entry, "RUN BUILD NOT SAVED");
      } else {
        card.rankEl.textContent = "no charted run yet";
        card.setTopRun(null);
        card.setBuild(null, "no charted run yet \u2014 go on down");
      }
    } catch {
      card.setTopRun(null);
      card.setBuild(null, "top run unavailable \u2014 check your connection");
    }
  }

  // ---- THE CLOSET (own-profile-only, fixed panel) ------------------------------------
  //
  // INSTANT EQUIP — there is no staging model, no save step, nothing to discard:
  //   - clicking/tapping/A/Enter an OWNED card equips it IMMEDIATELY: the stage updates,
  //     the card wears the unmistakable EQUIPPED state (chip text + persistent \u2713 badge +
  //     the amber double frame + 3px lift), the category's previous card loses it
  //   - persistence is OPTIMISTIC: the local apply is instant, the server write runs in
  //     the background (a tiny corner spinner rides the card while in flight); success is
  //     silent, FAILURE reverts stage + badge to the previously-equipped item with one
  //     non-blocking inline message. Rapid switching is last-click-wins via a per-slot
  //     sequence, so a slow earlier response can never override a newer pick.
  //   - clicking the already-equipped card is a no-op; closing just closes.
  // Categories are REAL only: a slot renders a tab only while it has items (future slots
  // stay hidden until populated). LOCKED cards are never equippable but stay FOCUSABLE so
  // the condition is readable — the chip IS the exact configured condition, activation
  // reads it out inline. Card states are distinguished by geometry + glyph + text, never
  // hue alone. The mirror renders through the same shared loadout renderer as the world.

  private closetRefresh: (() => void) | null = null;

  private readSeenUnlocks(): string[] {
    try {
      const raw = localStorage.getItem("blobrogue.closet.seenUnlocks");
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }

  private markSeenUnlocks(unlocks: readonly string[]) {
    try { localStorage.setItem("blobrogue.closet.seenUnlocks", JSON.stringify(unlocks)); } catch { /* ignore */ }
  }

  private buildCloset(wrap: HTMLElement): { cycleCategory: (dir: 1 | -1) => void } {
    const categories = COSMETIC_SLOTS.filter((slotDef) => cosmeticsForSlot(slotDef.slot).length > 0);
    let active: CosmeticSlot = categories[0]?.slot ?? "hat";
    // NEW badges: real unlocks earned since the last closet visit (marked seen on open).
    const seenAtOpen = this.readSeenUnlocks();
    const isNewUnlock = (id: string) =>
      (this.session.profile?.unlocks ?? []).includes(id) && !seenAtOpen.includes(id);

    const panel = el("div", "closet-panel");
    const stage = el("div", "closet-stage");
    const preview = createBlobPreview(lookOf(this.session.cosmetics, this.session.colorIndex), 128);
    stage.appendChild(preview.el);
    panel.appendChild(stage);

    const rightCol = el("div", "closet-right");
    const cats = el("div", "closet-cats");
    const grid = el("div", "closet-grid");
    // The ONE inline message line (reserved height): the failure revert notice and the
    // locked-condition readout swap text here — nothing modal, nothing moves.
    const note = el("p", "muted closet-note", "");
    rightCol.append(cats, grid, note);
    panel.appendChild(rightCol);
    wrap.appendChild(panel);

    const unlocks = () => this.session.profile?.unlocks ?? [];
    const equippedOf = (slot: CosmeticSlot) => this.session.cosmetics[slot];
    // ONE shared loadout state (the session) drives every stage: the closet mirror AND —
    // when the closet rides as an overlay above the title — the title blob, live.
    const syncStage = () => {
      preview.setLook(lookOf(this.session.cosmetics, this.session.colorIndex));
      this.titleStageRefresh?.();
    };

    // Optimistic-equip bookkeeping: a per-slot sequence makes rapid switching last-click-
    // wins (a stale response is simply ignored), and the in-flight pick wears the corner
    // spinner while its background write runs.
    const equipSeq = new Map<CosmeticSlot, number>();
    const inFlight = new Map<CosmeticSlot, string | null>();

    const equip = (id: string | null) => {
      const slot = active;
      if (equippedOf(slot) === id) return; // selecting the equipped item is a no-op
      const token = (equipSeq.get(slot) ?? 0) + 1;
      equipSeq.set(slot, token);
      const prevId = equippedOf(slot);
      const prevColor = this.session.colorIndex;
      inFlight.set(slot, id);
      note.textContent = "";
      // Apply locally NOW (stage + badge move immediately); persist in the background.
      const persist = slot === "body"
        ? this.session.setColorIndex(id !== null ? cosmeticById(id)?.paletteIndex ?? 0 : 0)
        : this.session.setCosmetic(slot, id);
      renderAll();
      void persist.then((isSaved) => {
        if (equipSeq.get(slot) !== token) return; // a newer pick owns this slot
        inFlight.delete(slot);
        // isKept covers the server-authority reconcile: a write the backend refused has
        // already been rolled back by the session and must read as a failure here too.
        const isKept = equippedOf(slot) === id;
        if (!isSaved) {
          if (slot === "body") this.session.revertColor(prevColor, prevId);
          else this.session.revertCosmetic(slot, prevId);
        }
        if (!isSaved || !isKept) note.textContent = "COULDN'T SAVE \u2014 REVERTED";
        renderAll();
      });
    };

    const renderCats = () => {
      cats.replaceChildren();
      for (const slotDef of categories) {
        const tab = el("button", `secondary closet-cat${slotDef.slot === active ? " on" : ""}`, slotDef.label);
        tab.type = "button";
        tab.onclick = () => { active = slotDef.slot; note.textContent = ""; renderAll(); };
        cats.appendChild(tab);
      }
    };

    const cardIcon = (def: CosmeticDef | null): HTMLElement => {
      const icon = el("span", "cos-icon");
      if (def?.slot === "body" || (def === null && active === "body")) {
        const swatch = el("span", "cos-swatch");
        swatch.style.background = playerColor(def?.paletteIndex ?? 0);
        icon.appendChild(swatch);
        return icon;
      }
      const art = def ? cosmeticOverlay(def.id) : null;
      if (art) {
        const mini = document.createElement("canvas");
        mini.width = 40; mini.height = 40;
        const g = mini.getContext("2d");
        if (g) { g.imageSmoothingEnabled = false; g.drawImage(art, 0, 0, 40, 40); }
        icon.appendChild(mini);
      } else {
        icon.textContent = def?.slot === "title" ? "\u2726" : "\u25cf";
      }
      return icon;
    };

    // One card. State language: .cos-card owned|equipped|locked, the .cos-check badge,
    // the .cos-lock glyph, the .cos-saving corner spinner — states read by GEOMETRY +
    // GLYPH + TEXT (double frame, lift, badge, chip copy), never hue alone.
    const addCard = (def: CosmeticDef | null, label: string) => {
      const id = def?.id ?? null;
      const isLocked = def !== null && !isCosmeticOwned(def, unlocks());
      const isEquipped = equippedOf(active) === id;
      const isSaving = inFlight.has(active) && (inFlight.get(active) ?? null) === id;
      const condition = def?.hint ?? "secret";
      const btn = el("button", `cos-card ${isLocked ? "locked" : isEquipped ? "equipped" : "owned"}`);
      btn.type = "button";
      btn.setAttribute("aria-pressed", String(isEquipped));
      if (isLocked) btn.appendChild(el("span", "cos-lock"));
      if (isEquipped) btn.appendChild(el("span", "cos-check", "\u2713"));
      btn.append(cardIcon(def), el("span", "cos-name", label));
      // The chip: EQUIPPED, the exact unlock condition (locked), or the one-visit NEW tag.
      const chip = isLocked
        ? condition.toUpperCase()
        : isEquipped ? "EQUIPPED" : isNewUnlock(id ?? "") ? "NEW" : "";
      btn.appendChild(el("span", "cos-chip", chip));
      if (isSaving) btn.appendChild(el("span", "cos-saving"));
      btn.setAttribute("aria-label", isLocked
        ? `${label}, locked \u2014 ${condition}`
        : `${label}${isEquipped ? ", equipped" : ""}`);
      // Locked cards stay focusable/clickable so the condition is readable everywhere —
      // activation READS the condition inline, it never equips.
      btn.onclick = () => {
        if (isLocked) { note.textContent = `LOCKED \u2014 ${condition.toUpperCase()}`; return; }
        equip(id);
      };
      grid.appendChild(btn);
    };

    const renderGrid = () => {
      grid.replaceChildren();
      const slotDef = categories.find((c) => c.slot === active);
      // The always-owned DEFAULT/NONE card leads every category.
      addCard(null, slotDef?.noneLabel ?? "None");
      for (const def of cosmeticsForSlot(active)) addCard(def, def.name);
    };

    const renderAll = () => { renderCats(); renderGrid(); syncStage(); };
    renderAll();
    this.closetRefresh = renderAll;
    // This visit's NEW badges are computed — mark everything seen for the next visit.
    this.markSeenUnlocks(unlocks());

    // Controller LB/RB parity: cycle the real categories.
    const cycleCategory = (dir: 1 | -1) => {
      const idx = categories.findIndex((c) => c.slot === active);
      const next = categories[(idx + dir + categories.length) % categories.length];
      if (next) { active = next.slot; note.textContent = ""; renderAll(); }
    };

    return { cycleCategory };
  }

  private async hydrateCloset() {
    // Refresh unlock states in place (fixed geometry; a dead backend just leaves the
    // locked states standing, never an error screen).
    if (!this.client) return;
    try {
      await this.session.login();
      this.closetRefresh?.();
      this.markSeenUnlocks(this.session.profile?.unlocks ?? []);
    } catch {
      // locked states stand
    }
  }

  // ---- the closet OVERLAY (the title's CUSTOMIZE affordance) ---------------------------
  // The closet rides ABOVE the title as a panel — never a mode swap: Play stays on screen
  // behind the translucent scrim, and closing (X / Esc / B / scrim tap) returns to the
  // SAME title nodes with only the blob repainted. There is nothing else to sync back:
  // instant equip already saved every change server-side as it happened.
  private openClosetOverlay() {
    const scrim = el("div", "closet-scrim");
    const pop = el("div", "menu closet-pop");
    const scope = new FocusScope();
    let isClosed = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
    };
    const close = () => {
      if (isClosed) return;
      isClosed = true;
      window.removeEventListener("keydown", onKey);
      this.overlay.removeChild(scrim);
      this.closetRefresh = null;
      this.tabCycle = null;
      this.titleStageRefresh?.(); // the unchanged title, wearing the updated blob
      this.titleStage?.setPaused(false); // the idle loop resumes with the title
      scope.close();
    };
    scrim.addEventListener("click", (e) => { if (e.target === scrim) close(); });
    const closeBtn = this.closeButton(close);
    pop.appendChild(closeBtn);
    pop.appendChild(el("div", "col-h closet-pop-h", "closet \u2014 changes save instantly"));
    const closet = this.buildCloset(pop);
    scrim.appendChild(pop);
    this.overlay.appendChild(scrim);
    window.addEventListener("keydown", onKey);
    this.tabCycle = closet.cycleCategory;
    // The covered title parks its idle loop; equips still repaint it live (static frames)
    // through titleStageRefresh, so the blob behind the scrim visibly updates.
    this.titleStage?.setPaused(true);
    scope.open(closeBtn, currentFocus());
    void this.hydrateCloset();
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

  // The ONE-TIME identity gate before a guest's first online start: name + color committed
  // together in the canonical menu shell, so the ticket/roster identity teammates see is
  // explicit and confirmed — never the generated default by accident, never the literal
  // "blob". Signed-in players (Google name) and already-confirmed guests skip it entirely;
  // it never appears on the title or for solo.
  private needsNameGate(): boolean {
    return !(this.auth?.isSignedIn ?? false) && !this.session.isNameConfirmed;
  }

  private showNameGate() {
    const wrap = el("div", "menu name-gate");
    wrap.appendChild(el("h1", "", "WHAT'S YOUR NAME?"));
    wrap.appendChild(el("p", "", "Teammates will see this in your run."));

    const nameRow = el("div", "gate-namerow");
    const input = el("input", "gate-name");
    input.type = "text";
    input.maxLength = 20;
    input.value = this.session.name;
    input.setAttribute("aria-label", "your blob name");
    input.addEventListener("focus", () => input.select());
    const dice = el("button", "secondary gate-dice", "\u{1F3B2}");
    dice.type = "button";
    dice.setAttribute("aria-label", "shuffle name");
    let roll = 0;
    dice.onclick = () => {
      input.value = rerollBlobName(this.session.clientId, ++roll, input.value);
    };
    nameRow.append(input, dice);
    wrap.appendChild(nameRow);

    // The color pick lives HERE too — one place sets the whole online identity before the
    // first join. The live preview renders through the shared blob renderer, and the
    // selected swatch is marked by GEOMETRY (check glyph + inset ring), never hue alone.
    let selected = this.session.colorIndex ?? 0;
    const colorRow = el("div", "gate-colorrow");
    const preview = createBlobPreview(this.gateLook(selected), 96);
    colorRow.appendChild(preview.el);
    const swatches = el("div", "swatch-row");
    swatches.setAttribute("role", "radiogroup");
    swatches.setAttribute("aria-label", "blob color");
    const renderSwatches = () => {
      swatches.replaceChildren();
      for (let i = 0; i < PLAYER_COLORS.length; i++) {
        const isSel = i === selected;
        const btn = el("button", `swatch${isSel ? " sel" : ""}`);
        btn.type = "button";
        btn.style.background = playerColor(i);
        btn.setAttribute("aria-pressed", String(isSel));
        btn.setAttribute("aria-label", `blob color ${i + 1}${isSel ? " — selected" : ""}`);
        btn.appendChild(el("span", "swatch-check", isSel ? "\u2713" : ""));
        btn.onclick = () => {
          selected = i;
          preview.setLook(this.gateLook(selected));
          renderSwatches();
        };
        swatches.appendChild(btn);
      }
    };
    renderSwatches();
    colorRow.appendChild(swatches);
    wrap.appendChild(colorRow);

    const proceed = () => {
      // The typed name wins; junk/empty keeps the generated default — never empty, never
      // the literal "blob". Color + name commit together and the flush is CHAINED: every
      // room operation and ticket mint awaits it, so the run is joined as exactly this
      // confirmed identity.
      const name = resolveNameInput(input.value, this.session.name);
      this.session.setColorIndex(selected);
      this.session.markNameConfirmed();
      void this.session.login(name).catch(() => {});
      void this.showOnlineHome();
    };
    const row = el("div", "btnrow");
    const play = el("button", "", "PLAY ONLINE \u25b8");
    play.onclick = proceed;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") proceed(); });
    const goBack = () => void this.showTitle({ dest: "online" });
    const back = el("button", "secondary", "back");
    back.onclick = goBack;
    row.append(play, back);
    wrap.appendChild(row);
    wrap.appendChild(el("p", "muted", "You can change this later in Profile."));

    this.show(wrap);
    this.bindEscape(goBack);
    input.focus();
  }

  // The gate preview's render look: the candidate party color (0 = the natural amber
  // sprite) under the player's already-equipped overlay cosmetics.
  private gateLook(colorIndex: number): BlobLook {
    const cosmetics = this.session.cosmetics;
    return { colorIndex: colorIndex > 0 ? colorIndex : null, hat: cosmetics.hat, face: cosmetics.face };
  }

  // The online home: quick play into the public pool, create a private room (shareable
  // code), or join a friend's code. Every action stays on this screen until it succeeds,
  // so a failed backend just writes a status line — never a dead end. `isBusy` renders
  // the actions disabled from first paint (an invite join in flight owns the screen until
  // it settles — the settle re-arms them, success or failure).
  async showOnlineHome(note = "", opts: { isBusy?: boolean } = {}) {
    if (!this.client) { await this.showTitle(); return; }
    if (this.needsNameGate()) { this.showNameGate(); return; }
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
    if (opts.isBusy) buttons.forEach((b) => (b.disabled = true));
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

  // An invite link's landing (cold boot in main.ts, warm popstate arrivals — same door).
  // Routes straight into that room's lobby with the join in flight: the online home paints
  // busy with "joining room CODE…" while the SAME server-validated rooms.join a typed code
  // takes runs underneath (capacity, kind, ended — nothing bypassed). Guests join through
  // the ordinary ensurePlayer identity; an invite never forces sign-in. Every failure
  // settles THIS screen with a specific reason and the live quick-play/join actions.
  async openInvite(code: string): Promise<void> {
    if (!this.client) { await this.showTitle(); return; }
    await this.showOnlineHome(inviteJoiningNote(code), { isBusy: true });
    const client = this.client;
    // An unreachable backend never REJECTS (the Convex client retries forever) — it just
    // never resolves. Settle honestly after the hydrate window; a join landing later must
    // not teleport the player, so it leaves the room it silently won.
    let isSettled = false;
    const timer = setTimeout(() => {
      isSettled = true;
      void this.showOnlineHome(INVITE_UNREACHABLE_NOTE);
    }, HYDRATE_TIMEOUT_MS);
    try {
      const profile = await this.session.login();
      const lobby = new OnlineLobby(client, this.session);
      await lobby.join(code);
      clearTimeout(timer);
      if (isSettled) { lobby.leave(); return; }
      // A live room is a JOINABLE room (drop-in): land in the lobby with the honest note —
      // REJOIN RUN is right there. A cold link never yanks anyone straight into gameplay.
      this.showOnlineLobby(lobby, profile, lobby.status === "playing" ? INVITE_RUN_LIVE_NOTE : "");
    } catch (err) {
      clearTimeout(timer);
      if (isSettled) return;
      await this.showOnlineHome(inviteFailNote(this.cleanErr(err instanceof Error ? err.message : "")));
    }
  }

  private async doQuickPlayOnline(setBusy: (b: boolean, t: string) => void) {
    if (!this.client) return;
    setBusy(true, "finding a room\u2026");
    try {
      const profile = await this.session.login();
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
      const profile = await this.session.login();
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
      const profile = await this.session.login();
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
      // The header confirms the identity THIS player joins as (the same swatch + name the
      // ticket carries), so a wrong color/name is caught before the run, not during it.
      const you = el("div", "lobby-you");
      const youSwatch = el("span", "you-swatch");
      youSwatch.style.background = playerColor(this.session.colorIndex ?? 0);
      you.append(el("span", "you-label", "YOU:"), youSwatch, el("span", "you-name", this.session.name));
      wrap.appendChild(you);
      wrap.appendChild(el("p", "", INVITE_SHARE_HINT));
      // The code badge + the one-tap invite share, one fixed row. Every feedback state
      // swaps the button's LABEL inside its fixed width; the reserved line underneath
      // only ever fills on a copy failure (the raw URL, shareable by hand) — the roster
      // below never moves.
      const codeRow = el("div", "code-row");
      codeRow.appendChild(el("div", "code-badge", lobby.code));
      const inviteUrlLine = el("p", "muted invite-url", "");
      const invite = el("button", "secondary invite-copy", COPY_INVITE_LABEL);
      invite.type = "button";
      invite.onclick = () => void this.doCopyInvite(lobby.code, invite, inviteUrlLine);
      codeRow.appendChild(invite);
      wrap.appendChild(codeRow);
      wrap.appendChild(inviteUrlLine);

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

  // One tap shares the FULL invite URL (/r/<CODE>), not just the code: the native share
  // sheet on touch devices, the clipboard everywhere else. The confirmation is honest per
  // outcome — a dismissed share sheet copied nothing, so it confirms nothing — and every
  // state swaps content inside the fixed button/line geometry. Node-local with a timed
  // revert: a roster re-render simply rebuilds the idle control.
  private async doCopyInvite(code: string, btn: HTMLButtonElement, urlLine: HTMLElement): Promise<void> {
    const url = inviteUrlFor(code, window.location.origin);
    btn.disabled = true;
    const outcome = await shareInviteUrl(url);
    btn.disabled = false;
    if (outcome === "dismissed") { btn.textContent = COPY_INVITE_LABEL; return; }
    if (outcome === "failed") {
      btn.textContent = INVITE_COPY_FAILED_LABEL;
      urlLine.textContent = url;
      return;
    }
    btn.textContent = outcome === "shared" ? INVITE_SHARED_LABEL : INVITE_COPIED_LABEL;
    setTimeout(() => { btn.textContent = COPY_INVITE_LABEL; }, 1600);
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
    // cooldown-guarded, placed AFTER the run stats and unlock reveal in reading order.
    // It renders with the screen (zero shift) and never takes focus.
    const nudge = this.signinNudgeBlock(result, profile, ctx);
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
  private signinNudgeBlock(result: RunResult, profile: ProfileDoc | null, ctx: GameOverContext): HTMLElement | null {
    const isEligible = shouldShowSigninNudge(localStorage, {
      isSignInAvailable: this.auth !== null,
      isSignedIn: this.auth?.isSignedIn ?? false,
      // Meaningful progress = the run actually saved (a dead backend makes the pitch hollow).
      hasMeaningfulProgress: profile !== null,
      isShownThisSession: this.isNudgeShownThisSession,
    });
    if (!isEligible) return null;
    this.isNudgeShownThisSession = true;
    recordNudgeShown(localStorage); // merely seeing it starts the shown-cooldown

    const box = el("div", "nudge");
    // The pitch names the ACTUAL unsynced value: the cosmetic this run earned, else the
    // concrete run that was just banked on this browser only.
    const earned = (ctx.newUnlocks ?? []).map((id) => cosmeticById(id)?.name).filter((n): n is string => n !== undefined);
    const pitch = earned.length > 0
      ? `that ${earned[0]} you just earned only lives in this browser \u2014 ${SIGNIN_BENEFITS}`
      : `your floor ${result.floor} run only lives in this browser \u2014 ${SIGNIN_BENEFITS}`;
    box.appendChild(el("p", "nudge-copy", pitch));
    const row = el("div", "nudge-row");
    const status = el("p", "muted auth-status");
    const signin = el("button", "secondary btn-google");
    signin.appendChild(googleMark());
    const signinLabel = el("span", "", "Sign in with Google");
    signin.appendChild(signinLabel);
    signin.addEventListener("click", () => void this.doSignIn(signin, signinLabel, status));
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
      const profile = await this.session.login();
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
function googleMark(size = 16): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 48 48");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
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
