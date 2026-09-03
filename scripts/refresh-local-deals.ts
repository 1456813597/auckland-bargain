import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import nextEnv from '@next/env';

import { PaknsaveCollector } from '../lib/collectors/paknsave';
import { WoolworthsCollector } from '../lib/collectors/woolworths';
import { dealEvidencePercent, isStrongDeal } from '../lib/deal-quality';
import type { Deal } from '../lib/deals';
import {
  LOCAL_DEALS_SCHEMA_VERSION,
  offersToLocalDeals,
  parseLocalDealsSnapshot,
  type LocalDealsSnapshot,
  type LocalRetailerSnapshot,
} from '../lib/local-deals';

type RetailerSlug = 'paknsave' | 'woolworths';
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

const maximumDealsPerRetailer = positiveInteger(
  process.env.LOCAL_DEALS_PER_RETAILER,
  100,
);

function keepTopDeals(deals: Deal[]) {
  return deals
    .filter(isStrongDeal)
    .sort(
      (left, right) =>
        dealEvidencePercent(right) - dealEvidencePercent(left) ||
        right.score - left.score ||
        left.name.localeCompare(right.name),
    )
    .slice(0, maximumDealsPerRetailer);
}

function selectedRetailers(): RetailerSlug[] {
  const inline = process.argv.find((value) => value.startsWith('--retailer='));
  const flagIndex = process.argv.indexOf('--retailer');
  const requested = (
    inline?.slice('--retailer='.length) ??
    (flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined) ??
    'all'
  ).toLowerCase();

  if (requested === 'all') return ['woolworths', 'paknsave'];
  if (requested === 'woolworths' || requested === 'paknsave') {
    return [requested];
  }
  throw new Error(
    `Unknown retailer "${requested}". Use all, woolworths, or paknsave.`,
  );
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
  const collection = await collector.collectSpecials();
  const deals = keepTopDeals(
    offersToLocalDeals(
      {
        retailerSlug: 'woolworths',
        retailerName: 'Woolworths',
        store: collection.store,
        offers: collection.offers,
      },
      previousDeals,
    ),
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
    },
  } satisfies CollectedRetailer;
}

async function collectPaknsave(previousDeals: Deal[]) {
  const collector = new PaknsaveCollector({
    storeId: process.env.PAKNSAVE_STORE_ID,
    storeQuery: process.env.PAKNSAVE_STORE_QUERY ?? 'Royal Oak',
    city: process.env.PAKNSAVE_STORE_CITY,
    maxPages: positiveInteger(process.env.PAKNSAVE_MAX_PAGES, 12),
  });
  const [store] = await collector.getStores();
  if (!store) throw new Error("PAK'nSAVE did not return a matching store.");
  const collection = await collector.collectSpecials(store);
  const deals = keepTopDeals(
    offersToLocalDeals(
      {
        retailerSlug: 'paknsave',
        retailerName: "PAK'nSAVE",
        store: collection.store,
        offers: collection.offers,
      },
      previousDeals,
    ),
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
    },
  } satisfies CollectedRetailer;
}

async function main() {
  const requested = selectedRetailers();
  const existing = await readExistingSnapshot();
  const successful: CollectedRetailer[] = [];
  const failures: string[] = [];

  for (const retailer of requested) {
    process.stdout.write(`Collecting ${retailer} specials...\n`);
    try {
      const result =
        retailer === 'woolworths'
          ? await collectWoolworths(existing.deals)
          : await collectPaknsave(existing.deals);
      successful.push(result);
      process.stdout.write(
        `Collected ${result.deals.length} ${result.name} deals.\n`,
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

  const refreshed = new Set(successful.map((result) => result.slug));
  const retainedDeals = existing.deals.filter(
    (deal) =>
      !successful.some((result) => deal.id.startsWith(`${result.slug}-`)),
  );
  const retainedRetailers = existing.retailers.filter(
    (retailer) => !refreshed.has(retailer.slug as RetailerSlug),
  );
  const snapshot: LocalDealsSnapshot = {
    schemaVersion: LOCAL_DEALS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    retailers: [
      ...retainedRetailers,
      ...successful.map((result) => result.metadata),
    ].sort((left, right) => left.slug.localeCompare(right.slug)),
    deals: [
      ...retainedDeals,
      ...successful.flatMap((result) => result.deals),
    ].sort(
      (left, right) =>
        right.score - left.score || left.name.localeCompare(right.name),
    ),
  };

  await writeFile(
    snapshotPath,
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );
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

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
