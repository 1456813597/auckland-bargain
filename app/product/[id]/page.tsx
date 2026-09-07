import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';

import { ProductDetail } from '@/components/product-detail';
import { getComparisonsWithFallback } from '@/lib/repositories/comparison-source';
import {
  comparisonForCity,
  comparisonSearchParams,
  parseComparisonFilters,
} from '@/lib/comparison-query';

export const dynamic = 'force-dynamic';

const loadProduct = cache(async (id: string) => {
  const source = await getComparisonsWithFallback();
  const product = source.comparisons.find((item) => item.id === id);
  return { source, product };
});

export async function generateMetadata(
  props: PageProps<'/product/[id]'>,
): Promise<Metadata> {
  const { id } = await props.params;
  const { product } = await loadProduct(id);
  if (!product) return { title: 'Product not found' };
  return {
    title: `${product.name} supermarket prices`,
    description: `Compare current ${product.name} prices across New Zealand supermarkets.`,
  };
}

export default async function ProductPage(props: PageProps<'/product/[id]'>) {
  const { id } = await props.params;
  const { source, product: allLocations } = await loadProduct(id);
  if (!allLocations) notFound();
  const params = await props.searchParams;
  const city = typeof params.city === 'string' ? params.city : '';
  const search = comparisonSearchParams(
    parseComparisonFilters(
      new URLSearchParams(
        typeof params.search === 'string' ? params.search.slice(0, 2000) : '',
      ),
    ),
  );
  if (city) search.set('city', city);
  const product = comparisonForCity(allLocations, city);
  if (!product) notFound();
  const related = source.comparisons
    .flatMap((item) => {
      const local = comparisonForCity(item, city);
      return local ? [local] : [];
    })
    .filter(
      (item) => item.id !== product.id && item.category === product.category,
    )
    .slice(0, 4);

  return (
    <ProductDetail
      product={product}
      related={related}
      source={source.source}
      city={city}
      search={search.toString()}
    />
  );
}
