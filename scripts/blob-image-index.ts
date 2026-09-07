import nextEnv from '@next/env';
import { list } from '@vercel/blob';
import { seedProductImageIndex } from '../lib/storage/product-images';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

// Run once after deploying the mirror index, so blobs uploaded by the old
// list-per-run collector are adopted instead of being uploaded a second time.
async function main() {
  const args = process.argv.slice(2);
  let execute = false;
  for (const flag of args) {
    if (flag === '--execute') execute = true;
    else throw new Error(`Unknown flag ${flag}. Use --execute.`);
  }

  const result = await seedProductImageIndex({ execute, list });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
