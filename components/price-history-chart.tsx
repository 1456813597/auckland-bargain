'use client';

import { Line, LineChart, XAxis, YAxis } from 'recharts';

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import type { ProductComparison } from '@/lib/comparisons';
import { comparePriceObservations } from '@/lib/comparison-history';
import { money } from '@/lib/deals';

const chartConfig = {
  price: { label: 'Lowest price', color: 'var(--color-primary)' },
} satisfies ChartConfig;

export function PriceHistoryChart({ product }: { product: ProductComparison }) {
  const history = comparePriceObservations(product.offers);
  if (!history) {
    return (
      <div className="grid h-48 place-items-center rounded-xl border border-dashed bg-muted/40 px-6 text-center text-sm text-muted-foreground">
        No prior observations are available. A price comparison will appear
        after a successful collection in another week.
      </div>
    );
  }

  const data = [
    { label: 'Prior', price: history.previousLowestPrice },
    { label: 'Latest', price: history.currentLowestPrice },
  ];

  return (
    <>
      <p className="sr-only">
        For the same {history.offerCount} offers, the lowest price was{' '}
        {money.format(data[0].price)} in prior observations and is{' '}
        {money.format(data[1].price)} in the latest observations.
      </p>
      <ChartContainer config={chartConfig} className="h-48 w-full aspect-auto">
        <LineChart
          data={data}
          margin={{ top: 16, right: 16, bottom: 0, left: 16 }}
        >
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tickMargin={10}
          />
          <YAxis hide domain={['dataMin - 0.5', 'dataMax + 0.5']} />
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
            type="linear"
            stroke="var(--color-price)"
            strokeWidth={3}
            dot={{ r: 5, fill: 'var(--color-card)', strokeWidth: 3 }}
            activeDot={{ r: 6 }}
          />
        </LineChart>
      </ChartContainer>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        Based on {history.offerCount} offers with both observations. Collection
        dates can differ between stores; prior does not necessarily mean last
        week. Newly covered offers are excluded from price movements.
      </p>
    </>
  );
}
