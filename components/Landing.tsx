"use client";
/* The empty state: drop target, paste panel, and a sample so the app can be
   evaluated in ten seconds without hunting for a PDF. */

import { useCallback, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { ingestFile, ingestText, MAX_FILE_BYTES, formatBytes } from "@/lib/ingest";
import { CHUNK_PRESETS } from "@/lib/text/chunk";
import { SAMPLE_TEXT } from "@/lib/sample";
import { Button, Progress } from "./ui/Primitives";
import { Book, Bolt, Doc, Download, Sparkle, Text, Upload, Waveform } from "./ui/Icons";

export function Landing() {
  const setDocument = useStore((s) => s.setDocument);
  const setIngest = useStore((s) => s.setIngest);
  const setIngestError = useStore((s) => s.setIngestError);
  const ingest = useStore((s) => s.ingest);
  const error = useStore((s) => s.ingestError);
  const chunkPreset = useStore((s) => s.chunkPreset);
  const toast = useStore((s) => s.toast);

  const [hot, setHot] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const file = Array.from(files)[0];
      if (!file) return;
      const controller = new AbortController();
      abort.current = controller;
      setIngestError(null);
      try {
        const doc = await ingestFile(file, {
          chunking: CHUNK_PRESETS[chunkPreset],
          onProgress: setIngest,
          signal: controller.signal,
        });
        setDocument(doc);
        toast({
          tone: "success",
          title: "Ready to read",
          body: `${doc.meta.words.toLocaleString()} words in ${doc.chunks.length.toLocaleString()} passages.`,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          setIngest(null);
          return;
        }
        setIngestError(err instanceof Error ? err.message : "Could not read that file.");
      } finally {
        abort.current = null;
      }
    },
    [chunkPreset, setDocument, setIngest, setIngestError, toast],
  );

  const loadSample = () => {
    const doc = ingestText(SAMPLE_TEXT, "The Lighthouse at Dunmore Head.md", {
      chunking: CHUNK_PRESETS[chunkPreset],
    });
    setDocument(doc);
  };

  const submitPaste = () => {
    if (!pasted.trim()) return;
    try {
      const doc = ingestText(pasted, "Pasted text.txt", {
        chunking: CHUNK_PRESETS[chunkPreset],
      });
      setDocument(doc);
      setPasting(false);
      setPasted("");
    } catch (err) {
      setIngestError(err instanceof Error ? err.message : "Could not read that text.");
    }
  };

  return (
    <div className="scroll-fine h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-4xl flex-col justify-center px-6 py-14">
        {/* Hero */}
        <div className="animate-rise text-center">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[var(--hairline)] bg-[color-mix(in_oklab,white_4%,transparent)] px-3.5 py-1.5 text-[11.5px] font-medium text-ink-300">
            <Sparkle width={13} height={13} className="text-iris-400" />
            PDF, EPUB, Markdown and plain text - parsed entirely in your browser
          </div>
          <h1 className="text-[clamp(2.4rem,6vw,3.9rem)] leading-[1.04] font-semibold tracking-[-0.03em] text-balance">
            <span className="grad-text">Give anything you read</span>
            <br />
            <span className="text-ink-100">a voice worth listening to.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-balance text-ink-300">
            Drop in a nine-hundred-page book. ReadLoud parses it, paces it like a
            narrator rather than a screen reader, follows along word by word, and
            exports the whole thing as an MP3 with a matching transcript.
          </p>
        </div>

        {/* Dropzone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setHot(true);
          }}
          onDragLeave={() => setHot(false)}
          onDrop={(e) => {
            e.preventDefault();
            setHot(false);
            void handleFiles(e.dataTransfer.files);
          }}
          className={`animate-rise glass mt-10 rounded-2xl border-2 border-dashed p-10 text-center transition-all duration-300 ${
            hot ? "dropzone-hot" : ""
          }`}
          style={{ animationDelay: "80ms" }}
        >
          {ingest ? (
            <div className="mx-auto max-w-md">
              <div className="mb-3 flex items-center justify-center gap-2.5">
                <Waveform width={18} height={18} className="text-iris-400" />
                <span className="text-[14px] font-medium text-ink-100">{ingest.detail}</span>
              </div>
              <Progress value={ingest.ratio} indeterminate={ingest.phase === "reading"} />
              <div className="mt-3 flex items-center justify-center gap-3 text-[12px] text-ink-400">
                <span className="tabular">{Math.round(ingest.ratio * 100)}%</span>
                <span>-</span>
                <button
                  className="text-ink-300 underline underline-offset-2 hover:text-ink-100"
                  onClick={() => abort.current?.abort()}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-iris-500 to-aqua-500 shadow-lg">
                <Upload width={24} height={24} className="text-white" />
              </div>
              <p className="text-[16px] font-medium text-ink-100">
                Drop a document here
              </p>
              <p className="mt-1.5 text-[13px] text-ink-400">
                PDF, EPUB, TXT, Markdown or HTML - up to {formatBytes(MAX_FILE_BYTES)}
              </p>
              <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
                <Button variant="primary" size="lg" onClick={() => inputRef.current?.click()}>
                  <Doc width={16} height={16} />
                  Choose a file
                </Button>
                <Button size="lg" onClick={() => setPasting((v) => !v)}>
                  <Text width={16} height={16} />
                  Paste text
                </Button>
                <Button size="lg" onClick={loadSample}>
                  <Book width={16} height={16} />
                  Try the sample
                </Button>
              </div>
              <input
                ref={inputRef}
                type="file"
                accept=".pdf,.epub,.txt,.md,.markdown,.html,.htm,.xhtml,application/pdf,application/epub+zip,text/plain,text/markdown,text/html"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) void handleFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </>
          )}

          {pasting && !ingest && (
            <div className="animate-rise mt-6 text-left">
              <textarea
                autoFocus
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder="Paste an article, a chapter, a transcript, anything."
                rows={7}
                className="ring-focus scroll-fine w-full resize-y rounded-xl border border-[var(--hairline)] bg-[var(--field)] p-3.5 font-serif text-[14px] leading-relaxed text-ink-100 placeholder:text-ink-500"
              />
              <div className="mt-2.5 flex items-center justify-between">
                <span className="tabular text-[12px] text-ink-400">
                  {pasted.length.toLocaleString()} characters
                </span>
                <Button variant="primary" size="sm" onClick={submitPaste} disabled={!pasted.trim()}>
                  Read this
                </Button>
              </div>
            </div>
          )}

          {error && (
            <div className="mt-5 rounded-xl border border-[color-mix(in_oklab,var(--color-rose-500)_38%,transparent)] bg-[color-mix(in_oklab,var(--color-rose-500)_9%,transparent)] px-4 py-3 text-left">
              <p className="text-[13px] leading-relaxed text-rose-500">{error}</p>
            </div>
          )}
        </div>

        {/* Capability strip */}
        <div className="animate-rise mt-8 grid gap-3 sm:grid-cols-3" style={{ animationDelay: "160ms" }}>
          <Capability
            icon={<Bolt width={16} height={16} />}
            title="Built for scale"
            body="pdf.js streams page by page and releases each one, so a 1,200-page scan never fills memory."
          />
          <Capability
            icon={<Waveform width={16} height={16} />}
            title="Real MP3 export"
            body="LAME runs in a worker and encodes as it goes, so a six-hour book never becomes a six-gigabyte buffer."
          />
          <Capability
            icon={<Download width={16} height={16} />}
            title="Transcripts that line up"
            body="Markdown, plain text, SRT, VTT and JSON, timed from the rendered audio rather than guessed."
          />
        </div>

        <p className="mt-8 text-center text-[11.5px] text-ink-500">
          Nothing is uploaded. Parsing, highlighting and encoding all happen in this tab.
        </p>
      </div>
    </div>
  );
}

function Capability({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="glass rounded-xl p-4">
      <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-[color-mix(in_oklab,var(--color-iris-500)_18%,transparent)] text-iris-400">
        {icon}
      </div>
      <div className="text-[13.5px] font-medium text-ink-100">{title}</div>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-400">{body}</p>
    </div>
  );
}
