/* ────────────────────────────────────────────────────────────────
   PDF ingestion via pdf.js.

   The whole game with "massive" PDFs is never holding more than one
   page of rendered state at a time. Three rules keep a 1,200-page
   scan from killing the tab:

   1. Load with `disableAutoFetch` + `disableStream: false` so pdf.js
      pulls ranges lazily instead of materializing the whole file.
   2. Call `page.cleanup()` and drop the page reference immediately
      after extracting its text. pdf.js caches operator lists per page
      and will happily grow to gigabytes otherwise.
   3. Yield to the event loop every few pages so the progress UI can
      paint and the user can cancel.

   We reconstruct layout from text-item geometry rather than blindly
   joining items: pdf.js emits one item per glyph run, so naive joins
   produce "T h e   q u i c k" on some documents and run whole
   paragraphs together on others.
   ──────────────────────────────────────────────────────────────── */

import type { IngestProgress } from "@/lib/types";
import { stripRunningFurniture } from "@/lib/text/normalize";
import type { Part } from "@/lib/text/assemble";
import { asset } from "@/lib/base-path";

/**
 * We import the LEGACY build, not the default one.
 *
 * pdf.js 6's modern bundle targets a very recent JavaScript baseline and calls
 * methods that most shipping browsers do not have yet (`Map.prototype.
 * getOrInsertComputed`, among others). On a browser missing them, page text
 * still extracts but `getMetadata()` throws, and other paths are a coin flip.
 * The legacy build is pdf.js's own answer to this: same API, transpiled and
 * polyfilled. The cost is a slightly larger bundle, which is the right trade
 * for a parser that has to work everywhere.
 *
 * It is imported lazily so it never lands in the server bundle or the initial
 * client chunk - the parser is ~400 KB and nobody needs it until they open a
 * PDF.
 */
type PdfModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjs: PdfModule | null = null;

async function loadPdfJs(): Promise<PdfModule> {
  if (pdfjs) return pdfjs;
  const mod = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // `scripts/copy-pdf-worker.mjs` places the matching worker here on install.
  // `asset()` so a subdirectory deployment resolves it correctly.
  mod.GlobalWorkerOptions.workerSrc = asset("/pdf.worker.min.mjs");
  pdfjs = mod;
  return mod;
}

interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}

export interface PdfResult {
  parts: Part[];
  meta: { title?: string; author?: string; pages: number; warnings: string[] };
}

export async function extractPdf(
  data: ArrayBuffer,
  onProgress: (p: IngestProgress) => void,
  signal?: AbortSignal,
): Promise<PdfResult> {
  const pdfjsLib = await loadPdfJs();

  onProgress({ phase: "parsing", ratio: 0, detail: "Opening document" });

  const task = pdfjsLib.getDocument({
    data: new Uint8Array(data),
    // Lazy range requests keep peak memory near one page, not one book.
    disableAutoFetch: true,
    // We only need the text layer; never build canvas font resources.
    disableFontFace: true,
  });

  signal?.addEventListener("abort", () => void task.destroy(), { once: true });

  const doc = await task.promise;
  const warnings: string[] = [];

  let title: string | undefined;
  let author: string | undefined;
  try {
    const info = await doc.getMetadata();
    const raw = info.info as Record<string, unknown> | undefined;
    title = asString(raw?.Title);
    author = asString(raw?.Author);
  } catch {
    /* metadata is optional; some producers omit the Info dictionary */
  }

  const pageTexts: string[] = [];
  let emptyPages = 0;

  for (let n = 1; n <= doc.numPages; n++) {
    if (signal?.aborted) throw new DOMException("Ingestion cancelled", "AbortError");

    const page = await doc.getPage(n);
    try {
      const content = await page.getTextContent();
      const text = reflow(content.items as unknown as TextItemLike[]);
      if (text.trim().length < 8) emptyPages++;
      pageTexts.push(text);
    } finally {
      // Critical for large files: release the page's operator-list cache.
      page.cleanup();
    }

    if (n % 4 === 0 || n === doc.numPages) {
      onProgress({
        phase: "parsing",
        ratio: n / doc.numPages,
        detail: `Extracting page ${n.toLocaleString()} of ${doc.numPages.toLocaleString()}`,
      });
      // Let the browser paint; without this the progress bar is a lie.
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const pages = doc.numPages;
  // `cleanup()` drops the shared font/image caches; `destroy()` on the loading
  // task tears down the worker. Both matter: skipping either leaves tens of
  // megabytes per document alive for as long as the tab lives.
  doc.cleanup();
  await task.destroy();

  if (emptyPages > pages * 0.4) {
    warnings.push(
      `${emptyPages} of ${pages} pages contained no extractable text. This PDF is likely a scan — run it through OCR first for usable audio.`,
    );
  }

  onProgress({ phase: "normalizing", ratio: 1, detail: "Removing headers and footers" });
  const cleaned = stripRunningFurniture(pageTexts);

  return {
    parts: cleaned.map((text, i) => ({ title: `Page ${i + 1}`, text })),
    meta: { title, author, pages, warnings },
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Rebuild reading order and whitespace from text-item geometry.
 *
 * pdf.js gives each item a transform matrix; `transform[5]` is the baseline
 * Y and `transform[4]` the left X. A new line is a meaningful drop in Y; a
 * space is a horizontal gap wider than roughly a third of the font size.
 */
function reflow(items: TextItemLike[]): string {
  if (items.length === 0) return "";

  let out = "";
  let prevY: number | null = null;
  let prevRight = 0;
  let prevSize = 12;

  /**
   * Emit at most the requested number of newlines, counting what is already
   * at the tail. Both `hasEOL` and the geometry check can fire for the same
   * break; stacking them turns every wrapped line into its own paragraph,
   * which then defeats the line-rejoining pass in `normalizeText`.
   */
  const breakLines = (count: number) => {
    const existing = /\n*$/.exec(out)?.[0].length ?? 0;
    if (existing >= count) return;
    out += "\n".repeat(count - existing);
  };

  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const t = item.transform;
    if (!t || t.length < 6) {
      out += item.str;
      continue;
    }

    const x = t[4];
    const y = t[5];
    const size = Math.abs(t[3]) || Math.abs(t[0]) || prevSize;

    if (prevY !== null) {
      const dy = Math.abs(y - prevY);
      if (dy > size * 0.5) {
        // A new line. Typical leading runs 1.2-1.4x the font size, so a drop
        // past ~1.6x means the extra space of a paragraph break.
        breakLines(dy > size * 1.6 ? 2 : 1);
      } else {
        const gap = x - prevRight;
        if (gap > size * 0.28 && !/\s$/.test(out) && !/^\s/.test(item.str)) {
          out += " ";
        }
      }
    }

    out += item.str;
    if (item.hasEOL) breakLines(1);

    prevY = y;
    prevRight = x + (item.width || 0);
    prevSize = size;
  }

  return out;
}
