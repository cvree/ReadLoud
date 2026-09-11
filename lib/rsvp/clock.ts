/* ────────────────────────────────────────────────────────────────
   Drift-free word scheduling.

   Three rules, each of which exists because the naive version fails in
   a way the reader cannot see:

   1. **Absolute deadlines, not `setInterval`.** Interval pacers
      accumulate the difference between the interval you asked for and
      the one the browser gave you, and lose a word every few hundred.
      Here every deadline is computed once from a single origin, so the
      error never compounds.

   2. **Never skip; rebase on a stall.** At most one word is advanced
      per frame, so a hiccup makes the display fall behind rather than
      fast-forwarding through words that came due while nothing was
      painting. A gap longer than `stallMs` (a throttled tab, a GC
      pause, a Kokoro inference spike) shifts the whole schedule
      forward instead: that time is treated as not having passed.
      Silently skipping words is the one failure mode nobody notices.

   3. **`performance.now()`, not frame counts.** Which is what makes
      rule 2 recoverable rather than just detectable.

   The clock takes its `now` and its frame scheduler as options so that
   `scripts/rsvp.test.ts` can run it against a fake clock in Node and
   assert the drift, instead of asking you to watch a screen and trust
   your eyes.
   ──────────────────────────────────────────────────────────────── */

export interface ClockOptions {
  /** Milliseconds to hold each index. `dwells.length` words are shown. */
  dwells: number[];
  /** Called once per index, in order, starting with 0 at t=0. */
  onIndex(index: number, elapsedMs: number): void;
  /** Called once, after the final index has had its full dwell. */
  onDone(totalMs: number): void;
  now?(): number;
  requestFrame?(cb: () => void): number;
  cancelFrame?(handle: number): void;
  /** A frame gap longer than this is a stall, not elapsed reading time. */
  stallMs?: number;
}

export interface ClockHandle {
  pause(): void;
  resume(): void;
  cancel(): void;
  /** Index currently displayed. */
  readonly index: number;
  /** Scheduled milliseconds consumed so far. */
  readonly elapsed: number;
}

const FRAME_MS = 16;

export function startClock(opts: ClockOptions): ClockHandle {
  const {
    dwells,
    onIndex,
    onDone,
    now = () => performance.now(),
    requestFrame = (cb) => requestAnimationFrame(() => cb()),
    cancelFrame = (h) => cancelAnimationFrame(h),
    stallMs = 250,
  } = opts;

  // deadline[i] is when index i becomes due. deadline[0] is 0.
  const deadline = new Array<number>(dwells.length + 1);
  deadline[0] = 0;
  for (let i = 0; i < dwells.length; i++) deadline[i + 1] = deadline[i] + Math.max(1, dwells[i]);
  const total = deadline[dwells.length] ?? 0;

  let index = 0;
  let origin = now();
  let lastFrame = origin;
  let pausedAt: number | null = null;
  let frame = 0;
  let finished = dwells.length === 0;
  let elapsed = 0;

  if (finished) {
    // Nothing to show. Report completion on the next tick rather than
    // synchronously, so the caller has its handle before `done` resolves.
    requestFrame(() => onDone(0));
    return {
      pause() {},
      resume() {},
      cancel() {},
      get index() {
        return 0;
      },
      get elapsed() {
        return 0;
      },
    };
  }

  onIndex(0, 0);

  const tick = () => {
    if (finished || pausedAt !== null) return;

    const t = now();
    const gap = t - lastFrame;
    // Rule 2: a long gap is a stall. Pretend the clock did not advance
    // through it, so no word is passed over unseen.
    if (gap > stallMs) origin += gap - FRAME_MS;
    lastFrame = t;

    elapsed = t - origin;

    if (index + 1 < dwells.length) {
      if (elapsed >= deadline[index + 1]) {
        index++;
        // Report the scheduled time rather than the wall clock: the position
        // readout should not jitter by a frame, and on the silent pacer the
        // schedule *is* the truth.
        onIndex(index, deadline[index]);
      }
    } else if (elapsed >= total) {
      finished = true;
      onDone(total);
      return;
    }

    frame = requestFrame(tick);
  };

  frame = requestFrame(tick);

  return {
    pause() {
      if (finished || pausedAt !== null) return;
      pausedAt = now();
      cancelFrame(frame);
    },
    resume() {
      if (finished || pausedAt === null) return;
      const paused = now() - pausedAt;
      origin += paused;
      lastFrame = now();
      pausedAt = null;
      frame = requestFrame(tick);
    },
    cancel() {
      finished = true;
      cancelFrame(frame);
    },
    get index() {
      return index;
    },
    get elapsed() {
      return elapsed;
    },
  };
}
