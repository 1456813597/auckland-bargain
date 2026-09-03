import { getDealsWithFallback } from '@/lib/repositories/deal-source';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const source = await getDealsWithFallback();
  const deal = source.deals.find((item) => item.id === id);

  if (!deal) {
    return Response.json({ error: 'Product not found' }, { status: 404 });
  }

  return Response.json({
    data: deal,
    meta: { demo: source.source === 'demo', source: source.source },
  });
}
