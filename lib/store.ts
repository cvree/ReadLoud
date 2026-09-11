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
import { preloadModel } from "@/lib/tts/kokoro";
import { silentPacer, wpmToRate } from "@/lib/rsvp/pacer";
import { WPM_RANGE } from "@/lib/rsvp/pacing";
import { CHUNK_PRESETS, type ChunkPreset } from "@/lib/text/chunk";
import { chunkDocument } from "@/lib/text/chunk";
import { unlockAudio } from "@/lib/audio/decode";

export type ViewMode = "reader" | "outline" | "transcript";

/**
 * What moves the cursor in reading mode.
 *
 * `voice` is the differentiated one: the word display is driven by the
 * narrator's own boundary events, so you get one-word-at-a-time reading with
 * the voice running underneath it. Every other RSVP tool in this category
 * shows you words in silence, and the main documented cost of RSVP is the
 * comprehension hit from stripping prosody — which is exactly what the voice
 * hands back.
 *
 * `silent` is the classic pacer: a clock, no audio, 150–1200 wpm.
 */
export type RsvpMode = "voice" | "silent";

export interface RsvpState {
  /** The full-bleed one-word display is up. */
  enabled: boolean;
  mode: RsvpMode;
  /**
   * Silent-mode target rate. Kept separate from `rate` on purpose: one is a
   * voice control clamped to 0.5–3.0, the other is a pacer dial that goes to
   * 1200 wpm. Conflating them is easy to get wrong once and confusing forever
   * after.
   */
  wpm: number;
  /** The current sentence, dimmed, under the word. The comprehension lever. */
  ribbon: boolean;
  /** True while a `Backspace` replay is running below the set rate. */
  replaying: boolean;
}

/** How much slower a replay runs. */
const REPLAY_SCALE = 0.7;

function clampWpm(wpm: number): number {
  const n = Number.isFinite(wpm) ? wpm : 400;
  return Math.min(WPM_RANGE.max, Math.max(WPM_RANGE.min, Math.round(n)));
}

export interface Toast {
  id: string;
  tone: "info" | "success" | "warn" | "error";
  title: string;
  body?: string;
  /** Optional one-click undo / follow-up, rendered as a link in the toast. */
  action?: { label: string; run: () => void };
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

  /* reading mode */
  rsvp: RsvpState;

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
  setRsvpEnabled(v: boolean): void;
  setRsvpMode(mode: RsvpMode): void;
  setRsvpWpm(wpm: number): void;
  setRsvpRibbon(v: boolean): void;
  startReplay(fromChar: number): void;
  endReplay(): void;
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
const PLACES_KEY = "readloud.places.v1";

/* ── Keeping your place ──────────────────────────────────────────
   Nobody finishes a nine-hundred-page book in one sitting, and until
   now closing the tab meant starting it again from page one. The
   document itself is never stored — it never leaves the machine and
   it can be gigabytes — only which passage you had reached, keyed by
   something stable about the file.
   ──────────────────────────────────────────────────────────────── */

/** Stable across re-opens of the same file; different for a different file. */
function placeKey(doc: Document): string {
  return `${doc.name}|${doc.bytes}|${doc.meta.characters}`;
}

type Places = Record<string, { chunkIndex: number; at: number }>;

function readPlaces(): Places {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(PLACES_KEY) ?? "{}") as Places;
  } catch {
    return {};
  }
}

function rememberPlace(doc: Document | null, chunkIndex: number) {
  if (!doc || typeof window === "undefined") return;
  try {
    const places = readPlaces();
    places[placeKey(doc)] = { chunkIndex, at: Date.now() };
    // Bounded: the twenty most recent documents. Without a cap this grows
    // forever and eventually trips the localStorage quota, which would take
    // the *preferences* down with it.
    const trimmed = Object.entries(places)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, 20);
    localStorage.setItem(PLACES_KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch {
    /* private browsing / quota */
  }
}

function recallPlace(doc: Document): number {
  const entry = readPlaces()[placeKey(doc)];
  if (!entry) return 0;
  // A position past the end means the document was re-chunked at a different
  // preset since. Better to start over than to land somewhere arbitrary.
  return entry.chunkIndex > 0 && entry.chunkIndex < doc.chunks.length ? entry.chunkIndex : 0;
}

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
  rsvpMode: RsvpMode;
  rsvpWpm: number;
  rsvpRibbon: boolean;
}

function loadPrefs(): Partial<Prefs> {
  if (typeof window === "undefined") return {};
  try {
    const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    // A browser that used an older build may have "openai" or "elevenlabs"
    // stored here. `getProvider` throws on an unknown id, and it is read
    // during the first render — long before `initProviders` could correct it —
    // so a stale value has to be dropped on the way in, not on the way out.
    if (prefs.providerId && !PROVIDERS.some((p) => p.id === prefs.providerId)) {
      delete prefs.providerId;
      delete prefs.voiceId;
    }
    return prefs;
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
    // `enabled` is deliberately not persisted: reading mode is a thing you
    // enter, not a state the app should open in.
    rsvpMode: state.rsvp.mode,
    rsvpWpm: state.rsvp.wpm,
    rsvpRibbon: state.rsvp.ribbon,
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
 * `speechSynthesis.getVoices()` lazily and we allow it up to 3s). If you switch
 * providers while one is in flight, the slower response would otherwise land
 * last and overwrite the selection you just made with the wrong provider's
 * voices. Every call takes a ticket; only the newest is allowed to commit.
 */
let providerGeneration = 0;

export const useStore = create<State>((set, get) => {
  const narrator = new Narrator();
  const prefs = loadPrefs();

  // Word-rate updates, so this must stay cheap: the only extra work is a
  // comparison, and the write to localStorage happens once per passage.
  let lastSavedChunk = -1;
  narrator.onUpdate = (player) => {
    set({ player });
    if (player.chunkIndex !== lastSavedChunk) {
      lastSavedChunk = player.chunkIndex;
      rememberPlace(get().doc, player.chunkIndex);
    }
  };
  narrator.settings.rate = prefs.rate ?? 1;
  narrator.settings.pitch = prefs.pitch ?? 1;
  narrator.settings.volume = prefs.volume ?? 1;
  narrator.settings.gapSeconds = prefs.gapSeconds ?? 0.18;

  const persist = () => savePrefs(get());

  /* ── One place decides what drives the cursor ──────────────────
     Silent reading mode swaps the narrator's provider for the pacer and
     its rate for the WPM dial. Everything that can change either of
     those routes through here, so the two can never disagree — and the
     voice's own rate and voice id are left untouched underneath, ready
     to be restored on the way out. */

  const silentActive = (): boolean => {
    const { rsvp } = get();
    return rsvp.enabled && rsvp.mode === "silent";
  };

  const pacingRate = (): number => {
    const s = get();
    if (!silentActive()) return s.rate;
    return wpmToRate(s.rsvp.wpm) * (s.rsvp.replaying ? REPLAY_SCALE : 1);
  };

  /** Re-point the narrator, continuing from `atChar` rather than restarting. */
  const applyPacing = (atChar?: number) => {
    const s = get();
    const silent = silentActive();
    narrator.retune(
      silent ? silentPacer : getProvider(s.providerId),
      { voiceId: silent ? "silent" : s.voiceId, rate: pacingRate() },
      atChar,
    );
  };

  /** Where the reader currently is, for a retune that must not lose the word. */
  const cursorOrUndefined = (): number | undefined => {
    const { cursor } = narrator.getState();
    return cursor >= 0 ? cursor : undefined;
  };

  return {
    doc: null,
    ingest: null,
    ingestError: null,

    player: narrator.getState(),
    providerId: prefs.providerId ?? "kokoro",
    availableProviders: ["webspeech"],
    voices: [],
    voiceId: prefs.voiceId ?? "",
    rate: prefs.rate ?? 1,
    pitch: prefs.pitch ?? 1,
    volume: prefs.volume ?? 1,
    gapSeconds: prefs.gapSeconds ?? 0.18,
    stopAtSectionEnd: false,

    rsvp: {
      enabled: false,
      mode: prefs.rsvpMode ?? "voice",
      wpm: clampWpm(prefs.rsvpWpm ?? 400),
      ribbon: prefs.rsvpRibbon ?? true,
      replaying: false,
    },

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
        // Read the remembered place *before* loading: `load()` resets the
        // narrator to passage 0, which goes straight back out through
        // `onUpdate` and would overwrite the very position being read.
        const place = recallPlace(doc);

        narrator.load(doc.chunks);
        set({ view: "reader" });

        // Pick up where this document was left off, and say so — silently
        // landing someone in chapter nine reads as a bug, not a feature.
        if (place > 0) {
          narrator.jump(place);
          get().toast({
            tone: "info",
            title: "Picked up where you left off",
            body: `Passage ${(place + 1).toLocaleString()} of ${doc.chunks.length.toLocaleString()}.`,
            action: { label: "Start from the beginning", run: () => narrator.jump(0) },
          });
        }

        // Somebody who has just opened a book is going to press play. Start
        // fetching the model now so the wait overlaps with them finding their
        // place, rather than landing between the press and the first word.
        // Deliberately not done on page load: an 86 MB download is not
        // something to spend on a visitor who is only looking around.
        if (get().providerId === "kokoro") preloadModel();
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
      // While the pacer is driving, the chosen voice is remembered but not
      // installed; `applyPacing` hands the narrator back on the way out.
      if (!silentActive()) narrator.setProvider(provider);
      set({ providerId: id, voices: [] });

      const remembered = get().voiceId;
      const voices = await provider.listVoices();
      if (generation !== providerGeneration) return; // superseded

      // Each provider lists its voices best-first, so index 0 is the right
      // default for anyone who has not chosen one.
      const voiceId = voices.find((v) => v.id === remembered)?.id ?? voices[0]?.id ?? "";
      set({ voices, voiceId });
      if (!silentActive()) narrator.update({ providerId: id, voiceId });
      persist();
    },

    selectVoice(voiceId) {
      set({ voiceId });
      if (!silentActive()) narrator.update({ voiceId });
      persist();
    },

    setRate(rate) {
      const clamped = Math.min(3, Math.max(0.5, Number(rate.toFixed(2))));
      set({ rate: clamped });
      // In silent reading mode the clock belongs to the WPM dial. This slider
      // stays the voice's rate and takes effect again on the way out.
      if (!silentActive()) narrator.update({ rate: clamped });
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

    /* ── Reading mode ───────────────────────────────────────────── */

    setRsvpEnabled(enabled) {
      const { rsvp } = get();
      if (rsvp.enabled === enabled) return;

      const st = narrator.getState();
      const running = st.status === "playing" || st.status === "buffering";
      const leavingSilent = !enabled && rsvp.mode === "silent";

      // Leaving silent mode mid-passage must not start talking: you were
      // reading in silence, and a voice arriving unannounced is a jump scare,
      // not a feature. Tear the pacer down into `paused` first.
      if (leavingSilent && running) narrator.suspend();

      set({ rsvp: { ...rsvp, enabled, replaying: false } });
      // Only silent mode swaps anything. In voice mode the overlay is a
      // different renderer over the same playback, so retuning here would
      // restart the passage — and re-synthesize it — for no reason.
      if (rsvp.mode === "silent") applyPacing(cursorOrUndefined());
      persist();
    },

    setRsvpMode(mode) {
      const { rsvp } = get();
      if (rsvp.mode === mode) return;

      const st = narrator.getState();
      const running = st.status === "playing" || st.status === "buffering";
      if (rsvp.enabled && mode === "voice" && running) narrator.suspend();

      set({ rsvp: { ...rsvp, mode, replaying: false } });
      applyPacing(cursorOrUndefined());
      persist();
    },

    setRsvpWpm(wpm) {
      const { rsvp } = get();
      const next = clampWpm(wpm);
      if (next === rsvp.wpm) return;
      set({ rsvp: { ...rsvp, wpm: next } });
      // Re-pacing from the current word rather than the top of the passage:
      // dragging the dial should change the speed, not your place.
      if (silentActive()) applyPacing(cursorOrUndefined());
      persist();
    },

    setRsvpRibbon(ribbon) {
      set({ rsvp: { ...get().rsvp, ribbon } });
      persist();
    },

    /**
     * Re-read the last few words — the answer to RSVP's real complaint, which
     * is that you cannot look back.
     *
     * Slower only in silent mode, where a rate change is free. In voice mode
     * the re-listen *is* the replay, and dropping the rate would cost two
     * re-synthesises and an audible speed change in the middle of a sentence
     * for no comprehension gain.
     *
     * Starts playing if it was paused: a "replay" that leaves you looking at
     * an earlier word and waiting for a second keystroke is not a replay.
     */
    startReplay(fromChar) {
      set({ rsvp: { ...get().rsvp, replaying: silentActive() } });
      applyPacing(fromChar);
      const { status } = narrator.getState();
      if (status !== "playing" && status !== "buffering") void narrator.play();
    },

    endReplay() {
      if (!get().rsvp.replaying) return;
      set({ rsvp: { ...get().rsvp, replaying: false } });
      applyPacing(cursorOrUndefined());
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
      // Long enough to read; longer again when there is something to click.
      const ttl = t.tone === "error" ? 9000 : t.action ? 11000 : 4500;
      setTimeout(() => get().dismissToast(id), ttl);
    },

    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },

    reset() {
      narrator.stop();
      // Clear the document first, for the same reason: unloading the narrator
      // reports passage 0, and that must not be written down as "where you
      // had got to" in the book being closed.
      set({
        doc: null,
        ingest: null,
        ingestError: null,
        view: "reader",
        exportProgress: null,
        // An overlay with no document behind it is a blank screen with a
        // keymap attached.
        rsvp: { ...get().rsvp, enabled: false, replaying: false },
      });
      narrator.load([]);
      // Hand the narrator back to the voice: leaving the pacer installed
      // would make the next document read itself in silence.
      applyPacing();
    },
  };
});

/** Playback needs a user gesture to unlock the AudioContext on iOS/Safari. */
export async function primeAudio(): Promise<void> {
  await unlockAudio();
}
