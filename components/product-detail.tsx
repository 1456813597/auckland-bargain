import Link from 'next/link';
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarClock,
  Check,
  CircleAlert,
  ShieldCheck,
  Store,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';

import { PriceHistoryChart } from '@/components/price-history-chart';
import { ProductImage } from '@/components/product-image';
import { SiteHeader } from '@/components/site-header';
import { Badge } from '@/components/ui/badge';
import type { ProductComparison } from '@/lib/comparisons';
import { money } from '@/lib/deals';

function checkedDate(value: string | null | undefined) {
  if (!value) return 'Sample snapshot';
  return new Intl.DateTimeFormat('en-NZ', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Pacific/Auckland',
  }).format(new Date(value));
}

function Delta({ value }: { value: number | null }) {
  if (value === null) {
    return <span className="text-muted-foreground">No prior observation</span>;
  }
  if (Math.abs(value) < 0.005) {
    return <span className="text-muted-foreground">No observed change</span>;
  }
  const lower = value < 0;
  const Icon = lower ? TrendingDown : TrendingUp;
  return (
    <span className={lower ? 'text-primary' : 'text-muted-foreground'}>
      <Icon className="me-1 inline size-3.5" aria-hidden="true" />
      {money.format(Math.abs(value))} {lower ? 'lower' : 'higher'}
    </span>
  );
}

export function ProductDetail({
  product,
  related,
  source,
  city = '',
  search = '',
}: {
  product: ProductComparison;
  related: ProductComparison[];
  source: 'database' | 'local-json' | 'demo';
  city?: string;
  search?: string;
}) {
  return (
    <>
      <SiteHeader />
      <main
        id="main-content"
        className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8"
      >
        <Link
          href={`/?${search}#compare`}
          className="inline-flex min-h-11 items-center gap-2 rounded-lg text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <ArrowLeft className="size-4" aria-hidden="true" /> Back to search
        </Link>

        {source !== 'database' && (
          <div className="mt-2 flex items-start gap-3 rounded-lg border border-accent/35 bg-accent/10 px-4 py-3 text-sm">
            <CircleAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <p>
              {source === 'demo'
                ? 'This product uses sample data, not collected supermarket prices.'
                : 'This product is shown from the local fallback snapshot.'}
            </p>
          </div>
        )}

        <section className="mt-5 grid gap-8 border-b pb-10 lg:grid-cols-[360px_minmax(0,1fr)]">
          <ProductImage
            src={product.imageUrl}
            alt={`${product.name} product`}
            sizes="(max-width: 1023px) 100vw, 360px"
            priority
            className="aspect-square w-full rounded-xl border bg-card"
          />

          <div className="flex min-w-0 flex-col justify-center">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-muted-foreground">
              <span>{product.category}</span>
              <span aria-hidden="true">/</span>
              <span>{product.size}</span>
            </div>
            <h1 className="mt-3 max-w-3xl font-heading text-3xl font-bold leading-tight tracking-[-0.045em] sm:text-5xl">
              {product.name}
            </h1>
            <p className="mt-2 text-base text-muted-foreground">
              {product.brand}
            </p>

            <div className="mt-7 grid gap-4 rounded-xl border bg-muted/45 p-5 sm:grid-cols-3">
              <div>
                <span className="text-xs font-semibold text-muted-foreground">
                  Lowest observed price
                </span>
                <strong className="mt-1 block font-heading text-3xl font-bold tracking-[-0.04em] text-primary">
                  {money.format(product.lowestPrice)}
                </strong>
              </div>
              <div>
                <span className="text-xs font-semibold text-muted-foreground">
                  Compared at
                </span>
                <strong className="mt-2 flex items-center gap-2 font-heading text-lg">
                  <Store className="size-4 text-primary" aria-hidden="true" />
                  {product.retailerCount}{' '}
                  {product.retailerCount === 1 ? 'supermarket' : 'supermarkets'}
                </strong>
              </div>
              <div>
                <span className="text-xs font-semibold text-muted-foreground">
                  You could save
                </span>
                <strong className="mt-2 block font-heading text-lg">
                  {product.possibleSaving > 0
                    ? money.format(product.possibleSaving)
                    : 'Best observed offer'}
                </strong>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
              <span className="flex items-center gap-2">
                <CalendarClock className="size-4" aria-hidden="true" /> Checked{' '}
                {checkedDate(product.updatedAt)}
              </span>
              {product.retailerCount > 1 && (
                <span className="flex items-center gap-2 text-primary">
                  <ShieldCheck className="size-4" aria-hidden="true" /> Match
                  confidence {Math.round(product.matchConfidence * 100)}%
                </span>
              )}
            </div>
          </div>
        </section>

        <div className="grid gap-10 py-10 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section aria-labelledby="offers-heading">
            <h2
              id="offers-heading"
              className="font-heading text-2xl font-bold tracking-[-0.035em]"
            >
              Compare supermarkets
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Offers are always ordered by the price a shopper pays.
            </p>

            <div className="mt-5 grid gap-3">
              {product.offers.map((offer, index) => (
                <article
                  key={`${offer.id}-${offer.store}`}
                  className="grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:p-5"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-heading text-lg font-semibold">
                        {offer.retailer}
                      </h3>
                      {index === 0 && (
                        <Badge className="rounded-md">
                          <Check data-icon="inline-start" /> Lowest price
                        </Badge>
                      )}
                      {offer.memberOnly && (
                        <Badge variant="outline">Member price</Badge>
                      )}
                    </div>
                    <p className="mt-1 truncate text-sm text-muted-foreground">
                      {offer.store}
                    </p>
                    <p className="mt-1 text-xs font-semibold text-muted-foreground">
                      {offer.promotion}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Checked {checkedDate(offer.collectedAt ?? null)}
                      {offer.history.at(-2)?.observedAt && (
                        <>
                          {' '}
                          &middot; Prior observation{' '}
                          {checkedDate(offer.history.at(-2)?.observedAt)}
                        </>
                      )}
                    </p>
                  </div>
                  <div className="sm:text-right">
                    <strong className="font-mono text-2xl tabular-nums">
                      {money.format(offer.offerPrice)}
                    </strong>
                    <span className="mt-1 block text-xs font-semibold">
                      <Delta value={offer.weeklyChange} />
                    </span>
                  </div>
                  {offer.sourceUrl ? (
                    <a
                      href={offer.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold whitespace-nowrap text-primary-foreground transition-colors hover:bg-primary/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      Visit store{' '}
                      <ArrowUpRight className="size-4" aria-hidden="true" />
                    </a>
                  ) : (
                    <span className="inline-flex min-h-11 items-center justify-center rounded-lg border px-4 text-sm font-semibold text-muted-foreground">
                      Link unavailable
                    </span>
                  )}
                </article>
              ))}
            </div>
          </section>

          <aside className="space-y-6">
            <section
              className="rounded-xl border bg-card p-5"
              aria-labelledby="history-heading"
            >
              <h2
                id="history-heading"
                className="font-heading text-lg font-semibold"
              >
                Weekly price history
              </h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                We retain the current snapshot and one prior weekly observation.
              </p>
              <div className="mt-4">
                <PriceHistoryChart product={product} />
              </div>
            </section>

            <section
              className="rounded-xl border bg-muted/45 p-5"
              aria-labelledby="match-heading"
            >
              <ShieldCheck className="size-6 text-primary" aria-hidden="true" />
              <h2
                id="match-heading"
                className="mt-3 font-heading text-lg font-semibold"
              >
                Why these offers match
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {product.matchMethod === 'gtin'
                  ? 'The retailer products share the same barcode.'
                  : product.retailerCount > 1
                    ? 'Brand, product wording, pack size and category passed the automatic matching threshold.'
                    : 'This source item remains separate until another supermarket offer passes the matching threshold.'}
              </p>
            </section>
          </aside>
        </div>

        {related.length > 0 && (
          <section className="border-t py-10" aria-labelledby="related-heading">
            <h2
              id="related-heading"
              className="font-heading text-2xl font-bold tracking-[-0.035em]"
            >
              Related products
            </h2>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {related.map((item) => (
                <Link
                  key={item.id}
                  href={`/product/${item.id}?${new URLSearchParams({ city, search }).toString()}`}
                  className="group rounded-xl border bg-card p-3 transition-colors hover:border-primary/45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <ProductImage
                    src={item.imageUrl}
                    alt={`${item.name} product`}
                    sizes="(max-width: 639px) 100vw, 240px"
                    className="aspect-[4/3] rounded-lg"
                  />
                  <h3 className="mt-3 line-clamp-2 font-heading font-semibold leading-snug group-hover:text-primary">
                    {item.name}
                  </h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    From{' '}
                    <strong className="font-mono text-foreground">
                      {money.format(item.lowestPrice)}
                    </strong>
                  </p>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>
    </>
  );
}
