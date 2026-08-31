import type { ProviderId, TTSProvider } from "@/lib/types";
import { webSpeechProvider } from "./webspeech";
import { elevenLabsProvider, openAIProvider } from "./cloud";

export const PROVIDERS: TTSProvider[] = [
  webSpeechProvider,
  openAIProvider,
  elevenLabsProvider,
];

export function getProvider(id: ProviderId): TTSProvider {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown TTS provider: ${id}`);
  return p;
}

/** Providers whose keys are actually configured on the server right now. */
export async function detectAvailableProviders(): Promise<ProviderId[]> {
  const results = await Promise.all(
    PROVIDERS.map(async (p) => ((await p.isAvailable()) ? p.id : null)),
  );
  return results.filter((v): v is ProviderId => v !== null);
}
