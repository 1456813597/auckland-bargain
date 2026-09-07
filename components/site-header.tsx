import Link from 'next/link';
import { Clock3, MapPin } from 'lucide-react';

export function SiteHeader() {
  return (
    <>
      <a
        href="#main-content"
        className="sr-only z-50 rounded-lg bg-primary px-4 py-3 font-semibold text-primary-foreground focus:not-sr-only focus:fixed focus:start-4 focus:top-4"
      >
        Skip to main content
      </a>
      <header className="border-b border-border/80 bg-background/95">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <Link
            href="/"
            className="flex min-h-11 items-center gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            aria-label="Auckland Bargain home"
          >
            <span className="grid size-9 place-items-center rounded-lg bg-primary font-heading text-sm font-bold text-primary-foreground">
              AB
            </span>
            <span className="font-heading text-lg font-semibold tracking-[-0.025em]">
              Auckland Bargain
            </span>
          </Link>

          <nav className="hidden items-center gap-6 text-sm font-semibold text-muted-foreground md:flex">
            <Link
              className="transition-colors hover:text-foreground"
              href="/#compare"
            >
              Compare prices
            </Link>
            <Link
              className="transition-colors hover:text-foreground"
              href="/#method"
            >
              How matching works
            </Link>
          </nav>

          <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
            <span className="hidden items-center gap-1.5 sm:flex">
              <MapPin className="size-4" aria-hidden="true" /> New Zealand
            </span>
            <span className="flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5">
              <Clock3 className="size-3.5" aria-hidden="true" /> Weekly
            </span>
          </div>
        </div>
      </header>
    </>
  );
}
