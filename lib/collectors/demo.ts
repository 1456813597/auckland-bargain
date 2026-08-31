import type { CollectorStore, RawOffer, RetailerCollector } from "./types";

const stores: CollectorStore[] = [
  { sourceStoreId: "demo-albany", name: "PAK’nSAVE Albany", city: "Auckland" },
  { sourceStoreId: "demo-wairau", name: "PAK’nSAVE Wairau Road", city: "Auckland" },
];

export class DemoCollector implements RetailerCollector {
  readonly retailerSlug = "demo-paknsave";

  async getStores() {
    return stores;
  }

  async getSpecials(store: CollectorStore): Promise<RawOffer[]> {
    return [
      {
        sourceProductId: `whittakers-250-${store.sourceStoreId}`,
        sourceName: "Whittaker’s Creamy Milk Chocolate 250g",
        brand: "Whittakers",
        category: "Snacks",
        size: "250g",
        gtin: null,
        imageUrl: null,
        sourceUrl: "https://example.com/demo-product",
        regularPriceCents: 679,
        promoPriceCents: 499,
        memberPriceCents: null,
        promotionType: "SPECIAL",
        promotionText: "Demo 90-day low",
        validUntil: null,
        collectedAt: new Date(),
      },
    ];
  }
}
