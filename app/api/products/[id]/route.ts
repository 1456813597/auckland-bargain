import { getComparisonsWithFallback } from '@/lib/repositories/comparison-source';
import { retailerProductKey } from '@/lib/offer-identity';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const source = await getComparisonsWithFallback();
  const product = source.comparisons.find(
    (item) =>
      item.id === id ||
      item.offers.some(
        (offer) => offer.id === id || retailerProductKey(offer) === id,
      ),
  );

  if (!product) {
    return Response.json({ error: 'Product not found' }, { status: 404 });
  }

  return Response.json({
    data: product,
    meta: {
      demo: source.source === 'demo',
      source: source.source,
      cadence: 'weekly',
      retainedHistorySnapshots: 1,
    },
  });
}
