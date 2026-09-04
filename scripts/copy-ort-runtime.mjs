/**
 * onnxruntime-web loads its WebAssembly binaries at runtime, by URL. Left
 * alone it fetches them from a public CDN, which puts a third party on the
 * critical path of every first synthesis and breaks the app entirely offline.
 *
 * Copying them into /public and pointing `env.wasmPaths` at our own origin
 * (see `lib/tts/kokoro.worker.ts`) removes both problems. Same trick, same
 * reasons, as `copy-pdf-worker.mjs`.
 *
 * Runs automatically on `npm install` (postinstall).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const outDir = join(root, "public", "ort");

try {
  // onnxruntime-web is a transitive dependency of kokoro-js, via
  // @huggingface/transformers; resolve it rather than assuming a hoisted path.
  // Its package.json is not in `exports`, so resolve the entry point instead —
  // every build it publishes already lives in the directory we want.
  const dist = dirname(require.resolve("onnxruntime-web"));
  if (!existsSync(dist)) throw new Error(`no dist directory at ${dist}`);

  // The `.wasm` binaries and the `.mjs` loaders that instantiate them. The
  // threaded JSEP build is what transformers.js asks for on both the WASM and
  // WebGPU backends.
  const wanted = readdirSync(dist).filter((f) => /^ort-wasm.*\.(wasm|mjs)$/.test(f));
  if (!wanted.length) throw new Error("no ort-wasm binaries found in onnxruntime-web/dist");

  mkdirSync(outDir, { recursive: true });
  for (const file of wanted) copyFileSync(join(dist, file), join(outDir, file));

  console.log(`[readloud] onnxruntime wasm -> public/ort/ (${wanted.length} files)`);
} catch (err) {
  console.warn("[readloud] could not copy onnxruntime wasm:", err.message);
  console.warn("[readloud] Kokoro will fall back to the public CDN for its runtime.");
}
