/* ────────────────────────────────────────────────────────────────
   The silent pacer: a TTSProvider that makes no sound.

   This is the one architectural decision the whole feature rests on.
   RSVP is not a new subsystem — it is a second renderer over a cursor
   ReadLoud already computes. `NarratorState.cursor` is an absolute
   character offset updated at word rate; the scrolling reader draws it
   as an amber highlight inside a paragraph, and reading mode draws the
   same number as one word in the middle of an empty screen.

   So silent mode is not a parallel engine. It is a provider that emits
   word boundaries and no audio, and `Narrator` drives it with no
   changes to its control flow. Everything below comes free:

     * chunk advance, gap timing, `stopAtSectionEnd`
     * `jump`, `seekTime`, `nudge`, the prefix-sum timeline
     * measured-duration correction — and here the measurement is
       *exact*, so the scrubber becomes truthful after one passage
       instead of gradually
     * the transport bar, the outline's progress, follow-scroll in the
       reader behind the overlay, the re-chunk path
     * one cursor, so voice mode and silent mode cannot drift apart by
       construction

   It is deliberately not registered in `PROVIDERS`: it is not a voice,
   it must never appear in the voice picker, and `synthesize: false`
   would otherwise offer the realtime-capture export path for something
   that produces no sound.
   ──────────────────────────────────────────────────────────────── */

import type { BoundaryEvent, SpeakRequest, SpeechHandle, TTSProvider } from "@/lib/types";
import { BASE_WPM } from "@/lib/text/normalize";
import { startClock } from "./clock.ts";
import { dwellsMs, withRampUp } from "./pacing.ts";
import { tokenize, tokenIndexAt } from "./tokenize.ts";

/** WPM the narrator's `rate` corresponds to, and back again. */
export function wpmToRate(wpm: number): number {
  return wpm / BASE_WPM;
}
export function rateToWpm(rate: number): number {
  return rate * BASE_WPM;
}

/**
 * When the previous passage ended, so a fresh start can be told from a
 * passage seam.
 *
 * The ramp-up belongs to a *session*, not to every passage: easing into the
 * target rate once when you press play is help, doing it again every twenty
 * seconds is a stutter. Seams are separated by `gapSeconds` (0.18 s by
 * default, 0.63 s across a section), so anything over a second means somebody
 * pressed play.
 */
let lastActivityAt = -Infinity;
const SESSION_GAP_MS = 1200;

export const silentPacer: TTSProvider = {
  id: "silent",
  label: "Silent pacer",
  blurb: "Paces reading mode from a clock instead of a voice. Produces no audio.",

  capabilities: {
    synthesize: false,
    boundaries: true,
    rate: true,
    pitch: false,
    // Honored exactly: stepping back a word is a different index into an
    // array, not a re-synthesis.
    resume: true,
    local: true,
  },

  async isAvailable() {
    return typeof performance !== "undefined" && typeof requestAnimationFrame !== "undefined";
  },

  /** Not a voice. The picker never sees this provider. */
  async listVoices() {
    return [];
  },

  speak(req: SpeakRequest, onBoundary?: (e: BoundaryEvent) => void): SpeechHandle {
    const wpm = rateToWpm(Number.isFinite(req.rate) && req.rate > 0 ? req.rate : 1);

    // Tokenize and pace the *whole* passage even when resuming into the
    // middle of it, so that the normalization — and therefore what the dial
    // means — does not depend on where you happened to step back to.
    const all = tokenize(req.text);
    const everyDwell = dwellsMs(all, wpm);

    const startChar = Math.max(0, Math.min(req.startChar ?? 0, Math.max(0, req.text.length - 1)));
    const from = startChar > 0 ? Math.max(0, tokenIndexAt(all, startChar)) : 0;

    const tokens = all.slice(from);
    const skippedMs = everyDwell.slice(0, from).reduce((a, b) => a + b, 0);

    const fresh = now() - lastActivityAt > SESSION_GAP_MS;
    const dwells = fresh ? withRampUp(everyDwell.slice(from)) : everyDwell.slice(from);

    // Resolve-only: a clock has no failure mode, and a cancelled handle
    // resolves for the same reason Web Speech treats "interrupted" as
    // success — the narrator's epoch guard is what decides whether the
    // continuation runs.
    let settle: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const clock = startClock({
      dwells,
      onIndex(index, elapsedMs) {
        const token = tokens[index];
        if (!token) return;
        onBoundary?.({
          charIndex: token.start,
          charLength: token.text.length,
          elapsed: (skippedMs + elapsedMs) / 1000,
        });
      },
      onDone(totalMs) {
        lastActivityAt = now();
        // One last boundary on the same word, carrying the full elapsed time.
        // `Narrator.record()` reads the last elapsed value it saw, and without
        // this the final word's dwell would be missing from every measured
        // passage duration.
        const token = tokens[tokens.length - 1];
        if (token) {
          onBoundary?.({
            charIndex: token.start,
            charLength: token.text.length,
            elapsed: (skippedMs + totalMs) / 1000,
          });
        }
        settle();
      },
    });

    return {
      done,
      pause() {
        clock.pause();
      },
      resume() {
        clock.resume();
      },
      cancel() {
        lastActivityAt = now();
        clock.cancel();
        settle();
      },
    };
  },
};

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
