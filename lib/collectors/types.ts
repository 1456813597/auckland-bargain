export type CollectorStore = {
  sourceStoreId: string;
  name: string;
  city: string;
  address?: string | null;
};

export type RawOffer = {
  sourceProductId: string;
  sourceName: string;
  brand: string | null;
  category: string | null;
  size: string | null;
  gtin: string | null;
  imageUrl: string | null;
  sourceUrl: string;
  regularPriceCents: number | null;
  promoPriceCents: number | null;
  memberPriceCents: number | null;
  promotionType: 'SPECIAL' | 'MEMBER_PRICE' | null;
  promotionText: string | null;
  validUntil: Date | null;
  collectedAt: Date;
};

export interface RetailerCollector {
  readonly retailerSlug: string;
  getStores(): Promise<CollectorStore[]>;
  getSpecials(store: CollectorStore): Promise<RawOffer[]>;
}
