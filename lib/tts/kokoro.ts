/* ────────────────────────────────────────────────────────────────
   Kokoro — the studio voice, running on the reader's own machine.

   This is the provider the app is built around. Web Speech is the
   instant-on fallback that every browser already has; Kokoro is the
   one that sounds like an audiobook.

   The bargain it makes: ~86 MB downloaded once, cached by the browser
   forever, and in exchange there is no account, no API key, no
   per-character billing, no server, and nothing you read ever leaves
   your machine. It also renders faster than realtime, which is what
   makes exporting a whole book as MP3 practical rather than theatre.

   The model lives in a worker (`kokoro.worker.ts`). This file is the
   handle: a voice catalogue, a request/response bridge, and the load
   state the UI needs to explain a 86 MB download to somebody who just
   clicked a button.
   ──────────────────────────────────────────────────────────────── */

import type {
  BoundaryEvent,
  SpeakRequest,
  SpeechHandle,
  TTSProvider,
  Voice,
} from "@/lib/types";
import * as clips from "./cache";
import { playBuffered } from "./buffered";

/**
 * The model carries the whole speed range the UI offers, rather than handing
 * anything above 2x to `audio.playbackRate`.
 *
 * Splitting it would have been kinder to quality at 3x, but it would also mean
 * the MP3 you export is not the audio you just listened to: the export pipeline
 * has no playback rate to apply, so the residual would silently vanish from the
 * file. Kokoro's `speed` scales predicted phoneme durations — it speeds up
 * speech without shifting pitch — so letting it own the full range keeps live
 * playback and export identical, at a cost only paid by someone who asked for
 * 3x in the first place.
 */
const SPEED_RANGE = { min: 0.5, max: 3 } as const;

/* ── Load state ──────────────────────────────────────────────── */

export type ModelPhase = "idle" | "loading" | "ready" | "error";

export interface ModelState {
  phase: ModelPhase;
  /** 0..1 while loading. */
  ratio: number;
  detail: string;
  /** "webgpu" or "wasm", once known. */
  device: string | null;
}

let state: ModelState = { phase: "idle", ratio: 0, detail: "", device: null };
const listeners = new Set<(s: ModelState) => void>();

function setState(patch: Partial<ModelState>) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
}

export function getModelState(): ModelState {
  return state;
}

/** Subscribe to load progress. Returns an unsubscribe function. */
export function subscribeModel(fn: (s: ModelState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ── Worker bridge ───────────────────────────────────────────── */

type Outbound =
  | { type: "ready"; device: string }
  | { type: "progress"; ratio: number; detail: string }
  | { type: "audio"; id: number; wav: ArrayBuffer; seconds: number }
  | { type: "error"; id: number | null; message: string };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve(bytes: ArrayBuffer): void; reject(e: Error): void }>();

function ensureWorker(): Worker {
  if (worker) return worker;

  const w = new Worker(new URL("./kokoro.worker.ts", import.meta.url), {
    type: "module",
    name: "readloud-kokoro",
  });

  w.onmessage = (event: MessageEvent<Outbound>) => {
    const msg = event.data;
    switch (msg.type) {
      case "progress":
        setState({ phase: "loading", ratio: msg.ratio, detail: msg.detail });
        break;
      case "ready":
        setState({ phase: "ready", ratio: 1, detail: "Voice ready", device: msg.device });
        break;
      case "audio": {
        pending.get(msg.id)?.resolve(msg.wav);
        pending.delete(msg.id);
        break;
      }
      case "error": {
        if (msg.id === null) {
          setState({ phase: "error", detail: msg.message });
          // A load failure strands every request waiting behind it.
          failAll(new Error(msg.message));
        } else {
          pending.get(msg.id)?.reject(new Error(msg.message));
          pending.delete(msg.id);
        }
        break;
      }
    }
  };

  w.onerror = (event) => {
    const message = event.message || "The on-device voice worker crashed.";
    setState({ phase: "error", detail: message });
    failAll(new Error(message));
  };

  worker = w;
  return w;
}

function failAll(err: Error) {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

/** Start downloading the model. Safe to call repeatedly. */
export function preloadModel(): void {
  if (typeof window === "undefined") return;
  if (state.phase === "ready" || state.phase === "loading") return;
  setState({ phase: "loading", ratio: 0, detail: "Preparing voice model" });
  ensureWorker().postMessage({ type: "init" });
}

function requestAudio(text: string, voice: string, speed: number): Promise<ArrayBuffer> {
  const w = ensureWorker();
  if (state.phase === "idle" || state.phase === "error") {
    setState({ phase: "loading", ratio: 0, detail: "Preparing voice model" });
  }
  const id = nextId++;
  return new Promise<ArrayBuffer>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ type: "generate", id, text, voice, speed });
  });
}

/* ── Synthesis ───────────────────────────────────────────────── */

function speedFor(rate: number): number {
  const r = Number.isFinite(rate) ? rate : 1;
  return Math.min(SPEED_RANGE.max, Math.max(SPEED_RANGE.min, r));
}

async function synthesize(req: SpeakRequest): Promise<clips.Clip> {
  // Keyed on the clamped speed, not the raw rate: two rates that clamp to the
  // same value produce byte-identical audio, so they should share a cache entry.
  const speed = speedFor(req.rate);
  const key = clips.cacheKey("kokoro", req.voiceId, speed, req.text);

  const cached = clips.get(key);
  // `decodeAudioData` detaches whatever buffer it is handed, so every consumer
  // gets its own copy of the cached bytes.
  if (cached) return { bytes: cached.bytes.slice(0), mime: cached.mime };

  const clip = await clips.dedupe(key, async () => ({
    bytes: await requestAudio(req.text, req.voiceId, speed),
    mime: "audio/wav",
  }));
  return { bytes: clip.bytes.slice(0), mime: clip.mime };
}

/* ── Voice catalogue ─────────────────────────────────────────── */

/**
 * Kokoro's published voice table, transcribed rather than imported: pulling it
 * from `kokoro-js` would drag the whole transformers runtime into the main
 * bundle to render a dropdown. The worker is the only place that package
 * belongs.
 *
 * Ordered by the model card's own quality grades, so the best narrators are
 * the ones a reader meets first.
 */
const VOICES: Array<{ id: string; name: string; tag: string; lang: string }> = [
  { id: "af_heart", name: "Heart", tag: "American ♀ — warmest, best overall", lang: "en-US" },
  { id: "af_bella", name: "Bella", tag: "American ♀ — expressive, great for fiction", lang: "en-US" },
  { id: "af_nicole", name: "Nicole", tag: "American ♀ — intimate, headphone mix", lang: "en-US" },
  { id: "bf_emma", name: "Emma", tag: "British ♀ — measured narrator", lang: "en-GB" },
  { id: "am_fenrir", name: "Fenrir", tag: "American ♂ — deep, documentary", lang: "en-US" },
  { id: "am_michael", name: "Michael", tag: "American ♂ — steady, neutral", lang: "en-US" },
  { id: "am_puck", name: "Puck", tag: "American ♂ — bright, lively", lang: "en-US" },
  { id: "af_aoede", name: "Aoede", tag: "American ♀ — clear, unhurried", lang: "en-US" },
  { id: "af_kore", name: "Kore", tag: "American ♀ — crisp", lang: "en-US" },
  { id: "af_sarah", name: "Sarah", tag: "American ♀ — soft", lang: "en-US" },
  { id: "bm_fable", name: "Fable", tag: "British ♂ — storyteller", lang: "en-GB" },
  { id: "bm_george", name: "George", tag: "British ♂ — classic", lang: "en-GB" },
  { id: "bf_isabella", name: "Isabella", tag: "British ♀ — poised", lang: "en-GB" },
  { id: "af_nova", name: "Nova", tag: "American ♀ — bright", lang: "en-US" },
  { id: "af_sky", name: "Sky", tag: "American ♀ — airy", lang: "en-US" },
  { id: "af_alloy", name: "Alloy", tag: "American ♀ — neutral", lang: "en-US" },
  { id: "am_echo", name: "Echo", tag: "American ♂ — even", lang: "en-US" },
  { id: "am_eric", name: "Eric", tag: "American ♂ — plain", lang: "en-US" },
  { id: "am_liam", name: "Liam", tag: "American ♂ — youthful", lang: "en-US" },
  { id: "am_onyx", name: "Onyx", tag: "American ♂ — low", lang: "en-US" },
  { id: "am_adam", name: "Adam", tag: "American ♂ — rough", lang: "en-US" },
  { id: "am_santa", name: "Santa", tag: "American ♂ — character", lang: "en-US" },
  { id: "af_jessica", name: "Jessica", tag: "American ♀ — casual", lang: "en-US" },
  { id: "af_river", name: "River", tag: "American ♀ — flat", lang: "en-US" },
  { id: "bf_alice", name: "Alice", tag: "British ♀ — light", lang: "en-GB" },
  { id: "bf_lily", name: "Lily", tag: "British ♀ — gentle", lang: "en-GB" },
  { id: "bm_daniel", name: "Daniel", tag: "British ♂ — dry", lang: "en-GB" },
  { id: "bm_lewis", name: "Lewis", tag: "British ♂ — gruff", lang: "en-GB" },
];

export const DEFAULT_KOKORO_VOICE = VOICES[0].id;

/* ── Provider ────────────────────────────────────────────────── */

export const kokoroProvider: TTSProvider = {
  id: "kokoro",
  label: "Kokoro (on-device)",
  blurb:
    "Audiobook-grade neural narration, free and offline after a one-time 86 MB download. Renders MP3 faster than realtime.",

  capabilities: {
    synthesize: true,
    // No word timings from the model; the cursor is interpolated from clip
    // position. See `snapToWord` in ./buffered.
    boundaries: false,
    rate: true,
    pitch: false,
    local: true,
  },

  /**
   * Available wherever the browser can run the worker and the WASM backend —
   * which is every current browser. Deliberately does *not* touch the network:
   * an availability probe must never start an 86 MB download on page load.
   */
  async isAvailable() {
    return (
      typeof Worker !== "undefined" &&
      typeof WebAssembly !== "undefined" &&
      typeof AudioContext !== "undefined"
    );
  },

  async listVoices(): Promise<Voice[]> {
    return VOICES.map((v) => ({
      id: v.id,
      name: v.name,
      provider: "kokoro",
      lang: v.lang,
      tag: v.tag,
      local: true,
    }));
  },

  synthesize,

  speak(req: SpeakRequest, onBoundary?: (e: BoundaryEvent) => void): SpeechHandle {
    // Always 1: the pacing is already in the samples, so the audio element must
    // not apply it a second time.
    return playBuffered(req, onBoundary, { load: synthesize, playbackRate: () => 1 });
  },

  /**
   * Warm the next passage while the current one plays. On a CPU backend a long
   * passage can take longer to synthesize than the one before it takes to
   * speak, so without this the narration audibly stalls at every boundary.
   * Failures are swallowed: a prefetch that misses just means the real request
   * pays for it.
   */
  prefetch(req: SpeakRequest) {
    void synthesize({ ...req, signal: undefined }).catch(() => {});
  },
};
