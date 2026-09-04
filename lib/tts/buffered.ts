/* ────────────────────────────────────────────────────────────────
   Live playback for providers that return audio *buffers* rather
   than speaking directly.

   Web Speech hands us an utterance and fires word-boundary events as
   it goes. A buffer provider hands us bytes: we own playback, and we
   own the highlight cursor, which has to be interpolated from clip
   position because there are no timings to read.
   ──────────────────────────────────────────────────────────────── */

import type { BoundaryEvent, SpeakRequest, SpeechHandle } from "@/lib/types";
import type { Clip } from "./cache";

export interface BufferedPlaybackOptions {
  /** Fetch (or synthesize) the clip for this request. */
  load(req: SpeakRequest): Promise<Clip>;
  /**
   * Playback rate to apply locally, after whatever the provider already
   * baked into the audio. 1 when the provider honored `rate` itself.
   */
  playbackRate(req: SpeakRequest): number;
}

/**
 * Play a clip through an `<audio>` element and interpolate boundaries from
 * wall-clock position, so reading mode still highlights along with the voice.
 */
export function playBuffered(
  req: SpeakRequest,
  onBoundary: ((e: BoundaryEvent) => void) | undefined,
  opts: BufferedPlaybackOptions,
): SpeechHandle {
  const audio = new Audio();
  audio.preload = "auto";
  audio.volume = Math.min(1, Math.max(0, req.volume));
  audio.playbackRate = opts.playbackRate(req);
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
    const { bytes, mime } = await opts.load(req);
    if (cancelled) return;
    url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    audio.src = url;

    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("Audio playback failed."));
      audio.play().then(
        () => {
          raf = requestAnimationFrame(tick);
        },
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
}

/**
 * Snap an interpolated position onto the word that contains it.
 *
 * Buffer providers give no word timings, so the cursor is derived from clip
 * position as a fraction of character count. Left raw it lands mid-word and
 * highlights fragments like "olitely." or a lone space, which reads as a bug
 * rather than as an approximation. Snapping back to the word start keeps the
 * highlight honest-looking: still approximate in *time*, always correct as a
 * *word*.
 */
export function snapToWord(
  text: string,
  index: number,
): { charIndex: number; charLength: number } {
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
