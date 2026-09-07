import Link from 'next/link';
import { SearchX } from 'lucide-react';

import { SiteHeader } from '@/components/site-header';

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main
        id="main-content"
        className="mx-auto grid min-h-[70dvh] max-w-2xl place-items-center px-4 py-16 text-center"
      >
        <div>
          <SearchX
            className="mx-auto size-10 text-primary"
            aria-hidden="true"
          />
          <h1 className="mt-5 font-heading text-3xl font-bold tracking-[-0.04em]">
            Product not found
          </h1>
          <p className="mt-3 leading-7 text-muted-foreground">
            This product may have left the latest weekly supermarket snapshot.
          </p>
          <Link
            href="/"
            className="mt-6 inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Search current products
          </Link>
        </div>
      </main>
    </>
  );
}
