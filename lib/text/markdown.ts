/* ────────────────────────────────────────────────────────────────
   Markdown -> speakable text.

   A speech engine reads "## What the instruments said" as "hash hash
   what the instruments said", and `**critical**` as "asterisk
   asterisk critical". Markup that is invisible to a reader is very
   audible to a listener, so it has to come out before synthesis.

   This is deliberately not a Markdown parser. It strips the syntax
   that would be vocalized and leaves the prose alone, which is the
   only thing that matters for text-to-speech.
   ──────────────────────────────────────────────────────────────── */

/** Does this text use enough Markdown to be worth cleaning? */
export function looksLikeMarkdown(text: string): boolean {
  const sample = text.slice(0, 20_000);
  let score = 0;
  if (/^#{1,6} +\S/m.test(sample)) score += 3;
  if (/^\s{0,3}[-*+] +\S/m.test(sample)) score += 1;
  if (/^\s{0,3}>\s/m.test(sample)) score += 1;
  if (/\[[^\]]+\]\([^)]+\)/.test(sample)) score += 2;
  if (/```/.test(sample)) score += 2;
  if (/\*\*\S[\s\S]{0,80}?\S\*\*/.test(sample)) score += 1;
  if (/^\s{0,3}(\|.+\|)\s*$/m.test(sample)) score += 1;
  return score >= 3;
}

export function markdownToText(input: string): string {
  let t = input;

  // Fenced code: read the prose around it, not the code. A hundred lines of
  // YAML read aloud is worse than useless.
  t = t.replace(/^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*$/gm, "\n");
  t = t.replace(/^[ \t]*~~~[^\n]*\n[\s\S]*?^[ \t]*~~~[ \t]*$/gm, "\n");

  // Front matter.
  t = t.replace(/^---\n[\s\S]*?\n---\n/, "");

  // Images: the alt text is the only speakable part, and usually is not
  // worth speaking either.
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => (alt ? alt : ""));
  // Links: keep the label, drop the URL.
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  t = t.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  // Bare autolinks.
  t = t.replace(/<(https?:\/\/[^>]+)>/g, "");
  // Reference definitions.
  t = t.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "");

  // Headings. Keep the words, add a period so the engine takes a breath
  // instead of running the heading into the next sentence.
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (_, body: string) =>
    /[.!?:]$/.test(body.trim()) ? body.trim() : `${body.trim()}.`,
  );
  // Setext headings.
  t = t.replace(/^(.+)\n[ \t]{0,3}[=-]{3,}[ \t]*$/gm, (_, body: string) =>
    /[.!?:]$/.test(body.trim()) ? body.trim() : `${body.trim()}.`,
  );

  // Thematic breaks.
  t = t.replace(/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "");

  // Blockquote and list markers.
  t = t.replace(/^[ \t]{0,3}>[ \t]?/gm, "");
  t = t.replace(/^([ \t]*)[-*+][ \t]+/gm, "$1");
  t = t.replace(/^([ \t]*)(\d+)[.)][ \t]+/gm, "$1$2. ");

  // Tables: keep the cell text, drop the pipes and the separator row.
  t = t.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, "");
  t = t.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_, row: string) =>
    row.split("|").map((c) => c.trim()).filter(Boolean).join(", "),
  );

  // Emphasis. Only strip markers that actually wrap something, so that
  // "2 * 3" and snake_case_names survive intact.
  t = t.replace(/(\*\*\*|___)(\S[\s\S]*?\S|\S)\1/g, "$2");
  t = t.replace(/(\*\*|__)(\S[\s\S]*?\S|\S)\1/g, "$2");
  t = t.replace(/(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, "$1");
  t = t.replace(/(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])/g, "$1");
  t = t.replace(/~~(\S[\s\S]*?\S|\S)~~/g, "$1");

  // Inline code: read the contents, drop the backticks.
  t = t.replace(/`{1,3}([^`\n]+)`{1,3}/g, "$1");

  // Escaped punctuation.
  t = t.replace(/\\([\\`*_{}[\]()#+\-.!>])/g, "$1");

  // Inline HTML left over from mixed-markup documents.
  t = t.replace(/<\/?[a-zA-Z][^>]*>/g, "");

  return t.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n");
}
