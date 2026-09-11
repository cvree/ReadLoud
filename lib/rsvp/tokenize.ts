/* ────────────────────────────────────────────────────────────────
   Offset-preserving tokens for the one-word-at-a-time display.

   The invariant that makes everything else work:

       doc.text.slice(token.start, token.end) === token.text

   Absolute offsets are what let `Esc` drop you back into the scrolling
   reader on the exact word you stopped at, what let the pacer report
   boundaries the narrator already knows how to interpret, and what let
   a step backwards be expressed as a character offset rather than as a
   second, parallel notion of position. It is the first thing the
   self-test asserts.

   A token that had to be split for width is the one case where what
   is displayed is not what was sliced — the fragment gets a trailing
   hyphen — so the display string lives in its own field and `text`
   stays exact.

   English-specific by design: the abbreviation list, the ORP table and
   the clause punctuation are all English. Kokoro is an English model
   and the chunker segments with an English locale, so this matches the
   rest of the pipeline rather than pretending to be general.
   ──────────────────────────────────────────────────────────────── */

// Relative, with the extension, so `scripts/rsvp.test.ts` can run this
// file under node's type stripping, where the "@/" alias does not exist.
import { endsWithAbbreviation } from "../text/segment.ts";
import { pivotFor } from "./orp.ts";

/** Characters past which a word is split across two flashes. */
export const MAX_WIDTH = 13;
/**
 * Slack before a split is worth it.
 *
 * Splitting strictly at the ceiling produces orphans: `"unremarkable,"` is
 * fourteen characters once the quotes and comma are counted, and cutting it
 * gave a twelve-character flash followed by a three-character one — which
 * reads as a glitch, not as a long word. A word a little over the ceiling is
 * better shown whole.
 */
const SPLIT_SLACK = 3;

export interface RsvpFlags {
  /** Terminal punctuation that is really terminal — not "Dr." or "3.14". */
  endsSentence: boolean;
  /** Comma, semicolon, colon: a breath, not a stop. */
  endsClause: boolean;
  endsParagraph: boolean;
  /** Numbers, currency, dates — read slower than words of the same width. */
  numeric: boolean;
  /** A fragment of a longer word: no word-boundary pause belongs after it. */
  continued: boolean;
}

export interface RsvpToken {
  /** Exact slice of the source text. See the invariant above. */
  text: string;
  /** What the screen shows: `text`, plus a hyphen on a split fragment. */
  display: string;
  /** Absolute offsets into the text this was tokenized from. */
  start: number;
  end: number;
  /** Index into `display` of the optimal recognition point. */
  pivot: number;
  flags: RsvpFlags;
}

const SENTENCE_END = /[.!?]+["')\]]*$/;
const CLAUSE_END = /[,;:]["')\]]*$/;

/**
 * Split `text` into display tokens.
 *
 * `base` is added to every offset, so passing a chunk's text and its
 * `chunk.start` yields tokens whose offsets are absolute in the document.
 *
 * Tokens cover the text with no gaps other than whitespace: between
 * `tokens[i].end` and `tokens[i + 1].start` there is never a non-space
 * character. The self-test asserts that too — a tokenizer that silently
 * eats a word is the failure mode a reader cannot detect.
 */
export function tokenize(text: string, base = 0, maxWidth = MAX_WIDTH): RsvpToken[] {
  const out: RsvpToken[] = [];
  const word = /\S+/g;
  let m: RegExpExecArray | null;

  while ((m = word.exec(text))) {
    const raw = m[0];
    const start = m.index;
    const end = start + raw.length;

    // Paragraph breaks are a property of the gap *after* a word, and the last
    // word of the text ends one by definition.
    const gap = text.slice(end, end + 8);
    const endsParagraph = /^\s*\n\s*\n/.test(gap) || !/\S/.test(text.slice(end));

    const numeric = isNumeric(raw);
    const flags: RsvpFlags = {
      endsSentence: SENTENCE_END.test(raw) && !endsWithAbbreviation(raw) && !isNumeric(raw),
      endsClause: CLAUSE_END.test(raw),
      endsParagraph,
      numeric,
      continued: false,
    };

    for (const piece of split(raw, maxWidth)) {
      const last = piece.offset + piece.text.length === raw.length;
      out.push({
        text: piece.text,
        display: last ? piece.text : piece.text + "-",
        start: base + start + piece.offset,
        end: base + start + piece.offset + piece.text.length,
        pivot: pivotFor(last ? piece.text : piece.text + "-"),
        // Only the final fragment inherits the word's real punctuation, and
        // only the fragments before it are "continued" — the pause after the
        // last one is a genuine word boundary.
        flags: last
          ? { ...flags, continued: false }
          : { ...flags, endsSentence: false, endsClause: false, endsParagraph: false, continued: true },
      });
    }
  }

  return out;
}

/** Index of the token containing (or the last one at or before) `offset`. */
export function tokenIndexAt(tokens: RsvpToken[], offset: number): number {
  if (tokens.length === 0) return -1;
  let lo = 0;
  let hi = tokens.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].start <= offset) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * Numbers, decimals, currency, dates and versions.
 *
 * The point is not classification for its own sake: it stops `3.14` and
 * `2026-09-11` from reading as the end of a sentence, which is the classic
 * RSVP bug, and it earns them the longer dwell that digits need.
 */
function isNumeric(token: string): boolean {
  return /\d/.test(token) && !/[\p{L}]{3,}/u.test(token);
}

interface Piece {
  text: string;
  /** Offset of this piece within the original whitespace-delimited word. */
  offset: number;
}

/**
 * Break a word too wide to flash in one go.
 *
 * Two rules beyond "cut at the ceiling", both about how the result looks at
 * 90 ms rather than about arithmetic:
 *
 *   * **Balanced pieces.** Cutting greedily at the ceiling leaves the
 *     remainder as an orphan; dividing the word into equal parts does not.
 *     One column is reserved for the hyphen the display adds.
 *   * **An internal hyphen wins.** "counter-intuitive" splitting at its own
 *     hyphen looks deliberate where "counter-intuit-ive" looks broken.
 */
function split(word: string, maxWidth: number): Piece[] {
  if (word.length <= maxWidth + SPLIT_SLACK) return [{ text: word, offset: 0 }];

  // -1 leaves room for the trailing hyphen, so no *displayed* piece is wider
  // than the ceiling.
  const pieces = Math.ceil(word.length / (maxWidth - 1));
  const target = Math.ceil(word.length / pieces);

  const out: Piece[] = [];
  let cursor = 0;
  while (word.length - cursor > target) {
    // One past the target, so a hyphen sitting exactly on the boundary is
    // still available to cut at.
    const window = word.slice(cursor, cursor + target + 1);
    const hyphen = window.lastIndexOf("-");
    const cut = hyphen >= Math.max(2, target >> 1) ? cursor + hyphen + 1 : cursor + target;
    out.push({ text: word.slice(cursor, cut), offset: cursor });
    cursor = cut;
  }
  out.push({ text: word.slice(cursor), offset: cursor });
  return out;
}
