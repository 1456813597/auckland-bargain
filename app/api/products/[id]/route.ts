import { demoDeals } from "@/lib/deals";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const deal = demoDeals.find((item) => item.id === id);

  if (!deal) {
    return Response.json({ error: "Product not found" }, { status: 404 });
  }

  return Response.json({ data: deal, meta: { demo: true } });
}
