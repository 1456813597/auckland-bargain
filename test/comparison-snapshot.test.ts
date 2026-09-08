/* oxlint-disable typescript/no-floating-promises -- node:test registrations. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getComparisonsWithFallback,
  resetComparisonSnapshot,
} from '../lib/repositories/comparison-source';

test('reuses one grouped catalogue across renders', async () => {
  resetComparisonSnapshot();
  const first = await getComparisonsWithFallback();
  const second = await getComparisonsWithFallback();

  assert.ok(first.comparisons.length > 0);
  // Every page render reads the whole catalogue, so a repeat read must not pay
  // for the source query and the product grouping again.
  assert.equal(second.comparisons, first.comparisons);
  assert.equal(second.source, first.source);
  assert.equal(second.updatedAt, first.updatedAt);
});

test('collapses concurrent cold reads into a single catalogue', async () => {
  resetComparisonSnapshot();
  const [left, right] = await Promise.all([
    getComparisonsWithFallback(),
    getComparisonsWithFallback(),
  ]);

  assert.equal(left.comparisons, right.comparisons);
});

test('rebuilds after the snapshot is dropped', async () => {
  resetComparisonSnapshot();
  const before = await getComparisonsWithFallback();
  resetComparisonSnapshot();
  const after = await getComparisonsWithFallback();

  assert.notEqual(after.comparisons, before.comparisons);
  assert.equal(after.comparisons.length, before.comparisons.length);
});
