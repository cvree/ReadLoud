/* ────────────────────────────────────────────────────────────────
   HTML -> speakable text.

   Uses the browser's own parser (never a regex) and walks the DOM so
   that block elements become paragraph breaks and non-content nodes
   (scripts, nav chrome, figure captions we do not want read aloud)
   are dropped. Headings get a trailing period so the speech engine
   drops in a natural beat instead of running the chapter title into
   the first sentence.
   ──────────────────────────────────────────────────────────────── */

const SKIP = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME",
  "AUDIO", "VIDEO", "OBJECT", "EMBED", "MAP", "AREA", "HEAD",
]);

const BLOCK = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE",
  "BLOCKQUOTE", "PRE", "FIGURE", "FIGCAPTION", "UL", "OL", "LI", "DL",
  "DT", "DD", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "HR",
  "H1", "H2", "H3", "H4", "H5", "H6", "BR",
]);

const HEADING = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);

export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const root = doc.body ?? doc.documentElement;
  if (!root) return "";

  // Drop content that is chrome rather than prose.
  root
    .querySelectorAll('[hidden], [aria-hidden="true"], [role="navigation"], .noprint')
    .forEach((el) => el.remove());

  let out = "";

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node.nodeValue ?? "").replace(/\s+/g, " ");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag)) return;

    const isBlock = BLOCK.has(tag);
    if (isBlock && !/\n\s*$/.test(out)) out += "\n";

    if (tag === "LI" && !/[-*]\s*$/.test(out)) out += "";

    for (const child of Array.from(el.childNodes)) walk(child);

    if (HEADING.has(tag)) {
      // A heading with no terminal punctuation runs straight into the body
      // text when spoken. A period buys a breath.
      const trimmed = out.trimEnd();
      if (trimmed && !/[.!?:]$/.test(trimmed)) out = trimmed + ".";
      out += "\n\n";
    } else if (isBlock) {
      out += "\n";
    }
  };

  walk(root);
  return out;
}
