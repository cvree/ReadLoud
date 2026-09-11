/* ────────────────────────────────────────────────────────────────
   Where this copy of ReadLoud lives.

   On a root deployment (`next start`, Vercel, a VPS) this is "" and
   every path below is what it always was. On GitHub Pages the site is
   served from a subdirectory — `/ReadLoud/` — and the absolute URLs
   the app hands to things outside the bundler (the pdf.js worker, the
   onnxruntime WASM binaries, the YouTube helper) have to carry that
   prefix or they resolve to the wrong place and fail at runtime with
   a 404 for a file that is very much deployed.

   `NEXT_PUBLIC_BASE_PATH` is inlined at build time, so this works
   identically on the main thread and inside a worker.
   ──────────────────────────────────────────────────────────────── */

/** "" at the root, "/ReadLoud" on a subdirectory deployment. Never trailing. */
export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");

/** Absolute URL path for a file in `public/`. `asset("/ort/")` → "/ReadLoud/ort/". */
export function asset(path: string): string {
  return `${BASE_PATH}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Origin *and* prefix — the URL another tab should be sent back to.
 * Browser only: there is no origin to speak of during prerender.
 */
export function appBaseUrl(): string {
  return `${window.location.origin}${BASE_PATH}`;
}
