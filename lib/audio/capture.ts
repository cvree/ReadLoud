/* ────────────────────────────────────────────────────────────────
   Live capture — the honest answer to "export Web Speech to MP3".

   The Web Speech API exposes no audio stream. Not a MediaStream, not
   an AudioNode, not a buffer. This is deliberate on the part of the
   spec authors (the OS voice engine sits outside the web sandbox) and
   there is no workaround: you cannot encode what you cannot read.

   So there are exactly two honest paths to an MP3:

     A. Use a provider that returns audio bytes — Kokoro, which
        renders on-device. Deterministic, faster than realtime,
        sample-accurate. This is `lib/audio/pipeline.ts`, and it is
        the default.

     B. Capture the audio the browser is actually playing, via
        `getDisplayMedia({ audio: true })`, while it speaks. Realtime
        (a 3-hour book takes 3 hours), requires the user to tick
        "Share tab audio", and Chromium-only. That is this file.

   B is a genuine fallback, not a toy: the captured stream is real PCM
   and goes through the same LAME encoder as path A.
   ──────────────────────────────────────────────────────────────── */

import { Mp3Recorder, type Mp3Options } from "./encode";

export function isTabCaptureSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function" &&
    typeof AudioContext !== "undefined"
  );
}

export interface CaptureSession {
  /** Stop capturing and return the encoded MP3. */
  stop(): Promise<Blob>;
  /** Abandon the capture and release the stream. */
  cancel(): void;
  /** Seconds captured so far. */
  elapsed(): number;
  /** 0..1 instantaneous level, for the meter. */
  level(): number;
}

/**
 * Begin capturing this tab's audio into a streaming MP3 encode.
 *
 * The user must choose "This tab" and enable "Also share tab audio" in the
 * picker; there is no way to preselect that for them. If they share video
 * only, we detect the missing audio track and say so plainly rather than
 * silently producing a file of pure silence.
 */
export async function startTabCapture(opts: Mp3Options): Promise<CaptureSession> {
  if (!isTabCaptureSupported()) {
    throw new Error(
      "Tab audio capture is not supported in this browser. Use Chrome or Edge, or switch to the Kokoro engine for instant export.",
    );
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true, // required: Chrome rejects audio-only display capture
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    } as MediaTrackConstraints,
  });

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error(
      'No audio track was shared. Re-run the export and tick "Also share tab audio" in the picker.',
    );
  }
  // We only ever needed the audio; drop video immediately to save the encode.
  stream.getVideoTracks().forEach((t) => {
    t.stop();
    stream.removeTrack(t);
  });

  const recorder = await Mp3Recorder.create(opts);
  const ctx = new AudioContext({ sampleRate: opts.sampleRate });
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;

  // ScriptProcessor is deprecated but is the only node available without
  // shipping a separate AudioWorklet module file; for a capture path that is
  // already realtime-bound, its latency cost is irrelevant.
  const FRAME = 4096;
  const processor = ctx.createScriptProcessor(FRAME, opts.channels, opts.channels);

  let samples = 0;
  let currentLevel = 0;
  let stopped = false;
  const queue: Promise<void>[] = [];

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    const input = event.inputBuffer;
    const channels: Float32Array[] = [];
    for (let c = 0; c < opts.channels; c++) {
      channels.push(new Float32Array(input.getChannelData(Math.min(c, input.numberOfChannels - 1))));
    }

    let peak = 0;
    const probe = channels[0];
    for (let i = 0; i < probe.length; i++) {
      const a = Math.abs(probe[i]);
      if (a > peak) peak = a;
    }
    currentLevel = peak;

    samples += input.length;
    queue.push(recorder.write(channels));
  };

  source.connect(analyser);
  analyser.connect(processor);
  // A zero-gain sink keeps the graph pulling without echoing to the speakers.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  processor.connect(sink);
  sink.connect(ctx.destination);

  const teardown = () => {
    stopped = true;
    processor.onaudioprocess = null;
    try {
      processor.disconnect();
      analyser.disconnect();
      source.disconnect();
      sink.disconnect();
    } catch {
      /* already torn down */
    }
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
  };

  // The user can stop sharing from Chrome's own bar; treat that as "stop".
  audioTracks[0].addEventListener("ended", () => {
    stopped = true;
  });

  return {
    async stop() {
      teardown();
      await Promise.all(queue);
      return recorder.finish();
    },
    cancel() {
      teardown();
      recorder.abort();
    },
    elapsed: () => samples / opts.sampleRate,
    level: () => currentLevel,
  };
}
