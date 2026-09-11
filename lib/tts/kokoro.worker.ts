/* ────────────────────────────────────────────────────────────────
   Kokoro-82M, running inside the reader's own browser.

   Kokoro is an 82-million-parameter StyleTTS2 model released under
   Apache-2.0. It is the reason this app needs no account, no key and
   no server: the weights (~86 MB, int8) are fetched once from the
   Hugging Face CDN, cached by the browser, and every sentence after
   that is synthesized locally. Nothing is uploaded. Nothing is billed.

   Everything here runs off the main thread because ONNX inference is
   a hard CPU stall — on the main thread it would freeze scrolling,
   highlighting and the whole UI for seconds at a time.

   Two things this file exists to get right:

   1. **Token budget.** `KokoroTTS.generate` truncates its input at
      510 tokens *silently*. Hand it a paragraph and you lose the end
      of it with no error. So text is split into segments that
      comfortably fit, synthesized in order, and concatenated.

   2. **Backend selection.** WebGPU is several times faster where it
      works and quietly broken where it does not. We prove it with a
      real generation before reporting ready, and fall back to WASM.
   ──────────────────────────────────────────────────────────────── */

/// <reference lib="webworker" />

import { KokoroTTS, env } from "kokoro-js";
import { asset } from "@/lib/base-path";

/** Apache-2.0 weights, ONNX-converted, hosted on the Hugging Face CDN. */
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

/**
 * int8. ~86 MB against ~326 MB for fp32, and the quality gap on speech
 * is not audible next to a download eight times the size — which on a
 * public website is the difference between "it works" and "I closed the tab".
 */
const DTYPE = "q8" as const;

/** Sample rate Kokoro emits. Not configurable; asserted, not assumed. */
const SAMPLE_RATE = 24_000;

/**
 * Characters per synthesis segment. English runs ~1.1 phoneme tokens per
 * character, so 300 leaves ample headroom under the 510-token ceiling even
 * for phoneme-dense text.
 */
const MAX_SEGMENT_CHARS = 300;

/** The model's own voice keys — `af_heart`, `bm_george`, and so on. */
type KokoroVoice = keyof KokoroTTS["voices"];

type Inbound =
  | { type: "init" }
  | { type: "generate"; id: number; text: string; voice: string; speed: number };

type Outbound =
  | { type: "ready"; device: string }
  | { type: "progress"; ratio: number; detail: string }
  | { type: "audio"; id: number; wav: ArrayBuffer; seconds: number }
  | { type: "error"; id: number | null; message: string };

function post(msg: Outbound, transfer?: Transferable[]) {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

/**
 * Point onnxruntime at the wasm binaries `scripts/copy-ort-runtime.mjs` copies
 * into /public/ort. Serving them from our own origin takes a third-party CDN
 * off the critical path of every first synthesis.
 *
 * Checked rather than assumed: if that copy never ran, an unconditional
 * override would turn a working CDN default into a 404 and a dead play button.
 */
async function useLocalRuntime(): Promise<void> {
  const base = `${self.location.origin}${asset("/ort/")}`;
  try {
    // The 44 KB loader rather than the 21 MB binary beside it: onnxruntime
    // fetches this file anyway, so a hit here costs nothing and a miss is
    // cheap. Both files are written by the same script, so one proves the other.
    const res = await fetch(`${base}ort-wasm-simd-threaded.jsep.mjs`);
    if (res.ok) env.wasmPaths = base;
  } catch {
    /* keep onnxruntime's own default */
  }
}

/* ── Model lifecycle ─────────────────────────────────────────── */

let tts: KokoroTTS | null = null;
let loading: Promise<KokoroTTS> | null = null;

/** Per-file download tallies, so progress reflects the whole model. */
const downloads = new Map<string, { loaded: number; total: number }>();

function onProgress(event: { status?: string; file?: string; loaded?: number; total?: number }) {
  if (event.status !== "progress" || !event.file || !event.total) return;
  downloads.set(event.file, { loaded: event.loaded ?? 0, total: event.total });

  let loaded = 0;
  let total = 0;
  for (const d of downloads.values()) {
    loaded += d.loaded;
    total += d.total;
  }
  if (!total) return;
  post({
    type: "progress",
    // Reserve the last slice of the bar for warm-up, which is not free.
    ratio: Math.min(0.95, loaded / total),
    detail: `Downloading voice model — ${mb(loaded)} of ${mb(total)} MB`,
  });
}

function mb(bytes: number): string {
  return (bytes / 1_048_576).toFixed(0);
}

async function webGPUAvailable(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return Boolean(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

/**
 * Load the model, preferring WebGPU.
 *
 * The warm-up generation is not ceremony. A WebGPU adapter can exist and still
 * fail to run this graph — driver quirks, an ANGLE fallback, an operator the
 * backend does not implement — and it fails at *inference*, not at load. If we
 * reported ready on a successful `from_pretrained` alone, the failure would
 * instead surface as a broken play button. Proving the path end-to-end here
 * means a fallback costs a few seconds; not proving it costs a working app.
 */
async function load(): Promise<KokoroTTS> {
  if (tts) return tts;
  if (loading) return loading;

  loading = (async () => {
    await useLocalRuntime();

    const devices: Array<"webgpu" | "wasm"> = (await webGPUAvailable())
      ? ["webgpu", "wasm"]
      : ["wasm"];

    let lastError: unknown;
    for (const device of devices) {
      try {
        post({ type: "progress", ratio: 0, detail: "Preparing voice model" });
        const model = await KokoroTTS.from_pretrained(MODEL_ID, {
          dtype: DTYPE,
          device,
          progress_callback: onProgress,
        });

        post({ type: "progress", ratio: 0.96, detail: "Warming up the voice" });
        // Both weights and the compiled graph are exercised by this.
        const probe = await model.generate("Ready.", { voice: "af_heart", speed: 1 });
        if (!probe.audio.length) throw new Error("model produced no audio");

        tts = model;
        post({ type: "progress", ratio: 1, detail: "Voice ready" });
        post({ type: "ready", device });
        return model;
      } catch (err) {
        lastError = err;
        // Fall through to the next backend; the last failure is the one reported.
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Could not start the on-device voice model.");
  })();

  try {
    return await loading;
  } catch (err) {
    // Let a later attempt retry from scratch rather than latching the failure.
    loading = null;
    throw err;
  }
}

/* ── Text segmentation ───────────────────────────────────────── */

/**
 * Split text into pieces the model will not truncate.
 *
 * Sentence boundaries first, because a break mid-sentence is audible as a
 * dropped beat. Only when a single sentence is itself too long do we fall back
 * to clause punctuation, and only then to whitespace — each step a worse place
 * to breathe than the one before, and each still better than losing the words.
 */
function segment(text: string): string[] {
  const out: string[] = [];
  for (const sentence of splitSentences(text)) {
    if (sentence.length <= MAX_SEGMENT_CHARS) {
      out.push(sentence);
      continue;
    }
    for (const clause of splitLong(sentence, /[;:,—–)\]]\s+/g)) {
      if (clause.length <= MAX_SEGMENT_CHARS) out.push(clause);
      else out.push(...splitLong(clause, /\s+/g));
    }
  }
  return out.filter((s) => /\S/.test(s));
}

function splitSentences(text: string): string[] {
  // Intl.Segmenter where the engine has it; a terminator scan where it does not.
  // Either way the model only ever sees whole sentences when they fit.
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const seg = new Intl.Segmenter("en", { granularity: "sentence" });
    return Array.from(seg.segment(text), (s) => s.segment.trim()).filter(Boolean);
  }
  return text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Greedily pack the pieces `pattern` produces into segments under the ceiling.
 * A piece that is *still* too long (an unbroken 400-character token — a URL, a
 * chemical name) is passed through whole: truncation would be worse than a
 * segment the model has to work at.
 */
function splitLong(text: string, pattern: RegExp): string[] {
  const pieces = text.split(pattern).filter(Boolean);
  const out: string[] = [];
  let current = "";

  for (const piece of pieces) {
    const candidate = current ? `${current} ${piece}` : piece;
    if (candidate.length <= MAX_SEGMENT_CHARS) {
      current = candidate;
    } else {
      if (current) out.push(current);
      current = piece;
    }
  }
  if (current) out.push(current);
  return out;
}

/* ── Synthesis ───────────────────────────────────────────────── */

/**
 * One generation at a time.
 *
 * The playback path and the prefetch path both post work here, and the export
 * pipeline posts several passages at once. Running them concurrently against a
 * single ONNX session does not make any of them faster — it just multiplies
 * peak memory and lets a prefetch delay the passage actually being listened to.
 */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

async function generate(text: string, voice: string, speed: number): Promise<Float32Array> {
  const model = await load();
  const segments = segment(text);
  if (!segments.length) return new Float32Array(0);

  const parts: Float32Array[] = [];
  for (const part of segments) {
    const audio = await model.generate(part, { voice: voice as KokoroVoice, speed });
    if (audio.sampling_rate !== SAMPLE_RATE) {
      throw new Error(
        `Kokoro returned ${audio.sampling_rate} Hz; the pipeline assumes ${SAMPLE_RATE} Hz.`,
      );
    }
    parts.push(audio.audio);
  }

  if (parts.length === 1) return parts[0];
  let length = 0;
  for (const p of parts) length += p.length;
  const merged = new Float32Array(length);
  let offset = 0;
  for (const p of parts) {
    merged.set(p, offset);
    offset += p.length;
  }
  return merged;
}

/**
 * 16-bit PCM WAV. The export pipeline hands these bytes straight to
 * `decodeAudioData`, and 16-bit halves what the clip cache holds against
 * float32 for no audible loss on speech.
 */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    // Asymmetric scaling: int16 reaches -32768 but only +32767.
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

/* ── Message loop ────────────────────────────────────────────── */

self.onmessage = (event: MessageEvent<Inbound>) => {
  const msg = event.data;

  if (msg.type === "init") {
    void load().catch((err: unknown) => {
      post({ type: "error", id: null, message: describe(err) });
    });
    return;
  }

  if (msg.type === "generate") {
    void enqueue(async () => {
      try {
        const samples = await generate(msg.text, msg.voice, msg.speed);
        const wav = encodeWav(samples, SAMPLE_RATE);
        post(
          { type: "audio", id: msg.id, wav, seconds: samples.length / SAMPLE_RATE },
          [wav],
        );
      } catch (err) {
        post({ type: "error", id: msg.id, message: describe(err) });
      }
    });
  }
};

/**
 * Turn a thrown value into something worth showing a reader.
 *
 * The common failure by far is the model download not completing — no
 * connection, a captive portal, an extension blocking the CDN — and what
 * `fetch` gives us for all of those is the bare string "Failed to fetch",
 * which tells nobody anything. Everything else is passed through: an ONNX
 * error is at least a lead.
 */
function describe(err: unknown): string {
  const raw =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";

  if (!raw) return "The on-device voice model failed to start.";
  if (/failed to fetch|networkerror|load failed|err_/i.test(raw)) {
    return "Could not download the voice model. Check your connection and try again.";
  }
  return raw;
}
