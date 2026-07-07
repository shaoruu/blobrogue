import type { ConvexClient } from "convex/browser";
import type { Session } from "../net/session.js";
import type { AuthClient } from "../net/auth.js";
import type { ProfileDoc } from "../net/api.js";
import { api } from "../net/api.js";
import { Multiplayer } from "../net/multiplayer.js";
import type { RunResult } from "../game/game.js";
import { playerColor } from "../game/assets.js";
import { createSettingsControls } from "./settings.js";

export interface MenuHost {
  startSolo(profile: ProfileDoc | null): void;
  startCoop(mp: Multiplayer, profile: ProfileDoc | null): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const CONTROLS = "WASD move \u00b7 Mouse aim \u00b7 Click shoot \u00b7 Shift dash \u00b7 hold TAB for stats";

function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Drives everything shown in #overlay: the title/menu, the co-op lobby, and the
// game-over screen. It is the only place that knows whether multiplayer exists.
export class Menu {
  private overlay: HTMLElement;
  private session: Session;
  private client: ConvexClient | null;
  private auth: AuthClient | null;
  private host: MenuHost;
  private unsub: (() => void) | null = null;
  private countupRaf = 0;
  private gameOverKeys: ((e: KeyboardEvent) => void) | null = null;

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
  }

  async showTitle() {
    const wrap = el("div", "menu");

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
      // Offline build: no profile/co-op — single centered actions column, no split.
      const colA = el("div", "col-actions");
      colA.appendChild(this.soloButton("\u25be  PLAY"));
      colA.appendChild(el("p", "muted", "multiplayer offline \u2014 no server configured for this build"));
      wrap.appendChild(colA);
      wrap.appendChild(createSettingsControls());
    } else {
      const body = el("div", "body");

      // LEFT column: play actions.
      const colA = el("div", "col-actions");
      colA.appendChild(el("div", "col-h", "Play"));
      const quickBtn = el("button", "btn-quick primary");
      quickBtn.appendChild(el("span", "", "\u25b6 QUICK PLAY (CO-OP)"));
      quickBtn.appendChild(el("span", "sub", "jump into an open game \u2014 no code needed"));
      quickBtn.addEventListener("click", () => void this.doQuickPlay());
      colA.appendChild(quickBtn);
      const solo = this.soloButton("PLAY SOLO");
      solo.classList.add("play-solo");
      colA.appendChild(solo);
      const actrow = el("div", "actrow");
      const hostBtn = el("button", "secondary", "PRIVATE ROOM");
      hostBtn.addEventListener("click", () => void this.doHost());
      const joinBtn = el("button", "secondary", "JOIN CODE");
      joinBtn.addEventListener("click", () => void this.showJoin());
      actrow.append(hostBtn, joinBtn);
      colA.appendChild(actrow);
      body.appendChild(colA);

      // RIGHT column: identity (name or account) + profile + settings.
      const colB = el("div", "col-side");
      colB.appendChild(this.identitySection());
      const profileBox = el("div", "profile");
      colB.appendChild(profileBox);
      colB.appendChild(createSettingsControls());
      body.appendChild(colB);

      wrap.appendChild(body);
      void this.hydrateProfile(profileBox);
    }

    wrap.appendChild(el("p", "foot", CONTROLS));
    this.show(wrap);
  }

  private nameRow(): HTMLElement {
    const row = el("div", "namerow");
    const label = el("label", "", "name");
    const input = el("input");
    input.type = "text";
    input.maxLength = 20;
    input.placeholder = "your blob name";
    input.value = this.session.name;
    input.addEventListener("change", () => void this.session.login(input.value.trim() || "blob"));
    row.append(label, input);
    return row;
  }

  // The right-column identity block. Signed in: a Google account chip (avatar + name
  // + sign out). Signed out: the guest name input plus an optional "Sign in with
  // Google" button. Guest play is always available either way.
  private identitySection(): HTMLElement {
    const wrap = el("div", "identity");
    if (this.auth && this.auth.isSignedIn) {
      wrap.appendChild(this.accountChip());
    } else {
      wrap.appendChild(this.nameRow());
      if (this.auth) wrap.appendChild(this.googleRow());
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

  private googleRow(): HTMLElement {
    const wrap = el("div", "authrow");
    const btn = el("button", "secondary btn-google");
    btn.appendChild(googleMark());
    btn.appendChild(el("span", "", "Sign in with Google"));
    const status = el("p", "muted auth-status");
    btn.addEventListener("click", () => void this.doSignIn(status));
    wrap.append(btn, status);
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
    await this.showTitle();
  }

  private async hydrateProfile(box: HTMLElement) {
    // Signed in: always run the upsert so the account row exists (and any unowned
    // guest stats migrate) before the first run is recorded. Guest: unchanged.
    const signedIn = this.auth?.isSignedIn ?? false;
    const profile = (this.session.name || signedIn)
      ? await this.session.login(this.session.name || "blob")
      : await this.session.refreshProfile();
    if (!profile || profile.gamesPlayed === 0) return;
    box.replaceChildren();
    box.appendChild(el("div", "col-h", `${profile.name} \u2014 all time`));
    const grid = el("div", "profile-grid");
    const stat = (label: string, value: number) => {
      const cell = el("div", "stat");
      const v = el("span", "stat-value", String(value));
      if (label === "deepest") v.classList.add("amber");
      cell.appendChild(v);
      cell.appendChild(el("span", "stat-label", label));
      return cell;
    };
    grid.append(
      stat("deepest", profile.deepestFloor),
      stat("kills", profile.totalKills),
      stat("coins", profile.totalCoins),
      stat("runs", profile.gamesPlayed),
    );
    box.appendChild(grid);
  }

  private soloButton(label: string): HTMLButtonElement {
    const btn = el("button", "", label);
    btn.addEventListener("click", () => void this.doSolo());
    return btn;
  }

  private doSolo() {
    // Solo must never block on the network: kick off the (optional) identity
    // upsert in the background and start immediately with whatever profile we have.
    if (this.client) void this.session.login(this.session.name || "blob");
    this.host.startSolo(this.session.profile);
  }

  private async doQuickPlay() {
    if (!this.client) return;
    const status = this.busy("finding a game\u2026");
    try {
      const profile = await this.session.login(this.session.name || "blob");
      const mp = new Multiplayer(this.client, this.session);
      await mp.quickPlay();
      this.showLobby(mp, profile);
    } catch (err) {
      status.textContent = this.cleanErr(err instanceof Error ? err.message : "could not find a game");
    }
  }

  private async doHost() {
    if (!this.client) return;
    const status = this.busy("creating room\u2026");
    try {
      const profile = await this.session.login(this.session.name || "blob");
      const mp = new Multiplayer(this.client, this.session);
      await mp.host();
      this.showLobby(mp, profile);
    } catch (err) {
      status.textContent = this.cleanErr(err instanceof Error ? err.message : "could not create room");
    }
  }

  private async showJoin() {
    const wrap = el("div", "menu");
    wrap.appendChild(el("h1", "", "JOIN GAME"));
    wrap.appendChild(el("p", "", "Enter the 4-letter code your host shared."));
    const input = el("input", "code-input");
    input.type = "text";
    input.maxLength = 4;
    input.placeholder = "CODE";
    input.autocapitalize = "characters";
    input.addEventListener("input", () => (input.value = input.value.toUpperCase()));
    wrap.appendChild(input);
    const status = el("p", "muted");
    const row = el("div", "btnrow");
    const go = el("button", "", "join");
    go.addEventListener("click", () => void this.doJoin(input.value, status));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") void this.doJoin(input.value, status); });
    const back = el("button", "secondary", "back");
    back.addEventListener("click", () => void this.showTitle());
    row.append(go, back);
    wrap.append(row, status);
    this.show(wrap);
    input.focus();
  }

  private async doJoin(code: string, status: HTMLElement) {
    if (!this.client || code.trim().length < 4) { status.textContent = "enter a valid code"; return; }
    status.textContent = "joining\u2026";
    try {
      const profile = await this.session.login(this.session.name || "blob");
      const mp = new Multiplayer(this.client, this.session);
      await mp.join(code);
      this.showLobby(mp, profile);
    } catch (err) {
      status.textContent = this.cleanErr(err instanceof Error ? err.message : "could not join");
    }
  }

  private showLobby(mp: Multiplayer, profile: ProfileDoc | null) {
    const render = () => {
      // The host clicking "start" flips status to playing; everyone launches here.
      if (mp.status === "playing") {
        this.teardownLobby();
        this.host.startCoop(mp, profile);
        return;
      }
      if (mp.status === "ended") { void this.showTitle(); return; }

      const wrap = el("div", "menu");
      wrap.appendChild(el("h1", "", "CO-OP LOBBY"));
      wrap.appendChild(el("p", "", "Share this code with friends on the same build:"));
      wrap.appendChild(el("div", "code-badge", mp.code));

      const list = el("div", "playerlist");
      for (const p of mp.lobbyPlayers()) {
        const rowEl = el("div", "playerrow");
        const dot = el("span", "dot");
        dot.style.background = playerColor(p.colorIndex);
        rowEl.append(dot, el("span", "", `${p.name}${p.isHost ? " (host)" : ""}`));
        list.appendChild(rowEl);
      }
      wrap.appendChild(list);

      const row = el("div", "btnrow");
      if (mp.isHost) {
        const start = el("button", "", "\u25be  START RUN");
        start.addEventListener("click", () => void mp.startGame());
        row.appendChild(start);
      } else {
        wrap.appendChild(el("p", "muted", "waiting for the host to start\u2026"));
      }
      const leave = el("button", "secondary", "leave");
      leave.addEventListener("click", () => { mp.leave(); void this.showTitle(); });
      row.appendChild(leave);
      wrap.appendChild(row);
      wrap.appendChild(el("p", "hint", CONTROLS));

      this.overlay.classList.remove("hidden");
      this.overlay.replaceChildren(wrap);
    };

    this.teardownLobby();
    this.unsub = mp.onChange(render);
    render();
  }

  showGameOver(result: RunResult, profile: ProfileDoc | null, wasCoop: boolean, isNewBest: boolean) {
    const wrap = el("div", "menu");
    wrap.appendChild(el("h1", "died", "YOU DIED"));
    wrap.appendChild(el("p", "", wasCoop ? "The party fights on without you." : "The depths claim another blob."));

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

    if (isNewBest) {
      const best = el("p", "", "\u2605 NEW BEST \u2014 your deepest run yet");
      best.style.color = "#ffb43b";
      best.style.fontWeight = "700";
      best.style.letterSpacing = "1px";
      wrap.appendChild(best);
    }
    if (profile) {
      wrap.appendChild(el("p", "muted", `all-time \u2014 deepest floor ${profile.deepestFloor} \u00b7 ${profile.totalKills} kills \u00b7 ${profile.totalCoins} coins \u00b7 ${profile.gamesPlayed} runs`));
    }

    const row = el("div", "btnrow");
    // Solo: "play again" restarts a fresh solo run (the one-key retention loop).
    // Co-op: the party already ended, so restarting to a lone solo run would silently
    // yank the player out of co-op — instead offer a clear "back to menu" as primary.
    if (wasCoop) {
      const menuBtn = el("button", "", "back to menu \u21b5");
      menuBtn.addEventListener("click", () => void this.showTitle());
      const soloAgain = el("button", "secondary", "play solo");
      soloAgain.addEventListener("click", () => this.doSolo());
      row.append(menuBtn, soloAgain);
      wrap.appendChild(row);
      wrap.appendChild(el("p", "hint", "press ENTER for menu"));
    } else {
      const again = el("button", "", "play again \u21b5");
      again.addEventListener("click", () => this.doSolo());
      const back = el("button", "secondary", "back to menu \u25b8");
      back.addEventListener("click", () => void this.showTitle());
      row.append(again, back);
      wrap.appendChild(row);
      wrap.appendChild(el("p", "hint", "press ENTER or R to play again"));
    }

    this.show(wrap);
    this.runCountups(counts);

    // One-key retention loop. Solo → restart run; co-op → back to menu (don't force solo).
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (wasCoop) { if (k === "enter") { e.preventDefault(); void this.showTitle(); } }
      else if (k === "enter" || k === "r") { e.preventDefault(); this.doSolo(); }
    };
    this.gameOverKeys = onKey;
    window.addEventListener("keydown", onKey);
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

  private busy(text: string): HTMLElement {
    const wrap = el("div", "menu");
    wrap.appendChild(el("h1", "", "\u2026"));
    const status = el("p", "muted", text);
    wrap.appendChild(status);
    this.show(wrap);
    return status;
  }

  private cleanErr(msg: string): string {
    return msg.replace(/^\[.*?\]\s*/, "");
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
