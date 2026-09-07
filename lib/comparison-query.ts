import type { ProductComparison } from './comparisons';
import { comparePriceObservations } from './comparison-history';

export type SortMode = 'coverage' | 'price' | 'saving' | 'weekly-drop';
export type ComparisonFilters = {
  q: string;
  category: string;
  retailer: string;
  city: string;
  sort: SortMode;
  matched: boolean;
  page: number;
  limit: number;
};

export function parseComparisonFilters(
  params: URLSearchParams,
  defaultLimit = 24,
): ComparisonFilters {
  const text = (key: string) => (params.get(key) ?? '').trim().slice(0, 200);
  const selection = (key: string) => (text(key) === 'all' ? '' : text(key));
  const positiveInteger = (key: string, fallback: number, max: number) => {
    const value = Number(params.get(key));
    return Number.isSafeInteger(value) && value > 0
      ? Math.min(value, max)
      : fallback;
  };
  const sort = text('sort');
  return {
    q: text('q'),
    category: selection('category'),
    retailer: selection('retailer'),
    city: selection('city'),
    sort: ['price', 'saving', 'weekly-drop'].includes(sort)
      ? (sort as SortMode)
      : 'coverage',
    matched: text('matched') === 'true',
    page: positiveInteger('page', 1, 1_000_000),
    limit: positiveInteger('limit', defaultLimit, 250),
  };
}

export function comparisonSearchParams(filters: ComparisonFilters) {
  const params = new URLSearchParams();
  for (const key of ['q', 'category', 'retailer', 'city'] as const) {
    if (filters[key]) params.set(key, filters[key]);
  }
  if (filters.sort !== 'coverage') params.set('sort', filters.sort);
  if (filters.matched) params.set('matched', 'true');
  if (filters.page > 1) params.set('page', String(filters.page));
  if (filters.limit !== 24) params.set('limit', String(filters.limit));
  return params;
}

function normalized(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-NZ');
}

export function comparisonForCity(
  product: ProductComparison,
  city: string,
): ProductComparison | null {
  if (!city) return product;
  const offers = product.offers.filter(
    (offer) => normalized(offer.storeCity ?? '') === normalized(city),
  );
  if (!offers.length) return null;
  const prices = offers.map((offer) => offer.offerPrice);
  const history = comparePriceObservations(offers);
  const lowestPrice = Math.min(...prices);
  const highestPrice = Math.max(...prices);
  return {
    ...product,
    offers,
    lowestPrice,
    highestPrice,
    retailerCount: new Set(offers.map((offer) => offer.retailerSlug)).size,
    possibleSaving: highestPrice - lowestPrice,
    weeklyChange: history?.change ?? null,
    updatedAt:
      offers
        .flatMap((offer) => (offer.collectedAt ? [offer.collectedAt] : []))
        .sort()
        .at(-1) ?? null,
  };
}

export function queryComparisons(
  comparisons: ProductComparison[],
  filters: ComparisonFilters,
) {
  const categoryCounts = new Map<string, number>();
  const retailerNames = new Map<string, string>();
  const cities = new Set<string>();
  for (const product of comparisons) {
    if (product.category)
      categoryCounts.set(
        product.category,
        (categoryCounts.get(product.category) ?? 0) + 1,
      );
    for (const offer of product.offers) {
      retailerNames.set(offer.retailerSlug, offer.retailer);
      if (offer.storeCity) cities.add(offer.storeCity);
    }
  }
  const terms = normalized(filters.q).split(/\s+/).filter(Boolean);
  const matching = comparisons
    .flatMap((product) => {
      const local = comparisonForCity(product, filters.city);
      if (!local) return [];
      const searchable = normalized(
        `${local.name} ${local.brand} ${local.size} ${local.category} ${local.offers.map((offer) => offer.name).join(' ')}`,
      );
      return terms.every((term) => searchable.includes(term)) &&
        (!filters.category ||
          normalized(local.category) === normalized(filters.category)) &&
        (!filters.retailer ||
          local.offers.some(
            (offer) => offer.retailerSlug === filters.retailer,
          )) &&
        (!filters.matched || local.retailerCount > 1)
        ? [local]
        : [];
    })
    .sort((left, right) => {
      let difference = 0;
      if (filters.sort === 'price')
        difference = left.lowestPrice - right.lowestPrice;
      else if (filters.sort === 'saving')
        difference = right.possibleSaving - left.possibleSaving;
      else if (filters.sort === 'weekly-drop')
        difference =
          (left.weeklyChange ?? Infinity) - (right.weeklyChange ?? Infinity);
      else
        difference =
          right.retailerCount - left.retailerCount ||
          right.possibleSaving - left.possibleSaving;
      return difference || left.id.localeCompare(right.id, 'en-NZ');
    });
  const totalPages = Math.max(1, Math.ceil(matching.length / filters.limit));
  const page = Math.min(filters.page, totalPages);
  return {
    products: matching.slice((page - 1) * filters.limit, page * filters.limit),
    filters: { ...filters, page },
    total: matching.length,
    totalProducts: comparisons.length,
    totalPages,
    categories: [...categoryCounts].sort(([left], [right]) =>
      left.localeCompare(right, 'en-NZ'),
    ),
    retailers: [...retailerNames].sort(([, left], [, right]) =>
      left.localeCompare(right, 'en-NZ'),
    ),
    cities: [...cities].sort((left, right) =>
      left.localeCompare(right, 'en-NZ'),
    ),
  };
}

export type ComparisonResults = ReturnType<typeof queryComparisons>;
