import type { Deal, PricePoint } from '@/lib/deals';

const calendar = new Intl.DateTimeFormat('en-NZ', {
  timeZone: 'Pacific/Auckland',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const label = new Intl.DateTimeFormat('en-NZ', {
  timeZone: 'Pacific/Auckland',
  day: '2-digit',
  month: 'short',
});

export function nzWeekStart(value: string | Date) {
  const instant = value instanceof Date ? value : new Date(value);
  const parts = calendar.formatToParts(instant);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  const date = new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

// Legacy labels such as "03 Sept" do not carry a year. Only the last legacy
// observation has a trustworthy timestamp (the offer's collectedAt).
export function datedHistory(
  deal: Pick<Deal, 'history' | 'collectedAt'>,
): PricePoint[] {
  return deal.history.flatMap((point, index) => {
    const observedAt =
      point.observedAt ??
      (index === deal.history.length - 1 ? deal.collectedAt : undefined);
    if (!observedAt || !Number.isFinite(Date.parse(observedAt))) return [];
    return [{ ...point, observedAt, weekStart: nzWeekStart(observedAt) }];
  });
}

export function appendWeeklyHistory(
  previous: Deal | undefined,
  price: number,
  collectedAt: Date,
) {
  const points = previous ? datedHistory(previous) : [];
  const next: PricePoint = {
    date: label.format(collectedAt),
    price,
    observedAt: collectedAt.toISOString(),
    weekStart: nzWeekStart(collectedAt),
  };
  const weeks = new Map<string, PricePoint>();
  for (const point of [...points, next].sort((a, b) =>
    a.observedAt!.localeCompare(b.observedAt!),
  )) {
    weeks.set(point.weekStart!, point);
  }
  return [...weeks.values()]
    .sort((a, b) => a.weekStart!.localeCompare(b.weekStart!))
    .slice(-2);
}
