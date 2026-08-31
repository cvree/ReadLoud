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
    this.cancelCurrent();
    this.patch({ chunkIndex: index, status: "buffering", error: null });
    void this.run(index, ++this.epoch);
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

  private async run(startIndex: number, epoch: number): Promise<void> {
    for (let i = startIndex; i < this.chunks.length; i++) {
      if (epoch !== this.epoch) return;

      const chunk = this.chunks[i];
      const provider = this.provider;
      if (!provider) {
        this.patch({ status: "error", error: "No speech provider is selected." });
        return;
      }

      this.patch({
        chunkIndex: i,
        status: "buffering",
        cursor: chunk.start,
        // Seed with the first whole word: a zero length renders as a
        // one-character highlight for the frame before the first boundary
        // arrives, which reads as a glitch.
        cursorLength: firstWordLength(chunk.text),
        position: this.chunkStart(i),
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
      let lastElapsed = 0;
      const handle = provider.speak(
        {
          text: chunk.text,
          voiceId: this.settings.voiceId,
          rate: this.settings.rate,
          pitch: this.settings.pitch,
          volume: this.settings.volume,
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
      this.record(i, lastElapsed);

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
