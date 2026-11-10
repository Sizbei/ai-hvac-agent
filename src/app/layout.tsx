import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import { MaskedAnalytics } from "@/components/masked-analytics";
import "./globals.css";

/** One family for everything. The `wdth` axis carries the condensed micro
 * labels (`.u-label`), so no second display face is loaded. */
const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-archivo",
  display: "swap",
});

/** Mono is mandatory for money, ids, dates, durations, counts, percentages. */
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "HVAC Customer Service",
  description: "AI-powered HVAC service request assistant",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${archivo.variable} ${plexMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {children}
        <MaskedAnalytics />
      </body>
    </html>
  );
}
