"use client";
/* ────────────────────────────────────────────────────────────────
   Import a YouTube transcript.

   The honest shape of this feature, stated once here because the UI
   has to explain it too:

   YouTube's caption endpoints send no CORS headers, so this page
   cannot fetch them. Nor, any longer, can a server: caption URLs are
   increasingly stamped `exp=xpe`, requiring a proof-of-origin token
   that YouTube's player JavaScript mints at runtime. It is not a
   cookie, so forwarding a session does not substitute for it, and a
   request without one returns an empty body with a 200.

   What always has a valid token is the reader's own browser on the
   video page. So we send them there with a helper that reads the
   transcript and hands it back. It is one click once the helper is
   installed, it works on members-only and unlisted videos that no
   scraper can reach, and nothing is ever uploaded.
   ──────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { ingestCaptionText } from "@/lib/ingest";
import { CHUNK_PRESETS } from "@/lib/text/chunk";
import { buildBookmarklet } from "@/lib/ingest/bookmarklet";
import { parseYouTubeUrl, watchUrl } from "@/lib/ingest/youtube";
import { Button, Dialog } from "./ui/Primitives";
import { Check, Doc, Info, Sparkle, Text } from "./ui/Icons";

export const HELPER_INSTALLED_KEY = "readloud.helper.v1";

/** How long to wait for a hand-off before assuming the helper is not there. */
const WAIT_MS = 60_000;

type Phase = "idle" | "waiting" | "timedout";

export function LinkImport({ open, onClose }: { open: boolean; onClose: () => void }) {
  const setDocument = useStore((s) => s.setDocument);
  const setIngestError = useStore((s) => s.setIngestError);
  const chunkPreset = useStore((s) => s.chunkPreset);
  const doc = useStore((s) => s.doc);

  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [installed, setInstalled] = useState(false);
  const [pasted, setPasted] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bookmarkRef = useRef<HTMLAnchorElement>(null);

  const video = parseYouTubeUrl(url);

  useEffect(() => {
    try {
      setInstalled(localStorage.getItem(HELPER_INSTALLED_KEY) === "1");
    } catch {
      /* private browsing */
    }
  }, [open]);

  /* A document arriving means the hand-off landed. Get out of the way. */
  useEffect(() => {
    if (doc && open) onClose();
  }, [doc, open, onClose]);

  /**
   * React refuses to render a `javascript:` href, and rightly - but a
   * bookmarklet is exactly that, and it is being dragged rather than
   * followed. Setting the attribute after mount is the documented escape.
   */
  useEffect(() => {
    if (!open) return;
    const el = bookmarkRef.current;
    if (el) el.setAttribute("href", buildBookmarklet(window.location.origin));
  }, [open]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const fetchIt = useCallback(() => {
    if (!video) return;
    // Must be inside the click handler or the popup blocker eats it.
    window.open(watchUrl(video.videoId, window.location.origin), "_blank", "noopener");
    setPhase("waiting");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setPhase("timedout"), WAIT_MS);
  }, [video]);

  const submitPaste = () => {
    if (!pasted.trim()) return;
    try {
      const document_ = ingestCaptionText(pasted, "YouTube transcript", {
        chunking: CHUNK_PRESETS[chunkPreset],
      });
      setDocument(document_);
      onClose();
    } catch (err) {
      setIngestError(err instanceof Error ? err.message : "That transcript could not be read.");
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Read a YouTube video"
      subtitle="The transcript is read by your own browser, on the video page. Nothing is uploaded, and no account or key is involved."
      width={620}
    >
      <label htmlFor="yt-url" className="mb-2 block text-[12px] font-medium text-ink-300">
        Video link
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="yt-url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setPhase("idle");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && video) fetchIt();
          }}
          placeholder="https://www.youtube.com/watch?v=..."
          className="ring-focus min-w-0 flex-1 rounded-xl border border-[var(--hairline)] bg-[var(--field)] px-3.5 py-2.5 font-mono text-[13px] text-ink-100 placeholder:text-ink-500"
        />
        <Button variant="primary" onClick={fetchIt} disabled={!video}>
          Get transcript
        </Button>
      </div>
      {url.trim() && !video && (
        <p className="mt-2 text-[12px] text-ember-400">
          That is not a YouTube link. Paste the address from the browser bar, or the
          video id on its own.
        </p>
      )}

      {phase === "waiting" && (
        <div className="animate-rise mt-5 rounded-xl border border-[var(--hairline)] bg-[var(--field)] px-4 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="eq text-iris-400"><span /><span /><span /><span /><span /></span>
            <span className="text-[13px] font-medium text-ink-100">
              Waiting for the video tab
            </span>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-400">
            A YouTube tab just opened. If the helper is installed it will read the
            transcript and hand it straight back here. If you are using the
            bookmarklet, click it on that tab now.
          </p>
        </div>
      )}

      {phase === "timedout" && (
        <div className="animate-rise mt-5 rounded-xl border border-[color-mix(in_oklab,var(--color-ember-500)_35%,transparent)] bg-[color-mix(in_oklab,var(--color-ember-500)_9%,transparent)] px-4 py-3.5">
          <p className="text-[13px] leading-relaxed text-ember-400">
            Nothing came back. Either the helper is not installed yet, or that
            video has no captions. Set up the helper below, or paste the
            transcript by hand - that always works.
          </p>
        </div>
      )}

      {/* Setup */}
      <div className="mt-6">
        <div className="mb-3 flex items-center gap-2">
          <h3 className="text-[13.5px] font-semibold text-ink-100">
            {installed ? "Your helper" : "One-time setup"}
          </h3>
          {installed && (
            <span className="inline-flex items-center gap-1 rounded-full border border-[color-mix(in_oklab,var(--color-mint-500)_40%,transparent)] px-2 py-0.5 text-[10.5px] font-medium text-mint-500">
              <Check width={11} height={11} />
              working
            </span>
          )}
        </div>

        <div className="grid gap-2.5">
          <Option
            title="Drag this to your bookmarks bar"
            body="Then open any video and click it. Nothing to install."
          >
            <a
              ref={bookmarkRef}
              href="#"
              draggable
              onClick={(e) => e.preventDefault()}
              className="btn btn-primary ring-focus inline-flex h-8 shrink-0 cursor-grab items-center gap-1.5 px-3 text-[12.5px] active:cursor-grabbing"
              title="Drag me to the bookmarks bar"
            >
              <Sparkle width={13} height={13} />
              Read aloud
            </a>
          </Option>

          <Option
            title="Or install the userscript"
            body="Needs Tampermonkey or Violentmonkey. After this, the button above does the whole job on its own."
          >
            <a
              href="/readloud-helper.user.js"
              target="_blank"
              rel="noreferrer"
              className="btn btn-ghost ring-focus inline-flex h-8 shrink-0 items-center gap-1.5 px-3 text-[12.5px]"
            >
              <Doc width={13} height={13} />
              Install
            </a>
          </Option>

          <Option
            title="Or paste it by hand"
            body="On the video, open the description, click Show transcript, select it all and copy."
          >
            <Button size="sm" onClick={() => setShowPaste((v) => !v)}>
              <Text width={13} height={13} />
              Paste
            </Button>
          </Option>
        </div>

        {showPaste && (
          <div className="animate-rise mt-3">
            <textarea
              autoFocus
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder={"0:00  so the first thing to understand\n0:04  is that the eye moves in jumps"}
              rows={6}
              className="ring-focus scroll-fine w-full resize-y rounded-xl border border-[var(--hairline)] bg-[var(--field)] p-3.5 font-mono text-[12.5px] leading-relaxed text-ink-100 placeholder:text-ink-500"
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
      </div>

      <p className="mt-5 flex gap-2 text-[11.5px] leading-relaxed text-ink-500">
        <Info width={13} height={13} className="mt-0.5 shrink-0" />
        <span>
          Auto-generated captions arrive with no punctuation at all. ReadLoud puts
          the sentence breaks back using the pauses in the speech, so the narrator
          has somewhere to breathe. Captions written by a human are left exactly
          as they were written.
        </span>
      </p>
    </Dialog>
  );
}

function Option({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--hairline)] px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink-100">{title}</div>
        <p className="mt-0.5 text-[12px] leading-relaxed text-ink-400">{body}</p>
      </div>
      {children}
    </div>
  );
}
