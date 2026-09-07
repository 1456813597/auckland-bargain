import {
  offersToLocalDeals,
  mergeLocalStoreSnapshots,
  type LocalDealsSnapshot,
} from '../local-deals';
import type { CompleteCollection } from '../collectors/types';
import { assertRegisteredCollection } from './registered-collector';
import { storeAccessProblems } from './store-registry';
import {
  planStoreCollections,
  retailerDefinitions,
  type RegisteredStore,
  type StoreRegistry,
} from './store-registry';

export async function refreshRegisteredStores(options: {
  registry: StoreRegistry;
  snapshot: LocalDealsSnapshot;
  environment: Record<string, string | undefined>;
  collect: (store: RegisteredStore) => Promise<CompleteCollection>;
  save: (snapshot: LocalDealsSnapshot) => Promise<void>;
  now?: () => Date;
  report?: (event: {
    id: string;
    status: 'saved' | 'failed';
    error?: string;
    offers?: number;
  }) => void;
}) {
  const now = options.now ?? (() => new Date());
  let snapshot = options.snapshot;
  const plan = planStoreCollections(
    options.registry,
    snapshot.retailers,
    now(),
    options.environment,
  );
  const saved: string[] = [];
  const failed: string[] = [];
  for (const job of plan.filter((job) => job.status === 'due')) {
    const store = options.registry.stores.find((store) => store.id === job.id)!;
    let collection: CompleteCollection;
    let next: LocalDealsSnapshot;
    try {
      // Permissions can expire while an earlier store is being collected.
      const reasons = storeAccessProblems(store, now(), options.environment);
      if (!store.enabled || reasons.length)
        throw new Error(`Store no longer runnable: ${reasons.join(', ')}.`);
      collection = await options.collect(store);
      assertRegisteredCollection(store, collection);
      if (
        job.lastCollectedAt &&
        collection.offers.some(
          (offer) =>
            offer.collectedAt.getTime() < Date.parse(job.lastCollectedAt!),
        )
      )
        throw new Error(
          'Collection is older than the published store snapshot.',
        );
      const deals = offersToLocalDeals(
        {
          retailerSlug: store.retailer,
          retailerName: retailerDefinitions[store.retailer].name,
          store: collection.store,
          offers: collection.offers,
        },
        snapshot.deals,
      );
      if (!deals.length)
        throw new Error('No usable prices; refusing an empty snapshot.');
      next = mergeLocalStoreSnapshots(
        snapshot,
        [
          {
            deals,
            metadata: {
              slug: store.retailer,
              name: retailerDefinitions[store.retailer].name,
              store: collection.store,
              dealCount: deals.length,
              collectedAt: collection.offers[0].collectedAt.toISOString(),
              scope: collection.scope,
              totalItemsReported: collection.totalItemsReported,
              unpricedItems: collection.unpricedItems ?? 0,
            },
          },
        ],
        now().toISOString(),
      );
    } catch (error) {
      failed.push(store.id);
      options.report?.({
        id: store.id,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Collection failed',
      });
      continue;
    }
    // A local disk/lock failure is fatal: do not keep collecting without a safe
    // checkpoint. Source failures above are isolated to the affected store.
    await options.save(next);
    snapshot = next;
    saved.push(store.id);
    options.report?.({
      id: store.id,
      status: 'saved',
      offers: collection.offers.length,
    });
  }
  return { snapshot, plan, saved, failed };
}
