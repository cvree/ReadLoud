import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ReadLoud - Read anything aloud",
  description:
    "Ingest massive PDFs and EPUBs, read them aloud with premium pacing, follow along word by word, and export studio-quality MP3 with a matching transcript. Everything runs in your browser.",
  applicationName: "ReadLoud",
  keywords: ["text to speech", "PDF reader", "EPUB", "audiobook", "MP3 export", "transcript"],
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
