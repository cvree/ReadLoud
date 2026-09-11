/* ────────────────────────────────────────────────────────────────
   ReadLoud — core domain model
   Everything in the app flows through these shapes. Ingestion
   produces a `Document`; the player consumes `Chunk[]`; the export
   pipeline consumes `RenderedChunk[]`.
   ──────────────────────────────────────────────────────────────── */

export type SourceKind = "pdf" | "epub" | "txt" | "md" | "html" | "paste" | "captions";

/** A logical division of the source — a PDF page, an EPUB spine item, etc. */
export interface Section {
  id: string;
  /** 1-based ordinal within the document. */
  index: number;
  /** Human label: "Page 42", "Chapter III — The Rescue". */
  title: string;
  /** Character offset of this section within `Document.text`. */
  start: number;
  end: number;
}

/**
 * A speakable unit. Chunks are built to respect sentence boundaries and to
 * stay under the character ceiling of the slowest provider, because both
 * Web Speech (which silently truncates past ~32k in some engines) and the
 * cloud APIs (hard request limits) punish long payloads.
 */
export interface Chunk {
  id: string;
  index: number;
  /** Speakable text — normalized, hyphenation repaired, no page furniture. */
  text: string;
  /** Absolute offsets into `Document.text` so the reader can highlight. */
  start: number;
  end: number;
  sectionId: string;
  sectionTitle: string;
  /** Sentence spans relative to `text`, used for sub-chunk highlighting. */
  sentences: Array<{ start: number; end: number }>;
  /** Estimated seconds at 1.0x — used for the scrubber before render. */
  estSeconds: number;
  words: number;
}

export interface Document {
  id: string;
  name: string;
  kind: SourceKind;
  bytes: number;
  /** Full normalized text. The single source of truth for the reader view. */
  text: string;
  sections: Section[];
  chunks: Chunk[];
  meta: {
    title?: string;
    author?: string;
    pages?: number;
    words: number;
    characters: number;
    /** Estimated read-aloud duration in seconds at 1.0x. */
    estSeconds: number;
    ingestedAt: number;
    /** Non-fatal issues worth surfacing (scanned pages, broken spine items). */
    warnings: string[];
  };
}

/**
 * One line of a caption track, with the timings it arrived with.
 *
 * The timings survive ingestion rather than being discarded at the door:
 * they are what lets `repairCaptions` tell a sentence break from a line
 * break on a track that has no punctuation, and they leave the door open to
 * pacing a read-along against the original video later.
 */
export interface CaptionCue {
  /** Seconds from the start of the media. */
  start: number;
  end: number;
  text: string;
}

export interface IngestProgress {
  phase: "reading" | "parsing" | "normalizing" | "chunking" | "done";
  /** 0..1 */
  ratio: number;
  detail: string;
}

/* ── TTS ─────────────────────────────────────────────────────── */

/**
 * `silent` is the RSVP pacer in `lib/rsvp/pacer.ts`: a provider that emits
 * word boundaries and no audio. It is deliberately absent from `PROVIDERS`
 * so it can never appear in the voice picker.
 */
export type ProviderId = "webspeech" | "kokoro" | "silent";

export interface Voice {
  id: string;
  name: string;
  provider: ProviderId;
  lang?: string;
  /** Provider-specific descriptor shown in the picker. */
  tag?: string;
  /** True for OS-local voices (offline, zero latency, lower fidelity). */
  local?: boolean;
  previewText?: string;
}

export interface SpeakRequest {
  text: string;
  voiceId: string;
  /** 0.5 – 3.0 */
  rate: number;
  /** 0 – 2, provider may ignore. */
  pitch: number;
  /** 0 – 1 */
  volume: number;
  /**
   * Start this far into `text` rather than at the beginning — what makes
   * stepping back one word possible inside a passage.
   *
   * Best-effort: honored only by providers that advertise
   * `capabilities.resume`, and ignored (start from 0) by the rest, because
   * you cannot seek into a Web Speech utterance that is already queued.
   * Boundary events are still reported against the full `text`, so the
   * caller's offsets never have to know this happened.
   */
  startChar?: number;
  signal?: AbortSignal;
}

/** Emitted while a chunk is being spoken so the reader can highlight. */
export interface BoundaryEvent {
  /** Character index into the chunk text. */
  charIndex: number;
  charLength: number;
  elapsed: number;
}

export interface SpeechHandle {
  /** Resolves when the utterance completes; rejects on error/abort. */
  done: Promise<void>;
  pause(): void;
  resume(): void;
  cancel(): void;
}

export interface ProviderCapabilities {
  /** Can return raw audio bytes → unlocks deterministic MP3 export. */
  synthesize: boolean;
  /** Emits word boundaries during live playback. */
  boundaries: boolean;
  /** Honors a rate multiplier natively. */
  rate: boolean;
  pitch: boolean;
  /**
   * Honors `SpeakRequest.startChar` — i.e. playback can begin mid-passage.
   * Reading mode needs this to step back a word without restarting the
   * whole passage.
   */
  resume: boolean;
  /**
   * Runs entirely on the reader's machine — no account, no key, no request
   * ever leaves the browser. Every provider ReadLoud ships is `true`; the flag
   * exists so the UI can promise it, and so a future hosted provider could not
   * be added without contradicting the promise in code.
   */
  local: boolean;
}

export interface TTSProvider {
  id: ProviderId;
  label: string;
  blurb: string;
  capabilities: ProviderCapabilities;
  isAvailable(): Promise<boolean>;
  listVoices(): Promise<Voice[]>;
  /** Live playback. */
  speak(req: SpeakRequest, onBoundary?: (e: BoundaryEvent) => void): SpeechHandle;
  /** Offline render → audio bytes. Only present when `capabilities.synthesize`. */
  synthesize?(req: SpeakRequest): Promise<{ bytes: ArrayBuffer; mime: string }>;
  /** Warm the cache for an upcoming passage. Best-effort; never throws. */
  prefetch?(req: SpeakRequest): void;
}

/* ── Export ──────────────────────────────────────────────────── */

export interface RenderedChunk {
  chunkId: string;
  index: number;
  /** Decoded mono/stereo PCM at the pipeline sample rate. */
  channels: Float32Array[];
  sampleRate: number;
  duration: number;
  /** Absolute start second in the final master. */
  offset: number;
}

export interface ExportProgress {
  phase: "synthesizing" | "decoding" | "mixing" | "encoding" | "done" | "error";
  ratio: number;
  detail: string;
}

export interface TranscriptCue {
  index: number;
  start: number;
  end: number;
  text: string;
  sectionTitle: string;
}
