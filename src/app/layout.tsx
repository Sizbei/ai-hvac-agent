import type { Metadata } from "next";
import { Inter, Bricolage_Grotesque } from "next/font/google";
import { MaskedAnalytics } from "@/components/masked-analytics";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
});

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-display",
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
    <html lang="en" className={`${inter.className} ${bricolage.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {children}
        <MaskedAnalytics />
      </body>
    </html>
  );
}
