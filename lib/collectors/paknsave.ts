import { randomUUID } from 'node:crypto';

import type { CollectorStore, RawOffer, RetailerCollector } from './types';

const DEFAULT_WEB_ORIGIN = 'https://www.paknsave.co.nz';
const DEFAULT_API_ORIGIN = 'https://api-prod.paknsave.co.nz';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_MAX_PAGES = 12;
const DEFAULT_PAGE_DELAY_MS = 125;
const USER_AGENT = 'AucklandBargain/0.1';

type PaknsaveStore = {
  id?: string;
  name?: string;
  banner?: string;
  address?: string | null;
  onlineActive?: boolean;
  physicalActive?: boolean;
  physicalAddress?: { cityName?: string | null };
};

type PaknsaveProduct = {
  productId?: string;
  name?: string;
  brand?: string | null;
  units?: string | null;
  categories?: string[];
  price?: number | null;
  nonLoyaltyPrice?: number | null;
  multiBuy?: {
    quantity?: number | null;
    price?: number | null;
  } | null;
  productImageUrls?: Record<string, string | null | undefined>;
  decalCode?: string | null;
};

type AnonymousSession = {
  access_token?: string;
  expires_time?: string;
};

type SpecialsResponse = {
  totalHits?: number;
  numberOfPages?: number;
  products?: PaknsaveProduct[];
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
  const sourceName = clean(product.name);
  const currentPriceCents = integerCents(product.price);
  if (!sourceProductId || !sourceName || currentPriceCents === null)
    return null;

  const nonLoyaltyPriceCents = integerCents(product.nonLoyaltyPrice);
  const multiBuyQuantity = integerCents(product.multiBuy?.quantity);
  const multiBuyTotalCents = integerCents(product.multiBuy?.price);
  const hasMultiBuy = Boolean(
    multiBuyQuantity && multiBuyTotalCents !== null && multiBuyQuantity > 0,
  );
  const isMemberPrice = Boolean(
    !hasMultiBuy &&
    nonLoyaltyPriceCents !== null &&
    nonLoyaltyPriceCents > currentPriceCents,
  );
  const multiBuyUnitCents = hasMultiBuy
    ? Math.round(multiBuyTotalCents! / multiBuyQuantity!)
    : null;

  let promotionText = "PAK'nSAVE special";
  if (hasMultiBuy) {
    promotionText =
      String(multiBuyQuantity) +
      ' for $' +
      (multiBuyTotalCents! / 100).toFixed(2);
  } else if (isMemberPrice) {
    promotionText = 'Club+ member price';
  } else if (product.decalCode === '6000') {
    promotionText = "PAK'nSAVE Extra Low";
  }

  return {
    sourceProductId,
    sourceName,
    brand: clean(product.brand),
    category: clean(product.categories?.[0]),
    size: clean(product.units),
    gtin: null,
    imageUrl: largestImage(product.productImageUrls),
    sourceUrl:
      webOrigin +
      '/shop/product/' +
      sourceProductId.toLocaleLowerCase('en-NZ').replaceAll('-', '_'),
    regularPriceCents: nonLoyaltyPriceCents ?? currentPriceCents,
    promoPriceCents: isMemberPrice
      ? null
      : (multiBuyUnitCents ?? currentPriceCents),
    memberPriceCents: isMemberPrice ? currentPriceCents : null,
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

    return [storeToCollectorStore(selected, this.city)];
  }

  async getSpecials(store: CollectorStore) {
    const result = await this.collectSpecials(store);
    return result.offers;
  }

  async collectSpecials(store: CollectorStore): Promise<PaknsaveCollection> {
    const collectedAt = new Date();
    const products = new Map<string, PaknsaveProduct>();
    let page = 0;
    let totalPages = 1;
    let totalItemsReported = 0;

    do {
      if (page >= this.maxPages) {
        throw new Error(
          "PAK'nSAVE collection needs more than the configured " +
            String(this.maxPages) +
            ' pages.',
        );
      }

      const response = await this.apiRequest<SpecialsResponse>(
        '/mobile/ecomm-products/PNS/' +
          encodeURIComponent(store.sourceStoreId) +
          '/specials?page=' +
          String(page),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
      );
      totalPages = Math.max(1, response.numberOfPages ?? 1);
      totalItemsReported = Math.max(
        totalItemsReported,
        response.totalHits ?? 0,
      );

      for (const product of response.products ?? []) {
        if (!clean(product.productId)) continue;
        products.set(product.productId!, product);
      }

      page += 1;
      if (page < totalPages) await this.sleep(this.pageDelayMs);
    } while (page < totalPages);

    const offers = [...products.values()]
      .map((product) => toPaknsaveOffer(product, collectedAt, this.webOrigin))
      .filter((offer): offer is RawOffer => Boolean(offer));

    if (offers.length === 0) {
      throw new Error("PAK'nSAVE returned no usable specials.");
    }

    return {
      store,
      offers,
      pagesCollected: page,
      totalItemsReported: Math.max(totalItemsReported, products.size),
    };
  }
}
