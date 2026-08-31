/* ────────────────────────────────────────────────────────────────
   Mp3Recorder — a thin, promise-shaped handle over the encoder worker.

   Usage:
     const rec = await Mp3Recorder.create({ sampleRate: 44100, channels: 1, kbps: 96 });
     await rec.write(decodedChannels);
     await rec.silence(0.4);
     const blob = await rec.finish();   // -> Blob("audio/mpeg")
   ──────────────────────────────────────────────────────────────── */

export interface Mp3Options {
  sampleRate: number;
  channels: 1 | 2;
  /** 64 is transparent for speech; 128 for music-adjacent content. */
  kbps: number;
}

export const BITRATE_PRESETS = [
  { kbps: 64, label: "64 kbps", note: "Smallest. Ideal for speech." },
  { kbps: 96, label: "96 kbps", note: "Recommended. Clean and compact." },
  { kbps: 128, label: "128 kbps", note: "Archive quality." },
  { kbps: 192, label: "192 kbps", note: "Overkill for narration." },
] as const;

type Outbound =
  | { type: "ready" }
  | { type: "frames"; frames: Uint8Array; id: number }
  | { type: "done"; frames: Uint8Array; bytesEncoded: number }
  | { type: "error"; message: string };

export class Mp3Recorder {
  private worker: Worker;
  private parts: Uint8Array[] = [];
  private pending = new Map<number, () => void>();
  private nextId = 1;
  private failure: Error | null = null;
  private finished: ((blob: Blob) => void) | null = null;
  private bytes = 0;

  private constructor(worker: Worker) {
    this.worker = worker;
    this.worker.onmessage = (e: MessageEvent<Outbound>) => this.handle(e.data);
    this.worker.onerror = (e) => {
      this.failure = new Error(e.message || "MP3 encoder worker crashed.");
      this.drain();
    };
  }

  static async create(opts: Mp3Options): Promise<Mp3Recorder> {
    const worker = new Worker(new URL("./mp3-encoder.worker.ts", import.meta.url), {
      type: "module",
      name: "readloud-mp3",
    });
    const rec = new Mp3Recorder(worker);
    await new Promise<void>((resolve, reject) => {
      const onReady = (e: MessageEvent<Outbound>) => {
        if (e.data.type === "ready") {
          worker.removeEventListener("message", onReady);
          resolve();
        } else if (e.data.type === "error") {
          worker.removeEventListener("message", onReady);
          reject(new Error(e.data.message));
        }
      };
      worker.addEventListener("message", onReady);
      worker.postMessage({
        type: "init",
        channels: opts.channels,
        sampleRate: opts.sampleRate,
        kbps: opts.kbps,
      });
    });
    return rec;
  }

  /** Bytes of MP3 written so far — drives a truthful progress readout. */
  get encodedBytes(): number {
    return this.bytes;
  }

  /** Encode one block of PCM. Buffers are transferred, not copied. */
  write(channels: Float32Array[]): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    // subarray views share their parent's buffer and cannot be transferred;
    // materialize a standalone copy for anything that is a view.
    const owned = channels.map((c) =>
      c.byteOffset === 0 && c.buffer.byteLength === c.byteLength ? c : new Float32Array(c),
    );
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage(
        { type: "encode", channels: owned, id },
        owned.map((c) => c.buffer as ArrayBuffer),
      );
    });
  }

  /** Insert a gap. Generated inside the worker: no allocation on this thread. */
  silence(seconds: number): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (seconds <= 0) return Promise.resolve();
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage({ type: "silence", seconds, id });
    });
  }

  /** Flush LAME's tail frame and assemble the final blob. */
  finish(): Promise<Blob> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.finished = resolve;
      const rejectRef = reject;
      this.worker.addEventListener("error", () => rejectRef(this.failure ?? new Error("Encode failed.")), {
        once: true,
      });
      this.worker.postMessage({ type: "flush" });
    });
  }

  /** Tear down without producing output. Safe to call twice. */
  abort(): void {
    this.failure = this.failure ?? new Error("Export cancelled.");
    try {
      this.worker.postMessage({ type: "abort" });
    } catch {
      /* worker may already be gone */
    }
    this.worker.terminate();
    this.parts = [];
    this.drain();
  }

  private handle(msg: Outbound) {
    switch (msg.type) {
      case "frames": {
        if (msg.frames.length) {
          this.parts.push(msg.frames);
          this.bytes += msg.frames.length;
        }
        this.pending.get(msg.id)?.();
        this.pending.delete(msg.id);
        break;
      }
      case "done": {
        if (msg.frames.length) this.parts.push(msg.frames);
        this.bytes += msg.frames.length;
        const blob = new Blob(this.parts as BlobPart[], { type: "audio/mpeg" });
        this.parts = [];
        this.worker.terminate();
        this.finished?.(blob);
        break;
      }
      case "error": {
        this.failure = new Error(msg.message);
        this.drain();
        break;
      }
      case "ready":
        break;
    }
  }

  /** Release every awaiting caller so a failure cannot deadlock the export. */
  private drain() {
    for (const resolve of this.pending.values()) resolve();
    this.pending.clear();
  }
}
