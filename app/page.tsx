import DealsDashboard, {
  type DealsPayload,
} from '@/components/deals-dashboard';
import { getDealsWithFallback } from '@/lib/repositories/deal-source';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const source = await getDealsWithFallback();
  const initialPayload: DealsPayload = {
    data: source.deals,
    meta: {
      demo: source.source === 'demo',
      source: source.source,
      updatedAt: source.updatedAt,
    },
  };

  return <DealsDashboard initialPayload={initialPayload} />;
}
