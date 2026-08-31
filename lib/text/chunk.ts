/* ────────────────────────────────────────────────────────────────
   Chunking.

   Why chunk at all, when `speechSynthesis.speak()` accepts a string
   of any length?

   1. Every engine has an undocumented ceiling. Chrome's SAPI bridge
      silently truncates long utterances and Safari drops them
      entirely. ~500-1500 chars is the safe band.
   2. Cloud TTS endpoints have hard per-request limits (OpenAI: 4096
      chars) and per-request pricing — chunks are the unit of retry,
      caching and cost accounting.
   3. Chunks are the unit of *seeking*. You cannot scrub into the
      middle of a Web Speech utterance; you can only start a new one.
      Small chunks are what make the scrubber feel continuous.
   4. Chunks bound memory. A 900-page PDF becomes ~8000 chunks of a
      kilobyte each rather than one 8 MB string re-rendered on every
      highlight tick.

   Chunks never split a sentence unless a single sentence exceeds the
   ceiling on its own, in which case we split on clause punctuation
   and only then hard-wrap.
   ──────────────────────────────────────────────────────────────── */

import type { Chunk, Section } from "@/lib/types";
import { countWords, estimateSeconds } from "./normalize";
import { segmentSentences, type Span } from "./segment";

export interface ChunkOptions {
  /** Hard ceiling per chunk. */
  maxChars: number;
  /** Below this we keep absorbing sentences even past a paragraph break. */
  minChars: number;
  /** Break a chunk at a blank line (paragraph) when past `minChars`. */
  respectParagraphs: boolean;
  locale: string;
}

export const CHUNK_PRESETS = {
  /** Snappy seeking + tight highlight sync. Best for Web Speech. */
  responsive: { maxChars: 480, minChars: 160, respectParagraphs: true, locale: "en" },
  /** Balanced: fewer requests, still seekable. Default. */
  balanced: { maxChars: 900, minChars: 320, respectParagraphs: true, locale: "en" },
  /** Fewest network round-trips. Best for paid providers billed per call. */
  economical: { maxChars: 2400, minChars: 900, respectParagraphs: false, locale: "en" },
} satisfies Record<string, ChunkOptions>;

export type ChunkPreset = keyof typeof CHUNK_PRESETS;

export function chunkDocument(
  text: string,
  sections: Section[],
  options: ChunkOptions = CHUNK_PRESETS.balanced,
): Chunk[] {
  const sentences = segmentSentences(text, options.locale);
  const units = sentences.flatMap((s) => splitOversized(text, s, options.maxChars));

  const chunks: Chunk[] = [];
  let open: Span[] = [];

  const flush = () => {
    if (open.length === 0) return;
    const start = open[0].start;
    const end = open[open.length - 1].end;
    const slice = text.slice(start, end);
    const trimmed = slice.trim();
    if (!trimmed) {
      open = [];
      return;
    }
    // Preserve exact offsets after trimming so highlights land correctly.
    const lead = slice.length - slice.trimStart().length;
    const absStart = start + lead;
    const absEnd = absStart + trimmed.length;

    const section = sectionAt(sections, absStart);
    const words = countWords(trimmed);
    chunks.push({
      id: `c${chunks.length}`,
      index: chunks.length,
      text: trimmed,
      start: absStart,
      end: absEnd,
      sectionId: section?.id ?? "sec-0",
      sectionTitle: section?.title ?? "Document",
      sentences: open.map((s) => ({
        start: Math.max(0, s.start - absStart),
        end: Math.min(trimmed.length, s.end - absStart),
      })).filter((s) => s.end > s.start),
      words,
      estSeconds: estimateSeconds(words) + pauseAfter(trimmed),
    });
    open = [];
  };

  for (const unit of units) {
    const current = open.length
      ? open[open.length - 1].end - open[0].start
      : 0;
    const addition = unit.end - unit.start;

    if (current > 0 && current + addition > options.maxChars) flush();

    if (
      options.respectParagraphs &&
      open.length > 0 &&
      current >= options.minChars &&
      /\n\s*\n\s*$/.test(text.slice(open[open.length - 1].end - 4, unit.start + 2))
    ) {
      flush();
    }

    open.push(unit);
  }
  flush();

  return chunks;
}

/** A beat of silence after terminal punctuation makes narration feel human. */
function pauseAfter(text: string): number {
  const last = text.trimEnd().slice(-1);
  if (last === "." || last === "!" || last === "?") return 0.35;
  if (last === ":" || last === ";") return 0.25;
  return 0.12;
}

function sectionAt(sections: Section[], offset: number): Section | undefined {
  // Sections are sorted and non-overlapping: binary search.
  let lo = 0;
  let hi = sections.length - 1;
  let best: Section | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = sections[mid];
    if (offset < s.start) {
      hi = mid - 1;
    } else {
      best = s;
      lo = mid + 1;
    }
  }
  return best;
}

/**
 * Split a single sentence that is longer than the ceiling. Tries clause
 * punctuation first (a natural breath), then whitespace, then a hard cut.
 */
function splitOversized(text: string, span: Span, maxChars: number): Span[] {
  if (span.end - span.start <= maxChars) return [span];

  const out: Span[] = [];
  let cursor = span.start;

  while (span.end - cursor > maxChars) {
    const windowEnd = cursor + maxChars;
    const window = text.slice(cursor, windowEnd);

    // Prefer the last clause break in the back half of the window.
    const clause = lastIndexOfAny(window, [";", ":", ",", ")", "-"], maxChars >> 1);
    const cut =
      clause >= 0
        ? cursor + clause + 1
        : cursor + Math.max(window.lastIndexOf(" "), maxChars >> 1);

    out.push({ start: cursor, end: cut });
    cursor = cut;
  }
  if (cursor < span.end) out.push({ start: cursor, end: span.end });
  return out;
}

function lastIndexOfAny(s: string, needles: string[], minIndex: number): number {
  let best = -1;
  for (const n of needles) {
    const i = s.lastIndexOf(n);
    if (i > best && i >= minIndex) best = i;
  }
  return best;
}
