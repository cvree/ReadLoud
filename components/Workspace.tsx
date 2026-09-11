"use client";
/* ────────────────────────────────────────────────────────────────
   App shell. Owns layout, the top bar, theme, the panel state that
   everything else reads from the store, and the two things that have
   to be true everywhere rather than in one screen: you can drop a
   file onto any part of the window, and every panel is reachable on
   a phone.
   ──────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { useIngest } from "@/lib/use-ingest";
import { resetSpeechQueue } from "@/lib/tts/webspeech";
import { installDevtools } from "@/lib/devtools";
import { formatClock } from "@/lib/audio/pipeline";
import { ACCEPTED_FILE_TYPES } from "@/lib/ingest";
import { Landing } from "./Landing";
import { Reader } from "./Reader";
import { Rsvp } from "./Rsvp";
import { Outline } from "./Outline";
import { VoiceStudio } from "./VoiceStudio";
import { Transport } from "./Transport";
import { ExportDialog } from "./ExportDialog";
import { HandoffBridge } from "./HandoffBridge";
import { Toaster } from "./Toaster";
import { Button, Dialog, Sheet } from "./ui/Primitives";
import {
  Book, Close, Eye, Keyboard, List, Moon, Sliders, Sun, Upload, Waveform,
} from "./ui/Icons";

/** Which panel the narrow-screen sheet is showing, if any. */
type SheetName = "outline" | "voice" | null;

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
  const [sheet, setSheet] = useState<SheetName>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  const setRsvpEnabled = useStore((s) => s.setRsvpEnabled);

  const { openFile } = useIngest();
  const fileInput = useRef<HTMLInputElement>(null);

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

  /* The inline script in `app/layout.tsx` has already applied the theme to
     <html> before first paint. Read it back rather than deciding again, or
     the two disagree for one frame. */
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem("readloud.theme", next);
      } catch {
        /* private browsing */
      }
      return next;
    });
  }, []);

  /* ── Panels ───────────────────────────────────────────────────
     One control, two behaviours: on a wide screen it docks or undocks
     the side pane, on a narrow one it raises the sheet. */
  const showOutline = useCallback(() => {
    if (window.matchMedia("(min-width: 1024px)").matches) setLeftOpen(true);
    else setSheet("outline");
  }, []);

  const togglePanel = useCallback((which: "outline" | "voice") => {
    if (window.matchMedia("(min-width: 1024px)").matches) {
      if (which === "outline") setLeftOpen((v) => !v);
      else setRightOpen((v) => !v);
    } else {
      setSheet((s) => (s === which ? null : which));
    }
  }, []);

  /* ── Shell-level shortcuts ───────────────────────────────────── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Reading mode owns the keyboard while it is up — including `Esc`, which
      // there means "back to the reader" rather than "close the panels".
      // Explicit, and greppable, rather than a race between capture-phase
      // handlers.
      if (useStore.getState().rsvp.enabled) return;

      if (e.key === "?") setShortcuts((v) => !v);
      if ((e.key === "r" || e.key === "R") && useStore.getState().doc) {
        setRsvpEnabled(true);
      }
      if (e.key === "Escape") {
        setShortcuts(false);
        setSheet(null);
      }
      // "/" is the search key everywhere else on the web; it should be here
      // too, and it should raise the panel that holds the search box.
      if (e.key === "/" && useStore.getState().doc) {
        e.preventDefault();
        showOutline();
        setTimeout(() => window.dispatchEvent(new Event("readloud:focus-search")), 60);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showOutline, setRsvpEnabled]);

  /* ── Drop a file anywhere ─────────────────────────────────────
     Dropping onto the window outside the landing zone used to make the
     browser navigate away to the raw file, throwing away the session. */
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    const carriesFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const onEnter = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      dragDepth.current += 1;
      setDropping(true);
    };
    const onOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault(); // without this the drop event never fires
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = () => {
      // dragleave fires for every child element crossed, so count rather
      // than clearing on the first one and flickering the whole way in.
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDropping(false);
    };
    const onDrop = (e: DragEvent) => {
      dragDepth.current = 0;
      setDropping(false);
      if (!carriesFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer?.files.length) void openFile(e.dataTransfer.files);
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [openFile]);

  const closeDocument = () => {
    setConfirmClose(false);
    setSheet(null);
    reset();
  };

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden">
      <div className="aurora"><i /></div>
      <div className="grain" />

      {/* Top bar */}
      <header className="glass relative z-30 flex h-14 shrink-0 items-center gap-2 rounded-b-2xl px-3 sm:gap-3 sm:px-4">
        <div className="flex shrink-0 items-center gap-2.5">
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
            <div className="mx-1 hidden h-6 w-px bg-[var(--hairline)] md:block" />
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

        <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
          {doc && (
            <>
              <Button
                variant="bare"
                size="icon"
                onClick={() => togglePanel("outline")}
                title="Contents and search (/)"
                aria-label="Contents and search"
                className={leftOpen ? "lg:text-ink-100" : ""}
              >
                <List width={17} height={17} />
              </Button>
              <Button
                variant="bare"
                size="icon"
                onClick={() => setRsvpEnabled(true)}
                title="Reading mode — one word at a time (R)"
                aria-label="Reading mode"
              >
                <Eye width={17} height={17} />
              </Button>
              <Button
                variant="bare"
                size="icon"
                onClick={() => togglePanel("voice")}
                title="Voice and reading settings"
                aria-label="Voice and reading settings"
                className={rightOpen ? "lg:text-ink-100" : ""}
              >
                <Sliders width={17} height={17} />
              </Button>
              <div className="mx-1 hidden h-6 w-px bg-[var(--hairline)] sm:block" />
              <Button
                variant="bare"
                size="icon"
                onClick={() => fileInput.current?.click()}
                title="Open another document"
                aria-label="Open another document"
                className="hidden sm:inline-flex"
              >
                <Upload width={17} height={17} />
              </Button>
            </>
          )}
          <Button
            variant="bare"
            size="icon"
            onClick={() => setShortcuts(true)}
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
            className="hidden sm:inline-flex"
          >
            <Keyboard width={17} height={17} />
          </Button>
          <Button
            variant="bare"
            size="icon"
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to paper mode" : "Switch to dark mode"}
            aria-label={theme === "dark" ? "Switch to paper mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <Sun width={17} height={17} /> : <Moon width={17} height={17} />}
          </Button>
          {doc && (
            <Button
              variant="bare"
              size="icon"
              onClick={() => setConfirmClose(true)}
              title="Close document"
              aria-label="Close document"
            >
              <Close width={17} height={17} />
            </Button>
          )}
        </div>
      </header>

      {/* Body */}
      <main className="relative z-10 flex min-h-0 flex-1 gap-3 p-2 sm:p-3">
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
        <div className="safe-bottom relative z-20 px-2 sm:px-3">
          <Transport />
        </div>
      )}

      {/* Narrow screens: the same two panels, as sheets. */}
      <Sheet open={sheet === "outline"} onClose={() => setSheet(null)} title="Contents">
        <Outline onNavigate={() => setSheet(null)} />
      </Sheet>
      <Sheet open={sheet === "voice"} onClose={() => setSheet(null)} title="Voice & reading">
        <VoiceStudio />
      </Sheet>

      <input
        ref={fileInput}
        type="file"
        accept={ACCEPTED_FILE_TYPES}
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) void openFile(e.target.files);
          e.target.value = "";
        }}
      />

      {dropping && (
        <div className="drop-veil animate-fade">
          <div className="glass-strong flex flex-col items-center gap-3 rounded-2xl px-10 py-8 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-iris-500 to-aqua-500 shadow-lg">
              <Upload width={24} height={24} className="text-white" />
            </div>
            <p className="text-[16px] font-medium text-ink-100">Drop it anywhere</p>
            <p className="max-w-xs text-[12.5px] leading-relaxed text-ink-400">
              PDF, EPUB, Markdown, HTML, plain text or subtitles. It is parsed here in
              this tab and never uploaded.
            </p>
          </div>
        </div>
      )}

      <Dialog
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        title="Close this document?"
        subtitle="Your place in it is remembered — open the same file again and it picks up where you stopped. The text itself was never stored anywhere, so you will need the file."
        width={460}
        footer={
          <>
            <Button onClick={() => setConfirmClose(false)}>Keep reading</Button>
            <Button variant="primary" onClick={closeDocument}>
              Close it
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-ink-300">
          Closing takes you back to the start screen, where you can drop in something
          else. Nothing is deleted from your machine either way.
        </p>
      </Dialog>

      <ExportDialog />
      <Rsvp />
      <HandoffBridge />
      <Toaster />
      <Shortcuts open={shortcuts} onClose={() => setShortcuts(false)} />
    </div>
  );
}

/* ── Shortcuts ──────────────────────────────────────────────── */

const KEYS: Array<[string, string]> = [
  ["Space / K", "Play or pause"],
  ["R", "Reading mode — one word at a time"],
  ["← / →", "Back or forward 15 seconds"],
  ["Shift + ← / →", "Previous or next passage"],
  ["J / L", "Back or forward 30 seconds"],
  ["↑ / ↓", "Volume"],
  ["[ / ]", "Slower or faster"],
  ["F", "Focus mode — dim everything but the spoken passage"],
  ["In reading mode: ← / →", "Back or forward one word"],
  ["In reading mode: Shift + ← / →", "Back or forward one sentence"],
  ["In reading mode: ↑ / ↓", "Faster or slower"],
  ["In reading mode: Backspace", "Replay the last ten words, slower"],
  ["/", "Search the document"],
  ["Double-click a passage", "Start reading from there"],
  ["Esc", "Close whatever is open"],
  ["?", "This panel"],
];

function Shortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Keyboard"
      subtitle="Everything here also has a button — these are for when your hands are already on the keys."
      width={480}
    >
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
    </Dialog>
  );
}
