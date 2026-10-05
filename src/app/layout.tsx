import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";

import { SiteHeader, StorageNotice } from "@/components/site-header";

import "./globals.css";

/**
 * Typography (Section 2).
 *
 * Display: Space Grotesk — a geometric sans with the oversized-bold-headline
 *   energy the reference conference sites use, but a cooler, more technical
 *   tone that suits a scientific archive.
 * Body: Inter — highly legible at small sizes and dense in tables, which is
 *   what the researcher/data mode needs. Devanagari arrives in Phase 7 via
 *   Noto Sans Devanagari, loaded alongside rather than replacing Inter, so
 *   Hindi text renders with correct conjuncts and matras.
 */
const display = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const body = Inter({
  variable: "--font-body",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "IndoPolaris — India's Window to the Poles",
    template: "%s · IndoPolaris",
  },
  description:
    "A unified platform for India's polar expeditions, research data and publications — a citable scientific archive and a public science-outreach experience, from the Ministry of Earth Sciences and NCPOR.",
  applicationName: "IndoPolaris",
  keywords: [
    "IndoPolaris",
    "NCPOR",
    "Ministry of Earth Sciences",
    "Antarctica",
    "Arctic",
    "Himalaya",
    "Southern Ocean",
    "polar science",
    "open data",
  ],
  authors: [{ name: "IndoPolaris" }],
  openGraph: {
    type: "website",
    title: "IndoPolaris — India's Window to the Poles",
    description:
      "Expeditions, datasets, publications and outreach from India's national polar research programme.",
    siteName: "IndoPolaris",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-base text-ink">
        <SiteHeader />
        <StorageNotice />
        <main className="mx-auto w-full max-w-7xl flex-1 px-5 py-8">{children}</main>
        <footer className="border-t border-line py-6 text-center text-xs text-muted">
          IndoPolaris · MoES / NCPOR · local prototype build
        </footer>
      </body>
    </html>
  );
}
