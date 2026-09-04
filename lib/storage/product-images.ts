import { createHash } from 'node:crypto';

import { BlobNotFoundError, head, list, put } from '@vercel/blob';

import type { RawOffer } from '@/lib/collectors/types';

const IMAGE_UPLOAD_CONCURRENCY = 12;
const MAX_IMAGE_UPLOADS_PER_RUN = 48;
const IMMUTABLE_CACHE_SECONDS = 31_536_000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function blobIsConfigured() {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN ||
    (process.env.VERCEL_OIDC_TOKEN && process.env.BLOB_STORE_ID),
  );
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

function imagePath(retailerSlug: string, offer: RawOffer) {
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

async function existingBlobUrl(pathname: string) {
  try {
    return (await head(pathname)).url;
  } catch (error) {
    if (error instanceof BlobNotFoundError) return null;
    throw error;
  }
}

async function listExistingBlobUrls(retailerSlug: string) {
  const urls = new Map<string, string>();
  const prefix = `product-images/${safePathSegment(retailerSlug)}/`;
  let cursor: string | undefined;

  do {
    const page = await list({ prefix, limit: 1_000, cursor });
    for (const blob of page.blobs) urls.set(blob.pathname, blob.url);
    if (page.hasMore && !page.cursor) {
      throw new Error('Vercel Blob returned another page without a cursor.');
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return urls;
}

async function mirrorImage(
  retailerSlug: string,
  offer: RawOffer,
  existingUrl?: string,
) {
  if (!offer.imageUrl) return offer;

  const pathname = imagePath(retailerSlug, offer);
  if (existingUrl) return { ...offer, imageUrl: existingUrl };

  const response = await fetch(offer.imageUrl, {
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
    const blob = await put(pathname, imageBytes, {
      access: 'public',
      addRandomSuffix: false,
      cacheControlMaxAge: IMMUTABLE_CACHE_SECONDS,
      contentType,
    });
    return { ...offer, imageUrl: blob.url };
  } catch (error) {
    // Concurrent store collections may race on the same immutable pathname.
    const racedBlobUrl = await existingBlobUrl(pathname).catch(() => null);
    if (racedBlobUrl) return { ...offer, imageUrl: racedBlobUrl };
    throw error;
  }
}

export async function mirrorOfferImages(
  retailerSlug: string,
  offers: RawOffer[],
) {
  if (!blobIsConfigured()) return offers;

  let existingUrls: Map<string, string>;
  try {
    existingUrls = await listExistingBlobUrls(retailerSlug);
  } catch (error) {
    console.warn(
      `Could not list existing ${retailerSlug} product images; using retailer URLs for this run.`,
      error,
    );
    return offers;
  }

  const mirrored = [...offers];
  let uploadsStarted = 0;
  for (
    let index = 0;
    index < offers.length;
    index += IMAGE_UPLOAD_CONCURRENCY
  ) {
    const batch = offers.slice(index, index + IMAGE_UPLOAD_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (offer) => {
        if (!offer.imageUrl) return offer;
        const pathname = imagePath(retailerSlug, offer);
        const existingUrl = existingUrls.get(pathname);
        if (!existingUrl && uploadsStarted >= MAX_IMAGE_UPLOADS_PER_RUN) {
          return offer;
        }
        if (!existingUrl) uploadsStarted += 1;

        try {
          return await mirrorImage(retailerSlug, offer, existingUrl);
        } catch (error) {
          console.warn(
            `Could not mirror product image for ${offer.sourceProductId}; using the retailer URL.`,
            error,
          );
          return offer;
        }
      }),
    );
    mirrored.splice(index, results.length, ...results);
  }
  return mirrored;
}
