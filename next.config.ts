import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // pdf.js + lamejs are browser-only and ship untranspiled ESM; keep them
  // out of the server bundle graph.
  serverExternalPackages: ["pdfjs-dist"],
  headers: async () => [
    {
      // Required if you later swap the MP3 encoder for ffmpeg.wasm's
      // multi-threaded build (SharedArrayBuffer). Harmless otherwise.
      source: "/(.*)",
      headers: [
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
      ],
    },
  ],
};

export default nextConfig;
