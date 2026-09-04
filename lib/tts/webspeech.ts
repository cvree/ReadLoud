/* ────────────────────────────────────────────────────────────────
   Web Speech provider — the zero-config baseline.

   This API is riddled with engine-specific defects. Everything odd
   below is a workaround for a real one:

   * Chrome populates `getVoices()` asynchronously and fires
     `voiceschanged` — sometimes more than once, sometimes never.
   * Chrome kills any utterance still speaking after ~15s unless you
     pause/resume it on a timer. The "keepalive" below is why long
     passages do not cut off mid-word.
   * `speechSynthesis.cancel()` inside an `onend` handler can wedge
     the queue; we always cancel on the next macrotask.
   * Safari fires no `boundary` events at all, so highlighting falls
     back to a timed estimator.
   * Firefox reports `charLength: 0` on boundary events.

   IMPORTANT ARCHITECTURAL NOTE: the Web Speech API deliberately gives
   no access to the synthesized audio stream. There is no
   `MediaStream`, no `AudioNode`, no buffer. That is why this provider
   reports `synthesize: false` and why MP3 export of Web Speech audio
   requires the tab-capture path in `lib/audio/capture.ts`.
   ──────────────────────────────────────────────────────────────── */

import type {
  BoundaryEvent,
  SpeakRequest,
  SpeechHandle,
  TTSProvider,
  Voice,
} from "@/lib/types";
import { BASE_WPM } from "@/lib/text/normalize";

/** Chrome's watchdog fires around 15s; resume well before that. */
const KEEPALIVE_MS = 9_000;

function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window
    ? window.speechSynthesis
    : null;
}

let voiceCache: Voice[] | null = null;
let nativeVoices: SpeechSynthesisVoice[] = [];

async function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const s = synth();
  if (!s) return [];

  const immediate = s.getVoices();
  if (immediate.length) {
    nativeVoices = immediate;
    return immediate;
  }

  // Chrome resolves this asynchronously and occasionally not at all.
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      s.removeEventListener("voiceschanged", finish);
      clearInterval(poll);
      clearTimeout(bail);
      nativeVoices = s.getVoices();
      resolve(nativeVoices);
    };
    s.addEventListener("voiceschanged", finish);
    // Belt and braces: some builds never fire the event.
    const poll = setInterval(() => {
      if (s.getVoices().length) finish();
    }, 120);
    const bail = setTimeout(finish, 3_000);
  });
}

/** Rank voices so the good ones float to the top of the picker. */
function qualityScore(v: SpeechSynthesisVoice): number {
  const n = v.name.toLowerCase();
  let score = 0;
  if (!v.localService) score += 40; // network voices are near-neural
  if (/natural|neural|premium|enhanced|siri|wavenet|studio/.test(n)) score += 60;
  if (/google/.test(n)) score += 25;
  if (/microsoft/.test(n)) score += 15;
  if (/compact|novelty|eloquence|espeak/.test(n)) score -= 40;
  if (v.default) score += 5;
  if (v.lang.toLowerCase().startsWith("en")) score += 10;
  return score;
}

export const webSpeechProvider: TTSProvider = {
  id: "webspeech",
  label: "System voices",
  blurb:
    "Whatever your browser already ships. Nothing to download, starts instantly, but the voices are your operating system's.",
  capabilities: {
    synthesize: false,
    boundaries: true,
    rate: true,
    pitch: true,
    local: true,
  },

  async isAvailable() {
    return synth() !== null;
  },

  async listVoices() {
    if (voiceCache) return voiceCache;
    const native = await loadVoices();
    voiceCache = native
      .map((v) => ({ v, score: qualityScore(v) }))
      .sort((a, b) => b.score - a.score || a.v.name.localeCompare(b.v.name))
      .map(({ v, score }) => ({
        id: v.voiceURI,
        name: v.name.replace(/^(Microsoft|Google)\s+/, ""),
        provider: "webspeech" as const,
        lang: v.lang,
        local: v.localService,
        tag: score >= 60 ? "Premium" : v.localService ? "Offline" : "Network",
      }));
    return voiceCache;
  },

  speak(req: SpeakRequest, onBoundary?: (e: BoundaryEvent) => void): SpeechHandle {
    const s = synth();
    if (!s) {
      return {
        done: Promise.reject(new Error("Speech synthesis is not available in this browser.")),
        pause() {},
        resume() {},
        cancel() {},
      };
    }

    const utter = new SpeechSynthesisUtterance(req.text);
    const voice = nativeVoices.find((v) => v.voiceURI === req.voiceId);
    if (voice) {
      utter.voice = voice;
      utter.lang = voice.lang;
    }
    utter.rate = clamp(req.rate, 0.1, 10);
    utter.pitch = clamp(req.pitch, 0, 2);
    utter.volume = clamp(req.volume, 0, 1);

    let finished = false;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let estimator: ReturnType<typeof setInterval> | undefined;
    const startedAt = performance.now();
    let sawBoundary = false;

    const cleanup = () => {
      finished = true;
      if (keepalive) clearInterval(keepalive);
      if (estimator) clearInterval(estimator);
      req.signal?.removeEventListener("abort", onAbort);
    };

    const done = new Promise<void>((resolve, reject) => {
      utter.onend = () => {
        if (finished) return;
        cleanup();
        // Report completion so the highlight lands on the final word.
        onBoundary?.({
          charIndex: req.text.length,
          charLength: 0,
          elapsed: (performance.now() - startedAt) / 1000,
        });
        resolve();
      };
      utter.onerror = (e) => {
        if (finished) return;
        cleanup();
        // "interrupted"/"canceled" are our own cancel() calls, not failures.
        if (e.error === "interrupted" || e.error === "canceled") resolve();
        else reject(new Error(`Speech engine error: ${e.error}`));
      };
      utter.onboundary = (e) => {
        if (e.name && e.name !== "word") return;
        sawBoundary = true;
        onBoundary?.({
          charIndex: e.charIndex,
          // Firefox reports 0; derive the length from the text instead.
          charLength: e.charLength || wordLengthAt(req.text, e.charIndex),
          elapsed: (performance.now() - startedAt) / 1000,
        });
      };
    });

    const onAbort = () => handle.cancel();
    req.signal?.addEventListener("abort", onAbort, { once: true });

    // Chrome truncates long utterances; a periodic pause/resume resets its
    // watchdog without any audible seam.
    keepalive = setInterval(() => {
      if (finished) return;
      if (s.speaking && !s.paused) {
        s.pause();
        s.resume();
      }
    }, KEEPALIVE_MS);

    // Safari never fires `boundary`. After 700ms of silence from the engine,
    // synthesize our own progress from the configured words-per-minute so the
    // reading-mode highlight still tracks.
    estimator = setInterval(() => {
      if (finished || sawBoundary) return;
      const elapsed = (performance.now() - startedAt) / 1000;
      const charsPerSecond = (BASE_WPM * req.rate * 5.6) / 60;
      const charIndex = Math.min(req.text.length - 1, Math.floor(elapsed * charsPerSecond));
      if (charIndex < 0) return;
      onBoundary?.({
        charIndex,
        charLength: wordLengthAt(req.text, charIndex),
        elapsed,
      });
    }, 140);

    s.speak(utter);

    const handle: SpeechHandle = {
      done,
      pause: () => s.pause(),
      resume: () => s.resume(),
      cancel: () => {
        if (finished) return;
        cleanup();
        // Cancelling synchronously from inside an event handler wedges the
        // Chrome queue; defer by a macrotask.
        setTimeout(() => s.cancel(), 0);
      },
    };
    return handle;
  },
};

function wordLengthAt(text: string, index: number): number {
  const m = /^[^\s]*/.exec(text.slice(index));
  return m ? m[0].length : 1;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Chrome leaves the queue in a bad state after a hard reload mid-utterance. */
export function resetSpeechQueue(): void {
  const s = synth();
  if (s && (s.speaking || s.pending)) s.cancel();
}
