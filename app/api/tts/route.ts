/* ────────────────────────────────────────────────────────────────
   /api/tts — the only place an API key is ever touched.

   GET  ?provider=openai            -> { available: boolean }
   GET  ?provider=openai&voices=1   -> { voices: Voice[] }
   POST { provider, text, voiceId, rate } -> audio/mpeg bytes

   Adding a provider is one `case` here plus one entry in
   `lib/tts/cloud.ts`. The client contract does not change.
   ──────────────────────────────────────────────────────────────── */

import { NextResponse } from "next/server";
import type { ProviderId, Voice } from "@/lib/types";

export const runtime = "nodejs";
// Synthesis of a long chunk can exceed the default edge budget.
export const maxDuration = 60;

const MAX_CHARS = Number(process.env.READLOUD_MAX_CHARS_PER_REQUEST ?? 6000);

function keyFor(provider: ProviderId): string | undefined {
  switch (provider) {
    case "openai":
      return process.env.OPENAI_API_KEY || undefined;
    case "elevenlabs":
      return process.env.ELEVENLABS_API_KEY || undefined;
    default:
      return undefined;
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") as ProviderId | null;
  if (!provider) return NextResponse.json({ error: "provider is required" }, { status: 400 });

  const key = keyFor(provider);
  if (!url.searchParams.get("voices")) {
    return NextResponse.json({ available: Boolean(key) });
  }
  if (!key) return NextResponse.json({ voices: [] });

  try {
    if (provider === "elevenlabs") {
      const res = await fetch("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": key },
        cache: "no-store",
      });
      if (!res.ok) return NextResponse.json({ voices: [] });
      const data = (await res.json()) as {
        voices?: Array<{
          voice_id: string;
          name: string;
          labels?: Record<string, string>;
        }>;
      };
      const voices: Voice[] = (data.voices ?? []).map((v) => ({
        id: v.voice_id,
        name: v.name,
        provider: "elevenlabs",
        tag: v.labels?.description ?? v.labels?.use_case ?? v.labels?.accent,
      }));
      return NextResponse.json({ voices });
    }
    // OpenAI has no voice-listing endpoint; the client's catalogue is used.
    return NextResponse.json({ voices: [] });
  } catch {
    return NextResponse.json({ voices: [] });
  }
}

interface SynthBody {
  provider: ProviderId;
  text: string;
  voiceId: string;
  rate?: number;
}

export async function POST(request: Request) {
  let body: SynthBody;
  try {
    body = (await request.json()) as SynthBody;
  } catch {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400 });
  }

  const { provider, voiceId } = body;
  const text = (body.text ?? "").trim();
  const rate = clamp(body.rate ?? 1, 0.25, 4);

  if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });
  if (text.length > MAX_CHARS) {
    return NextResponse.json(
      { error: `text exceeds the ${MAX_CHARS}-character per-request limit.` },
      { status: 413 },
    );
  }
  if (!voiceId) return NextResponse.json({ error: "voiceId is required" }, { status: 400 });

  const key = keyFor(provider);
  if (!key) {
    return NextResponse.json(
      { error: `${provider} is not configured. Add its key to .env.local and restart.` },
      { status: 501 },
    );
  }

  try {
    const audio = await synthesize(provider, { key, text, voiceId, rate });
    return new NextResponse(audio, {
      headers: {
        "content-type": "audio/mpeg",
        "cache-control": "private, max-age=3600",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown synthesis error.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

interface SynthArgs {
  key: string;
  text: string;
  voiceId: string;
  rate: number;
}

async function synthesize(provider: ProviderId, a: SynthArgs): Promise<ArrayBuffer> {
  switch (provider) {
    case "openai": {
      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          authorization: `Bearer ${a.key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini-tts",
          voice: a.voiceId,
          input: a.text,
          response_format: "mp3",
          speed: clamp(a.rate, 0.25, 4),
        }),
      });
      if (!res.ok) throw new Error(await describeFailure(res));
      return res.arrayBuffer();
    }

    case "elevenlabs": {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(a.voiceId)}?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: { "xi-api-key": a.key, "content-type": "application/json" },
          body: JSON.stringify({
            text: a.text,
            model_id: "eleven_multilingual_v2",
            voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.1 },
          }),
        },
      );
      if (!res.ok) throw new Error(await describeFailure(res));
      return res.arrayBuffer();
    }

    default:
      throw new Error(`${provider} cannot synthesize server-side.`);
  }
}

async function describeFailure(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const json = JSON.parse(text) as { error?: { message?: string }; detail?: unknown };
    const msg = json.error?.message ?? (typeof json.detail === "string" ? json.detail : null);
    if (msg) return `${res.status} ${msg}`;
  } catch {
    /* not JSON */
  }
  return `${res.status} ${res.statusText}${text ? ` - ${text.slice(0, 200)}` : ""}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
}
