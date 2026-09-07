import type { Metadata } from 'next';
import { Nunito_Sans, Rubik } from 'next/font/google';
import './globals.css';

const nunitoSans = Nunito_Sans({
  variable: '--font-nunito-sans',
  subsets: ['latin'],
  display: 'swap',
});
const rubik = Rubik({
  variable: '--font-rubik',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? 'http://localhost:3000'),
  title: {
    default: 'Auckland Bargain - Compare supermarket prices',
    template: '%s | Auckland Bargain',
  },
  description:
    'Compare weekly prices for matched grocery products across New Zealand supermarkets.',
  openGraph: {
    title: 'Auckland Bargain',
    description:
      'Compare matched supermarket prices and see what changed since the previous collection.',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'Auckland Bargain grocery price intelligence',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Auckland Bargain',
    description:
      'Compare matched supermarket prices and see what changed since the previous collection.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${nunitoSans.variable} ${rubik.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
