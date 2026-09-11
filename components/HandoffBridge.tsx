"use client";
/* ────────────────────────────────────────────────────────────────
   Receives a transcript from the browser helper.

   Renders nothing. Mounted once, at the app shell, because a hand-off
   can land whether or not the import dialog is still open - and
   because the tab that receives it is not always the tab that asked.

   The route a transcript travels, and why it is not simpler:

     tab A (this app)  ──opens──▶  tab B (youtube.com)
                                     helper extracts the captions
     tab A  ◀──BroadcastChannel──  tab B, navigated to this origin
                                     carrying the payload in its hash

   The obvious route - `window.opener.postMessage` - is unavailable:
   the app sets `Cross-Origin-Opener-Policy: same-origin` to stay
   cross-origin isolated, which is what lets onnxruntime run inference
   multi-threaded. Trading every reader's synthesis speed for an
   import path would be a bad bargain, so the payload rides in a URL
   fragment (never sent to a server) and is relayed between two
   same-origin tabs instead.
   ──────────────────────────────────────────────────────────────── */

import { useEffect } from "react";
import { useStore } from "@/lib/store";
import { ingestYouTube } from "@/lib/ingest";
import { decodeHandoff, listenForHandoff, relayHandoff, takeHandoffFromUrl } from "@/lib/ingest/youtube";
import { CHUNK_PRESETS } from "@/lib/text/chunk";
import { HELPER_INSTALLED_KEY } from "./LinkImport";

export function HandoffBridge() {
  const setDocument = useStore((s) => s.setDocument);
  const setIngestError = useStore((s) => s.setIngestError);
  const toast = useStore((s) => s.toast);

  useEffect(() => {
    let cancelled = false;

    const open = async (encoded: string) => {
      try {
        const handoff = await decodeHandoff(encoded);
        const doc = ingestYouTube(handoff, {
          chunking: CHUNK_PRESETS[useStore.getState().chunkPreset],
        });
        if (cancelled) return;
        // A hand-off that arrives is proof the helper is installed and
        // working, which is the only reliable way to know.
        try {
          localStorage.setItem(HELPER_INSTALLED_KEY, "1");
        } catch {
          /* private browsing */
        }
        setDocument(doc);
        toast({
          tone: "success",
          title: handoff.title,
          body: `${doc.meta.words.toLocaleString()} words from ${handoff.cues.length.toLocaleString()} caption lines.`,
        });
      } catch (err) {
        if (cancelled) return;
        setIngestError(
          err instanceof Error ? err.message : "That transcript could not be read.",
        );
      }
    };

    /* Are we the tab the helper navigated? */
    const encoded = takeHandoffFromUrl();
    if (encoded) {
      void (async () => {
        const claimed = await relayHandoff(encoded);
        if (cancelled) return;
        if (claimed) {
          // The tab that asked has it. This one was only ever a courier.
          window.close();
          // `close()` is refused for tabs the user opened themselves. If we
          // are still here a moment later, show the transcript rather than
          // leaving them looking at an empty app.
          setTimeout(() => {
            if (!cancelled) void open(encoded);
          }, 400);
          return;
        }
        void open(encoded);
      })();
    }

    const stop = listenForHandoff((payload) => void open(payload));
    return () => {
      cancelled = true;
      stop();
    };
  }, [setDocument, setIngestError, toast]);

  return null;
}
