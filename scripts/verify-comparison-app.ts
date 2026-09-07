import assert from 'node:assert/strict';
import type { ProductComparison } from '../lib/comparisons';

const origin = new URL(process.argv[2] ?? 'http://localhost:3100');
if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
  throw new Error('This verification script is scoped to a local test server.');
}
async function request(path: string) {
  return fetch(new URL(path, origin), { signal: AbortSignal.timeout(30_000) });
}
async function comparisons(query: string) {
  const response = await request(`/api/comparisons?${query}`);
  assert.equal(response.status, 200);
  return (await response.json()) as {
    data: ProductComparison[];
    meta: { total: number; page: number; pageSize: number; source: string };
  };
}

const home = await request('/');
assert.equal(home.status, 200);
const html = await home.text();
assert.ok(html.includes('Products and prices'));
assert.ok(
  Buffer.byteLength(html) < 1_000_000,
  'home must not serialize the entire catalogue',
);
const first = await comparisons('limit=24');
const second = await comparisons('limit=24&page=2');
assert.ok(first.data.length <= 24);
assert.equal(second.meta.page, 2);
assert.equal(
  new Set([...first.data, ...second.data].map((product) => product.id)).size,
  first.data.length + second.data.length,
);
const local = await comparisons(
  'q=hellers+pork&city=Auckland&matched=true&limit=24',
);
assert.ok(local.data.length > 0);
for (const product of local.data) {
  assert.ok(product.retailerCount > 1);
  assert.ok(product.offers.every((offer) => offer.storeCity === 'Auckland'));
  assert.equal(
    product.lowestPrice,
    Math.min(...product.offers.map((offer) => offer.offerPrice)),
  );
}
const empty = await comparisons('q=unfindable-verification-product');
assert.equal(empty.data.length, 0);
const product = local.data[0];
for (const id of [product.id, product.offers[0].id]) {
  const response = await request(`/api/products/${encodeURIComponent(id)}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: ProductComparison };
  assert.equal(body.data.id, product.id);
}
const detail = await request(
  `/product/${product.id}?city=Auckland&search=q%3Dhellers%2Bpork`,
);
assert.equal(detail.status, 200);
const detailHtml = await detail.text();
assert.ok(detailHtml.includes('Weekly price history'));
assert.ok(detailHtml.includes('Lowest observed price'));
assert.ok(!detailHtml.includes('Lowest this week'));
assert.ok(
  detailHtml.includes('href="/?q=hellers+pork&amp;city=Auckland#compare"'),
  'Back to search must preserve the query and selected locality',
);
const missing = await request('/product/unfindable-verification-product');
// Next.js may have streamed the loading shell with HTTP 200 before notFound()
// runs. Verify the not-found UI and noindex contract, not only the status code.
assert.ok([200, 404].includes(missing.status));
const missingHtml = await missing.text();
assert.ok(missingHtml.includes('Product not found'));
assert.ok(missingHtml.includes('<meta name="robots" content="noindex"'));
assert.equal(
  (await request('/api/products/unfindable-verification-product')).status,
  404,
);
// These calls cannot publish anything: every collection endpoint must reject
// missing authentication before it resolves stores or begins a collection.
for (const path of [
  '/api/cron/woolworths',
  '/api/cron/paknsave',
  '/api/cron/supermarkets?retailer=freshchoice',
]) {
  assert.equal((await request(path)).status, 401);
}
const readiness = await request('/api/health/ready');
assert.ok([200, 503].includes(readiness.status));
console.log(
  JSON.stringify(
    {
      ok: true,
      source: first.meta.source,
      catalogueProducts: first.meta.total,
      homepageBytes: Buffer.byteLength(html),
      localMatchedSearchResults: local.meta.total,
      verified: [
        'pagination',
        'search',
        'locality-scoped prices',
        'matched-only filter',
        'empty state',
        'product details',
        'canonical and offer ID lookup',
        'search return link',
        'not-found UI and noindex',
        'API 404',
        'cron authorization',
      ],
      databaseReady: readiness.status === 200,
    },
    null,
    2,
  ),
);
