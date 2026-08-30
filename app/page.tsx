"use client";

import { useMemo, useState } from "react";
import {
  ArrowDownRight,
  Bell,
  Check,
  ChevronDown,
  Clock3,
  Flame,
  MapPin,
  Search,
  ShoppingBasket,
  SlidersHorizontal,
  Sparkles,
  Store,
  TrendingDown,
  X,
} from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  categories,
  demoDeals,
  discountPercent,
  money,
  retailers,
  type Category,
  type Deal,
  type Retailer,
} from "@/lib/deals";

type CategoryFilter = "All" | Category;
type RetailerFilter = "All retailers" | Retailer;
type SortMode = "score" | "saving" | "price";

const chartConfig = {
  price: { label: "Price", color: "var(--color-primary)" },
} satisfies ChartConfig;

function DealCard({ deal, onOpen }: { deal: Deal; onOpen: (deal: Deal) => void }) {
  const saving = discountPercent(deal);

  return (
    <Card className="gap-0 rounded-[1.35rem] py-0 shadow-none ring-foreground/10 transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-[0_12px_28px_oklch(0.2_0.04_145/0.08)]">
      <div className="h-2" style={{ backgroundColor: deal.color }} />
      <CardHeader className="gap-3 p-5 pb-2">
        <div className="flex items-start justify-between gap-3">
          <Badge variant="secondary" className="bg-primary/8 text-primary">{deal.promotion}</Badge>
          <span className="font-mono text-xs font-bold text-muted-foreground">{deal.score}/100</span>
        </div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-lg font-bold tracking-tight">{deal.name}</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">{deal.size} · {deal.category}</p>
          </div>
          <div className="grid size-11 shrink-0 place-items-center rounded-xl text-sm font-extrabold text-[#25392e]" style={{ backgroundColor: `${deal.color}55` }} aria-hidden="true">
            {deal.brand.slice(0, 2).toUpperCase()}
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-1">
        <div className="flex items-end justify-between gap-4">
          <div>
            <strong className="font-heading text-3xl tracking-[-0.04em]">{money.format(deal.price)}</strong>
            <p className="mt-1 text-xs text-muted-foreground">90-day avg {money.format(deal.average90d)}</p>
          </div>
          <div className="text-right">
            <span className="font-mono text-lg font-bold text-primary">−{saving}%</span>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">vs average</p>
          </div>
        </div>
      </CardContent>
      <CardFooter className="border-foreground/8 bg-muted/55 px-5 py-3">
        <div className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 truncate text-xs font-medium"><MapPin className="size-3.5 shrink-0 text-primary" /> {deal.store}</span>
          {deal.memberOnly && <span className="mt-1 block text-[10px] font-semibold text-[#b34f36]">Membership required</span>}
        </div>
        <Button variant="ghost" size="icon-sm" aria-label={`View ${deal.name} price history`} onClick={() => onOpen(deal)}>
          <ArrowDownRight />
        </Button>
      </CardFooter>
    </Card>
  );
}

function DealDetail({ deal, onClose }: { deal: Deal | null; onClose: () => void }) {
  if (!deal) return null;
  const saving = discountPercent(deal);

  return (
    <Dialog open={Boolean(deal)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto rounded-[1.4rem] p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-foreground/8 p-5 pr-14">
          <div className="flex items-center gap-2">
            <Badge className="bg-primary/10 text-primary hover:bg-primary/10">Deal score {deal.score}</Badge>
            {deal.memberOnly && <Badge variant="outline">Member price</Badge>}
          </div>
          <DialogTitle className="mt-2 text-2xl font-bold tracking-tight">{deal.name}</DialogTitle>
          <DialogDescription>{deal.size} · {deal.store}</DialogDescription>
        </DialogHeader>

        <div className="p-5">
          <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl bg-foreground/10 ring-1 ring-foreground/10">
            {[
              ["Today", money.format(deal.price)],
              ["90-day avg", money.format(deal.average90d)],
              ["90-day low", money.format(deal.low90d)],
            ].map(([label, value]) => (
              <div key={label} className="bg-background p-3 text-center">
                <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
                <strong className="mt-1 block font-mono text-base">{value}</strong>
              </div>
            ))}
          </div>

          <div className="mt-6 flex items-center justify-between">
            <div>
              <h3 className="font-heading font-bold">90-day price trail</h3>
              <p className="text-xs text-muted-foreground">Change-only price observations</p>
            </div>
            <span className="flex items-center gap-1 text-sm font-bold text-primary"><TrendingDown className="size-4" /> {saving}% lower</span>
          </div>
          <ChartContainer config={chartConfig} className="mt-3 h-55 w-full aspect-auto">
            <LineChart data={deal.history} margin={{ left: 0, right: 10, top: 10, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={9} />
              <YAxis domain={["dataMin - 0.5", "dataMax + 0.5"]} hide />
              <ReferenceLine y={deal.average90d} stroke="var(--color-muted-foreground)" strokeDasharray="4 4" />
              <ChartTooltip cursor={false} content={<ChartTooltipContent formatter={(value) => <span className="font-mono font-semibold">{money.format(Number(value))}</span>} />} />
              <Line dataKey="price" type="monotone" stroke="var(--color-price)" strokeWidth={3} dot={{ fill: "var(--color-card)", strokeWidth: 2, r: 3 }} activeDot={{ r: 5 }} />
            </LineChart>
          </ChartContainer>
          <div className="mt-3 flex items-start gap-3 rounded-xl bg-[#f4b942]/18 p-3 text-xs leading-5 text-foreground/75">
            <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
            <p>This is {deal.price <= deal.low90d ? "the lowest observed price" : `within ${money.format(deal.price - deal.low90d)} of the 90-day low`}. It is a stronger signal than the supermarket’s promotional label alone.</p>
          </div>
        </div>

        <DialogFooter className="m-0 rounded-b-[1.4rem] px-5 py-4">
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button><Bell data-icon="inline-start" /> Watch below {money.format(deal.price)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("All");
  const [retailer, setRetailer] = useState<RetailerFilter>("All retailers");
  const [sort, setSort] = useState<SortMode>("score");
  const [memberPrices, setMemberPrices] = useState(true);
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null);

  const visibleDeals = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return demoDeals
      .filter((deal) => category === "All" || deal.category === category)
      .filter((deal) => retailer === "All retailers" || deal.retailer === retailer)
      .filter((deal) => memberPrices || !deal.memberOnly)
      .filter((deal) => !normalized || `${deal.name} ${deal.brand} ${deal.store} ${deal.category}`.toLowerCase().includes(normalized))
      .sort((a, b) => {
        if (sort === "price") return a.price - b.price;
        if (sort === "saving") return discountPercent(b) - discountPercent(a);
        return b.score - a.score;
      });
  }, [category, memberPrices, query, retailer, sort]);

  const resetFilters = () => {
    setQuery("");
    setCategory("All");
    setRetailer("All retailers");
    setMemberPrices(true);
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-foreground/10 bg-background/92 backdrop-blur-lg">
        <div className="mx-auto flex h-17 max-w-7xl items-center justify-between px-5 lg:px-8">
          <a href="#top" className="flex items-center gap-2.5" aria-label="Auckland Bargain home">
            <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-[3px_3px_0_#f4b942]"><ShoppingBasket className="size-5" /></span>
            <span>
              <strong className="block font-heading text-[15px] leading-none tracking-tight">Auckland Bargain</strong>
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Grocery watch</span>
            </span>
          </a>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="hidden border-primary/20 bg-primary/5 text-primary md:inline-flex"><Clock3 data-icon="inline-start" /> Updated 6:10am</Badge>
            <Button variant="outline" size="lg" className="rounded-full px-3.5"><MapPin data-icon="inline-start" /> Auckland <ChevronDown data-icon="inline-end" /></Button>
          </div>
        </div>
      </header>

      <div id="top" className="mx-auto max-w-7xl px-5 pb-16 pt-8 lg:px-8">
        <section className="grid items-end gap-6 border-b border-foreground/10 pb-7 lg:grid-cols-[1fr_380px]">
          <div>
            <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-primary"><Sparkles className="size-3.5" /> Sunday, 30 August</div>
            <h1 className="max-w-3xl font-heading text-4xl font-bold leading-[0.98] tracking-[-0.045em] sm:text-5xl">Real deals, not just <span className="text-primary">special stickers.</span></h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">Compare today’s price with its real 90-day history across nearby Auckland supermarkets.</p>
          </div>
          <div className="relative">
            <Search className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search groceries" placeholder="Search butter, milk, chocolate…" className="h-13 rounded-2xl border-foreground/15 bg-card pl-12 pr-11 text-base shadow-[0_3px_0_oklch(0.2_0.02_90/0.08)]" />
            {query && <Button variant="ghost" size="icon-sm" aria-label="Clear search" onClick={() => setQuery("")} className="absolute right-2 top-2.5"><X /></Button>}
          </div>
        </section>

        <section className="mt-6 grid gap-4 lg:grid-cols-[1.2fr_.8fr]">
          <div className="relative isolate min-h-64 overflow-hidden rounded-[1.7rem] bg-primary p-6 text-primary-foreground sm:p-8">
            <img src="/og.png" alt="A paper bag filled with fresh groceries" className="absolute inset-y-0 right-0 -z-10 h-full w-[58%] object-cover object-right opacity-90 [mask-image:linear-gradient(to_right,transparent,black_32%)]" />
            <div className="max-w-sm">
              <Badge className="mb-5 bg-[#f4b942] text-[#25392e] hover:bg-[#f4b942]"><Flame data-icon="inline-start" /> Today’s standout</Badge>
              <p className="text-sm font-semibold text-primary-foreground/70">Whittaker’s 250g</p>
              <div className="mt-1 flex items-end gap-3"><span className="font-heading text-5xl font-extrabold tracking-[-0.06em]">$4.99</span><span className="mb-1.5 text-sm text-primary-foreground/70 line-through">$6.52 avg</span></div>
              <p className="mt-3 flex items-center gap-2 text-sm font-semibold"><TrendingDown className="size-4 text-[#f4b942]" /> 23% below its 90-day average</p>
              <Button variant="secondary" className="mt-6 bg-background text-foreground hover:bg-background/90" onClick={() => setSelectedDeal(demoDeals[0])}>See price history <ArrowDownRight data-icon="inline-end" /></Button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[1.7rem] border border-foreground/10 bg-foreground/10">
            {[["47", "strong deals today"], ["$18.70", "possible basket saving"], ["3", "retailers compared"], ["12", "Auckland stores"]].map(([value, label]) => <div key={label} className="bg-card p-5 sm:p-6"><strong className="block font-heading text-2xl tracking-tight sm:text-3xl">{value}</strong><span className="mt-1 block text-xs leading-4 text-muted-foreground">{label}</span></div>)}
          </div>
        </section>

        <section className="mt-9" aria-labelledby="deals-heading">
          <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Ranked by real savings</p>
              <h2 id="deals-heading" className="mt-1 font-heading text-2xl font-bold tracking-tight">Worth grabbing today</h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant={memberPrices ? "secondary" : "outline"} size="sm" onClick={() => setMemberPrices((value) => !value)} aria-pressed={memberPrices}>{memberPrices && <Check data-icon="inline-start" />} Member prices</Button>
              <div className="relative">
                <Store className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <NativeSelect value={retailer} onChange={(event) => setRetailer(event.target.value as RetailerFilter)} className="bg-card [&_select]:pl-8" aria-label="Filter by retailer">
                  {retailers.map((item) => <NativeSelectOption key={item} value={item}>{item}</NativeSelectOption>)}
                </NativeSelect>
              </div>
              <div className="relative">
                <SlidersHorizontal className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <NativeSelect value={sort} onChange={(event) => setSort(event.target.value as SortMode)} className="bg-card [&_select]:pl-8" aria-label="Sort deals">
                  <NativeSelectOption value="score">Best score</NativeSelectOption>
                  <NativeSelectOption value="saving">Biggest saving</NativeSelectOption>
                  <NativeSelectOption value="price">Lowest price</NativeSelectOption>
                </NativeSelect>
              </div>
            </div>
          </div>

          <div className="mt-5 flex gap-2 overflow-x-auto pb-2" role="group" aria-label="Filter by category">
            {categories.map((item) => <Button key={item} size="sm" variant={category === item ? "default" : "outline"} className="shrink-0 rounded-full px-3.5" onClick={() => setCategory(item as CategoryFilter)}>{item}</Button>)}
          </div>

          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground"><span>{visibleDeals.length} matching deals</span><span className="hidden sm:inline">Tap a card arrow to inspect its history</span></div>

          {visibleDeals.length ? (
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{visibleDeals.map((deal) => <DealCard key={deal.id} deal={deal} onOpen={setSelectedDeal} />)}</div>
          ) : (
            <Empty className="mt-6 min-h-64 border border-foreground/15 bg-card"><EmptyHeader><EmptyMedia variant="icon"><Search /></EmptyMedia><EmptyTitle>No matching deals</EmptyTitle><EmptyDescription>Try a broader search or bring member prices back into the results.</EmptyDescription></EmptyHeader><EmptyContent><Button variant="outline" onClick={resetFilters}>Reset all filters</Button></EmptyContent></Empty>
          )}
        </section>

        <footer className="mt-12 flex flex-col justify-between gap-2 border-t border-foreground/10 pt-5 text-[11px] leading-5 text-muted-foreground sm:flex-row">
          <p>MVP preview · Prices and history are demonstration data, not live supermarket listings.</p>
          <p>Built for Auckland shoppers · Pacific/Auckland</p>
        </footer>
      </div>

      <DealDetail deal={selectedDeal} onClose={() => setSelectedDeal(null)} />
    </main>
  );
}
