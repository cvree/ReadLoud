import type { MetadataRoute } from "next";
import { BASE_PATH } from "@/lib/base-path";

/**
 * Installable, because the whole app already runs offline once the voice
 * model is cached: a reader who uses it daily should be able to keep it in
 * the dock rather than in a tab.
 */
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ReadLoud - Read anything aloud",
    short_name: "ReadLoud",
    description:
      "Read PDFs, EPUBs, articles and transcripts aloud in a neural voice that runs on your own machine.",
    start_url: `${BASE_PATH}/`,
    scope: `${BASE_PATH}/`,
    display: "standalone",
    background_color: "#05060a",
    theme_color: "#05060a",
    icons: [
      {
        src: `${BASE_PATH}/icon.svg`,
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
