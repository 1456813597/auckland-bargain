import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import nextEnv from '@next/env';

import { FourSquareCollector } from '../lib/collectors/foursquare';
import {
  FreshChoiceCollector,
  SuperValueCollector,
} from '../lib/collectors/myfoodlink';
import { NewWorldCollector } from '../lib/collectors/newworld';
import { PaknsaveCollector } from '../lib/collectors/paknsave';
import { WoolworthsCollector } from '../lib/collectors/woolworths';
import { collectForComparison } from '../lib/collectors/comparison-collection';
import type { CollectionScope } from '../lib/collectors/types';
import type { Deal } from '../lib/deals';
import {
  withLocalSnapshotLock,
  writeLocalSnapshotAtomically,
} from '../lib/collection/local-snapshot-file';
import {
  LOCAL_DEALS_SCHEMA_VERSION,
  offersToLocalDeals,
  parseLocalDealsSnapshot,
  mergeLocalStoreSnapshots,
  type LocalDealsSnapshot,
  type LocalRetailerSnapshot,
} from '../lib/local-deals';

type RetailerSlug =
  | 'foursquare'
  | 'freshchoice'
  | 'newworld'
  | 'paknsave'
  | 'supervalue'
  | 'woolworths';
type CollectedRetailer = {
  slug: RetailerSlug;
  name: string;
  deals: Deal[];
  metadata: LocalRetailerSnapshot;
};

const projectDirectory = process.cwd();
const snapshotPath = path.join(projectDirectory, 'data', 'deals.json');

const { loadEnvConfig } = nextEnv;
loadEnvConfig(projectDirectory);

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function selectedRetailers(): RetailerSlug[] {
  const inline = process.argv.find((value) => value.startsWith('--retailer='));
  const flagIndex = process.argv.indexOf('--retailer');
  const requested = (
    inline?.slice('--retailer='.length) ??
    (flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined) ??
    'all'
  ).toLowerCase();

  if (requested === 'all') {
    return [
      'woolworths',
      'paknsave',
      'newworld',
      'foursquare',
      'freshchoice',
      'supervalue',
    ];
  }
  if (
    requested === 'woolworths' ||
    requested === 'paknsave' ||
    requested === 'newworld' ||
    requested === 'foursquare' ||
    requested === 'freshchoice' ||
    requested === 'supervalue'
  ) {
    return [requested];
  }
  throw new Error(
    `Unknown retailer "${requested}". Use all, woolworths, paknsave, newworld, foursquare, freshchoice, or supervalue.`,
  );
}

function requestedScope(): CollectionScope | undefined {
  const inline = process.argv.find((value) => value.startsWith('--scope='));
  const index = process.argv.indexOf('--scope');
  const value =
    inline?.slice('--scope='.length) ??
    (index >= 0 ? process.argv[index + 1] : 'auto');
  if (value === 'auto') return undefined;
  if (value === 'catalogue' || value === 'specials') return value;
  throw new Error('Unknown collection scope. Use auto, catalogue or specials.');
}

async function readExistingSnapshot(): Promise<LocalDealsSnapshot> {
  try {
    return parseLocalDealsSnapshot(
      JSON.parse(await readFile(snapshotPath, 'utf8')) as unknown,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      schemaVersion: LOCAL_DEALS_SCHEMA_VERSION,
      generatedAt: null,
      retailers: [],
      deals: [],
    };
  }
}

async function collectWoolworths(previousDeals: Deal[]) {
  const collector = new WoolworthsCollector({
    cookie: process.env.WOOLWORTHS_COOKIE,
    city: process.env.WOOLWORTHS_STORE_CITY ?? 'Auckland',
    maxPages: positiveInteger(process.env.WOOLWORTHS_MAX_PAGES, 60),
    pageSize: positiveInteger(process.env.WOOLWORTHS_PAGE_SIZE, 100),
  });
  const [store] = await collector.getStores();
  if (!store) throw new Error('Woolworths did not identify its store.');
  const collection = await collectForComparison(
    collector,
    store,
    requestedScope(),
  );
  const deals = offersToLocalDeals(
    {
      retailerSlug: 'woolworths',
      retailerName: 'Woolworths',
      store: collection.store,
      offers: collection.offers,
    },
    previousDeals,
  );

  return {
    slug: 'woolworths',
    name: 'Woolworths',
    deals,
    metadata: {
      slug: 'woolworths',
      name: 'Woolworths',
      store: collection.store,
      dealCount: deals.length,
      collectedAt: collection.offers[0]!.collectedAt.toISOString(),
      scope: collection.scope,
      totalItemsReported: collection.totalItemsReported,
      unpricedItems: collection.unpricedItems ?? 0,
    },
  } satisfies CollectedRetailer;
}

async function collectPaknsave(previousDeals: Deal[]) {
  const collector = new PaknsaveCollector({
    storeId: process.env.PAKNSAVE_STORE_ID,
    storeQuery: process.env.PAKNSAVE_STORE_QUERY ?? 'Royal Oak',
    city: process.env.PAKNSAVE_STORE_CITY,
    maxPages: positiveInteger(process.env.PAKNSAVE_MAX_PAGES, 20),
  });
  const [store] = await collector.getStores();
  if (!store) throw new Error("PAK'nSAVE did not return a matching store.");
  const collection = await collectForComparison(
    collector,
    store,
    requestedScope(),
  );
  const deals = offersToLocalDeals(
    {
      retailerSlug: 'paknsave',
      retailerName: "PAK'nSAVE",
      store: collection.store,
      offers: collection.offers,
    },
    previousDeals,
  );

  return {
    slug: 'paknsave',
    name: "PAK'nSAVE",
    deals,
    metadata: {
      slug: 'paknsave',
      name: "PAK'nSAVE",
      store: collection.store,
      dealCount: deals.length,
      collectedAt: collection.offers[0]!.collectedAt.toISOString(),
      scope: collection.scope,
      totalItemsReported: collection.totalItemsReported,
      unpricedItems: collection.unpricedItems ?? 0,
    },
  } satisfies CollectedRetailer;
}

async function collectNewWorld(previousDeals: Deal[]) {
  const collector = new NewWorldCollector({
    storeId: process.env.NEWWORLD_STORE_ID,
    storeQuery: process.env.NEWWORLD_STORE_QUERY ?? 'Metro Queen St',
    city: process.env.NEWWORLD_STORE_CITY,
    maxPages: positiveInteger(process.env.NEWWORLD_MAX_PAGES, 20),
  });
  const [store] = await collector.getStores();
  if (!store) throw new Error('New World did not return a matching store.');
  const collection = await collectForComparison(
    collector,
    store,
    requestedScope(),
  );
  const deals = offersToLocalDeals(
    {
      retailerSlug: 'newworld',
      retailerName: 'New World',
      store: collection.store,
      offers: collection.offers,
    },
    previousDeals,
  );

  return {
    slug: 'newworld',
    name: 'New World',
    deals,
    metadata: {
      slug: 'newworld',
      name: 'New World',
      store: collection.store,
      dealCount: deals.length,
      collectedAt: collection.offers[0]!.collectedAt.toISOString(),
      scope: collection.scope,
      totalItemsReported: collection.totalItemsReported,
      unpricedItems: collection.unpricedItems ?? 0,
    },
  } satisfies CollectedRetailer;
}

async function collectFourSquare(previousDeals: Deal[]) {
  const collector = new FourSquareCollector({
    storeId: process.env.FOURSQUARE_STORE_ID,
    storeQuery: process.env.FOURSQUARE_STORE_QUERY ?? 'Lancaster',
    city: process.env.FOURSQUARE_STORE_CITY,
    maxPages: positiveInteger(process.env.FOURSQUARE_MAX_PAGES, 10),
  });
  const [store] = await collector.getStores();
  if (!store) throw new Error('Four Square did not return a matching store.');
  const collection = await collectForComparison(
    collector,
    store,
    requestedScope(),
  );
  const deals = offersToLocalDeals(
    {
      retailerSlug: 'foursquare',
      retailerName: 'Four Square',
      store: collection.store,
      offers: collection.offers,
    },
    previousDeals,
  );

  return {
    slug: 'foursquare',
    name: 'Four Square',
    deals,
    metadata: {
      slug: 'foursquare',
      name: 'Four Square',
      store: collection.store,
      dealCount: deals.length,
      collectedAt:
        collection.offers[0]?.collectedAt.toISOString() ??
        new Date().toISOString(),
      scope: collection.scope,
      totalItemsReported: collection.totalItemsReported,
      unpricedItems: collection.unpricedItems ?? 0,
    },
  } satisfies CollectedRetailer;
}

async function collectFreshChoice(previousDeals: Deal[]) {
  const collector = new FreshChoiceCollector({
    storeOrigin: process.env.FRESHCHOICE_STORE_ORIGIN,
    city: process.env.FRESHCHOICE_STORE_CITY,
    address: process.env.FRESHCHOICE_STORE_ADDRESS,
    maxPages: positiveInteger(process.env.FRESHCHOICE_MAX_PAGES, 80),
  });
  const [store] = await collector.getStores();
  if (!store) throw new Error('FreshChoice did not return a matching store.');
  const collection = await collectForComparison(
    collector,
    store,
    requestedScope(),
  );
  const deals = offersToLocalDeals(
    {
      retailerSlug: 'freshchoice',
      retailerName: 'FreshChoice',
      store: collection.store,
      offers: collection.offers,
    },
    previousDeals,
  );

  return {
    slug: 'freshchoice',
    name: 'FreshChoice',
    deals,
    metadata: {
      slug: 'freshchoice',
      name: 'FreshChoice',
      store: collection.store,
      dealCount: deals.length,
      collectedAt:
        collection.offers[0]?.collectedAt.toISOString() ??
        new Date().toISOString(),
      scope: collection.scope,
      totalItemsReported: collection.totalItemsReported,
      unpricedItems: collection.unpricedItems ?? 0,
    },
  } satisfies CollectedRetailer;
}

async function collectSuperValue(previousDeals: Deal[]) {
  const collector = new SuperValueCollector({
    storeOrigin: process.env.SUPERVALUE_STORE_ORIGIN,
    city: process.env.SUPERVALUE_STORE_CITY,
    address: process.env.SUPERVALUE_STORE_ADDRESS,
    maxPages: positiveInteger(process.env.SUPERVALUE_MAX_PAGES, 60),
  });
  const [store] = await collector.getStores();
  if (!store) throw new Error('SuperValue did not return a matching store.');
  const collection = await collectForComparison(
    collector,
    store,
    requestedScope(),
  );
  const deals = offersToLocalDeals(
    {
      retailerSlug: 'supervalue',
      retailerName: 'SuperValue',
      store: collection.store,
      offers: collection.offers,
    },
    previousDeals,
  );

  return {
    slug: 'supervalue',
    name: 'SuperValue',
    deals,
    metadata: {
      slug: 'supervalue',
      name: 'SuperValue',
      store: collection.store,
      dealCount: deals.length,
      collectedAt:
        collection.offers[0]?.collectedAt.toISOString() ??
        new Date().toISOString(),
      scope: collection.scope,
      totalItemsReported: collection.totalItemsReported,
      unpricedItems: collection.unpricedItems ?? 0,
    },
  } satisfies CollectedRetailer;
}

async function collectRetailer(retailer: RetailerSlug, previousDeals: Deal[]) {
  switch (retailer) {
    case 'woolworths':
      return collectWoolworths(previousDeals);
    case 'paknsave':
      return collectPaknsave(previousDeals);
    case 'newworld':
      return collectNewWorld(previousDeals);
    case 'foursquare':
      return collectFourSquare(previousDeals);
    case 'freshchoice':
      return collectFreshChoice(previousDeals);
    case 'supervalue':
      return collectSuperValue(previousDeals);
  }
}

async function main() {
  const requested = selectedRetailers();
  if (requestedScope() === 'catalogue') {
    const unsupported = requested.filter(
      (retailer) => !['freshchoice', 'supervalue'].includes(retailer),
    );
    if (unsupported.length)
      throw new Error(
        `Complete catalogue is not yet supported for: ${unsupported.join(', ')}. No stores were requested.`,
      );
  }
  const existing = await readExistingSnapshot();
  const successful: CollectedRetailer[] = [];
  const failures: string[] = [];

  for (const retailer of requested) {
    process.stdout.write(`Collecting ${retailer} prices...\n`);
    try {
      const result = await collectRetailer(retailer, existing.deals);
      successful.push(result);
      process.stdout.write(
        `Collected ${result.deals.length} ${result.name} prices (${result.metadata.scope}).\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${retailer}: ${message}`);
      process.stderr.write(`Could not collect ${retailer}: ${message}\n`);
    }
  }

  if (successful.length === 0) {
    throw new Error(
      'No retailer collection completed; the existing JSON was not changed.',
    );
  }

  const snapshot = mergeLocalStoreSnapshots(
    existing,
    successful,
    new Date().toISOString(),
  );

  await writeLocalSnapshotAtomically(snapshotPath, snapshot);
  process.stdout.write(
    `Saved ${snapshot.deals.length} deals to ${path.relative(projectDirectory, snapshotPath)}.\n`,
  );

  if (failures.length > 0) {
    process.stderr.write(
      `Completed with stale data retained for: ${failures.join('; ')}\n`,
    );
    process.exitCode = 1;
  }
}

withLocalSnapshotLock(snapshotPath, main).catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
