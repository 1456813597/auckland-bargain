import { createHash } from 'node:crypto';

import { getDatabase, type Database } from '@/db/client';
import type { RawOffer } from '@/lib/collectors/types';
import {
  createFilesystemImageStore,
  listStoredImages,
  PRODUCT_IMAGE_PREFIX,
  type ImageStore,
} from '@/lib/storage/image-store';

const IMAGE_DOWNLOAD_CONCURRENCY = 12;
// Bounds one collection run, not the disk. A run that claimed more than it can
// actually download would only delay the rest of the catalogue.
const MAX_IMAGE_UPLOADS_PER_RUN = 48;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const INDEX_LOOKUP_BATCH = 200;
const FAILED_MIRROR_RETRY_DAYS = 30;
// A self-hosted store pays disk, not per-operation fees. The ceiling keeps a
// growing mirror from filling a small VPS volume and taking the site with it.
const DEFAULT_STORE_BYTE_LIMIT = 8 * 1024 * 1024 * 1024;
const MAX_STORE_BYTE_LIMIT = 1024 * 1024 * 1024 * 1024;

export type MirrorDatabase = Database;

export type MirrorOptions = {
  database?: MirrorDatabase;
  store?: ImageStore;
  environment?: Record<string, string | undefined>;
  fetchImage?: typeof fetch;
  now?: () => Date;
};

type MirrorRow = {
  pathname: string;
  stored_url: string | null;
  status: string;
  retry_after: string | null;
};

function mirroringEnabled(environment: Record<string, string | undefined>) {
  // Explicitly off keeps serving images already in the store while spending no
  // more disk. Anything else mirrors, because the store is a local directory.
  return environment.PRODUCT_IMAGE_MIRROR !== 'off';
}

export function imageStoreByteLimit(
  environment: Record<string, string | undefined>,
) {
  const raw = environment.PRODUCT_IMAGE_MIRROR_MAX_BYTES;
  if (raw === undefined || raw === '') return DEFAULT_STORE_BYTE_LIMIT;
  // Reject anything that is not exactly an integer rather than silently
  // reinterpreting "8_000" or "8 GB" as a different amount of disk.
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed > MAX_STORE_BYTE_LIMIT) {
    throw new Error(
      `PRODUCT_IMAGE_MIRROR_MAX_BYTES must be an integer between 0 and ${MAX_STORE_BYTE_LIMIT}.`,
    );
  }
  return parsed;
}

function safePathSegment(value: string) {
  return (
    value
      .toLocaleLowerCase('en-NZ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'product'
  );
}

function imageExtension(sourceUrl: string) {
  try {
    const extension = new URL(sourceUrl).pathname
      .split('.')
      .pop()
      ?.toLocaleLowerCase('en-NZ');
    if (
      extension &&
      ['avif', 'gif', 'jpeg', 'jpg', 'png', 'webp'].includes(extension)
    ) {
      return extension === 'jpeg' ? 'jpg' : extension;
    }
  } catch {
    // The collector already validates URLs. Keep a safe fallback for old rows.
  }
  return 'jpg';
}

// Content addressed by retailer, product and source URL. The same product image
// therefore resolves to one pathname across every store of a banner, so the
// second store to see it is answered from the index without touching the disk.
export function productImagePath(retailerSlug: string, offer: RawOffer) {
  const sourceHash = createHash('sha256')
    .update(offer.imageUrl ?? '')
    .digest('hex')
    .slice(0, 16);
  return [
    PRODUCT_IMAGE_PREFIX.slice(0, -1),
    safePathSegment(retailerSlug),
    `${safePathSegment(offer.sourceProductId)}-${sourceHash}.${imageExtension(offer.imageUrl ?? '')}`,
  ].join('/');
}

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function loadMirrorIndex(database: MirrorDatabase, pathnames: string[]) {
  const rows = new Map<string, MirrorRow>();
  for (const batch of chunks(pathnames, INDEX_LOOKUP_BATCH)) {
    const { data, error } = await database
      .from('product_image_mirrors')
      .select('pathname,stored_url,status,retry_after')
      .in('pathname', batch);
    if (error) {
      throw new Error(`Load product image mirrors: ${error.message}`);
    }
    for (const row of (data ?? []) as MirrorRow[]) rows.set(row.pathname, row);
  }
  return rows;
}

async function storedBytes(database: MirrorDatabase) {
  const { data, error } = await database.rpc('product_image_store_bytes');
  if (error)
    throw new Error(`Read product image store usage: ${error.message}`);
  const used = Number(data);
  if (!Number.isSafeInteger(used) || used < 0) {
    throw new Error('Product image store usage returned an invalid size.');
  }
  return used;
}

type MirrorRecord = {
  pathname: string;
  retailer_slug: string;
  source_url: string | null;
  stored_url: string | null;
  byte_size: number | null;
  status: 'mirrored' | 'failed';
  last_error: string | null;
  retry_after: string | null;
  updated_at: string;
};

async function recordMirrorResults(
  database: MirrorDatabase,
  records: MirrorRecord[],
) {
  if (records.length === 0) return;
  for (const batch of chunks(records, INDEX_LOOKUP_BATCH)) {
    const { error } = await database
      .from('product_image_mirrors')
      .upsert(batch, { onConflict: 'pathname' });
    if (error) {
      throw new Error(`Record product image mirrors: ${error.message}`);
    }
  }
}

async function storeImage(
  pathname: string,
  sourceUrl: string,
  store: ImageStore,
  fetchImage: typeof fetch,
) {
  // A file already on disk answers without another retailer request. That is
  // what makes a lost or rebuilt index cheap instead of a full re-download.
  const existing = await store.head(pathname);
  if (existing) return existing;

  const response = await fetchImage(sourceUrl, {
    headers: {
      accept: 'image/avif,image/webp,image/png,image/jpeg,image/*',
      'user-agent': 'AucklandBargain/0.1',
    },
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(
      `Product image request failed with HTTP ${response.status}.`,
    );
  }

  const contentType = response.headers.get('content-type')?.split(';')[0];
  if (!contentType?.startsWith('image/')) {
    throw new Error(
      `Product image returned ${contentType ?? 'an unknown content type'}.`,
    );
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > MAX_IMAGE_BYTES) {
    throw new Error(`Product image is larger than ${MAX_IMAGE_BYTES} bytes.`);
  }
  const imageBytes = await response.arrayBuffer();
  if (imageBytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Product image is larger than ${MAX_IMAGE_BYTES} bytes.`);
  }

  return store.put(pathname, imageBytes, { contentType });
}

export async function mirrorOfferImages(
  retailerSlug: string,
  offers: RawOffer[],
  options: MirrorOptions = {},
) {
  const environment = options.environment ?? process.env;
  if (!mirroringEnabled(environment)) return offers;

  const limit = imageStoreByteLimit(environment);
  const now = options.now ?? (() => new Date());
  const database = options.database ?? getDatabase();
  const store = options.store ?? createFilesystemImageStore(environment);
  const fetchImage = options.fetchImage ?? fetch;

  const targets = offers.flatMap((offer, index) =>
    offer.imageUrl
      ? [{ index, offer, pathname: productImagePath(retailerSlug, offer) }]
      : [],
  );
  if (targets.length === 0) return offers;

  let index: Map<string, MirrorRow>;
  try {
    index = await loadMirrorIndex(database, [
      ...new Set(targets.map((target) => target.pathname)),
    ]);
  } catch (error) {
    // Without the index there is no cheap way to tell mirrored images apart, so
    // this run serves retailer URLs rather than re-downloading the catalogue.
    console.warn(
      `Could not read the ${retailerSlug} product image index; using retailer URLs for this run.`,
      error,
    );
    return offers;
  }

  const mirrored = [...offers];
  const pending = new Map<string, (typeof targets)[number]>();
  const at = now();
  for (const target of targets) {
    const row = index.get(target.pathname);
    if (row?.status === 'mirrored' && row.stored_url) {
      mirrored[target.index] = { ...target.offer, imageUrl: row.stored_url };
      continue;
    }
    if (
      row?.status === 'failed' &&
      row.retry_after &&
      new Date(row.retry_after) > at
    ) {
      continue;
    }
    pending.set(target.pathname, target);
  }
  if (pending.size === 0) return mirrored;

  let used: number;
  try {
    used = await storedBytes(database);
  } catch (error) {
    console.warn(
      `Could not read the product image store usage; using retailer URLs for ${pending.size} ${retailerSlug} images.`,
      error,
    );
    return mirrored;
  }
  if (used >= limit) {
    console.warn(
      `Product image store is using ${used} of ${limit} bytes; using retailer URLs for ${pending.size} ${retailerSlug} images.`,
    );
    return mirrored;
  }

  const claimed = [...pending.values()].slice(0, MAX_IMAGE_UPLOADS_PER_RUN);
  const records: MirrorRecord[] = [];
  const retryAfter = new Date(
    at.getTime() + FAILED_MIRROR_RETRY_DAYS * 86_400_000,
  ).toISOString();
  let remaining = limit - used;
  for (const batch of chunks(claimed, IMAGE_DOWNLOAD_CONCURRENCY)) {
    if (remaining <= 0) break;
    await Promise.all(
      batch.map(async (target) => {
        const sourceUrl = target.offer.imageUrl!;
        try {
          const stored = await storeImage(
            target.pathname,
            sourceUrl,
            store,
            fetchImage,
          );
          remaining -= stored.byteSize;
          mirrored[target.index] = { ...target.offer, imageUrl: stored.url };
          records.push({
            pathname: target.pathname,
            retailer_slug: retailerSlug,
            source_url: sourceUrl,
            stored_url: stored.url,
            byte_size: stored.byteSize,
            status: 'mirrored',
            last_error: null,
            retry_after: null,
            updated_at: at.toISOString(),
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Unknown mirror failure';
          console.warn(
            `Could not mirror product image for ${target.offer.sourceProductId}; using the retailer URL.`,
            error,
          );
          records.push({
            pathname: target.pathname,
            retailer_slug: retailerSlug,
            source_url: sourceUrl,
            stored_url: null,
            byte_size: null,
            status: 'failed',
            last_error: message.slice(0, 2_000),
            retry_after: retryAfter,
            updated_at: at.toISOString(),
          });
        }
      }),
    );
  }

  try {
    await recordMirrorResults(database, records);
  } catch (error) {
    // The files themselves are written; losing the index entry only means the
    // next run pays one `stat` to rediscover them, never a second download.
    console.warn(
      `Could not record ${retailerSlug} product image mirror results.`,
      error,
    );
  }
  return mirrored;
}

// One-off registration of files that exist on disk but not in the index: after
// restoring a volume backup, or after moving the store between servers.
export async function adoptStoredImages(
  options: {
    database?: MirrorDatabase;
    environment?: Record<string, string | undefined>;
    execute?: boolean;
    now?: () => Date;
  } = {},
) {
  const database = options.database ?? getDatabase();
  const environment = options.environment ?? process.env;
  const at = (options.now ?? (() => new Date()))();

  const records: MirrorRecord[] = [];
  for await (const entry of listStoredImages(environment)) {
    records.push({
      pathname: entry.pathname,
      retailer_slug: entry.retailerSlug,
      source_url: null,
      stored_url: entry.url,
      byte_size: entry.byteSize,
      status: 'mirrored',
      last_error: null,
      retry_after: null,
      updated_at: at.toISOString(),
    });
  }

  if (options.execute) await recordMirrorResults(database, records);
  return {
    mode: options.execute ? ('execute' as const) : ('preview' as const),
    found: records.length,
    bytes: records.reduce(
      (total, record) => total + (record.byte_size ?? 0),
      0,
    ),
    written: options.execute ? records.length : 0,
  };
}
