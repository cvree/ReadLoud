"use client";
/* ────────────────────────────────────────────────────────────────
   Opening a document, from wherever the reader happened to drop it.

   This lived inside the landing screen, which meant the drop target
   was the only way in: once a book was open, dragging a second one
   onto the window did nothing at all — the browser navigated away to
   the raw file instead, losing the session. Both the landing zone and
   the whole-window drop handler now come through here, so there is
   one code path, one error surface and one place that remembers to
   cancel the in-flight parse.
   ──────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useRef } from "react";
import { useStore } from "@/lib/store";
import { ingestFile, ingestText } from "@/lib/ingest";
import { CHUNK_PRESETS } from "@/lib/text/chunk";

export function useIngest() {
  const setDocument = useStore((s) => s.setDocument);
  const setIngest = useStore((s) => s.setIngest);
  const setIngestError = useStore((s) => s.setIngestError);
  const chunkPreset = useStore((s) => s.chunkPreset);
  const toast = useStore((s) => s.toast);
  const abort = useRef<AbortController | null>(null);

  /* A parse that is still running when the component goes away would keep
     a 900-page PDF alive and keep writing progress into a dead store. */
  useEffect(() => () => abort.current?.abort(), []);

  const openFile = useCallback(
    async (input: FileList | File[] | File) => {
      const file = input instanceof File ? input : Array.from(input)[0];
      if (!file) return;

      // A second drop while one is parsing: the newest wins, rather than
      // two parses racing to call `setDocument`.
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setIngestError(null);

      try {
        const doc = await ingestFile(file, {
          chunking: CHUNK_PRESETS[chunkPreset],
          onProgress: setIngest,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
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
        if (abort.current === controller) abort.current = null;
      }
    },
    [chunkPreset, setDocument, setIngest, setIngestError, toast],
  );

  const openText = useCallback(
    (text: string, name: string) => {
      if (!text.trim()) return false;
      try {
        const doc = ingestText(text, name, { chunking: CHUNK_PRESETS[chunkPreset] });
        setDocument(doc);
        toast({
          tone: "success",
          title: "Ready to read",
          body: `${doc.meta.words.toLocaleString()} words in ${doc.chunks.length.toLocaleString()} passages.`,
        });
        return true;
      } catch (err) {
        setIngestError(err instanceof Error ? err.message : "Could not read that text.");
        return false;
      }
    },
    [chunkPreset, setDocument, setIngestError, toast],
  );

  const cancel = useCallback(() => abort.current?.abort(), []);

  return { openFile, openText, cancel };
}
