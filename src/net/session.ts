import type { ConvexClient } from "convex/browser";
import { api } from "./api.js";
import type { ProfileDoc } from "./api.js";
import type { RunResult } from "../game/game.js";
import { bodyItemForPaletteIndex } from "../game/cosmetics.js";
import type { CosmeticSlot, CosmeticLoadout } from "../game/cosmetics.js";

const CLIENT_ID_KEY = "blobrogue.clientId";
const NAME_KEY = "blobrogue.name";
const COLOR_KEY = "blobrogue.color";
const COSMETICS_KEY = "blobrogue.cosmetics";

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
    this.name = stored;
    this.colorIndex = readStoredColor();
    this.cosmeticPicks = readStoredCosmetics();
  }

  get playerId(): string | null {
    return this.profile?.playerId ?? null;
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
  setColorIndex(colorIndex: number) {
    this.colorIndex = colorIndex;
    try { localStorage.setItem(COLOR_KEY, String(colorIndex)); } catch { /* ignore */ }
    const bodyItem = bodyItemForPaletteIndex(colorIndex);
    this.recordCosmeticPick("body", bodyItem?.id ?? null);
    // Persist the pick onto the profile in the background; the local value already applies.
    if (this.client) void this.login(this.name || "blob").catch(() => {});
  }

  private recordCosmeticPick(slot: CosmeticSlot, id: string | null) {
    this.cosmeticPicks = { ...this.cosmeticPicks, [slot]: id ?? "none" };
    try { localStorage.setItem(COSMETICS_KEY, JSON.stringify(this.cosmeticPicks)); } catch { /* ignore */ }
  }

  // Equip a cosmetic (or clear the slot with null). Applies locally immediately; persisted
  // onto the profile in the background exactly like the color pick.
  setCosmetic(slot: CosmeticSlot, id: string | null) {
    this.recordCosmeticPick(slot, id);
    if (this.client) void this.login(this.name || "blob").catch(() => {});
  }

  async login(name: string): Promise<ProfileDoc | null> {
    this.persistName(name);
    if (!this.client) return null;
    const sent: StoredCosmetics = { ...this.cosmeticPicks };
    const hasPicks = COSMETIC_PICK_SLOTS.some((slot) => sent[slot] !== undefined);
    this.profile = await this.client.mutation(api.players.ensurePlayer, {
      clientId: this.clientId,
      name,
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

  async refreshProfile(): Promise<ProfileDoc | null> {
    if (!this.client) return null;
    this.profile = await this.client.query(api.players.getProfile, { clientId: this.clientId });
    return this.profile;
  }

  async recordRun(result: RunResult): Promise<ProfileDoc | null> {
    if (!this.client) return null;
    try {
      this.profile = await this.client.mutation(api.players.recordRun, {
        clientId: this.clientId,
        floor: result.floor,
        kills: result.kills,
        coins: result.coins,
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
}
