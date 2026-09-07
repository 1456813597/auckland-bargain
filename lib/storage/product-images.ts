import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import { BlobNotFoundError, head, put } from '@vercel/blob';

import { getSupabaseAdmin } from '@/db/supabase';
import type { RawOffer } from '@/lib/collectors/types';

const IMAGE_UPLOAD_CONCURRENCY = 12;
// Bounds one function invocation, not the month. Claiming more slots than a
// single run can actually upload would spend the shared budget on nothing.
const MAX_IMAGE_UPLOADS_PER_RUN = 48;
const IMMUTABLE_CACHE_SECONDS = 31_536_000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const INDEX_LOOKUP_BATCH = 200;
const FAILED_MIRROR_RETRY_DAYS = 30;
// Vercel Blob counts `put` as an advanced operation and includes 10,000 per
// month on Hobby. Staying under the included amount keeps a slow, incremental
// mirror from locking the whole store for 30 days.
const DEFAULT_MONTHLY_UPLOAD_BUDGET = 8_000;
const MAX_MONTHLY_UPLOAD_BUDGET = 1_000_000;

export type MirrorDatabase = Pick<SupabaseClient, 'from' | 'rpc'>;

type PutOptions = {
  access: 'public';
  addRandomSuffix: boolean;
  cacheControlMaxAge: number;
  contentType: string;
};

// Declared with method syntax so the real `@vercel/blob` functions, whose
// option types are wider than the subset used here, satisfy the shape.
export type BlobClient = {
  head(pathname: string): Promise<{ url: string }>;
  put(
    pathname: string,
    body: ArrayBuffer,
    options: PutOptions,
  ): Promise<{ url: string }>;
};

export type MirrorOptions = {
  database?: MirrorDatabase;
  blob?: BlobClient;
  environment?: Record<string, string | undefined>;
  fetchImage?: typeof fetch;
  now?: () => Date;
};

type MirrorRow = {
  pathname: string;
  blob_url: string | null;
  status: string;
  retry_after: string | null;
};

function mirroringEnabled(environment: Record<string, string | undefined>) {
  // An explicit opt-out matters more than the token: a project can keep its
  // store linked for previously mirrored images while spending nothing new.
  if (environment.PRODUCT_IMAGE_MIRROR === 'off') return false;
  return Boolean(
    environment.BLOB_READ_WRITE_TOKEN ||
    (environment.VERCEL_OIDC_TOKEN && environment.BLOB_STORE_ID),
  );
}

export function monthlyUploadBudget(
  environment: Record<string, string | undefined>,
) {
  const raw = environment.PRODUCT_IMAGE_MIRROR_MONTHLY_UPLOADS;
  if (raw === undefined || raw === '') return DEFAULT_MONTHLY_UPLOAD_BUDGET;
  // Reject anything that is not exactly an integer rather than silently
  // reinterpreting "8_000" or "8000 uploads" as a different amount of spend.
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed > MAX_MONTHLY_UPLOAD_BUDGET) {
    throw new Error(
      `PRODUCT_IMAGE_MIRROR_MONTHLY_UPLOADS must be an integer between 0 and ${MAX_MONTHLY_UPLOAD_BUDGET}.`,
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
// second store to see it is answered from the index without any blob request.
export function productImagePath(retailerSlug: string, offer: RawOffer) {
  const sourceHash = createHash('sha256')
    .update(offer.imageUrl ?? '')
    .digest('hex')
    .slice(0, 16);
  return [
    'product-images',
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
      .select('pathname,blob_url,status,retry_after')
      .in('pathname', batch);
    if (error) {
      throw new Error(`Load product image mirrors: ${error.message}`);
    }
    for (const row of (data ?? []) as MirrorRow[]) rows.set(row.pathname, row);
  }
  return rows;
}

async function claimUploadSlots(
  database: MirrorDatabase,
  requested: number,
  monthlyLimit: number,
) {
  const { data, error } = await database.rpc('claim_blob_upload_slots', {
    p_requested: requested,
    p_monthly_limit: monthlyLimit,
  });
  if (error) throw new Error(`Claim blob upload slots: ${error.message}`);
  const granted = Number(data);
  if (!Number.isSafeInteger(granted) || granted < 0 || granted > requested) {
    throw new Error('Blob upload budget returned an invalid grant.');
  }
  return granted;
}

type MirrorRecord = {
  pathname: string;
  retailer_slug: string;
  source_url: string | null;
  blob_url: string | null;
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

async function uploadImage(
  pathname: string,
  sourceUrl: string,
  blob: BlobClient,
  fetchImage: typeof fetch,
) {
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

  try {
    const uploaded = await blob.put(pathname, imageBytes, {
      access: 'public',
      addRandomSuffix: false,
      cacheControlMaxAge: IMMUTABLE_CACHE_SECONDS,
      contentType,
    });
    return uploaded.url;
  } catch (error) {
    // A blob left behind by an earlier deployment, or a concurrent store
    // collection, already holds this immutable pathname. `head` is a simple
    // operation, an order of magnitude cheaper than retrying the upload, and
    // the answer is written to the index so this never repeats.
    try {
      return (await blob.head(pathname)).url;
    } catch (headError) {
      if (headError instanceof BlobNotFoundError) throw error;
      throw headError;
    }
  }
}

export async function mirrorOfferImages(
  retailerSlug: string,
  offers: RawOffer[],
  options: MirrorOptions = {},
) {
  const environment = options.environment ?? process.env;
  if (!mirroringEnabled(environment)) return offers;

  const budget = monthlyUploadBudget(environment);
  const now = options.now ?? (() => new Date());
  const database = options.database ?? getSupabaseAdmin();
  const blob = options.blob ?? ({ head, put } satisfies BlobClient);
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
    // this run serves retailer URLs rather than re-uploading the catalogue.
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
    if (row?.status === 'mirrored' && row.blob_url) {
      mirrored[target.index] = { ...target.offer, imageUrl: row.blob_url };
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

  const queue = [...pending.values()].slice(0, MAX_IMAGE_UPLOADS_PER_RUN);
  let slots: number;
  try {
    slots = await claimUploadSlots(database, queue.length, budget);
  } catch (error) {
    console.warn(
      `Could not claim ${retailerSlug} product image upload budget; using retailer URLs for this run.`,
      error,
    );
    return mirrored;
  }
  if (slots === 0) {
    console.warn(
      `Reached the monthly product image mirror budget of ${budget} uploads; using retailer URLs for ${pending.size} ${retailerSlug} images.`,
    );
    return mirrored;
  }

  const claimed = queue.slice(0, slots);
  const records: MirrorRecord[] = [];
  const retryAfter = new Date(
    at.getTime() + FAILED_MIRROR_RETRY_DAYS * 86_400_000,
  ).toISOString();
  for (const batch of chunks(claimed, IMAGE_UPLOAD_CONCURRENCY)) {
    await Promise.all(
      batch.map(async (target) => {
        const sourceUrl = target.offer.imageUrl!;
        try {
          const blobUrl = await uploadImage(
            target.pathname,
            sourceUrl,
            blob,
            fetchImage,
          );
          mirrored[target.index] = { ...target.offer, imageUrl: blobUrl };
          records.push({
            pathname: target.pathname,
            retailer_slug: retailerSlug,
            source_url: sourceUrl,
            blob_url: blobUrl,
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
            blob_url: null,
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
    // The uploads themselves succeeded; losing the index entry only means the
    // next run pays a `head` to rediscover them, never a duplicate upload.
    console.warn(
      `Could not record ${retailerSlug} product image mirror results.`,
      error,
    );
  }
  return mirrored;
}

export type BlobLister = (options: {
  prefix: string;
  limit: number;
  cursor?: string;
}) => Promise<{
  blobs: { pathname: string; url: string }[];
  cursor?: string;
  hasMore: boolean;
}>;

const INDEX_PREFIX = 'product-images/';

// One-off adoption of blobs uploaded before the index existed. This is the only
// `list` in the codebase: it costs one advanced operation per 1,000 blobs, once,
// instead of the full prefix walk the collector used to pay on every store run.
export async function seedProductImageIndex(
  options: {
    database?: MirrorDatabase;
    list?: BlobLister;
    execute?: boolean;
    now?: () => Date;
  } = {},
) {
  const database = options.database ?? getSupabaseAdmin();
  const listBlobs = options.list;
  if (!listBlobs) throw new Error('A blob listing function is required.');
  const at = (options.now ?? (() => new Date()))();

  const records: MirrorRecord[] = [];
  const skipped: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await listBlobs({
      prefix: INDEX_PREFIX,
      limit: 1_000,
      cursor,
    });
    pages += 1;
    for (const blob of page.blobs) {
      const retailerSlug = blob.pathname.split('/')[1];
      if (!retailerSlug) {
        skipped.push(blob.pathname);
        continue;
      }
      records.push({
        pathname: blob.pathname,
        retailer_slug: retailerSlug,
        source_url: null,
        blob_url: blob.url,
        status: 'mirrored',
        last_error: null,
        retry_after: null,
        updated_at: at.toISOString(),
      });
    }
    if (page.hasMore && !page.cursor) {
      throw new Error('Vercel Blob returned another page without a cursor.');
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  if (options.execute) await recordMirrorResults(database, records);
  return {
    mode: options.execute ? ('execute' as const) : ('preview' as const),
    listPages: pages,
    adopted: records.length,
    written: options.execute ? records.length : 0,
    skipped,
  };
}
