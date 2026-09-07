import type {
  CollectionScope,
  CollectorStore,
  CompleteCollection,
  RetailerCollector,
} from './types';

export type CompleteRetailerCollector = RetailerCollector & {
  collectSpecials(store: CollectorStore): Promise<CompleteCollection>;
  collectCatalogue?(store: CollectorStore): Promise<CompleteCollection>;
};

export function collectionScope(
  collector: CompleteRetailerCollector,
  requested?: CollectionScope,
): CollectionScope {
  const scope =
    requested ?? (collector.collectCatalogue ? 'catalogue' : 'specials');
  if (scope === 'catalogue' && !collector.collectCatalogue) {
    throw new Error(
      `${collector.retailerSlug} does not yet support a complete catalogue; refusing to silently collect specials.`,
    );
  }
  return scope;
}

export async function collectForComparison(
  collector: CompleteRetailerCollector,
  store: CollectorStore,
  requested?: CollectionScope,
): Promise<CompleteCollection> {
  const scope = collectionScope(collector, requested);
  const result =
    scope === 'catalogue'
      ? await collector.collectCatalogue!(store)
      : await collector.collectSpecials(store);
  if (result.scope && result.scope !== scope) {
    throw new Error(
      'Collector returned a different scope from the requested snapshot.',
    );
  }
  return { ...result, scope };
}
