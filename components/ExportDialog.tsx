"use client";
/* ────────────────────────────────────────────────────────────────
   Export.

   Three paths, and the dialog is honest about which one you are on:

   * Studio render (Kokoro) — synthesize, decode, LAME-encode.
     Faster than realtime, deterministic, exact timings for subtitles.
   * Realtime capture (system voice) — record what the browser plays.
     Works, but takes as long as the book, and Chromium only. This
     exists because the Web Speech API exposes no audio stream at all.
   * Transcript only — always available, instant, no audio involved.
   ──────────────────────────────────────────────────────────────── */

import { useCallback, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { getProvider } from "@/lib/tts/registry";
import { BITRATE_PRESETS } from "@/lib/audio/encode";
import { DEFAULT_RENDER, formatBytes, formatClock, renderToMp3 } from "@/lib/audio/pipeline";
import { isTabCaptureSupported, startTabCapture, type CaptureSession } from "@/lib/audio/capture";
import { buildTranscript, type TranscriptFormat } from "@/lib/export/transcript";
import { download, downloadText, safeFilename } from "@/lib/export/download";
import type { TranscriptCue } from "@/lib/types";
import { Button, Dialog, Field, Progress, Segmented, Select, Switch } from "./ui/Primitives";
import { Bolt, Check, Download, Info, Mic, Warning, Waveform } from "./ui/Icons";

type Scope = "all" | "section" | "rest";
type Tab = "audio" | "transcript";

export function ExportDialog() {
  const open = useStore((s) => s.exportOpen);
  const setOpen = useStore((s) => s.setExportOpen);
  const doc = useStore((s) => s.doc);
  const providerId = useStore((s) => s.providerId);
  const voiceId = useStore((s) => s.voiceId);
  const rate = useStore((s) => s.rate);
  const pitch = useStore((s) => s.pitch);
  const gapSeconds = useStore((s) => s.gapSeconds);
  const chunkIndex = useStore((s) => s.player.chunkIndex);
  const progress = useStore((s) => s.exportProgress);
  const setProgress = useStore((s) => s.setExportProgress);
  const toast = useStore((s) => s.toast);

  const [tab, setTab] = useState<Tab>("audio");
  const [scope, setScope] = useState<Scope>("all");
  const [kbps, setKbps] = useState(96);
  const [stereo, setStereo] = useState(false);
  const [normalize, setNormalize] = useState(true);
  const [trim, setTrim] = useState(true);
  const [format, setFormat] = useState<TranscriptFormat>("md");
  const [withTimestamps, setWithTimestamps] = useState(true);
  const [withSections, setWithSections] = useState(true);
  const [capture, setCapture] = useState<CaptureSession | null>(null);
  const [captureSeconds, setCaptureSeconds] = useState(0);

  const abort = useRef<AbortController | null>(null);
  const lastCues = useRef<TranscriptCue[] | undefined>(undefined);

  const provider = getProvider(providerId);
  const canRender = provider.capabilities.synthesize;

  const chunks = useMemo(() => {
    if (!doc) return [];
    if (scope === "rest") return doc.chunks.slice(chunkIndex);
    if (scope === "section") {
      const sectionId = doc.chunks[chunkIndex]?.sectionId;
      return doc.chunks.filter((c) => c.sectionId === sectionId);
    }
    return doc.chunks;
  }, [doc, scope, chunkIndex]);

  const estimate = useMemo(() => {
    const seconds = chunks.reduce((a, c) => a + c.estSeconds, 0) / rate;
    const characters = chunks.reduce((a, c) => a + c.text.length, 0);
    const channels = stereo ? 2 : 1;
    // MP3 size is bitrate x duration; the CBR encoder makes this exact.
    const bytes = (kbps * 1000 * seconds) / 8;
    return { seconds, characters, bytes, channels, requests: chunks.length };
  }, [chunks, rate, kbps, stereo]);

  const busy = progress !== null && progress.phase !== "done" && progress.phase !== "error";

  /* ── studio render ────────────────────────────────────────── */

  const runRender = useCallback(async () => {
    if (!doc) return;
    const controller = new AbortController();
    abort.current = controller;
    setProgress({ phase: "synthesizing", ratio: 0, detail: "Starting" });

    try {
      const result = await renderToMp3(
        chunks,
        provider,
        {
          ...DEFAULT_RENDER,
          voiceId,
          rate,
          pitch,
          kbps,
          channels: stereo ? 2 : 1,
          gapSeconds,
          normalize,
          trim,
        },
        setProgress,
        controller.signal,
      );
      lastCues.current = result.cues;
      download(result.blob, safeFilename(doc.meta.title ?? doc.name, "mp3"));
      toast({
        tone: "success",
        title: "MP3 ready",
        body: `${formatClock(result.duration)} - ${formatBytes(result.bytes)}. Subtitle timings are now exact.`,
      });
      setProgress({ phase: "done", ratio: 1, detail: "Saved" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Export failed.";
      const cancelled = err instanceof DOMException && err.name === "AbortError";
      setProgress(cancelled ? null : { phase: "error", ratio: 0, detail: message });
      if (!cancelled) toast({ tone: "error", title: "Export failed", body: message });
    } finally {
      abort.current = null;
    }
  }, [
    doc, chunks, provider, voiceId, rate, pitch, kbps, stereo, gapSeconds,
    normalize, trim, setProgress, toast,
  ]);

  /* ── realtime capture ─────────────────────────────────────── */

  const startCapture = useCallback(async () => {
    if (!doc) return;
    try {
      const session = await startTabCapture({
        sampleRate: 44100,
        channels: stereo ? 2 : 1,
        kbps,
      });
      setCapture(session);
      const timer = setInterval(() => setCaptureSeconds(session.elapsed()), 250);
      (session as CaptureSession & { _timer?: number })._timer =
        timer as unknown as number;
      toast({
        tone: "info",
        title: "Recording",
        body: "Press play to narrate. Everything the tab plays is captured until you stop.",
      });
    } catch (err) {
      toast({
        tone: "error",
        title: "Could not start capture",
        body: err instanceof Error ? err.message : undefined,
      });
    }
  }, [doc, stereo, kbps, toast]);

  const stopCapture = useCallback(async () => {
    if (!capture || !doc) return;
    const timer = (capture as CaptureSession & { _timer?: number })._timer;
    if (timer) clearInterval(timer);
    try {
      const blob = await capture.stop();
      download(blob, safeFilename(doc.meta.title ?? doc.name, "mp3"));
      toast({
        tone: "success",
        title: "Recording saved",
        body: `${formatClock(captureSeconds)} - ${formatBytes(blob.size)}`,
      });
    } catch (err) {
      toast({
        tone: "error",
        title: "Could not finish the recording",
        body: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setCapture(null);
      setCaptureSeconds(0);
    }
  }, [capture, doc, captureSeconds, toast]);

  /* ── transcript ───────────────────────────────────────────── */

  const exportTranscript = useCallback(() => {
    if (!doc) return;
    const { content, mime, extension } = buildTranscript(doc, chunks, {
      format,
      includeSections: withSections,
      includeTimestamps: withTimestamps,
      cues: lastCues.current,
    });
    downloadText(content, safeFilename(doc.meta.title ?? doc.name, extension), mime);
    toast({
      tone: "success",
      title: `Transcript saved as .${extension}`,
      body: lastCues.current
        ? "Timings match the MP3 you rendered."
        : "Timings are estimated. Render the MP3 first for exact ones.",
    });
  }, [doc, chunks, format, withSections, withTimestamps, toast]);

  if (!doc) return null;

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (busy) return;
        setOpen(false);
      }}
      title="Export"
      subtitle={`${doc.meta.title ?? doc.name} - ${doc.meta.words.toLocaleString()} words`}
      width={680}
      footer={
        <>
          {busy ? (
            <Button
              onClick={() => {
                abort.current?.abort();
                setProgress(null);
              }}
            >
              Cancel
            </Button>
          ) : (
            <Button onClick={() => setOpen(false)}>Close</Button>
          )}
          {tab === "audio" ? (
            canRender ? (
              <Button variant="primary" onClick={runRender} disabled={busy || !voiceId}>
                <Download width={15} height={15} />
                Render MP3
              </Button>
            ) : capture ? (
              <Button variant="primary" onClick={stopCapture}>
                Stop and save
              </Button>
            ) : (
              <Button variant="primary" onClick={startCapture} disabled={!isTabCaptureSupported()}>
                <Mic width={15} height={15} />
                Start recording
              </Button>
            )
          ) : (
            <Button variant="primary" onClick={exportTranscript}>
              <Download width={15} height={15} />
              Download .{format}
            </Button>
          )}
        </>
      }
    >
      <Segmented<Tab>
        className="mb-5"
        value={tab}
        onChange={setTab}
        options={[
          { value: "audio", label: <><Waveform width={13} height={13} /> Audio</> },
          { value: "transcript", label: <><Info width={13} height={13} /> Transcript</> },
        ]}
      />

      <Field label="Range">
        <Segmented<Scope>
          stretch
          className="w-full"
          value={scope}
          onChange={setScope}
          options={[
            { value: "all", label: "Whole document" },
            { value: "rest", label: "From here on" },
            { value: "section", label: "This section" },
          ]}
        />
      </Field>

      {tab === "audio" ? (
        <>
          {!canRender && <CaptureNotice supported={isTabCaptureSupported()} />}

          <div className="grid grid-cols-2 gap-x-5">
            <Field label="Bitrate" value={`${kbps} kbps`}>
              <Select<string>
                value={String(kbps)}
                onChange={(v) => setKbps(Number(v))}
                options={BITRATE_PRESETS.map((b) => ({
                  value: String(b.kbps),
                  label: b.label,
                  hint: b.note,
                }))}
              />
            </Field>
            <Field label="Estimated size" value={formatBytes(estimate.bytes)}>
              <div className="flex h-[42px] items-center gap-2 rounded-xl border border-[var(--hairline)] px-3">
                <Bolt width={13} height={13} className="text-ember-500" />
                <span className="tabular text-[13px] text-ink-200">
                  {formatClock(estimate.seconds)}
                </span>
                <span className="text-[11.5px] text-ink-500">
                  {estimate.requests.toLocaleString()} passages
                </span>
              </div>
            </Field>
          </div>

          <div className="mt-1 divide-y divide-[var(--hairline)]">
            <Switch
              checked={stereo}
              onChange={setStereo}
              label="Stereo"
              hint="Speech gains nothing from two channels. Mono halves the file."
            />
            {canRender && (
              <>
                <Switch
                  checked={trim}
                  onChange={setTrim}
                  label="Trim provider padding"
                  hint="Neural voices pad each clip with silence. Across thousands of passages that becomes minutes of dead air."
                />
                <Switch
                  checked={normalize}
                  onChange={setNormalize}
                  label="Match loudness"
                  hint="Peak-normalize every passage so the volume never lurches between them."
                />
              </>
            )}
          </div>

          {capture && (
            <div className="mt-5 rounded-xl border border-[color-mix(in_oklab,var(--color-rose-500)_35%,transparent)] bg-[color-mix(in_oklab,var(--color-rose-500)_8%,transparent)] px-4 py-3">
              <div className="flex items-center gap-2.5">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-500" />
                </span>
                <span className="text-[13px] font-medium text-ink-100">Recording</span>
                <span className="tabular ml-auto text-[13px] text-ink-300">
                  {formatClock(captureSeconds)}
                </span>
              </div>
              <p className="mt-2 text-[11.5px] leading-snug text-ink-400">
                Press play in the transport bar. Keep this tab in the foreground - background
                tabs are throttled and the recording will contain gaps.
              </p>
            </div>
          )}

          {progress && <ProgressPanel />}
        </>
      ) : (
        <>
          <Field label="Format">
            <Segmented<TranscriptFormat>
              stretch
              className="w-full"
              value={format}
              onChange={setFormat}
              options={[
                { value: "md", label: "Markdown", title: "Formatted, with a metadata table" },
                { value: "txt", label: "Plain text", title: "Clean text" },
                { value: "srt", label: "SRT", title: "Subtitles" },
                { value: "vtt", label: "WebVTT", title: "Web subtitles" },
                { value: "json", label: "JSON", title: "Structured cues" },
              ]}
            />
          </Field>

          {(format === "md" || format === "txt") && (
            <div className="divide-y divide-[var(--hairline)]">
              <Switch
                checked={withSections}
                onChange={setWithSections}
                label="Section headings"
                hint="Insert a heading at each chapter or page boundary."
              />
              <Switch
                checked={withTimestamps}
                onChange={setWithTimestamps}
                label="Timecodes"
                hint="Prefix each passage with its position in the audio."
              />
            </div>
          )}

          <div
            className={`mt-4 flex items-start gap-2.5 rounded-xl border px-3.5 py-3 ${
              lastCues.current
                ? "border-[color-mix(in_oklab,var(--color-mint-500)_32%,transparent)] bg-[color-mix(in_oklab,var(--color-mint-500)_8%,transparent)]"
                : "border-[var(--hairline)]"
            }`}
          >
            {lastCues.current ? (
              <Check width={15} height={15} className="mt-0.5 shrink-0 text-mint-500" />
            ) : (
              <Info width={15} height={15} className="mt-0.5 shrink-0 text-ink-400" />
            )}
            <p className="text-[12px] leading-relaxed text-ink-300">
              {lastCues.current
                ? "Timings are measured from the MP3 you rendered, so SRT and VTT line up exactly."
                : "Timings are estimated from word counts. Render the MP3 first and re-export to get sample-accurate subtitle timings."}
            </p>
          </div>

          <TranscriptPreview format={format} />
        </>
      )}
    </Dialog>
  );
}

function ProgressPanel() {
  const progress = useStore((s) => s.exportProgress);
  if (!progress) return null;
  const failed = progress.phase === "error";
  return (
    <div className="mt-5 rounded-xl border border-[var(--hairline)] px-4 py-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <span
          className={`text-[12px] font-semibold tracking-wide uppercase ${failed ? "text-rose-500" : "text-iris-400"}`}
        >
          {progress.phase}
        </span>
        {!failed && (
          <span className="tabular ml-auto text-[12px] text-ink-300">
            {Math.round(progress.ratio * 100)}%
          </span>
        )}
      </div>
      {!failed && <Progress value={progress.ratio} />}
      <p className={`mt-2.5 text-[12px] ${failed ? "text-rose-500" : "text-ink-400"}`}>
        {progress.detail}
      </p>
    </div>
  );
}

function CaptureNotice({ supported }: { supported: boolean }) {
  return (
    <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-[color-mix(in_oklab,var(--color-ember-500)_32%,transparent)] bg-[color-mix(in_oklab,var(--color-ember-500)_8%,transparent)] px-3.5 py-3">
      <Warning width={15} height={15} className="mt-0.5 shrink-0 text-ember-500" />
      <div className="text-[12px] leading-relaxed text-ink-300">
        <p className="mb-1.5 font-medium text-ember-400">
          System voices cannot be rendered to a file directly.
        </p>
        <p>
          The Web Speech API exposes no audio stream by design, so the only way to
          capture it is to record what the browser plays - in realtime, and in
          Chrome or Edge. When the picker opens, choose{" "}
          <b className="text-ink-100">This tab</b> and enable{" "}
          <b className="text-ink-100">Also share tab audio</b>.
        </p>
        {!supported && (
          <p className="mt-1.5 text-rose-500">
            This browser does not support tab capture. Switch to the Kokoro engine
            for instant, fully offline MP3 rendering.
          </p>
        )}
      </div>
    </div>
  );
}

function TranscriptPreview({ format }: { format: TranscriptFormat }) {
  const doc = useStore((s) => s.doc);
  const preview = useMemo(() => {
    if (!doc) return "";
    // Render only the opening passages - building a full transcript for a
    // 900-page book on every format toggle would be pointless work - but
    // report the whole document's totals in the header.
    const { content } = buildTranscript(doc, doc.chunks.slice(0, 3), {
      format,
      includeSections: true,
      includeTimestamps: true,
      totals: {
        passages: doc.chunks.length,
        duration: doc.chunks.reduce((a, c) => a + c.estSeconds, 0),
      },
    });
    return content.slice(0, 700);
  }, [doc, format]);

  return (
    <div className="mt-4">
      <div className="mb-2 text-[11px] font-semibold tracking-[0.09em] text-ink-400 uppercase">
        Preview
      </div>
      <pre className="scroll-fine max-h-52 overflow-auto rounded-xl border border-[var(--hairline)] bg-[var(--field)] p-3.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-300">
        {preview}
      </pre>
    </div>
  );
}
