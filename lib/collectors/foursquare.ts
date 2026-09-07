import type { CollectorStore, RawOffer, RetailerCollector } from './types';
import { extractSizeLabel } from './html';

const DEFAULT_ORIGIN = 'https://www.foursquare.co.nz';
const SPECIALS_PATH = '/local-specials-and-promotions';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_PAGE_DELAY_MS = 125;
const USER_AGENT =
  'Mozilla/5.0 (compatible; AucklandBargain/0.1; weekly price research)';

type FourSquareStoreSummary = {
  title?: string;
  url?: string;
  storeId?: string;
  contactDetails?: {
    address?: string;
    region?: string;
    island?: string;
  };
};

type FourSquareProduct = {
  id?: string;
  department?: string;
  endDate?: string;
  heading?: string;
  image?: { src?: string };
  pricing?: {
    per?: string;
    price?: number;
    multibuy?: number | null;
  };
  specialType?: string;
  additionalText?: string;
};

type FourSquareProductSection = {
  store?: {
    store_id?: string;
    title?: string;
    url?: string;
    contact_details?: {
      address?: string;
      region?: string;
      island?: string;
    };
  };
  mappedProducts?: FourSquareProduct[];
  paginationProps?: {
    numPages?: number;
    showingInfo?: { totalItems?: number };
  };
};

type ParsedFourSquarePage = {
  stores: FourSquareStoreSummary[];
  selectedStore: FourSquareProductSection['store'] | null;
  offers: RawOffer[];
  totalPages: number;
  totalItems: number;
};

export type FourSquareCollectorOptions = {
  origin?: string;
  storeId?: string;
  storeQuery?: string;
  city?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  maxPages?: number;
  pageDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type FourSquareCollection = {
  store: CollectorStore;
  offers: RawOffer[];
  pagesCollected: number;
  totalItemsReported: number;
};

function clean(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function walk(
  value: unknown,
  visit: (record: Record<string, unknown>) => void,
) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  const record = value as Record<string, unknown>;
  visit(record);
  for (const child of Object.values(record)) walk(child, visit);
}

function flightValues(html: string) {
  const values: unknown[] = [];
  for (const scriptMatch of html.matchAll(
    /<script[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    const script = scriptMatch[1] ?? '';
    const marker = 'self.__next_f.push(';
    const markerIndex = script.indexOf(marker);
    if (markerIndex < 0) continue;
    const start = markerIndex + marker.length;
    const end = script.lastIndexOf(')');
    if (end <= start) continue;
    try {
      const tuple = JSON.parse(script.slice(start, end)) as [unknown, unknown];
      if (typeof tuple[1] !== 'string') continue;
      for (const line of tuple[1].split('\n')) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const serialized = line.slice(colon + 1);
        if (!serialized.startsWith('{') && !serialized.startsWith('[')) {
          continue;
        }
        try {
          values.push(JSON.parse(serialized) as unknown);
        } catch {
          // Flight records that reference other records are not standalone JSON.
        }
      }
    } catch {
      // Ignore unrelated inline scripts and malformed/incomplete Flight chunks.
    }
  }
  return values;
}

function endDate(value: string | undefined) {
  const match = value?.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (!match) return null;
  const parsed = new Date(
    `${match[2]} ${match[1]}, ${match[3]} 23:59:59 GMT+1200`,
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseFourSquarePage(
  html: string,
  options: { origin?: string; collectedAt: Date },
): ParsedFourSquarePage {
  const origin = options.origin ?? DEFAULT_ORIGIN;
  const stores = new Map<string, FourSquareStoreSummary>();
  let section: FourSquareProductSection | null = null;

  for (const value of flightValues(html)) {
    walk(value, (record) => {
      if (
        typeof record.storeId === 'string' &&
        typeof record.title === 'string' &&
        record.title.startsWith('Four Square')
      ) {
        stores.set(record.storeId, record as FourSquareStoreSummary);
      }
      if (
        Array.isArray(record.mappedProducts) &&
        record.store &&
        typeof record.store === 'object'
      ) {
        section = record as FourSquareProductSection;
      }
    });
  }

  const productSection = section as FourSquareProductSection | null;
  const selectedStore = productSection?.store ?? null;
  const sourceUrl = new URL(SPECIALS_PATH, origin).toString();
  const offers = (productSection?.mappedProducts ?? []).flatMap(
    (product): RawOffer[] => {
      const sourceProductId = clean(product.id);
      const sourceName = clean(product.heading);
      const advertisedPrice = product.pricing?.price;
      if (
        !sourceProductId ||
        !sourceName ||
        !Number.isFinite(advertisedPrice) ||
        Number(advertisedPrice) < 0
      ) {
        return [];
      }
      const multibuy =
        Number.isSafeInteger(product.pricing?.multibuy) &&
        Number(product.pricing?.multibuy) > 1
          ? Number(product.pricing?.multibuy)
          : 1;
      const totalPriceCents = Math.round(Number(advertisedPrice) * 100);
      return [
        {
          sourceProductId,
          sourceName,
          brand: null,
          category: clean(product.department),
          size: extractSizeLabel(sourceName),
          gtin: null,
          imageUrl: clean(product.image?.src),
          sourceUrl,
          regularPriceCents: null,
          promoPriceCents: Math.round(totalPriceCents / multibuy),
          memberPriceCents: null,
          promotionType: 'SPECIAL',
          promotionText:
            multibuy > 1
              ? `${String(multibuy)} for $${(totalPriceCents / 100).toFixed(2)}`
              : (clean(product.specialType) ?? 'Four Square special'),
          validUntil: endDate(product.endDate),
          collectedAt: options.collectedAt,
        },
      ];
    },
  );

  return {
    stores: [...stores.values()],
    selectedStore,
    offers,
    totalPages: Math.max(1, productSection?.paginationProps?.numPages ?? 1),
    totalItems:
      productSection?.paginationProps?.showingInfo?.totalItems ?? offers.length,
  };
}

function collectorStore(
  store: FourSquareStoreSummary,
  cityOverride?: string,
): CollectorStore {
  const sourceStoreId = clean(store.storeId);
  const name = clean(store.title);
  if (!sourceStoreId || !name) {
    throw new Error('Four Square returned a store without an id or name.');
  }
  const address = clean(store.contactDetails?.address);
  const inferredCity =
    address
      ?.split(',')
      .at(-1)
      ?.trim()
      .replace(/\s+\d{4}$/, '') ?? null;
  return {
    sourceStoreId,
    name,
    city:
      clean(cityOverride) ??
      inferredCity ??
      clean(store.contactDetails?.region) ??
      'New Zealand',
    address,
  };
}

function setCookieLines(headers: Headers) {
  const compatible = headers as Headers & { getSetCookie?: () => string[] };
  if (compatible.getSetCookie) return compatible.getSetCookie();
  const combined = headers.get('set-cookie');
  if (!combined) return [];
  return combined.split(/,(?=\s*[!#$%&'*+.^_`|~\w-]+=)/);
}

export class FourSquareCollector implements RetailerCollector {
  readonly retailerSlug = 'foursquare';

  private readonly origin: string;
  private readonly storeId?: string;
  private readonly storeQuery: string;
  private readonly city?: string;
  private readonly transport: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly maxPages: number;
  private readonly pageDelayMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly cookies = new Map<string, string>();
  private bootstrapHtml?: string;

  constructor(options: FourSquareCollectorOptions = {}) {
    this.origin = new URL(options.origin ?? DEFAULT_ORIGIN).origin;
    this.storeId = clean(options.storeId) ?? undefined;
    this.storeQuery = clean(options.storeQuery) ?? 'Lancaster';
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
  }

  private absorbCookies(headers: Headers) {
    for (const line of setCookieLines(headers)) {
      const pair = line.split(';', 1)[0];
      const separator = pair?.indexOf('=') ?? -1;
      if (!pair || separator < 1) continue;
      this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  private cookieHeader(storeId?: string) {
    const cookies = new Map(this.cookies);
    if (storeId) cookies.set('brands_store_id', storeId);
    return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  private async request(page = 1, storeId?: string) {
    const url = new URL(SPECIALS_PATH, this.origin);
    if (page > 1) url.searchParams.set('pg', String(page));
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const cookie = this.cookieHeader(storeId);
        const response = await this.transport(url, {
          cache: 'no-store',
          headers: {
            accept: 'text/html,application/xhtml+xml',
            ...(cookie ? { cookie } : {}),
            'user-agent': USER_AGENT,
          },
          signal: controller.signal,
        });
        this.absorbCookies(response.headers);
        if (response.ok) return await response.text();
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === this.retries) {
          throw new Error(
            `Four Square page ${String(page)} returned HTTP ${String(response.status)}.`,
          );
        }
        lastError = new Error(`Retryable HTTP ${String(response.status)}.`);
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
    throw new Error(`Four Square collection failed: ${message}`);
  }

  private async bootstrap() {
    this.bootstrapHtml ??= await this.request();
    return this.bootstrapHtml;
  }

  async getAllStores() {
    const parsed = parseFourSquarePage(await this.bootstrap(), {
      origin: this.origin,
      collectedAt: new Date(),
    });
    if (parsed.stores.length === 0) {
      throw new Error('Four Square returned no store directory.');
    }
    return parsed.stores.map((store) => collectorStore(store));
  }

  async getStores() {
    const stores = await this.getAllStores();
    const normalizedId = this.storeId?.toLocaleLowerCase('en-NZ');
    const normalizedQuery = this.storeQuery.toLocaleLowerCase('en-NZ');
    const selected = normalizedId
      ? stores.find(
          (store) =>
            store.sourceStoreId.toLocaleLowerCase('en-NZ') === normalizedId,
        )
      : stores.find((store) =>
          store.name.toLocaleLowerCase('en-NZ').includes(normalizedQuery),
        );
    if (!selected) {
      throw new Error(
        `Four Square could not find store ${this.storeId ?? this.storeQuery}.`,
      );
    }
    return [{ ...selected, ...(this.city ? { city: this.city } : {}) }];
  }

  async getSpecials(store: CollectorStore) {
    return (await this.collectSpecials(store)).offers;
  }

  async collectSpecials(store?: CollectorStore): Promise<FourSquareCollection> {
    const [selectedStore] = store ? [store] : await this.getStores();
    if (!selectedStore)
      throw new Error('Four Square returned no selected store.');
    const collectedAt = new Date();
    const bootstrapHtml = await this.bootstrap();
    const bootstrap = parseFourSquarePage(bootstrapHtml, {
      origin: this.origin,
      collectedAt,
    });
    const firstHtml =
      bootstrap.selectedStore?.store_id === selectedStore.sourceStoreId
        ? bootstrapHtml
        : await this.request(1, selectedStore.sourceStoreId);
    const first = parseFourSquarePage(firstHtml, {
      origin: this.origin,
      collectedAt,
    });
    if (first.selectedStore?.store_id !== selectedStore.sourceStoreId) {
      throw new Error(
        `Four Square returned ${first.selectedStore?.title ?? 'an unknown store'} instead of ${selectedStore.name}.`,
      );
    }
    if (first.totalPages > this.maxPages) {
      throw new Error(
        `Four Square needs ${String(first.totalPages)} pages, above the configured ${String(this.maxPages)} page limit.`,
      );
    }

    const offers = new Map(
      first.offers.map((offer) => [offer.sourceProductId, offer]),
    );
    for (let page = 2; page <= first.totalPages; page += 1) {
      if (this.pageDelayMs > 0) await this.sleep(this.pageDelayMs);
      const parsed = parseFourSquarePage(
        await this.request(page, selectedStore.sourceStoreId),
        { origin: this.origin, collectedAt },
      );
      if (parsed.selectedStore?.store_id !== selectedStore.sourceStoreId) {
        throw new Error(`Four Square changed stores on page ${String(page)}.`);
      }
      for (const offer of parsed.offers) {
        offers.set(offer.sourceProductId, offer);
      }
    }
    if (first.totalItems > 0 && offers.size !== first.totalItems) {
      throw new Error(
        `Four Square reported ${String(first.totalItems)} specials but ${String(offers.size)} unique offers were parsed; refusing a partial snapshot.`,
      );
    }
    return {
      store: selectedStore,
      offers: [...offers.values()],
      pagesCollected: first.totalPages,
      totalItemsReported: first.totalItems,
    };
  }
}
