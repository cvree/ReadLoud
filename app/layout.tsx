import type { Metadata, Viewport } from "next";
import { BASE_PATH } from "@/lib/base-path";
import "./globals.css";

const DESCRIPTION =
  "Open a PDF or EPUB and hear it in an audiobook-grade neural voice, follow along word by word, and export the whole thing as MP3 with a matching transcript. Free, no account, and everything — including the voice — runs in your browser.";

export const metadata: Metadata = {
  title: "ReadLoud - Read anything aloud",
  description: DESCRIPTION,
  applicationName: "ReadLoud",
  manifest: `${BASE_PATH}/manifest.webmanifest`,
  keywords: [
    "text to speech",
    "PDF reader",
    "EPUB",
    "audiobook",
    "MP3 export",
    "transcript",
    "Kokoro TTS",
    "offline TTS",
  ],
  openGraph: {
    type: "website",
    siteName: "ReadLoud",
    title: "ReadLoud - Read anything aloud",
    description: DESCRIPTION,
  },
  twitter: { card: "summary", title: "ReadLoud", description: DESCRIPTION },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#05060a" },
    { media: "(prefers-color-scheme: light)", color: "#f6f5f2" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  // Phones report a viewport that excludes the address bar and then change
  // their mind while you scroll. `viewport-fit` plus `100dvh` is what keeps
  // the transport bar on screen instead of underneath the browser chrome.
  viewportFit: "cover",
};

/**
 * Theme before first paint.
 *
 * The theme lives in localStorage, which React cannot read during
 * prerender — so without this the first frame is always dark and anyone
 * who chose paper mode gets a black flash on every single load. Runs
 * synchronously in <head>, before the body exists.
 */
const THEME_BOOTSTRAP = `
try {
  var stored = localStorage.getItem("readloud.theme");
  var theme = stored === "light" || stored === "dark"
    ? stored
    : (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  document.documentElement.dataset.theme = theme;
} catch (e) {}
`.trim();

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        {/* Restores cross-origin isolation on hosts that cannot send headers.
            A no-op where the headers are already there. See the file itself. */}
        <script src={`${BASE_PATH}/coi-serviceworker.js`} defer />
      </head>
      <body>{children}</body>
    </html>
  );
}
