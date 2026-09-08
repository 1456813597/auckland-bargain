import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Product images live on a disk this deployment owns: a Docker volume on the
// server, or any directory a reverse proxy can also serve directly. The
// pathname is the shared identity between the file, the index row and the URL.
export const PRODUCT_IMAGE_PREFIX = 'product-images/';
export const PRODUCT_IMAGE_PATHNAME =
  /^product-images\/[a-z0-9-]+\/[a-z0-9-]+\.(avif|gif|jpg|png|webp)$/;

export type StoredImage = { url: string; byteSize: number };

export interface ImageStore {
  head(pathname: string): Promise<StoredImage | null>;
  put(
    pathname: string,
    body: ArrayBuffer,
    options: { contentType: string },
  ): Promise<StoredImage>;
}

export function productImageDirectory(
  environment: Record<string, string | undefined> = process.env,
) {
  // The directory is deployment configuration, not a build input; without the
  // ignore comment the bundler treats it as a possible dependency root and
  // copies the whole repository into the standalone server output.
  return path.resolve(
    /*turbopackIgnore: true*/ environment.PRODUCT_IMAGE_DIR ??
      '.data/product-images',
  );
}

// Relative by default, so the same rows work behind localhost, an IP and a
// domain. Set a base URL only when the files are served from another origin.
export function productImageUrl(
  pathname: string,
  environment: Record<string, string | undefined> = process.env,
) {
  const base = environment.PRODUCT_IMAGE_BASE_URL?.trim().replace(/\/+$/, '');
  return base ? `${base}/${pathname}` : `/${pathname}`;
}

export function assertProductImagePathname(pathname: string) {
  if (!PRODUCT_IMAGE_PATHNAME.test(pathname)) {
    throw new Error(`Refusing an unsupported image pathname: ${pathname}`);
  }
  return pathname;
}

// The pathname is validated against a pattern with no dots or slashes in its
// segments, so a resolved file can never leave the directory.
export function productImageFilePath(
  pathname: string,
  environment: Record<string, string | undefined> = process.env,
) {
  assertProductImagePathname(pathname);
  return path.join(
    productImageDirectory(environment),
    pathname.slice(PRODUCT_IMAGE_PREFIX.length),
  );
}

export function createFilesystemImageStore(
  environment: Record<string, string | undefined> = process.env,
): ImageStore {
  return {
    async head(pathname) {
      try {
        const file = await stat(productImageFilePath(pathname, environment));
        return file.isFile()
          ? {
              url: productImageUrl(pathname, environment),
              byteSize: file.size,
            }
          : null;
      } catch {
        return null;
      }
    },
    async put(pathname, body) {
      const file = productImageFilePath(pathname, environment);
      await mkdir(path.dirname(file), { recursive: true });
      // Written beside the target and renamed, so a reader (or a crash) never
      // sees a half-written image at the immutable URL.
      const temporary = `${file}.${randomUUID()}.tmp`;
      const bytes = new Uint8Array(body);
      try {
        await writeFile(temporary, bytes);
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return {
        url: productImageUrl(pathname, environment),
        byteSize: bytes.byteLength,
      };
    },
  };
}

export type StoredImageEntry = {
  pathname: string;
  retailerSlug: string;
  url: string;
  byteSize: number;
};

// Walks the store one retailer directory at a time. Used to re-register files
// that are on disk but missing from the index, such as after a server move.
export async function* listStoredImages(
  environment: Record<string, string | undefined> = process.env,
): AsyncGenerator<StoredImageEntry> {
  const root = productImageDirectory(environment);
  let retailers: string[];
  try {
    retailers = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return;
  }
  for (const retailerSlug of retailers.sort()) {
    const entries = await readdir(path.join(root, retailerSlug), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (!entry.isFile()) continue;
      const pathname = `${PRODUCT_IMAGE_PREFIX}${retailerSlug}/${entry.name}`;
      if (!PRODUCT_IMAGE_PATHNAME.test(pathname)) continue;
      const file = await stat(path.join(root, retailerSlug, entry.name));
      yield {
        pathname,
        retailerSlug,
        url: productImageUrl(pathname, environment),
        byteSize: file.size,
      };
    }
  }
}
