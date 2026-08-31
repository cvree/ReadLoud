/// <reference lib="webworker" />
/* ────────────────────────────────────────────────────────────────
   MP3 encoder worker (LAME via @breezystack/lamejs).

   The design decision that matters here is STREAMING.

   A naive pipeline renders every chunk to PCM, concatenates one giant
   Float32Array, and then encodes it. For a six-hour audiobook that
   buffer is:

       44100 Hz x 3600 s x 6 h x 4 bytes x 2 channels = 7.6 GB

   which is not a memory problem so much as an instant tab crash.

   Instead we hold exactly one chunk of PCM at a time. Each decoded
   chunk is handed to LAME, encoded to MP3 frames, and the PCM is
   released. Only the compressed output accumulates: at 128 kbps a
   six-hour book is ~345 MB, and at 64 kbps mono (plenty for speech)
   it is ~170 MB. Frames are emitted back to the main thread as they
   are produced so nothing is duplicated.

   Everything runs off the main thread, so the UI stays at 60fps while
   a book encodes.
   ──────────────────────────────────────────────────────────────── */

import lamejs from "@breezystack/lamejs";

type InboundMessage =
  | { type: "init"; channels: 1 | 2; sampleRate: number; kbps: number }
  | { type: "encode"; channels: Float32Array[]; id: number }
  | { type: "silence"; seconds: number; id: number }
  | { type: "flush" }
  | { type: "abort" };

type OutboundMessage =
  | { type: "ready" }
  | { type: "frames"; frames: Uint8Array; id: number }
  | { type: "done"; frames: Uint8Array; bytesEncoded: number }
  | { type: "error"; message: string };

/** LAME consumes samples in blocks; 1152 is the MPEG-1 Layer III frame size. */
const BLOCK = 1152;

let encoder: InstanceType<typeof lamejs.Mp3Encoder> | null = null;
let channelCount: 1 | 2 = 1;
let sampleRate = 44100;
let bytesEncoded = 0;
let aborted = false;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: OutboundMessage, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer);
}

/**
 * Float32 [-1, 1] -> Int16 with clipping. LAME wants signed 16-bit PCM.
 * We clamp rather than wrap: a wrapped sample is an audible click.
 */
function toInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = input[i];
    out[i] = s < -1 ? -32768 : s > 1 ? 32767 : Math.round(s * 32767);
  }
  return out;
}

function encodePcm(pcm: Int16Array[]): Uint8Array[] {
  if (!encoder) throw new Error("Encoder was not initialized.");
  const out: Uint8Array[] = [];
  const length = pcm[0].length;

  for (let offset = 0; offset < length; offset += BLOCK) {
    const end = Math.min(offset + BLOCK, length);
    const left = pcm[0].subarray(offset, end);
    const buf =
      channelCount === 2
        ? encoder.encodeBuffer(left, pcm[1].subarray(offset, end))
        : encoder.encodeBuffer(left);
    if (buf.length > 0) out.push(new Uint8Array(buf));
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const p of parts) {
    out.set(p, cursor);
    cursor += p.length;
  }
  return out;
}

ctx.onmessage = (event: MessageEvent<InboundMessage>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case "init": {
        channelCount = msg.channels;
        sampleRate = msg.sampleRate;
        bytesEncoded = 0;
        aborted = false;
        encoder = new lamejs.Mp3Encoder(msg.channels, msg.sampleRate, msg.kbps);
        post({ type: "ready" });
        break;
      }

      case "encode": {
        if (aborted) return;
        const channels = msg.channels;
        const pcm =
          channelCount === 2
            ? [toInt16(channels[0]), toInt16(channels[1] ?? channels[0])]
            : [toInt16(channels[0])];
        const frames = concat(encodePcm(pcm));
        bytesEncoded += frames.length;
        // Transfer ownership: no copy crossing the worker boundary.
        post({ type: "frames", frames, id: msg.id }, [frames.buffer]);
        break;
      }

      case "silence": {
        if (aborted) return;
        // Inter-passage pauses. Generated here so the main thread never
        // allocates a multi-second buffer just to hold zeros.
        const samples = Math.max(0, Math.round(msg.seconds * sampleRate));
        if (samples === 0) {
          post({ type: "frames", frames: new Uint8Array(0), id: msg.id });
          break;
        }
        const silent = new Int16Array(samples);
        const pcm = channelCount === 2 ? [silent, silent] : [silent];
        const frames = concat(encodePcm(pcm));
        bytesEncoded += frames.length;
        post({ type: "frames", frames, id: msg.id }, [frames.buffer]);
        break;
      }

      case "flush": {
        if (!encoder) throw new Error("Encoder was not initialized.");
        // The final partial frame lives inside LAME until flushed; skipping
        // this truncates the last ~26ms of audio.
        const tail = new Uint8Array(encoder.flush());
        bytesEncoded += tail.length;
        encoder = null;
        post({ type: "done", frames: tail, bytesEncoded }, [tail.buffer]);
        break;
      }

      case "abort": {
        aborted = true;
        encoder = null;
        break;
      }
    }
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

export {};
