"use client";
/* ────────────────────────────────────────────────────────────────
   Reading mode — one word at a time, on the spot where your eye
   already is.

   A full-bleed overlay rather than a panel, because RSVP's premise is
   that nothing else is on screen: a word in a sidebar is just a small
   highlight. The scrolling reader stays mounted behind it, keeps
   following the cursor, and is exactly where `Esc` puts you back —
   on the same word, because both renderers read the same
   `NarratorState.cursor`.

   Two things this does that the category does not:

     * **Voice-synced mode.** Spreeder, Spritz, Reedy and the rest show
       you words in silence. The main documented cost of RSVP is
       comprehension, and the main reason is that it strips prosody —
       so here the voice can run underneath the words and hand it back.
     * **It tells you the truth about speed.** The dial is normalized
       (see `lib/rsvp/pacing.ts`), so 600 wpm is 600 wpm; the ceiling
       is 1200 rather than the 2000 competitors advertise and cannot
       deliver; and the note under the dial says plainly that above
       ~500 wpm there is a comprehension cost on unfamiliar material.

   Motion, deliberately: words *cut*, they do not fade, slide or
   scale. A transition smears the glyph during the exact 90 ms you
   need to read it, and a repeating opacity animation at 600 wpm is a
   10 Hz luminance change — squarely in photosensitivity territory.
   ──────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { primeAudio, useStore, type RsvpMode } from "@/lib/store";
import { getProvider } from "@/lib/tts/registry";
import { tokenize, tokenIndexAt, type RsvpToken } from "@/lib/rsvp/tokenize";
import {
  WPM_COMPREHENSION_EDGE,
  WPM_QUANTIZED_ABOVE,
  WPM_RANGE,
} from "@/lib/rsvp/pacing";
import { rateToWpm } from "@/lib/rsvp/pacer";
import { BASE_WPM } from "@/lib/text/normalize";
import { formatClock } from "@/lib/audio/pipeline";
import { Button, Segmented, Slider, Switch } from "./ui/Primitives";
import {
  Close, Pause, Play, Rewind, SkipBack, SkipForward, Sparkle, WordBack, WordForward,
} from "./ui/Icons";

/** How many words `Backspace` goes back. */
const REPLAY_WORDS = 10;
/** Mirrors `REPLAY_SCALE` in the store, for the label that mentions it. */
const REPLAY_PERCENT = 70;
/**
 * A step in voice mode cancels and re-synthesizes, so held arrow keys are
 * collected and committed once the reader stops pressing.
 */
const VOICE_STEP_SETTLE_MS = 220;

export function Rsvp() {
  const enabled = useStore((s) => s.rsvp.enabled);
  const doc = useStore((s) => s.doc);
  if (!enabled || !doc) return null;
  return <Overlay />;
}

function Overlay() {
  const doc = useStore((s) => s.doc)!;
  const narrator = useStore((s) => s.narrator);
  const chunkIndex = useStore((s) => s.player.chunkIndex);
  const cursor = useStore((s) => s.player.cursor);
  const status = useStore((s) => s.player.status);
  const position = useStore((s) => Math.round(s.player.position));
  const duration = useStore((s) => s.player.duration);
  const mode = useStore((s) => s.rsvp.mode);
  const wpm = useStore((s) => s.rsvp.wpm);
  const ribbon = useStore((s) => s.rsvp.ribbon);
  const replaying = useStore((s) => s.rsvp.replaying);
  const voiceRate = useStore((s) => s.rate);
  const providerId = useStore((s) => s.providerId);
  const setRate = useStore((s) => s.setRate);
  const setRsvpEnabled = useStore((s) => s.setRsvpEnabled);
  const setRsvpMode = useStore((s) => s.setRsvpMode);
  const setRsvpWpm = useStore((s) => s.setRsvpWpm);
  const setRsvpRibbon = useStore((s) => s.setRsvpRibbon);
  const startReplay = useStore((s) => s.startReplay);
  const endReplay = useStore((s) => s.endReplay);

  const chunk = doc.chunks[chunkIndex];

  /* Tokens for the passage on screen. One passage at a time, memoized on its
     id: tokenizing a 900-page book up front would cost 30 MB to display one
     word. */
  const tokens = useMemo(
    () => (chunk ? tokenize(chunk.text, chunk.start) : []),
    [chunk],
  );

  /**
   * A step the reader has made but that has not been committed to the engine
   * yet. Voice mode collects them; silent mode commits immediately.
   */
  const [pending, setPending] = useState<number | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Where a replay has to catch up to before the rate goes back up. */
  const replayTarget = useRef<number | null>(null);

  const displayChar = pending ?? cursor;
  const tokenIdx = displayChar >= 0 ? tokenIndexAt(tokens, displayChar) : -1;
  const token: RsvpToken | undefined = tokenIdx >= 0 ? tokens[tokenIdx] : undefined;

  useEffect(() => {
    return () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    };
  }, []);

  /* End a replay once it has read back up to where it started. */
  useEffect(() => {
    if (!replaying || replayTarget.current === null) return;
    if (cursor >= replayTarget.current) {
      replayTarget.current = null;
      endReplay();
    }
  }, [cursor, replaying, endReplay]);

  /* `requestAnimationFrame` stops in a hidden tab, so the pacer's clock stops
     with it. That is correct — no word is skipped — but coming back to a
     display that had been frozen mid-sentence for an hour is not, so silent
     mode pauses outright. Voice mode deliberately keeps playing: listening
     with the tab in the background is the point. */
  useEffect(() => {
    if (mode !== "silent") return;
    const onVisibility = () => {
      if (document.hidden) narrator.pause();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [mode, narrator]);

  const commit = useCallback(
    (absolute: number) => {
      if (mode === "silent") {
        setPending(null);
        narrator.seekChar(absolute);
        return;
      }
      // Voice mode: show the word now, seek once the keys stop moving. The
      // pending value is dropped the moment the engine has been told, so the
      // display can never get stuck on a word the provider did not honor —
      // Web Speech cannot resume mid-passage, and showing its real position is
      // better than showing a comfortable fiction.
      setPending(absolute);
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => {
        narrator.seekChar(absolute);
        setPending(null);
      }, VOICE_STEP_SETTLE_MS);
    },
    [mode, narrator],
  );

  /** Step `delta` words, crossing passage boundaries when it has to. */
  const step = useCallback(
    (delta: number) => {
      if (!chunk || tokens.length === 0) return;
      const here = tokenIdx < 0 ? 0 : tokenIdx;
      const target = here + delta;

      if (target < 0) {
        const prev = doc.chunks[chunkIndex - 1];
        if (!prev) return commit(tokens[0].start);
        const prevTokens = tokenize(prev.text, prev.start);
        const landing = prevTokens[Math.max(0, prevTokens.length + target)];
        return commit(landing?.start ?? prev.start);
      }
      if (target >= tokens.length) {
        const next = doc.chunks[chunkIndex + 1];
        if (!next) return commit(tokens[tokens.length - 1].start);
        const nextTokens = tokenize(next.text, next.start);
        const landing = nextTokens[Math.min(nextTokens.length - 1, target - tokens.length)];
        return commit(landing?.start ?? next.start);
      }
      commit(tokens[target].start);
    },
    [chunk, tokens, tokenIdx, doc.chunks, chunkIndex, commit],
  );

  /** Sentence-granularity regression: back to the top of this sentence. */
  const stepSentence = useCallback(
    (direction: -1 | 1) => {
      if (!chunk) return;
      const local = displayChar - chunk.start;
      const spans = chunk.sentences;
      const at = spans.findIndex((s) => local >= s.start && local < s.end);
      if (direction < 0) {
        // Already at the top of a sentence → go to the one before it.
        const current = spans[at];
        if (current && local > current.start + 1) return commit(chunk.start + current.start);
        const prev = spans[at - 1];
        if (prev) return commit(chunk.start + prev.start);
        return narrator.previous();
      }
      const next = spans[at + 1];
      if (next) return commit(chunk.start + next.start);
      return narrator.next();
    },
    [chunk, displayChar, commit, narrator],
  );

  const replay = useCallback(async () => {
    if (!chunk || tokens.length === 0 || tokenIdx < 0) return;
    const from = tokens[Math.max(0, tokenIdx - REPLAY_WORDS)];
    replayTarget.current = tokens[tokenIdx].start;
    setPending(null);
    // A replay plays, so it needs the same gesture-unlocked audio context the
    // play button does — harmless in silent mode, required in voice mode.
    await primeAudio();
    startReplay(from.start);
  }, [chunk, tokens, tokenIdx, startReplay]);

  const toggle = useCallback(async () => {
    await primeAudio();
    narrator.toggle();
  }, [narrator]);

  const nudgeRate = useCallback(
    (deltaWpm: number) => {
      if (mode === "silent") {
        setRsvpWpm(wpm + deltaWpm);
        return;
      }
      // In voice mode the dial is the voice's rate; ±25 wpm in rate terms.
      setRate(voiceRate + deltaWpm / BASE_WPM);
    },
    [mode, wpm, setRsvpWpm, setRate, voiceRate],
  );

  /* ── Keymap ──────────────────────────────────────────────────────
     `Transport` and `Workspace` both early-return while reading mode is
     up, so this owns the keyboard outright rather than fighting listener
     ordering with capture-phase handlers. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          void toggle();
          break;
        case "ArrowLeft":
          e.preventDefault();
          e.shiftKey ? stepSentence(-1) : step(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          e.shiftKey ? stepSentence(1) : step(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          nudgeRate(WPM_RANGE.step);
          break;
        case "ArrowDown":
          e.preventDefault();
          nudgeRate(-WPM_RANGE.step);
          break;
        case "Backspace":
          e.preventDefault();
          void replay();
          break;
        case "Escape":
          e.preventDefault();
          setRsvpEnabled(false);
          break;
        case "r":
        case "R":
          setRsvpEnabled(false);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, step, stepSentence, nudgeRate, replay, setRsvpEnabled]);

  const playing = status === "playing";
  const buffering = status === "buffering";
  /** Whether the chosen voice can actually resume mid-passage. */
  const canResume = getProvider(providerId).capabilities.resume;
  const effective = mode === "silent" ? wpm : Math.round(rateToWpm(voiceRate));
  const total = doc.chunks.length;

  /* The sentence under the word. The single largest comprehension lever
     available, and it costs one paragraph: the spans are already on the
     chunk. */
  const sentence = useMemo(() => {
    if (!chunk || !ribbon || displayChar < 0) return null;
    const local = displayChar - chunk.start;
    const span =
      chunk.sentences.find((s) => local >= s.start && local < s.end) ??
      (chunk.sentences.length ? chunk.sentences[0] : { start: 0, end: chunk.text.length });
    return {
      before: chunk.text.slice(span.start, Math.max(span.start, local)),
      word: chunk.text.slice(Math.max(span.start, local), Math.min(span.end, local + (token?.text.length ?? 0))),
      after: chunk.text.slice(Math.min(span.end, local + (token?.text.length ?? 0)), span.end),
    };
  }, [chunk, ribbon, displayChar, token]);

  return (
    <div className="rsvp-veil animate-fade" role="dialog" aria-modal="true" aria-label="Reading mode">
      {/* Top bar: where you are, and the way out. */}
      <header className="flex shrink-0 items-center gap-3 px-4 pt-4 sm:px-6">
        <div className="min-w-0">
          <div className="truncate text-[11px] font-semibold tracking-[0.09em] text-ink-400 uppercase">
            {chunk?.sectionTitle ?? doc.meta.title ?? doc.name}
          </div>
          <div className="tabular mt-0.5 text-[11.5px] text-ink-500">
            Passage {(chunkIndex + 1).toLocaleString()} of {total.toLocaleString()} ·{" "}
            {formatClock(Math.max(0, duration - position))} left
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Segmented<RsvpMode>
            value={mode}
            onChange={setRsvpMode}
            options={[
              { value: "voice", label: "Voice", title: "Words paced by the narration you are hearing" },
              { value: "silent", label: "Silent", title: "Words paced by a clock, with no audio" },
            ]}
          />
          <Button
            variant="bare"
            size="icon"
            onClick={() => setRsvpEnabled(false)}
            title="Back to the reader (Esc)"
            aria-label="Back to the reader"
          >
            <Close width={18} height={18} />
          </Button>
        </div>
      </header>

      {/* The word. */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4">
        <div className="rsvp-rail" aria-hidden />
        <div
          className="rsvp-word"
          /* Never announced: a screen reader must not be fed ten words a
             second. The passage is exposed as prose below instead. */
          aria-live="off"
          aria-hidden
        >
          {token ? (
            <>
              <span className="rsvp-pre">{token.display.slice(0, token.pivot)}</span>
              <span className="rsvp-pivot">{token.display.slice(token.pivot, token.pivot + 1)}</span>
              <span className="rsvp-post">{token.display.slice(token.pivot + 1)}</span>
            </>
          ) : (
            <>
              <span className="rsvp-pre" />
              <span className="rsvp-pivot text-ink-500">·</span>
              <span className="rsvp-post" />
            </>
          )}
        </div>
        <div className="rsvp-rail" aria-hidden />

        {sentence && (
          <p className="rsvp-ribbon">
            {sentence.before}
            <span className="rsvp-ribbon-word">{sentence.word}</span>
            {sentence.after}
          </p>
        )}

        {/* What a screen reader gets instead of the flashing word. */}
        <p className="sr-only">{chunk?.text ?? ""}</p>

        {replaying ? (
          <div className="animate-fade mt-6 text-[11.5px] font-medium text-iris-400">
            Replaying the last {REPLAY_WORDS} words at {REPLAY_PERCENT}% speed
          </div>
        ) : (
          /* Pause is always visible and always one key (WCAG 2.2.2). */
          !playing &&
          !buffering && (
            <div className="mt-6 text-[12px] text-ink-400">Paused — press space</div>
          )
        )}
      </div>

      {/* Progress: a hairline, not a scrubber. The transport bar is one Esc
          away and this is not a screen for dragging. */}
      <div className="px-4 sm:px-6">
        <div className="h-[3px] w-full overflow-hidden rounded-full bg-[color-mix(in_oklab,white_10%,transparent)]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-iris-500 to-aqua-500"
            style={{ width: `${duration > 0 ? Math.min(100, (position / duration) * 100) : 0}%` }}
          />
        </div>
      </div>

      {/* Controls. */}
      <footer className="shrink-0 px-4 pt-4 pb-5 sm:px-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-3">
          <div className="flex items-center justify-center gap-1.5">
            <Button
              variant="bare"
              size="icon"
              onClick={() => stepSentence(-1)}
              title="Back one sentence (Shift+Left)"
              aria-label="Back one sentence"
            >
              <SkipBack width={17} height={17} />
            </Button>
            <Button
              variant="bare"
              size="icon"
              onClick={() => step(-1)}
              title="Back one word (Left)"
              aria-label="Back one word"
            >
              <WordBack width={19} height={19} />
            </Button>
            <button
              onClick={() => void toggle()}
              aria-label={playing ? "Pause" : "Play"}
              className={`ring-focus btn btn-primary mx-1 rounded-full ${buffering ? "pulse-ring" : ""}`}
              style={{ height: 52, width: 52 }}
            >
              {playing ? <Pause width={20} height={20} /> : <Play width={20} height={20} />}
            </button>
            <Button
              variant="bare"
              size="icon"
              onClick={() => step(1)}
              title="Forward one word (Right)"
              aria-label="Forward one word"
            >
              <WordForward width={19} height={19} />
            </Button>
            <Button
              variant="bare"
              size="icon"
              onClick={() => stepSentence(1)}
              title="Forward one sentence (Shift+Right)"
              aria-label="Forward one sentence"
            >
              <SkipForward width={17} height={17} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="ml-2 gap-1.5"
              onClick={() => void replay()}
              title={
                mode === "silent"
                  ? `Replay the last ${REPLAY_WORDS} words at ${REPLAY_PERCENT}% speed (Backspace)`
                  : `Re-read the last ${REPLAY_WORDS} words (Backspace)`
              }
            >
              <Rewind width={14} height={14} />
              Replay
            </Button>
          </div>

          {mode === "silent" ? (
            <div>
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span className="text-[11px] font-semibold tracking-[0.09em] text-ink-400 uppercase">
                  Pace
                </span>
                <span className="tabular text-[12px] text-ink-200">{wpm} wpm</span>
              </div>
              <Slider
                aria-label="Words per minute"
                value={wpm}
                min={WPM_RANGE.min}
                max={WPM_RANGE.max}
                step={WPM_RANGE.step}
                onChange={setRsvpWpm}
              />
              <p className="mt-1.5 text-[11px] leading-snug text-ink-500">
                {wpm > WPM_QUANTIZED_ABOVE
                  ? `Above ${WPM_QUANTIZED_ABOVE} wpm each word lasts fewer than four frames, so timing quantizes to about ±8 ms. `
                  : ""}
                {wpm > WPM_COMPREHENSION_EDGE
                  ? `Past ~${WPM_COMPREHENSION_EDGE} wpm expect a real comprehension cost on unfamiliar material: RSVP raises rate mainly by preventing the regressions that are useful on 10–15% of fixations. Voice mode gives the prosody back.`
                  : "Punctuation-aware: commas, full stops and paragraph ends get longer holds, paid for by the words around them, so the dial means what it says."}
              </p>
            </div>
          ) : (
            <div>
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span className="text-[11px] font-semibold tracking-[0.09em] text-ink-400 uppercase">
                  Voice speed
                </span>
                <span className="tabular text-[12px] text-ink-200">
                  {voiceRate.toFixed(2)}x · ≈{effective} wpm
                </span>
              </div>
              <Slider
                aria-label="Voice speed"
                value={voiceRate}
                min={0.5}
                max={3}
                step={0.05}
                onChange={setRate}
              />
              <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-snug text-ink-500">
                <Sparkle width={12} height={12} className="mt-0.5 shrink-0 text-iris-400" />
                The words are paced by the narration itself, so the ceiling is the
                voice: 3x is about {Math.round(rateToWpm(3))} wpm, and quality drops
                before it. Switch to Silent to go faster than anyone can speak.
              </p>
              {!canResume && (
                <p className="mt-1 text-[11px] leading-snug text-ink-500">
                  {getProvider(providerId).label} cannot start an utterance
                  part-way through, so stepping back a word restarts the passage
                  from its beginning. Kokoro and the silent pacer step exactly.
                </p>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-4">
            <Switch
              checked={ribbon}
              onChange={setRsvpRibbon}
              label="Context ribbon"
              hint="The sentence around the word. Costs a glance; buys back most of the comprehension."
            />
          </div>
        </div>
      </footer>
    </div>
  );
}
