import {
  collectionScope,
  collectForComparison,
  type CompleteRetailerCollector,
} from '../collectors/comparison-collection';
import { FourSquareCollector } from '../collectors/foursquare';
import {
  FreshChoiceCollector,
  SuperValueCollector,
} from '../collectors/myfoodlink';
import { NewWorldCollector } from '../collectors/newworld';
import { PaknsaveCollector } from '../collectors/paknsave';
import { WoolworthsCollector } from '../collectors/woolworths';
import type { CompleteCollection } from '../collectors/types';
import {
  parseStoreRegistry,
  registryStoreKey,
  storeAccessProblems,
  type RegisteredStore,
} from './store-registry';

type CollectorOptions = {
  environment: Record<string, string | undefined>;
  fetch?: typeof fetch;
};

export function createRegisteredCollector(
  store: RegisteredStore,
  options: CollectorOptions,
): CompleteRetailerCollector {
  const common = { city: store.city, fetch: options.fetch };
  switch (store.retailer) {
    case 'woolworths':
      return new WoolworthsCollector({
        ...common,
        cookie: options.environment[store.cookieEnv!],
        maxPages: 60,
      });
    case 'paknsave':
      return new PaknsaveCollector({
        ...common,
        storeId: store.sourceStoreId,
        maxPages: 20,
      });
    case 'newworld':
      return new NewWorldCollector({
        ...common,
        storeId: store.sourceStoreId,
        maxPages: 20,
      });
    case 'foursquare':
      return new FourSquareCollector({
        ...common,
        storeId: store.sourceStoreId,
        maxPages: 10,
      });
    case 'freshchoice':
      return new FreshChoiceCollector({
        ...common,
        storeOrigin: store.storeOrigin,
        address: store.address ?? undefined,
        maxPages: 80,
      });
    case 'supervalue':
      return new SuperValueCollector({
        ...common,
        storeOrigin: store.storeOrigin,
        address: store.address ?? undefined,
        maxPages: 60,
      });
  }
}

export function assertRegisteredCollection(
  store: RegisteredStore,
  collection: CompleteCollection,
) {
  if (
    registryStoreKey({
      retailer: store.retailer,
      sourceStoreId: collection.store.sourceStoreId,
    }) !== registryStoreKey(store)
  )
    throw new Error(
      `Store identity changed while collecting ${store.id}; snapshot not published.`,
    );
  if (collection.scope !== store.scope)
    throw new Error(
      `Collection scope changed for ${store.id}; snapshot not published.`,
    );
  if (!collection.offers.length)
    throw new Error(
      `Store ${store.id} returned no usable prices; snapshot not published.`,
    );
  if (
    collection.offers.some(
      (offer) => !Number.isFinite(offer.collectedAt.getTime()),
    )
  )
    throw new Error(
      `Invalid observation date for ${store.id}; snapshot not published.`,
    );
}

export async function collectRegisteredStore(
  target: RegisteredStore,
  options: CollectorOptions & {
    now?: Date;
    createCollector?: typeof createRegisteredCollector;
  },
) {
  // Revalidate at the execution boundary, including after a stored job is loaded.
  const [store] = parseStoreRegistry({
    schemaVersion: 1,
    stores: [target],
  }).stores;
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime()))
    throw new Error('Collection requires a valid date.');
  const reasons = storeAccessProblems(store, now, options.environment);
  if (!store.enabled || reasons.length) {
    throw new Error(
      `Store ${store.id} cannot run: ${!store.enabled ? 'disabled' : reasons.join(', ')}. No source requested.`,
    );
  }
  // A new instance per store isolates cookies, source sessions and region caches.
  const collector = (options.createCollector ?? createRegisteredCollector)(
    store,
    options,
  );
  if (collector.retailerSlug !== store.retailer)
    throw new Error('Collector retailer does not match the registered target.');
  collectionScope(collector, store.scope);
  const resolved = await collector.getStores();
  const isExpected = (sourceStoreId: string) =>
    registryStoreKey({ retailer: store.retailer, sourceStoreId }) ===
    registryStoreKey(store);
  if (resolved.length !== 1 || !isExpected(resolved[0].sourceStoreId))
    throw new Error(
      `Store identity mismatch for ${store.id}; refusing to request its catalogue.`,
    );
  const collection = await collectForComparison(
    collector,
    resolved[0],
    store.scope,
  );
  assertRegisteredCollection(store, collection);
  // Equivalent case-insensitive Four Square IDs share one persisted identity.
  return {
    ...collection,
    store: { ...collection.store, sourceStoreId: store.sourceStoreId },
  };
}
