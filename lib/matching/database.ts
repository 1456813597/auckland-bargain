import { createHash } from 'node:crypto';

import type { Database } from '@/db/client';
import type { RawOffer } from '@/lib/collectors/types';
import {
  canonicalProductSlug,
  normalizedBrand,
  normalizeProductText,
  productBlockingTokens,
  productMeasureKey,
  scoreProductMatch,
  type ProductIdentity,
  type ProductMatch,
} from '@/lib/product-matching';

type CanonicalRow = {
  id: number;
  slug: string;
  display_name: string;
  normalized_name: string;
  brand: string | null;
  normalized_brand: string | null;
  category: string | null;
  size: string | null;
  gtin: string | null;
  matching_measure: string | null;
  matching_tokens: string[];
};

const CANDIDATE_COLUMNS =
  'id,slug,display_name,normalized_name,brand,normalized_brand,category,size,gtin,matching_measure,matching_tokens';
const QUERY_BATCH_SIZE = 100;

function chunks<T>(values: T[], size = QUERY_BATCH_SIZE) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function addCandidate(
  index: Map<string, CanonicalRow[]>,
  key: string | null | undefined,
  candidate: CanonicalRow,
) {
  if (!key) return;
  const values = index.get(key);
  if (values) values.push(candidate);
  else index.set(key, [candidate]);
}

function identityForOffer(
  retailerSlug: string,
  retailerProductId: number,
  offer: RawOffer,
): ProductIdentity {
  return {
    id: String(retailerProductId),
    sourceName: offer.sourceName,
    brand: offer.brand,
    category: offer.category,
    size: offer.size,
    gtin: offer.gtin,
    retailerSlug,
  };
}

function identityForCanonical(row: CanonicalRow): ProductIdentity {
  return {
    id: String(row.id),
    sourceName: row.display_name,
    brand: row.brand,
    category: row.category,
    size: row.size,
    gtin: row.gtin,
  };
}

function uniqueSlug(identity: ProductIdentity, retailerSlug: string) {
  const digest = createHash('sha256')
    .update(`${retailerSlug}:${identity.id}:${identity.sourceName}`)
    .digest('hex')
    .slice(0, 10);
  return `${canonicalProductSlug(identity).slice(0, 60)}-${digest}`;
}

function canonicalProductRow(
  retailerSlug: string,
  offer: RawOffer,
  identity: ProductIdentity,
) {
  return {
    slug: uniqueSlug(identity, retailerSlug),
    display_name: offer.sourceName,
    normalized_name: normalizeProductText(offer.sourceName),
    brand: offer.brand,
    normalized_brand: normalizedBrand(offer.brand) || null,
    category: offer.category,
    size: offer.size,
    gtin: offer.gtin,
    matching_measure: productMeasureKey(identity),
    matching_tokens: productBlockingTokens(identity),
    image_url: offer.imageUrl,
  };
}

async function loadCandidates(supabase: Database, offers: RawOffer[]) {
  const brands = [
    ...new Set(
      offers.map((offer) => normalizedBrand(offer.brand)).filter(Boolean),
    ),
  ];
  const gtins = [
    ...new Set(offers.map((offer) => offer.gtin?.trim()).filter(Boolean)),
  ] as string[];
  const measures = [
    ...new Set(
      offers
        .map((offer, index) =>
          productMeasureKey(identityForOffer('candidate', index, offer)),
        )
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const titleTokens = [
    ...new Set(
      offers.flatMap((offer, index) =>
        productBlockingTokens(identityForOffer('candidate', index, offer)),
      ),
    ),
  ];
  const byId = new Map<number, CanonicalRow>();

  for (const [column, values] of [
    ['normalized_brand', brands],
    ['gtin', gtins],
    ['matching_measure', measures],
    ['matching_tokens', titleTokens],
  ] as const) {
    for (const batch of chunks(values)) {
      let cursor = 0;
      for (;;) {
        const query = supabase
          .from('canonical_products')
          .select(CANDIDATE_COLUMNS)
          .gt('id', cursor)
          .order('id')
          .limit(500);
        const { data, error } = await (column === 'matching_tokens'
          ? query.overlaps(column, batch)
          : query.in(column, batch));
        if (error)
          throw new Error(`Read ${column} candidates: ${error.message}`);
        const rows = (data ?? []) as CanonicalRow[];
        if (!rows.length) break;
        for (const row of rows) byId.set(row.id, row);
        const next = rows.at(-1)!.id;
        if (next <= cursor)
          throw new Error('Candidate pagination did not advance');
        cursor = next;
      }
    }
  }

  return [...byId.values()];
}

async function excludeSameRetailerCandidates(
  supabase: Database,
  retailerSlug: string,
  candidates: CanonicalRow[],
) {
  if (candidates.length === 0) return candidates;
  const { data: retailer, error: retailerError } = await supabase
    .from('retailers')
    .select('id')
    .eq('slug', retailerSlug)
    .single();
  if (retailerError || !retailer?.id) {
    throw new Error(
      `Read retailer for matching: ${retailerError?.message ?? 'no id returned'}`,
    );
  }

  const sameRetailerCanonicalIds = new Set<number>();
  const candidateIds = candidates.map((candidate) => candidate.id);
  for (let index = 0; index < candidateIds.length; index += 200) {
    const batch = candidateIds.slice(index, index + 200);
    const { data, error } = await supabase
      .from('product_matches')
      .select('canonical_product_id,retailer_products!inner(retailer_id)')
      .eq('status', 'accepted')
      .eq('retailer_products.retailer_id', retailer.id)
      .in('canonical_product_id', batch);
    if (error) {
      throw new Error(
        `Read same-retailer canonical products: ${error.message}`,
      );
    }
    for (const row of data ?? []) {
      sameRetailerCanonicalIds.add(Number(row.canonical_product_id));
    }
  }

  return candidates.filter(
    (candidate) => !sameRetailerCanonicalIds.has(candidate.id),
  );
}

export async function reconcileProductMatches(input: {
  supabase: Database;
  retailerSlug: string;
  productIds: Map<string, number>;
  offers: RawOffer[];
}) {
  const retailerProductIds = [...input.productIds.values()];
  if (retailerProductIds.length === 0) return { matched: 0, reviewQueued: 0 };

  const alreadyMatched = new Set<number>();
  for (const batch of chunks(retailerProductIds)) {
    const { data: existing, error: existingError } = await input.supabase
      .from('product_matches')
      .select('retailer_product_id')
      .in('retailer_product_id', batch);
    if (existingError)
      throw new Error(
        `Read existing product matches: ${existingError.message}`,
      );
    for (const row of existing ?? [])
      alreadyMatched.add(Number(row.retailer_product_id));
  }
  const unmatchedOffers = input.offers.filter((offer) => {
    const productId = input.productIds.get(offer.sourceProductId);
    return productId !== undefined && !alreadyMatched.has(productId);
  });
  const candidates = await excludeSameRetailerCandidates(
    input.supabase,
    input.retailerSlug,
    await loadCandidates(input.supabase, unmatchedOffers),
  );
  const candidatesByBrand = new Map<string, CanonicalRow[]>();
  const candidatesByGtin = new Map<string, CanonicalRow[]>();
  const candidatesByMeasure = new Map<string, CanonicalRow[]>();
  const candidatesByToken = new Map<string, CanonicalRow[]>();
  const candidateIdentities = new Map(
    candidates.map((candidate) => [
      candidate.id,
      identityForCanonical(candidate),
    ]),
  );
  const claimedCanonicalIds = new Set<number>();
  for (const candidate of candidates) {
    addCandidate(candidatesByBrand, candidate.normalized_brand, candidate);
    addCandidate(
      candidatesByGtin,
      normalizeProductText(candidate.gtin),
      candidate,
    );
    addCandidate(
      candidatesByMeasure,
      candidate.matching_measure ??
        productMeasureKey(identityForCanonical(candidate)),
      candidate,
    );
    for (const token of candidate.matching_tokens.length > 0
      ? candidate.matching_tokens
      : productBlockingTokens(identityForCanonical(candidate))) {
      addCandidate(candidatesByToken, token, candidate);
    }
  }
  type RankedCandidate = { candidate: CanonicalRow; match: ProductMatch };
  const plans: Array<{
    retailerProductId: number;
    identity: ProductIdentity;
    offer: RawOffer;
    automatic: RankedCandidate | undefined;
    review: RankedCandidate | undefined;
  }> = [];

  for (const offer of unmatchedOffers) {
    const retailerProductId = input.productIds.get(offer.sourceProductId)!;
    const identity = identityForOffer(
      input.retailerSlug,
      retailerProductId,
      offer,
    );
    const candidateSet = new Set<CanonicalRow>();
    const brand = normalizedBrand(identity.brand);
    const gtin = normalizeProductText(identity.gtin);
    const measure = productMeasureKey(identity);
    for (const candidate of candidatesByBrand.get(brand) ?? []) {
      candidateSet.add(candidate);
    }
    for (const candidate of candidatesByGtin.get(gtin) ?? []) {
      candidateSet.add(candidate);
    }
    for (const candidate of candidatesByMeasure.get(measure ?? '') ?? []) {
      candidateSet.add(candidate);
    }
    for (const token of productBlockingTokens(identity)) {
      for (const candidate of candidatesByToken.get(token) ?? []) {
        candidateSet.add(candidate);
      }
    }
    const ranked = [...candidateSet]
      .filter((candidate) => !claimedCanonicalIds.has(candidate.id))
      .map((candidate) => ({
        candidate,
        match: scoreProductMatch(
          identity,
          candidateIdentities.get(candidate.id)!,
        ),
      }))
      .sort((left, right) => right.match.score - left.match.score);
    const automatic = ranked.find((item) => item.match.decision === 'auto');
    if (automatic) claimedCanonicalIds.add(automatic.candidate.id);
    const review = ranked.find((item) => item.match.decision === 'review');
    plans.push({ retailerProductId, identity, offer, automatic, review });
  }

  const seeds = plans
    .filter((plan) => !plan.automatic)
    .map((plan) =>
      canonicalProductRow(input.retailerSlug, plan.offer, plan.identity),
    );
  const seededIds = new Map<string, number>();
  for (const batch of chunks(seeds, 50)) {
    // The deterministic slug makes retries after a lost response safe. Do not
    // overwrite a previously created or manually curated canonical identity.
    const { error: insertError } = await input.supabase
      .from('canonical_products')
      .upsert(batch, { onConflict: 'slug', ignoreDuplicates: true });
    if (insertError)
      throw new Error(`Create canonical products: ${insertError.message}`);
    const { data, error: readError } = await input.supabase
      .from('canonical_products')
      .select('id,slug')
      .in(
        'slug',
        batch.map((row) => row.slug),
      );
    if (readError)
      throw new Error(`Read seeded canonical products: ${readError.message}`);
    for (const row of data ?? [])
      seededIds.set(String(row.slug), Number(row.id));
    for (const row of batch) {
      if (!seededIds.has(row.slug))
        throw new Error(`Canonical product was not returned: ${row.slug}`);
    }
  }

  const timestamp = new Date().toISOString();
  const matches = plans.map(({ retailerProductId, identity, automatic }) => {
    const canonicalProductId =
      automatic?.candidate.id ??
      seededIds.get(uniqueSlug(identity, input.retailerSlug))!;
    const selectedMatch = automatic?.match;
    const matchMethod = selectedMatch?.method ?? 'seed';
    const confidence = selectedMatch?.score ?? 1;
    const explanation = selectedMatch
      ? { reasons: selectedMatch.reasons, breakdown: selectedMatch.breakdown }
      : { reasons: ['Created as a new canonical product'] };

    return {
      retailer_product_id: retailerProductId,
      canonical_product_id: canonicalProductId,
      match_method: matchMethod,
      confidence,
      explanation,
      status: 'accepted',
      updated_at: timestamp,
    };
  });
  const reviews = plans.flatMap(({ retailerProductId, automatic, review }) =>
    !automatic && review
      ? [
          {
            retailer_product_id: retailerProductId,
            candidate_canonical_product_id: review.candidate.id,
            score: review.match.score,
            explanation: {
              reasons: review.match.reasons,
              breakdown: review.match.breakdown,
            },
            status: 'pending',
            updated_at: timestamp,
          },
        ]
      : [],
  );
  // Persist review evidence before accepting source matches. If this fails,
  // the next retry still sees the source as unmatched and can retry the review.
  for (const batch of chunks(reviews)) {
    const { error: reviewError } = await input.supabase
      .from('product_match_reviews')
      .upsert(batch, {
        onConflict: 'retailer_product_id,candidate_canonical_product_id',
      });
    if (reviewError) {
      throw new Error(`Queue product match review: ${reviewError.message}`);
    }
  }
  for (const batch of chunks(matches)) {
    const { error } = await input.supabase
      .from('product_matches')
      .upsert(batch, { onConflict: 'retailer_product_id' });
    if (error) throw new Error(`Persist product matches: ${error.message}`);
  }
  return { matched: matches.length, reviewQueued: reviews.length };
}
