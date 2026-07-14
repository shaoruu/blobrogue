import type { ConvexClient } from "convex/browser";
import { api } from "./api.js";
import type { ProfileDoc, CampMutationResult } from "./api.js";
import type { RunResult } from "../game/game.js";
import { bodyItemForPaletteIndex } from "../game/cosmetics.js";
import type { CosmeticSlot, CosmeticLoadout } from "../game/cosmetics.js";
import { generatedBlobName, sanitizeBlobName } from "./blobName.js";
import { getRememberedPet, getSelectedKit, rememberRunLoadout } from "./kitSelection.js";
import type { PlayableKitId, RememberedPet, RunLoadout } from "./kitSelection.js";
import { isKitId, isKitUnlocked } from "../sim/kits.js";

const CLIENT_ID_KEY = "blobrogue.clientId";
const NAME_KEY = "blobrogue.name";
const NAME_CONFIRMED_KEY = "blobrogue.nameConfirmed";
const COLOR_KEY = "blobrogue.color";
const COSMETICS_KEY = "blobrogue.cosmetics";

export type SessionLoadoutResult =
  | { ok: true; profile: ProfileDoc | null; isOffline: boolean }
  | { ok: false; reason: string; profile: ProfileDoc | null; isOffline: boolean };

function readOrMintClientId(): string {
  try {
    const existing = localStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const minted = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, minted);
    return minted;
  } catch {
    // Private mode / storage disabled: fall back to an in-memory id for this tab.
    return crypto.randomUUID();
  }
}

function readStoredColor(): number | null {
  try {
    const raw = localStorage.getItem(COLOR_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 15 ? n : null;
  } catch {
    return null;
  }
}

// Locally-picked loadout. Per slot: undefined = never picked (adopt the profile's saved
// value), "none" = explicitly cleared, else an equipped id. Mirrors the colorIndex rule:
// only explicit picks are ever written to the backend.
type StoredCosmetics = { hat?: string; face?: string; body?: string; title?: string };
const COSMETIC_PICK_SLOTS = ["hat", "face", "body", "title"] as const;

function readStoredCosmetics(): StoredCosmetics {
  try {
    const raw = localStorage.getItem(COSMETICS_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const rec = parsed as Record<string, unknown>;
    const out: StoredCosmetics = {};
    for (const slot of COSMETIC_PICK_SLOTS) {
      const v = rec[slot];
      if (typeof v === "string") out[slot] = v.slice(0, 24);
    }
    return out;
  } catch {
    return {};
  }
}

// Owns the persistent player identity (name + chosen blob color + equipped cosmetics) and
// their saved stats. Works with or without a Convex client: with none, it just remembers
// everything locally.
export class Session {
  readonly clientId: string;
  name: string;
  // Chosen blob tint (client palette index). null = never picked (renders the natural
  // amber hero). Persisted locally always, and onto the Convex profile at login so
  // signed-in players keep it across devices.
  colorIndex: number | null;
  private cosmeticPicks: StoredCosmetics;
  profile: ProfileDoc | null = null;
  private client: ConvexClient | null;

  constructor(client: ConvexClient | null) {
    this.client = client;
    this.clientId = readOrMintClientId();
    let stored = "";
    try { stored = localStorage.getItem(NAME_KEY) ?? ""; } catch { stored = ""; }
    // A guest is NEVER nameless (and never the literal "blob"): with no stored pick, the
    // deterministic clientId-hashed default is assigned once and persisted, so a returning
    // guest keeps the same generated identity across sessions.
    const clean = sanitizeBlobName(stored);
    this.name = clean.length > 0 && clean.toLowerCase() !== "blob" ? clean : generatedBlobName(this.clientId);
    if (this.name !== stored) { try { localStorage.setItem(NAME_KEY, this.name); } catch { /* ignore */ } }
    this.colorIndex = readStoredColor();
    this.cosmeticPicks = readStoredCosmetics();
  }

  get playerId(): string | null {
    return this.profile?.playerId ?? null;
  }

  // The one-time online name gate's latch: once the player confirmed (or a signed-in
  // account made the prompt moot), online starts skip straight through.
  get isNameConfirmed(): boolean {
    try { return localStorage.getItem(NAME_CONFIRMED_KEY) === "1"; } catch { return false; }
  }

  markNameConfirmed(): void {
    try { localStorage.setItem(NAME_CONFIRMED_KEY, "1"); } catch { /* ignore */ }
  }

  // Drop the cached profile (called on sign-out) so no prior-user data — name, stats,
  // adopted cosmetics — can leak into the next render; the guest hydrate refills it.
  clearProfile(): void {
    this.profile = null;
  }

  // The equipped loadout as the renderer consumes it: local explicit picks win, the
  // saved profile fills never-picked slots, "none" resolves to the empty slot.
  get cosmetics(): CosmeticLoadout {
    const resolve = (slot: CosmeticSlot): string | null => {
      const local = this.cosmeticPicks[slot];
      if (local !== undefined) return local === "none" ? null : local;
      // Optional chain into cosmetics: a pre-cosmetics backend returns profiles without
      // the field — every slot defaults to empty, never a crash.
      return this.profile?.cosmetics?.[slot] ?? null;
    };
    return { hat: resolve("hat"), face: resolve("face"), body: resolve("body"), title: resolve("title") };
  }

  private persistName(name: string) {
    this.name = name;
    try { localStorage.setItem(NAME_KEY, name); } catch { /* ignore */ }
  }

  // One swatch pick sets BOTH color layers at launch: the PARTY color (colorIndex — name
  // label / minimap / roster identity) and the cosmetic body item. The model keeps them
  // separate so party-assigned colors can diverge from the worn body palette later.
  // Applies locally at once; the returned promise resolves false when the background
  // persist failed (network), so optimistic UIs can revert — it never rejects.
  setColorIndex(colorIndex: number): Promise<boolean> {
    this.colorIndex = colorIndex;
    try { localStorage.setItem(COLOR_KEY, String(colorIndex)); } catch { /* ignore */ }
    const bodyItem = bodyItemForPaletteIndex(colorIndex);
    this.recordCosmeticPick("body", bodyItem?.id ?? null);
    return this.flushInBackground();
  }

  private recordCosmeticPick(slot: CosmeticSlot, id: string | null) {
    this.cosmeticPicks = { ...this.cosmeticPicks, [slot]: id ?? "none" };
    try { localStorage.setItem(COSMETICS_KEY, JSON.stringify(this.cosmeticPicks)); } catch { /* ignore */ }
  }

  // Equip a cosmetic (or clear the slot with null). Applies locally immediately; persisted
  // onto the profile in the background exactly like the color pick, with the same
  // never-rejecting success signal.
  setCosmetic(slot: CosmeticSlot, id: string | null): Promise<boolean> {
    this.recordCosmeticPick(slot, id);
    return this.flushInBackground();
  }

  // Local-only rollback of a failed optimistic equip. No write is fired: the server never
  // stored the failed pick, so local state is the only side that needs fixing.
  revertCosmetic(slot: CosmeticSlot, id: string | null): void {
    this.recordCosmeticPick(slot, id);
  }

  // The body-color equivalent: restores both color layers (party color + body item).
  revertColor(colorIndex: number | null, body: string | null): void {
    this.colorIndex = colorIndex;
    try {
      if (colorIndex === null) localStorage.removeItem(COLOR_KEY);
      else localStorage.setItem(COLOR_KEY, String(colorIndex));
    } catch { /* ignore */ }
    this.recordCosmeticPick("body", body);
  }

  // The latest in-flight background identity write. Background picks never block the UI,
  // but the JOIN paths must be able to await them: flushIdentity() below is what guarantees
  // a room ticket can never be minted ahead of the pick it should carry (the remote-color
  // Sev — teammates rendering a stale/default tint).
  private pendingFlush: Promise<void> = Promise.resolve();

  // Fire the background write and surface its outcome (true = stored; false = network
  // failure, so an optimistic UI can revert). The pending handle is kept for the JOIN
  // paths' flushIdentity() barrier as well.
  private flushInBackground(): Promise<boolean> {
    if (!this.client) return Promise.resolve(true);
    const flush = this.login().then(() => true, () => false);
    this.pendingFlush = flush.then(() => undefined);
    return flush;
  }

  // Settle every backgrounded identity write, then land one final flush of the CURRENT
  // name/color/cosmetics — awaited by every room operation and ticket mint, so the
  // authoritative profile (and therefore the ticket/roster identity) always carries the
  // player's latest picks before anyone else can observe them.
  async flushIdentity(): Promise<void> {
    await this.pendingFlush;
    await this.login();
  }

  // Upsert the caller's profile row with the CURRENT identity. A passed name is sanitized
  // first; one that sanitizes away (or is the retired literal "blob" placeholder) keeps the
  // standing name — a login can never blank a name or resurrect the "blob" collision.
  async login(name: string = this.name): Promise<ProfileDoc | null> {
    const clean = sanitizeBlobName(name);
    this.persistName(clean.length > 0 && clean.toLowerCase() !== "blob" ? clean : this.name);
    if (!this.client) return null;
    const sent: StoredCosmetics = { ...this.cosmeticPicks };
    const hasPicks = COSMETIC_PICK_SLOTS.some((slot) => sent[slot] !== undefined);
    this.profile = await this.client.mutation(api.players.ensurePlayer, {
      clientId: this.clientId,
      name: this.name,
      // Only explicit local picks are sent — undefined never overwrites a saved pick.
      ...(this.colorIndex !== null ? { colorIndex: this.colorIndex } : {}),
      ...(hasPicks ? { cosmetics: sent } : {}),
    });
    // A signed-in account may carry picks made on another device; adopt them locally.
    if (this.colorIndex === null && this.profile.colorIndex !== null) {
      this.colorIndex = this.profile.colorIndex;
      try { localStorage.setItem(COLOR_KEY, String(this.profile.colorIndex)); } catch { /* ignore */ }
    }
    // Authority reconcile: a pick the server did NOT store (locked/unknown/tampered) must
    // not linger as local truth. Only slots untouched since this flush left are reconciled,
    // so a fresh pick made mid-flight is never clobbered by its predecessor's response —
    // its own flush (already queued by setCosmetic) settles it.
    for (const slot of COSMETIC_PICK_SLOTS) {
      if (sent[slot] === undefined) continue;
      if (this.cosmeticPicks[slot] !== sent[slot]) continue;
      const sentValue = sent[slot] === "none" ? null : sent[slot] ?? null;
      const serverValue = this.profile.cosmetics?.[slot] ?? null;
      if (serverValue !== sentValue) this.recordCosmeticPick(slot, serverValue);
    }
    return this.profile;
  }

  // Set a SIGNED-IN account's chosen display name (server-authoritative override; guests use
  // login instead). The server sanitizes + validates and returns the effective profile; on
  // success the returned display name becomes the session name so lobbies, in-run labels, and
  // the leaderboard all pick it up. Never rejects — resolves null on failure so the UI can note it.
  async setCustomName(name: string): Promise<ProfileDoc | null> {
    if (!this.client) return null;
    try {
      const profile = await this.client.mutation(api.players.setCustomName, {
        clientId: this.clientId,
        name,
      });
      if (profile) {
        this.profile = profile;
        this.persistName(profile.name);
      }
      return profile;
    } catch {
      return null;
    }
  }

  async refreshProfile(): Promise<ProfileDoc | null> {
    if (!this.client) return null;
    this.profile = await this.client.query(api.players.getProfile, { clientId: this.clientId });
    return this.profile;
  }

  // Bank the deepest floor reached, PROGRESSIVELY, on each descend — so a run that ends by
  // a teammate carrying on / a disconnect / a quit (never a clean full-party-wipe game over,
  // the only thing that calls recordRun) still records its depth on the leaderboard. Fire-
  // and-forget: a failed floor-bank must never interrupt play, and the mutation is
  // idempotent (Math.max) so a re-bank of the same floor is harmless.
  recordFloorProgress(floor: number): void {
    if (!this.client || !Number.isFinite(floor) || floor < 1) return;
    void this.client.mutation(api.players.recordFloorProgress, {
      clientId: this.clientId,
      floor: Math.floor(floor),
    }).catch(() => { /* never let a depth-bank failure interrupt the run */ });
  }

  async recordRun(result: RunResult): Promise<ProfileDoc | null> {
    if (!this.client) return null;
    try {
      this.profile = await this.client.mutation(api.players.recordRun, {
        clientId: this.clientId,
        floor: result.floor,
        kills: result.kills,
        coins: result.coins,
        // The authoritative run FACTS — the server banks Amber from these (never a client
        // amber number). floorsCleared/bossKills come from the sim's own descend/kill events.
        floorsCleared: result.floorsCleared,
        bossKills: result.bossKills,
        isCacheArmed: result.isCacheArmed,
        amberWindfall: result.amberWindfall,
        outcome: result.outcome,
        durationMs: Math.round(result.durationMs),
        // The run's final build rides along for the player's leaderboard entry (ids only —
        // display names resolve client-side from the weapon/item catalogs).
        build: {
          weapons: (result.build?.weapons ?? []).map((w) => w.id),
          items: (result.build?.items ?? []).map((it) => ({ id: it.id, count: it.count })),
        },
      });
    } catch {
      // Never let a stats-save failure interrupt the play loop.
    }
    return this.profile;
  }

  // The equipped companion pet id from the profile (WAVE 1), or null. Read at run start so the
  // client renders the local player's own pet; teammates render it from the wire identity.
  get equippedPet(): string | null {
    return this.profile?.equippedPet ?? null;
  }

  get lastKitId(): PlayableKitId {
    const saved = this.profile?.lastKitId;
    return saved && isKitId(saved) && saved !== "none" ? saved : getSelectedKit();
  }

  get rememberedPet(): RememberedPet {
    const local = getRememberedPet();
    if (local.isRemembered) return local;
    return { isRemembered: true, petId: this.profile?.equippedPet ?? null };
  }

  acceptConfirmedRunLoadout(loadout: RunLoadout, profile: ProfileDoc | null = this.profile): void {
    rememberRunLoadout(loadout);
    this.profile = profile
      ? { ...profile, lastKitId: loadout.kitId, equippedPet: loadout.petId }
      : null;
  }

  async confirmRunLoadout(loadout: RunLoadout): Promise<SessionLoadoutResult> {
    if (!this.client) {
      const level = this.profile?.masteryLevel ?? 1;
      if (!isKitUnlocked(loadout.kitId, level)) {
        return { ok: false, reason: "kit_locked", profile: this.profile, isOffline: true };
      }
      if (loadout.petId !== null) {
        return { ok: false, reason: "offline_pet_unavailable", profile: this.profile, isOffline: true };
      }
      this.acceptConfirmedRunLoadout(loadout);
      return { ok: true, profile: this.profile, isOffline: true };
    }
    try {
      await this.flushIdentity();
      const result = await this.client.mutation(api.players.confirmRunLoadout, {
        clientId: this.clientId,
        kitId: loadout.kitId,
        petId: loadout.petId,
        isKitChoiceMade: true,
        isPetChoiceMade: true,
      });
      if (!result) {
        return { ok: false, reason: "profile_unavailable", profile: this.profile, isOffline: false };
      }
      this.profile = result.profile;
      if (!result.ok) {
        return {
          ok: false,
          reason: result.reason ?? "loadout_rejected",
          profile: result.profile,
          isOffline: false,
        };
      }
      this.acceptConfirmedRunLoadout(loadout, result.profile);
      return { ok: true, profile: this.profile, isOffline: false };
    } catch {
      return { ok: false, reason: "backend_unavailable", profile: this.profile, isOffline: false };
    }
  }

  // WAVE 1 Amber Camp SPEND (server-authoritative). Buy a camp node: the server validates
  // cost/prereqs/ownership and deducts Amber, then this caches the returned profile so the UI
  // reflects the new balance + unlock. Returns the result (ok + reason) or null on failure.
  async buyNode(nodeId: string): Promise<CampMutationResult | null> {
    if (!this.client) return null;
    try {
      const res = await this.client.mutation(api.players.buyNode, { clientId: this.clientId, nodeId });
      if (res) this.profile = res.profile;
      return res;
    } catch {
      return null;
    }
  }

  // Equip (or clear with null) the active companion pet. The server validates ownership; this
  // caches the returned profile so the menu + next run render the equipped pet.
  async equipPet(petId: string | null): Promise<CampMutationResult | null> {
    if (!this.client) return null;
    try {
      const res = await this.client.mutation(api.players.equipPet, { clientId: this.clientId, petId });
      if (res) {
        this.profile = res.profile;
        if (res.ok) rememberRunLoadout({ kitId: this.lastKitId, petId });
      }
      return res;
    } catch {
      return null;
    }
  }
}
