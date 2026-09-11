/* ────────────────────────────────────────────────────────────────
   YouTube hand-off.

   Why there is a hand-off at all, rather than a fetch:

   YouTube's caption endpoints send no `Access-Control-Allow-Origin`,
   so this page cannot fetch them - that has always been true. What is
   newer is that a *server* cannot reliably fetch them either. Caption
   URLs are increasingly stamped `exp=xpe`, meaning they require a
   proof-of-origin token minted at runtime by YouTube's own player
   JavaScript. It is not a cookie; you cannot log in and copy it. A
   request without it gets HTTP 200 and an empty body.

   The one thing that always has a valid token is the reader's own
   browser, on the video page, logged in. So that is where the
   extraction runs - as a bookmarklet or a userscript - and this module
   is the receiving end.

   The hand-off deliberately does not use `window.opener`. The app sets
   `Cross-Origin-Opener-Policy: same-origin` to stay cross-origin
   isolated, which is what lets onnxruntime run WASM inference
   multi-threaded; that header also severs the opener relationship
   across origins. Making every reader's voice slower to import a
   transcript would be a poor trade, so the payload travels in a URL
   fragment instead - which is never sent to any server - and is
   relayed to the tab that asked for it over `BroadcastChannel`.
   ──────────────────────────────────────────────────────────────── */

import type { CaptionCue } from "@/lib/types";

export const HANDOFF_HASH = "yt";
export const RELAY_CHANNEL = "readloud.handoff.v1";
/** Above this the fragment stops being a sane transport; we ask for a paste. */
export const MAX_PAYLOAD_CHARS = 1_500_000;

export interface YouTubeHandoff {
  v: 1;
  videoId: string;
  title: string;
  author?: string;
  lang?: string;
  cues: CaptionCue[];
}

/* ── URLs ────────────────────────────────────────────────────── */

const ID = /^[\w-]{11}$/;

/**
 * Accepts anything a person might paste: a watch URL with tracking junk on
 * it, a share link, a Short, a live URL, an embed, or a bare video id.
 */
export function parseYouTubeUrl(input: string): { videoId: string; start?: number } | null {
  const raw = input.trim();
  if (!raw) return null;
  if (ID.test(raw)) return { videoId: raw };

  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const isYouTube =
    host === "youtube.com" ||
    host === "m.youtube.com" ||
    host === "music.youtube.com" ||
    host === "youtube-nocookie.com" ||
    host === "youtu.be";
  if (!isYouTube) return null;

  let videoId: string | null = null;
  if (host === "youtu.be") {
    videoId = url.pathname.slice(1).split("/")[0] || null;
  } else {
    videoId = url.searchParams.get("v");
    if (!videoId) {
      const m = /^\/(?:shorts|live|embed|v)\/([\w-]{11})/.exec(url.pathname);
      videoId = m?.[1] ?? null;
    }
  }
  if (!videoId || !ID.test(videoId)) return null;

  const t = url.searchParams.get("t") ?? url.searchParams.get("start");
  const start = t ? parseStartTime(t) : undefined;
  return start === undefined ? { videoId } : { videoId, start };
}

function parseStartTime(t: string): number | undefined {
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!m || !m.slice(1).some(Boolean)) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

export function watchUrl(videoId: string, returnOrigin: string): string {
  // The helper reads its instructions out of the fragment, which never leaves
  // the browser. `readloud` names the origin to hand the transcript back to.
  return `https://www.youtube.com/watch?v=${videoId}#readloud=${encodeURIComponent(returnOrigin)}`;
}

/* ── Payload codec ───────────────────────────────────────────── */

/**
 * gzip + base64url. A one-hour talk is roughly 60 KB of text and compresses
 * to about a quarter of that, which sits comfortably inside a fragment; the
 * ceiling exists for the four-hour podcast that does not.
 */
export async function encodeHandoff(payload: YouTubeHandoff): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return toBase64Url(bytes);
}

export async function decodeHandoff(encoded: string): Promise<YouTubeHandoff> {
  const bytes = fromBase64Url(encoded);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(stream).text();
  const data = JSON.parse(text) as unknown;
  return validateHandoff(data);
}

/**
 * The payload arrives from a script running on another origin, so it is
 * checked rather than trusted. It only ever becomes text - the reader renders
 * it through React, which escapes - but a malformed or hostile shape should
 * fail here with a clear message rather than three layers down.
 */
export function validateHandoff(data: unknown): YouTubeHandoff {
  const bad = (why: string): never => {
    throw new Error(`That transcript hand-off was malformed (${why}).`);
  };
  if (typeof data !== "object" || data === null) return bad("not an object");
  const d = data as Record<string, unknown>;
  if (d.v !== 1) return bad("unknown version");
  if (typeof d.videoId !== "string" || !ID.test(d.videoId)) return bad("bad video id");
  if (!Array.isArray(d.cues) || d.cues.length === 0) return bad("no cues");
  if (d.cues.length > 200_000) return bad("implausibly many cues");

  const cues: CaptionCue[] = [];
  for (const raw of d.cues as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.text !== "string" || !c.text.trim()) continue;
    const start = Number(c.start);
    const end = Number(c.end);
    cues.push({
      start: Number.isFinite(start) ? start : 0,
      end: Number.isFinite(end) ? end : 0,
      text: c.text.slice(0, 2000),
    });
  }
  if (cues.length === 0) return bad("no usable cues");

  return {
    v: 1,
    videoId: d.videoId,
    title: typeof d.title === "string" && d.title.trim() ? d.title.slice(0, 300) : "YouTube video",
    author: typeof d.author === "string" ? d.author.slice(0, 200) : undefined,
    lang: typeof d.lang === "string" ? d.lang.slice(0, 16) : undefined,
    cues,
  };
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  // Chunked: `String.fromCharCode(...bytes)` blows the argument limit well
  // before the payload ceiling above.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ── Receiving ───────────────────────────────────────────────── */

/** Pull a hand-off out of `location.hash` and clear it, if one is there. */
export function takeHandoffFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash.startsWith(`${HANDOFF_HASH}=`)) return null;
  const encoded = hash.slice(HANDOFF_HASH.length + 1);
  // Take it out of the address bar immediately: it is large, it is ugly, and
  // leaving it there means a refresh re-imports the same transcript.
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return encoded || null;
}

/**
 * Wire up the tab that asked for the transcript.
 *
 * The helper navigates a *second* tab back to this origin carrying the
 * payload. That tab relays it here over `BroadcastChannel` - same origin, so
 * no COOP involvement - and closes itself. If nobody is listening (the
 * original tab was closed), the second tab keeps the transcript and opens it
 * there instead, so the work is never simply lost.
 */
export function listenForHandoff(onPayload: (encoded: string) => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(RELAY_CHANNEL);
  channel.onmessage = (e: MessageEvent) => {
    const data = e.data as { type?: string; payload?: unknown };
    if (data?.type === "transcript" && typeof data.payload === "string") {
      channel.postMessage({ type: "claimed" });
      onPayload(data.payload);
    }
  };
  return () => channel.close();
}

/**
 * Run on load in the tab the helper navigated. Offers the payload to an
 * existing tab and resolves `true` if one took it, in which case this tab has
 * nothing left to do but close.
 */
export function relayHandoff(encoded: string, waitMs = 400): Promise<boolean> {
  if (typeof BroadcastChannel === "undefined") return Promise.resolve(false);
  return new Promise((resolve) => {
    const channel = new BroadcastChannel(RELAY_CHANNEL);
    let settled = false;
    const finish = (claimed: boolean) => {
      if (settled) return;
      settled = true;
      channel.close();
      resolve(claimed);
    };
    channel.onmessage = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type === "claimed") finish(true);
    };
    channel.postMessage({ type: "transcript", payload: encoded });
    setTimeout(() => finish(false), waitMs);
  });
}
