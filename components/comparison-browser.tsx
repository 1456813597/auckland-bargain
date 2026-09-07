'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ListFilter,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Store,
} from 'lucide-react';

import { ProductImage } from '@/components/product-image';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import type { ProductComparison } from '@/lib/comparisons';
import { money } from '@/lib/deals';
import {
  comparisonSearchParams,
  type ComparisonFilters,
  type ComparisonResults,
  type SortMode,
} from '@/lib/comparison-query';

const ALL = 'all';

function shortDate(value: string | null) {
  if (!value) return 'Sample data';
  return new Intl.DateTimeFormat('en-NZ', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Pacific/Auckland',
  }).format(new Date(value));
}

function priceChangeLabel(value: number | null) {
  if (value === null) return 'No prior observation';
  if (Math.abs(value) < 0.005) return 'No observed change';
  return `${money.format(Math.abs(value))} ${value < 0 ? 'lower' : 'higher'} since prior observations`;
}

function ResultCard({
  product,
  city,
  search,
}: {
  product: ProductComparison;
  city: string;
  search: string;
}) {
  const visibleOffers = product.offers.slice(0, 3);
  const params = new URLSearchParams({ search });
  if (city) params.set('city', city);
  const href = `/product/${product.id}?${params.toString()}`;

  return (
    <Card className="content-auto gap-0 overflow-hidden rounded-xl border-border bg-card py-0 shadow-none transition-colors duration-200 hover:border-primary/45">
      <div className="grid gap-4 p-4 sm:grid-cols-[112px_minmax(0,1fr)_auto] sm:p-5">
        <Link
          href={href}
          prefetch={false}
          className="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-label={`Compare prices for ${product.name}`}
        >
          <ProductImage
            src={product.imageUrl}
            alt={`${product.name} product`}
            sizes="112px"
            className="aspect-square w-full rounded-lg sm:w-28"
          />
        </Link>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-muted-foreground">
            <span>{product.category}</span>
            <span aria-hidden="true">/</span>
            <span>{product.size}</span>
            {product.retailerCount > 1 && (
              <Badge
                variant="outline"
                className="rounded-md border-primary/25 bg-primary/5 text-primary"
              >
                <ShieldCheck data-icon="inline-start" /> Matched{' '}
                {Math.round(product.matchConfidence * 100)}%
              </Badge>
            )}
          </div>
          <Link
            href={href}
            prefetch={false}
            className="mt-1 block rounded-sm font-heading text-lg font-semibold leading-snug tracking-[-0.025em] hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:text-xl"
          >
            {product.name}
          </Link>
          <p className="mt-1 text-sm text-muted-foreground">
            {product.brand} · {product.retailerCount}{' '}
            {product.retailerCount === 1 ? 'supermarket' : 'supermarkets'}
          </p>

          <div className="mt-4 grid gap-2">
            {visibleOffers.map((offer, index) => (
              <div
                key={`${offer.id}-${offer.store}`}
                className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg bg-muted/75 px-3 py-2 text-sm sm:grid-cols-[minmax(120px,0.8fr)_minmax(140px,1.2fr)_auto]"
              >
                <div className="min-w-0 font-semibold">
                  {offer.retailer}
                  <span className="block text-xs font-normal text-muted-foreground">
                    {offer.store}
                  </span>
                  {index === 0 && (
                    <span className="ms-2 text-xs font-bold text-primary">
                      Lowest
                    </span>
                  )}
                </div>
                <span className="hidden truncate text-xs text-muted-foreground sm:block">
                  {offer.promotion}
                </span>
                <strong className="font-mono text-base tabular-nums">
                  {money.format(offer.offerPrice)}
                </strong>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-end justify-between gap-4 border-t pt-4 sm:min-w-32 sm:flex-col sm:items-end sm:justify-start sm:border-s sm:border-t-0 sm:ps-5 sm:pt-0">
          <div className="sm:text-right">
            <span className="text-xs font-semibold text-muted-foreground">
              From
            </span>
            <strong className="block font-heading text-2xl font-bold tracking-[-0.04em] text-primary sm:text-3xl">
              {money.format(product.lowestPrice)}
            </strong>
            <span
              className={`mt-1 block text-xs font-semibold ${
                product.weeklyChange !== null && product.weeklyChange < 0
                  ? 'text-primary'
                  : 'text-muted-foreground'
              }`}
            >
              {priceChangeLabel(product.weeklyChange)}
            </span>
            {product.possibleSaving > 0 && (
              <span className="mt-2 hidden text-xs text-muted-foreground sm:block">
                Save up to {money.format(product.possibleSaving)}
              </span>
            )}
          </div>
          <Link
            href={href}
            prefetch={false}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold whitespace-nowrap text-primary-foreground transition-colors hover:bg-primary/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Compare <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </Card>
  );
}

export function ComparisonBrowser({
  results,
  source,
  updatedAt,
}: {
  results: ComparisonResults;
  source: 'database' | 'local-json' | 'demo';
  updatedAt: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState(results.filters.q);
  const category = results.filters.category || ALL;
  const retailer = results.filters.retailer || ALL;
  const sort = results.filters.sort;
  const matchedOnly = results.filters.matched;
  const [showAllCategories, setShowAllCategories] = useState(false);
  const categories = results.categories.map(([name]) => name);
  const categoryCounts = new Map(results.categories);
  const retailers = results.retailers;
  const navigate = (changes: Partial<ComparisonFilters>) => {
    const filters = { ...results.filters, q: query, page: 1, ...changes };
    const params = comparisonSearchParams(filters);
    startTransition(() =>
      router.push(`/?${params.toString()}#compare`, { scroll: false }),
    );
  };
  const setCategory = (value: string) =>
    navigate({ category: value === ALL ? '' : value });
  const setRetailer = (value: string) =>
    navigate({ retailer: value === ALL ? '' : value });
  const setSort = (value: SortMode) => navigate({ sort: value });

  const clearFilters = () => {
    setQuery('');
    navigate({ q: '', category: '', retailer: '', city: '', matched: false });
  };

  const visibleCategories = showAllCategories
    ? categories
    : categories.slice(0, 7);
  const pageCount = results.totalPages;
  const currentPage = results.filters.page;
  const firstVisibleIndex = (currentPage - 1) * results.filters.limit;
  const paginated = results.products;

  const goToPage = (nextPage: number) => {
    navigate({ page: Math.min(Math.max(nextPage, 1), pageCount) });
  };

  return (
    <>
      <section className="border-b bg-muted/35">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)] lg:items-end lg:px-8">
          <div>
            <p className="text-sm font-bold text-primary">
              New Zealand grocery prices
            </p>
            <h1 className="mt-3 max-w-3xl font-heading text-4xl font-bold leading-[1.05] tracking-[-0.055em] sm:text-5xl lg:text-6xl">
              Find the supermarket with the lowest price.
            </h1>
            <p className="mt-4 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
              Search one product. Compare matched weekly prices from selected
              New Zealand supermarkets.
            </p>
          </div>

          <div className="rounded-xl border bg-card p-3 shadow-[0_12px_30px_oklch(0.3_0.05_150/0.08)]">
            <label htmlFor="product-search" className="px-1 text-sm font-bold">
              What are you shopping for?
            </label>
            <form
              className="mt-2 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                navigate({ q: query });
              }}
            >
              <div className="relative min-w-0 flex-1">
                <Search
                  className="pointer-events-none absolute start-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  id="product-search"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                  }}
                  placeholder="Try Bluebird chips or cat food"
                  className="h-12 rounded-lg ps-10 text-base"
                />
              </div>
              <Button
                className="h-12 shrink-0 rounded-lg px-5"
                type="submit"
                disabled={pending}
              >
                Search
              </Button>
            </form>
            <label
              className="mt-3 block px-1 text-xs font-semibold"
              htmlFor="city-filter"
            >
              Compare stores in
            </label>
            <NativeSelect
              id="city-filter"
              value={results.filters.city}
              onChange={(event) => navigate({ city: event.target.value })}
              className="mt-1 min-h-11 w-full rounded-lg"
            >
              <NativeSelectOption value="">
                All covered locations
              </NativeSelectOption>
              {results.cities.map((city) => (
                <NativeSelectOption key={city} value={city}>
                  {city}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <p className="mt-2 px-1 text-xs leading-5 text-muted-foreground">
              Updated {shortDate(updatedAt)}. Prices may vary by store.
            </p>
          </div>
        </div>
      </section>

      <main
        id="main-content"
        className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8"
      >
        {source !== 'database' && (
          <div className="mb-6 flex items-start gap-3 rounded-lg border border-accent/35 bg-accent/10 px-4 py-3 text-sm">
            <CircleAlert
              className="mt-0.5 size-4 shrink-0 text-accent-foreground"
              aria-hidden="true"
            />
            <p>
              {source === 'demo'
                ? 'Showing sample prices while the live database is not connected.'
                : 'Showing the latest bundled snapshot. Connect Supabase for live weekly results.'}
            </p>
          </div>
        )}

        <div className="grid gap-8 lg:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="hidden lg:block" aria-label="Product filters">
            <div className="sticky top-6 space-y-8">
              <div>
                <h2 className="flex items-center gap-2 font-heading font-semibold">
                  <ListFilter className="size-4" aria-hidden="true" />{' '}
                  Categories
                </h2>
                <div className="mt-3 grid gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setCategory(ALL);
                    }}
                    className={`flex min-h-11 cursor-pointer items-center justify-between rounded-lg px-3 text-left text-sm font-semibold transition-colors ${category === ALL ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                  >
                    All products <span>{results.totalProducts}</span>
                  </button>
                  {visibleCategories.map((item) => {
                    const count = categoryCounts.get(item) ?? 0;
                    return (
                      <button
                        key={item}
                        type="button"
                        onClick={() => {
                          setCategory(item);
                        }}
                        className={`flex min-h-11 cursor-pointer items-center justify-between rounded-lg px-3 text-left text-sm font-semibold transition-colors ${category === item ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                      >
                        <span className="truncate">{item}</span>
                        <span className="ms-3 text-xs opacity-70">{count}</span>
                      </button>
                    );
                  })}
                  {categories.length > 7 && (
                    <button
                      type="button"
                      onClick={() =>
                        setShowAllCategories((current) => !current)
                      }
                      className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-3 text-sm font-semibold text-primary transition-colors hover:bg-muted"
                    >
                      {showAllCategories ? 'Show fewer' : 'Show all categories'}
                      <ChevronDown
                        className={`size-4 transition-transform ${showAllCategories ? 'rotate-180' : ''}`}
                        aria-hidden="true"
                      />
                    </button>
                  )}
                </div>
              </div>

              <div>
                <h2 className="flex items-center gap-2 font-heading font-semibold">
                  <Store className="size-4" aria-hidden="true" /> Supermarkets
                </h2>
                <div className="mt-3 grid gap-1">
                  {[[ALL, 'All supermarkets'], ...retailers].map(
                    ([slug, name]) => (
                      <button
                        key={slug}
                        type="button"
                        onClick={() => {
                          setRetailer(slug);
                        }}
                        className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-3 text-left text-sm font-semibold transition-colors ${retailer === slug ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                      >
                        {retailer === slug && (
                          <Check className="size-4" aria-hidden="true" />
                        )}
                        {name}
                      </button>
                    ),
                  )}
                </div>
              </div>
            </div>
          </aside>

          <section
            id="compare"
            aria-labelledby="results-heading"
            aria-busy={pending}
          >
            <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2
                  id="results-heading"
                  className="font-heading text-2xl font-bold tracking-[-0.035em]"
                >
                  Products and prices
                </h2>
                <p
                  className="mt-1 text-sm text-muted-foreground"
                  aria-live="polite"
                >
                  {pending ? 'Updating… ' : ''}
                  {results.total} {results.total === 1 ? 'product' : 'products'}{' '}
                  found
                  {results.total > 0 && (
                    <>
                      {' '}
                      &middot; Showing {firstVisibleIndex + 1}&ndash;
                      {Math.min(
                        firstVisibleIndex + results.filters.limit,
                        results.total,
                      )}
                    </>
                  )}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:flex">
                <NativeSelect
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                  aria-label="Filter by category"
                  className="min-h-11 rounded-lg lg:hidden"
                >
                  <NativeSelectOption value={ALL}>
                    All categories
                  </NativeSelectOption>
                  {categories.map((item) => (
                    <NativeSelectOption key={item} value={item}>
                      {item}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <NativeSelect
                  value={retailer}
                  onChange={(event) => {
                    setRetailer(event.target.value);
                  }}
                  aria-label="Filter by supermarket"
                  className="min-h-11 rounded-lg lg:hidden"
                >
                  <NativeSelectOption value={ALL}>
                    All supermarkets
                  </NativeSelectOption>
                  {retailers.map(([slug, name]) => (
                    <NativeSelectOption key={slug} value={slug}>
                      {name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <NativeSelect
                  value={sort}
                  onChange={(event) => {
                    setSort(event.target.value as SortMode);
                  }}
                  aria-label="Sort products"
                  className="min-h-11 rounded-lg"
                >
                  <NativeSelectOption value="coverage">
                    Most compared
                  </NativeSelectOption>
                  <NativeSelectOption value="price">
                    Lowest price
                  </NativeSelectOption>
                  <NativeSelectOption value="saving">
                    Biggest saving
                  </NativeSelectOption>
                  <NativeSelectOption value="weekly-drop">
                    Largest observed drop
                  </NativeSelectOption>
                </NativeSelect>
                <Button
                  variant={matchedOnly ? 'default' : 'outline'}
                  onClick={() => {
                    navigate({ matched: !matchedOnly });
                  }}
                  className="min-h-11 rounded-lg"
                  aria-pressed={matchedOnly}
                >
                  <SlidersHorizontal data-icon="inline-start" /> Matched only
                </Button>
              </div>
            </div>

            <div className="mt-5 grid gap-3">
              {paginated.map((product) => (
                <ResultCard
                  key={product.id}
                  product={product}
                  city={results.filters.city}
                  search={comparisonSearchParams(results.filters).toString()}
                />
              ))}
            </div>

            {pageCount > 1 && (
              <nav
                className="mt-6 flex items-center justify-between gap-3 border-t pt-5"
                aria-label="Product result pages"
              >
                <Button
                  variant="outline"
                  className="min-h-11 rounded-lg"
                  disabled={pending || currentPage === 1}
                  onClick={() => goToPage(currentPage - 1)}
                >
                  <ChevronLeft data-icon="inline-start" /> Previous
                </Button>
                <span className="text-sm font-semibold text-muted-foreground">
                  Page {currentPage} of {pageCount}
                </span>
                <Button
                  variant="outline"
                  className="min-h-11 rounded-lg"
                  disabled={pending || currentPage === pageCount}
                  onClick={() => goToPage(currentPage + 1)}
                >
                  Next <ChevronRight data-icon="inline-end" />
                </Button>
              </nav>
            )}

            {results.total === 0 && (
              <div className="mt-5 rounded-xl border border-dashed bg-card px-6 py-14 text-center">
                <Search
                  className="mx-auto size-8 text-muted-foreground"
                  aria-hidden="true"
                />
                <h3 className="mt-4 font-heading text-lg font-semibold">
                  No matching products
                </h3>
                <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                  Try a broader product name or remove one of the active
                  filters.
                </p>
                <Button
                  variant="outline"
                  className="mt-5 rounded-lg"
                  onClick={clearFilters}
                >
                  Clear filters
                </Button>
              </div>
            )}
          </section>
        </div>
      </main>

      <section id="method" className="border-t bg-muted/45">
        <div className="mx-auto grid max-w-7xl gap-6 px-4 py-12 sm:px-6 lg:grid-cols-[0.8fr_1.2fr] lg:px-8">
          <div>
            <ShieldCheck className="size-7 text-primary" aria-hidden="true" />
            <h2 className="mt-4 font-heading text-2xl font-bold tracking-[-0.035em]">
              Same product, checked carefully
            </h2>
            <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
              Supermarkets describe the same item differently. We only combine
              offers when the product identity is strong enough.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ['Barcode first', 'Matching GTINs are accepted as exact.'],
              [
                'Attributes next',
                'Brand, product wording, pack size and category are scored together.',
              ],
              [
                'Conflicts stop',
                'Different sizes or protected variants never auto-merge.',
              ],
            ].map(([title, body]) => (
              <div key={title} className="rounded-xl border bg-card p-5">
                <h3 className="font-heading font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="border-t bg-background">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <p>Independent grocery price comparison for New Zealand shoppers.</p>
          <p>Prices are observations, not purchase guarantees.</p>
        </div>
      </footer>
    </>
  );
}
