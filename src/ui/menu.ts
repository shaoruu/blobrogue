import type { ConvexClient } from "convex/browser";
import type { Session } from "../net/session.js";
import type { AuthClient } from "../net/auth.js";
import type { ProfileDoc, PlayerStatsDoc, RunHistoryEntryDoc, LeaderboardCategory, Difficulty, LeaderboardEntryDoc } from "../net/api.js";
import { api } from "../net/api.js";
import { Multiplayer } from "../net/multiplayer.js";
import { OnlineLobby } from "../net/onlineLobby.js";
import type { RunResult } from "../game/game.js";
import { playerColor, PLAYER_COLORS } from "../game/assets.js";
import { createSettingsControls } from "./settings.js";
import { WEAPONS } from "../sim/weapons.js";
import { itemById } from "../sim/items.js";
import { BOSS_NAMES, DIFFICULTIES, DEFAULT_DIFFICULTY } from "../../convex/statsCore.js";

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
      // Offline build: no multiplayer — single centered actions column. Local stats still
      // exist (the localStorage mirror), so the profile panel stays reachable.
      const colA = el("div", "col-actions");
      colA.appendChild(this.soloButton("\u25be  PLAY"));
      const offlineProfile = el("button", "secondary", "PROFILE & STATS");
      offlineProfile.addEventListener("click", () => void this.showProfilePanel());
      colA.appendChild(offlineProfile);
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
      const actrow = el("div", "actrow");
      const classicBtn = el("button", "secondary", "CLASSIC CO-OP");
      classicBtn.addEventListener("click", () => void this.showClassicCoop());
      actrow.append(classicBtn);
      colA.appendChild(actrow);
      body.appendChild(colA);

      // RIGHT column: identity (name, blob color, account) + profile + settings.
      const colB = el("div", "col-side");
      colB.appendChild(this.identitySection());
      const profileBox = el("div", "profile");
      colB.appendChild(profileBox);
      const statsRow = el("div", "actrow");
      const profileBtn = el("button", "secondary", "PROFILE & STATS");
      profileBtn.addEventListener("click", () => void this.showProfilePanel());
      const boardsBtn = el("button", "secondary", "LEADERBOARDS");
      boardsBtn.addEventListener("click", () => void this.showLeaderboardPanel());
      statsRow.append(profileBtn, boardsBtn);
      colB.appendChild(statsRow);
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

  // ---- PROFILE / STATS panel -----------------------------------------------------------

  // Lifetime aggregates + run history. Backend-first (account or guest row), with the
  // localStorage mirror as the offline fallback — a guest always sees THEIR stats.
  async showProfilePanel() {
    const busy = this.busy("loading profile\u2026");
    let stats: PlayerStatsDoc | null = null;
    let runs: RunHistoryEntryDoc[] = [];
    let runsCursor: string | null = null;
    let isRunsDone = true;
    let isLocalFallback = false;
    if (this.client) {
      try {
        const signedIn = this.auth?.isSignedIn ?? false;
        if (this.session.name || signedIn) await this.session.login(this.session.name || "blob");
        stats = await this.client.query(api.stats.getMyStats, { clientId: this.session.clientId });
        const first = await this.client.query(api.stats.listMyRuns, { clientId: this.session.clientId, cursor: null, numItems: 10 });
        runs = first.page;
        runsCursor = first.continueCursor;
        isRunsDone = first.isDone;
      } catch {
        stats = null;
      }
    }
    if (!stats) {
      const local = this.session.localStatsSnapshot();
      stats = local.stats;
      runs = local.runs;
      isLocalFallback = true;
    }
    void busy;

    const wrap = el("div", "menu");
    const head = el("div", "panel-h");
    head.appendChild(el("h1", "", stats.name.toUpperCase()));
    head.appendChild(el("span", "panel-sub", isLocalFallback
      ? "this browser only"
      : stats.isAccount ? "account \u00b7 global" : "guest \u00b7 this browser"));
    wrap.appendChild(head);

    const a = stats.aggregates;
    const grid = el("div", "profile-grid wide");
    const stat = (label: string, value: string, isAmber = false) => {
      const cell = el("div", "stat");
      const v = el("span", "stat-value", value);
      if (isAmber) v.classList.add("amber");
      cell.append(v, el("span", "stat-label", label));
      grid.appendChild(cell);
    };
    stat("deepest floor", String(a.deepestFloor), true);
    stat("runs", String(a.gamesPlayed));
    stat("wins", String(a.wins));
    stat("deaths", String(a.deaths));
    stat("total kills", String(a.totalKills));
    stat("bosses slain", String(a.bossKills));
    stat("best combo", a.bestCombo > 0 ? `x${a.bestCombo}` : "\u2014");
    stat("playtime", fmtPlaytime(a.playtimeMs));
    stat("damage dealt", fmtBig(a.damageDealt));
    stat("damage taken", fmtBig(a.damageTaken));
    stat("coins earned", fmtBig(a.coinsEarned));
    stat("coins spent", fmtBig(a.coinsSpent));
    wrap.appendChild(grid);

    const details: string[] = [];
    if (stats.favoriteWeapon) details.push(`favorite weapon \u2014 ${weaponName(stats.favoriteWeapon)}`);
    if (a.fastestBossMs !== null) details.push(`fastest boss \u2014 ${fmtClock(a.fastestBossMs / 1000)}`);
    const bossBits = Object.entries(a.bossKillsByBoss).map(([id, n]) => `${BOSS_NAMES[id] ?? id} \u00d7${n}`);
    if (bossBits.length) details.push(bossBits.join(" \u00b7 "));
    if (details.length) {
      const line = el("p", "bossline");
      line.innerHTML = "";
      line.append(...details.map((d, i) => {
        const s = el("span", "", (i > 0 ? "  \u00b7  " : "") + d);
        return s;
      }));
      wrap.appendChild(line);
    }

    wrap.appendChild(el("div", "col-h", "RUN HISTORY"));
    const list = el("div", "scrolly");
    if (runs.length === 0) list.appendChild(el("p", "lb-empty", "no runs yet \u2014 go get eaten by something"));
    for (const r of runs) list.appendChild(runRow(r));
    wrap.appendChild(list);

    const row = el("div", "btnrow");
    if (!isRunsDone && this.client) {
      const more = el("button", "secondary", "load more");
      more.addEventListener("click", () => void (async () => {
        if (!this.client) return;
        more.disabled = true;
        try {
          const next = await this.client.query(api.stats.listMyRuns, { clientId: this.session.clientId, cursor: runsCursor, numItems: 10 });
          for (const r of next.page) list.appendChild(runRow(r));
          runsCursor = next.continueCursor;
          if (next.isDone) more.remove();
        } finally {
          more.disabled = false;
        }
      })());
      row.appendChild(more);
    }
    if (this.client) {
      const boards = el("button", "secondary", "leaderboards");
      boards.addEventListener("click", () => void this.showLeaderboardPanel());
      row.appendChild(boards);
    }
    const back = el("button", "", "back \u21b5");
    back.addEventListener("click", () => void this.showTitle());
    row.appendChild(back);
    wrap.appendChild(row);

    if (!isLocalFallback && !stats.isAccount && this.auth) {
      wrap.appendChild(this.signInCta("Guest stats live in this browser. Sign in with Google to compete on the global leaderboards."));
    }

    this.show(wrap);
  }

  // ---- GLOBAL LEADERBOARDS panel ---------------------------------------------------------

  async showLeaderboardPanel(category: LeaderboardCategory = "deepestFloor", difficulty: Difficulty = DEFAULT_DIFFICULTY) {
    if (!this.client) { await this.showTitle(); return; }
    const client = this.client;
    const wrap = el("div", "menu");
    const head = el("div", "panel-h");
    head.appendChild(el("h1", "", "LEADERBOARDS"));
    head.appendChild(el("span", "panel-sub", "authoritative server runs \u00b7 signed-in players"));
    wrap.appendChild(head);

    const tabs = el("div", "tabrow");
    const tabDefs: Array<{ id: LeaderboardCategory; label: string }> = [
      { id: "deepestFloor", label: "DEEPEST" },
      { id: "fastestBoss", label: "FASTEST BOSS" },
      { id: "bossKills", label: "BOSS KILLS" },
      { id: "score", label: "SCORE" },
      { id: "combo", label: "COMBO" },
    ];
    for (const t of tabDefs) {
      const b = el("button", "secondary tab" + (t.id === category ? " on" : ""), t.label);
      b.addEventListener("click", () => void this.showLeaderboardPanel(t.id, difficulty));
      tabs.appendChild(b);
    }
    wrap.appendChild(tabs);

    const diffRow = el("div", "diffrow");
    diffRow.appendChild(el("span", "lab", "difficulty"));
    for (const d of DIFFICULTIES) {
      const b = el("button", "secondary tab" + (d === difficulty ? " on" : ""), d.toUpperCase());
      b.addEventListener("click", () => void this.showLeaderboardPanel(category, d));
      diffRow.appendChild(b);
    }
    wrap.appendChild(diffRow);

    const list = el("div", "lb-list");
    const status = el("p", "muted", "loading\u2026");
    wrap.appendChild(list);
    wrap.appendChild(status);

    const row = el("div", "btnrow");
    const more = el("button", "secondary", "load more");
    more.style.display = "none";
    row.appendChild(more);
    const back = el("button", "", "back \u21b5");
    back.addEventListener("click", () => void this.showTitle());
    row.appendChild(back);
    wrap.appendChild(row);

    if (this.auth && !this.auth.isSignedIn) {
      wrap.appendChild(this.signInCta("Playing as a guest \u2014 your stats stay in this browser. Sign in with Google and your online runs count here."));
    }

    this.show(wrap);

    let cursor: string | null = null;
    let rank = 0;
    const selfId = this.session.playerId;
    const loadPage = async () => {
      more.disabled = true;
      status.textContent = rank === 0 ? "loading\u2026" : "";
      try {
        const page = await client.query(api.leaderboard.top, {
          category, difficulty, cursor, numItems: 25,
          clientId: this.session.clientId,
        });
        for (const e of page.entries) list.appendChild(lbRow(++rank, e, category, e.playerId === selfId));
        cursor = page.continueCursor;
        more.style.display = page.isDone ? "none" : "";
        if (rank === 0) {
          list.appendChild(el("p", "lb-empty", "no entries yet \u2014 be the first: sign in and clear a run online"));
        }
        status.textContent = page.me && !page.entries.some((e) => e.playerId === selfId)
          ? `your best \u2014 ${fmtBoardValue(page.me.value, category)}`
          : "";
      } catch {
        status.textContent = "leaderboards unavailable \u2014 try again in a moment";
      } finally {
        more.disabled = false;
      }
    };
    more.addEventListener("click", () => void loadPage());
    await loadPage();
  }

  private signInCta(text: string): HTMLElement {
    const box = el("div", "cta-box");
    box.appendChild(el("p", "", text));
    const btn = el("button", "secondary btn-google");
    btn.appendChild(googleMark());
    btn.appendChild(el("span", "", "Sign in with Google"));
    const status = el("p", "muted auth-status");
    btn.addEventListener("click", () => void this.doSignIn(status));
    box.append(btn, status);
    return box;
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

function weaponName(id: string): string {
  return (WEAPONS as Partial<Record<string, { name: string }>>)[id]?.name ?? id;
}

function fmtPlaytime(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return ms > 0 ? "<1m" : "0m";
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
}

function fmtBig(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}m`;
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtWhen(ts: number | null): string {
  if (ts === null || ts <= 0) return "";
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function fmtBoardValue(value: number, category: LeaderboardCategory): string {
  switch (category) {
    case "deepestFloor": return `FL ${value}`;
    case "fastestBoss": return fmtClock(value / 1000);
    case "bossKills": return `\u00d7${value}`;
    case "score": return fmtBig(value);
    case "combo": return `x${value}`;
  }
}

// One run-history row: outcome + depth at a glance, combat detail underneath, final
// build (weapons + blessings) on the fine-print line.
function runRow(r: RunHistoryEntryDoc): HTMLElement {
  const row = el("div", "runrow");
  const r1 = el("div", "r1");
  const fl = el("span", "fl", `FL ${r.floor}`);
  const res = el("span", `res ${r.result}`, r.result);
  const meta = el("span", "", `${fmtClock(r.durationMs / 1000)} \u00b7 ${r.difficulty}`);
  const src = el("span", `src ${r.source}`, r.source === "server" ? "server" : "local");
  src.title = r.source === "server"
    ? "authoritative online run \u2014 counts toward global leaderboards"
    : "locally simulated run \u2014 personal stats only";
  r1.append(fl, res, meta, src);
  row.appendChild(r1);
  const bossBit = r.bossKills > 0 ? ` \u00b7 ${r.bossKills} boss${r.bossKills > 1 ? "es" : ""}` : "";
  const comboBit = r.bestCombo > 0 ? ` \u00b7 x${r.bestCombo} combo` : "";
  row.appendChild(el("div", "r2",
    `${r.kills} kills${bossBit}${comboBit} \u00b7 ${fmtBig(r.damageDealt)} dealt / ${fmtBig(r.damageTaken)} taken \u00b7 ${r.coins} coins`));
  const build: string[] = r.weapons.map(weaponName);
  const blessingCounts = new Map<string, number>();
  for (const id of r.blessings) blessingCounts.set(id, (blessingCounts.get(id) ?? 0) + 1);
  for (const [id, lv] of blessingCounts) {
    const def = itemById(id);
    build.push(`${def?.name ?? id}${lv > 1 ? ` Lv${lv}` : ""}`);
  }
  row.appendChild(el("div", "r3", `${fmtWhen(r.endedAt)}${build.length ? " \u00b7 " + build.join(", ") : ""}`));
  return row;
}

function lbRow(rank: number, e: LeaderboardEntryDoc, category: LeaderboardCategory, isYou: boolean): HTMLElement {
  const row = el("div", "lb-row" + (isYou ? " you" : ""));
  row.appendChild(el("span", "rank", `#${rank}`));
  const dot = el("span", "dot");
  dot.style.background = playerColor(e.colorIndex ?? 0);
  row.appendChild(dot);
  row.appendChild(el("span", "nm", e.name + (isYou ? " (you)" : "")));
  row.appendChild(el("span", "val", fmtBoardValue(e.value, category)));
  row.appendChild(el("span", "when", fmtWhen(e.achievedAt)));
  return row;
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
