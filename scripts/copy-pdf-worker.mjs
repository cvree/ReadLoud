/**
 * pdf.js ships its worker as a separate bundle. Rather than fight bundler
 * `new URL(...)` resolution across dev/turbopack/webpack/edge, we copy the
 * prebuilt worker into /public and point `workerSrc` at a stable URL.
 * Runs automatically on `npm install` (postinstall).
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const publicDir = join(root, "public");

try {
  const entry = require.resolve("pdfjs-dist/package.json");
  const pkgDir = dirname(entry);
  // The worker must match the build that loads it. `lib/ingest/pdf.ts`
  // imports the legacy bundle for browser compatibility, so ship its worker.
  const candidates = [
    "legacy/build/pdf.worker.min.mjs",
    "legacy/build/pdf.worker.mjs",
    "build/pdf.worker.min.mjs",
  ];
  const found = candidates.map((c) => join(pkgDir, c)).find(existsSync);
  if (!found) throw new Error("no pdf.worker bundle found in pdfjs-dist");
  mkdirSync(publicDir, { recursive: true });
  copyFileSync(found, join(publicDir, "pdf.worker.min.mjs"));
  console.log("[readloud] pdf.js worker -> public/pdf.worker.min.mjs");
} catch (err) {
  console.warn("[readloud] could not copy pdf.js worker:", err.message);
  console.warn("[readloud] PDF ingestion will fail until this is resolved.");
}
