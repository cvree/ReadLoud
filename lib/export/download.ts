/** Trigger a browser download for a Blob, then release the object URL. */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking synchronously cancels the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function downloadText(content: string, filename: string, mime: string): void {
  download(new Blob([content], { type: `${mime};charset=utf-8` }), filename);
}

/** Filesystem-safe filename derived from a document title. */
export function safeFilename(name: string, extension: string): string {
  const base = name
    .replace(/\.[^.]+$/, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "readloud";
  return `${base}.${extension}`;
}
