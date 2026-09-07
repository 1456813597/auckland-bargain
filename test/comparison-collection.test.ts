/* oxlint-disable typescript/no-floating-promises -- node:test registrations. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectForComparison,
  collectionScope,
  type CompleteRetailerCollector,
} from '../lib/collectors/comparison-collection';
import type { CompleteCollection } from '../lib/collectors/types';

const store = { sourceStoreId: 'test', name: 'Test store', city: 'Auckland' };
const result: CompleteCollection = {
  store,
  offers: [],
  pagesCollected: 1,
  totalItemsReported: 0,
};
function fixture() {
  const calls: string[] = [];
  const collector: CompleteRetailerCollector = {
    retailerSlug: 'test',
    getStores: async () => [store],
    getSpecials: async () => [],
    collectSpecials: async () => {
      calls.push('specials');
      return result;
    },
    collectCatalogue: async () => {
      calls.push('catalogue');
      return { ...result, scope: 'catalogue', unpricedItems: 0 };
    },
  };
  return { collector, calls };
}

test('weekly comparison collection prefers a supported full catalogue', async () => {
  const { collector, calls } = fixture();
  const actual = await collectForComparison(collector, store);
  assert.equal(actual.scope, 'catalogue');
  assert.deepEqual(calls, ['catalogue']);
});

test('specials-only adapters identify their limited scope and reject explicit full requests', async () => {
  const { collector, calls } = fixture();
  delete collector.collectCatalogue;
  assert.equal(collectionScope(collector), 'specials');
  await assert.rejects(
    collectForComparison(collector, store, 'catalogue'),
    /refusing to silently collect specials/,
  );
  assert.deepEqual(calls, []);
  assert.equal(
    (await collectForComparison(collector, store)).scope,
    'specials',
  );
});

test('a failed or scope-mismatched catalogue never falls back to specials', async () => {
  const { collector, calls } = fixture();
  collector.collectCatalogue = async () => {
    throw new Error('Missing catalogue page');
  };
  await assert.rejects(
    collectForComparison(collector, store),
    /Missing catalogue page/,
  );
  collector.collectCatalogue = async () => ({ ...result, scope: 'specials' });
  await assert.rejects(
    collectForComparison(collector, store),
    /different scope/,
  );
  assert.deepEqual(calls, []);
});

test('explicit specials scope remains available for bounded source diagnostics', async () => {
  const { collector, calls } = fixture();
  assert.equal(
    (await collectForComparison(collector, store, 'specials')).scope,
    'specials',
  );
  assert.deepEqual(calls, ['specials']);
});
