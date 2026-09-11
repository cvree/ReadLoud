<div align="center">

# ReadLoud

**Give anything you read a voice worth listening to.**

Ingest a nine-hundred-page PDF or EPUB, read it aloud with narrator pacing,
follow along word by word, and export the whole thing as an MP3 with a
transcript whose timings actually match the audio.

Everything — parsing, **the neural voice itself**, highlighting, MP3 encoding —
runs in the browser. No account, no API key, no server, no bill. Nothing you
open ever leaves your machine.

### [→ Open ReadLoud](https://cvree.github.io/ReadLoud/)

</div>

---

## Quick start

It is live at **<https://cvree.github.io/ReadLoud/>** — nothing to install.

To run it yourself:

```bash
npm install          # also copies the pdf.js and onnxruntime workers into public/
npm run dev          # http://localhost:3000
```

That's it. There is nothing to configure — no keys, no accounts, no services.
Open it, click **Try the sample**, press space.

The first time you press play, ReadLoud downloads **Kokoro-82M** (~86 MB), an
Apache-2.0 neural text-to-speech model, and runs it locally from then on. The
browser caches it, so it is a one-time cost and the app works fully offline
afterwards. If you would rather not spend the download, switch the engine to
**System voices** — your OS voices, instantly, with nothing to fetch.

---

## What it actually does

| | |
|---|---|
| **Ingests** | PDF (pdf.js), EPUB, Markdown, HTML, plain text, pasted text, subtitles (SRT/VTT/SBV/TTML), YouTube transcripts |
| **Reads aloud** | Kokoro-82M running on-device (WebGPU, or WASM), plus your OS voices — one interface, hot-swappable |
| **Follows along** | Word-level highlighting, sentence bedding, focus mode, auto-scroll |
| **Exports audio** | Real MP3 via LAME in a worker, streaming, faster than realtime |
| **Exports text** | Markdown, plain text, SRT, WebVTT, JSON — with measured timings |
| **Keeps your place** | Reopen the same file and it resumes at the passage you stopped on |
| **Works on a phone** | Every panel is reachable, and it installs as an app |

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
  globals.css             Design system: tokens, glass, aurora, highlight states
  icon.svg  layout.tsx  manifest.ts  page.tsx

lib/
  types.ts                Core domain model — everything flows through these

  ingest/
    index.ts              Façade + format detection by magic bytes
    pdf.ts                pdf.js streaming extraction + geometry reflow
    epub.ts               ZIP → OPF → spine → XHTML, with nav/NCX titles
    html.ts               DOM walk → speakable text
    captions.ts           SRT/VTT/SBV/TTML/json3 → cues → listenable prose
    youtube.ts            Hand-off codec and the two-tab relay
    bookmarklet.ts        The zero-install helper

  text/
    normalize.ts          Ligatures, hyphenation, running headers, page numbers
    markdown.ts           Strips markup a speech engine would vocalize
    segment.ts            Sentence segmentation (Intl.Segmenter + abbreviations)
    assemble.ts           Parts → one string, with exact section offsets
    chunk.ts              The chunking algorithm

  tts/
    kokoro.ts             The on-device neural voice: catalogue + worker bridge
    kokoro.worker.ts      Kokoro-82M itself — ONNX inference, off the main thread
    webspeech.ts          Baseline provider (+ every Chrome/Safari workaround)
    buffered.ts           Playback for providers that return bytes, not speech
    cache.ts              Clip cache + prefetch — kills the gap between passages
    registry.ts  use-model-state.ts

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
  use-ingest.ts           Opening a document, from wherever it was dropped
  base-path.ts            Where this copy is served from (root, or /ReadLoud/)
  devtools.ts             `window.__readloud` in development

components/
  Workspace.tsx           Shell, top bar, theme, shortcuts
  Landing.tsx             Dropzone, paste, sample
  LinkImport.tsx          YouTube import + helper setup
  HandoffBridge.tsx       Receives a transcript from the helper
  Reader.tsx              Reading mode + word highlighting
  Outline.tsx             Sections, progress, full-text search
  VoiceStudio.tsx         Engine, voice, pacing, reading preferences
  Transport.tsx           Play/pause/scrub/speed/volume
  ExportDialog.tsx        Audio + transcript export
  ui/                     Button, Slider, Switch, Segmented, Select, Dialog, Sheet…

public/
  coi-serviceworker.js    Cross-origin isolation on a host that cannot send headers
  readloud-helper.user.js The YouTube helper

.github/workflows/
  deploy.yml              Static export → GitHub Pages, on every push to main
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
2. Neural models have hard input ceilings — Kokoro truncates past 510
   phoneme tokens, silently, which is why the worker sub-splits again
   before synthesis.
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
  capabilities: { synthesize; boundaries; rate; pitch; local };
  listVoices(): Promise<Voice[]>;
  speak(req, onBoundary?): SpeechHandle;      // live playback
  synthesize?(req): Promise<{ bytes; mime }>; // offline render → unlocks MP3
  prefetch?(req): void;                       // warm the next passage
}
```

`capabilities.synthesize` is the load-bearing flag: a provider that can return
audio bytes gets the deterministic export pipeline; one that cannot gets the
realtime capture path, and the UI says which you are on.

**To add a provider:**

1. Implement `TTSProvider`. If it returns audio bytes, `lib/tts/buffered.ts`
   already gives you live playback and an interpolated highlight cursor.
2. Register it in `lib/tts/registry.ts`.

Nothing else changes. The player, exporter, transcript generator and UI are
all written against the interface.

Note the `local` capability. Every provider that ships is `true`, and the UI
promises as much to the reader — a hosted provider could not be added without
contradicting that promise in code, which is the point of the flag.

### 4. A studio voice with nobody's server in the loop

`lib/tts/kokoro.worker.ts`. The model is [Kokoro-82M][kokoro] — 82 million
parameters, StyleTTS2 architecture, Apache-2.0 — served as ONNX and run by
`onnxruntime-web`. It is small enough to download once and good enough that
the output is genuinely audiobook-grade.

Three things this costs, and what is done about each:

**The download.** ~86 MB at int8, fetched once from the Hugging Face CDN and
kept in the browser's Cache API. int8 rather than fp32 (~326 MB) because on a
public website the difference is not "slightly better quality", it is whether
the visitor stays. It begins the moment a document is opened rather than on
page load — nobody who is only looking around should pay 86 MB — so the wait
usually overlaps with the reader finding their place.

**The 510-token ceiling.** `KokoroTTS.generate` truncates longer input
*silently*: hand it a paragraph and the end of it simply never gets spoken, with
no error anywhere. So the worker splits again before synthesis — sentences
first, then clause punctuation, then whitespace, each a worse place to breathe
than the last and each still better than losing the words.

**Backend roulette.** WebGPU is several times faster where it works and quietly
broken where it does not — an adapter can exist and still fail on this graph,
and it fails at *inference*, not at load. So the worker proves the path with a
real generation before reporting ready, and falls back to WASM. A fallback
costs a few seconds; not checking would cost a play button that does nothing.

`onnxruntime`'s WASM binaries are copied into `public/ort` at install time and
served from our own origin, so no third party sits on the critical path.

[kokoro]: https://huggingface.co/hexgrad/Kokoro-82M

### 5. YouTube, and why it needs a helper

`lib/ingest/captions.ts`, `lib/ingest/youtube.ts`, `public/readloud-helper.user.js`.

**A browser cannot fetch a YouTube transcript** — the caption endpoints send no
`Access-Control-Allow-Origin`. That part is old news. What is newer is that **a
server cannot reliably fetch one either**: caption URLs are increasingly stamped
`exp=xpe`, meaning they require a proof-of-origin token that YouTube's player
JavaScript mints at runtime. It is not a cookie, so forwarding a session does
not substitute for it, and a request without one returns HTTP 200 with an empty
body. Datacenter IPs — which is every host this app would deploy to — are
challenged first besides.

The one thing that always holds a valid token is the reader's own browser on
the video page. So the extraction runs there, as a bookmarklet or a userscript,
and the app is the receiving end. It costs no server, no key and no bill, it
works on members-only and unlisted videos that no scraper can reach, and
nothing is uploaded.

**The transport is odd for a reason.** The obvious route —
`window.opener.postMessage` — is unavailable here: `next.config.ts` sets
`Cross-Origin-Opener-Policy: same-origin` to keep the page cross-origin
isolated, which is what lets onnxruntime run inference multi-threaded, and that
header also severs the opener relationship across origins. Trading every
reader's synthesis speed for an import path is a bad bargain, so:

```
tab A (ReadLoud)  ──opens──▶  tab B (youtube.com)
                                helper reads the captions
tab A  ◀──BroadcastChannel──  tab B, navigated back to our origin
                                with the payload gzipped into its hash
```

URL fragments are never sent to a server, and the relay is same-origin, so COOP
never enters into it.

#### The part that decides whether it is listenable

Parsing captions is mechanical. Making them readable is not, and
`repairCaptions` is where the work is:

- **Rolling windows repeat themselves.** A scrolling track emits "the quick
  brown" then "quick brown fox". Joined naively, the narrator says every phrase
  twice. Overlaps of two or more words are trimmed; one word is left alone,
  because "…and then" / "then we…" is ordinary speech, not a scroll.
- **Cue boundaries are not sentence boundaries.** They are line breaks in a box
  at the bottom of a video, and treating them as sentences gives the chunker a
  break every four words.
- **Auto-captions have no punctuation at all.** Nothing to segment on, nothing
  to breathe on. Sentence breaks are put back from the pauses in the speech —
  the pause *is* the punctuation, so this is transcribing it rather than
  inventing it. It runs **only** on tracks that had essentially no punctuation
  of their own; anything human-written is left exactly as written.

Contiguous tracks — cue *n* ending exactly where *n+1* starts — are common and
have no pauses to key off, so a run that goes too long without a break gets one
anyway, placed at the best available boundary rather than wherever the counter
ran out. "Best" is scored crudely: a real gap dominates, breaking before a
discourse marker ("so", "now", "but") is rewarded, and breaking after a word
that cannot end a sentence ("of", "the", "is") is penalised.

`npm test` covers all of this, including that no words are lost or duplicated.

### 6. MP3 export

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

- **Bounded concurrency.** A small window runs ahead of the encoder. With an
  on-device model the limit is memory and cores rather than a rate limiter —
  the worker serializes inference anyway, since parallel ONNX sessions only
  multiply peak memory.
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
| Providers | Kokoro | Any, including system voices |
| Speed | Faster than realtime | Takes as long as the book |
| Accuracy | Sample-accurate timings | Recording of what played |
| Browser | All | Chromium (`getDisplayMedia`) |

Capture uses `getDisplayMedia({ audio: true })` and runs the captured PCM
through the same LAME encoder. The dialog explains the trade-off rather than
pretending the limitation does not exist.

---

## Design notes

Dark by default, unless your system asks for light — a first visit follows
`prefers-color-scheme`, and after that it follows whatever you last chose. An
inline script in `app/layout.tsx` applies it before first paint, so the paper
theme never opens with a black flash. Both themes come from one set of CSS
custom properties; there are no per-theme component styles anywhere. Three
ideas hold it together:

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
| `/` | Search the document |
| `Esc` | Close whatever is open |
| `?` | Shortcuts |
| Double-click a passage | Start reading there |

---

## Development

```bash
npm run dev          # dev server
npm run build        # production build (Node host)
npm run build:static # static export → out/ (GitHub Pages and friends)
npm run typecheck    # tsc --noEmit
npm test             # caption ingestion tests - no framework, no dependency
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

## Deploy

The app has no server, no database, no API routes and no secrets, so every
target below is free and none of them need configuring.

### GitHub Pages (what this repo does)

`.github/workflows/deploy.yml` builds a static export and publishes it on every
push to `main`. There is nothing to set up — the workflow turns Pages on the
first time it runs — and nothing to add afterwards.

Two details it takes care of, both of which would otherwise break the site:

**The subdirectory.** A project page is served from `/<repo>/`, not the root,
so `assetPrefix` alone is not enough: the pdf.js worker, the onnxruntime WASM
binaries and the YouTube hand-off URL are all handed to things the bundler
never sees. `lib/base-path.ts` is where that prefix lives, fed by
`NEXT_PUBLIC_BASE_PATH`, which the workflow fills in from the Pages API.

**The headers.** `output: "export"` cannot emit headers at all, and a static
host would not send them anyway — so a static deployment loses the
cross-origin isolation that lets onnxruntime run WASM inference
multi-threaded. `public/coi-serviceworker.js` puts it back: a service worker
re-serves same-origin responses with `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: credentialless`, the same pair
`next.config.ts` sends on a Node host. It reloads the page at most once per
tab, ever, and where it cannot run at all the app is simply single-threaded.
Load any page with `?coi=off` to unregister it.

To build the same thing locally:

```bash
NEXT_PUBLIC_BASE_PATH=/ReadLoud npm run build:static   # → out/
```

### Vercel (zero config)

*Add New → Project*, import the repo, deploy. No environment variables. This
path runs `next start`, so the isolation headers come from `next.config.ts`
and the service worker stands down on its own.

### Cloudflare Pages / Netlify

Build `npm run build`, and use the platform's Next.js adapter.

### Any Node host

Railway, Render, Fly.io, a VPS: `npm ci && npm run build && npm start`.

### Why cross-origin isolation is worth this much trouble

`Cross-Origin-Opener-Policy: same-origin` plus
`Cross-Origin-Embedder-Policy: credentialless` make the page *cross-origin
isolated*, which is what lets `onnxruntime-web` use `SharedArrayBuffer` and
run WASM inference on several threads. Without it synthesis still works —
WebGPU does not need it at all — but the WASM fallback path is noticeably
slower, which on a long book is the difference between the narrator keeping up
and the narrator stopping to think.

## License

MIT.
