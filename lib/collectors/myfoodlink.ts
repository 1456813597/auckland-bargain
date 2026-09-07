import type {
  CollectorStore,
  RawOffer,
  RetailerCollector,
  CollectionScope,
  CompleteCollection,
} from './types';
import { decodeHtml, extractSizeLabel, stripHtml } from './html';
import { parseCatalogueTree, type CatalogueCategory } from './catalogue-tree';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_MAX_PAGES = 80;
const DEFAULT_PAGE_DELAY_MS = 125;
const PLATFORM_PAGE_CAP = 50;
const USER_AGENT = 'AucklandBargain/0.1 (+weekly price research)';

type TrackingProduct = {
  item_name?: string;
  item_id?: string;
  item_brand?: string;
  item_category?: string;
  item_category2?: string;
  item_category3?: string;
};

type TrackingLayer = Array<{
  ecommerce?: { items?: TrackingProduct[] };
}>;

type CmsLayer = Array<{
  mfl_shop_update?: {
    shop?: { id?: string; name?: string; url?: string };
  };
}>;

type ParsedPage = {
  offers: RawOffer[];
  productIds: string[];
  totalItems: number;
  totalPages: number;
  store: { id: string; name: string } | null;
};

export type MyFoodLinkCollectorOptions = {
  retailerSlug: string;
  retailerName: string;
  storeOrigin: string;
  city: string;
  address?: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  maxPages?: number;
  maxCataloguePages?: number;
  pageDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type MyFoodLinkCollection = CompleteCollection;

function clean(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeKey(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-NZ');
}

function parseDollars(value: string | undefined) {
  if (!value) return null;
  const amount = Number(value.replaceAll(',', ''));
  return Number.isFinite(amount) && amount >= 0
    ? Math.round(amount * 100)
    : null;
}

function parseJsonAssignment<T>(html: string, variable: string): T | null {
  const escapedVariable = variable.replaceAll('.', '\\.');
  const expression = new RegExp(
    `${escapedVariable}\\s*=\\s*(?:${escapedVariable}\\s*\\|\\|\\s*)?(\\[[\\s\\S]*?\\]);`,
  );
  const match = html.match(expression);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]) as T;
  } catch {
    return null;
  }
}

function attribute(tag: string, name: string) {
  const match = tag.match(new RegExp(`${name}=["']([^"']*)["']`, 'i'));
  return match?.[1] ? decodeHtml(match[1]) : null;
}

function advertisedEndDate(html: string, collectedAt: Date) {
  const label = stripHtml(
    html.match(
      /<span class="CatalogueEdition__DateTo">([\s\S]*?)<\/span>/i,
    )?.[1] ?? '',
  ).replace(/^[^-]*-\s*/, '');
  const monthDay = label.replace(/^[A-Za-z]+,\s*/, '');
  if (!monthDay) return null;

  let year = collectedAt.getUTCFullYear();
  let parsed = new Date(`${monthDay}, ${String(year)} 23:59:59 GMT+1200`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getTime() < collectedAt.getTime() - 31 * 24 * 60 * 60 * 1_000) {
    year += 1;
    parsed = new Date(`${monthDay}, ${String(year)} 23:59:59 GMT+1200`);
  }
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseMyFoodLinkPage(
  html: string,
  options: {
    origin: string;
    retailerName: string;
    collectedAt: Date;
    scope?: CollectionScope;
  },
): ParsedPage {
  const tracking =
    parseJsonAssignment<TrackingLayer>(html, 'window.gtmDataLayer') ?? [];
  const trackedProducts = tracking.flatMap(
    (entry) => entry.ecommerce?.items ?? [],
  );
  const trackedByName = new Map<string, TrackingProduct[]>();
  for (const product of trackedProducts) {
    const name = clean(product.item_name);
    if (!name) continue;
    const key = normalizeKey(name);
    trackedByName.set(key, [...(trackedByName.get(key) ?? []), product]);
  }

  const cms = parseJsonAssignment<CmsLayer>(html, 'window.cmsDataLayer');
  const cmsStore = cms?.[0]?.mfl_shop_update?.shop;
  const storeId = clean(cmsStore?.id);
  const storeName = clean(cmsStore?.name);
  const store = storeId && storeName ? { id: storeId, name: storeName } : null;
  const validUntil = advertisedEndDate(html, options.collectedAt);
  const offers: RawOffer[] = [];
  const productIds: string[] = [];
  const cardParts = html.split(
    /<div class="TalkerGrid__Item" role="listitem">/i,
  );

  for (const card of cardParts.slice(1)) {
    const nameTag = card.match(
      /<div[^>]+class="talker__name talker__section"[^>]*>/i,
    )?.[0];
    // The visible span often omits the size, while the title attribute and
    // analytics item_name retain it. Join metadata on the complete identity.
    const sourceName =
      (nameTag ? attribute(nameTag, 'title') : null) ??
      stripHtml(
        card.match(
          /<span class="talker__product-name">([\s\S]*?)<\/span>/i,
        )?.[1] ?? '',
      );
    if (!sourceName) continue;

    const href = decodeHtml(
      card.match(/<a[^>]+href=["'](\/lines\/[^"']+)["']/i)?.[1] ?? '',
    );
    const lineId = clean(card.match(/id="line_([^"]+)"/i)?.[1]);
    const imageTag = card.match(/<img[^>]+alt="Photo of[^"]*"[^>]*>/i)?.[0];
    const imageUrl = imageTag ? attribute(imageTag, 'src') : null;
    const currentPriceCents = parseDollars(
      card.match(/<strong class="price__sell"[^>]*>\s*\$([\d,.]+)/i)?.[1],
    );
    const regularPriceCents = parseDollars(
      card.match(
        /<span class="talker__prices__was weak">[\s\S]*?was\s+\$([\d,.]+)/i,
      )?.[1],
    );
    const key = normalizeKey(sourceName);
    const candidates = trackedByName.get(key) ?? [];
    const trackingProduct = candidates.shift();
    if (candidates.length === 0) trackedByName.delete(key);
    const sourceProductId =
      lineId ??
      clean(trackingProduct?.item_id) ??
      clean(href.slice('/lines/'.length));
    if (!sourceProductId || !href) continue;
    productIds.push(sourceProductId);
    if (currentPriceCents === null || currentPriceCents <= 0) continue;
    const isSpecial =
      options.scope !== 'catalogue' ||
      /\btalker--Special\b/i.test(
        card.match(/<div class="talker\b[^>]*>/i)?.[0] ?? '',
      ) ||
      (regularPriceCents !== null && regularPriceCents > currentPriceCents);

    offers.push({
      sourceProductId,
      sourceName,
      brand: clean(trackingProduct?.item_brand),
      category:
        clean(trackingProduct?.item_category3) ??
        clean(trackingProduct?.item_category2) ??
        clean(trackingProduct?.item_category),
      size: extractSizeLabel(sourceName),
      gtin: null,
      imageUrl,
      sourceUrl: new URL(href, options.origin).toString(),
      regularPriceCents:
        regularPriceCents ?? (isSpecial ? null : currentPriceCents),
      promoPriceCents: isSpecial ? currentPriceCents : null,
      memberPriceCents: null,
      promotionType: isSpecial ? 'SPECIAL' : null,
      promotionText: isSpecial ? `${options.retailerName} special` : null,
      validUntil: isSpecial ? validUntil : null,
      collectedAt: options.collectedAt,
    });
  }

  const reportedTotal = html
    .match(/<strong>Refine<\/strong>\s*<span>([\d,]+)\s+results<\/span>/i)?.[1]
    ?.replaceAll(',', '');
  if (options.scope === 'catalogue' && reportedTotal === undefined) {
    throw new Error(
      'Catalogue page does not identify its total product count.',
    );
  }
  const totalItems = Number(reportedTotal ?? offers.length);
  const pageNumbers = [...html.matchAll(/aria-label="Page\s+(\d+)"/gi)].map(
    (match) => Number(match[1]),
  );
  const totalPages = Math.max(1, ...pageNumbers.filter(Number.isSafeInteger));

  return { offers, productIds, totalItems, totalPages, store };
}

export class MyFoodLinkCollector implements RetailerCollector {
  readonly retailerSlug: string;

  private readonly retailerName: string;
  private readonly storeOrigin: string;
  private readonly city: string;
  private readonly address: string | null;
  private readonly transport: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly maxPages: number;
  private readonly maxCataloguePages: number;
  private readonly pageDelayMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private firstPage?: string;

  constructor(options: MyFoodLinkCollectorOptions) {
    this.retailerSlug = options.retailerSlug;
    this.retailerName = options.retailerName;
    this.storeOrigin = new URL(options.storeOrigin).origin;
    this.city = options.city;
    this.address = clean(options.address);
    this.transport = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.maxCataloguePages = options.maxCataloguePages ?? 500;
    if (
      !Number.isSafeInteger(this.maxCataloguePages) ||
      this.maxCataloguePages < 1
    ) {
      throw new Error('Catalogue page budget must be a positive integer.');
    }
    this.pageDelayMs = options.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  private async requestUrl(url: URL, redirect: RequestRedirect = 'follow') {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.transport(url, {
          cache: 'no-store',
          redirect,
          headers: {
            accept: 'text/html,application/xhtml+xml,application/json',
            'user-agent': USER_AGENT,
          },
          signal: controller.signal,
        });
        if (response.ok) return await response.text();
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === this.retries) {
          throw new Error(
            `${this.retailerName} request to ${url.pathname} returned HTTP ${String(response.status)}.`,
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
    throw new Error(`${this.retailerName} collection failed: ${message}`);
  }

  private async request(page: number, baseUrl?: string) {
    const url = baseUrl
      ? new URL(baseUrl, this.storeOrigin)
      : new URL('/specials', this.storeOrigin);
    if (page > 1) {
      url.searchParams.set('page', String(page));
      if (!url.searchParams.getAll('q[]').includes('special:1')) {
        url.searchParams.append('q[]', 'special:1');
      }
    }
    return this.requestUrl(url);
  }

  private async loadFirstPage() {
    this.firstPage ??= await this.request(1);
    return this.firstPage;
  }

  async getStores() {
    const parsed = parseMyFoodLinkPage(await this.loadFirstPage(), {
      origin: this.storeOrigin,
      retailerName: this.retailerName,
      collectedAt: new Date(),
    });
    if (!parsed.store) {
      throw new Error(
        `${this.retailerName} did not identify its online store.`,
      );
    }
    return [
      {
        sourceStoreId: parsed.store.id,
        name: parsed.store.name,
        city: this.city,
        address: this.address,
      },
    ];
  }

  async getSpecials(store: CollectorStore) {
    return (await this.collectSpecials(store)).offers;
  }

  async getCatalogue(store: CollectorStore) {
    return (await this.collectCatalogue(store)).offers;
  }

  async collectCatalogue(
    expectedStore?: CollectorStore,
  ): Promise<MyFoodLinkCollection> {
    const collectedAt = new Date();
    const homeHtml = await this.requestUrl(
      new URL('/', this.storeOrigin),
      'error',
    );
    const home = parseMyFoodLinkPage(homeHtml, {
      origin: this.storeOrigin,
      retailerName: this.retailerName,
      collectedAt,
    });
    if (
      !home.store ||
      (expectedStore && home.store.id !== expectedStore.sourceStoreId)
    ) {
      throw new Error(
        `${this.retailerName} catalogue store identity changed mid-run.`,
      );
    }
    const selectedStore = expectedStore ?? {
      sourceStoreId: home.store.id,
      name: home.store.name,
      city: this.city,
      address: this.address,
    };
    let pagesCollected = 0;
    const requestPage = async (slug: string, page = 1) => {
      if (++pagesCollected > this.maxCataloguePages) {
        throw new Error(
          `${this.retailerName} exceeded its catalogue page budget; refusing a partial snapshot.`,
        );
      }
      if (pagesCollected > 1 && this.pageDelayMs > 0)
        await this.sleep(this.pageDelayMs);
      const url = new URL(
        `/category/${encodeURIComponent(slug)}`,
        this.storeOrigin,
      );
      if (page > 1) url.searchParams.set('page', String(page));
      // Normal category URLs have no specials/search filters. Adding special:1
      // here would silently narrow later pages back to promotional products.
      const html = await this.requestUrl(url, 'error');
      const parsed = parseMyFoodLinkPage(html, {
        origin: this.storeOrigin,
        retailerName: this.retailerName,
        collectedAt,
        scope: 'catalogue',
      });
      if (!parsed.store || parsed.store.id !== selectedStore.sourceStoreId) {
        throw new Error(
          `${this.retailerName} catalogue store identity changed mid-run.`,
        );
      }
      return { html, parsed };
    };
    const collectCategory = async (
      category: CatalogueCategory,
      page: ParsedPage,
    ): Promise<{ ids: Set<string>; offers: Map<string, RawOffer> }> => {
      const ids = new Set<string>();
      const offers = new Map<string, RawOffer>();
      const mergePage = (parsed: ParsedPage) => {
        for (const id of parsed.productIds) ids.add(id);
        for (const offer of parsed.offers)
          offers.set(offer.sourceProductId, offer);
      };
      if (page.totalPages <= Math.min(this.maxPages, PLATFORM_PAGE_CAP)) {
        mergePage(page);
        for (let index = 2; index <= page.totalPages; index += 1) {
          const next = (await requestPage(category.slug, index)).parsed;
          if (
            next.totalItems !== page.totalItems ||
            next.totalPages !== page.totalPages
          ) {
            throw new Error(
              `${this.retailerName} catalogue category ${category.slug} changed during collection.`,
            );
          }
          mergePage(next);
        }
      } else {
        if (!category.children.length) {
          throw new Error(
            `${this.retailerName} catalogue leaf ${category.slug} exceeds the page limit and cannot be partitioned.`,
          );
        }
        for (const child of category.children) {
          const next = (await requestPage(child.slug)).parsed;
          const branch = await collectCategory(child, next);
          for (const id of branch.ids) ids.add(id);
          for (const [id, offer] of branch.offers) offers.set(id, offer);
        }
      }
      if (ids.size !== page.totalItems) {
        throw new Error(
          `${this.retailerName} catalogue category ${category.slug} reported ${page.totalItems} products but ${ids.size} unique items were collected; refusing a partial snapshot.`,
        );
      }
      // Every item visible on the parent preview must also belong to a child.
      if (page.productIds.some((id) => !ids.has(id))) {
        throw new Error(
          `${this.retailerName} catalogue partitions omitted a parent product.`,
        );
      }
      return { ids, offers };
    };

    const navigationTag =
      homeHtml.match(
        /<[^>]+data-data-url="[^"]+"[^>]*\bid="sidebar"[^>]*>/i,
      )?.[0] ??
      homeHtml.match(
        /<[^>]+\bid="sidebar"[^>]*data-data-url="[^"]+"[^>]*>/i,
      )?.[0];
    const value = navigationTag
      ? attribute(navigationTag, 'data-data-url')
      : null;
    if (!value)
      throw new Error(
        `${this.retailerName} catalogue has no department navigation.`,
      );
    const url = new URL(value, this.storeOrigin);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      ![
        new URL(this.storeOrigin).host,
        'dtgxwmigmg3gc.cloudfront.net',
      ].includes(url.host) ||
      !url.pathname.startsWith(
        `/sidebar/${encodeURIComponent(selectedStore.sourceStoreId)}/`,
      )
    ) {
      throw new Error(
        `${this.retailerName} catalogue navigation has an unexpected origin or store.`,
      );
    }
    const root = parseCatalogueTree(
      JSON.parse(await this.requestUrl(url, 'error')) as unknown,
    );
    // "All Departments" is a virtual navigation node, not /category/all.
    // Collect every real department and validate each against its own count.
    const catalogue = {
      ids: new Set<string>(),
      offers: new Map<string, RawOffer>(),
    };
    for (const category of root.children) {
      const first = (await requestPage(category.slug)).parsed;
      const branch = await collectCategory(category, first);
      for (const id of branch.ids) catalogue.ids.add(id);
      for (const [id, offer] of branch.offers) catalogue.offers.set(id, offer);
    }
    if (!catalogue.offers.size) {
      throw new Error(
        `${this.retailerName} catalogue returned no usable prices.`,
      );
    }
    return {
      store: selectedStore,
      offers: [...catalogue.offers.values()],
      pagesCollected,
      totalItemsReported: catalogue.ids.size,
      unpricedItems: catalogue.ids.size - catalogue.offers.size,
      scope: 'catalogue',
    };
  }

  private async categoryUrls(html: string) {
    const encodedUrl = html.match(/data-sidebar-facet-url="([^"]+)"/i)?.[1];
    if (!encodedUrl) {
      throw new Error(
        `${this.retailerName} exceeded the page cap but returned no category facets.`,
      );
    }
    const response = await this.requestUrl(
      new URL(decodeHtml(encodedUrl), this.storeOrigin),
    );
    const document = JSON.parse(response) as {
      more_sections?: Array<{
        group?: string;
        facets?: Array<{ url?: string }>;
      }>;
    };
    const urls =
      document.more_sections
        ?.filter((section) => section.group === 'categories')
        .flatMap((section) => section.facets ?? [])
        .map((facet) => clean(facet.url))
        .filter((url): url is string => Boolean(url)) ?? [];
    if (urls.length === 0) {
      throw new Error(
        `${this.retailerName} exceeded the page cap but returned no category URLs.`,
      );
    }
    return [...new Set(urls)];
  }

  private async collectPageSet(
    baseUrl: string | undefined,
    firstHtml: string | undefined,
    collectedAt: Date,
  ) {
    const first = parseMyFoodLinkPage(
      firstHtml ?? (await this.request(1, baseUrl)),
      {
        origin: this.storeOrigin,
        retailerName: this.retailerName,
        collectedAt,
      },
    );
    if (first.totalPages > this.maxPages) {
      throw new Error(
        `${this.retailerName} needs ${String(first.totalPages)} pages, above the configured ${String(this.maxPages)} page limit.`,
      );
    }
    if (first.totalPages > PLATFORM_PAGE_CAP) {
      throw new Error(
        `${this.retailerName} category still exceeds the ${String(PLATFORM_PAGE_CAP)}-page upstream cap.`,
      );
    }
    const offers = new Map(
      first.offers.map((offer) => [offer.sourceProductId, offer]),
    );
    for (let page = 2; page <= first.totalPages; page += 1) {
      if (this.pageDelayMs > 0) await this.sleep(this.pageDelayMs);
      const parsed = parseMyFoodLinkPage(await this.request(page, baseUrl), {
        origin: this.storeOrigin,
        retailerName: this.retailerName,
        collectedAt,
      });
      for (const offer of parsed.offers) {
        offers.set(offer.sourceProductId, offer);
      }
    }
    if (first.totalItems > 0 && offers.size !== first.totalItems) {
      throw new Error(
        `${this.retailerName} partition reported ${String(first.totalItems)} specials but ${String(offers.size)} unique offers were parsed.`,
      );
    }
    return {
      offers,
      pagesCollected: first.totalPages,
      totalItems: first.totalItems,
    };
  }

  async collectSpecials(store?: CollectorStore): Promise<MyFoodLinkCollection> {
    const [selectedStore] = store ? [store] : await this.getStores();
    if (!selectedStore) {
      throw new Error(`${this.retailerName} returned no selected store.`);
    }
    const collectedAt = new Date();
    const first = parseMyFoodLinkPage(await this.loadFirstPage(), {
      origin: this.storeOrigin,
      retailerName: this.retailerName,
      collectedAt,
    });
    if (first.store?.id !== selectedStore.sourceStoreId) {
      throw new Error(`${this.retailerName} store identity changed mid-run.`);
    }
    const offers = new Map<string, RawOffer>();
    let pagesCollected = 0;
    if (first.totalPages <= PLATFORM_PAGE_CAP) {
      const complete = await this.collectPageSet(
        undefined,
        await this.loadFirstPage(),
        collectedAt,
      );
      pagesCollected = complete.pagesCollected;
      for (const offer of complete.offers.values()) {
        offers.set(offer.sourceProductId, offer);
      }
    } else {
      // MyFoodLink renders page links beyond 50, but its search backend returns
      // an empty page after that cap. Top-level departments are disjoint, so
      // collecting each facet preserves completeness without duplicate writes.
      const categoryUrls = await this.categoryUrls(await this.loadFirstPage());
      pagesCollected = 1;
      for (const categoryUrl of categoryUrls) {
        if (this.pageDelayMs > 0) await this.sleep(this.pageDelayMs);
        const complete = await this.collectPageSet(
          categoryUrl,
          undefined,
          collectedAt,
        );
        pagesCollected += complete.pagesCollected;
        for (const offer of complete.offers.values()) {
          offers.set(offer.sourceProductId, offer);
        }
      }
    }

    if (first.totalItems > 0 && offers.size !== first.totalItems) {
      throw new Error(
        `${this.retailerName} reported ${String(first.totalItems)} specials but ${String(offers.size)} unique offers were parsed; refusing a partial snapshot.`,
      );
    }
    return {
      store: selectedStore,
      offers: [...offers.values()],
      pagesCollected,
      totalItemsReported: first.totalItems,
    };
  }
}

export type BannerCollectorOptions = Partial<
  Omit<
    MyFoodLinkCollectorOptions,
    'retailerSlug' | 'retailerName' | 'storeOrigin' | 'city'
  >
> & {
  storeOrigin?: string;
  city?: string;
};

export class FreshChoiceCollector extends MyFoodLinkCollector {
  constructor(options: BannerCollectorOptions = {}) {
    const defaultStore =
      !options.storeOrigin ||
      new URL(options.storeOrigin).origin ===
        'https://epsom.store.freshchoice.co.nz';
    super({
      retailerSlug: 'freshchoice',
      retailerName: 'FreshChoice',
      storeOrigin:
        options.storeOrigin ?? 'https://epsom.store.freshchoice.co.nz',
      city: options.city ?? (defaultStore ? 'Auckland' : 'New Zealand'),
      address:
        options.address ??
        (defaultStore
          ? '233A Green Lane West, Epsom, Auckland 1051'
          : undefined),
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      retries: options.retries,
      maxPages: options.maxPages,
      maxCataloguePages: options.maxCataloguePages,
      pageDelayMs: options.pageDelayMs,
      sleep: options.sleep,
    });
  }
}

export class SuperValueCollector extends MyFoodLinkCollector {
  constructor(options: BannerCollectorOptions = {}) {
    const defaultStore =
      !options.storeOrigin ||
      new URL(options.storeOrigin).origin ===
        'https://milton.store.supervalue.co.nz';
    super({
      retailerSlug: 'supervalue',
      retailerName: 'SuperValue',
      storeOrigin:
        options.storeOrigin ?? 'https://milton.store.supervalue.co.nz',
      city: options.city ?? (defaultStore ? 'Milton' : 'New Zealand'),
      address:
        options.address ??
        (defaultStore ? '59 Union Street, Milton 9220' : undefined),
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      retries: options.retries,
      maxPages: options.maxPages,
      maxCataloguePages: options.maxCataloguePages,
      pageDelayMs: options.pageDelayMs,
      sleep: options.sleep,
    });
  }
}
