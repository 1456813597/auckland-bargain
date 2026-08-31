import { demoDeals } from "@/lib/deals";
import { isSupabaseConfigured } from "@/db/supabase";
import { getCurrentDeals } from "@/lib/repositories/deals";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const configured = isSupabaseConfigured();
  const source = configured
    ? await getCurrentDeals()
    : { deals: demoDeals };
  const deal = source.deals.find((item) => item.id === id);

  if (!deal) {
    return Response.json({ error: "Product not found" }, { status: 404 });
  }

  return Response.json({ data: deal, meta: { demo: !configured } });
}
