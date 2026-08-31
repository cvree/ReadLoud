/* ────────────────────────────────────────────────────────────────
   Cloud providers (OpenAI TTS, ElevenLabs).

   These are the ones that make MP3 export *deterministic*: they hand
   back real audio bytes, so we can decode, concatenate and encode
   offline — faster than realtime, bit-exact, repeatable.

   Both share one implementation because they share one shape:
     POST /api/tts { provider, voiceId, text, rate } -> audio bytes
   The API key never reaches the browser; the route in
   `app/api/tts/route.ts` holds it.

   To add a provider (PlayHT, Cartesia, Azure, a self-hosted Piper):
     1. add a case to `app/api/tts/route.ts`
     2. add a `makeCloudProvider({...})` entry below
     3. register it in `lib/tts/registry.ts`
   Nothing else in the app changes.
   ──────────────────────────────────────────────────────────────── */

import type {
  BoundaryEvent,
  ProviderId,
  SpeakRequest,
  SpeechHandle,
  TTSProvider,
  Voice,
} from "@/lib/types";
import { BASE_WPM } from "@/lib/text/normalize";
import * as clips from "./cache";

interface CloudConfig {
  id: ProviderId;
  label: string;
  blurb: string;
  fallbackVoices: Voice[];
}

async function postSynthesis(
  provider: ProviderId,
  req: SpeakRequest,
): Promise<{ bytes: ArrayBuffer; mime: string }> {
  const key = clips.cacheKey(provider, req.voiceId, req.rate, req.text);
  const cached = clips.get(key);
  // `decodeAudioData` detaches whatever buffer it is handed, so every consumer
  // gets its own copy of the cached bytes.
  if (cached) return { bytes: cached.bytes.slice(0), mime: cached.mime };

  const clip = await clips.dedupe(key, () => fetchClip(provider, req));
  return { bytes: clip.bytes.slice(0), mime: clip.mime };
}

async function fetchClip(
  provider: ProviderId,
  req: SpeakRequest,
): Promise<{ bytes: ArrayBuffer; mime: string }> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider,
      text: req.text,
      voiceId: req.voiceId,
      rate: req.rate,
    }),
    signal: req.signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `${provider} synthesis failed (${res.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    );
  }
  return {
    bytes: await res.arrayBuffer(),
    mime: res.headers.get("content-type") ?? "audio/mpeg",
  };
}

export function makeCloudProvider(config: CloudConfig): TTSProvider {
  let available: boolean | null = null;
  let voices: Voice[] | null = null;

  return {
    id: config.id,
    label: config.label,
    blurb: config.blurb,
    capabilities: {
      synthesize: true,
      // No word timings from these APIs today. ElevenLabs' timestamps
      // endpoint could feed this later; until then we interpolate.
      boundaries: false,
      rate: config.id === "openai",
      pitch: false,
      needsKey: true,
    },

    async isAvailable() {
      if (available !== null) return available;
      try {
        const res = await fetch(`/api/tts?provider=${config.id}`);
        const json = (await res.json()) as { available?: boolean };
        available = Boolean(json.available);
      } catch {
        available = false;
      }
      return available;
    },

    async listVoices() {
      if (voices) return voices;
      try {
        const res = await fetch(`/api/tts?provider=${config.id}&voices=1`);
        if (res.ok) {
          const json = (await res.json()) as { voices?: Voice[] };
          if (json.voices?.length) {
            voices = json.voices;
            return voices;
          }
        }
      } catch {
        /* fall through to the static catalogue */
      }
      voices = config.fallbackVoices;
      return voices;
    },

    synthesize(req) {
      return postSynthesis(config.id, req);
    },

    /**
     * Warm the next passage while the current one plays. Without this every
     * passage boundary costs a full round-trip of silence and the narration
     * sounds like it is buffering. Failures are swallowed on purpose: a
     * prefetch that misses just means the real request pays for it.
     */
    prefetch(req) {
      void postSynthesis(config.id, { ...req, signal: undefined }).catch(() => {});
    },

    /**
     * Live playback for a buffer provider: fetch the clip, play it through an
     * <audio> element, and interpolate boundaries from wall-clock position so
     * reading mode still highlights.
     */
    speak(req: SpeakRequest, onBoundary?: (e: BoundaryEvent) => void): SpeechHandle {
      const audio = new Audio();
      audio.preload = "auto";
      audio.volume = Math.min(1, Math.max(0, req.volume));
      // OpenAI applies `speed` server-side; ElevenLabs does not, so we adjust
      // playback rate locally and preserve pitch.
      audio.playbackRate = config.id === "openai" ? 1 : req.rate;
      audio.preservesPitch = true;

      let url: string | null = null;
      let raf = 0;
      let cancelled = false;

      const tick = () => {
        if (cancelled) return;
        const dur = audio.duration;
        if (Number.isFinite(dur) && dur > 0 && onBoundary) {
          const ratio = Math.min(1, audio.currentTime / dur);
          const snapped = snapToWord(req.text, Math.floor(ratio * req.text.length));
          onBoundary({ ...snapped, elapsed: audio.currentTime });
        }
        raf = requestAnimationFrame(tick);
      };

      const done = (async () => {
        const { bytes, mime } = await postSynthesis(config.id, req);
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        audio.src = url;

        await new Promise<void>((resolve, reject) => {
          audio.onended = () => resolve();
          audio.onerror = () => reject(new Error("Audio playback failed."));
          audio.play().then(
            () => { raf = requestAnimationFrame(tick); },
            (err: unknown) => {
              // Autoplay policy: the first play must originate from a gesture.
              reject(
                err instanceof DOMException && err.name === "NotAllowedError"
                  ? new Error("Your browser blocked playback. Press play again to grant permission.")
                  : (err as Error),
              );
            },
          );
        });
      })().finally(() => {
        cancelAnimationFrame(raf);
        if (url) URL.revokeObjectURL(url);
      });

      req.signal?.addEventListener("abort", () => handle.cancel(), { once: true });

      const handle: SpeechHandle = {
        done,
        pause: () => audio.pause(),
        resume: () => void audio.play().catch(() => {}),
        cancel: () => {
          cancelled = true;
          cancelAnimationFrame(raf);
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
          if (url) URL.revokeObjectURL(url);
        },
      };
      return handle;
    },
  };
}

/**
 * Snap an interpolated position onto the word that contains it.
 *
 * These providers give no word timings, so the cursor is derived from clip
 * position as a fraction of character count. Left raw it lands mid-word and
 * highlights fragments like "olitely." or a lone space, which reads as a bug
 * rather than as an approximation. Snapping back to the word start keeps the
 * highlight honest-looking: still approximate in *time*, always correct as a
 * *word*.
 */
function snapToWord(text: string, index: number): { charIndex: number; charLength: number } {
  if (text.length === 0) return { charIndex: 0, charLength: 0 };
  let i = Math.max(0, Math.min(index, text.length - 1));

  // If we landed in whitespace, move forward to the next word.
  while (i < text.length && /\s/.test(text[i])) i++;
  if (i >= text.length) {
    // Trailing whitespace: hold on the final word rather than vanishing.
    i = text.length - 1;
    while (i > 0 && /\s/.test(text[i])) i--;
  }
  // Walk back to the start of the word we are inside.
  while (i > 0 && !/\s/.test(text[i - 1])) i--;

  const m = /^\S+/.exec(text.slice(i));
  return { charIndex: i, charLength: m ? m[0].length : 1 };
}

/** Used only for pre-render duration estimates in the export planner. */
export function estimateClipSeconds(text: string, rate: number): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return (words / (BASE_WPM * rate)) * 60;
}

export const openAIProvider = makeCloudProvider({
  id: "openai",
  label: "OpenAI TTS",
  blurb: "Studio-grade neural voices. Deterministic MP3 export, faster than realtime.",
  fallbackVoices: [
    { id: "alloy", name: "Alloy", provider: "openai", tag: "Neutral" },
    { id: "ash", name: "Ash", provider: "openai", tag: "Warm" },
    { id: "ballad", name: "Ballad", provider: "openai", tag: "Lyrical" },
    { id: "coral", name: "Coral", provider: "openai", tag: "Bright" },
    { id: "echo", name: "Echo", provider: "openai", tag: "Measured" },
    { id: "fable", name: "Fable", provider: "openai", tag: "Storyteller" },
    { id: "onyx", name: "Onyx", provider: "openai", tag: "Deep" },
    { id: "nova", name: "Nova", provider: "openai", tag: "Crisp" },
    { id: "sage", name: "Sage", provider: "openai", tag: "Calm" },
    { id: "shimmer", name: "Shimmer", provider: "openai", tag: "Airy" },
  ],
});

export const elevenLabsProvider = makeCloudProvider({
  id: "elevenlabs",
  label: "ElevenLabs",
  blurb: "The most expressive long-form narration available. Ideal for books.",
  fallbackVoices: [
    { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", provider: "elevenlabs", tag: "Narration" },
    { id: "AZnzlk1XvdvUeBnXmlld", name: "Domi", provider: "elevenlabs", tag: "Confident" },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", provider: "elevenlabs", tag: "Soft" },
    { id: "ErXwobaYiN019PkySvjV", name: "Antoni", provider: "elevenlabs", tag: "Warm" },
    { id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh", provider: "elevenlabs", tag: "Deep" },
    { id: "VR6AewLTigWG4xSOukaG", name: "Arnold", provider: "elevenlabs", tag: "Crisp" },
    { id: "pNInz6obpgDQGcFmaJgB", name: "Adam", provider: "elevenlabs", tag: "Documentary" },
  ],
});
