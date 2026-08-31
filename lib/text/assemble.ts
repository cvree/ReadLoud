/* ────────────────────────────────────────────────────────────────
   Assemble normalized parts (PDF pages, EPUB spine items) into one
   document string while recording exact section offsets.

   Offsets matter: the reader view highlights by absolute character
   index, so normalization has to happen *before* assembly, and the
   joins have to be length-accounted as we go.
   ──────────────────────────────────────────────────────────────── */

import type { Section } from "@/lib/types";
import { normalizeText, stripOrphanPageNumbers } from "./normalize";

export interface Part {
  title: string;
  text: string;
}

export function assemble(parts: Part[]): { text: string; sections: Section[] } {
  const sections: Section[] = [];
  let buf = "";

  for (let i = 0; i < parts.length; i++) {
    const cleaned = stripOrphanPageNumbers(normalizeText(parts[i].text)).trim();
    if (!cleaned) continue;

    if (buf) {
      // A page that ends mid-sentence and continues in lowercase on the next
      // page is one sentence; joining with a blank line would make the engine
      // pause in the middle of a clause.
      const tail = buf[buf.length - 1];
      const head = cleaned[0];
      const continues = !/[.!?:;"')\]]/.test(tail) && /[a-z(]/.test(head);
      if (continues && /[a-z]-$/.test(buf)) {
        buf = buf.slice(0, -1); // hyphenated word split across the page break
      } else {
        buf += continues ? " " : "\n\n";
      }
    }

    const start = buf.length;
    buf += cleaned;
    sections.push({
      id: `sec-${i}`,
      index: sections.length + 1,
      title: parts[i].title,
      start,
      end: buf.length,
    });
  }

  return { text: buf, sections };
}
