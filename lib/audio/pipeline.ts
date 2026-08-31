/* ────────────────────────────────────────────────────────────────
   The export pipeline: text -> audio bytes -> PCM -> MP3.

   Per chunk:
     synthesize  (network, parallel, bounded)
        -> decode + resample to one rate   (WebAudio)
        -> trim provider padding, fade edges
        -> stream into LAME                (worker)
        -> record a timestamp for the transcript

   Two properties worth calling out:

   * Bounded concurrency. Firing 4,000 fetches at once gets you rate
     limited and blows out memory. We run a small window ahead of the
     encoder, so network latency is hidden but only a handful of
     clips are ever in flight.
   * In-order encoding. MP3 is a stream; frames must be appended in
     playback order. Synthesis happens out of order for speed, then a
     reorder buffer feeds the encoder strictly sequentially.

   The timeline this produces is *real*, measured from decoded sample
   counts rather than estimated, which is what makes the exported SRT
   and VTT actually line up with the exported MP3.
   ──────────────────────────────────────────────────────────────── */

import type { Chunk, ExportProgress, TTSProvider, TranscriptCue } from "@/lib/types";
import { Mp3Recorder, type Mp3Options } from "./encode";
import { applyEdgeFades, decodeToRate, normalizePeak, trimSilence } from "./decode";

export interface RenderOptions extends Mp3Options {
  voiceId: string;
  rate: number;
  pitch: number;
  volume: number;
  /** Silence inserted after each passage, in seconds. */
  gapSeconds: number;
  /** Extra silence at a section (chapter/page) boundary. */
  sectionGapSeconds: number;
  /** How many synthesis requests may be in flight at once. */
  concurrency: number;
  /** Trim the provider's leading/trailing padding. */
  trim: boolean;
  /** Peak-normalize each clip for consistent loudness. */
  normalize: boolean;
}

export const DEFAULT_RENDER: Omit<RenderOptions, "voiceId"> = {
  sampleRate: 44100,
  channels: 1,
  kbps: 96,
  rate: 1,
  pitch: 1,
  volume: 1,
  gapSeconds: 0.32,
  sectionGapSeconds: 0.9,
  concurrency: 4,
  trim: true,
  normalize: true,
};

export interface RenderResult {
  blob: Blob;
  cues: TranscriptCue[];
  duration: number;
  bytes: number;
}

export async function renderToMp3(
  chunks: Chunk[],
  provider: TTSProvider,
  options: RenderOptions,
  onProgress: (p: ExportProgress) => void,
  signal?: AbortSignal,
): Promise<RenderResult> {
  if (!provider.synthesize) {
    throw new Error(
      `${provider.label} does not expose an audio stream, so it cannot be encoded offline. ` +
        "Switch to a cloud voice for instant export, or use realtime tab capture.",
    );
  }
  if (chunks.length === 0) throw new Error("Nothing selected to export.");

  const recorder = await Mp3Recorder.create({
    sampleRate: options.sampleRate,
    channels: options.channels,
    kbps: options.kbps,
  });

  const onAbort = () => recorder.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  const cues: TranscriptCue[] = [];
  let timeline = 0;
  let synthesized = 0;

  // Reorder buffer: index -> decoded PCM waiting for its turn at the encoder.
  const ready = new Map<number, { channels: Float32Array[]; duration: number }>();
  const waiters = new Map<number, () => void>();

  const publish = (i: number, value: { channels: Float32Array[]; duration: number }) => {
    ready.set(i, value);
    waiters.get(i)?.();
    waiters.delete(i);
  };

  const awaitIndex = (i: number) =>
    ready.has(i)
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiters.set(i, resolve));

  let failure: Error | null = null;

  // ── producer: bounded-concurrency synthesis ──────────────────
  let nextToFetch = 0;
  const worker = async () => {
    while (!failure) {
      const i = nextToFetch++;
      if (i >= chunks.length) return;
      if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");

      try {
        const { bytes } = await provider.synthesize!({
          text: chunks[i].text,
          voiceId: options.voiceId,
          rate: options.rate,
          pitch: options.pitch,
          volume: 1, // volume is a playback concern, never baked into a file
          signal,
        });

        let { channels, duration } = await decodeToRate(
          bytes,
          options.sampleRate,
          options.channels,
        );
        if (options.trim) {
          channels = trimSilence(channels, options.sampleRate);
          duration = channels[0].length / options.sampleRate;
        }
        if (options.normalize) normalizePeak(channels);
        applyEdgeFades(channels, options.sampleRate);

        publish(i, { channels, duration });
        synthesized++;
        onProgress({
          phase: "synthesizing",
          ratio: synthesized / chunks.length,
          detail: `Rendering passage ${synthesized.toLocaleString()} of ${chunks.length.toLocaleString()}`,
        });
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
        // Unblock the consumer so it can surface the error instead of hanging.
        for (const resolve of waiters.values()) resolve();
        waiters.clear();
        return;
      }
    }
  };

  const producers = Array.from(
    { length: Math.max(1, Math.min(options.concurrency, chunks.length)) },
    worker,
  );

  // ── consumer: strictly ordered encode ────────────────────────
  try {
    for (let i = 0; i < chunks.length; i++) {
      await awaitIndex(i);
      if (failure) throw failure;
      if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");

      const item = ready.get(i)!;
      ready.delete(i); // release the PCM as soon as it is consumed

      const start = timeline;
      await recorder.write(item.channels);
      timeline += item.duration;

      cues.push({
        index: i,
        start,
        end: timeline,
        text: chunks[i].text,
        sectionTitle: chunks[i].sectionTitle,
      });

      const next = chunks[i + 1];
      const gap = !next
        ? 0
        : next.sectionId !== chunks[i].sectionId
          ? options.sectionGapSeconds
          : options.gapSeconds;
      if (gap > 0) {
        await recorder.silence(gap);
        timeline += gap;
      }

      onProgress({
        phase: "encoding",
        ratio: (i + 1) / chunks.length,
        detail: `Encoding ${formatClock(timeline)} - ${formatBytes(recorder.encodedBytes)}`,
      });
    }

    await Promise.all(producers);
    if (failure) throw failure;

    onProgress({ phase: "encoding", ratio: 1, detail: "Finalizing MP3" });
    const blob = await recorder.finish();

    onProgress({ phase: "done", ratio: 1, detail: `${formatBytes(blob.size)} ready` });
    return { blob, cues, duration: timeline, bytes: blob.size };
  } catch (err) {
    recorder.abort();
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
