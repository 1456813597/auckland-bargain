import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? "http://localhost:3000"),
  title: "Auckland Bargain — Real grocery deals",
  description: "Find Auckland grocery prices that are genuinely below their recent average.",
  openGraph: {
    title: "Auckland Bargain",
    description: "Real grocery deals, backed by price history.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Auckland Bargain grocery price intelligence" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Auckland Bargain",
    description: "Real grocery deals, backed by price history.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>{children}</body>
    </html>
  );
}
