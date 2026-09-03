import type { CollectorStore, RawOffer, RetailerCollector } from './types';
import { promotionLabelForDiscount } from '../deal-quality';

const DEFAULT_ORIGIN = 'https://www.woolworths.co.nz';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 60;
const DEFAULT_PAGE_DELAY_MS = 125;

type WoolworthsPrice = {
  originalPrice?: number | null;
  salePrice?: number | null;
  savePrice?: number | null;
  savePercentage?: number | null;
  isClubPrice?: boolean;
  isSpecial?: boolean;
  promotionEndDate?: string | null;
};

type WoolworthsProduct = {
  type?: string;
  sku?: string | number;
  name?: string;
  brand?: string | null;
  barcode?: string | null;
  slug?: string | null;
  price?: WoolworthsPrice;
  images?: { big?: string | null; small?: string | null };
  size?: { volumeSize?: string | null };
  productTag?: { tagType?: string | null };
  departments?: Array<{ name?: string | null }>;
};

type WoolworthsFulfilment = {
  fulfilmentStoreId?: string | number;
  address?: string | null;
};

type WoolworthsResponse = {
  isSuccessful?: boolean;
  products?: {
    items?: WoolworthsProduct[];
    totalItems?: number;
  };
  context?: {
    fulfilment?: WoolworthsFulfilment;
  };
};

export type WoolworthsCollectorOptions = {
  origin?: string;
  cookie?: string;
  city?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  pageSize?: number;
  maxPages?: number;
  pageDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type WoolworthsCollection = {
  store: CollectorStore;
  offers: RawOffer[];
  pagesCollected: number;
  totalItemsReported: number;
};

function cents(value: number | null | undefined) {
  return Number.isFinite(value) ? Math.round(Number(value) * 100) : null;
}

function clean(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function displayText(value: string | null | undefined) {
  const normalized = clean(value);
  if (!normalized) return null;
  return normalized.charAt(0).toLocaleUpperCase('en-NZ') + normalized.slice(1);
}

function parseDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function discountPercent(
  originalPriceCents: number | null,
  currentPriceCents: number,
) {
  if (!originalPriceCents || originalPriceCents <= currentPriceCents) return 0;
  return Math.round(
    (100 * (originalPriceCents - currentPriceCents)) / originalPriceCents,
  );
}

function storeFromFulfilment(
  fulfilment: WoolworthsFulfilment | undefined,
  city: string,
): CollectorStore {
  if (fulfilment?.fulfilmentStoreId === undefined) {
    throw new Error(
      'Woolworths response did not identify its fulfilment store.',
    );
  }

  const sourceStoreId = String(fulfilment.fulfilmentStoreId);
  const address = clean(fulfilment.address);
  return {
    sourceStoreId,
    name: `Woolworths ${address ?? sourceStoreId}`,
    city,
    address,
  };
}

export function toWoolworthsOffer(
  product: WoolworthsProduct,
  collectedAt: Date,
  origin = DEFAULT_ORIGIN,
): RawOffer | null {
  if (product.sku === undefined || !clean(product.name)) return null;

  const originalPriceCents = cents(product.price?.originalPrice);
  const salePriceCents = cents(product.price?.salePrice);
  const currentPriceCents = salePriceCents ?? originalPriceCents;
  if (currentPriceCents === null) return null;

  const isMemberPrice = Boolean(product.price?.isClubPrice);
  const isSpecial = Boolean(
    product.price?.isSpecial || product.productTag?.tagType === 'IsSpecial',
  );
  const savePrice = product.price?.savePrice;
  const computedDiscount = discountPercent(
    originalPriceCents,
    currentPriceCents,
  );
  const strongPromotionLabel = promotionLabelForDiscount(computedDiscount);

  let promotionText: string | null = null;
  if (strongPromotionLabel) {
    promotionText = strongPromotionLabel;
  } else if (isMemberPrice) {
    promotionText = 'Everyday Rewards member price';
  } else if (Number.isFinite(savePrice) && Number(savePrice) > 0) {
    promotionText = `Save $${Number(savePrice).toFixed(2)}`;
  } else if (isSpecial) {
    promotionText = 'Woolworths special';
  }

  const sourceProductId = String(product.sku);
  const slug = clean(product.slug) ?? 'product';

  return {
    sourceProductId,
    sourceName: displayText(product.name)!,
    brand: displayText(product.brand),
    category: displayText(product.departments?.[0]?.name),
    size: clean(product.size?.volumeSize),
    gtin: clean(product.barcode),
    imageUrl: clean(product.images?.big) ?? clean(product.images?.small),
    sourceUrl: `${origin}/shop/productdetails?stockcode=${encodeURIComponent(sourceProductId)}&name=${encodeURIComponent(slug)}`,
    regularPriceCents: originalPriceCents ?? currentPriceCents,
    promoPriceCents: !isMemberPrice && isSpecial ? currentPriceCents : null,
    memberPriceCents: isMemberPrice ? currentPriceCents : null,
    promotionType: isMemberPrice
      ? 'MEMBER_PRICE'
      : isSpecial
        ? 'SPECIAL'
        : null,
    promotionText,
    validUntil: parseDate(product.price?.promotionEndDate),
    collectedAt,
  };
}

export class WoolworthsCollector implements RetailerCollector {
  readonly retailerSlug = 'woolworths';

  private readonly origin: string;
  private readonly cookie?: string;
  private readonly city: string;
  private readonly transport: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly pageDelayMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: WoolworthsCollectorOptions = {}) {
    this.origin = options.origin ?? DEFAULT_ORIGIN;
    this.cookie = options.cookie;
    this.city = options.city ?? 'Auckland';
    this.transport = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.pageDelayMs = options.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  private async requestPage(page: number, size: number) {
    const search = new URLSearchParams({
      target: 'specials',
      useRankedSpecials: 'true',
      page: String(page),
      size: String(size),
    });
    const url = `${this.origin}/api/v1/products?${search}`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.transport(url, {
          headers: {
            accept: 'application/json',
            referer: `${this.origin}/shop/specials`,
            'user-agent': 'AucklandBargain/0.1',
            'x-requested-with': 'OnlineShopping.WebApp',
            ...(this.cookie ? { cookie: this.cookie } : {}),
          },
          cache: 'no-store',
          signal: controller.signal,
        });

        if (response.ok) {
          const payload = (await response.json()) as WoolworthsResponse;
          if (payload.isSuccessful === false) {
            throw new Error('Woolworths returned an unsuccessful response.');
          }
          return payload;
        }

        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === this.retries) {
          throw new Error(
            `Woolworths specials request failed with HTTP ${response.status}.`,
          );
        }
        lastError = new Error(`Retryable Woolworths HTTP ${response.status}.`);
      } catch (error) {
        lastError = error;
        if (attempt === this.retries) break;
      } finally {
        clearTimeout(timeout);
      }

      await this.sleep(500 * 2 ** attempt);
    }

    const message =
      lastError instanceof Error ? lastError.message : 'Unknown request error';
    throw new Error(`Woolworths specials request failed: ${message}`);
  }

  async getStores() {
    const response = await this.requestPage(1, 1);
    return [storeFromFulfilment(response.context?.fulfilment, this.city)];
  }

  async getSpecials(store: CollectorStore) {
    const result = await this.collectSpecials(store);
    return result.offers;
  }

  async collectSpecials(
    expectedStore?: CollectorStore,
  ): Promise<WoolworthsCollection> {
    const collectedAt = new Date();
    const products = new Map<string, WoolworthsProduct>();
    let store: CollectorStore | undefined;
    let totalItemsReported = 0;
    let pagesCollected = 0;
    let totalPages = 1;

    for (let page = 1; page <= totalPages; page += 1) {
      if (page > this.maxPages) {
        throw new Error(
          `Woolworths collection needs more than the configured ${this.maxPages} pages.`,
        );
      }

      const response = await this.requestPage(page, this.pageSize);
      const pageStore = storeFromFulfilment(
        response.context?.fulfilment,
        this.city,
      );

      if (
        (store && store.sourceStoreId !== pageStore.sourceStoreId) ||
        (expectedStore &&
          expectedStore.sourceStoreId !== pageStore.sourceStoreId)
      ) {
        throw new Error(
          'Woolworths fulfilment store changed during collection.',
        );
      }

      store = pageStore;
      totalItemsReported = Math.max(
        totalItemsReported,
        response.products?.totalItems ?? 0,
      );
      totalPages = Math.max(1, Math.ceil(totalItemsReported / this.pageSize));

      for (const product of response.products?.items ?? []) {
        if (product.type && product.type !== 'Product') continue;
        if (product.sku === undefined) continue;
        products.set(String(product.sku), product);
      }

      pagesCollected = page;
      if (page < totalPages) await this.sleep(this.pageDelayMs);
    }

    if (!store) {
      throw new Error('Woolworths did not return a store context.');
    }

    const offers = [...products.values()]
      .map((product) => toWoolworthsOffer(product, collectedAt, this.origin))
      .filter((offer): offer is RawOffer => Boolean(offer));

    if (offers.length === 0) {
      throw new Error('Woolworths returned no usable specials.');
    }

    return { store, offers, pagesCollected, totalItemsReported };
  }
}
