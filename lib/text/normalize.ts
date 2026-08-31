/* ────────────────────────────────────────────────────────────────
   Text normalization.

   Extracted PDF/EPUB text is hostile to a speech engine: ligatures,
   soft hyphens, hard-wrapped lines mid-word, running headers repeated
   on every page, page numbers, and smart quotes that some engines
   pronounce literally. This module makes text *speakable* while
   preserving enough structure for the reader view.

   Every non-ASCII character below is written as a \u escape on purpose:
   invisible characters in source are a maintenance trap.
   ──────────────────────────────────────────────────────────────── */

const LIGATURES: Array<[RegExp, string]> = [
  [/ﬀ/g, "ff"],
  [/ﬁ/g, "fi"],
  [/ﬂ/g, "fl"],
  [/ﬃ/g, "ffi"],
  [/ﬄ/g, "ffl"],
  [/[ﬅﬆ]/g, "st"],
  [/Ĳ/g, "IJ"],
  [/ĳ/g, "ij"],
];

const PUNCT: Array<[RegExp, string]> = [
  // curly single quotes / prime -> apostrophe
  [/[‘’‚‛′]/g, "'"],
  // curly double quotes / double prime -> straight quote
  [/[“”„‟″]/g, '"'],
  // dash family -> hyphen
  [/[‐‑‒–—―]/g, "-"],
  [/…/g, "..."],
  // exotic spaces -> plain space
  [/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " "],
  // zero-width space / non-joiner / joiner / BOM / soft hyphen -> nothing
  [/[\u200B\u200C\u200D\uFEFF\u00AD]/g, ""],
  [/⁄/g, "/"],
];

/** Control characters and box-drawing glyphs that read as noise. */
const NOISE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F─-╿]/g;

export function normalizeText(raw: string): string {
  let t = raw.normalize("NFKC");
  for (const [re, sub] of LIGATURES) t = t.replace(re, sub);
  for (const [re, sub] of PUNCT) t = t.replace(re, sub);
  t = t.replace(NOISE, "");
  t = t.replace(/\r\n?/g, "\n");
  t = t.replace(/\t/g, " ");

  // Repair hyphenation across line breaks: "unbeliev-\nable" -> "unbelievable".
  // Guarded to lowercase -> lowercase so we don't fuse "Anglo-\nSaxon".
  t = t.replace(/([a-z])-\n([a-z])/g, "$1$2");

  // Rejoin hard-wrapped lines inside a paragraph. A line that does not end in
  // sentence punctuation and is followed by a lowercase word was wrapped, not
  // ended. Blank lines stay: they are paragraph boundaries.
  t = t.replace(/([^\n.!?:;"')\]])\n(?!\n)(?=[a-z("'])/g, "$1 ");

  t = t.replace(/[ ]{2,}/g, " ");
  t = t.replace(/ +\n/g, "\n");
  // HTML extraction leaves a space where the markup was indented.
  t = t.replace(/\n[ \t]+/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

/**
 * Strip running headers/footers. PDFs repeat the book title and page number
 * on every page; a reader saying "The Wealth of Nations 47" between every
 * paragraph is unbearable. We detect lines that repeat across a meaningful
 * fraction of pages and drop them.
 */
export function stripRunningFurniture(pages: string[]): string[] {
  if (pages.length < 4) return pages;

  const tally = new Map<string, number>();
  const edgesOf = (page: string) => {
    const lines = page.split("\n").map((l) => l.trim()).filter(Boolean);
    return [...lines.slice(0, 2), ...lines.slice(-2)];
  };

  for (const page of pages) {
    for (const line of new Set(edgesOf(page))) {
      // Normalize digits so "Page 12" and "Page 13" collapse to one key.
      const key = line.replace(/\d+/g, "#");
      if (key.length < 2 || key.length > 90) continue;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }

  const threshold = Math.max(3, Math.floor(pages.length * 0.35));
  const furniture = new Set(
    [...tally.entries()].filter(([, n]) => n >= threshold).map(([k]) => k),
  );
  if (furniture.size === 0) return pages;

  return pages.map((page) => {
    const lines = page.split("\n");
    const keep = lines.filter((line, i) => {
      const isEdge = i < 2 || i >= lines.length - 2;
      if (!isEdge) return true;
      const key = line.trim().replace(/\d+/g, "#");
      return !furniture.has(key);
    });
    return keep.join("\n");
  });
}

/** Drop bare page numbers left behind on their own line. */
export function stripOrphanPageNumbers(text: string): string {
  return text.replace(/^[ \t]*[-[(]?[ \t]*\d{1,4}[ \t]*[-\])]?[ \t]*$/gm, "");
}

/** Rough words-per-minute -> seconds. Tuned against real narration pace. */
export const BASE_WPM = 165;

export function estimateSeconds(words: number, rate = 1): number {
  return (words / (BASE_WPM * rate)) * 60;
}

export function countWords(text: string): number {
  const m = text.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu);
  return m ? m.length : 0;
}
