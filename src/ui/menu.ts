import type { ConvexClient } from "convex/browser";
import type { Session } from "../net/session.js";
import type { AuthClient } from "../net/auth.js";
import type { ProfileDoc } from "../net/api.js";
import { api } from "../net/api.js";
import { Multiplayer } from "../net/multiplayer.js";
import { OnlineLobby } from "../net/onlineLobby.js";
import type { RunResult } from "../game/game.js";
import { playerColor, PLAYER_COLORS } from "../game/assets.js";
import { createSettingsControls } from "./settings.js";

export interface MenuHost {
  startSolo(profile: ProfileDoc | null): void;
  startCoop(mp: Multiplayer, profile: ProfileDoc | null): void;
  startOnline(lobby: OnlineLobby, profile: ProfileDoc | null): void;
}

// Context for the game-over screen: which flow the run came from decides the retry action.
export interface GameOverContext {
  wasCoop: boolean;
  isNewBest: boolean;
  online: OnlineLobby | null;
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

// Drives everything shown in #overlay: the title/menu, the online lobby, the classic co-op
// lobby, and the game-over screen. It is the only place that knows whether multiplayer exists.
export class Menu {
  private overlay: HTMLElement;
  private session: Session;
  private client: ConvexClient | null;
  private auth: AuthClient | null;
  private host: MenuHost;
  private unsub: (() => void) | null = null;
  private countupRaf = 0;
  private gameOverKeys: ((e: KeyboardEvent) => void) | null = null;
  private syncColorRow: (() => void) | null = null;

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
      // Offline build: no profile/multiplayer — single centered actions column, no split.
      const colA = el("div", "col-actions");
      colA.appendChild(this.soloButton("\u25be  PLAY"));
      colA.appendChild(el("p", "muted", "multiplayer offline \u2014 no server configured for this build"));
      wrap.appendChild(colA);
      wrap.appendChild(createSettingsControls());
    } else {
      const body = el("div", "body");

      // LEFT column: play actions. Online (the authoritative server) is the headline;
      // solo below it; the classic peer-synced co-op keeps its own door underneath.
      const colA = el("div", "col-actions");
      colA.appendChild(el("div", "col-h", "Play"));
      const onlineBtn = el("button", "btn-quick primary");
      onlineBtn.appendChild(el("span", "", "\u25b6 PLAY ONLINE"));
      onlineBtn.appendChild(el("span", "sub", "rooms & quick play on the live server"));
      onlineBtn.addEventListener("click", () => void this.showOnlineHome());
      colA.appendChild(onlineBtn);
      const solo = this.soloButton("PLAY SOLO");
      solo.classList.add("play-solo");
      colA.appendChild(solo);
      // One multiplayer product path only: authoritative PLAY ONLINE. The legacy peer-synced
      // path produced separate enemy/drop simulations and confused players into thinking they
      // shared a world, so it is intentionally removed from the front door.
      body.appendChild(colA);

      // RIGHT column: identity (name, blob color, account) + profile + settings.
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
    input.addEventListener("change", () => void this.session.login(input.value.trim() || "blob").catch(() => {}));
    row.append(label, input);
    return row;
  }

  // The blob-color pick: one swatch per palette slot. Slot 0 (amber) is the natural
  // sprite; any other pick tints your blob everywhere (solo + online) and is persisted
  // (locally always, onto the profile when the backend is reachable).
  private colorRow(): HTMLElement {
    const row = el("div", "namerow");
    row.appendChild(el("label", "", "blob color"));
    const swatches = el("div", "swatches");
    const buttons: HTMLButtonElement[] = [];
    const sync = () => {
      const current = this.session.colorIndex ?? 0;
      buttons.forEach((b, i) => b.classList.toggle("sel", i === current));
    };
    for (let i = 0; i < PLAYER_COLORS.length; i++) {
      const b = el("button", "swatch");
      b.type = "button";
      b.style.background = PLAYER_COLORS[i];
      b.title = i === 0 ? "amber (classic)" : "";
      b.addEventListener("click", () => { this.session.setColorIndex(i); sync(); });
      buttons.push(b);
      swatches.appendChild(b);
    }
    sync();
    this.syncColorRow = sync;
    row.appendChild(swatches);
    return row;
  }

  // The right-column identity block. Signed in: a Google account chip (avatar + name
  // + sign out). Signed out: the guest name input plus an optional "Sign in with
  // Google" button. Guest play is always available either way; the blob-color pick
  // shows for both.
  private identitySection(): HTMLElement {
    const wrap = el("div", "identity");
    if (this.auth && this.auth.isSignedIn) {
      wrap.appendChild(this.accountChip());
    } else {
      wrap.appendChild(this.nameRow());
    }
    wrap.appendChild(this.colorRow());
    if (this.auth && !this.auth.isSignedIn) wrap.appendChild(this.googleRow());
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
    // Never let an unreachable backend break the title screen.
    let profile: ProfileDoc | null = null;
    try {
      const signedIn = this.auth?.isSignedIn ?? false;
      profile = (this.session.name || signedIn)
        ? await this.session.login(this.session.name || "blob")
        : await this.session.refreshProfile();
    } catch {
      return;
    }
    // Login may have adopted an account's saved color pick; reflect it in the swatches.
    this.syncColorRow?.();
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
    btn.addEventListener("click", () => this.doSolo());
    return btn;
  }

  private doSolo() {
    // Solo must never block on the network: kick off the (optional) identity
    // upsert in the background and start immediately with whatever profile we have.
    if (this.client) void this.session.login(this.session.name || "blob").catch(() => {});
    this.host.startSolo(this.session.profile);
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

    const status = el("p", "muted", note);
    wrap.appendChild(status);

    const row = el("div", "btnrow");
    const back = el("button", "secondary", "back");
    back.addEventListener("click", () => void this.showTitle());
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
  }

  private async doQuickPlayOnline(setBusy: (b: boolean, t: string) => void) {
    if (!this.client) return;
    setBusy(true, "finding a room\u2026");
    try {
      const profile = await this.session.login(this.session.name || "blob");
      const lobby = new OnlineLobby(this.client, this.session);
      await lobby.quickPlay();
      // The public pool has no start gate: the room is live, drop straight in.
      this.launchOnline(lobby, profile);
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
      if (lobby.status === "playing") this.launchOnline(lobby, profile);
      else this.showOnlineLobby(lobby, profile);
    } catch (err) {
      status.textContent = this.cleanErr(err instanceof Error ? err.message : "could not join");
    }
  }

  private launchOnline(lobby: OnlineLobby, profile: ProfileDoc | null) {
    this.teardownLobby();
    this.host.startOnline(lobby, profile);
  }

  // The room lobby: the shareable code, who's here (names + colors, host tag), and the
  // start/waiting/rejoin control. Re-renders on every roster/status change.
  showOnlineLobby(lobby: OnlineLobby, profile: ProfileDoc | null, note = "") {
    let prevStatus = lobby.status;
    const render = () => {
      if (lobby.status === "ended") { lobby.leave(); void this.showTitle(); return; }
      // The host pressing START flips the room live; everyone waiting launches together.
      // (Only on the transition — re-opening this screen mid-run shows REJOIN instead.)
      if (lobby.status === "playing" && prevStatus === "lobby") { this.launchOnline(lobby, profile); return; }
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
        list.appendChild(rowEl);
      }
      wrap.appendChild(list);
      wrap.appendChild(el("p", "muted", `${players.length} player${players.length === 1 ? "" : "s"} in the room`));

      const row = el("div", "btnrow");
      if (lobby.status === "playing") {
        // A run is live in this room (e.g. you stepped out mid-run) — jump back in.
        const rejoin = el("button", "", "\u25be  REJOIN RUN");
        rejoin.addEventListener("click", () => this.launchOnline(lobby, profile));
        row.appendChild(rejoin);
      } else if (lobby.isHost) {
        const start = el("button", "", "\u25be  START RUN");
        start.addEventListener("click", () => void lobby.start().catch(() => {}));
        row.appendChild(start);
      } else {
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

  // ---- CLASSIC CO-OP (peer-synced, the original path — fully preserved) --------------

  async showClassicCoop() {
    if (!this.client) { await this.showTitle(); return; }
    const wrap = el("div", "menu");
    wrap.appendChild(el("h1", "", "CLASSIC CO-OP"));
    wrap.appendChild(el("p", "", "The original peer-synced co-op \u2014 everyone runs the same dungeon side by side."));

    const colA = el("div", "col-actions");
    const quickBtn = el("button", "btn-quick primary");
    quickBtn.appendChild(el("span", "", "\u25b6 QUICK PLAY (CO-OP)"));
    quickBtn.appendChild(el("span", "sub", "jump into an open game \u2014 no code needed"));
    quickBtn.addEventListener("click", () => void this.doQuickPlay());
    colA.appendChild(quickBtn);
    const actrow = el("div", "actrow");
    const hostBtn = el("button", "secondary", "PRIVATE ROOM");
    hostBtn.addEventListener("click", () => void this.doHost());
    const joinBtn = el("button", "secondary", "JOIN CODE");
    joinBtn.addEventListener("click", () => void this.showJoinScreen({
      title: "JOIN GAME",
      hint: "Enter the 4-letter code your host shared.",
      onBack: () => void this.showClassicCoop(),
      onJoin: (code, status) => void this.doJoin(code, status),
    }));
    actrow.append(hostBtn, joinBtn);
    colA.appendChild(actrow);
    wrap.appendChild(colA);

    const row = el("div", "btnrow");
    const back = el("button", "secondary", "back");
    back.addEventListener("click", () => void this.showTitle());
    row.appendChild(back);
    wrap.appendChild(row);

    this.show(wrap);
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

  // Shared join-by-code screen (classic co-op and online rooms use the same 4-letter codes).
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
    const status = el("p", "muted");
    const row = el("div", "btnrow");
    const go = el("button", "", "join");
    go.addEventListener("click", () => opts.onJoin(input.value, status));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") opts.onJoin(input.value, status); });
    const back = el("button", "secondary", "back");
    back.addEventListener("click", () => opts.onBack());
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

  showGameOver(result: RunResult, profile: ProfileDoc | null, ctx: GameOverContext) {
    const wrap = el("div", "menu");
    wrap.appendChild(el("h1", "died", "YOU DIED"));
    const flavor = ctx.online
      ? "The run is over \u2014 regroup and go again."
      : ctx.wasCoop ? "The party fights on without you." : "The depths claim another blob.";
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
    } else if (ctx.wasCoop) {
      // Co-op: the party already ended, so restarting to a lone solo run would silently
      // yank the player out of co-op — instead offer a clear "back to menu" as primary.
      primary = () => void this.showTitle();
      const menuBtn = el("button", "", "back to menu \u21b5");
      menuBtn.addEventListener("click", () => primary());
      const soloAgain = el("button", "secondary", "play solo");
      soloAgain.addEventListener("click", () => this.doSolo());
      row.append(menuBtn, soloAgain);
      hint = "press ENTER for menu";
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
    wrap.appendChild(el("p", "hint", hint));

    this.show(wrap);
    this.runCountups(counts);

    // One-key retention loop: ENTER always triggers the primary action (R also, solo only).
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === "enter" || (k === "r" && !ctx.wasCoop && !ctx.online)) { e.preventDefault(); primary(); }
    };
    this.gameOverKeys = onKey;
    window.addEventListener("keydown", onKey);
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
      this.launchOnline(lobby, profile);
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

  private busy(text: string): HTMLElement {
    const wrap = el("div", "menu");
    wrap.appendChild(el("h1", "", "\u2026"));
    const status = el("p", "muted", text);
    wrap.appendChild(status);
    this.show(wrap);
    return status;
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
