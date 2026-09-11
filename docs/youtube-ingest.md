# Getting a YouTube transcript into ReadLoud

**Status:** built. Paths 1-3 below shipped; see `lib/ingest/captions.ts`,
`lib/ingest/youtube.ts` and `public/readloud-helper.user.js`.
**Question:** can a user paste a YouTube URL and have ReadLoud read the video aloud?
**Short answer:** yes — but not by scraping YouTube from our server, and the
reason is new.

---

## 1. What changed: proof-of-origin tokens

Through about 2024 this was easy. You fetched `youtube.com/watch`, pulled
`captionTracks[].baseUrl` out of `ytInitialPlayerResponse`, fetched that URL,
and got XML back. Every "YouTube transcript" tool is built on that.

YouTube has since added **PO tokens** (proof-of-origin) to its bot-detection
stack. The token is generated at runtime by the YouTube player's own JavaScript
(BotGuard), is bound to the video and the session, and expires quickly. It is
not a cookie; you cannot log in and copy it.

The observable symptom: when a caption track's `baseUrl` carries `&exp=xpe`,
fetching it returns **HTTP 200 with an empty body**. No error, no status code
to branch on — just nothing.

| Evidence | |
|---|---|
| `youtube-transcript-api` [#592](https://github.com/jdepoix/youtube-transcript-api/issues/592) | Opened April 2026 against v1.2.4. `PoTokenRequired` on `exp=xpe` tracks. No confirmed workaround; cookies and IP rotation do not help. Affects only tracks whose baseUrl already carries the flag — selective, not universal. |
| `YouTube.js` (youtubei.js) [#1102](https://github.com/LuanRT/YouTube.js/issues/1102) | `youtubei/v1/get_transcript` returning HTTP 400 intermittently since Dec 2025. |
| `yt-dlp` [#16082](https://github.com/yt-dlp/yt-dlp/issues/16082), [#16747](https://github.com/yt-dlp/yt-dlp/issues/16747) | From a GCP IP, all formats unavailable *even with* `bgutil` generating valid PO tokens — YouTube forces SABR and the n-challenge fails. Separately: IP-based blocking. |

Two independent walls, and they compound:

1. **PO token.** Solvable only by running YouTube's player JS. `bgutil-ytdlp-pot-provider`
   does exactly that — it needs a Node runtime and a long-lived server process
   beside your app.
2. **Datacenter IP reputation.** Vercel, Netlify, Railway, Render, Fly and every
   other place ReadLoud would plausibly deploy are datacenter IPs. These are the
   *first* addresses YouTube challenges. Residential proxies are the standard
   answer and they cost more than this app makes.

> **So the plan's original framing was too generous to the server option.** It
> treated a route handler as a privacy trade-off that would at least work. It
> would also be unreliable — and unreliable in the worst way: fine on your
> laptop, degrading in production, breaking on YouTube's schedule rather than
> ours. **Revises D4.**

I could not verify any of this firsthand: `www.youtube.com` is blocked by this
session's egress policy, so the endpoint probes returned proxy 403s rather than
YouTube's own responses. Everything above is from the upstream trackers.

---

## 2. The path that works: let the user's own browser do it

The PO token problem has one clean solution. **The reader's browser already
generates a valid token every time they watch a video.** It is logged in, it is
a residential IP, it is running YouTube's real player JS. Nothing we deploy can
imitate that, and nothing needs to.

So: a bookmarklet (or userscript) that runs *on the YouTube page*, where the
caption URL is same-origin and already carries a live token, and hands the text
to ReadLoud.

The helper reads `ytInitialPlayerResponse.captions`, fetches the caption URL
same-origin (it already carries whatever token the player minted), and hands the
result back.

> **One thing the plan got wrong.** The obvious transport — the helper posting
> to `window.opener` — does not work here. `next.config.ts` sets
> `Cross-Origin-Opener-Policy: same-origin` to keep the page cross-origin
> isolated, which is what lets onnxruntime run WASM inference multi-threaded
> (see the README's deploy section). That header also severs the opener
> relationship across origins. Making every reader's synthesis slower in order
> to import a transcript is a bad trade, so the transport changed rather than
> the header:
>
> ```
> tab A (ReadLoud)  ──opens──▶  tab B (youtube.com)
>                                 helper reads the captions
> tab A  ◀──BroadcastChannel──  tab B, navigated back to our origin
>                                 with the payload gzipped into its hash
> ```
>
> URL fragments are never sent to a server, and the relay is same-origin, so
> COOP never applies. If no tab is listening — the original was closed — the
> courier tab keeps the transcript and opens it itself, so the work is never
> lost.

The payload is validated on arrival rather than trusted: version, video id
shape, cue count and per-cue types are all checked, because it comes from a
script running on another origin.

| | |
|---|---|
| **Works** | yes, for anything the user can watch — including members-only and unlisted videos, which no scraper can reach |
| **Server** | none |
| **API key** | none |
| **Cost** | zero, at any number of users |
| **Privacy** | the URL never leaves their machine; neither does the transcript |
| **Effort** | one click on the video page — fewer clicks than pasting a URL |
| **Timings** | `fmt=json3` gives per-cue millisecond offsets, so video-synced RSVP stays possible |

**Risks.** Bookmarklets are exempt from CSP in current Chrome and Firefox, but
that exemption has wobbled historically — ship a Tampermonkey userscript as the
fallback, where it is not in question. `ytInitialPlayerResponse` is an internal
global and can be renamed; the DOM-scrape of the *Show transcript* panel is the
second fallback, and it is stable because it is what users see.

---

## 3. The full ladder

Ordered by what I'd ship, not by what sounds best.

| | Path | Server | Key | Reliability | Effort |
|---|---|---|---|---|---|
| **1** | **Paste the transcript panel.** YouTube's own *Show transcript* → select → paste. Parse `0:12` / `1:02:33` line prefixes. | none | none | **total** | ✅ shipped |
| **2** | **Caption files.** `.vtt` `.srt` `.sbv` `.ttml` dropped on the existing dropzone. | none | none | **total** | ✅ shipped |
| **3** | **Bookmarklet / userscript.** Section 2. | none | none | high | ✅ shipped |
| **4** | **BYO hosted API key.** User pastes their own key from a transcript vendor; stored in `localStorage`, never ours. URL paste works for those who opt in. | none | user's | vendor's | ~1 day |
| **5** | **Our own route handler + scraper.** | yes | — | **poor, degrading** | ~2 days, then forever |

**Ship 1 and 2 first** — they are an afternoon each, they never break, and they
make ReadLoud accept subtitle files generally: lecture recordings, conference
talks, Zoom exports, podcasts. YouTube is the headline; the format is the feature.

**Then 3**, which is the one that delivers the experience you actually asked for.

**4 is the honest version of "paste a URL."** Vendors (Supadata, TranscriptAPI,
ChocoData and others) work because they run residential proxy pools — they are
paying the cost that makes this hard. Their published success rates are
self-reported marketing, not independent measurement, so treat them as claims.
Pricing seen in September 2026 runs roughly $5–$300/month depending on volume.
As **BYO key** this costs us nothing, keeps the app free and keyless by default,
and puts the bill on the person who wants the convenience.

**5 is the treadmill.** If you want it anyway it is `app/api/transcript/route.ts`
plus a PO-token provider process, and it needs to be built expecting to fail:
feature-flagged, off by default, and falling back to path 1 with a message that
says what happened rather than "something went wrong."

---

## 4. Caption repair — the part that decides whether this feels good

Every path above lands on the same problem, and it is the one that actually
determines quality. Auto-generated captions are hostile to everything
downstream: `segmentSentences()` fails outright, chunks break mid-clause, and
RSVP has no punctuation to breathe on.

1. **Dedupe the rolling window.** Auto-captions repeat — cue *n* ends with the
   words cue *n+1* opens with. Overlap-match consecutive cues and drop the
   duplicated tail, or the narrator says every phrase twice.
2. **Rejoin into flowing text.** Cue boundaries are display artifacts, not
   sentence boundaries.
3. **Gaps as sentence hints.** With no punctuation, an inter-cue gap past
   ~700 ms is a stronger sentence signal than anything in the text.
   `segmentSentences()` can be seeded with those spans.
4. **Leave casing alone.** Let the pacer fall back to gap-derived pauses when
   `endsSentence` never fires.
5. **Keep the timings.** `CaptionCue` carries them through ingestion, which
   leaves video-synced RSVP open later.

`lib/ingest/captions.ts`. Shared by every path above, and covered by `npm test`
— including the case the first implementation got wrong: **contiguous tracks**,
where every cue starts exactly where the last ended. There are no gaps to key
off at all, and a purely gap-driven pass emits one run-on the length of the
video. A run that goes too long now gets a break anyway, placed at the best
scoring boundary rather than wherever the counter ran out.

---

## 5. "And transcribe" — the version that fits this app

If the point is *videos that have no captions at all*, the on-device answer is
better than the server one and it is already ReadLoud's whole personality.

Transformers.js v3 runs **Whisper** in the browser on WebGPU with a WASM
fallback — the same ONNX runtime that is already vendored into `public/ort` for
Kokoro. `onnx-community/whisper-base` is roughly the download Kokoro already
asks for, and `whisper-tiny.en` is a fraction of it.

The catch is the same one as everywhere else: **you cannot get YouTube's audio
from a browser either.** So this applies to media the user has — drop an MP4,
MP3, M4A or WAV on the dropzone, transcribe on-device, read it aloud or RSVP it.

That is a real feature and a clean fit: no server, no key, nothing leaves the
machine, and it reuses the worker and ORT plumbing that already exists. It just
isn't a YouTube feature. Worth scoping separately.

---

## 6. What shipped, and what is left

Shipped: the caption pipeline and repair pass, subtitle-file ingestion, the
paste path (a copied transcript is recognised on sight, so the existing paste
box handles it), the bookmarklet, the userscript, and the two-tab relay.

Left, in the order I would take them:

1. **A real video to test against.** Everything here is verified against
   synthetic fixtures and a scripted browser; `www.youtube.com` was blocked by
   the egress policy of the session that built it, so the helper's contact with
   the live page is the one part not exercised end to end.
2. **BYO-key URL paste**, if literal URL-paste matters for people who will pay
   for it.
3. **Whisper on-device** for local media files — a separate, good feature, and
   the honest answer to "what about videos with no captions".
4. Our own scraper only if 1-3 prove insufficient.

**Sources:** [youtube-transcript-api #592](https://github.com/jdepoix/youtube-transcript-api/issues/592) ·
[YouTube.js #1102](https://github.com/LuanRT/YouTube.js/issues/1102) ·
[yt-dlp #16082](https://github.com/yt-dlp/yt-dlp/issues/16082) ·
[yt-dlp #16747](https://github.com/yt-dlp/yt-dlp/issues/16747) ·
[bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) ·
[Transformers.js v3](https://www.huggingface.co/blog/transformersjs-v3)
