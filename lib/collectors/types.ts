export type CollectorStore = {
  sourceStoreId: string;
  name: string;
  city: string;
};

export type RawOffer = {
  sourceProductId: string;
  sourceName: string;
  regularPriceCents: number | null;
  promoPriceCents: number | null;
  memberPriceCents: number | null;
  promotionText: string | null;
  collectedAt: Date;
};

export interface RetailerCollector {
  readonly retailerSlug: string;
  getStores(): Promise<CollectorStore[]>;
  getSpecials(store: CollectorStore): Promise<RawOffer[]>;
}
