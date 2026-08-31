<div align="center">

# ReadLoud

**Give anything you read a voice worth listening to.**

Ingest a nine-hundred-page PDF or EPUB, read it aloud with narrator pacing,
follow along word by word, and export the whole thing as an MP3 with a
transcript whose timings actually match the audio.

Everything — parsing, highlighting, MP3 encoding — runs in the browser.

</div>

---

## Quick start

```bash
npm install          # also copies the pdf.js worker into public/
npm run dev          # http://localhost:3000
```

That's it. No API keys, no services. The app works immediately using your
browser's built-in speech engine — open it, click **Try the sample**, press
space.

To unlock studio voices and instant MP3 export:

```bash
cp .env.example .env.local
# add OPENAI_API_KEY and/or ELEVENLABS_API_KEY
npm run dev
```

Keys stay on the server. The browser talks to `/api/tts`, never to a provider.

---

## What it actually does

| | |
|---|---|
| **Ingests** | PDF (pdf.js), EPUB, Markdown, HTML, plain text, pasted text |
| **Reads aloud** | Web Speech API, OpenAI TTS, ElevenLabs — one interface, hot-swappable |
| **Follows along** | Word-level highlighting, sentence bedding, focus mode, auto-scroll |
| **Exports audio** | Real MP3 via LAME in a worker, streaming, faster than realtime |
| **Exports text** | Markdown, plain text, SRT, WebVTT, JSON — with measured timings |

Measured on a synthetic 2,400-page PDF (376,805 words, 38.3 hours of audio),
in Chromium:

| | |
|---|---|
| Ingest → readable | **7.5 s** |
| JS heap, whole book loaded | **36 MB** |
| Cost of one highlight update | **0.57 ms** (~1,700/s; word rate is ~8/s) |
| Full-text search across 588k characters | **~560 ms** |

---

## Project structure

```
app/
  api/tts/route.ts        The only place an API key is ever touched
  globals.css             Design system: tokens, glass, aurora, highlight states
  layout.tsx  page.tsx

lib/
  types.ts                Core domain model — everything flows through these

  ingest/
    index.ts              Façade + format detection by magic bytes
    pdf.ts                pdf.js streaming extraction + geometry reflow
    epub.ts               ZIP → OPF → spine → XHTML, with nav/NCX titles
    html.ts               DOM walk → speakable text

  text/
    normalize.ts          Ligatures, hyphenation, running headers, page numbers
    markdown.ts           Strips markup a speech engine would vocalize
    segment.ts            Sentence segmentation (Intl.Segmenter + abbreviations)
    assemble.ts           Parts → one string, with exact section offsets
    chunk.ts              The chunking algorithm

  tts/
    webspeech.ts          Baseline provider (+ every Chrome/Safari workaround)
    cloud.ts              OpenAI / ElevenLabs behind the same interface
    cache.ts              Clip cache + prefetch — kills the gap between passages
    registry.ts

  player/engine.ts        Narrator: the playback state machine. Framework-free.

  audio/
    mp3-encoder.worker.ts LAME, streaming, off the main thread
    encode.ts             Mp3Recorder — promise-shaped handle over the worker
    decode.ts             Decode, resample, trim, fade, normalize
    pipeline.ts           Synthesize → decode → encode, bounded and in order
    capture.ts            Realtime tab capture (the Web Speech fallback)

  export/
    transcript.ts         TXT / MD / SRT / VTT / JSON
    download.ts

  store.ts                Zustand store binding it all together
  devtools.ts             `window.__readloud` in development

components/
  Workspace.tsx           Shell, top bar, theme, shortcuts
  Landing.tsx             Dropzone, paste, sample
  Reader.tsx              Reading mode + word highlighting
  Outline.tsx             Sections, progress, full-text search
  VoiceStudio.tsx         Engine, voice, pacing, reading preferences
  Transport.tsx           Play/pause/scrub/speed/volume
  ExportDialog.tsx        Audio + transcript export
  ui/                     Button, Slider, Switch, Segmented, Select, Dialog…
```

---

## How the four hard parts work

### 1. Massive PDFs without killing the tab

Three rules keep a 1,200-page scan from filling memory (`lib/ingest/pdf.ts`):

- **Lazy range loading.** `disableAutoFetch: true` makes pdf.js pull byte
  ranges on demand rather than materializing the file.
- **Release every page.** `page.cleanup()` immediately after extracting text,
  then `doc.cleanup()` and `task.destroy()` at the end. pdf.js caches operator
  lists per page and will happily grow to gigabytes otherwise.
- **Yield to the event loop** every few pages, so the progress bar is not a
  lie and cancellation works.

Text is then reconstructed from item **geometry**, not by joining strings:
pdf.js emits one item per glyph run, so a naive join produces either
`T h e   q u i c k` or whole paragraphs run together. We use the transform
matrix — a Y drop past ~1.6× the font size is a paragraph, a smaller drop is a
line, an X gap past ~0.28em is a space.

> **Note:** we import `pdfjs-dist/legacy/build/pdf.mjs`, not the default build.
> pdf.js 6's modern bundle calls `Map.prototype.getOrInsertComputed` and other
> very new APIs; on browsers that lack them, page text extracts but
> `getMetadata()` throws. The legacy build is pdf.js's own answer to this.
> `scripts/copy-pdf-worker.mjs` copies the **matching** worker into `public/`.

Finally, running headers and footers are detected statistically — a line that
appears at the edge of ≥35% of pages, with digits normalized so `Page 12` and
`Page 13` collapse to one key — and removed. Without this the narrator says
the book's title between every paragraph.

### 2. Chunking

`lib/text/chunk.ts`. Chunks exist for four reasons, not one:

1. Every speech engine has an undocumented ceiling. Chrome silently truncates
   long utterances; Safari drops them.
2. Cloud APIs have hard per-request limits and per-request pricing.
3. **Chunks are the unit of seeking.** You cannot scrub into the middle of a
   Web Speech utterance — only start a new one. Small chunks are what make the
   scrubber feel continuous.
4. They bound memory and re-render cost.

Chunks never split a sentence unless a single sentence exceeds the ceiling, in
which case we break on clause punctuation, then whitespace, then hard-wrap.
Three presets (`responsive` / `balanced` / `economical`) trade seek
granularity against API call count; switching one re-chunks from the parsed
text without re-parsing.

### 3. The TTS abstraction

One interface (`lib/types.ts`):

```ts
interface TTSProvider {
  id: ProviderId;
  capabilities: { synthesize; boundaries; rate; pitch; needsKey };
  listVoices(): Promise<Voice[]>;
  speak(req, onBoundary?): SpeechHandle;      // live playback
  synthesize?(req): Promise<{ bytes; mime }>; // offline render → unlocks MP3
  prefetch?(req): void;                       // warm the next passage
}
```

`capabilities.synthesize` is the load-bearing flag: a provider that can return
audio bytes gets the deterministic export pipeline; one that cannot gets the
realtime capture path, and the UI says which you are on.

**To add a provider** (PlayHT, Cartesia, Azure, self-hosted Piper):

1. Add a `case` to `synthesize()` in `app/api/tts/route.ts`.
2. Add a `makeCloudProvider({...})` entry in `lib/tts/cloud.ts`.
3. Register it in `lib/tts/registry.ts`.

Nothing else changes. The player, exporter, transcript generator and UI are
all written against the interface.

### 4. MP3 export

The critical piece, and the one where the obvious implementation fails.

**The naive pipeline** renders every chunk to PCM, concatenates one giant
`Float32Array`, then encodes. For a six-hour audiobook that buffer is
`44100 × 3600 × 6 × 4 × 2 ≈ 7.6 GB` — an instant tab crash.

**This pipeline streams.** Exactly one chunk of PCM exists at a time. Each
decoded chunk is handed to LAME, encoded to MP3 frames, and released. Only the
compressed output accumulates: ~345 MB at 128 kbps, ~170 MB at 64 kbps mono
(plenty for speech). The encoder lives in a worker, so the UI stays smooth.

```
synthesize (network, bounded concurrency)
  → decode + resample to one rate         (WebAudio / OfflineAudioContext)
  → trim provider padding, fade edges, normalize
  → stream into LAME                      (worker)
  → record a real timestamp                (for the transcript)
```

Two properties worth calling out:

- **Bounded concurrency.** Firing 4,000 fetches at once gets you rate-limited.
  A small window runs ahead of the encoder.
- **In-order encoding.** MP3 is a stream; frames must be appended in playback
  order. Synthesis happens out of order for speed, then a reorder buffer feeds
  the encoder strictly sequentially.

Because durations come from decoded sample counts rather than estimates, the
exported SRT/VTT line up with the exported MP3 exactly. (Verified: a 12.43 s
render produced a final cue ending at 12.400 s.)

#### The honest bit about Web Speech

**The Web Speech API exposes no audio stream.** Not a `MediaStream`, not an
`AudioNode`, not a buffer. This is deliberate — the OS voice engine sits
outside the web sandbox — and there is no workaround. You cannot encode what
you cannot read.

So there are exactly two honest paths to a file, and the app offers both:

| | Studio render | Realtime capture |
|---|---|---|
| Providers | OpenAI, ElevenLabs | Any, including system voices |
| Speed | Faster than realtime | Takes as long as the book |
| Accuracy | Sample-accurate timings | Recording of what played |
| Browser | All | Chromium (`getDisplayMedia`) |

Capture uses `getDisplayMedia({ audio: true })` and runs the captured PCM
through the same LAME encoder. The dialog explains the trade-off rather than
pretending the limitation does not exist.

---

## Design notes

Dark by default; a light "paper" mode for daytime reading. Both come from one
set of CSS custom properties — there are no per-theme component styles
anywhere. Three ideas hold it together:

- **Depth through translucency, not borders.** Glass panes over a slow aurora,
  so the app reads as one continuous space instead of a grid of boxes.
- **One accent gradient (violet → cyan), used sparingly — and amber reserved
  exclusively for the spoken word.** Nothing else in the entire UI is amber,
  so your eye finds the cursor instantly.
- **Motion that describes causality.** Every transition is 120–320 ms on one
  easing curve. Nothing bounces, nothing spins for decoration. All of it
  collapses under `prefers-reduced-motion`.

### Why the reader is not virtualized

It was, and the virtualization was deleted. Virtualizing here is a pile of
feedback loops: spacer heights derive from measured heights, measured heights
depend on what is mounted, what is mounted depends on scroll position, and
scroll position depends on spacer heights. The scrollbar lies, hand-scrolling
walks into blank space, and browser find-in-page only searches the paragraphs
that happen to be mounted.

Instead every passage is in the DOM with `content-visibility: auto` and
`contain-intrinsic-size: auto`. The browser skips layout and paint for
off-screen passages while keeping geometry exact — so the scrollbar is
truthful, native scrolling is native, and find-in-page searches all 900 pages.

Word-rate re-rendering is handled by isolation rather than by unmounting: the
list subscribes only to the *passage* index (changes every ~20 s), and exactly
one component — `ActivePassage` — subscribes to the cursor. A word boundary
re-renders one paragraph, measured at 0.57 ms on a 2,743-passage document.

---

## Keyboard

| Key | Action |
|---|---|
| `Space` / `K` | Play / pause |
| `←` / `→` | Back / forward 15 s |
| `Shift` + `←` / `→` | Previous / next passage |
| `J` / `L` | Back / forward 30 s |
| `↑` / `↓` | Volume |
| `[` / `]` | Slower / faster |
| `F` | Focus mode |
| `?` | Shortcuts |
| Double-click a passage | Start reading there |

---

## Development

```bash
npm run dev        # dev server
npm run build      # production build
npm run typecheck  # tsc --noEmit
```

In development, `window.__readloud` is available in the console:

```js
await __readloud.encodeSelfTest()   // sine → LAME → MP3, bitstream verified
__readloud.state()                  // current store snapshot
__readloud.clipCacheStats()
```

`encodeSelfTest()` checks the output is a real MP3 — it scans for MPEG frame
sync words and asserts the size matches the CBR expectation — rather than just
confirming that bytes came out.

### Things that will bite you

- **Web Speech is full of engine bugs.** Chrome kills utterances after ~15 s
  (we pause/resume on a timer), populates `getVoices()` asynchronously and
  sometimes never fires `voiceschanged`, and wedges its queue if you cancel
  from inside an event handler. Safari fires no `boundary` events at all, so
  highlighting falls back to a timed estimator. All handled in
  `lib/tts/webspeech.ts`; read the comments before "simplifying" it.
- **The narrator is owned by the store, not by a component.** Calling
  `narrator.destroy()` from an effect cleanup detaches the store subscription
  permanently under React Strict Mode's double-mount.
- **`decodeAudioData` detaches its input buffer.** Always hand it a copy.
- **Provider switching is generation-guarded.** `listVoices()` can take
  seconds; without the guard a slow response lands last and overwrites the
  selection you just made.

---

## License

MIT.
