import type { Metadata, Viewport } from "next";
import "./globals.css";

const DESCRIPTION =
  "Open a PDF or EPUB and hear it in an audiobook-grade neural voice, follow along word by word, and export the whole thing as MP3 with a matching transcript. Free, no account, and everything — including the voice — runs in your browser.";

export const metadata: Metadata = {
  title: "ReadLoud - Read anything aloud",
  description: DESCRIPTION,
  applicationName: "ReadLoud",
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
  themeColor: "#05060a",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
