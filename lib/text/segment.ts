/* ────────────────────────────────────────────────────────────────
   Sentence segmentation.

   Prefers `Intl.Segmenter`, which is locale-aware and handles the
   abbreviation/decimal cases that naive `split(/[.!?]/)` destroys.
   Falls back to a hand-tuned regex on engines that lack it.
   ──────────────────────────────────────────────────────────────── */

export interface Span {
  start: number;
  end: number;
}

const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "rev", "hon", "pres",
  "gen", "col", "capt", "lt", "sgt", "gov", "sen", "rep", "supt", "det",
  "inc", "ltd", "co", "corp", "dept", "est", "fig", "vol", "no", "op",
  "cit", "ed", "eds", "trans", "approx", "etc", "vs", "viz", "cf", "al",
  "ca", "circa", "i.e", "e.g", "a.m", "p.m", "u.s", "u.k", "u.n",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct",
  "nov", "dec", "mon", "tue", "wed", "thu", "fri", "sat", "sun",
]);

let segmenter: Intl.Segmenter | null | undefined;

function getSegmenter(locale: string): Intl.Segmenter | null {
  if (segmenter !== undefined) return segmenter;
  try {
    segmenter =
      typeof Intl !== "undefined" && "Segmenter" in Intl
        ? new Intl.Segmenter(locale, { granularity: "sentence" })
        : null;
  } catch {
    segmenter = null;
  }
  return segmenter;
}

/**
 * Returns sentence spans over `text`. Spans are contiguous and cover the
 * whole string (including trailing whitespace) so that offsets computed
 * from them map 1:1 back onto the reader view.
 */
export function segmentSentences(text: string, locale = "en"): Span[] {
  const seg = getSegmenter(locale);
  const raw: Span[] = seg ? viaIntl(text, seg) : viaRegex(text);

  // Intl.Segmenter still breaks on "Dr. Who" in some ICU builds; merge any
  // span that ends on a known abbreviation into the following one.
  const merged: Span[] = [];
  for (const span of raw) {
    const prev = merged[merged.length - 1];
    if (prev && endsWithAbbreviation(text.slice(prev.start, prev.end))) {
      prev.end = span.end;
    } else {
      merged.push({ ...span });
    }
  }
  return merged.filter((s) => text.slice(s.start, s.end).trim().length > 0);
}

function viaIntl(text: string, seg: Intl.Segmenter): Span[] {
  const out: Span[] = [];
  for (const s of seg.segment(text)) {
    out.push({ start: s.index, end: s.index + s.segment.length });
  }
  return out;
}

function viaRegex(text: string): Span[] {
  const out: Span[] = [];
  // Terminal punctuation, optional closing quote/bracket, then whitespace.
  const re = /[.!?]+["')\]]*(?:\s+|$)|\n{2,}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    out.push({ start: last, end });
    last = end;
  }
  if (last < text.length) out.push({ start: last, end: text.length });
  return out;
}

/**
 * Exported for `lib/rsvp/tokenize.ts`: a display that pauses on "Dr." as if
 * it were the end of a sentence is the same bug in a different renderer, and
 * this list should not exist twice.
 */
export function endsWithAbbreviation(s: string): boolean {
  const m = s.trimEnd().match(/([\p{L}.]+)\.$/u);
  if (!m) return false;
  const word = m[1].toLowerCase().replace(/\.$/, "");
  if (ABBREVIATIONS.has(word)) return true;
  // Single initial: "J." in "J. R. R. Tolkien"
  if (/^\p{Lu}$/u.test(m[1])) return true;
  return false;
}
