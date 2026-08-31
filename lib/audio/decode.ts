/* ────────────────────────────────────────────────────────────────
   Audio decoding + resampling.

   Providers return MP3 at whatever sample rate they like (OpenAI at
   24 kHz, ElevenLabs at 44.1 kHz). LAME only accepts a fixed set of
   MPEG sample rates and every chunk in one master must share a rate,
   so we normalize everything to a single target on the way in.
   ──────────────────────────────────────────────────────────────── */

/** Rates MPEG-1/2/2.5 Layer III actually supports. */
export const MPEG_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000] as const;

let sharedContext: AudioContext | null = null;

/** One AudioContext for the whole app: browsers cap them at ~6. */
export function audioContext(): AudioContext {
  if (!sharedContext || sharedContext.state === "closed") {
    sharedContext = new AudioContext();
  }
  return sharedContext;
}

/** Autoplay policy parks the context until a user gesture resumes it. */
export async function unlockAudio(): Promise<void> {
  const ctx = audioContext();
  if (ctx.state === "suspended") await ctx.resume().catch(() => {});
}

export interface DecodedAudio {
  channels: Float32Array[];
  sampleRate: number;
  duration: number;
}

/**
 * Decode compressed audio and resample to `targetRate`.
 *
 * `decodeAudioData` resamples to the context rate on Chrome and Firefox but
 * not reliably on Safari, so we always run an explicit OfflineAudioContext
 * render when the rates differ. That render is also where downmixing to mono
 * happens — speech gains nothing from stereo and mono halves the file size.
 */
export async function decodeToRate(
  bytes: ArrayBuffer,
  targetRate: number,
  targetChannels: 1 | 2 = 1,
): Promise<DecodedAudio> {
  const ctx = audioContext();
  // decodeAudioData detaches the buffer; hand it a copy so callers can retry.
  const buffer = await ctx.decodeAudioData(bytes.slice(0));

  if (buffer.sampleRate === targetRate && buffer.numberOfChannels === targetChannels) {
    return {
      channels: Array.from({ length: targetChannels }, (_, i) =>
        new Float32Array(buffer.getChannelData(i)),
      ),
      sampleRate: targetRate,
      duration: buffer.duration,
    };
  }

  const frames = Math.max(1, Math.ceil((buffer.duration * targetRate)));
  const offline = new OfflineAudioContext(targetChannels, frames, targetRate);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();

  return {
    channels: Array.from({ length: targetChannels }, (_, i) =>
      new Float32Array(rendered.getChannelData(i)),
    ),
    sampleRate: targetRate,
    duration: rendered.duration,
  };
}

/**
 * Trim digital silence from both ends of a clip.
 *
 * Cloud TTS pads each response with 100-300ms of near-silence. Across a
 * 4,000-chunk book that is twenty minutes of dead air, and it makes the
 * narration sound like it is buffering between sentences. We cut it and
 * substitute our own, deliberately chosen pause.
 */
export function trimSilence(
  channels: Float32Array[],
  sampleRate: number,
  thresholdDb = -45,
  keepMs = 30,
): Float32Array[] {
  if (channels.length === 0 || channels[0].length === 0) return channels;

  const threshold = Math.pow(10, thresholdDb / 20);
  const probe = channels[0];
  const keep = Math.round((keepMs / 1000) * sampleRate);

  let start = 0;
  while (start < probe.length && Math.abs(probe[start]) < threshold) start++;
  let end = probe.length - 1;
  while (end > start && Math.abs(probe[end]) < threshold) end--;

  if (start >= end) return channels; // clip is entirely silence

  start = Math.max(0, start - keep);
  end = Math.min(probe.length, end + keep);
  if (start === 0 && end === probe.length) return channels;

  return channels.map((c) => c.subarray(start, end));
}

/**
 * A short cosine fade on each edge. Splicing trimmed clips together at a
 * non-zero sample produces a click; 5ms of fade removes it inaudibly.
 */
export function applyEdgeFades(channels: Float32Array[], sampleRate: number, ms = 5): void {
  const n = Math.min(Math.round((ms / 1000) * sampleRate), Math.floor((channels[0]?.length ?? 0) / 2));
  if (n <= 1) return;
  for (const c of channels) {
    for (let i = 0; i < n; i++) {
      const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
      c[i] *= g;
      c[c.length - 1 - i] *= g;
    }
  }
}

/** Peak-normalize to a target headroom so exports have consistent loudness. */
export function normalizePeak(channels: Float32Array[], targetDb = -1.5): number {
  let peak = 0;
  for (const c of channels) {
    for (let i = 0; i < c.length; i++) {
      const a = Math.abs(c[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak === 0) return 1;
  const target = Math.pow(10, targetDb / 20);
  const gain = target / peak;
  // Only ever bring levels down or gently up; never amplify noise 10x.
  const applied = Math.min(gain, 4);
  if (Math.abs(applied - 1) < 0.01) return 1;
  for (const c of channels) {
    for (let i = 0; i < c.length; i++) c[i] *= applied;
  }
  return applied;
}
