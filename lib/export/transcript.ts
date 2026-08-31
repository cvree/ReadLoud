/* ────────────────────────────────────────────────────────────────
   Transcript generation.

   Five formats, one source of truth. When an MP3 has been rendered we
   have real per-passage timings from decoded sample counts, so SRT and
   VTT line up with the audio exactly. Without a render we fall back to
   estimated timings and say so in the header.
   ──────────────────────────────────────────────────────────────── */

import type { Chunk, Document, TranscriptCue } from "@/lib/types";
import { formatClock } from "@/lib/audio/pipeline";

export type TranscriptFormat = "txt" | "md" | "srt" | "vtt" | "json";

export interface TranscriptOptions {
  format: TranscriptFormat;
  /** Insert "## Chapter 3" style markers at section boundaries. */
  includeSections: boolean;
  /** Prefix each passage with its timecode (txt/md only). */
  includeTimestamps: boolean;
  /** Real timings from a render; estimated when absent. */
  cues?: TranscriptCue[];
  /**
   * Override the header totals. Used by the preview, which renders only the
   * first few passages but must still describe the whole document.
   */
  totals?: { passages: number; duration: number };
}

export function buildTranscript(
  doc: Document,
  chunks: Chunk[],
  opts: TranscriptOptions,
): { content: string; mime: string; extension: string } {
  const cues = opts.cues ?? estimateCues(chunks);

  switch (opts.format) {
    case "srt":
      return { content: toSrt(cues), mime: "application/x-subrip", extension: "srt" };
    case "vtt":
      return { content: toVtt(cues), mime: "text/vtt", extension: "vtt" };
    case "json":
      return {
        content: JSON.stringify(
          {
            title: doc.meta.title ?? doc.name,
            author: doc.meta.author,
            source: { name: doc.name, kind: doc.kind, pages: doc.meta.pages },
            stats: {
              words: doc.meta.words,
              characters: doc.meta.characters,
              passages: chunks.length,
              durationSeconds: cues.length ? cues[cues.length - 1].end : 0,
              timingsAreEstimates: !opts.cues,
            },
            sections: doc.sections.map((s) => ({ index: s.index, title: s.title })),
            cues,
          },
          null,
          2,
        ),
        mime: "application/json",
        extension: "json",
      };
    case "md":
      return { content: toMarkdown(doc, chunks, cues, opts), mime: "text/markdown", extension: "md" };
    case "txt":
    default:
      return { content: toPlain(doc, chunks, cues, opts), mime: "text/plain", extension: "txt" };
  }
}

/** Estimated cues, used before a render exists. */
function estimateCues(chunks: Chunk[]): TranscriptCue[] {
  let t = 0;
  return chunks.map((c, i) => {
    const start = t;
    t += c.estSeconds;
    return { index: i, start, end: t, text: c.text, sectionTitle: c.sectionTitle };
  });
}

function header(
  doc: Document,
  chunks: Chunk[],
  cues: TranscriptCue[],
  estimated: boolean,
  totals?: { passages: number; duration: number },
) {
  const duration = totals?.duration ?? (cues.length ? cues[cues.length - 1].end : 0);
  return {
    title: doc.meta.title ?? stripExtension(doc.name),
    author: doc.meta.author,
    words: doc.meta.words,
    passages: totals?.passages ?? chunks.length,
    duration,
    estimated,
    generated: new Date().toISOString(),
  };
}

function toPlain(
  doc: Document,
  chunks: Chunk[],
  cues: TranscriptCue[],
  opts: TranscriptOptions,
): string {
  const h = header(doc, chunks, cues, !opts.cues, opts.totals);
  const lines: string[] = [];
  lines.push(h.title);
  if (h.author) lines.push(`by ${h.author}`);
  lines.push("=".repeat(Math.min(72, Math.max(h.title.length, 24))));
  lines.push(
    `${h.words.toLocaleString()} words - ${h.passages.toLocaleString()} passages - ${formatClock(h.duration)}${h.estimated ? " (estimated)" : ""}`,
  );
  lines.push(`Transcribed by ReadLoud on ${new Date().toLocaleString()}`);
  lines.push("");

  let lastSection = "";
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (opts.includeSections && c.sectionTitle !== lastSection) {
      lines.push("", `--- ${c.sectionTitle} ---`, "");
      lastSection = c.sectionTitle;
    }
    const stamp = opts.includeTimestamps ? `[${formatClock(cues[i].start)}] ` : "";
    lines.push(stamp + c.text);
    lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function toMarkdown(
  doc: Document,
  chunks: Chunk[],
  cues: TranscriptCue[],
  opts: TranscriptOptions,
): string {
  const h = header(doc, chunks, cues, !opts.cues, opts.totals);
  const out: string[] = [];
  out.push(`# ${h.title}`, "");
  if (h.author) out.push(`*by ${h.author}*`, "");
  out.push(
    "| | |",
    "|---|---|",
    `| **Words** | ${h.words.toLocaleString()} |`,
    `| **Passages** | ${h.passages.toLocaleString()} |`,
    `| **Duration** | ${formatClock(h.duration)}${h.estimated ? " *(estimated)*" : ""} |`,
    `| **Source** | \`${doc.name}\` |`,
    `| **Generated** | ${new Date().toLocaleString()} |`,
    "",
    "---",
    "",
  );

  let lastSection = "";
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (opts.includeSections && c.sectionTitle !== lastSection) {
      out.push(`## ${c.sectionTitle}`, "");
      lastSection = c.sectionTitle;
    }
    if (opts.includeTimestamps) {
      out.push(`<sub>\`${formatClock(cues[i].start)}\`</sub>`, "");
    }
    out.push(c.text, "");
  }
  out.push("---", "", "<sub>Transcript generated by ReadLoud.</sub>", "");
  return out.join("\n");
}

function toSrt(cues: TranscriptCue[]): string {
  // Long passages make unreadable subtitles; split them across the cue's span.
  return splitForSubtitles(cues)
    .map(
      (c, i) =>
        `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${wrapForSubtitle(c.text)}\n`,
    )
    .join("\n");
}

function toVtt(cues: TranscriptCue[]): string {
  const body = splitForSubtitles(cues)
    .map(
      (c, i) =>
        `${i + 1}\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${wrapForSubtitle(c.text)}\n`,
    )
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

/**
 * Break each passage into subtitle-sized lines, distributing the passage's
 * measured duration across them in proportion to character count.
 */
function splitForSubtitles(cues: TranscriptCue[], maxChars = 84): TranscriptCue[] {
  const out: TranscriptCue[] = [];
  for (const cue of cues) {
    const pieces = splitSentences(cue.text, maxChars);
    if (pieces.length <= 1) {
      out.push({ ...cue, index: out.length });
      continue;
    }
    const total = pieces.reduce((a, p) => a + p.length, 0) || 1;
    const span = Math.max(0.001, cue.end - cue.start);
    let t = cue.start;
    for (const piece of pieces) {
      const dur = (piece.length / total) * span;
      out.push({
        index: out.length,
        start: t,
        end: t + dur,
        text: piece,
        sectionTitle: cue.sectionTitle,
      });
      t += dur;
    }
  }
  return out;
}

function splitSentences(text: string, maxChars: number): string[] {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return [flat];

  const sentences = flat.match(/[^.!?]+[.!?]*\s*/g) ?? [flat];
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (buf && (buf + s).length > maxChars) {
      out.push(buf.trim());
      buf = "";
    }
    if (s.length > maxChars) {
      // A single very long sentence: cut on word boundaries.
      let rest = (buf + s).trim();
      buf = "";
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf(" ", maxChars);
        if (cut <= 0) cut = maxChars;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      buf = rest;
    } else {
      buf += s;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

/** Two balanced lines read better than one long one. */
function wrapForSubtitle(text: string): string {
  if (text.length <= 42) return text;
  const mid = Math.floor(text.length / 2);
  let cut = text.lastIndexOf(" ", mid);
  if (cut < text.length * 0.25) cut = text.indexOf(" ", mid);
  if (cut <= 0) return text;
  return `${text.slice(0, cut)}\n${text.slice(cut + 1)}`;
}

function srtTime(t: number): string {
  return timecode(t, ",");
}
function vttTime(t: number): string {
  return timecode(t, ".");
}
function timecode(t: number, sep: string): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${String(rest).padStart(3, "0")}`;
}
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}
