/* ────────────────────────────────────────────────────────────────
   Property checks for reading mode.

   Following the idiom `lib/devtools.ts` already sets with
   `encodeSelfTest()`: assert a property rather than confirm that
   something came out. The three things below are the three ways this
   feature can be broken without looking broken.

     1. **Offsets drift.** The display shows a word, `Esc` returns you
        to a different one. Or a word is silently dropped by the
        tokenizer and you never find out what it was.
     2. **Pacing lies.** The dial says 600 wpm and delivers 430,
        because the punctuation holds were added on top of the rate
        instead of being normalized into it.
     3. **The clock drifts or skips.** The two failure modes that
        do not look like failures: cumulative drift over a long
        passage, and a word that came due during a stall and was
        stepped over without ever being painted.

   All three are pure functions of the text plus an injectable clock,
   so `scripts/rsvp.test.ts` runs them in Node with no browser and no
   framework, and `window.__readloud` runs them against whatever
   document is open.
   ──────────────────────────────────────────────────────────────── */

import { startClock } from "./clock.ts";
import { dwellsMs, effectiveWpm } from "./pacing.ts";
import { tokenize } from "./tokenize.ts";

export interface TokenRoundTrip {
  ok: boolean;
  /** How many tokens the text produced. */
  tokens: number;
  /** Tokens whose offsets do not slice back to their own text. */
  mismatches: Array<{ index: number; text: string; sliced: string }>;
  /** Non-whitespace the tokenizer skipped between two tokens. */
  dropped: Array<{ after: number; text: string }>;
}

/**
 * `text.slice(t.start, t.end) === t.text` for every token, and nothing but
 * whitespace between one token and the next.
 *
 * This is the invariant the whole feature rests on: it is what lets the
 * overlay and the scrolling reader share one cursor.
 */
export function tokenRoundTrip(text: string, base = 0): TokenRoundTrip {
  const tokens = tokenize(text, base);
  const mismatches: TokenRoundTrip["mismatches"] = [];
  const dropped: TokenRoundTrip["dropped"] = [];

  let previousEnd = base;
  tokens.forEach((t, index) => {
    const sliced = text.slice(t.start - base, t.end - base);
    if (sliced !== t.text) mismatches.push({ index, text: t.text, sliced });

    const between = text.slice(previousEnd - base, t.start - base);
    if (/\S/.test(between)) dropped.push({ after: index - 1, text: between });
    previousEnd = t.end;
  });

  const tail = text.slice(previousEnd - base);
  if (/\S/.test(tail)) dropped.push({ after: tokens.length - 1, text: tail });

  return {
    ok: mismatches.length === 0 && dropped.length === 0,
    tokens: tokens.length,
    mismatches,
    dropped,
  };
}

export interface PacingReport {
  requested: number;
  /** What the normalized schedule actually delivers. */
  effective: number;
  /** Within 2% — the claim the UI makes about the dial. */
  ok: boolean;
  words: number;
  minDwellMs: number;
  maxDwellMs: number;
}

export function pacingReport(text: string, wpm = 600): PacingReport {
  const tokens = tokenize(text);
  const dwells = dwellsMs(tokens, wpm);
  const effective = effectiveWpm(dwells);
  return {
    requested: wpm,
    effective: Math.round(effective * 10) / 10,
    ok: tokens.length === 0 || Math.abs(effective - wpm) / wpm < 0.02,
    words: tokens.length,
    minDwellMs: dwells.length ? Math.round(Math.min(...dwells)) : 0,
    maxDwellMs: dwells.length ? Math.round(Math.max(...dwells)) : 0,
  };
}

export interface DriftReport {
  ok: boolean;
  /** Words actually displayed. Must equal `expected`; skipping is the bug. */
  shown: number;
  expected: number;
  /** Difference between the wall clock and the schedule, in ms. */
  driftMs: number;
  perWordMs: number;
  notes: string[];
}

export interface DriftOptions {
  /** Frame interval for the fake clock, in ms. Defaults to 60 Hz. */
  frameMs?: number;
  /**
   * Inject a stall of this many milliseconds half way through, to check that
   * it is rebased rather than fast-forwarded through.
   */
  stallAtHalfwayMs?: number;
}

/**
 * Run the pacer's clock against a synthetic frame source and assert that
 * every word was shown, in order, at the right time.
 *
 * Synthetic on purpose: a test that waits for real frames takes as long as
 * the passage it is pacing, and cannot inject a 400 ms stall on demand.
 */
export function driftTest(wpm = 600, words = 400, opts: DriftOptions = {}): DriftReport {
  const frameMs = opts.frameMs ?? 1000 / 60;
  const perWordMs = 60000 / wpm;

  // A flat schedule: this is a test of the clock, not of the pacing model.
  const dwells = new Array<number>(words).fill(perWordMs);

  let clockNow = 0;
  const queue: Array<() => void> = [];
  const shown: Array<{ index: number; at: number; scheduled: number }> = [];
  let doneAt: number | null = null;
  let stalled = false;

  const handle = startClock({
    dwells,
    now: () => clockNow,
    requestFrame: (cb) => {
      queue.push(cb);
      return queue.length;
    },
    cancelFrame: () => {},
    onIndex(index, elapsedMs) {
      shown.push({ index, at: clockNow, scheduled: elapsedMs });
    },
    onDone() {
      doneAt = clockNow;
    },
  });

  // Drive frames until the schedule completes, with a generous ceiling so a
  // broken clock fails the assertion instead of hanging the run.
  const ceiling = perWordMs * words * 4 + 10_000;
  while (doneAt === null && clockNow < ceiling) {
    const frame = queue.shift();
    if (!frame) break;
    clockNow += frameMs;
    if (
      opts.stallAtHalfwayMs &&
      !stalled &&
      clockNow >= (perWordMs * words) / 2
    ) {
      stalled = true;
      clockNow += opts.stallAtHalfwayMs;
    }
    frame();
  }
  handle.cancel();

  const notes: string[] = [];
  if (shown.length !== words) {
    notes.push(`${shown.length} of ${words} words displayed.`);
  }
  for (let i = 0; i < shown.length; i++) {
    if (shown[i].index !== i) {
      notes.push(`Out of order at ${i}: got index ${shown[i].index}.`);
      break;
    }
  }

  // Drift is measured against the schedule, discounting any injected stall —
  // stalled time is explicitly *not* reading time.
  const last = shown[shown.length - 1];
  const driftMs = last ? last.at - (opts.stallAtHalfwayMs ?? 0) - last.scheduled : 0;
  // One frame plus one word interval: a frame source cannot do better, and
  // anything beyond it is accumulation rather than quantization.
  const budget = frameMs + perWordMs;
  if (Math.abs(driftMs) > budget) {
    notes.push(`Drift ${driftMs.toFixed(1)}ms exceeds ${budget.toFixed(1)}ms.`);
  }

  return {
    ok: notes.length === 0,
    shown: shown.length,
    expected: words,
    driftMs: Math.round(driftMs * 10) / 10,
    perWordMs: Math.round(perWordMs * 100) / 100,
    notes,
  };
}
