# RSVP — reading one word at a time

**Status:** plan. Nothing here is built yet.
**Scope:** a Rapid Serial Visual Presentation mode for ReadLoud, plus the
ingestion work needed to point it at YouTube transcripts.

---

## The thesis

RSVP is not a new subsystem. It is **a second renderer over a cursor ReadLoud
already computes**.

`NarratorState.cursor` is an absolute character offset into `Document.text`,
updated at word rate, and `cursorLength` is the length of the word under it.
`Reader.tsx` renders that as an amber highlight inside a paragraph. RSVP
renders the exact same two numbers as one word in the middle of an empty
screen. The cursor, the seeking, the section handling, the progress bar and the
transport already exist and already work.

That reframing is the whole plan. It also produces the feature nobody else in
this category has:

> Spreeder, AccelaReader, Spritz and Reedy all show you one word at a time in
> silence. ReadLoud can show you one word at a time **with the voice running
> underneath it.** The main documented cost of RSVP is comprehension, and the
> main reason is that it strips prosody and prevents regressions. We can hand
> the prosody back for free.

---

## 1. Two modes, one surface

| | **Voice-synced** | **Silent pacer** |
|---|---|---|
| Driven by | the TTS provider's boundary events | a wall-clock scheduler |
| Speed | 82–495 wpm (`BASE_WPM` 165 × rate 0.5–3) | 150–1200 wpm |
| Cost to build | ~0 — the cursor is already there | one clock, one pacer |
| Comprehension | best in the app: prosody + no eye travel | classic RSVP trade-off |
| Exportable | yes, unchanged | n/a (there is no audio) |

Both render through the same component. The mode selector chooses what moves
the cursor, not what draws it.

**Voice-synced is close to free.** For Kokoro the cursor is already
word-snapped: `lib/tts/buffered.ts` interpolates clip position into a character
index and `snapToWord()` pulls it back to a word boundary on every animation
frame. That is exactly the signal an RSVP display wants. For Web Speech the
boundary events are real. Both work today.

**The ceiling on voice-synced mode is the voice.** `rate` clamps at 3.0, which
is ~495 wpm, and Kokoro's quality degrades before that. Say so in the UI rather
than letting someone drag a WPM dial that silently stops responding.

---

## 2. Architecture: the silent pacer is a `TTSProvider`

**Recommendation:** implement silent RSVP as a provider that makes no sound.

```ts
// lib/rsvp/pacer.ts
export const silentPacer: TTSProvider = {
  id: "silent",
  capabilities: { synthesize: false, boundaries: true, rate: true,
                  pitch: false, local: true, resume: true },
  speak(req, onBoundary) { /* schedule boundary events, emit no audio */ },
  ...
};
```

`Narrator` then drives RSVP with no changes to its control flow, and everything
below comes free:

- chunk advance, gap timing and `stopAtSectionEnd`
- `jump()`, `seekTime()`, `nudge()`, the prefix-sum timeline and binary search
- measured-duration correction — and in silent mode the measurement is *exact*,
  so the scrubber becomes truthful after one passage instead of gradually
- the transport bar, the outline's progress, follow-scroll in the reader behind
  the overlay, and the chunk-preset re-chunk path
- one cursor, so voice mode and silent mode cannot drift apart by construction

**Registration:** keep `silentPacer` out of `PROVIDERS`. It is not a voice and
must not appear in the voice picker, and `capabilities.synthesize: false` would
otherwise offer the realtime-capture export path for something that produces no
sound. The store swaps it in on entering silent mode and restores the previous
provider on exit.

### The WPM ↔ rate bridge

`Narrator` already treats `rate` as a pure time scale: `chunkStart()` divides
the prefix sums by it and `record()` multiplies measurements back by it. So
WPM maps onto it cleanly:

```
narratorRate = wpm / BASE_WPM        // BASE_WPM = 165, lib/text/normalize.ts
600 wpm → 3.64      900 wpm → 5.45
```

`store.setRate()` clamps to 0.5–3.0, which is right for a voice and wrong for a
pacer. Silent mode therefore calls `narrator.update({ rate })` directly and the
store keeps `voiceRate` and `rsvp.wpm` as separate persisted values, restoring
`voiceRate` on exit. The rate slider in Voice Studio stays a voice control; the
WPM dial lives in the RSVP surface.

### The one real engine change: intra-chunk seeking

Stepping back one word is the single most important RSVP affordance — it is the
first con the feature brief lists — and `Narrator` was deliberately built
without it, because you cannot seek into a Web Speech utterance. At `balanced`
chunking a passage is ~900 characters, roughly 150 words, so "restart the
passage" is not an answer.

Three small, honest additions:

```ts
// lib/types.ts
interface SpeakRequest        { startChar?: number }   // best-effort
interface ProviderCapabilities { resume: boolean }     // honors startChar
// lib/player/engine.ts
seekChar(absolute: number): void
```

`seekChar` cancels the current handle and re-runs the chunk from `startChar`
when the provider advertises `resume`, and falls back to the chunk start when
it does not. The silent pacer honors it exactly. Kokoro could honor it later —
its worker already sub-splits chunks before synthesis — which would make
mid-passage seeking work for the voice too. That is a real future win, not a
consolation prize.

> **Gotcha:** `Narrator.record()` must skip any chunk played with
> `startChar > 0`. A half-played passage reports a half duration, and the
> existing sanity guard (`atRateOne < estimate / 8`) will not catch it. One
> rewind would otherwise put a permanent lie in the timeline.

### Alternatives considered

**A standalone `RsvpEngine` that reads `Document.text` directly.** Rejected:
it duplicates the chunk state machine, creates a second cursor that has to be
reconciled with the narrator's on every mode switch, and leaves the transport
bar frozen for the ~20 seconds it takes to cross a passage.

**Registering the pacer in `PROVIDERS`.** Rejected: it puts "no voice" in the
voice picker and offers an export path for silence.

---

## 3. The word pipeline

Four new files under `lib/rsvp/`. All framework-free, in the style of
`lib/player/engine.ts`.

### `tokenize.ts` — offset-preserving tokens

```ts
interface RsvpToken {
  text: string;
  start: number; end: number;      // absolute, into Document.text
  pivot: number;                   // ORP index within text
  flags: { endsSentence, endsClause, endsParagraph, numeric, continued };
}
```

**Invariant:** `doc.text.slice(t.start, t.end) === t.text` for every token.
That is what lets `Esc` drop you back into the reader on the exact word you
stopped at, and it is the first thing the self-test asserts.

Rules that matter, in order of how badly they break the display when missed:

- Trailing punctuation stays attached (`"end."`, `"wait —"`). A lone `.` flashed
  for 60 ms is noise, and the pause it should imply is lost.
- Numbers, decimals, currency and dates stay whole: `$1,234.56`, `3.14`,
  `2026-09-10`. Splitting on `.` here is the classic RSVP bug.
- Hyphenated compounds stay whole up to the width limit.
- A token wider than ~13 characters splits, with a trailing hyphen on all but
  the last piece and `flags.continued` set so the pacer does not add a
  word-boundary pause inside it.
- `\n\n` sets `endsParagraph` on the preceding token.

### `orp.ts` — the pivot

The optimal recognition point sits just left of centre, and holding it in a
fixed screen column is the entire mechanical claim of RSVP: your eye does not
move because it has nothing to find.

| Word length | Pivot index |
|---|---|
| 1 | 0 |
| 2–5 | 1 |
| 6–9 | 2 |
| 10–13 | 3 |
| 14+ | 4 |

### `pacing.ts` — per-word dwell

A flat `60000 / wpm` per word is what makes cheap RSVP implementations
exhausting: punctuation vanishes, so sentences run together and nothing breathes.

| Condition | Multiplier |
|---|---|
| base | 1.00 |
| each character past 8 | +0.04 (capped at 1.6) |
| ends `,` `;` `:` | ×1.45 |
| ends `.` `!` `?` | ×2.10 |
| ends a paragraph | ×2.60 |
| numeric token | ×1.30 |
| first token of a section | ×3.00 |
| `flags.continued` | ×0.80 |

**Normalize the multipliers to a mean of 1.0 across the document**, so the dial
means what it says: at 600 wpm a 6,000-word chapter takes ten minutes. Then show
the measured effective rate next to the dial. A dial that reads 600 and delivers
430 is the kind of thing this codebase's README calls a lie.

### `clock.ts` — drift-free scheduling

- **Absolute schedule, not `setInterval`.** Compute `deadline[i]` in
  `performance.now()` terms once per passage and advance on `requestAnimationFrame`
  while `now >= deadline[i+1]`. Interval-based pacers accumulate drift and lose
  a word every few hundred.
- **Rebase on a stall, never skip.** If a frame gap exceeds ~250 ms (tab
  throttled, GC pause, a Kokoro inference spike), shift the whole schedule
  forward instead of fast-forwarding through the words that came due. Silently
  skipping words is the one failure mode the reader cannot detect.
- **Frame quantization is real above ~900 wpm.** At 1000 wpm a word is 60 ms;
  on a 60 Hz display that is 3.6 frames, so per-word timing quantizes to ±8 ms.
  Cap the dial at 1200, and say what the ceiling is rather than offering 2000.
- **Auto-pause on `visibilitychange`.** rAF stops when the tab is hidden; without
  this the reader comes back to a display that resumed mid-sentence.

---

## 4. The surface

A full-bleed overlay, not a panel. RSVP's premise is that nothing else is on
screen; a word in a sidebar is just a small highlight.

### Centering the pivot

No measurement, no monospace font, no per-glyph math:

```css
.rsvp-word { display: grid; grid-template-columns: 1fr auto 1fr; }
.rsvp-pre  { text-align: right; }
.rsvp-post { text-align: left; }
```

The pivot character is a grid item in the centre column, so it lands on the same
pixel for every word regardless of the glyphs around it.

### Colour

The pivot is **ember**, and no rule has to be invented for it: `globals.css`
already reserves amber exclusively for the spoken word, and in RSVP the pivot is
the spoken word. Everything else on the overlay is ink.

### Comprehension affordances

Both cons in the brief are real and both have answers.

**Regression — "hard to look back."**

- `←` back one word, `→` forward one word
- `Shift + ←` back to the start of the sentence
- `Backspace` replay the last ten words at 70% speed
- **The context ribbon** (default on): the current sentence rendered small and
  dimmed below the pivot, with the active word emphasized. This is the single
  largest comprehension lever available and it costs one `<p>` — the sentence
  spans are already on `Chunk.sentences`.
- Voice mode, which is regression-proof in a different way: you can re-listen.

**Comprehension at speed.**

- **Ramp-up:** start each session at 70% of target and reach it over ~12 words.
  Dropping someone cold into 600 wpm loses the first sentence every time.
- Punctuation-aware dwell (above), which is most of the perceived difference.
- Auto-pause at section boundaries, reusing `stopAtSectionEnd`.
- An honest line in the UI rather than a speed-reading claim. The research
  consensus (Rayner et al., *So Much to Read, So Little Time*, 2016) is that
  RSVP raises rate mainly by preventing regressions — and regressions are
  functional on 10–15% of fixations. Expect a real comprehension cost above
  ~500 wpm on unfamiliar material. Being straight about that is more credible
  than the category norm, and it is the argument for voice-synced mode.

### Motion and safety

- **No per-word fade, slide or scale.** It smears the glyph during the exact
  interval you need to read it, and at 600 wpm a repeating opacity animation is
  a 10 Hz luminance change — squarely in photosensitivity territory. Words cut,
  they do not transition.
- Pause is always visible and always one key (WCAG 2.2.2).
- `prefers-reduced-motion` removes the aurora and the overlay's entry
  transition. It does not remove the words: they are the content.
- The word display gets `aria-live="off"` — a screen reader must not be fed ten
  words a second. Expose the passage text instead.

---

## 5. Controls and keyboard

| Key | RSVP | (today, in the reader) |
|---|---|---|
| `Space` | play / pause | play / pause |
| `←` `→` | ± one word | ± 15 s |
| `Shift + ←` `→` | ± one sentence | ± one passage |
| `↑` `↓` | ± 25 wpm | volume |
| `Backspace` | replay last ten words | — |
| `Esc` | exit to the reader, on the same word | — |
| `R` | enter RSVP | — |

`Transport.tsx` registers its keymap on `window`. Rather than fight listener
ordering with capture-phase handlers, its handler early-returns when
`useStore.getState().rsvp.enabled` — explicit, and greppable.

---

## 6. YouTube transcripts

Worth doing, and the hard part is not parsing.

> **Superseded by [`youtube-ingest.md`](./youtube-ingest.md).** The research
> below was written before checking the current state of YouTube's caption
> endpoints. It is wrong in one important way: option C is not merely a privacy
> trade-off that would at least work. Since YouTube added proof-of-origin (PO)
> tokens, a server-side scrape is also *unreliable* — and datacenter IPs, which
> is every host ReadLoud would deploy to, are challenged first. The path that
> works is a bookmarklet running in the reader's own logged-in browser, where
> the caption URL is same-origin and already carries a live token. See the
> other document for the evidence and the full ladder.

### The constraint

### The constraint

**A browser cannot fetch a YouTube transcript.** Neither `youtube.com/watch` nor
the `timedtext` endpoint sends `Access-Control-Allow-Origin`, so `fetch` from
our origin is blocked before the response is read. There is no client-side
workaround. Every "YouTube transcript" web tool has a server.

| Option | Works | Cost |
|---|---|---|
| **A. Paste the transcript panel** | yes | none — YouTube's own *Show transcript* → select → paste |
| **B. Caption files** (`.vtt` `.srt` `.sbv` `.ttml`) | yes | one ingester; real timings included |
| **C. Server route handler** | yes | breaks the privacy promise, breaks static export, YouTube blocks datacentre IPs, ToS |
| **D. User-supplied CORS proxy** | sometimes | configuration burden, same trust question as C without the control |

**Recommendation: A and B ship first, C is a separately-decided phase 2.**

A and B cost one afternoon each, work offline, and keep the README's central
claim — *nothing you open ever leaves your machine* — intact. C is not a
technical decision but a product one: pasting a URL means the URL leaves the
machine, and that promise is on the landing page.

### `lib/ingest/captions.ts`

Parse `.vtt`, `.srt`, `.sbv` and `.ttml` into `CaptionCue[]`, then into `Part[]`.
Also parse the paste-panel format, which is just `0:12` / `1:02:33` prefixes on
alternating lines.

### The part that actually matters: caption repair

Auto-generated captions are hostile to everything downstream. Raw, they produce
sentence segmentation that fails completely, chunks that break mid-clause, and
RSVP pacing with no punctuation to breathe on — which is precisely the
difference between pleasant and unbearable.

1. **Dedupe the rolling window.** Auto-captions repeat: cue *n* ends with the
   words cue *n+1* opens with. Overlap-match consecutive cues and drop the
   duplicated tail, or the reader hears every phrase twice.
2. **Rejoin into flowing text.** Cue boundaries are display artifacts, not
   sentence boundaries.
3. **Use inter-cue gaps as sentence hints.** A gap over ~700 ms is a stronger
   sentence signal than anything in the text when there is no punctuation, and
   `segmentSentences()` can be seeded with those spans.
4. **Case and punctuation.** Leave the text alone but let the pacer fall back to
   gap-derived pauses when `endsSentence` never fires.

Because cues carry real timestamps, this also unlocks a third RSVP mode later:
**video-synced**, where the words flash in time with the video you have open in
the next tab. Out of scope now; the data model should not preclude it, so
`CaptionCue` keeps its timings through ingestion.

### Also worth having

The same caption ingester makes ReadLoud accept subtitle files generally —
lecture recordings, conference talks, podcasts with transcripts, Zoom exports.
YouTube is the headline; the format is the feature.

---

## 7. What does not change

The export pipeline, the transcript generator, `lib/ingest` (beyond one new
source kind), the chunker, the Kokoro worker and the MP3 encoder are all
untouched. RSVP consumes `Document` and `NarratorState`; it produces nothing
they need to know about.

---

## 8. Risks and gotchas

- **`record()` and partial chunks.** Covered above. This is the one that
  silently corrupts the timeline.
- **Provider swap on mode change** must go through the generation guard in
  `selectProvider`, or a slow `listVoices()` from the real provider can land
  after the swap and overwrite the selection.
- **`content-visibility` behind the overlay.** The reader stays mounted; when
  `Esc` returns, `scrollIntoView` on a passage the browser has skipped needs the
  same care `ActivePassage` already takes.
- **rAF and Kokoro's WASM backend.** On the WASM path inference can block long
  enough to stall the pacer's frames. The stall-rebase rule covers correctness;
  running the pacer's schedule off `performance.now()` rather than frame counts
  is what makes it recoverable.
- **`prefers-reduced-motion` is not a request to stop the words.** Do not wire
  RSVP to it wholesale.
- **The WPM dial is not the rate slider.** Two persisted values, one restore
  path. Easy to get wrong once and confusing forever after.

## 9. Verification

The repo has no test runner — verification here follows the existing
`window.__readloud` devtools idiom (`lib/devtools.ts`), matching
`encodeSelfTest()`, which asserts a property rather than confirming that bytes
came out.

- `__readloud.rsvpTokenRoundTrip()` — every token's offsets slice back to its
  own text out of `doc.text`, and the tokens cover the document with no gaps.
- `__readloud.rsvpDriftTest(wpm, n)` — schedule *n* words, assert cumulative
  drift under 1 word-interval and that exactly *n* words were displayed. Drift
  and skipping are the two failure modes that do not look like failures.
- `__readloud.rsvpPacingReport()` — effective vs. requested WPM across the
  loaded document; the normalization is correct when it lands within 2%.
- Manual: 900-page PDF at 700 wpm for five minutes with the Performance panel
  open — no leak, no dropped words at a section boundary, `Esc` returns to the
  exact word.

## 10. Phases

**Phase 1 — RSVP core.** `lib/rsvp/{tokenize,orp,pacing,clock,pacer}.ts`,
`components/Rsvp.tsx`, the store slice, the three `types.ts` additions and
`Narrator.seekChar`. Both modes, the context ribbon, the keymap. Roughly 700–900
lines; the surface is small, the pacing model is where the time goes.

**Phase 2 — Captions.** `lib/ingest/captions.ts` plus the repair pass and the
paste-panel parser on the landing page. Roughly 300 lines, most of it repair.

**Phase 3 — Polish.** Session stats (words read, effective rate, time saved
against a 250 wpm baseline), multi-word chunks (2–3 per flash, ORP applied to
the group), per-document resume, and the video-sync mode if captions land well.

## 11. Decisions needed

1. **D1 — Serif or sans for the word display?** The reader is serif. RSVP
   convention is sans, and at 60 ms exposure the lower stroke contrast reads
   more reliably. Recommend sans; it is a visible break from the reading view.
2. **D2 — WPM ceiling.** Recommend 1200, with the frame-quantization note
   above ~900. Competitors advertise higher and cannot deliver it.
3. **D3 — Does RSVP get a `ViewMode`, or is it an overlay?** Recommend overlay:
   it is a mode of reading, not a third pane, and it must be able to cover the
   sidebars.
4. **D4 — YouTube option C.** *Revised.* Not just a privacy decision: since PO
   tokens, a server-side scrape is unreliable on exactly the hosts we would
   deploy to. Recommend the bookmarklet path instead — it needs no server, no
   key, and reaches members-only videos no scraper can. See
   [`youtube-ingest.md`](./youtube-ingest.md).
5. **D5 — Voice-synced as the default mode on first open?** It is the
   differentiated one and the honest one; it is also slower, which may read as
   "this isn't speed reading." Recommend defaulting to voice-synced with the
   silent pacer one tap away.
6. **D6 — Does the context ribbon default on?** It measurably helps
   comprehension and it slightly undercuts the "no eye movement" claim.
   Recommend on, with a toggle.
