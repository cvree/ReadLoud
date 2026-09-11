/* ────────────────────────────────────────────────────────────────
   Narrator — the playback state machine.

   Sits between the UI and whichever TTSProvider is selected, and owns
   the one thing neither of them can: continuity across thousands of
   passages.

   Responsibilities:
     * advance through chunks without gaps (prefetching the next)
     * translate provider boundary events into an absolute character
       offset in the document, for reading-mode highlighting
     * maintain a position clock so the scrubber can be dragged
     * survive a provider changing mid-sentence (voice/rate switches
       restart the current passage rather than dropping the session)

   Deliberately framework-free: no React, no store import. The UI
   subscribes to `onUpdate`. That keeps the hard part testable and
   means a different frontend could drive it unchanged.
   ──────────────────────────────────────────────────────────────── */

import type { Chunk, ProviderId, SpeechHandle, TTSProvider } from "@/lib/types";

export type PlaybackStatus = "idle" | "buffering" | "playing" | "paused" | "error";

export interface NarratorSettings {
  providerId: ProviderId;
  voiceId: string;
  rate: number;
  pitch: number;
  volume: number;
  /** Extra pause after each passage, in seconds. Pacing, not dead air. */
  gapSeconds: number;
  /** Stop automatically at the end of the current section. */
  stopAtSectionEnd: boolean;
}

export interface NarratorState {
  status: PlaybackStatus;
  chunkIndex: number;
  /** Absolute character offset of the word being spoken, or -1. */
  cursor: number;
  cursorLength: number;
  /** Seconds elapsed across the whole document, at the current rate. */
  position: number;
  /** Estimated total seconds at the current rate. */
  duration: number;
  error: string | null;
}

const IDLE: NarratorState = {
  status: "idle",
  chunkIndex: 0,
  cursor: -1,
  cursorLength: 0,
  position: 0,
  duration: 0,
  error: null,
};

export class Narrator {
  private chunks: Chunk[] = [];
  private provider: TTSProvider | null = null;
  private handle: SpeechHandle | null = null;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  /** Incremented on every state change that must invalidate in-flight work. */
  private epoch = 0;
  private state: NarratorState = { ...IDLE };
  private prefix: number[] = [];
  /**
   * Measured duration per chunk, normalized to rate 1.0, or null while a
   * chunk has not been heard yet.
   *
   * The scrubber starts out driven by a words-per-minute estimate, which is
   * the best you can do before any audio exists. But once a passage has
   * actually been spoken we know exactly how long it took, and there is no
   * reason to keep lying about it. Each completed passage replaces its
   * estimate with the real figure and the timeline rebuilds, so the longer
   * you listen the more accurate the scrubber and the remaining-time readout
   * become.
   */
  private measured: Array<number | null> = [];
  /**
   * Where to resume the current passage from, set by `seekChar` while paused.
   * Cleared as soon as the passage it belongs to is played or left behind.
   */
  private resumeAt: { index: number; char: number } | null = null;

  settings: NarratorSettings = {
    providerId: "webspeech",
    voiceId: "",
    rate: 1,
    pitch: 1,
    volume: 1,
    gapSeconds: 0.18,
    stopAtSectionEnd: false,
  };

  onUpdate: (state: NarratorState) => void = () => {};
  onChunkChange: (index: number) => void = () => {};

  /* ── setup ──────────────────────────────────────────────────── */

  load(chunks: Chunk[]): void {
    this.hardStop();
    this.resumeAt = null;
    this.chunks = chunks;
    this.measured = new Array(chunks.length).fill(null);
    this.rebuildPrefix();
    this.state = { ...IDLE, duration: this.totalDuration() };
    this.emit();
  }

  setProvider(provider: TTSProvider): void {
    this.provider = provider;
    this.settings.providerId = provider.id;
  }

  getState(): NarratorState {
    return this.state;
  }

  /** Fraction of the document whose duration is measured rather than estimated. */
  get timelineConfidence(): number {
    if (this.chunks.length === 0) return 1;
    let known = 0;
    for (const m of this.measured) if (m !== null) known++;
    return known / this.chunks.length;
  }

  get currentChunk(): Chunk | undefined {
    return this.chunks[this.state.chunkIndex];
  }

  /* ── transport ──────────────────────────────────────────────── */

  async play(fromIndex?: number): Promise<void> {
    if (this.chunks.length === 0) return;

    if (fromIndex === undefined && this.state.status === "paused" && this.handle) {
      this.handle.resume();
      this.patch({ status: "playing" });
      return;
    }

    const index = fromIndex ?? this.state.chunkIndex;
    // A `seekChar` while paused leaves a resume point behind; pressing play
    // should carry on from the word you stepped to, not from the top of the
    // passage.
    const from = this.resumeAt?.index === index ? this.resumeAt.char : 0;
    this.cancelCurrent();
    this.patch({ chunkIndex: index, status: "buffering", error: null });
    void this.run(index, ++this.epoch, from);
  }

  pause(): void {
    if (this.state.status !== "playing") return;
    this.clearGap();
    this.handle?.pause();
    this.patch({ status: "paused" });
  }

  toggle(): void {
    if (this.state.status === "playing") this.pause();
    else void this.play();
  }

  stop(): void {
    this.hardStop();
    this.patch({ status: "idle", cursor: -1, cursorLength: 0 });
  }

  /**
   * Cancel whatever is in flight and settle into `paused`, keeping the cursor
   * exactly where it is.
   *
   * `pause()` suspends a live utterance and only works while one is playing;
   * `stop()` throws the cursor away. Leaving silent reading mode needs
   * neither: the pacer has to be torn down before the voice takes over, but
   * the word you had reached is the whole point.
   */
  suspend(): void {
    this.cancelCurrent();
    this.patch({ status: "paused" });
  }

  next(): void {
    this.jump(Math.min(this.chunks.length - 1, this.state.chunkIndex + 1));
  }

  previous(): void {
    // Match every audio player ever: restart the passage if we are more than
    // a moment into it, otherwise step back.
    const withinChunk = this.state.position - this.chunkStart(this.state.chunkIndex);
    const target =
      withinChunk > 2.5 ? this.state.chunkIndex : Math.max(0, this.state.chunkIndex - 1);
    this.jump(target);
  }

  /** Skip forward/back by seconds, resolved to the nearest passage. */
  nudge(seconds: number): void {
    this.seekTime(this.state.position + seconds);
  }

  jump(index: number): void {
    const clamped = Math.max(0, Math.min(this.chunks.length - 1, index));
    const wasPlaying = this.state.status === "playing" || this.state.status === "buffering";
    this.resumeAt = null;
    this.cancelCurrent();
    this.patch({
      chunkIndex: clamped,
      cursor: this.chunks[clamped]?.start ?? -1,
      cursorLength: 0,
      position: this.chunkStart(clamped),
    });
    this.onChunkChange(clamped);
    if (wasPlaying) void this.play(clamped);
    else this.patch({ status: "paused" });
  }

  seekTime(seconds: number): void {
    const clamped = Math.max(0, Math.min(this.totalDuration(), seconds));
    this.jump(this.indexAtTime(clamped));
  }

  /**
   * Seek to an absolute character offset in the document — the affordance
   * reading mode is built on.
   *
   * `Narrator` was deliberately built without this, because you cannot seek
   * into a Web Speech utterance. But "step back one word" is the single most
   * important thing a one-word-at-a-time display can offer, and at balanced
   * chunking a passage is ~150 words, so "restart the passage" is not an
   * answer. Providers that advertise `capabilities.resume` honor the offset
   * exactly; the rest restart the passage containing it, which is strictly
   * better than ignoring the seek.
   *
   * Crossing a passage boundary is handled here rather than by the caller:
   * stepping back from the first word of a passage lands on the last word of
   * the one before it.
   */
  seekChar(absolute: number): void {
    if (this.chunks.length === 0) return;
    const index = this.indexAtChar(absolute);
    const chunk = this.chunks[index];
    const char = Math.max(0, Math.min(absolute - chunk.start, chunk.text.length - 1));
    const wasPlaying = this.state.status === "playing" || this.state.status === "buffering";

    this.cancelCurrent();
    this.resumeAt = { index, char };
    this.patch({
      chunkIndex: index,
      cursor: chunk.start + char,
      cursorLength: firstWordLength(chunk.text.slice(char)),
      position: this.chunkStart(index) + this.withinChunk(index, char),
    });
    this.onChunkChange(index);

    if (wasPlaying) void this.run(index, ++this.epoch, char);
    else this.patch({ status: this.state.status === "idle" ? "idle" : "paused" });
  }

  /**
   * Swap the provider and its settings without losing your place in the
   * passage.
   *
   * `update()` restarts the current passage from its start, which is right
   * for a voice change you want to hear immediately and wrong for entering
   * reading mode: the whole point is that the cursor does not move. Passing
   * `atChar` continues from that offset instead, in one restart rather than
   * two.
   */
  retune(provider: TTSProvider, partial: Partial<NarratorSettings>, atChar?: number): void {
    const wasPlaying = this.state.status === "playing" || this.state.status === "buffering";
    this.cancelCurrent();
    this.provider = provider;
    Object.assign(this.settings, partial, { providerId: provider.id });
    // The rate may have changed by a factor of seven on the way into silent
    // mode, so the timeline has to be rebuilt before anything reads it.
    this.patch({ duration: this.totalDuration() });

    if (atChar === undefined) {
      if (wasPlaying) void this.run(this.state.chunkIndex, ++this.epoch);
      else this.patch({ status: this.state.status === "idle" ? "idle" : "paused" });
      return;
    }

    // `seekChar` re-reads `status`, which `cancelCurrent` left untouched, so
    // playback continues from `atChar` if it was running.
    if (wasPlaying) this.patch({ status: "buffering" });
    this.seekChar(atChar);
  }

  /* ── live settings ──────────────────────────────────────────── */

  /**
   * Changing rate or voice mid-passage. No engine can retune an utterance
   * that is already speaking, so we restart the current passage. Restarting
   * the passage (rather than the document) is the least surprising behavior:
   * you hear the change immediately, in context.
   */
  update(partial: Partial<NarratorSettings>): void {
    const restartKeys: Array<keyof NarratorSettings> = ["voiceId", "rate", "pitch", "providerId"];
    const needsRestart = restartKeys.some(
      (k) => partial[k] !== undefined && partial[k] !== this.settings[k],
    );
    Object.assign(this.settings, partial);

    if (partial.rate !== undefined) {
      this.patch({ duration: this.totalDuration(), position: this.chunkStart(this.state.chunkIndex) });
    }
    if (needsRestart && (this.state.status === "playing" || this.state.status === "buffering")) {
      void this.play(this.state.chunkIndex);
    }
  }

  destroy(): void {
    this.hardStop();
    this.onUpdate = () => {};
    this.onChunkChange = () => {};
  }

  /* ── internals ──────────────────────────────────────────────── */

  private async run(startIndex: number, epoch: number, startChar = 0): Promise<void> {
    for (let i = startIndex; i < this.chunks.length; i++) {
      if (epoch !== this.epoch) return;

      const chunk = this.chunks[i];
      // Only the first passage of a run can start part-way in.
      const from = i === startIndex ? Math.max(0, Math.min(startChar, chunk.text.length - 1)) : 0;
      const provider = this.provider;
      if (!provider) {
        this.patch({ status: "error", error: "No speech provider is selected." });
        return;
      }

      this.patch({
        chunkIndex: i,
        status: "buffering",
        cursor: chunk.start + from,
        // Seed with the first whole word: a zero length renders as a
        // one-character highlight for the frame before the first boundary
        // arrives, which reads as a glitch.
        cursorLength: firstWordLength(chunk.text.slice(from)),
        position: this.chunkStart(i) + this.withinChunk(i, from),
      });
      this.onChunkChange(i);

      // Warm the next passage so the seam is inaudible.
      const upcoming = this.chunks[i + 1];
      if (upcoming && provider.prefetch) {
        provider.prefetch({
          text: upcoming.text,
          voiceId: this.settings.voiceId,
          rate: this.settings.rate,
          pitch: this.settings.pitch,
          volume: this.settings.volume,
        });
      }

      const chunkStart = this.chunkStart(i);
      // `startChar` is best-effort: a provider that cannot resume mid-utterance
      // plays the passage from the beginning instead, which is the documented
      // fallback rather than a silent failure.
      const resumed = from > 0 && provider.capabilities.resume;
      let lastElapsed = 0;
      const handle = provider.speak(
        {
          text: chunk.text,
          voiceId: this.settings.voiceId,
          rate: this.settings.rate,
          pitch: this.settings.pitch,
          volume: this.settings.volume,
          startChar: resumed ? from : 0,
        },
        (b) => {
          if (epoch !== this.epoch) return;
          lastElapsed = b.elapsed;
          this.patch({
            status: "playing",
            cursor: chunk.start + Math.min(b.charIndex, chunk.text.length),
            cursorLength: b.charLength,
            position: chunkStart + b.elapsed,
          });
        },
      );
      this.handle = handle;
      this.patch({ status: "playing" });

      try {
        await handle.done;
      } catch (err) {
        if (epoch !== this.epoch) return;
        this.patch({
          status: "error",
          error: err instanceof Error ? err.message : "Playback failed.",
        });
        return;
      }
      if (epoch !== this.epoch) return;

      this.handle = null;
      // A half-played passage reports a half duration, and the sanity guard in
      // `record` is too loose to catch it. One rewind would otherwise write a
      // permanent lie into the timeline.
      if (!resumed) this.record(i, lastElapsed);
      if (this.resumeAt?.index === i) this.resumeAt = null;

      const next = this.chunks[i + 1];
      if (!next) break;
      if (this.settings.stopAtSectionEnd && next.sectionId !== chunk.sectionId) {
        this.patch({ status: "paused", chunkIndex: i + 1, position: this.chunkStart(i + 1) });
        this.onChunkChange(i + 1);
        return;
      }

      // A beat between passages. This is what separates "a robot reading a
      // list of strings" from something you can listen to for an hour.
      const gap =
        this.settings.gapSeconds +
        (next.sectionId !== chunk.sectionId ? 0.45 : 0);
      if (gap > 0) {
        await new Promise<void>((resolve) => {
          this.gapTimer = setTimeout(resolve, gap * 1000);
        });
        if (epoch !== this.epoch) return;
      }
    }

    // Reached the end of the document.
    this.patch({
      status: "idle",
      position: this.totalDuration(),
      cursor: -1,
      cursorLength: 0,
    });
  }

  /**
   * Prefix sums of per-chunk duration: makes seek-by-time O(log n) rather
   * than O(n) on every scrubber drag over an 8,000-chunk book. Rebuilt when
   * a measurement lands - a few thousand additions once per passage, which is
   * nothing next to synthesizing one.
   */
  private rebuildPrefix(): void {
    this.prefix = new Array(this.chunks.length + 1);
    this.prefix[0] = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      this.prefix[i + 1] = this.prefix[i] + (this.measured[i] ?? this.chunks[i].estSeconds);
    }
  }

  private record(index: number, seconds: number): void {
    // Guard against nonsense: a cancelled utterance reports a stub duration,
    // and one bad value would distort the whole timeline.
    if (!Number.isFinite(seconds) || seconds <= 0.05) return;
    const atRateOne = seconds * this.settings.rate;
    const estimate = this.chunks[index]?.estSeconds ?? atRateOne;
    if (atRateOne > estimate * 8 || atRateOne < estimate / 8) return;

    if (this.measured[index] === atRateOne) return;
    this.measured[index] = atRateOne;
    this.rebuildPrefix();
    this.patch({ duration: this.totalDuration() });
  }

  private cancelCurrent(): void {
    this.epoch++;
    this.clearGap();
    this.handle?.cancel();
    this.handle = null;
  }

  private hardStop(): void {
    this.cancelCurrent();
    this.state = { ...this.state, status: "idle" };
  }

  private clearGap(): void {
    if (this.gapTimer) {
      clearTimeout(this.gapTimer);
      this.gapTimer = null;
    }
  }

  /** Estimated seconds before chunk `i`, adjusted for the current rate. */
  private chunkStart(i: number): number {
    const raw = this.prefix[Math.max(0, Math.min(this.prefix.length - 1, i))] ?? 0;
    return raw / this.settings.rate;
  }

  private totalDuration(): number {
    return (this.prefix[this.prefix.length - 1] ?? 0) / this.settings.rate;
  }

  /** Binary search the chunks for the one containing an absolute offset. */
  private indexAtChar(absolute: number): number {
    let lo = 0;
    let hi = this.chunks.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.chunks[mid].start <= absolute) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  /**
   * Seconds into chunk `i` that a character offset corresponds to, pro rata.
   *
   * Only used to keep the scrubber honest after a mid-passage seek: the real
   * figure is not knowable until the passage has been heard.
   */
  private withinChunk(i: number, char: number): number {
    const chunk = this.chunks[i];
    if (!chunk || chunk.text.length === 0 || char <= 0) return 0;
    const seconds = (this.measured[i] ?? chunk.estSeconds) / this.settings.rate;
    return seconds * Math.min(1, char / chunk.text.length);
  }

  /** Binary search the prefix sums for the chunk containing `seconds`. */
  private indexAtTime(seconds: number): number {
    const target = seconds * this.settings.rate;
    let lo = 0;
    let hi = this.chunks.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.prefix[mid] <= target) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  private patch(partial: Partial<NarratorState>): void {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  private emit(): void {
    this.onUpdate(this.state);
  }
}

function firstWordLength(text: string): number {
  const m = /^\s*(\S+)/.exec(text);
  return m ? m[1].length : 0;
}
