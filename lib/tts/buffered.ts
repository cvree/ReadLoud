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
 *
 * `req.startChar` is honored by synthesizing only the tail of the passage.
 * That is what lets reading mode step back one word without restarting the
 * whole passage on the neural voice: it costs one inference (Kokoro renders
 * faster than realtime, so a passage is a fraction of a second) and the
 * prosody restarts from that word rather than being spliced, which is the
 * honest version of resuming mid-sentence. Boundary events are reported
 * against the *full* passage, so nothing above this function has to know.
 */
export function playBuffered(
  req: SpeakRequest,
  onBoundary: ((e: BoundaryEvent) => void) | undefined,
  opts: BufferedPlaybackOptions,
): SpeechHandle {
  const offset = Math.max(0, Math.min(req.startChar ?? 0, Math.max(0, req.text.length - 1)));
  // Everything below works in tail coordinates; only the boundary events are
  // translated back.
  const tail: SpeakRequest =
    offset > 0 ? { ...req, text: req.text.slice(offset), startChar: 0 } : req;

  const audio = new Audio();
  audio.preload = "auto";
  audio.volume = Math.min(1, Math.max(0, req.volume));
  audio.playbackRate = opts.playbackRate(tail);
  audio.preservesPitch = true;

  let url: string | null = null;
  let raf = 0;
  let cancelled = false;

  const tick = () => {
    if (cancelled) return;
    const dur = audio.duration;
    if (Number.isFinite(dur) && dur > 0 && onBoundary) {
      const ratio = Math.min(1, audio.currentTime / dur);
      const snapped = snapToWord(tail.text, Math.floor(ratio * tail.text.length));
      // The clip is only the tail, so its clock starts at zero. Add back a
      // pro-rata estimate of the part that was skipped, or the transport bar
      // would jump backwards every time somebody steps into a passage.
      const skipped = offset > 0 ? (offset / tail.text.length) * dur : 0;
      onBoundary({
        charIndex: snapped.charIndex + offset,
        charLength: snapped.charLength,
        elapsed: skipped + audio.currentTime,
      });
    }
    raf = requestAnimationFrame(tick);
  };

  const done = (async () => {
    const { bytes, mime } = await opts.load(tail);
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
