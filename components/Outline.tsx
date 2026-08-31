"use client";
/* Document outline: sections with progress, plus a passage jump list for
   the current section. Doubles as the search surface. */

import { useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { formatClock } from "@/lib/audio/pipeline";
import { Book, Doc } from "./ui/Icons";

export function Outline() {
  const doc = useStore((s) => s.doc);
  const chunkIndex = useStore((s) => s.player.chunkIndex);
  const narrator = useStore((s) => s.narrator);
  const rate = useStore((s) => s.rate);
  const [query, setQuery] = useState("");

  /* Aggregate chunks per section once; a 900-page PDF has ~900 sections
     and we do not want to re-scan 8,000 chunks on every render. */
  const sections = useMemo(() => {
    if (!doc) return [];
    const map = new Map<
      string,
      { title: string; first: number; last: number; seconds: number; words: number }
    >();
    for (const c of doc.chunks) {
      const entry = map.get(c.sectionId);
      if (entry) {
        entry.last = c.index;
        entry.seconds += c.estSeconds;
        entry.words += c.words;
      } else {
        map.set(c.sectionId, {
          title: c.sectionTitle,
          first: c.index,
          last: c.index,
          seconds: c.estSeconds,
          words: c.words,
        });
      }
    }
    return [...map.entries()].map(([id, v]) => ({ id, ...v }));
  }, [doc]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections.filter((s) => s.title.toLowerCase().includes(q));
  }, [sections, query]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!doc || q.length < 3) return [];
    const out: Array<{ index: number; text: string; title: string }> = [];
    for (const c of doc.chunks) {
      const at = c.text.toLowerCase().indexOf(q);
      if (at >= 0) {
        out.push({
          index: c.index,
          title: c.sectionTitle,
          text: c.text.slice(Math.max(0, at - 42), at + 90),
        });
        if (out.length >= 60) break;
      }
    }
    return out;
  }, [doc, query]);

  if (!doc) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="hairline-b shrink-0 p-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the document"
          className="ring-focus w-full rounded-xl border border-[var(--hairline)] bg-[var(--field)] px-3 py-2 text-[13px] text-ink-100 placeholder:text-ink-500"
        />
      </div>

      <div className="scroll-fine min-h-0 flex-1 overflow-y-auto p-2">
        {query.trim().length >= 3 && (
          <div className="mb-3">
            <SectionLabel>
              {matches.length >= 60 ? "First 60 matches" : `${matches.length} matches`}
            </SectionLabel>
            {matches.map((m) => (
              <button
                key={m.index}
                onClick={() => narrator.jump(m.index)}
                className="mb-1 block w-full rounded-lg px-2.5 py-2 text-left transition-colors duration-[140ms] hover:bg-[color-mix(in_oklab,white_7%,transparent)]"
              >
                <div className="text-[10px] font-semibold tracking-wide text-iris-400 uppercase">
                  {m.title}
                </div>
                <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-ink-300">
                  {highlight(m.text, query.trim())}
                </div>
              </button>
            ))}
            {matches.length === 0 && (
              <p className="px-2.5 py-3 text-[12px] text-ink-500">No passages contain that.</p>
            )}
          </div>
        )}

        <SectionLabel>
          <span className="flex items-center gap-1.5">
            <Book width={12} height={12} />
            {sections.length.toLocaleString()} sections
          </span>
        </SectionLabel>

        {filtered.map((s) => {
          const active = chunkIndex >= s.first && chunkIndex <= s.last;
          const progress = active
            ? (chunkIndex - s.first + 1) / (s.last - s.first + 1)
            : chunkIndex > s.last
              ? 1
              : 0;
          return (
            <button
              key={s.id}
              onClick={() => narrator.jump(s.first)}
              className={`group relative mb-0.5 block w-full overflow-hidden rounded-lg px-2.5 py-2 text-left transition-colors duration-[140ms] ${
                active
                  ? "bg-[color-mix(in_oklab,var(--color-iris-500)_16%,transparent)]"
                  : "hover:bg-[color-mix(in_oklab,white_6%,transparent)]"
              }`}
            >
              {progress > 0 && (
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 bg-[color-mix(in_oklab,var(--color-iris-500)_11%,transparent)] transition-[width] duration-500"
                  style={{ width: `${progress * 100}%` }}
                />
              )}
              <span className="relative flex items-center gap-2">
                <Doc
                  width={13}
                  height={13}
                  className={active ? "shrink-0 text-iris-400" : "shrink-0 text-ink-500"}
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={`block truncate text-[12.5px] ${active ? "font-medium text-ink-100" : "text-ink-300"}`}
                  >
                    {s.title}
                  </span>
                </span>
                <span className="tabular shrink-0 text-[10.5px] text-ink-500">
                  {formatClock(s.seconds / rate)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 py-2 text-[10.5px] font-semibold tracking-[0.09em] text-ink-500 uppercase">
      {children}
    </div>
  );
}

function highlight(text: string, query: string) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded bg-[color-mix(in_oklab,var(--color-ember-500)_30%,transparent)] px-0.5 text-ink-100">
        {text.slice(at, at + query.length)}
      </mark>
      {text.slice(at + query.length)}
    </>
  );
}
