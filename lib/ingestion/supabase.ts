import { createHash } from 'node:crypto';

import { getSupabaseAdmin } from '@/db/supabase';
import type { CollectorStore, RawOffer } from '@/lib/collectors/types';
import { mirrorOfferImages } from '@/lib/storage/product-images';

const WRITE_BATCH_SIZE = 250;

function chunks<T>(values: T[], size = WRITE_BATCH_SIZE) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function offerHash(offer: RawOffer) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        regularPriceCents: offer.regularPriceCents,
        promoPriceCents: offer.promoPriceCents,
        memberPriceCents: offer.memberPriceCents,
        promotionType: offer.promotionType,
        promotionText: offer.promotionText,
        validUntil: offer.validUntil?.toISOString() ?? null,
      }),
    )
    .digest('hex');
}

function fail(operation: string, error: { message: string } | null) {
  if (error) throw new Error(`${operation}: ${error.message}`);
}

export async function createCollectionRun(
  retailerSlug: string,
  storeSourceId: string,
  metadata: Record<string, unknown> = {},
) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc('claim_collection_run', {
    p_retailer_slug: retailerSlug,
    p_store_source_id: storeSourceId,
    p_metadata: metadata,
  });

  fail('Create collection run', error);
  if (data === null) throw new CollectionAlreadyRunningError();
  return Number(data);
}

export class CollectionAlreadyRunningError extends Error {
  constructor() {
    super('A collection for this store is already running.');
    this.name = 'CollectionAlreadyRunningError';
  }
}

export async function markCollectionRunFailed(runId: number, error: unknown) {
  const message =
    error instanceof Error ? error.message : 'Unknown collection failure';
  const { error: updateError } = await getSupabaseAdmin()
    .from('collection_runs')
    .update({
      status: 'failed',
      finished_at: new Date().toISOString(),
      error_message: message.slice(0, 2_000),
    })
    .eq('id', runId);

  fail('Mark collection run failed', updateError);
}

export type RetailerIdentity = {
  slug: string;
  name: string;
  website: string;
};

async function upsertRetailer(retailer: RetailerIdentity) {
  const { data, error } = await getSupabaseAdmin()
    .from('retailers')
    .upsert(
      {
        slug: retailer.slug,
        name: retailer.name,
        website: retailer.website,
      },
      { onConflict: 'slug' },
    )
    .select('id')
    .single();

  fail('Upsert retailer', error);
  if (!data?.id) throw new Error('Upsert retailer returned no id.');
  return Number(data.id);
}

async function upsertStore(retailerId: number, store: CollectorStore) {
  const { data, error } = await getSupabaseAdmin()
    .from('stores')
    .upsert(
      {
        retailer_id: retailerId,
        source_store_id: store.sourceStoreId,
        name: store.name,
        city: store.city,
        address: store.address ?? null,
        active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'retailer_id,source_store_id' },
    )
    .select('id')
    .single();

  fail('Upsert store', error);
  if (!data?.id) throw new Error('Upsert store returned no id.');
  return Number(data.id);
}

async function upsertProducts(
  retailerId: number,
  retailerSlug: string,
  offers: RawOffer[],
) {
  const ids = new Map<string, number>();
  const supabase = getSupabaseAdmin();
  const offersWithStoredImages = await mirrorOfferImages(retailerSlug, offers);

  for (const batch of chunks(offersWithStoredImages)) {
    const { data, error } = await supabase
      .from('retailer_products')
      .upsert(
        batch.map((offer) => ({
          retailer_id: retailerId,
          source_product_id: offer.sourceProductId,
          source_name: offer.sourceName,
          brand: offer.brand,
          category: offer.category,
          size: offer.size,
          gtin: offer.gtin,
          image_url: offer.imageUrl,
          source_url: offer.sourceUrl,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: 'retailer_id,source_product_id' },
      )
      .select('id,source_product_id');

    fail('Upsert retailer products', error);
    for (const product of data ?? []) {
      ids.set(String(product.source_product_id), Number(product.id));
    }
  }

  if (ids.size !== offers.length) {
    throw new Error(
      `Expected ${offers.length} retailer products but received ${ids.size} ids.`,
    );
  }
  return ids;
}

export async function ingestOffers(input: {
  runId: number;
  retailer: RetailerIdentity;
  store: CollectorStore;
  offers: RawOffer[];
}) {
  if (input.offers.length === 0) {
    throw new Error('Refusing to finalize an empty collection.');
  }

  const retailerId = await upsertRetailer(input.retailer);
  const storeId = await upsertStore(retailerId, input.store);
  const productIds = await upsertProducts(
    retailerId,
    input.retailer.slug,
    input.offers,
  );
  const supabase = getSupabaseAdmin();

  for (const batch of chunks(input.offers)) {
    const { error } = await supabase.from('current_offers').upsert(
      batch.map((offer) => ({
        retailer_product_id: productIds.get(offer.sourceProductId)!,
        store_id: storeId,
        regular_price_cents: offer.regularPriceCents,
        promo_price_cents: offer.promoPriceCents,
        member_price_cents: offer.memberPriceCents,
        promotion_type: offer.promotionType,
        promotion_text: offer.promotionText,
        valid_until: offer.validUntil?.toISOString() ?? null,
        collected_at: offer.collectedAt.toISOString(),
        content_hash: offerHash(offer),
        active: true,
        last_seen_run_id: input.runId,
      })),
      { onConflict: 'retailer_product_id,store_id' },
    );

    fail('Upsert current offers', error);
  }

  const { error } = await supabase.rpc('finalize_collection_run', {
    p_run_id: input.runId,
    p_offers_seen: input.offers.length,
  });
  fail('Finalize collection run', error);

  return {
    runId: input.runId,
    retailerId,
    storeId,
    offersSeen: input.offers.length,
  };
}
