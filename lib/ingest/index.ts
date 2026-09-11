/* ────────────────────────────────────────────────────────────────
   Ingestion façade. One entry point; format detection by magic bytes
   first, extension second, because browsers lie about MIME types for
   EPUBs (`application/octet-stream` is common).
   ──────────────────────────────────────────────────────────────── */

import type { Document, IngestProgress, SourceKind } from "@/lib/types";
import { assemble, type Part } from "@/lib/text/assemble";
import { chunkDocument, CHUNK_PRESETS, type ChunkOptions } from "@/lib/text/chunk";
import { countWords, estimateSeconds } from "@/lib/text/normalize";
import { extractPdf } from "./pdf";
import { extractEpub } from "./epub";
import { htmlToText } from "./html";
import { looksLikeMarkdown, markdownToText } from "@/lib/text/markdown";
import {
  captionsToParts,
  detectCaptionFormat,
  looksLikeTranscriptPanel,
  parseCaptions,
} from "./captions";
import type { YouTubeHandoff } from "./youtube";

export interface IngestOptions {
  chunking?: ChunkOptions;
  onProgress?: (p: IngestProgress) => void;
  signal?: AbortSignal;
}

export const CAPTION_EXTENSIONS = new Set(["vtt", "srt", "sbv", "ttml", "dfxp", "srv3"]);

/** 250 MB. Above this the browser will thrash before pdf.js even starts. */
export const MAX_FILE_BYTES = 250 * 1024 * 1024;

/**
 * What the file picker offers, in one place.
 *
 * There are three pickers (the landing zone, the top bar, and a drop that
 * falls back to one) and they were drifting apart; a format missing from one
 * of them reads as "unsupported" even though ingestion handles it fine.
 */
export const ACCEPTED_FILE_TYPES = [
  ".pdf", ".epub", ".txt", ".md", ".markdown", ".html", ".htm", ".xhtml",
  ".vtt", ".srt", ".sbv", ".ttml", ".dfxp",
  "application/pdf", "application/epub+zip", "text/plain", "text/markdown",
  "text/html", "text/vtt",
].join(",");

export async function ingestFile(file: File, opts: IngestOptions = {}): Promise<Document> {
  const onProgress = opts.onProgress ?? (() => {});
  const chunking = opts.chunking ?? CHUNK_PRESETS.balanced;

  if (file.size > MAX_FILE_BYTES) {
    throw new Error(
      `${formatBytes(file.size)} exceeds the ${formatBytes(MAX_FILE_BYTES)} ceiling. Split the file and ingest it in parts.`,
    );
  }

  onProgress({ phase: "reading", ratio: 0, detail: `Reading ${file.name}` });
  const buffer = await file.arrayBuffer();
  const kind = await detectKind(file, buffer);

  let parts: Part[];
  let meta: { title?: string; author?: string; pages?: number; warnings: string[] };

  switch (kind) {
    case "pdf": {
      const r = await extractPdf(buffer, onProgress, opts.signal);
      parts = r.parts;
      meta = r.meta;
      break;
    }
    case "epub": {
      const r = await extractEpub(buffer, onProgress, opts.signal);
      parts = r.parts;
      meta = { ...r.meta };
      break;
    }
    case "captions": {
      const cues = parseCaptions(decodeText(buffer));
      parts = captionsToParts(cues);
      meta = { warnings: captionWarnings(cues.length, parts.length) };
      break;
    }
    case "html": {
      const text = htmlToText(new TextDecoder().decode(buffer));
      parts = [{ title: file.name, text }];
      meta = { warnings: [] };
      break;
    }
    default: {
      const text = decodeText(buffer);
      parts = splitPlainText(text, file.name);
      // Markup is invisible to a reader and very audible to a listener.
      if (kind === "md" || looksLikeMarkdown(text)) {
        parts = parts.map((p) => ({ ...p, text: markdownToText(p.text) }));
      }
      meta = { warnings: [] };
    }
  }

  return buildDocument({
    name: file.name,
    kind,
    bytes: file.size,
    parts,
    meta,
    chunking,
    onProgress,
  });
}

export function ingestText(
  text: string,
  name = "Pasted text",
  opts: IngestOptions = {},
): Document {
  const chunking = opts.chunking ?? CHUNK_PRESETS.balanced;

  // Somebody who copied YouTube's transcript panel has pasted timestamps
  // interleaved with the words. Read as prose, the narrator would say
  // "nought twelve" every four seconds.
  if (looksLikeTranscriptPanel(text)) {
    return ingestCaptionText(text, name, opts);
  }

  let parts = splitPlainText(text, name);
  if (looksLikeMarkdown(text)) {
    parts = parts.map((p) => ({ ...p, text: markdownToText(p.text) }));
  }
  return buildDocumentSync({
    name,
    kind: "paste",
    bytes: new Blob([text]).size,
    parts,
    meta: { warnings: [] },
    chunking,
  });
}

/**
 * A caption track or a pasted transcript, as text. Shared by the file path,
 * the paste box and the YouTube hand-off.
 */
export function ingestCaptionText(
  text: string,
  name = "Transcript",
  opts: IngestOptions = {},
): Document {
  const cues = parseCaptions(text);
  const parts = captionsToParts(cues);
  return buildDocumentSync({
    name,
    kind: "captions",
    bytes: new Blob([text]).size,
    parts,
    meta: { warnings: captionWarnings(cues.length, parts.length) },
    chunking: opts.chunking ?? CHUNK_PRESETS.balanced,
  });
}

/** A transcript handed over by the browser helper. */
export function ingestYouTube(handoff: YouTubeHandoff, opts: IngestOptions = {}): Document {
  const parts = captionsToParts(handoff.cues);
  const doc = buildDocumentSync({
    name: `${handoff.title}.transcript`,
    kind: "captions",
    bytes: handoff.cues.reduce((n, c) => n + c.text.length, 0),
    parts,
    meta: {
      title: handoff.title,
      author: handoff.author,
      warnings: captionWarnings(handoff.cues.length, parts.length),
    },
    chunking: opts.chunking ?? CHUNK_PRESETS.balanced,
  });
  return doc;
}

function captionWarnings(cueCount: number, partCount: number): string[] {
  if (cueCount === 0) return ["No caption lines were found in that file."];
  if (partCount === 0) return ["That caption track had timings but no text."];
  return [];
}

/** Is this something the caption pipeline can read? */
export function isCaptionText(text: string): boolean {
  return detectCaptionFormat(text) !== null;
}

/* ── internals ───────────────────────────────────────────────── */

interface BuildArgs {
  name: string;
  kind: SourceKind;
  bytes: number;
  parts: Part[];
  meta: { title?: string; author?: string; pages?: number; warnings: string[] };
  chunking: ChunkOptions;
  onProgress?: (p: IngestProgress) => void;
}

async function buildDocument(args: BuildArgs): Promise<Document> {
  args.onProgress?.({ phase: "chunking", ratio: 0.9, detail: "Segmenting into passages" });
  await new Promise((r) => setTimeout(r, 0));
  const doc = buildDocumentSync(args);
  args.onProgress?.({ phase: "done", ratio: 1, detail: `${doc.chunks.length.toLocaleString()} passages ready` });
  return doc;
}

function buildDocumentSync(args: BuildArgs): Document {
  const { text, sections } = assemble(args.parts);
  if (!text.trim()) {
    throw new Error(
      "No readable text was found. If this is a scanned PDF or an image-only export, OCR it first.",
    );
  }

  const chunks = chunkDocument(text, sections, args.chunking);
  const words = countWords(text);

  return {
    id: `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: args.name,
    kind: args.kind,
    bytes: args.bytes,
    text,
    sections,
    chunks,
    meta: {
      title: args.meta.title,
      author: args.meta.author,
      pages: args.meta.pages,
      words,
      characters: text.length,
      estSeconds: chunks.reduce((a, c) => a + c.estSeconds, 0) || estimateSeconds(words),
      ingestedAt: Date.now(),
      warnings: args.meta.warnings,
    },
  };
}

async function detectKind(file: File, buffer: ArrayBuffer): Promise<SourceKind> {
  const head = new Uint8Array(buffer.slice(0, 4));
  const ext = file.name.toLowerCase().split(".").pop() ?? "";

  // %PDF
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) {
    return "pdf";
  }
  // PK.. — a ZIP. EPUB is the only ZIP we accept.
  if (head[0] === 0x50 && head[1] === 0x4b) {
    if (ext === "epub" || file.type.includes("epub")) return "epub";
    // Sniff the mimetype entry, which EPUB requires to be the first member.
    const probe = new TextDecoder().decode(new Uint8Array(buffer.slice(0, 128)));
    if (probe.includes("application/epub+zip")) return "epub";
    throw new Error("That ZIP archive is not an EPUB. Upload a PDF, EPUB, or text file.");
  }

  if (CAPTION_EXTENSIONS.has(ext)) return "captions";
  // A caption file saved without its extension is still unmistakable.
  const sniff = new TextDecoder().decode(new Uint8Array(buffer.slice(0, 512)));
  if (/^\uFEFF?WEBVTT/.test(sniff) || /\d{1,2}:\d{2}:\d{2},\d{3}\s*-->/.test(sniff)) {
    return "captions";
  }

  if (ext === "html" || ext === "htm" || ext === "xhtml") return "html";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "pdf") return "pdf";
  if (ext === "epub") return "epub";
  return "txt";
}

function decodeText(buffer: ArrayBuffer): string {
  // Honor a UTF-8/UTF-16 BOM; fall back to UTF-8 with replacement.
  const b = new Uint8Array(buffer);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(buffer);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(buffer);
  return new TextDecoder("utf-8").decode(buffer);
}

/**
 * Give long plain text a navigable spine. Markdown headings win; otherwise
 * we cut every ~12k characters at a paragraph boundary so the outline is
 * still useful on a 400-page novel pasted as .txt.
 */
function splitPlainText(text: string, name: string): Part[] {
  const headings = [...text.matchAll(/^#{1,3} +(.+)$/gm)];
  if (headings.length >= 2) {
    const parts: Part[] = [];
    for (let i = 0; i < headings.length; i++) {
      const start = headings[i].index ?? 0;
      const end = i + 1 < headings.length ? (headings[i + 1].index ?? text.length) : text.length;
      parts.push({ title: headings[i][1].trim(), text: text.slice(start, end) });
    }
    if ((headings[0].index ?? 0) > 0) {
      parts.unshift({ title: "Front matter", text: text.slice(0, headings[0].index ?? 0) });
    }
    return parts;
  }

  const TARGET = 12_000;
  if (text.length <= TARGET) return [{ title: name, text }];

  const parts: Part[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(text.length, cursor + TARGET);
    if (end < text.length) {
      const br = text.lastIndexOf("\n\n", end);
      if (br > cursor + TARGET * 0.5) end = br;
    }
    parts.push({ title: `Part ${parts.length + 1}`, text: text.slice(cursor, end) });
    cursor = end;
  }
  return parts;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
