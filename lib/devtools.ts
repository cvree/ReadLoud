/* ────────────────────────────────────────────────────────────────
   Development-only console handles.

   Open the console and you can drive the pipeline directly:

     await __readloud.encodeSelfTest()   // sine -> LAME -> MP3, verified
     __readloud.state()                  // current store snapshot
     __readloud.clipCacheStats()

   Guarded by NODE_ENV so none of it reaches a production bundle.
   ──────────────────────────────────────────────────────────────── */

import { Mp3Recorder } from "@/lib/audio/encode";
import * as clips from "@/lib/tts/cache";

export interface EncodeSelfTest {
  ok: boolean;
  bytes: number;
  /** Frames found by scanning for MPEG sync words. */
  frames: number;
  sampleRate: number;
  kbps: number;
  seconds: number;
  notes: string[];
}

/**
 * Encode a known signal and verify the output is a real MP3.
 *
 * Checks the bitstream rather than just "did it produce bytes": every MPEG
 * audio frame starts with eleven set bits, and a CBR encode of a known
 * duration has a predictable size. Both are asserted.
 */
export async function encodeSelfTest(seconds = 2, kbps = 96): Promise<EncodeSelfTest> {
  const sampleRate = 44100;
  const notes: string[] = [];
  const recorder = await Mp3Recorder.create({ sampleRate, channels: 1, kbps });

  // A 440 Hz tone at -6 dBFS, written in half-second blocks so the streaming
  // path (many small writes) is what actually gets exercised.
  const blockSeconds = 0.5;
  const blocks = Math.round(seconds / blockSeconds);
  for (let b = 0; b < blocks; b++) {
    const n = Math.round(blockSeconds * sampleRate);
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = (b * n + i) / sampleRate;
      buf[i] = 0.5 * Math.sin(2 * Math.PI * 440 * t);
    }
    await recorder.write([buf]);
  }
  await recorder.silence(0.25);

  const blob = await recorder.finish();
  const bytes = new Uint8Array(await blob.arrayBuffer());

  let frames = 0;
  for (let i = 0; i + 1 < bytes.length; i++) {
    // MPEG frame sync: 0xFF followed by 0xEx (eleven consecutive set bits).
    if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0) frames++;
  }

  const expected = ((seconds + 0.25) * kbps * 1000) / 8;
  const ratio = bytes.length / expected;
  if (frames < 10) notes.push("Too few MPEG frame sync words - output is not valid MP3.");
  if (ratio < 0.8 || ratio > 1.25) {
    notes.push(`Size ${bytes.length} is ${ratio.toFixed(2)}x the CBR expectation.`);
  }
  if (blob.type !== "audio/mpeg") notes.push(`Unexpected MIME type ${blob.type}.`);

  return {
    ok: notes.length === 0,
    bytes: bytes.length,
    frames,
    sampleRate,
    kbps,
    seconds: seconds + 0.25,
    notes,
  };
}

export function installDevtools(state: () => unknown): void {
  if (process.env.NODE_ENV === "production") return;
  if (typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>).__readloud = {
    encodeSelfTest,
    state,
    clipCacheStats: clips.stats,
    clearClipCache: clips.clear,
  };
}
