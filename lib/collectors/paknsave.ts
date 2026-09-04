import { randomUUID } from 'node:crypto';

import { paknsaveProductImageUrl } from '@/lib/product-images';

import type { CollectorStore, RawOffer, RetailerCollector } from './types';

const DEFAULT_WEB_ORIGIN = 'https://www.paknsave.co.nz';
const DEFAULT_API_ORIGIN = 'https://api-prod.paknsave.co.nz';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_PAGE_DELAY_MS = 125;
const SEARCH_PAGE_SIZE = 50;
const SEARCH_RESULT_CAP = 1_000;
const USER_AGENT = 'AucklandBargain/0.1';

type PaknsaveStore = {
  id?: string;
  name?: string;
  banner?: string;
  address?: string | null;
  region?: string | null;
  onlineActive?: boolean;
  physicalActive?: boolean;
  physicalAddress?: { cityName?: string | null };
};

type PaknsavePromotion = {
  rewardValue?: number | null;
  decal?: string | null;
  threshold?: number | null;
  multiProducts?: boolean | null;
  cardDependencyFlag?: boolean | null;
  bestPromotion?: boolean | null;
};

type PaknsaveProduct = {
  productId?: string;
  name?: string;
  displayName?: string | null;
  brand?: string | null;
  units?: string | null;
  categories?: string[];
  categoryTrees?: Array<{
    level0?: string | null;
    level1?: string | null;
  }>;
  price?: number | null;
  singlePrice?: { price?: number | null } | null;
  nonLoyaltyPrice?: number | null;
  multiBuy?: {
    quantity?: number | null;
    price?: number | null;
  } | null;
  promotions?: PaknsavePromotion[];
  productImageUrls?: Record<string, string | null | undefined>;
  decalCode?: string | null;
};

type AnonymousSession = {
  access_token?: string;
  expires_time?: string;
};

type SpecialsResponse = {
  totalHits?: number;
  totalPages?: number;
  numberOfPages?: number;
  products?: PaknsaveProduct[];
  algoliaSearchResult?: {
    facets?: Record<string, Record<string, number>>;
  };
};

export type PaknsaveCollectorOptions = {
  webOrigin?: string;
  apiOrigin?: string;
  storeId?: string;
  storeQuery?: string;
  city?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  maxPages?: number;
  pageDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  fingerprint?: string;
};

export type PaknsaveCollection = {
  store: CollectorStore;
  offers: RawOffer[];
  pagesCollected: number;
  totalItemsReported: number;
};

function clean(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function integerCents(value: number | null | undefined) {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

function largestImage(images: PaknsaveProduct['productImageUrls']) {
  if (!images) return null;
  return (
    Object.entries(images)
      .filter((entry): entry is [string, string] => Boolean(clean(entry[1])))
      .sort(([left], [right]) => Number(right) - Number(left))[0]?.[1] ?? null
  );
}

function bestPromotion(product: PaknsaveProduct) {
  return (
    product.promotions?.find((promotion) => promotion.bestPromotion) ??
    product.promotions?.[0]
  );
}

function storeToCollectorStore(
  store: PaknsaveStore,
  cityOverride?: string,
): CollectorStore {
  const sourceStoreId = clean(store.id);
  const name = clean(store.name);
  if (!sourceStoreId || !name) {
    throw new Error("PAK'nSAVE returned a store without an id or name.");
  }

  return {
    sourceStoreId,
    name,
    city:
      clean(cityOverride) ??
      clean(store.physicalAddress?.cityName) ??
      'Auckland',
    address: clean(store.address),
  };
}

export function toPaknsaveOffer(
  product: PaknsaveProduct,
  collectedAt: Date,
  webOrigin = DEFAULT_WEB_ORIGIN,
): RawOffer | null {
  const sourceProductId = clean(product.productId);
  const sourceName = clean(product.name) ?? clean(product.displayName);
  const currentPriceCents = integerCents(
    product.singlePrice?.price ?? product.price,
  );
  if (!sourceProductId || !sourceName || currentPriceCents === null)
    return null;

  const promotion = bestPromotion(product);
  const promotionValueCents = integerCents(promotion?.rewardValue);
  const nonLoyaltyPriceCents = integerCents(product.nonLoyaltyPrice);
  const multiBuyQuantity = integerCents(
    product.multiBuy?.quantity ?? promotion?.threshold,
  );
  const multiBuyTotalCents = integerCents(
    product.multiBuy?.price ?? promotion?.rewardValue,
  );
  const hasMultiBuy = Boolean(
    multiBuyQuantity &&
    multiBuyTotalCents !== null &&
    multiBuyQuantity > 1 &&
    (product.multiBuy || promotion?.multiProducts),
  );
  const hasSearchMemberPrice = Boolean(
    promotion?.cardDependencyFlag && promotionValueCents !== null,
  );
  const hasLegacyMemberPrice = Boolean(
    !hasMultiBuy &&
    nonLoyaltyPriceCents !== null &&
    nonLoyaltyPriceCents > currentPriceCents,
  );
  const isMemberPrice = hasSearchMemberPrice || hasLegacyMemberPrice;
  const normalizedPromotionCents =
    multiBuyQuantity && multiBuyQuantity > 1 && promotionValueCents !== null
      ? Math.round(promotionValueCents / multiBuyQuantity)
      : promotionValueCents;
  const memberPriceCents = hasSearchMemberPrice
    ? normalizedPromotionCents
    : hasLegacyMemberPrice
      ? currentPriceCents
      : null;

  let promotionText = "PAK'nSAVE special";
  if (hasMultiBuy) {
    promotionText =
      String(multiBuyQuantity) +
      ' for $' +
      (multiBuyTotalCents! / 100).toFixed(2);
  } else if (isMemberPrice) {
    promotionText = 'Club+ member price';
  } else if (product.decalCode === '6000' || promotion?.decal === '6000') {
    promotionText = "PAK'nSAVE Extra Low";
  }

  return {
    sourceProductId,
    sourceName,
    brand: clean(product.brand),
    category:
      clean(product.categories?.[0]) ??
      clean(product.categoryTrees?.[0]?.level1) ??
      clean(product.categoryTrees?.[0]?.level0),
    size: clean(product.units) ?? clean(product.displayName),
    gtin: null,
    imageUrl:
      largestImage(product.productImageUrls) ??
      paknsaveProductImageUrl(sourceProductId),
    sourceUrl:
      webOrigin +
      '/shop/product/' +
      sourceProductId.toLocaleLowerCase('en-NZ').replaceAll('-', '_') +
      'pns',
    regularPriceCents: nonLoyaltyPriceCents ?? currentPriceCents,
    // singlePrice.price is the amount charged when the shopper buys one item.
    // A multi-buy rewardValue is the total charged only after its threshold is
    // met, so dividing it here makes the headline "live price" misleading.
    promoPriceCents: isMemberPrice ? null : currentPriceCents,
    memberPriceCents,
    promotionType: isMemberPrice ? 'MEMBER_PRICE' : 'SPECIAL',
    promotionText,
    validUntil: null,
    collectedAt,
  };
}

export class PaknsaveCollector implements RetailerCollector {
  readonly retailerSlug = 'paknsave';

  private readonly webOrigin: string;
  private readonly apiOrigin: string;
  private readonly storeId?: string;
  private readonly storeQuery: string;
  private readonly city?: string;
  private readonly transport: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly maxPages: number;
  private readonly pageDelayMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly fingerprint: string;
  private readonly storeRegions = new Map<string, string>();
  private accessToken?: string;
  private accessTokenExpiresAt = 0;

  constructor(options: PaknsaveCollectorOptions = {}) {
    this.webOrigin = options.webOrigin ?? DEFAULT_WEB_ORIGIN;
    this.apiOrigin = options.apiOrigin ?? DEFAULT_API_ORIGIN;
    this.storeId = clean(options.storeId) ?? undefined;
    this.storeQuery = clean(options.storeQuery) ?? 'Royal Oak';
    this.city = clean(options.city) ?? undefined;
    this.transport = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.pageDelayMs = options.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.fingerprint =
      clean(options.fingerprint) ?? randomUUID().replaceAll('-', '');
  }

  private async request(url: string, init: RequestInit, operation: string) {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.transport(url, {
          ...init,
          cache: 'no-store',
          signal: controller.signal,
        });
        if (response.ok) return response;

        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === this.retries) {
          throw new Error(
            "PAK'nSAVE " +
              operation +
              ' failed with HTTP ' +
              String(response.status) +
              '.',
          );
        }
        lastError = new Error(
          "Retryable PAK'nSAVE HTTP " + String(response.status) + '.',
        );
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
    throw new Error("PAK'nSAVE " + operation + ' failed: ' + message);
  }

  private async authenticate() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    const response = await this.request(
      this.webOrigin + '/api/user/get-current-user',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          fingerprintUser: this.fingerprint,
          fingerprintGuest: USER_AGENT,
        }),
      },
      'anonymous authentication',
    );
    const session = (await response.json()) as AnonymousSession;
    if (!clean(session.access_token)) {
      throw new Error("PAK'nSAVE anonymous authentication returned no token.");
    }

    this.accessToken = session.access_token;
    const expiresAt = Date.parse(session.expires_time ?? '');
    this.accessTokenExpiresAt = Number.isNaN(expiresAt)
      ? Date.now() + 5 * 60_000
      : expiresAt;
    return this.accessToken;
  }

  private async apiRequest<T>(path: string, init: RequestInit = {}) {
    const accessToken = await this.authenticate();
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    headers.set('authorization', 'Bearer ' + accessToken);
    headers.set('origin', this.webOrigin);
    headers.set('referer', this.webOrigin + '/');
    headers.set('user-agent', USER_AGENT);
    const response = await this.request(
      this.apiOrigin + path,
      {
        ...init,
        headers,
      },
      path,
    );
    return (await response.json()) as T;
  }

  private async searchPage(
    storeId: string,
    region: string,
    page: number,
    category?: string,
  ) {
    const categoryFacet = `category0${region}`;
    return this.apiRequest<SpecialsResponse>(
      '/v1/edge/search/paginated/products',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          algoliaQuery: {
            query: '',
            filters: `stores:${storeId} AND onPromotion:${storeId}`,
            facets: [categoryFacet],
            ...(category
              ? { facetFilters: [[`${categoryFacet}:${category}`]] }
              : {}),
            maxValuesPerFacet: 100,
          },
          algoliaFacetQueries: [],
          storeId,
          hitsPerPage: SEARCH_PAGE_SIZE,
          page,
          sortOrder:
            region === 'SI' ? 'SI_POPULARITY_ASC' : 'NI_POPULARITY_ASC',
          tobaccoQuery: false,
          precisionMedia: {
            adDomain: 'CATEGORY_PAGE',
            adPositions: [3, 6, 9],
            publishImpressionEvent: false,
            disableAds: true,
          },
        }),
      },
    );
  }

  private totalPages(response: SpecialsResponse) {
    const totalPages = response.totalPages ?? response.numberOfPages ?? 1;
    if (!Number.isSafeInteger(totalPages) || totalPages < 1) {
      throw new Error("PAK'nSAVE returned an invalid page count.");
    }
    if (totalPages > this.maxPages) {
      throw new Error(
        "PAK'nSAVE collection needs more than the configured " +
          String(this.maxPages) +
          ' pages.',
      );
    }
    return totalPages;
  }

  private addProducts(
    destination: Map<string, PaknsaveProduct>,
    response: SpecialsResponse,
  ) {
    for (const product of response.products ?? []) {
      const productId = clean(product.productId);
      if (productId) destination.set(productId, product);
    }
  }

  private async collectSearchPages(
    storeId: string,
    region: string,
    category: string | undefined,
    firstPage: SpecialsResponse,
  ) {
    const products = new Map<string, PaknsaveProduct>();
    this.addProducts(products, firstPage);
    const totalPages = this.totalPages(firstPage);

    for (let page = 1; page < totalPages; page += 1) {
      await this.sleep(this.pageDelayMs);
      this.addProducts(
        products,
        await this.searchPage(storeId, region, page, category),
      );
    }

    return { products, pagesCollected: totalPages };
  }

  async getStores() {
    const response = await this.apiRequest<{ stores?: PaknsaveStore[] }>(
      '/v1/edge/store',
    );
    const candidates = (response.stores ?? []).filter(
      (store) =>
        store.banner?.toLocaleUpperCase('en-NZ') === 'PNS' &&
        store.physicalActive !== false &&
        store.onlineActive !== false,
    );

    let selected: PaknsaveStore | undefined;
    if (this.storeId) {
      selected = candidates.find((store) => store.id === this.storeId);
    } else {
      const query = this.storeQuery.toLocaleLowerCase('en-NZ');
      selected =
        candidates.find(
          (store) => store.name?.toLocaleLowerCase('en-NZ') === query,
        ) ??
        candidates.find(
          (store) =>
            store.name?.toLocaleLowerCase('en-NZ').includes(query) ||
            store.address?.toLocaleLowerCase('en-NZ').includes(query),
        );
    }

    if (!selected) {
      const selector = this.storeId ?? this.storeQuery;
      throw new Error(
        "Could not find an active PAK'nSAVE store for " + selector + '.',
      );
    }

    const collectorStore = storeToCollectorStore(selected, this.city);
    const region = clean(selected.region)?.toLocaleUpperCase('en-NZ');
    this.storeRegions.set(
      collectorStore.sourceStoreId,
      region === 'SI' ? 'SI' : 'NI',
    );
    return [collectorStore];
  }

  async getSpecials(store: CollectorStore) {
    const result = await this.collectSpecials(store);
    return result.offers;
  }

  async collectSpecials(store: CollectorStore): Promise<PaknsaveCollection> {
    const collectedAt = new Date();
    const region = this.storeRegions.get(store.sourceStoreId) ?? 'NI';
    const firstPage = await this.searchPage(store.sourceStoreId, region, 0);
    const reportedTotal = Math.max(0, firstPage.totalHits ?? 0);
    let pagesCollected = 1;
    let products: Map<string, PaknsaveProduct>;

    if (reportedTotal < SEARCH_RESULT_CAP) {
      const collection = await this.collectSearchPages(
        store.sourceStoreId,
        region,
        undefined,
        firstPage,
      );
      products = collection.products;
      pagesCollected = collection.pagesCollected;
      if (reportedTotal > 0 && products.size !== reportedTotal) {
        throw new Error(
          `PAK'nSAVE reported ${reportedTotal} specials but returned ${products.size}.`,
        );
      }
    } else {
      const categoryFacet = `category0${region}`;
      const categories = Object.entries(
        firstPage.algoliaSearchResult?.facets?.[categoryFacet] ?? {},
      ).filter(([, count]) => Number.isSafeInteger(count) && count > 0);
      if (categories.length === 0) {
        throw new Error(
          "PAK'nSAVE capped the search results without returning category facets.",
        );
      }

      products = new Map<string, PaknsaveProduct>();
      for (const [category, facetCount] of categories) {
        await this.sleep(this.pageDelayMs);
        const categoryFirstPage = await this.searchPage(
          store.sourceStoreId,
          region,
          0,
          category,
        );
        pagesCollected += 1;
        const categoryTotal = Math.max(0, categoryFirstPage.totalHits ?? 0);
        if (categoryTotal >= SEARCH_RESULT_CAP) {
          throw new Error(
            `PAK'nSAVE category "${category}" is still capped at ${categoryTotal} results.`,
          );
        }
        if (categoryTotal !== facetCount) {
          throw new Error(
            `PAK'nSAVE category "${category}" changed from ${facetCount} to ${categoryTotal} results during collection.`,
          );
        }

        const categoryCollection = await this.collectSearchPages(
          store.sourceStoreId,
          region,
          category,
          categoryFirstPage,
        );
        pagesCollected += categoryCollection.pagesCollected - 1;
        if (categoryCollection.products.size !== categoryTotal) {
          throw new Error(
            `PAK'nSAVE category "${category}" reported ${categoryTotal} specials but returned ${categoryCollection.products.size}.`,
          );
        }
        for (const [productId, product] of categoryCollection.products) {
          products.set(productId, product);
        }
      }
    }

    const offers = [...products.values()]
      .map((product) => toPaknsaveOffer(product, collectedAt, this.webOrigin))
      .filter((offer): offer is RawOffer => Boolean(offer));

    if (offers.length === 0) {
      throw new Error("PAK'nSAVE returned no usable specials.");
    }

    return {
      store,
      offers,
      pagesCollected,
      totalItemsReported: products.size,
    };
  }
}
