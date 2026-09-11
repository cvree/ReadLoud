"use client";
/* ────────────────────────────────────────────────────────────────
   App shell. Owns layout, the top bar, theme, and the panel state
   that everything else reads from the store.
   ──────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { resetSpeechQueue } from "@/lib/tts/webspeech";
import { installDevtools } from "@/lib/devtools";
import { formatClock } from "@/lib/audio/pipeline";
import { Landing } from "./Landing";
import { Reader } from "./Reader";
import { Outline } from "./Outline";
import { VoiceStudio } from "./VoiceStudio";
import { Transport } from "./Transport";
import { ExportDialog } from "./ExportDialog";
import { HandoffBridge } from "./HandoffBridge";
import { Toaster } from "./Toaster";
import { Button } from "./ui/Primitives";
import {
  Book, Keyboard, List, Moon, Sliders, Sun, Trash, Waveform,
} from "./ui/Icons";

export function Workspace() {
  const doc = useStore((s) => s.doc);
  const initProviders = useStore((s) => s.initProviders);
  const reset = useStore((s) => s.reset);
  const narrator = useStore((s) => s.narrator);
  // Only the total duration is needed here; subscribing to `s.player` would
  // re-render the whole shell on every word boundary.
  const playerDuration = useStore((s) => s.player.duration);
  const rate = useStore((s) => s.rate);

  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [shortcuts, setShortcuts] = useState(false);

  /* Discover which providers actually have keys, then load their voices. */
  useEffect(() => {
    void initProviders();
  }, [initProviders]);

  /* A reload while speaking leaves Chrome's queue in a bad state, and an
     utterance can outlive the page. Clear it on both edges. */
  useEffect(() => {
    resetSpeechQueue();
    const onUnload = () => resetSpeechQueue();
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      // Stop audio, but never `destroy()` the narrator here: the store owns it
      // for the lifetime of the tab, and React Strict Mode runs this cleanup
      // between its two development mounts. Destroying it there would detach
      // the store subscription permanently and freeze every readout.
      narrator.stop();
      resetSpeechQueue();
    };
  }, [narrator]);

  /* Console handles for poking the pipeline in development. */
  useEffect(() => {
    installDevtools(() => useStore.getState());
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem("readloud.theme");
    const next = stored === "light" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      localStorage.setItem("readloud.theme", next);
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (e.key === "?") setShortcuts((v) => !v);
      if (e.key === "Escape") setShortcuts(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden">
      <div className="aurora"><i /></div>
      <div className="grain" />

      {/* Top bar */}
      <header className="glass relative z-30 flex h-14 shrink-0 items-center gap-3 rounded-b-2xl px-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-iris-500 to-aqua-500 shadow-md">
            <Waveform width={17} height={17} className="text-white" />
          </div>
          <div className="leading-none">
            <div className="text-[14.5px] font-semibold tracking-tight text-ink-100">
              Read<span className="grad-text">Loud</span>
            </div>
          </div>
        </div>

        {doc && (
          <>
            <div className="mx-1 h-6 w-px bg-[var(--hairline)]" />
            <div className="hidden min-w-0 flex-1 items-baseline gap-2.5 md:flex">
              <span className="truncate text-[13px] font-medium text-ink-200">
                {doc.meta.title ?? doc.name}
              </span>
              <span className="tabular shrink-0 text-[11.5px] text-ink-500">
                {formatClock(playerDuration || doc.meta.estSeconds / rate)}
              </span>
            </div>
          </>
        )}

        <div className="ml-auto flex items-center gap-1">
          {doc && (
            <>
              <Button
                variant="bare"
                size="icon"
                onClick={() => setLeftOpen((v) => !v)}
                title="Toggle outline"
                className={`hidden lg:inline-flex ${leftOpen ? "text-ink-100" : ""}`}
              >
                <List width={17} height={17} />
              </Button>
              <Button
                variant="bare"
                size="icon"
                onClick={() => setRightOpen((v) => !v)}
                title="Toggle voice studio"
                className={`hidden lg:inline-flex ${rightOpen ? "text-ink-100" : ""}`}
              >
                <Sliders width={17} height={17} />
              </Button>
              <div className="mx-1 hidden h-6 w-px bg-[var(--hairline)] lg:block" />
            </>
          )}
          <Button
            variant="bare"
            size="icon"
            onClick={() => setShortcuts(true)}
            title="Keyboard shortcuts (?)"
          >
            <Keyboard width={17} height={17} />
          </Button>
          <Button variant="bare" size="icon" onClick={toggleTheme} title="Toggle theme">
            {theme === "dark" ? <Sun width={17} height={17} /> : <Moon width={17} height={17} />}
          </Button>
          {doc && (
            <Button variant="bare" size="icon" onClick={reset} title="Close document">
              <Trash width={17} height={17} />
            </Button>
          )}
        </div>
      </header>

      {/* Body */}
      <main className="relative z-10 flex min-h-0 flex-1 gap-3 p-3">
        {!doc ? (
          <div className="glass min-h-0 flex-1 overflow-hidden rounded-2xl">
            <Landing />
          </div>
        ) : (
          <>
            <aside
              className={`glass hidden min-h-0 shrink-0 overflow-hidden rounded-2xl transition-all duration-300 lg:block ${
                leftOpen ? "w-[268px] opacity-100" : "pointer-events-none w-0 opacity-0"
              }`}
              style={{ transitionTimingFunction: "var(--ease-out-soft)" }}
            >
              <Outline />
            </aside>

            <section className="glass min-w-0 flex-1 overflow-hidden rounded-2xl">
              <Reader />
            </section>

            <aside
              className={`glass hidden min-h-0 shrink-0 overflow-hidden rounded-2xl transition-all duration-300 lg:block ${
                rightOpen ? "w-[312px] opacity-100" : "pointer-events-none w-0 opacity-0"
              }`}
              style={{ transitionTimingFunction: "var(--ease-out-soft)" }}
            >
              <VoiceStudio />
            </aside>
          </>
        )}
      </main>

      {doc && (
        <div className="relative z-20 px-3 pb-0">
          <Transport />
        </div>
      )}

      <ExportDialog />
      <HandoffBridge />
      <Toaster />
      {shortcuts && <Shortcuts onClose={() => setShortcuts(false)} />}
    </div>
  );
}

const KEYS: Array<[string, string]> = [
  ["Space / K", "Play or pause"],
  ["Left / Right", "Back or forward 15 seconds"],
  ["Shift + Left / Right", "Previous or next passage"],
  ["J / L", "Back or forward 30 seconds"],
  ["Up / Down", "Volume"],
  ["[ / ]", "Slower or faster"],
  ["F", "Focus mode"],
  ["Double-click a passage", "Start reading from there"],
  ["?", "This panel"],
];

function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center p-4">
      <div className="animate-fade absolute inset-0 bg-black/65 backdrop-blur-sm" onClick={onClose} />
      <div className="glass-strong animate-rise relative w-full max-w-md rounded-2xl p-6">
        <div className="mb-4 flex items-center gap-2.5">
          <Keyboard width={18} height={18} className="text-iris-400" />
          <h2 className="text-[16px] font-semibold text-ink-100">Keyboard</h2>
        </div>
        <dl className="space-y-0.5">
          {KEYS.map(([key, action]) => (
            <div
              key={key}
              className="flex items-center justify-between gap-4 rounded-lg px-2 py-2 transition-colors hover:bg-[color-mix(in_oklab,white_5%,transparent)]"
            >
              <dt className="text-[12.5px] text-ink-300">{action}</dt>
              <dd className="shrink-0 rounded-md border border-[var(--hairline)] bg-[var(--field)] px-2 py-1 font-mono text-[11px] text-ink-200">
                {key}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 flex items-center gap-1.5 text-[11.5px] text-ink-500">
          <Book width={12} height={12} />
          Shortcuts are ignored while a text field has focus.
        </p>
      </div>
    </div>
  );
}
