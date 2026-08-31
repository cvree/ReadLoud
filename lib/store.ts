"use client";
/* ────────────────────────────────────────────────────────────────
   Application store.

   Zustand rather than Context because the highlight cursor updates
   at word rate (up to ~8 Hz) and a Context value change re-renders
   every consumer. With a selector-based store only the components
   that read `cursor` re-render, so a 500-page document stays at
   60fps while it is being read aloud.
   ──────────────────────────────────────────────────────────────── */

import { create } from "zustand";
import type {
  Document,
  ExportProgress,
  IngestProgress,
  ProviderId,
  Voice,
} from "@/lib/types";
import { Narrator, type NarratorState } from "@/lib/player/engine";
import { getProvider, PROVIDERS } from "@/lib/tts/registry";
import { CHUNK_PRESETS, type ChunkPreset } from "@/lib/text/chunk";
import { chunkDocument } from "@/lib/text/chunk";
import { unlockAudio } from "@/lib/audio/decode";

export type ViewMode = "reader" | "outline" | "transcript";

export interface Toast {
  id: string;
  tone: "info" | "success" | "warn" | "error";
  title: string;
  body?: string;
}

interface State {
  /* document */
  doc: Document | null;
  ingest: IngestProgress | null;
  ingestError: string | null;

  /* playback */
  player: NarratorState;
  providerId: ProviderId;
  availableProviders: ProviderId[];
  voices: Voice[];
  voiceId: string;
  rate: number;
  pitch: number;
  volume: number;
  gapSeconds: number;
  stopAtSectionEnd: boolean;

  /* ui */
  view: ViewMode;
  focusMode: boolean;
  followCursor: boolean;
  fontScale: number;
  chunkPreset: ChunkPreset;
  exportOpen: boolean;
  exportProgress: ExportProgress | null;
  toasts: Toast[];

  /* actions */
  narrator: Narrator;
  setDocument(doc: Document | null): void;
  setIngest(p: IngestProgress | null): void;
  setIngestError(message: string | null): void;
  initProviders(): Promise<void>;
  selectProvider(id: ProviderId): Promise<void>;
  selectVoice(id: string): void;
  setRate(rate: number): void;
  setPitch(pitch: number): void;
  setVolume(volume: number): void;
  setGap(seconds: number): void;
  setStopAtSectionEnd(v: boolean): void;
  setView(view: ViewMode): void;
  setFocusMode(v: boolean): void;
  setFollowCursor(v: boolean): void;
  setFontScale(v: number): void;
  setChunkPreset(preset: ChunkPreset): void;
  setExportOpen(v: boolean): void;
  setExportProgress(p: ExportProgress | null): void;
  toast(t: Omit<Toast, "id">): void;
  dismissToast(id: string): void;
  reset(): void;
}

const PREFS_KEY = "readloud.prefs.v1";

interface Prefs {
  providerId: ProviderId;
  voiceId: string;
  rate: number;
  pitch: number;
  volume: number;
  gapSeconds: number;
  fontScale: number;
  focusMode: boolean;
  followCursor: boolean;
  chunkPreset: ChunkPreset;
}

function loadPrefs(): Partial<Prefs> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
  } catch {
    return {};
  }
}

function savePrefs(state: State) {
  if (typeof window === "undefined") return;
  const prefs: Prefs = {
    providerId: state.providerId,
    voiceId: state.voiceId,
    rate: state.rate,
    pitch: state.pitch,
    volume: state.volume,
    gapSeconds: state.gapSeconds,
    fontScale: state.fontScale,
    focusMode: state.focusMode,
    followCursor: state.followCursor,
    chunkPreset: state.chunkPreset,
  };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private browsing / quota */
  }
}

/**
 * Guards against a stale voice list winning.
 *
 * `listVoices()` is async and can take seconds (Chrome populates
 * `speechSynthesis.getVoices()` lazily and we allow it up to 3s; ElevenLabs
 * is a network round-trip). If you switch providers while one is in flight,
 * the slower response would otherwise land last and overwrite the selection
 * you just made with the wrong provider's voices. Every call takes a ticket;
 * only the newest is allowed to commit.
 */
let providerGeneration = 0;

export const useStore = create<State>((set, get) => {
  const narrator = new Narrator();
  const prefs = loadPrefs();

  narrator.onUpdate = (player) => set({ player });
  narrator.settings.rate = prefs.rate ?? 1;
  narrator.settings.pitch = prefs.pitch ?? 1;
  narrator.settings.volume = prefs.volume ?? 1;
  narrator.settings.gapSeconds = prefs.gapSeconds ?? 0.18;

  const persist = () => savePrefs(get());

  return {
    doc: null,
    ingest: null,
    ingestError: null,

    player: narrator.getState(),
    providerId: prefs.providerId ?? "webspeech",
    availableProviders: ["webspeech"],
    voices: [],
    voiceId: prefs.voiceId ?? "",
    rate: prefs.rate ?? 1,
    pitch: prefs.pitch ?? 1,
    volume: prefs.volume ?? 1,
    gapSeconds: prefs.gapSeconds ?? 0.18,
    stopAtSectionEnd: false,

    view: "reader",
    focusMode: prefs.focusMode ?? false,
    followCursor: prefs.followCursor ?? true,
    fontScale: prefs.fontScale ?? 1,
    chunkPreset: prefs.chunkPreset ?? "balanced",
    exportOpen: false,
    exportProgress: null,
    toasts: [],

    narrator,

    setDocument(doc) {
      set({ doc, ingest: null, ingestError: null });
      if (doc) {
        narrator.load(doc.chunks);
        set({ view: "reader" });
      } else {
        narrator.load([]);
      }
    },

    setIngest(ingest) {
      set({ ingest });
    },

    setIngestError(ingestError) {
      set({ ingestError, ingest: null });
    },

    async initProviders() {
      const checks = await Promise.all(
        PROVIDERS.map(async (p) => ({ id: p.id, ok: await p.isAvailable() })),
      );
      const availableProviders = checks.filter((c) => c.ok).map((c) => c.id);
      set({ availableProviders });

      const wanted = get().providerId;
      const chosen = availableProviders.includes(wanted)
        ? wanted
        : (availableProviders[0] ?? "webspeech");
      // Only auto-select if the user has not already picked one themselves
      // while the availability probe was in flight.
      if (providerGeneration === 0) await get().selectProvider(chosen);
    },

    async selectProvider(id) {
      const generation = ++providerGeneration;
      const provider = getProvider(id);
      narrator.setProvider(provider);
      set({ providerId: id, voices: [] });

      const remembered = get().voiceId;
      const voices = await provider.listVoices();
      if (generation !== providerGeneration) return; // superseded

      const voiceId =
        voices.find((v) => v.id === remembered)?.id ??
        voices.find((v) => v.tag === "Premium")?.id ??
        voices[0]?.id ??
        "";
      set({ voices, voiceId });
      narrator.update({ providerId: id, voiceId });
      persist();
    },

    selectVoice(voiceId) {
      set({ voiceId });
      narrator.update({ voiceId });
      persist();
    },

    setRate(rate) {
      const clamped = Math.min(3, Math.max(0.5, Number(rate.toFixed(2))));
      set({ rate: clamped });
      narrator.update({ rate: clamped });
      persist();
    },

    setPitch(pitch) {
      set({ pitch });
      narrator.update({ pitch });
      persist();
    },

    setVolume(volume) {
      set({ volume });
      narrator.update({ volume });
      persist();
    },

    setGap(gapSeconds) {
      set({ gapSeconds });
      narrator.update({ gapSeconds });
      persist();
    },

    setStopAtSectionEnd(stopAtSectionEnd) {
      set({ stopAtSectionEnd });
      narrator.update({ stopAtSectionEnd });
    },

    setView(view) {
      set({ view });
    },

    setFocusMode(focusMode) {
      set({ focusMode });
      persist();
    },

    setFollowCursor(followCursor) {
      set({ followCursor });
      persist();
    },

    setFontScale(fontScale) {
      set({ fontScale: Math.min(1.6, Math.max(0.8, fontScale)) });
      persist();
    },

    /**
     * Re-chunking is a real operation, not a preference: it changes what the
     * engine speaks. We rebuild the chunk list from the already-parsed text
     * (no re-parse) and reload the narrator at the equivalent position.
     */
    setChunkPreset(chunkPreset) {
      set({ chunkPreset });
      persist();
      const doc = get().doc;
      if (!doc) return;
      const ratio = doc.chunks.length
        ? get().player.chunkIndex / doc.chunks.length
        : 0;
      const chunks = chunkDocument(doc.text, doc.sections, CHUNK_PRESETS[chunkPreset]);
      const next: Document = { ...doc, chunks };
      set({ doc: next });
      narrator.load(chunks);
      narrator.jump(Math.floor(ratio * chunks.length));
    },

    setExportOpen(exportOpen) {
      set({ exportOpen });
      if (!exportOpen) set({ exportProgress: null });
    },

    setExportProgress(exportProgress) {
      set({ exportProgress });
    },

    toast(t) {
      const id = Math.random().toString(36).slice(2);
      set({ toasts: [...get().toasts, { ...t, id }] });
      const ttl = t.tone === "error" ? 9000 : 4500;
      setTimeout(() => get().dismissToast(id), ttl);
    },

    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },

    reset() {
      narrator.stop();
      narrator.load([]);
      set({ doc: null, ingest: null, ingestError: null, view: "reader", exportProgress: null });
    },
  };
});

/** Playback needs a user gesture to unlock the AudioContext on iOS/Safari. */
export async function primeAudio(): Promise<void> {
  await unlockAudio();
}
