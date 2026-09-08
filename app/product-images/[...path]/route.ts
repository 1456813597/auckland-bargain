import { readFile, stat } from 'node:fs/promises';

import {
  PRODUCT_IMAGE_PATHNAME,
  PRODUCT_IMAGE_PREFIX,
  productImageFilePath,
} from '@/lib/storage/image-store';

export const runtime = 'nodejs';
// Content-addressed pathnames never change meaning, so a hit can be cached
// forever; the route itself must not be prerendered into the build output.
export const dynamic = 'force-dynamic';

const CONTENT_TYPES: Record<string, string> = {
  avif: 'image/avif',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

// Mirrored retailer images are served from the store directory. In production a
// reverse proxy (nginx, or the aaPanel site config) can serve the same volume
// directly; this keeps a single container working on its own.
export async function GET(
  _request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const pathname = `${PRODUCT_IMAGE_PREFIX}${path.join('/')}`;
  if (!PRODUCT_IMAGE_PATHNAME.test(pathname)) {
    return new Response('Not found', { status: 404 });
  }

  const file = productImageFilePath(pathname);
  try {
    const details = await stat(file);
    if (!details.isFile()) return new Response('Not found', { status: 404 });
    const bytes = await readFile(file);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type':
          CONTENT_TYPES[pathname.split('.').pop() ?? ''] ??
          'application/octet-stream',
        'Content-Length': String(details.size),
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
