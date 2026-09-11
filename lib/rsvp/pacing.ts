/* ────────────────────────────────────────────────────────────────
   Per-word dwell.

   A flat 60000/wpm per word is what makes cheap RSVP implementations
   exhausting: punctuation disappears, so sentences run together and
   nothing breathes. Long words get the same 90 ms as "the", and a full
   stop is indistinguishable from a space.

   So each token gets a weight, and the weights are then *normalized to
   a mean of 1*. That second step is the honest part: it means the dial
   says what it does. At 600 wpm a 6,000-word chapter takes ten
   minutes — the pauses are paid for by the words around them, not
   added on top of a number the UI already promised.
   ──────────────────────────────────────────────────────────────── */

import type { RsvpToken } from "./tokenize.ts";

/** The dial's range. Below 150 the voice is better; above 1200 see below. */
export const WPM_RANGE = { min: 150, max: 1200, step: 25 } as const;

/**
 * Frame quantization is real above ~900 wpm: at 1000 wpm a word is 60 ms,
 * which on a 60 Hz display is 3.6 frames, so per-word timing quantizes to
 * about ±8 ms. The ceiling is 1200 rather than the 2000-and-up competitors
 * advertise because 1200 is the last figure this can actually deliver.
 */
export const WPM_QUANTIZED_ABOVE = 900;

/** Above this, expect a real comprehension cost on unfamiliar material. */
export const WPM_COMPREHENSION_EDGE = 500;

export interface PacingOptions {
  /** The first token of a section gets a long beat to land the heading. */
  firstIsSectionStart?: boolean;
}

/**
 * Relative dwell weights, before normalization.
 *
 * Exported for the self-test and the pacing report; the pacer itself wants
 * `dwellsMs`.
 */
export function dwellWeights(tokens: RsvpToken[], opts: PacingOptions = {}): number[] {
  return tokens.map((t, i) => {
    let w = 1;

    // Long words need proportionally more than their share of the clock;
    // capped, or a single 20-character term stalls the whole passage.
    if (t.display.length > 8) w += Math.min(0.6, (t.display.length - 8) * 0.04);

    if (t.flags.endsParagraph) w *= 2.6;
    else if (t.flags.endsSentence) w *= 2.1;
    else if (t.flags.endsClause) w *= 1.45;

    if (t.flags.numeric) w *= 1.3;
    if (t.flags.continued) w *= 0.8;
    if (i === 0 && opts.firstIsSectionStart) w *= 3;

    return w;
  });
}

/**
 * Per-token dwell in milliseconds at `wpm`.
 *
 * Normalized, so `sum(dwells) === tokens.length * 60000 / wpm` to within
 * floating point. That identity is what `rsvpPacingReport()` checks.
 */
export function dwellsMs(tokens: RsvpToken[], wpm: number, opts: PacingOptions = {}): number[] {
  if (tokens.length === 0) return [];
  const rate = Math.max(1, wpm);
  const perWord = 60000 / rate;

  const weights = dwellWeights(tokens, opts);
  const mean = weights.reduce((a, b) => a + b, 0) / weights.length;
  // A document of nothing but paragraph-final words would have mean 2.6; this
  // is what stops that from reading at 0.38x the requested rate.
  const scale = mean > 0 ? perWord / mean : perWord;
  return weights.map((w) => w * scale);
}

/**
 * Add a ramp to the front of a schedule: start at `from` of the target rate
 * and reach it over `words` tokens.
 *
 * Dropping someone cold into 600 wpm loses the first sentence every time.
 * Mutates nothing; returns a new array.
 */
export function withRampUp(dwells: number[], words = 12, from = 0.7): number[] {
  if (dwells.length === 0) return dwells;
  return dwells.map((ms, i) => {
    if (i >= words) return ms;
    const progress = i / words;
    const speed = from + (1 - from) * progress; // 0.7 → 1.0
    return ms / speed; // slower speed, longer dwell
  });
}

/** Words per minute a schedule actually delivers. */
export function effectiveWpm(dwells: number[]): number {
  if (dwells.length === 0) return 0;
  const total = dwells.reduce((a, b) => a + b, 0);
  return total > 0 ? (dwells.length * 60000) / total : 0;
}
