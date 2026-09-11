"use client";
/* ────────────────────────────────────────────────────────────────
   Reading mode.

   The hard requirement: highlight the word being spoken, inside a
   document that may be nine hundred pages long, without dropping
   frames.

   The obvious answer is a virtualized list. I built one, and then
   threw it away, because virtualization here is a pile of feedback
   loops: spacer heights are derived from measured heights, measured
   heights depend on what is mounted, what is mounted depends on
   scroll position, and scroll position depends on spacer heights.
   Every fix moves the seam somewhere else, the scrollbar lies, and
   find-in-page only searches the fifty paragraphs that happen to be
   mounted.

   Two mechanisms do the job with none of that:

   1. `content-visibility: auto` on every passage. The whole document
      is in the DOM - so the scrollbar is exact, native scrolling is
      native, and browser find-in-page searches all nine hundred
      pages - but the browser skips layout, paint and hit-testing for
      anything off screen. `contain-intrinsic-size: auto` makes it
      remember each passage's real height once measured, so nothing
      jumps when you scroll back.

   2. Re-render isolation. The highlight cursor moves up to eight
      times a second. If the list owned that state, every tick would
      reconcile the entire document. Instead the list subscribes only
      to the *passage* index, which changes every twenty seconds or
      so, and exactly one component - `ActivePassage` - subscribes to
      the cursor. A word boundary re-renders one paragraph.
   ──────────────────────────────────────────────────────────────── */

import { memo, useCallback, useEffect, useRef } from "react";
import { useStore } from "@/lib/store";
import type { Chunk } from "@/lib/types";

export function Reader() {
  const doc = useStore((s) => s.doc);
  const chunkIndex = useStore((s) => s.player.chunkIndex);
  const followCursor = useStore((s) => s.followCursor);
  const focusMode = useStore((s) => s.focusMode);
  const fontScale = useStore((s) => s.fontScale);
  const narrator = useStore((s) => s.narrator);

  const scroller = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLParagraphElement>(null);
  /** Suppresses follow-scroll while the reader is scrolling by hand. */
  const userScrolledAt = useRef(0);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [doc?.id]);

  /* Follow the narrator, unless the reader is deliberately scrolling. */
  useEffect(() => {
    if (!followCursor) return;
    if (performance.now() - userScrolledAt.current < 3200) return;
    const el = activeRef.current;
    const container = scroller.current;
    if (!el || !container) return;

    const box = el.getBoundingClientRect();
    const view = container.getBoundingClientRect();
    // Park the active passage a third of the way down: reading position, not
    // dead centre, so the eye has upcoming text in view.
    const target = view.top + view.height * 0.34;
    const delta = box.top - target;
    if (Math.abs(delta) < 12) return;
    container.scrollBy({
      top: delta,
      behavior: Math.abs(delta) > view.height * 2 ? "auto" : "smooth",
    });
  }, [chunkIndex, followCursor]);

  const onScroll = useCallback(() => {
    userScrolledAt.current = performance.now();
  }, []);

  const jump = useCallback((index: number) => narrator.jump(index), [narrator]);

  if (!doc) return null;

  return (
    <div
      ref={scroller}
      onScroll={onScroll}
      className={`scroll-fine relative h-full overflow-y-auto ${focusMode ? "focus-dim" : ""}`}
    >
      <div className="mx-auto max-w-[74ch] px-4 pt-8 pb-[42vh] sm:px-10 sm:pt-10">
        <DocumentHeader />

        <div
          className="font-serif"
          style={{
            // Scales down on a narrow screen so a phone gets a line of prose
            // rather than four words, and the reader's own size preference
            // still multiplies whatever the viewport settled on.
            fontSize: `calc(${fontScale} * clamp(0.98rem, 0.9rem + 0.55vw, 1.115rem))`,
            lineHeight: 1.72,
            letterSpacing: "-0.003em",
          }}
        >
          {doc.chunks.map((chunk) =>
            chunk.index === chunkIndex ? (
              <ActivePassage key={chunk.id} ref={activeRef} chunk={chunk} onSelect={jump} />
            ) : (
              <Passage
                key={chunk.id}
                chunk={chunk}
                read={chunk.index < chunkIndex}
                onSelect={jump}
              />
            ),
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Document header ────────────────────────────────────────── */

/** What the parser called the source, in words a reader would use. */
const KIND_LABEL: Record<string, string> = {
  pdf: "PDF",
  epub: "EPUB",
  txt: "Text",
  md: "Markdown",
  html: "Web page",
  paste: "Pasted text",
  captions: "Transcript",
};

function DocumentHeader() {
  const doc = useStore((s) => s.doc);
  if (!doc) return null;
  const title = doc.meta.title ?? doc.name.replace(/\.[^.]+$/, "");
  return (
    <header className="animate-rise mb-10">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] font-semibold tracking-[0.09em] text-ink-400 uppercase">
        <span className="rounded-md border border-[var(--hairline)] px-2 py-0.5">
          {KIND_LABEL[doc.kind] ?? doc.kind}
        </span>
        {doc.meta.pages && <span>{doc.meta.pages.toLocaleString()} pages</span>}
        <span>{doc.meta.words.toLocaleString()} words</span>
        <span>{doc.chunks.length.toLocaleString()} passages</span>
      </div>
      <h1 className="font-serif text-[clamp(1.9rem,3.6vw,2.7rem)] leading-[1.14] font-semibold tracking-tight text-balance text-ink-100">
        {title}
      </h1>
      {doc.meta.author && (
        <p className="mt-2 font-serif text-[15px] text-ink-300 italic">by {doc.meta.author}</p>
      )}
      {doc.meta.warnings.length > 0 && (
        <div className="mt-5 rounded-xl border border-[color-mix(in_oklab,var(--color-ember-500)_35%,transparent)] bg-[color-mix(in_oklab,var(--color-ember-500)_9%,transparent)] px-4 py-3">
          {doc.meta.warnings.map((w, i) => (
            <p key={i} className="font-sans text-[12.5px] leading-relaxed text-ember-400">
              {w}
            </p>
          ))}
        </div>
      )}
      <div className="mt-8 h-px bg-gradient-to-r from-[var(--hairline-strong)] to-transparent" />
    </header>
  );
}

/* ── Passages ───────────────────────────────────────────────── */

const PASSAGE_CLASS = "passage relative my-1 cursor-default px-4 py-2 whitespace-pre-wrap";

/**
 * Rough height hint for a passage that has not been laid out yet, so the
 * scrollbar is proportional on first paint. `auto` in `contain-intrinsic-size`
 * means the browser replaces this with the real height the first time the
 * passage is rendered, and remembers it afterwards.
 */
function intrinsicHeight(chunk: Chunk): string {
  const lines = Math.max(1, Math.ceil(chunk.text.length / 74));
  return `auto ${lines * 31 + 24}px`;
}

/**
 * An inactive passage. Memoized on the only two things that can change while
 * it is on screen, so a word-boundary tick never touches it.
 */
const Passage = memo(function Passage({
  chunk,
  read,
  onSelect,
}: {
  chunk: Chunk;
  read: boolean;
  onSelect: (index: number) => void;
}) {
  return (
    <p
      data-chunk={chunk.index}
      onDoubleClick={() => onSelect(chunk.index)}
      title="Double-click to start reading here"
      className={`${PASSAGE_CLASS} ${read ? "passage-read" : "passage-idle"}`}
      style={{ contentVisibility: "auto", containIntrinsicSize: intrinsicHeight(chunk) }}
    >
      {chunk.text}
    </p>
  );
});

/**
 * The passage being spoken. The only component in the app subscribed to the
 * cursor, and therefore the only one that re-renders at word rate.
 *
 * It deliberately does *not* set `content-visibility`: it is on screen by
 * definition, and skipping the containment keeps `scrollIntoView` maths and
 * the follow-scroll measurement exact.
 */
function ActivePassage({
  chunk,
  onSelect,
  ref,
}: {
  chunk: Chunk;
  onSelect: (index: number) => void;
  ref?: React.Ref<HTMLParagraphElement>;
}) {
  const cursor = useStore((s) => s.player.cursor);
  const cursorLength = useStore((s) => s.player.cursorLength);
  const speaking = useStore((s) => s.player.status === "playing");

  return (
    <p
      ref={ref}
      data-chunk={chunk.index}
      onDoubleClick={() => onSelect(chunk.index)}
      title="Double-click to start reading here"
      className={`${PASSAGE_CLASS} passage-active`}
    >
      {speaking && (
        <span aria-hidden className="eq absolute top-3.5 -left-7 hidden text-iris-400 lg:flex">
          <span /><span /><span /><span /><span />
        </span>
      )}
      <HighlightedText chunk={chunk} cursor={cursor} cursorLength={cursorLength} />
    </p>
  );
}

/**
 * Split the passage into: text already spoken, the active sentence, the
 * active word inside it, and the remainder. At most five nodes, so a boundary
 * tick mutates a handful of text nodes rather than reflowing a paragraph made
 * of one span per word.
 */
function HighlightedText({
  chunk,
  cursor,
  cursorLength,
}: {
  chunk: Chunk;
  cursor: number;
  cursorLength: number;
}) {
  const local = cursor - chunk.start;
  if (cursor < 0 || local < 0 || local > chunk.text.length) return <>{chunk.text}</>;

  const wordEnd = Math.min(chunk.text.length, local + Math.max(1, cursorLength));
  const sentence =
    chunk.sentences.find((s) => local >= s.start && local < s.end) ??
    { start: 0, end: chunk.text.length };

  const before = chunk.text.slice(0, sentence.start);
  const sentenceHead = chunk.text.slice(sentence.start, local);
  const word = chunk.text.slice(local, wordEnd);
  const sentenceTail = chunk.text.slice(wordEnd, sentence.end);
  const after = chunk.text.slice(sentence.end);

  return (
    <>
      {before}
      <span className="sentence-active">
        {sentenceHead}
        {word && <span className="word-active">{word}</span>}
        {sentenceTail}
      </span>
      {after}
    </>
  );
}
