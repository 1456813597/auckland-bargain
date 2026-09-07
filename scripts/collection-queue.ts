import { readFile } from 'node:fs/promises';
import path from 'node:path';
import nextEnv from '@next/env';
import {
  parseStoreRegistry,
  retailerDefinitions,
  type RegisteredRetailer,
} from '../lib/collection/store-registry';
import {
  syncCollectionTargets,
  enqueueWeeklyCollections,
  getCollectionQueueStatus,
  processOneCollectionJob,
} from '../lib/collection/queue';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || !['sync', 'status', 'enqueue', 'work'].includes(command))
    throw new Error('Use sync, status, enqueue or work.');
  let registryPath = 'data/stores.json';
  let execute = false;
  let retailer: RegisteredRetailer | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--execute' && command === 'sync') execute = true;
    else if (args[index] === '--registry' && command === 'sync') {
      const value = args[++index];
      if (!value || value.startsWith('--'))
        throw new Error('Missing registry path.');
      registryPath = value;
    } else if (
      args[index] === '--retailer' &&
      ['enqueue', 'work'].includes(command)
    ) {
      const value = args[++index];
      if (!value || !Object.hasOwn(retailerDefinitions, value))
        throw new Error('Unknown retailer.');
      retailer = value as RegisteredRetailer;
    } else throw new Error('Unknown or unsupported command option.');
  }
  let result: unknown;
  switch (command) {
    case 'sync': {
      const registry = parseStoreRegistry(
        JSON.parse(
          await readFile(path.resolve(registryPath), 'utf8'),
        ) as unknown,
      );
      result = execute
        ? await syncCollectionTargets(registry)
        : {
            mode: 'preview',
            writes: 0,
            targets: registry.stores.map(
              ({ id, retailer, enabled, scope, access }) => ({
                id,
                retailer,
                enabled,
                scope,
                accessStatus: access.status,
              }),
            ),
          };
      break;
    }
    case 'status':
      result = await getCollectionQueueStatus();
      break;
    case 'enqueue':
      result = await enqueueWeeklyCollections(undefined, retailer);
      break;
    case 'work': {
      const outcome = await processOneCollectionJob({ retailer });
      result = outcome;
      if (outcome.status !== 'idle' && outcome.status !== 'succeeded')
        process.exitCode = 1;
      break;
    }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Collection queue command failed.'}\n`,
  );
  process.exitCode = 1;
});
