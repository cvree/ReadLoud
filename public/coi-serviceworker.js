/* ────────────────────────────────────────────────────────────────
   Cross-origin isolation on a host that cannot send headers.

   onnxruntime-web runs its WASM inference multi-threaded only when
   the page is cross-origin isolated, which normally means two
   response headers. A static host (GitHub Pages) has no way to send
   them, and Next.js refuses to emit headers in `output: "export"`
   mode at all.

   A service worker can add them to its own responses, which is what
   this does: same file, two jobs. Loaded as a <script> it registers
   itself; running as the worker it re-serves same-origin responses
   with the isolation headers attached.

   Three deliberate limits:

   - Only *same-origin* responses are touched. The headers only mean
     anything on the document and on our own scripts, and passing an
     86 MB model download through a worker to change nothing would be
     a pure cost.
   - `credentialless` rather than `require-corp`, matching what
     `next.config.ts` sends on a Node host: it is what allows the
     Hugging Face CDN fetch to proceed without that CDN opting in.
   - It reloads the page at most once per tab, ever. A service worker
     that can reload is a service worker that can reload-loop, and a
     reload loop is worse than a slow model.

   Escape hatch: load any page with `?coi=off` to unregister it.
   ──────────────────────────────────────────────────────────────── */

/* global self, window, navigator, location, sessionStorage */

if (typeof window === "undefined") {
  /* ── Running as the service worker ─────────────────────────── */

  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener("message", (event) => {
    if (event.data && event.data.type === "readloud-coi-off") {
      self.registration.unregister().catch(() => {});
    }
  });

  self.addEventListener("fetch", (event) => {
    const request = event.request;
    // A range request replayed out of the HTTP cache; re-fetching it throws.
    if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;

    let url;
    try {
      url = new URL(request.url);
    } catch {
      return;
    }
    // Everything cross-origin goes straight to the network, untouched.
    if (url.origin !== self.location.origin) return;

    event.respondWith(
      fetch(request)
        .then((response) => {
          if (!response || response.status === 0) return response; // opaque
          const headers = new Headers(response.headers);
          headers.set("Cross-Origin-Opener-Policy", "same-origin");
          headers.set("Cross-Origin-Embedder-Policy", "credentialless");
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        })
        // Never fail closed: an error here would take the whole page down.
        .catch(() => fetch(request)),
    );
  });
} else {
  /* ── Running as a page script ──────────────────────────────── */

  (function registerIsolationWorker() {
    // `document.currentScript` is only meaningful while this script is
    // executing; it is null by the time any promise below resolves.
    const selfUrl = document.currentScript && document.currentScript.src;
    const off = new URLSearchParams(location.search).get("coi") === "off";

    if (off) {
      navigator.serviceWorker
        ?.getRegistrations?.()
        .then((regs) => regs.forEach((reg) => reg.unregister()))
        .catch(() => {});
      return;
    }

    // Already isolated: a host that sends the real headers, or a reload that
    // this worker has already fixed. Nothing to install.
    if (window.crossOriginIsolated) return;
    if (!window.isSecureContext || !navigator.serviceWorker || !selfUrl) return;

    const RELOADED = "readloud.coi.reloaded";

    /** One reload per tab, ever — a reload loop is worse than a slow model. */
    function reloadOnce() {
      if (window.crossOriginIsolated) return;
      try {
        if (sessionStorage.getItem(RELOADED)) return;
        sessionStorage.setItem(RELOADED, "1");
      } catch {
        return; // no storage means no loop guard, so do not reload at all
      }
      location.reload();
    }

    navigator.serviceWorker
      .register(selfUrl, { scope: "./" })
      .then(() => {
        // This document was fetched before the worker could touch it, so its
        // headers are still the host's. The worker claims clients on activate;
        // reload once it has, and this page comes back isolated.
        if (navigator.serviceWorker.controller) reloadOnce();
        else {
          navigator.serviceWorker.addEventListener("controllerchange", reloadOnce, {
            once: true,
          });
        }
      })
      .catch(() => {
        /* No isolation, single-threaded inference. The app still works. */
      });
  })();
}
