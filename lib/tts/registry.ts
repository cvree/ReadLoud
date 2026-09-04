import type { ProviderId, TTSProvider } from "@/lib/types";
import { webSpeechProvider } from "./webspeech";
import { kokoroProvider } from "./kokoro";

/**
 * Order matters: this is the order the engine picker renders, and the first
 * available entry is what a first-time visitor gets. Kokoro leads because it
 * is the one that sounds like an audiobook; Web Speech is the zero-download
 * fallback for a browser without the headroom, or for a reader who does not
 * want to spend 86 MB to hear one paragraph.
 */
export const PROVIDERS: TTSProvider[] = [kokoroProvider, webSpeechProvider];

export function getProvider(id: ProviderId): TTSProvider {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown TTS provider: ${id}`);
  return p;
}

/** Providers this browser can actually run. */
export async function detectAvailableProviders(): Promise<ProviderId[]> {
  const results = await Promise.all(
    PROVIDERS.map(async (p) => ((await p.isAvailable()) ? p.id : null)),
  );
  return results.filter((v): v is ProviderId => v !== null);
}
