/* ────────────────────────────────────────────────────────────────
   Caption and transcript ingestion.

   Covers WebVTT, SubRip, SBV, TTML/XML and YouTube's `json3`, plus
   the format you get by selecting YouTube's own transcript panel and
   hitting copy. One parser per format, all landing on `CaptionCue[]`.

   The parsing is the easy half. The half that decides whether the
   result is listenable is `repairCaptions` - see the comment there.
   ──────────────────────────────────────────────────────────────── */

import type { CaptionCue } from "@/lib/types";
import type { Part } from "@/lib/text/assemble";

export type CaptionFormat = "vtt" | "srt" | "sbv" | "ttml" | "json3" | "panel";

/* ── Format detection ────────────────────────────────────────── */

export function detectCaptionFormat(src: string): CaptionFormat | null {
  const head = src.slice(0, 4096);
  if (/^﻿?WEBVTT/.test(head)) return "vtt";
  if (/^\s*[[{]/.test(head) && /"events"\s*:/.test(head)) return "json3";
  if (/<\s*(tt|transcript|tt:tt)[\s>]/i.test(head)) return "ttml";
  // SubRip: an index line, then `00:00:01,000 --> 00:00:04,000`.
  if (/\d{1,2}:\d{2}:\d{2},\d{3}\s*-->/.test(head)) return "srt";
  // WebVTT cue timings can appear without the header in fragments.
  if (/\d{1,2}:\d{2}(:\d{2})?\.\d{3}\s*-->/.test(head)) return "vtt";
  // SBV: `0:00:01.000,0:00:04.000`
  if (/\d{1,2}:\d{2}:\d{2}\.\d{3},\d{1,2}:\d{2}:\d{2}\.\d{3}/.test(head)) return "sbv";
  if (looksLikeTranscriptPanel(src)) return "panel";
  return null;
}

/**
 * YouTube's transcript panel, copied to the clipboard, arrives as a timestamp
 * and its line - sometimes on two lines, sometimes on one. Require several
 * matches before claiming it, so ordinary prose that happens to mention "3:15"
 * is not misread as a transcript.
 */
export function looksLikeTranscriptPanel(src: string): boolean {
  const stamps = src.match(/(?:^|\n)\s*\d{1,2}:\d{2}(?::\d{2})?(?=\s|$)/g);
  return (stamps?.length ?? 0) >= 4;
}

export function parseCaptions(src: string, format?: CaptionFormat): CaptionCue[] {
  const fmt = format ?? detectCaptionFormat(src);
  switch (fmt) {
    case "vtt": return parseVtt(src);
    case "srt": return parseSrt(src);
    case "sbv": return parseSbv(src);
    case "ttml": return parseTtml(src);
    case "json3": return parseJson3(src);
    case "panel": return parsePanel(src);
    default:
      throw new Error("That does not look like a transcript or caption file.");
  }
}

/* ── Time parsing ────────────────────────────────────────────── */

/** `01:02:03.456`, `02:03.456`, `1:02:03,456`, `62.5` -> seconds. */
function parseTimestamp(raw: string): number {
  const s = raw.trim().replace(",", ".");
  const parts = s.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

/* ── WebVTT / SubRip ─────────────────────────────────────────── */

const ARROW = /\s*-->\s*/;

function parseVtt(src: string): CaptionCue[] {
  const out: CaptionCue[] = [];
  const blocks = splitBlocks(src);

  for (const block of blocks) {
    const lines = block.split("\n");
    const timeIndex = lines.findIndex((l) => ARROW.test(l));
    if (timeIndex === -1) continue; // NOTE, STYLE, REGION, or the header

    const [from, to] = lines[timeIndex].split(ARROW);
    const start = parseTimestamp(from);
    // A cue's settings (`align:start position:0%`) ride on the end timestamp.
    const end = parseTimestamp((to ?? "").split(/\s+/)[0] ?? "");
    if (!Number.isFinite(start)) continue;

    const text = stripCueMarkup(lines.slice(timeIndex + 1).join("\n"));
    if (text) out.push({ start, end: Number.isFinite(end) ? end : start, text });
  }
  return out;
}

function parseSrt(src: string): CaptionCue[] {
  // SubRip differs from WebVTT only in the comma decimal separator and the
  // mandatory index line, both of which the VTT parser already tolerates.
  return parseVtt(src);
}

function parseSbv(src: string): CaptionCue[] {
  const out: CaptionCue[] = [];
  for (const block of splitBlocks(src)) {
    const lines = block.split("\n");
    const m = /^([\d:.]+),([\d:.]+)$/.exec(lines[0]?.trim() ?? "");
    if (!m) continue;
    const text = stripCueMarkup(lines.slice(1).join("\n"));
    if (text) out.push({ start: parseTimestamp(m[1]), end: parseTimestamp(m[2]), text });
  }
  return out;
}

function splitBlocks(src: string): string[] {
  return src.replace(/\r\n?/g, "\n").split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
}

/**
 * Caption files carry markup a speech engine would happily vocalize:
 * `<c.colorE5E5E5>`, `<00:00:01.234>` karaoke timings, `{\an8}` positioning.
 */
function stripCueMarkup(text: string): string {
  return decodeEntities(
    text
      .replace(/<\d{1,2}:\d{2}:\d{2}[.,]\d{3}>/g, "")
      .replace(/<[^>]*>/g, "")
      .replace(/\{\\[^}]*\}/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // last, so `&amp;lt;` survives as `&lt;`
}

/* ── TTML / YouTube srv XML ──────────────────────────────────── */

function parseTtml(src: string): CaptionCue[] {
  const doc = new DOMParser().parseFromString(src, "text/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("That caption file is not valid XML.");
  }
  const out: CaptionCue[] = [];
  // `<p>` is TTML; `<text>` is YouTube's older srv1/srv3 shape.
  const nodes = doc.querySelectorAll("p, text");

  nodes.forEach((node) => {
    const begin = node.getAttribute("begin") ?? node.getAttribute("start") ?? node.getAttribute("t");
    if (begin === null) return;
    const start = /^\d+$/.test(begin) ? Number(begin) / 1000 : parseTimestamp(begin);

    const endAttr = node.getAttribute("end");
    const durAttr = node.getAttribute("dur") ?? node.getAttribute("d");
    const end = endAttr
      ? (/^\d+$/.test(endAttr) ? Number(endAttr) / 1000 : parseTimestamp(endAttr))
      : start + (durAttr ? (/^\d+$/.test(durAttr) ? Number(durAttr) / 1000 : parseTimestamp(durAttr)) : 0);

    const text = stripCueMarkup(node.textContent ?? "");
    if (text && Number.isFinite(start)) out.push({ start, end, text });
  });
  return out;
}

/* ── YouTube json3 ───────────────────────────────────────────── */

interface Json3Seg { utf8?: string; tOffsetMs?: number }
interface Json3Event { tStartMs?: number; dDurationMs?: number; segs?: Json3Seg[]; aAppend?: number }

function parseJson3(src: string): CaptionCue[] {
  const data = JSON.parse(src) as { events?: Json3Event[] };
  const out: CaptionCue[] = [];

  for (const ev of data.events ?? []) {
    // `aAppend` events re-send text already carried by the previous event in
    // order to scroll a caption window. They are pure duplication.
    if (ev.aAppend === 1) continue;
    if (!ev.segs || typeof ev.tStartMs !== "number") continue;

    const text = stripCueMarkup(ev.segs.map((s) => s.utf8 ?? "").join(""));
    if (!text) continue;
    const start = ev.tStartMs / 1000;
    out.push({ start, end: start + (ev.dDurationMs ?? 0) / 1000, text });
  }
  return out;
}

/* ── YouTube transcript panel, copied and pasted ─────────────── */

function parsePanel(src: string): CaptionCue[] {
  const out: CaptionCue[] = [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const stamp = /^\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const m = stamp.exec(lines[i]);
    if (!m) continue;
    // The panel copies as either "0:12<tab>text" or "0:12\ntext" depending on
    // the browser and how the selection was made. Accept both.
    let text = m[2].trim();
    if (!text) {
      const next = lines[i + 1] ?? "";
      if (!stamp.test(next)) {
        text = next.trim();
        i++;
      }
    }
    text = stripCueMarkup(text);
    if (text) out.push({ start: parseTimestamp(m[1]), end: NaN, text });
  }

  // The panel gives no end times; infer each from the next cue's start so the
  // gap analysis in `repairCaptions` still has something to work with.
  for (let i = 0; i < out.length; i++) {
    if (!Number.isFinite(out[i].end)) {
      out[i].end = out[i + 1] ? out[i + 1].start : out[i].start;
    }
  }
  return out;
}

/* ── Repair ──────────────────────────────────────────────────── */

export interface RepairOptions {
  /** Silence past this many seconds becomes a paragraph break. */
  paragraphGap: number;
  /** On unpunctuated tracks, silence past this becomes a sentence break. */
  sentenceGap: number;
}

export const DEFAULT_REPAIR: RepairOptions = { paragraphGap: 2.0, sentenceGap: 0.85 };

export interface RepairResult {
  text: string;
  /** True when the source carried no usable punctuation of its own. */
  reconstructed: boolean;
  droppedWords: number;
}

/**
 * Turn cues into prose a narrator can read.
 *
 * Three things are wrong with a raw caption track, and all three are fatal
 * downstream rather than merely untidy:
 *
 * 1. **Rolling windows repeat themselves.** A track that scrolls emits
 *    "the quick brown" then "quick brown fox": join them naively and the
 *    narrator says every phrase twice.
 * 2. **Cue boundaries are not sentence boundaries.** They are line breaks in a
 *    box at the bottom of a video. Joined with newlines they would give
 *    `segmentSentences` one "sentence" every four words, and the chunker would
 *    then break mid-clause.
 * 3. **Auto-captions have no punctuation at all.** Nothing for the segmenter to
 *    split on, nothing for the narrator to breathe on, and nothing for RSVP
 *    pacing to slow down at - which is the difference between pleasant and
 *    unbearable.
 *
 * The fix for (3) is the only one that puts characters in the text that nobody
 * said, so it is deliberately conservative: it runs *only* when the track has
 * essentially no punctuation of its own, and it derives every break from a
 * real pause in the speech. The pause is the punctuation; we are transcribing
 * it, not inventing it. A track that arrives already punctuated - anything
 * human-authored - is left exactly as written.
 */
export function repairCaptions(
  cues: CaptionCue[],
  options: RepairOptions = DEFAULT_REPAIR,
): RepairResult {
  if (cues.length === 0) return { text: "", reconstructed: false, droppedWords: 0 };

  const ordered = [...cues].sort((a, b) => a.start - b.start);
  const { deduped, droppedWords } = dedupeRollingWindow(ordered);

  const words = deduped.reduce((n, c) => n + countWordsLoose(c.text), 0);
  const terminals = deduped.reduce(
    (n, c) => n + (c.text.match(/[.!?](?:["')\]]|\s|$)/g)?.length ?? 0),
    0,
  );
  // Human captions run about one terminal mark per fifteen words. Auto-captions
  // run zero. One per hundred separates them with room to spare. The word floor
  // is only there so a handful of words is never enough to judge on - low
  // enough that a thirty-second Short still gets repaired.
  const reconstructed = words >= 25 && terminals / words < 0.01;

  const breaks = planBreaks(deduped, reconstructed, options);

  let text = "";
  for (let i = 0; i < deduped.length; i++) {
    if (i > 0) {
      const alreadyPunctuated = /[.!?,;:—–-]["')\]]?$/.test(text);
      if (breaks[i] === "paragraph") text += reconstructed && !alreadyPunctuated ? ".\n\n" : "\n\n";
      else if (breaks[i] === "sentence" && !alreadyPunctuated) text += ". ";
      else text += " ";
    }
    text += deduped[i].text;
  }

  // Close the last sentence, but only when the track actually ends on a word.
  // Ending on a comma is odd; ending on `and,.` is broken.
  if (reconstructed && /[\p{L}\p{N}]$/u.test(text)) text += ".";
  return { text, reconstructed, droppedWords };
}

type Break = "space" | "sentence" | "paragraph";

/**
 * Decide where each cue boundary becomes a space, a sentence end, or a
 * paragraph break.
 *
 * Long silences are the primary signal and the honest one - the pause *is*
 * the punctuation, and we are transcribing it rather than inventing it.
 *
 * But the signal is not always there. Plenty of auto-caption tracks are
 * contiguous, each cue starting exactly where the last one ended, so the
 * gaps are all zero and a purely gap-driven pass would emit one unbroken
 * run-on for the length of the video - unreadable, unchunkable, and with
 * nowhere for the narrator to breathe. So a run that goes too long without a
 * break gets one anyway, placed at the widest gap available rather than
 * wherever the counter happened to run out. That is a guess, and it is only
 * ever made on tracks that had no punctuation to begin with.
 */
function planBreaks(cues: CaptionCue[], reconstructed: boolean, o: RepairOptions): Break[] {
  /** Never cut a sentence shorter than this many words on the fallback path. */
  const MIN_RUN = 12;
  /** Force a cut once a run reaches this many words. */
  const MAX_RUN = 30;

  const breaks: Break[] = new Array(cues.length).fill("space");
  // Cumulative word counts, so a break placed retroactively can be measured
  // from without re-counting the run.
  const upTo: number[] = new Array(cues.length + 1).fill(0);
  for (let i = 0; i < cues.length; i++) upTo[i + 1] = upTo[i] + countWordsLoose(cues[i].text);

  let lastBreak = 0;
  let bestIndex = -1;
  let bestGap = -1;

  for (let i = 1; i < cues.length; i++) {
    const prev = cues[i - 1];
    const gap = cues[i].start - (prev.end || prev.start);

    if (gap >= o.paragraphGap) {
      breaks[i] = "paragraph";
      lastBreak = i; bestIndex = -1; bestGap = -1;
      continue;
    }
    if (reconstructed && gap >= o.sentenceGap) {
      breaks[i] = "sentence";
      lastBreak = i; bestIndex = -1; bestGap = -1;
      continue;
    }
    if (!reconstructed) continue;

    const run = upTo[i] - upTo[lastBreak];
    const score = boundaryScore(prev.text, cues[i].text, gap);
    if (run >= MIN_RUN && score > bestGap) { bestGap = score; bestIndex = i; }
    if (run >= MAX_RUN) {
      const at = bestIndex >= 0 ? bestIndex : i;
      breaks[at] = "sentence";
      lastBreak = at; bestIndex = -1; bestGap = -1;
    }
  }
  return breaks;
}

/**
 * How good a place is this to end a sentence?
 *
 * A pause is the strongest evidence and dominates when there is one. On a
 * contiguous track there is none, and the choice falls to the words either
 * side: breaking after "do not" and before "glide" is audibly wrong in a way
 * that breaking before "so" or "now" is not.
 *
 * Crude, and deliberately so - this only runs on tracks that had no
 * punctuation to begin with, where the alternative is a paragraph the length
 * of the video.
 */
function boundaryScore(before: string, after: string, gap: number): number {
  let score = gap * 10; // a real pause outweighs everything below
  const last = lastWord(before);
  const next = firstWord(after);
  if (DANGLING.has(last)) score -= 4;
  if (OPENERS.has(next)) score += 3;
  return score;
}

/**
 * Words that almost never end a spoken sentence: articles, prepositions,
 * conjunctions, auxiliaries, possessives.
 *
 * Kept deliberately tight. An earlier, longer list included words like "all"
 * and "some", which end sentences perfectly well ("not at all", "I want
 * some") - and penalising a good boundary is worse than not scoring it,
 * because the break then lands somewhere arbitrary instead.
 */
const DANGLING = new Set([
  "a", "an", "the", "of", "to", "in", "on", "at", "for", "with", "from", "by",
  "as", "than", "and", "or", "but", "if", "into", "onto", "about", "because",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "will", "would", "can", "could", "should", "shall",
  "may", "might", "must", "has", "have", "had",
  "my", "your", "his", "her", "its", "our", "their", "whose",
  "very", "quite", "rather", "so", "such", "another",
]);

/** Words that commonly open a new spoken sentence. */
const OPENERS = new Set([
  "so", "now", "but", "then", "okay", "ok", "right", "well", "anyway",
  "actually", "basically", "first", "second", "next", "finally", "however",
  "meanwhile", "also", "look", "listen", "remember", "notice", "imagine",
  "i", "we", "you", "they", "he", "she", "it", "this", "that", "there",
  "here", "what", "why", "how", "when", "where", "if", "let", "lets",
]);

const lastWord = (s: string) => norm(s.trim().split(/\s+/).pop() ?? "");
const firstWord = (s: string) => norm(s.trim().split(/\s+/)[0] ?? "");

/**
 * Drop the leading words of a cue that merely repeat the tail of the one
 * before it.
 *
 * Requires a two-word overlap. One word is far too eager: "...and then" /
 * "then we..." is ordinary speech, not a scroll, and trimming it would delete
 * a word the speaker actually said.
 */
function dedupeRollingWindow(cues: CaptionCue[]): { deduped: CaptionCue[]; droppedWords: number } {
  const MIN_OVERLAP = 2;
  const MAX_OVERLAP = 24;
  const deduped: CaptionCue[] = [];
  let droppedWords = 0;

  for (const cue of cues) {
    const prev = deduped[deduped.length - 1];
    if (!prev) {
      deduped.push({ ...cue });
      continue;
    }

    const tail = prev.text.split(/\s+/).filter(Boolean);
    const head = cue.text.split(/\s+/).filter(Boolean);
    const limit = Math.min(MAX_OVERLAP, tail.length, head.length);

    let overlap = 0;
    for (let k = limit; k >= MIN_OVERLAP; k--) {
      let same = true;
      for (let j = 0; j < k; j++) {
        if (norm(tail[tail.length - k + j]) !== norm(head[j])) { same = false; break; }
      }
      if (same) { overlap = k; break; }
    }

    if (overlap === head.length) {
      // Wholly contained in what we already have: extend the timing, add nothing.
      prev.end = Math.max(prev.end, cue.end);
      droppedWords += overlap;
      continue;
    }
    if (overlap > 0) {
      droppedWords += overlap;
      deduped.push({ ...cue, text: head.slice(overlap).join(" ") });
      continue;
    }
    deduped.push({ ...cue });
  }
  return { deduped, droppedWords };
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

function countWordsLoose(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/* ── Sectioning ──────────────────────────────────────────────── */

/**
 * Give a transcript a navigable spine. Sections are titled by the video
 * timestamp they begin at, which is the only landmark a transcript has - and
 * the one a reader will be cross-referencing against the video anyway.
 */
export function captionsToParts(cues: CaptionCue[], options = DEFAULT_REPAIR): Part[] {
  if (cues.length === 0) return [];

  const TARGET = 9_000;
  const parts: Part[] = [];
  let batch: CaptionCue[] = [];
  let size = 0;

  const flush = () => {
    if (batch.length === 0) return;
    const { text } = repairCaptions(batch, options);
    if (text.trim()) parts.push({ title: formatStamp(batch[0].start), text });
    batch = [];
    size = 0;
  };

  for (const cue of cues) {
    // Prefer to cut where the speaker paused, but never run away past the target.
    const prev = batch[batch.length - 1];
    const gap = prev ? cue.start - (prev.end || prev.start) : 0;
    if (size > TARGET * 0.6 && gap >= options.paragraphGap) flush();
    else if (size > TARGET) flush();

    batch.push(cue);
    size += cue.text.length + 1;
  }
  flush();
  return parts;
}

export function formatStamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
