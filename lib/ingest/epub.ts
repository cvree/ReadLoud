/* ────────────────────────────────────────────────────────────────
   EPUB ingestion.

   An EPUB is a ZIP with an OPF manifest. We read it directly rather
   than pulling in a full reader library, because all we need is the
   spine order and the text inside each XHTML document.

   Path resolution is the part people get wrong: hrefs in the OPF are
   relative to the OPF's own directory, which is itself named by
   META-INF/container.xml and is *not* always "OEBPS/".
   ──────────────────────────────────────────────────────────────── */

import JSZip from "jszip";
import type { IngestProgress } from "@/lib/types";
import type { Part } from "@/lib/text/assemble";
import { htmlToText } from "./html";

export interface EpubResult {
  parts: Part[];
  meta: { title?: string; author?: string; warnings: string[] };
}

export async function extractEpub(
  data: ArrayBuffer,
  onProgress: (p: IngestProgress) => void,
  signal?: AbortSignal,
): Promise<EpubResult> {
  onProgress({ phase: "parsing", ratio: 0, detail: "Unpacking archive" });
  const zip = await JSZip.loadAsync(data);
  const warnings: string[] = [];

  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) throw new Error("Not a valid EPUB: META-INF/container.xml is missing.");

  const container = parseXml(await containerFile.async("string"));
  const opfPath = container
    .querySelector("rootfile")
    ?.getAttribute("full-path");
  if (!opfPath) throw new Error("Not a valid EPUB: no OPF rootfile declared.");

  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error(`EPUB is corrupt: ${opfPath} is missing.`);
  const opf = parseXml(await opfFile.async("string"));
  const baseDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

  const title = opf.querySelector("metadata > title, title")?.textContent?.trim();
  const author = opf.querySelector("metadata > creator, creator")?.textContent?.trim();

  // manifest id -> href
  const manifest = new Map<string, { href: string; type: string }>();
  for (const el of Array.from(opf.querySelectorAll("manifest > item"))) {
    const id = el.getAttribute("id");
    const href = el.getAttribute("href");
    if (!id || !href) continue;
    manifest.set(id, { href, type: el.getAttribute("media-type") ?? "" });
  }

  // Spine defines reading order. Skip non-linear items (notes, ads).
  const spine = Array.from(opf.querySelectorAll("spine > itemref"))
    .filter((el) => el.getAttribute("linear") !== "no")
    .map((el) => el.getAttribute("idref"))
    .filter((v): v is string => Boolean(v));

  if (spine.length === 0) throw new Error("EPUB has an empty spine — nothing to read.");

  // Chapter titles from the nav document / NCX, keyed by href.
  const titles = await readNavTitles(zip, opf, baseDir, manifest);

  const parts: Part[] = [];
  for (let i = 0; i < spine.length; i++) {
    if (signal?.aborted) throw new DOMException("Ingestion cancelled", "AbortError");

    const entry = manifest.get(spine[i]);
    if (!entry) continue;
    const path = resolvePath(baseDir, entry.href);
    const file = zip.file(path) ?? zip.file(decodeURIComponent(path));
    if (!file) {
      warnings.push(`Spine item "${entry.href}" is declared but missing from the archive.`);
      continue;
    }

    const html = await file.async("string");
    const text = htmlToText(html);
    if (text.trim()) {
      parts.push({
        title: titles.get(entry.href) ?? titles.get(path) ?? fallbackTitle(html, i),
        text,
      });
    }

    if (i % 3 === 0 || i === spine.length - 1) {
      onProgress({
        phase: "parsing",
        ratio: (i + 1) / spine.length,
        detail: `Reading section ${i + 1} of ${spine.length}`,
      });
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  if (parts.length === 0) throw new Error("No readable text found in this EPUB.");
  return { parts, meta: { title, author, warnings } };
}

function fallbackTitle(html: string, i: number): string {
  const m = html.match(/<h[1-3][^>]*>([\s\S]{1,120}?)<\/h[1-3]>/i);
  const t = m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
  return t || `Section ${i + 1}`;
}

async function readNavTitles(
  zip: JSZip,
  opf: Document,
  baseDir: string,
  manifest: Map<string, { href: string; type: string }>,
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();

  // EPUB 3 nav document
  const navItem = Array.from(opf.querySelectorAll("manifest > item")).find((el) =>
    (el.getAttribute("properties") ?? "").split(/\s+/).includes("nav"),
  );
  const navHref = navItem?.getAttribute("href");
  if (navHref) {
    const file = zip.file(resolvePath(baseDir, navHref));
    if (file) {
      const nav = parseXml(await file.async("string"), "text/html");
      for (const a of Array.from(nav.querySelectorAll("nav a[href]"))) {
        const href = (a.getAttribute("href") ?? "").split("#")[0];
        const label = a.textContent?.trim();
        if (href && label) titles.set(href, label);
      }
      if (titles.size) return titles;
    }
  }

  // EPUB 2 NCX fallback
  const ncx = [...manifest.values()].find((m) => m.type === "application/x-dtbncx+xml");
  if (ncx) {
    const file = zip.file(resolvePath(baseDir, ncx.href));
    if (file) {
      const doc = parseXml(await file.async("string"));
      for (const point of Array.from(doc.querySelectorAll("navPoint"))) {
        const href = point.querySelector("content")?.getAttribute("src")?.split("#")[0];
        const label = point.querySelector("navLabel > text")?.textContent?.trim();
        if (href && label) titles.set(href, label);
      }
    }
  }
  return titles;
}

/** Resolve an OPF-relative href, collapsing "../" segments. */
function resolvePath(baseDir: string, href: string): string {
  const stack: string[] = baseDir ? baseDir.replace(/\/$/, "").split("/") : [];
  for (const seg of href.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return stack.join("/");
}

function parseXml(source: string, mime: DOMParserSupportedType = "application/xml"): Document {
  const doc = new DOMParser().parseFromString(source, mime);
  if (doc.querySelector("parsererror") && mime === "application/xml") {
    // Some publishers ship malformed XHTML; the HTML parser is forgiving.
    return new DOMParser().parseFromString(source, "text/html");
  }
  return doc;
}
