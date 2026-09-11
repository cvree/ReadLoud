import type { NextConfig } from "next";

/* ────────────────────────────────────────────────────────────────
   Two shapes of the same app.

   A Node host (`next start`, Vercel, Railway) can send headers, so it
   gets the cross-origin isolation that lets onnxruntime run WASM
   inference multi-threaded.

   A static host (GitHub Pages) cannot: `output: "export"` refuses to
   emit headers at all. There the isolation is restored at runtime by
   `public/coi-serviceworker.js`, and the site simply runs single
   threaded on the first load and on browsers without a service
   worker. Nothing breaks either way — it is a speed difference.
   ──────────────────────────────────────────────────────────────── */

const staticExport = process.env.READLOUD_STATIC_EXPORT === "1";
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");

const ISOLATION_HEADERS = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // pdf.js + lamejs are browser-only and ship untranspiled ESM; keep them
  // out of the server bundle graph.
  serverExternalPackages: ["pdfjs-dist"],

  ...(staticExport
    ? {
        output: "export" as const,
        // GitHub Pages serves a project site from /<repo>/. Next uses this
        // for `assetPrefix` too; `lib/base-path.ts` covers the handful of
        // URLs the bundler never sees.
        ...(basePath ? { basePath, assetPrefix: basePath } : {}),
        images: { unoptimized: true },
      }
    : {
        headers: async () => [{ source: "/(.*)", headers: ISOLATION_HEADERS }],
      }),
};

export default nextConfig;
