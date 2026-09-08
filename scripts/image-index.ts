import nextEnv from '@next/env';
import { adoptStoredImages } from '../lib/storage/product-images';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

// Run after restoring or moving the image volume, so files already on disk are
// registered in the index instead of being downloaded from retailers again.
async function main() {
  const args = process.argv.slice(2);
  let execute = false;
  for (const flag of args) {
    if (flag === '--execute') execute = true;
    else throw new Error(`Unknown flag ${flag}. Use --execute.`);
  }

  const result = await adoptStoredImages({ execute });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
