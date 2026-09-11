/* ────────────────────────────────────────────────────────────────
   The optimal recognition point.

   RSVP's entire mechanical claim is that your eye does not move,
   and that only holds if the part of the word you fixate on lands in
   the same screen column every time. That point is not the centre:
   for English it sits slightly left of it, and it drifts right as
   words get longer.

   So every token carries a pivot index, the display puts the pivot
   character in a fixed centre column, and the pre/post fragments grow
   outwards from it. No measurement, no monospace font, no per-glyph
   maths — see `.rsvp-word` in globals.css.
   ──────────────────────────────────────────────────────────────── */

/** Anything that can carry the fixation: a letter, a digit. */
const CORE = /[\p{L}\p{N}]/u;

/**
 * Pivot index into `word`, by the length of its alphanumeric core.
 *
 *   | core length | pivot |
 *   |-------------|-------|
 *   | 1           | 0     |
 *   | 2–5         | 1     |
 *   | 6–9         | 2     |
 *   | 10–13       | 3     |
 *   | 14+         | 4     |
 *
 * Leading punctuation is skipped rather than counted: on `"Hello` the
 * fixation belongs on the word, not on the quote mark.
 */
export function pivotFor(word: string): number {
  if (word.length === 0) return 0;

  let lead = 0;
  while (lead < word.length && !CORE.test(word[lead])) lead++;
  // A token with no letters or digits at all ("—", "...") has no core to
  // aim at; treat the whole thing as the core.
  if (lead === word.length) lead = 0;

  let core = 0;
  for (let i = lead; i < word.length && CORE.test(word[i]); i++) core++;

  const offset = core <= 1 ? 0 : core <= 5 ? 1 : core <= 9 ? 2 : core <= 13 ? 3 : 4;
  return Math.min(word.length - 1, lead + offset);
}
