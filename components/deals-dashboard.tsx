'use client';

import Image from 'next/image';
import { useMemo, useState } from 'react';
import {
  ArrowDownRight,
  Bell,
  Check,
  Clock3,
  Flame,
  RefreshCw,
  Search,
  ShoppingBasket,
  SlidersHorizontal,
  Sparkles,
  Store,
  TrendingDown,
  X,
} from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from 'recharts';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { dealOfferPrice, discountPercent, money, type Deal } from '@/lib/deals';
import { isMultiBuyPromotion, multiBuyOffer } from '@/lib/retailer-pricing';

type CategoryFilter = string;
type RetailerFilter = string;
type SortMode = 'score' | 'saving' | 'price';

const ALL_RETAILERS = 'All supermarkets';

export type DealsMeta = {
  demo: boolean;
  source: 'database' | 'local-json' | 'demo';
  updatedAt: string | null;
};

export type DealsPayload = {
  data: Deal[];
  meta: DealsMeta;
};

async function fetchCurrentDeals(signal?: AbortSignal) {
  const response = await fetch('/api/deals', {
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error('Deals request failed');
  return response.json() as Promise<DealsPayload>;
}

const chartConfig = {
  price: { label: 'Price', color: 'var(--color-primary)' },
} satisfies ChartConfig;

const retailerLogos = {
  paknsave: {
    src: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c0/Pak%27nSave_Logo_10.2024.svg/960px-Pak%27nSave_Logo_10.2024.svg.png',
    width: 110,
    height: 26,
  },
  newWorld: {
    src: 'https://upload.wikimedia.org/wikipedia/en/thumb/f/f4/New_World_%28nz%29_Logo_10.2024.svg/960px-New_World_%28nz%29_Logo_10.2024.svg.png',
    width: 110,
    height: 24,
  },
  woolworths: {
    src: 'https://upload.wikimedia.org/wikipedia/en/7/7a/Woolworths_New_Zealand_logo.png',
    width: 116,
    height: 29,
  },
} as const;

function retailerLogo(retailer: string) {
  const normalized = retailer.toLocaleLowerCase('en-NZ');
  if (normalized.includes('pak')) return retailerLogos.paknsave;
  if (normalized.includes('new world')) return retailerLogos.newWorld;
  return retailerLogos.woolworths;
}

function DealCard({
  deal,
  onOpen,
}: {
  deal: Deal;
  onOpen: (deal: Deal) => void;
}) {
  const saving = discountPercent(deal);
  const logo = retailerLogo(deal.retailer);
  const multiBuy = multiBuyOffer(deal.promotion);
  const imageIsStoredInBlob = deal.imageUrl?.includes(
    '.public.blob.vercel-storage.com/',
  );

  return (
    <Card className="group relative isolate min-h-84 gap-0 overflow-hidden rounded-[1.35rem] bg-[#263b31] py-0 text-white shadow-[0_14px_36px_oklch(0.2_0.04_145/0.12)] ring-white/12 transition-[transform,box-shadow] duration-300 hover:-translate-y-1 hover:shadow-[0_20px_46px_oklch(0.2_0.04_145/0.22)]">
      {deal.imageUrl ? (
        <Image
          src={deal.imageUrl}
          alt={`${deal.name} product photo`}
          fill
          sizes="(max-width: 639px) 100vw, (max-width: 1023px) 50vw, (max-width: 1279px) 33vw, 25vw"
          unoptimized={!imageIsStoredInBlob}
          className="-z-20 object-cover object-center transition-transform duration-500 group-hover:scale-[1.035]"
        />
      ) : (
        <div
          className="absolute inset-0 -z-20 grid place-items-center bg-[radial-gradient(circle_at_70%_18%,rgb(255_255_255/.38),transparent_34%),linear-gradient(145deg,var(--fallback-color),#263b31)]"
          style={{ '--fallback-color': deal.color } as React.CSSProperties}
          aria-hidden="true"
        >
          <span className="font-heading text-7xl font-black text-white/20">
            {deal.brand.slice(0, 2).toUpperCase()}
          </span>
        </div>
      )}
      <div className="absolute inset-0 -z-10 bg-[linear-gradient(180deg,rgb(18_30_24/.12)_0%,rgb(18_30_24/.42)_40%,rgb(18_30_24/.96)_100%),linear-gradient(90deg,rgb(18_30_24/.46),transparent_70%)]" />
      <div className="pointer-events-none absolute inset-px rounded-[calc(1.35rem-1px)] ring-1 ring-inset ring-white/15" />

      <div className="flex min-h-84 flex-1 flex-col justify-between p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="grid h-10 min-w-28 place-items-center rounded-xl bg-white/94 px-3 shadow-[inset_0_1px_0_rgb(255_255_255/.75),0_8px_22px_rgb(18_30_24/.16)] backdrop-blur-md">
            <Image
              src={logo.src}
              alt={`${deal.retailer} logo`}
              width={logo.width}
              height={logo.height}
              unoptimized
              className="max-h-7 w-auto object-contain"
            />
          </div>
          <span className="rounded-lg border border-white/18 bg-[#17261f]/58 px-2.5 py-1.5 font-mono text-xs font-bold text-white shadow-[inset_0_1px_0_rgb(255_255_255/.12)] backdrop-blur-md">
            {deal.score}/100
          </span>
        </div>

        <div>
          <Badge className="mb-3 border border-white/15 bg-white/14 text-white shadow-[inset_0_1px_0_rgb(255_255_255/.14)] backdrop-blur-md hover:bg-white/14">
            {deal.promotion}
          </Badge>
          <h3 className="font-heading text-xl font-bold leading-tight tracking-[-0.025em] text-white">
            {deal.name}
          </h3>
          <p className="mt-1 text-xs font-medium text-white/72">
            {deal.size} / {deal.category}
          </p>

          <div className="mt-4 flex items-end justify-between gap-4 border-t border-white/16 pt-4">
            <div>
              <strong className="font-heading text-4xl tracking-[-0.055em] text-white">
                {money.format(deal.price)}
              </strong>
              {multiBuy && (
                <p className="mt-0.5 text-[11px] font-semibold text-[#ffd36a]">
                  Single item · {money.format(multiBuy.unitPriceCents / 100)} ea
                  when buying {multiBuy.quantity}
                </p>
              )}
              <p className="mt-1 text-xs text-white/68">
                90-day avg {money.format(deal.average90d)}
              </p>
              {deal.memberOnly && (
                <span className="mt-1 block text-[11px] font-semibold text-[#ffd36a]">
                  Membership required
                </span>
              )}
            </div>
            <div className="flex items-end gap-3">
              <div className="text-right">
                <span className="font-mono text-xl font-bold text-[#ffd36a]">
                  -{saving}%
                </span>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-white/62">
                  vs average
                </p>
              </div>
              <Button
                variant="secondary"
                size="icon"
                className="size-11 shrink-0 rounded-xl bg-white text-[#263b31] shadow-[0_6px_18px_rgb(18_30_24/.2)] hover:bg-white/90 active:scale-[0.98]"
                aria-label={`View ${deal.name} price history`}
                onClick={() => onOpen(deal)}
              >
                <ArrowDownRight />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

function DealDetail({
  deal,
  onClose,
}: {
  deal: Deal | null;
  onClose: () => void;
}) {
  if (!deal) return null;
  const saving = discountPercent(deal);
  const hasMultiBuy = isMultiBuyPromotion(deal.promotion);

  return (
    <Dialog open={Boolean(deal)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto rounded-[1.4rem] p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-foreground/8 p-5 pr-14">
          <div className="flex items-center gap-2">
            <Badge className="bg-primary/10 text-primary hover:bg-primary/10">
              Deal score {deal.score}
            </Badge>
            {deal.memberOnly && <Badge variant="outline">Member price</Badge>}
            {hasMultiBuy && <Badge variant="outline">Multibuy available</Badge>}
          </div>
          <DialogTitle className="mt-2 text-2xl font-bold tracking-tight">
            {deal.name}
          </DialogTitle>
          <DialogDescription>
            {deal.size} · {deal.store}
          </DialogDescription>
        </DialogHeader>

        <div className="p-5">
          <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl bg-foreground/10 ring-1 ring-foreground/10">
            {[
              [hasMultiBuy ? 'Single item' : 'Today', money.format(deal.price)],
              ['90-day avg', money.format(deal.average90d)],
              ['90-day low', money.format(deal.low90d)],
            ].map(([label, value]) => (
              <div key={label} className="bg-background p-3 text-center">
                <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {label}
                </span>
                <strong className="mt-1 block font-mono text-base">
                  {value}
                </strong>
              </div>
            ))}
          </div>
          {hasMultiBuy && (
            <p className="mt-3 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-xs leading-5 text-foreground/75">
              {deal.promotion}. The price above is what one item costs when the
              multibuy threshold is not met.
            </p>
          )}

          <div className="mt-6 flex items-center justify-between">
            <div>
              <h3 className="font-heading font-bold">90-day price trail</h3>
              <p className="text-xs text-muted-foreground">
                Change-only price observations
              </p>
            </div>
            <span className="flex items-center gap-1 text-sm font-bold text-primary">
              <TrendingDown className="size-4" /> {saving}% lower
            </span>
          </div>
          <ChartContainer
            config={chartConfig}
            className="mt-3 h-55 w-full aspect-auto"
          >
            <LineChart
              data={deal.history}
              margin={{ left: 0, right: 10, top: 10, bottom: 0 }}
            >
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={9}
              />
              <YAxis domain={['dataMin - 0.5', 'dataMax + 0.5']} hide />
              <ReferenceLine
                y={deal.average90d}
                stroke="var(--color-muted-foreground)"
                strokeDasharray="4 4"
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    formatter={(value) => (
                      <span className="font-mono font-semibold">
                        {money.format(Number(value))}
                      </span>
                    )}
                  />
                }
              />
              <Line
                dataKey="price"
                type="monotone"
                stroke="var(--color-price)"
                strokeWidth={3}
                dot={{ fill: 'var(--color-card)', strokeWidth: 2, r: 3 }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ChartContainer>
          <div className="mt-3 flex items-start gap-3 rounded-xl bg-[#f4b942]/18 p-3 text-xs leading-5 text-foreground/75">
            <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
            <p>
              This is{' '}
              {deal.price <= deal.low90d
                ? 'the lowest observed price'
                : `within ${money.format(deal.price - deal.low90d)} of the 90-day low`}
              . It is a stronger signal than the supermarket’s promotional label
              alone.
            </p>
          </div>
        </div>

        <DialogFooter className="m-0 rounded-b-[1.4rem] px-5 py-4">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button>
            <Bell data-icon="inline-start" /> Watch below{' '}
            {money.format(deal.price)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function DealsDashboard({
  initialPayload,
}: {
  initialPayload: DealsPayload;
}) {
  const [deals, setDeals] = useState<Deal[]>(initialPayload.data);
  const [dataMeta, setDataMeta] = useState<DealsMeta>(initialPayload.meta);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('All');
  const [retailer, setRetailer] = useState<RetailerFilter>(ALL_RETAILERS);
  const [sort, setSort] = useState<SortMode>('score');
  const [memberPrices, setMemberPrices] = useState(true);
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState('');

  const refreshDeals = async () => {
    setIsRefreshing(true);
    setRefreshMessage('');

    try {
      const payload = await fetchCurrentDeals();
      setDeals(payload.data);
      setDataMeta(payload.meta);
      setRefreshMessage(
        payload.meta.source === 'database'
          ? 'Latest database data loaded.'
          : payload.meta.source === 'local-json'
            ? 'Latest local JSON snapshot loaded.'
            : 'Preview data loaded.',
      );
    } catch (error) {
      console.error('Could not refresh current deals', error);
      setRefreshMessage('Refresh failed. Please try again.');
    } finally {
      setIsRefreshing(false);
    }
  };

  const retailerOptions = useMemo(
    () => [...new Set(deals.map((deal) => deal.retailer))],
    [deals],
  );
  const scopedDeals = useMemo(
    () =>
      retailer === ALL_RETAILERS
        ? deals
        : deals.filter((deal) => deal.retailer === retailer),
    [deals, retailer],
  );
  const visibleDeals = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return scopedDeals
      .filter((deal) => category === 'All' || deal.category === category)
      .filter((deal) => memberPrices || !deal.memberOnly)
      .filter(
        (deal) =>
          !normalized ||
          `${deal.name} ${deal.brand} ${deal.store} ${deal.category}`
            .toLowerCase()
            .includes(normalized),
      )
      .sort((a, b) => {
        if (sort === 'price') return a.price - b.price;
        if (sort === 'saving') return discountPercent(b) - discountPercent(a);
        return b.score - a.score;
      });
  }, [category, memberPrices, query, scopedDeals, sort]);

  const categoryOptions = useMemo(
    () => ['All', ...new Set(scopedDeals.map((deal) => deal.category))],
    [scopedDeals],
  );
  const retailerCounts = useMemo(
    () =>
      new Map(
        retailerOptions.map((option) => [
          option,
          deals.filter((deal) => deal.retailer === option).length,
        ]),
      ),
    [deals, retailerOptions],
  );
  const groupedDeals = useMemo(
    () =>
      retailerOptions
        .map((option) => ({
          retailer: option,
          deals: visibleDeals.filter((deal) => deal.retailer === option),
        }))
        .filter((group) => group.deals.length > 0),
    [retailerOptions, visibleDeals],
  );
  const standout = scopedDeals.reduce<Deal | undefined>(
    (best, deal) => (!best || deal.score > best.score ? deal : best),
    undefined,
  );
  const storeCount = new Set(scopedDeals.map((deal) => deal.store)).size;
  const possibleSaving = scopedDeals.reduce(
    (total, deal) =>
      total + Math.max(0, deal.regularPrice - dealOfferPrice(deal)),
    0,
  );
  const updatedLabel = dataMeta.updatedAt
    ? new Intl.DateTimeFormat('en-NZ', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'Pacific/Auckland',
      }).format(new Date(dataMeta.updatedAt))
    : 'preview data';
  const collectionDateLabel = dataMeta.updatedAt
    ? new Intl.DateTimeFormat('en-NZ', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        timeZone: 'Pacific/Auckland',
      })
        .format(new Date(dataMeta.updatedAt))
        .toLocaleUpperCase('en-NZ')
    : 'LATEST VERIFIED DEALS';

  const resetFilters = () => {
    setQuery('');
    setCategory('All');
    setRetailer(ALL_RETAILERS);
    setMemberPrices(true);
  };

  const chooseRetailer = (nextRetailer: RetailerFilter) => {
    setRetailer(nextRetailer);
    setCategory('All');
    setSelectedDeal(null);
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-foreground/10 bg-background/92 backdrop-blur-lg">
        <div className="mx-auto flex h-17 max-w-7xl items-center justify-between px-5 lg:px-8">
          <a
            href="#top"
            className="flex items-center gap-2.5"
            aria-label="Auckland Bargain home"
          >
            <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-[3px_3px_0_#f4b942]">
              <ShoppingBasket className="size-5" />
            </span>
            <span>
              <strong className="block font-heading text-[15px] leading-none tracking-tight">
                Auckland Bargain
              </strong>
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Grocery watch
              </span>
            </span>
          </a>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="hidden border-primary/20 bg-primary/5 text-primary md:inline-flex"
            >
              <Clock3 data-icon="inline-start" /> Updated {updatedLabel}
            </Badge>
            <Button
              variant="outline"
              size="lg"
              className="h-11 min-w-32 rounded-full px-4"
              disabled={isRefreshing}
              aria-busy={isRefreshing}
              onClick={refreshDeals}
            >
              <RefreshCw
                data-icon="inline-start"
                className={
                  isRefreshing ? 'animate-spin motion-reduce:animate-none' : ''
                }
              />
              {isRefreshing ? 'Refreshing…' : 'Refresh data'}
            </Button>
            <span className="sr-only" aria-live="polite" aria-atomic="true">
              {refreshMessage}
            </span>
          </div>
        </div>
      </header>

      <div id="top" className="mx-auto max-w-7xl px-5 pb-16 pt-8 lg:px-8">
        <section className="grid items-end gap-6 border-b border-foreground/10 pb-7 lg:grid-cols-[1fr_380px]">
          <div>
            <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-primary">
              <Sparkles className="size-3.5" /> {collectionDateLabel}
            </div>
            <h1 className="max-w-3xl font-heading text-4xl font-bold leading-[0.98] tracking-[-0.045em] sm:text-5xl">
              Real deals, not just{' '}
              <span className="text-primary">special stickers.</span>
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
              Compare today’s price with its real 90-day history across nearby
              Auckland supermarkets.
            </p>
          </div>
          <div className="relative">
            <Search className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search groceries"
              placeholder="Search butter, milk, chocolate…"
              className="h-13 rounded-2xl border-foreground/15 bg-card pl-12 pr-11 text-base shadow-[0_3px_0_oklch(0.2_0.02_90/0.08)]"
            />
            {query && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Clear search"
                onClick={() => setQuery('')}
                className="absolute right-2 top-2.5"
              >
                <X />
              </Button>
            )}
          </div>
        </section>

        <fieldset className="mt-6 rounded-[1.35rem] border border-foreground/10 bg-card p-4 sm:p-5">
          <legend className="px-1 font-heading text-base font-bold tracking-tight">
            Choose a supermarket
          </legend>
          <p className="mb-3 px-1 text-xs leading-5 text-muted-foreground">
            Prices, rankings and savings update to match your selection.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant={retailer === ALL_RETAILERS ? 'default' : 'outline'}
              className="min-h-11 rounded-xl px-4"
              aria-pressed={retailer === ALL_RETAILERS}
              onClick={() => chooseRetailer(ALL_RETAILERS)}
            >
              <Store data-icon="inline-start" /> All supermarkets
              <span className="font-mono text-xs opacity-70">
                {deals.length}
              </span>
            </Button>
            {retailerOptions.map((option) => (
              <Button
                key={option}
                type="button"
                variant={retailer === option ? 'default' : 'outline'}
                className="min-h-11 rounded-xl px-4"
                aria-pressed={retailer === option}
                onClick={() => chooseRetailer(option)}
              >
                {option}
                <span className="font-mono text-xs opacity-70">
                  {retailerCounts.get(option) ?? 0}
                </span>
              </Button>
            ))}
          </div>
        </fieldset>

        <section className="mt-6 grid gap-4 lg:grid-cols-[1.2fr_.8fr]">
          <div className="relative isolate min-h-64 overflow-hidden rounded-[1.7rem] bg-primary p-6 text-primary-foreground sm:p-8">
            <Image
              src="/og.png"
              alt="A paper bag filled with fresh groceries"
              fill
              priority
              sizes="(min-width: 1024px) 45vw, 100vw"
              className="absolute -z-10 object-cover object-right opacity-90 [mask-image:linear-gradient(to_right,transparent,black_32%)]"
            />
            <div className="max-w-sm">
              <Badge className="mb-5 bg-[#f4b942] text-[#25392e] hover:bg-[#f4b942]">
                <Flame data-icon="inline-start" /> Today’s standout
              </Badge>
              {standout ? (
                <>
                  <p className="text-sm font-semibold text-primary-foreground/70">
                    {standout.name} · {standout.size}
                  </p>
                  <div className="mt-1 flex items-end gap-3">
                    <span className="font-heading text-5xl font-extrabold tracking-[-0.06em]">
                      {money.format(standout.price)}
                    </span>
                    <span className="mb-1.5 text-sm text-primary-foreground/70 line-through">
                      {money.format(standout.average90d)} avg
                    </span>
                  </div>
                  <p className="mt-3 flex items-center gap-2 text-sm font-semibold">
                    <TrendingDown className="size-4 text-[#f4b942]" />{' '}
                    {discountPercent(standout)}% below its 90-day average
                  </p>
                  {isMultiBuyPromotion(standout.promotion) && (
                    <p className="mt-2 text-xs text-primary-foreground/72">
                      Single-item price · {standout.promotion}
                    </p>
                  )}
                  <Button
                    variant="secondary"
                    className="mt-6 bg-background text-foreground hover:bg-background/90"
                    onClick={() => setSelectedDeal(standout)}
                  >
                    See price history <ArrowDownRight data-icon="inline-end" />
                  </Button>
                </>
              ) : (
                <p className="max-w-xs font-heading text-3xl font-bold leading-tight">
                  No deal has enough price evidence yet.
                </p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[1.7rem] border border-foreground/10 bg-foreground/10">
            {[
              [String(scopedDeals.length), 'strong deals today'],
              [money.format(possibleSaving), 'possible basket saving'],
              [
                retailer === ALL_RETAILERS
                  ? String(retailerOptions.length)
                  : '1',
                retailer === ALL_RETAILERS
                  ? 'retailers compared'
                  : 'selected retailer',
              ],
              [String(storeCount), 'Auckland stores'],
            ].map(([value, label]) => (
              <div key={label} className="bg-card p-5 sm:p-6">
                <strong className="block font-heading text-2xl tracking-tight sm:text-3xl">
                  {value}
                </strong>
                <span className="mt-1 block text-xs leading-4 text-muted-foreground">
                  {label}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-9" aria-labelledby="deals-heading">
          <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                Ranked by real savings
              </p>
              <h2
                id="deals-heading"
                className="mt-1 font-heading text-2xl font-bold tracking-tight"
              >
                Worth grabbing today
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant={memberPrices ? 'secondary' : 'outline'}
                size="sm"
                onClick={() => setMemberPrices((value) => !value)}
                aria-pressed={memberPrices}
              >
                {memberPrices && <Check data-icon="inline-start" />} Member
                prices
              </Button>
              <div className="relative">
                <SlidersHorizontal className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <NativeSelect
                  value={sort}
                  onChange={(event) => setSort(event.target.value as SortMode)}
                  className="bg-card [&_select]:pl-8"
                  aria-label="Sort deals"
                >
                  <NativeSelectOption value="score">
                    Best score
                  </NativeSelectOption>
                  <NativeSelectOption value="saving">
                    Biggest saving
                  </NativeSelectOption>
                  <NativeSelectOption value="price">
                    Lowest price
                  </NativeSelectOption>
                </NativeSelect>
              </div>
            </div>
          </div>

          <fieldset className="mt-5 flex min-w-0 max-w-full flex-wrap gap-2 pb-2">
            <legend className="sr-only">Filter by category</legend>
            {categoryOptions.map((item) => (
              <Button
                key={item}
                size="sm"
                variant={category === item ? 'default' : 'outline'}
                className="shrink-0 rounded-full px-3.5"
                onClick={() => setCategory(item as CategoryFilter)}
                aria-pressed={category === item}
              >
                {item}
              </Button>
            ))}
          </fieldset>

          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>{visibleDeals.length} matching deals</span>
            <span className="hidden sm:inline">
              Tap a card arrow to inspect its history
            </span>
          </div>

          {visibleDeals.length ? (
            <div className="mt-4 space-y-9">
              {groupedDeals.map((group) => {
                const logo = retailerLogo(group.retailer);
                const headingId = `retailer-${group.retailer
                  .toLocaleLowerCase('en-NZ')
                  .replaceAll(/[^a-z0-9]+/g, '-')}`;
                const stores = [
                  ...new Set(group.deals.map((deal) => deal.store)),
                ];

                return (
                  <section key={group.retailer} aria-labelledby={headingId}>
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-foreground/10 pb-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="grid h-10 w-28 shrink-0 place-items-center rounded-xl border border-foreground/10 bg-white px-3">
                          <Image
                            src={logo.src}
                            alt=""
                            width={logo.width}
                            height={logo.height}
                            unoptimized
                            className="max-h-7 w-auto object-contain"
                          />
                        </div>
                        <div className="min-w-0">
                          <h3
                            id={headingId}
                            className="font-heading text-lg font-bold tracking-tight"
                          >
                            {group.retailer}
                          </h3>
                          <p className="truncate text-xs text-muted-foreground">
                            {stores.join(' · ')}
                          </p>
                        </div>
                      </div>
                      <span className="font-mono text-xs text-muted-foreground">
                        {group.deals.length} deals
                      </span>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                      {group.deals.map((deal) => (
                        <DealCard
                          key={deal.id}
                          deal={deal}
                          onOpen={setSelectedDeal}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            <Empty className="mt-6 min-h-64 border border-foreground/15 bg-card">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Search />
                </EmptyMedia>
                <EmptyTitle>No matching deals</EmptyTitle>
                <EmptyDescription>
                  Try a broader search or bring member prices back into the
                  results.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" onClick={resetFilters}>
                  Reset all filters
                </Button>
              </EmptyContent>
            </Empty>
          )}
        </section>

        <footer className="mt-12 flex flex-col justify-between gap-2 border-t border-foreground/10 pt-5 text-[11px] leading-5 text-muted-foreground sm:flex-row">
          <p>
            {dataMeta.source === 'database'
              ? 'Live supermarket prices · Change-only history stored in Supabase.'
              : dataMeta.source === 'local-json'
                ? 'Local snapshot · Run npm run deals:refresh to collect current prices.'
                : 'Preview mode · Run npm run deals:refresh to create a local data snapshot.'}
          </p>
          <p>Built for Auckland shoppers · Pacific/Auckland</p>
        </footer>
      </div>

      <DealDetail deal={selectedDeal} onClose={() => setSelectedDeal(null)} />
    </main>
  );
}
