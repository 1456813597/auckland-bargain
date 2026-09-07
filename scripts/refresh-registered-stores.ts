import { readFile } from 'node:fs/promises';
import path from 'node:path';
import nextEnv from '@next/env';
import {
  parseLocalDealsSnapshot,
  LOCAL_DEALS_SCHEMA_VERSION,
} from '../lib/local-deals';
import {
  parseStoreRegistry,
  planStoreCollections,
} from '../lib/collection/store-registry';
import { collectRegisteredStore } from '../lib/collection/registered-collector';
import { refreshRegisteredStores } from '../lib/collection/registered-refresh';
import {
  withLocalSnapshotLock,
  writeLocalSnapshotAtomically,
} from '../lib/collection/local-snapshot-file';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

function argumentsForRun() {
  const args = process.argv.slice(2);
  let registry = 'data/stores.json';
  let store: string | undefined;
  let execute = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--execute') execute = true;
    else if (flag === '--registry' || flag === '--store') {
      const value = args[++index];
      if (!value || value.startsWith('--'))
        throw new Error(`Missing value for ${flag}.`);
      if (flag === '--registry') registry = value;
      else store = value;
    } else
      throw new Error(
        `Unknown flag ${flag}. Use --registry <file>, --store <id>, or --execute.`,
      );
  }
  return { registry: path.resolve(registry), store, execute };
}

async function main() {
  const args = argumentsForRun();
  const registry = parseStoreRegistry(
    JSON.parse(await readFile(args.registry, 'utf8')) as unknown,
  );
  if (args.store) {
    registry.stores = registry.stores.filter(
      (store) => store.id === args.store,
    );
    if (!registry.stores.length)
      throw new Error('Unknown registered store. No source requested.');
  }
  const snapshotPath = path.resolve('data/deals.json');
  const readSnapshot = async () => {
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
  };
  if (!args.execute) {
    const snapshot = await readSnapshot();
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: 'preview',
          sourceRequests: 0,
          stores: planStoreCollections(
            registry,
            snapshot.retailers,
            new Date(),
            process.env,
          ),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  await withLocalSnapshotLock(snapshotPath, async () => {
    const result = await refreshRegisteredStores({
      registry,
      snapshot: await readSnapshot(),
      environment: process.env,
      collect: (store) =>
        collectRegisteredStore(store, { environment: process.env }),
      save: (snapshot) => writeLocalSnapshotAtomically(snapshotPath, snapshot),
      report: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
    });
    const blocked = result.plan.filter((job) => job.status === 'blocked');
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: 'execute',
          saved: result.saved,
          failed: result.failed,
          blocked: blocked.map(({ id, reasons }) => ({ id, reasons })),
          current: result.plan
            .filter((job) => job.status === 'current')
            .map(({ id }) => id),
          disabled: result.plan
            .filter((job) => job.status === 'disabled')
            .map(({ id }) => id),
        },
        null,
        2,
      )}\n`,
    );
    if (result.failed.length || blocked.length) process.exitCode = 1;
  });
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Registered store refresh failed.'}\n`,
  );
  process.exitCode = 1;
});
