/* oxlint-disable typescript/no-floating-promises -- node:test registrations. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { FreshChoiceCollector } from '../lib/collectors/myfoodlink';
import { parseCatalogueTree } from '../lib/collectors/catalogue-tree';
import { offersToLocalDeals } from '../lib/local-deals';

const store = {
  sourceStoreId: 'store-one',
  name: 'Test store',
  city: 'Auckland',
};
const navigationUrl = 'https://shop.test/sidebar/store-one/navigation.json';
const departments = [
  { id: 'all', slug: 'all', parent_id: '' },
  { id: 'grocery', slug: 'groceries', parent_id: 'all' },
  { id: 'pantry', slug: 'pantry', parent_id: 'grocery' },
  { id: 'deli', slug: 'deli', parent_id: 'all' },
];

function page(
  products: Array<{ id: string; price?: number; was?: number }>,
  totalItems = products.length,
  totalPages = 1,
  sourceStoreId = store.sourceStoreId,
) {
  return `
    <script>window.cmsDataLayer = [{"mfl_shop_update":{"shop":{"id":"${sourceStoreId}","name":"Test store"}}}];</script>
    <div id="sidebar" data-data-url="${navigationUrl}"></div>
    <strong>Refine</strong><span>${totalItems} results</span>
    <a aria-label="Page ${totalPages}">${totalPages}</a>
    ${products
      .map(
        (item) => `
      <div class="TalkerGrid__Item" role="listitem">
        <div class="talker ${item.was ? 'talker--Special' : ''}" id="line_${item.id}">
          <a href="/lines/${item.id}">View</a>
          <span class="talker__product-name">Test product ${item.id} 500g</span>
          ${item.was ? `<span class="talker__prices__was weak">was $${item.was.toFixed(2)}</span>` : ''}
          ${item.price === undefined ? '' : `<strong class="price__sell">$${item.price.toFixed(2)}</strong>`}
        </div>
      </div>
    `,
      )
      .join('')}
  `;
}

function fixture(
  overrides: Record<string, string> = {},
  navigation: unknown = { departments },
) {
  const responses: Record<string, string> = {
    '/': page([]),
    '/category/groceries': page([{ id: 'regular', price: 10 }], 2, 51),
    '/category/pantry': page([{ id: 'regular', price: 10 }], 2, 2),
    '/category/pantry?page=2': page(
      [{ id: 'discount', price: 6, was: 8 }],
      2,
      2,
    ),
    '/category/deli': page([{ id: 'unpriced' }]),
    ...overrides,
  };
  const visited: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(
      init?.redirect,
      'error',
      'do not follow unexpected catalogue redirects',
    );
    assert.equal(url.origin, 'https://shop.test');
    assert.ok(!url.pathname.startsWith('/search'));
    assert.equal(url.searchParams.has('q[]'), false);
    const path = url.pathname + url.search;
    visited.push(path);
    if (url.toString() === navigationUrl) return Response.json(navigation);
    assert.ok(path in responses, `Unexpected request ${path}`);
    return new Response(responses[path]);
  };
  const collector = new FreshChoiceCollector({
    storeOrigin: 'https://shop.test',
    fetch: transport,
    pageDelayMs: 0,
    retries: 0,
  });
  return { collector, visited, transport };
}

test('full catalogue recursively partitions categories and retains regular prices', async () => {
  const { collector, visited } = fixture();
  const result = await collector.collectCatalogue(store);
  assert.equal(result.scope, 'catalogue');
  assert.equal(result.totalItemsReported, 3);
  assert.equal(result.unpricedItems, 1);
  assert.equal(result.pagesCollected, 4);
  assert.equal(result.offers.length, 2);
  assert.deepEqual(visited, [
    '/',
    '/sidebar/store-one/navigation.json',
    '/category/groceries',
    '/category/pantry',
    '/category/pantry?page=2',
    '/category/deli',
  ]);
  const regular = result.offers.find(
    (offer) => offer.sourceProductId === 'regular',
  )!;
  assert.equal(regular.regularPriceCents, 1000);
  assert.equal(regular.promoPriceCents, null);
  assert.equal(regular.promotionType, null);
  assert.equal(regular.promotionText, null);
  const discount = result.offers.find(
    (offer) => offer.sourceProductId === 'discount',
  )!;
  assert.equal(discount.regularPriceCents, 800);
  assert.equal(discount.promoPriceCents, 600);
  assert.equal(discount.promotionType, 'SPECIAL');
  const deals = offersToLocalDeals({
    retailerSlug: 'freshchoice',
    retailerName: 'FreshChoice',
    store,
    offers: result.offers,
  });
  assert.equal(
    deals.find((deal) => deal.price === 10)?.promotion,
    'Observed price',
  );
});

test('small departments are collected once without requesting a virtual all page', async () => {
  const { collector, visited } = fixture({
    '/category/groceries': page([{ id: 'regular', price: 10 }]),
  });
  const result = await collector.collectCatalogue();
  assert.equal(result.offers.length, 1);
  assert.equal(result.unpricedItems, 1);
  assert.equal(result.store.sourceStoreId, store.sourceStoreId);
  assert.deepEqual(visited, [
    '/',
    '/sidebar/store-one/navigation.json',
    '/category/groceries',
    '/category/deli',
  ]);
});

test('refuses duplicate-page gaps, changed totals and changed stores', async () => {
  for (const [replacement, message] of [
    [page([{ id: 'regular', price: 10 }], 2, 2), /2 products but 1 unique/],
    [page([{ id: 'discount', price: 6 }], 3, 2), /changed during collection/],
    [
      page([{ id: 'discount', price: 6 }], 2, 2, 'another-store'),
      /store identity changed/,
    ],
  ] as const) {
    const { collector } = fixture({ '/category/pantry?page=2': replacement });
    await assert.rejects(collector.collectCatalogue(store), message);
  }
});

test('refuses navigation that omits parent products, even if counts happen to match', async () => {
  const { collector } = fixture({
    '/category/groceries': page([{ id: 'missing', price: 3 }], 2, 51),
  });
  await assert.rejects(
    collector.collectCatalogue(store),
    /omitted a parent product/,
  );
});

test('refuses capped leaves, untrusted navigation and missing advertised totals', async () => {
  const capped = fixture({
    '/category/deli': page([{ id: 'unpriced' }], 1, 51),
  });
  await assert.rejects(
    capped.collector.collectCatalogue(store),
    /leaf deli exceeds/,
  );
  const untrusted = fixture({
    '/': page([]).replace(
      navigationUrl,
      'https://unknown.test/sidebar/store-one/nav.json',
    ),
  });
  await assert.rejects(
    untrusted.collector.collectCatalogue(store),
    /unexpected origin or store/,
  );
  assert.deepEqual(untrusted.visited, ['/']);
  const noCount = fixture({
    '/category/groceries': page([]).replace(
      '<strong>Refine</strong><span>0 results</span>',
      '',
    ),
  });
  await assert.rejects(
    noCount.collector.collectCatalogue(store),
    /total product count/,
  );
});

test('enforces the full-run page budget without returning a partial catalogue', async () => {
  const { transport } = fixture();
  const collector = new FreshChoiceCollector({
    storeOrigin: 'https://shop.test',
    fetch: transport,
    maxCataloguePages: 2,
    retries: 0,
    pageDelayMs: 0,
  });
  await assert.rejects(
    collector.collectCatalogue(store),
    /catalogue page budget/,
  );
});

test('rejects incomplete or unsafe category trees before collection', () => {
  assert.equal(parseCatalogueTree({ departments }).children.length, 2);
  for (const rows of [
    [...departments, departments[0]],
    [...departments, { id: 'orphan', slug: 'orphan', parent_id: 'missing' }],
    [...departments, { id: 'cycle', slug: 'cycle', parent_id: 'cycle' }],
    [{ id: 'root', slug: '../account', parent_id: '' }],
  ]) {
    assert.throws(
      () => parseCatalogueTree({ departments: rows }),
      /navigation/,
    );
  }
});
