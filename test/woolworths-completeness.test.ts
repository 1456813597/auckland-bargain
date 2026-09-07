/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WoolworthsCollector } from '../lib/collectors/woolworths';

function collector(pageData: (page: number) => unknown) {
  return new WoolworthsCollector({
    pageSize: 1,
    pageDelayMs: 0,
    fetch: async (input) => {
      const url =
        input instanceof Request ? new URL(input.url) : new URL(input);
      return Response.json({
        products: pageData(Number(url.searchParams.get('page'))),
        context: {
          fulfilment: { fulfilmentStoreId: 9171, address: 'Glenfield' },
        },
      });
    },
  });
}
const product = (sku: string) => ({
  sku,
  name: 'Milk 2L',
  price: { originalPrice: 5 },
});

test('Woolworths duplicate pages cannot publish an incomplete weekly snapshot', async () => {
  await assert.rejects(
    collector(() => ({
      totalItems: 2,
      items: [product('one')],
    })).collectSpecials(),
    /2 products but returned 1 unique/,
  );
});

test('Woolworths changing, missing and malformed totals fail closed', async () => {
  await assert.rejects(
    collector((page) => ({
      totalItems: page === 1 ? 2 : 3,
      items: [product(String(page))],
    })).collectSpecials(),
    /total changed/,
  );
  for (const totalItems of [undefined, -1, 1.5, '1'])
    await assert.rejects(
      collector(() => ({
        totalItems,
        items: [product('one')],
      })).collectSpecials(),
      /invalid product totals/,
    );
  await assert.rejects(
    collector(() => ({
      totalItems: 1,
      items: [{ name: 'Missing SKU' }],
    })).collectSpecials(),
    /without an SKU/,
  );
});

test('Woolworths counts identified unpriced products without inventing a price', async () => {
  const result = await collector((page) => ({
    totalItems: 2,
    items: [
      page === 1
        ? product('priced')
        : { sku: 'unpriced', name: 'Unavailable item' },
    ],
  })).collectSpecials();
  assert.equal(result.totalItemsReported, 2);
  assert.equal(result.offers.length, 1);
  assert.equal(result.unpricedItems, 1);
});
