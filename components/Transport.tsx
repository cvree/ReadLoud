"use client";
/* ────────────────────────────────────────────────────────────────
   The transport bar. Play/pause, skip, scrub, rate, volume.

   The scrubber deserves a note: while you drag it we show your drag
   position but do not seek, because seeking means cancelling and
   restarting an utterance, and doing that 60 times a second makes the
   speech engine stutter and eventually wedge. We commit the seek on
   pointer-up. The passage under the pointer is previewed in a tooltip
   during the drag, so you can find your place without hearing it.
   ──────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useRef, useState } from "react";
import { useStore, primeAudio } from "@/lib/store";
import { formatClock } from "@/lib/audio/pipeline";
import { Button, Slider } from "./ui/Primitives";
import {
  Back15, Bolt, Download, Focus, Forward15, Pause, Play, SkipBack, SkipForward,
  Volume, VolumeMute,
} from "./ui/Icons";

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** Shown once, ever, to whoever has not pressed play here before. */
const HINT_KEY = "readloud.hint.play.v1";

export function Transport() {
  const doc = useStore((s) => s.doc);
  // Deliberately field-by-field rather than `s.player`: that object is
  // recreated on every word boundary, so subscribing to it would re-render
  // the entire transport bar eight times a second for a clock that ticks
  // once a second.
  const status = useStore((s) => s.player.status);
  const chunkIndex = useStore((s) => s.player.chunkIndex);
  const rawPosition = useStore((s) => Math.round(s.player.position * 2) / 2);
  const rawDuration = useStore((s) => s.player.duration);
  const playerError = useStore((s) => s.player.error);
  const narrator = useStore((s) => s.narrator);
  const rate = useStore((s) => s.rate);
  const setRate = useStore((s) => s.setRate);
  const volume = useStore((s) => s.volume);
  const setVolume = useStore((s) => s.setVolume);
  const focusMode = useStore((s) => s.focusMode);
  const setFocusMode = useStore((s) => s.setFocusMode);
  const setExportOpen = useStore((s) => s.setExportOpen);

  const [scrub, setScrub] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const lastVolume = useRef(volume);

  /* The speed menu used to open on hover only, which meant it could not be
     opened by touch at all and not by keyboard either. Click to open. */
  const [speedOpen, setSpeedOpen] = useState(false);
  const speedRoot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!speedOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!speedRoot.current?.contains(e.target as Node)) setSpeedOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSpeedOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [speedOpen]);

  /* A first-timer looking at a wall of text and a play button does not know
     that the spacebar works. Say so once, then never again. */
  const [hint, setHint] = useState(false);
  const toastCount = useStore((s) => s.toasts.length);
  useEffect(() => {
    // No spacebar on a touch device, and the play button is right there
    // under the thumb — the hint would be noise rather than help.
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    try {
      if (!localStorage.getItem(HINT_KEY)) setHint(true);
    } catch {
      /* private browsing: no hint rather than a hint on every load */
    }
  }, []);
  const dismissHint = useCallback(() => {
    setHint(false);
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      /* ignore */
    }
  }, []);

  // The timeline starts as a words-per-minute estimate and is replaced with
  // measured durations as passages are heard. Say which one you are looking at
  // rather than presenting a guess as a fact.
  const estimated = narrator.timelineConfidence < 0.9;

  const playing = status === "playing";
  const busy = status === "buffering";
  const position = scrub ?? rawPosition;
  const duration = rawDuration || 1;

  const onPlay = useCallback(async () => {
    dismissHint();
    // Safari and Chrome both require a gesture before audio may start.
    await primeAudio();
    narrator.toggle();
  }, [narrator, dismissHint]);

  /* Keyboard shortcuts. Skipped while typing in an input. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          void onPlay();
          break;
        case "ArrowRight":
          e.preventDefault();
          e.shiftKey ? narrator.next() : narrator.nudge(15);
          break;
        case "ArrowLeft":
          e.preventDefault();
          e.shiftKey ? narrator.previous() : narrator.nudge(-15);
          break;
        case "ArrowUp":
          e.preventDefault();
          setVolume(Math.min(1, volume + 0.1));
          break;
        case "ArrowDown":
          e.preventDefault();
          setVolume(Math.max(0, volume - 0.1));
          break;
        case "j":
          narrator.nudge(-30);
          break;
        case "l":
          narrator.nudge(30);
          break;
        case "k":
          void onPlay();
          break;
        case "f":
          setFocusMode(!focusMode);
          break;
        case "[": {
          const i = RATES.findIndex((r) => r >= rate);
          setRate(RATES[Math.max(0, i - 1)]);
          break;
        }
        case "]": {
          const i = RATES.findIndex((r) => r >= rate);
          setRate(RATES[Math.min(RATES.length - 1, i + 1)]);
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [narrator, onPlay, rate, setRate, volume, setVolume, focusMode, setFocusMode]);

  if (!doc) return null;

  const scrubChunk = scrub !== null
    ? doc.chunks[Math.min(doc.chunks.length - 1, Math.max(0, indexAtTime(doc.chunks, scrub, rate)))]
    : null;

  const toggleMute = () => {
    if (muted) {
      setVolume(lastVolume.current || 1);
      setMuted(false);
    } else {
      lastVolume.current = volume;
      setVolume(0);
      setMuted(true);
    }
  };

  return (
    <div className="glass-strong relative z-20 shrink-0 rounded-t-2xl">
      {/* Scrub track */}
      <div className="relative px-4 pt-3 sm:px-5">
        {scrubChunk && (
          <div
            className="glass-strong animate-fade pointer-events-none absolute -top-16 z-30 max-w-sm rounded-xl px-3 py-2"
            style={{
              left: `clamp(1rem, ${(position / duration) * 100}%, calc(100% - 1rem))`,
              transform: "translateX(-50%)",
            }}
          >
            <div className="text-[10px] font-semibold tracking-wide text-iris-400 uppercase">
              {scrubChunk.sectionTitle}
            </div>
            <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-ink-200">
              {scrubChunk.text.slice(0, 120)}
            </div>
          </div>
        )}
        <Slider
          aria-label="Seek"
          value={position}
          min={0}
          max={duration}
          step={0.5}
          onChange={setScrub}
          onCommit={(v) => {
            narrator.seekTime(v);
            setScrub(null);
          }}
        />
        <div className="mt-1.5 flex items-center justify-between text-[11px] font-medium text-ink-400">
          <span className="tabular">{formatClock(position)}</span>
          <span className="truncate px-3 text-center text-ink-300">
            {doc.chunks[chunkIndex]?.sectionTitle ?? ""}
          </span>
          <span
            className="tabular"
            title={
              estimated
                ? "Estimated from word count. Replaced with the real duration as each passage is heard."
                : "Measured from the rendered audio."
            }
          >
            {estimated ? "~" : ""}
            {formatClock(Math.max(0, duration - position))} left
          </span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-1.5 px-3 pt-1 pb-4 sm:gap-2 sm:px-5">
        {/* Left: position in the document */}
        <div className="flex flex-1 items-center gap-2">
          <Button
            variant="bare"
            size="icon"
            onClick={() => narrator.jump(0)}
            title="Back to start"
            aria-label="Back to start"
            className="hidden sm:inline-flex"
          >
            <SkipBack width={16} height={16} />
          </Button>
          <span className="tabular hidden text-[11.5px] text-ink-500 sm:inline">
            Passage {(chunkIndex + 1).toLocaleString()} of{" "}
            {doc.chunks.length.toLocaleString()}
          </span>
        </div>

        {/* Centre: the transport proper */}
        <div className="flex items-center gap-1.5">
          <Button
            variant="bare"
            size="icon"
            onClick={() => narrator.previous()}
            title="Previous passage (Shift+Left)"
            aria-label="Previous passage"
            className="hidden sm:inline-flex"
          >
            <SkipBack width={18} height={18} />
          </Button>
          <Button variant="bare" size="icon" onClick={() => narrator.nudge(-15)} title="Back 15 seconds (Left)">
            <Back15 width={20} height={20} />
          </Button>

          <div className="relative mx-1">
            {hint && status === "idle" && toastCount === 0 && (
              <div className="animate-rise glass-strong pointer-events-none absolute bottom-full left-1/2 mb-3 w-max max-w-[70vw] -translate-x-1/2 rounded-xl px-3 py-2 text-center">
                <div className="text-[12px] font-medium text-ink-100">
                  Press play — or just hit space
                </div>
                <div className="mt-0.5 text-[11px] text-ink-400">
                  The neural voice downloads once, then works offline.
                </div>
              </div>
            )}
            <button
              onClick={onPlay}
              aria-label={playing ? "Pause" : "Play"}
              className={`ring-focus btn btn-primary rounded-full ${busy ? "pulse-ring" : ""}`}
              style={{ height: 52, width: 52 }}
            >
              {playing ? <Pause width={20} height={20} /> : <Play width={20} height={20} />}
            </button>
          </div>

          <Button variant="bare" size="icon" onClick={() => narrator.nudge(15)} title="Forward 15 seconds (Right)">
            <Forward15 width={20} height={20} />
          </Button>
          <Button
            variant="bare"
            size="icon"
            onClick={() => narrator.next()}
            title="Next passage (Shift+Right)"
            aria-label="Next passage"
            className="hidden sm:inline-flex"
          >
            <SkipForward width={18} height={18} />
          </Button>
        </div>

        {/* Right: output settings */}
        <div className="flex flex-1 items-center justify-end gap-1">
          <div ref={speedRoot} className="relative">
            <Button
              variant="ghost"
              size="sm"
              className="tabular w-[62px] gap-1"
              onClick={() => setSpeedOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={speedOpen}
              title="Playback speed ([ and ])"
            >
              <Bolt width={12} height={12} className="text-ember-500" />
              {rate}x
            </Button>
            {speedOpen && (
              <div
                role="menu"
                className="glass-strong animate-fade absolute right-0 bottom-full z-40 mb-2 flex flex-col gap-0.5 rounded-xl p-1"
              >
                {RATES.map((r) => (
                  <button
                    key={r}
                    role="menuitemradio"
                    aria-checked={r === rate}
                    onClick={() => {
                      setRate(r);
                      setSpeedOpen(false);
                    }}
                    className={`ring-focus tabular rounded-lg px-3 py-1.5 text-left text-[12.5px] transition-colors ${
                      r === rate
                        ? "bg-[color-mix(in_oklab,var(--color-iris-500)_28%,transparent)] text-white"
                        : "text-ink-300 hover:bg-[color-mix(in_oklab,white_8%,transparent)]"
                    }`}
                  >
                    {r}x
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="hidden items-center gap-1.5 sm:flex">
            <Button variant="bare" size="icon" onClick={toggleMute} title="Mute (Up/Down to adjust)">
              {volume === 0 ? <VolumeMute width={17} height={17} /> : <Volume width={17} height={17} />}
            </Button>
            <Slider
              aria-label="Volume"
              className="w-20"
              value={volume}
              min={0}
              max={1}
              step={0.02}
              onChange={(v) => {
                setVolume(v);
                setMuted(v === 0);
              }}
            />
          </div>

          <div className="mx-1.5 hidden h-6 w-px bg-[var(--hairline)] sm:block" />

          <Button
            variant="bare"
            size="icon"
            onClick={() => setFocusMode(!focusMode)}
            title="Focus mode (F)"
            aria-label="Focus mode"
            aria-pressed={focusMode}
            className={`hidden sm:inline-flex ${focusMode ? "text-iris-400" : ""}`}
          >
            <Focus width={18} height={18} />
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setExportOpen(true)}
            className="gap-1.5"
            title="Export an MP3 or a transcript"
            aria-label="Export an MP3 or a transcript"
          >
            <Download width={15} height={15} />
            <span className="hidden md:inline">Export</span>
          </Button>
        </div>
      </div>

      {playerError && (
        <div className="hairline-t px-5 py-2 text-[12px] text-rose-500">{playerError}</div>
      )}
    </div>
  );
}

/** Mirror of the engine's seek maths, for the scrub preview tooltip. */
function indexAtTime(
  chunks: Array<{ estSeconds: number }>,
  seconds: number,
  rate: number,
): number {
  let acc = 0;
  const target = seconds * rate;
  for (let i = 0; i < chunks.length; i++) {
    acc += chunks[i].estSeconds;
    if (acc > target) return i;
  }
  return chunks.length - 1;
}
