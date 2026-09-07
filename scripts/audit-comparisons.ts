import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { buildProductComparisons } from '../lib/comparisons';
import type { Deal } from '../lib/deals';
import { parseProductMeasure } from '../lib/product-matching';

const snapshot = JSON.parse(await readFile('data/deals.json', 'utf8')) as {
  deals: Deal[];
};
const started = performance.now();
const comparisons = buildProductComparisons(snapshot.deals);
const matched = comparisons.filter((product) => product.retailerCount > 1);
console.log(
  JSON.stringify(
    {
      offers: snapshot.deals.length,
      products: comparisons.length,
      matchedProducts: matched.length,
      elapsedMs: Math.round(performance.now() - started),
      serializedBytes: Buffer.byteLength(JSON.stringify(comparisons)),
      retailers: Object.fromEntries(
        [...new Set(snapshot.deals.map((deal) => deal.retailer))].map(
          (retailer) => {
            const offers = snapshot.deals.filter(
              (deal) => deal.retailer === retailer,
            );
            return [
              retailer,
              {
                offers: offers.length,
                missingBrand: offers.filter((offer) => !offer.brand).length,
                unresolvedMeasure: offers.filter(
                  (offer) => !parseProductMeasure(offer.size, offer.name),
                ).length,
              },
            ];
          },
        ),
      ),
    },
    null,
    2,
  ),
);

const sampleSize = Number(process.argv[2] ?? 20);
console.log(
  JSON.stringify(
    matched.slice(0, sampleSize).map((product) => ({
      score: product.matchConfidence,
      offers: product.offers.map((offer) => ({
        retailer: offer.retailer,
        name: offer.name,
        brand: offer.brand,
        size: offer.size,
        price: offer.offerPrice,
      })),
    })),
    null,
    2,
  ),
);
