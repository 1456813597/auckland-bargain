import { isDatabaseConfigured } from '@/db/client';
import { isAuthorizedCronRequest } from '@/lib/http/cron-auth';
import { adoptStoredImages } from '@/lib/storage/product-images';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Registers image files that are on the volume but missing from the index —
// after restoring a backup, or moving the store to another server. It writes
// only what it can see on disk, so running it twice changes nothing.
// `?execute=true` performs the write; without it the response is a preview.
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  if (!isDatabaseConfigured()) {
    return Response.json(
      { error: 'No database is configured on the server.' },
      { status: 503 },
    );
  }

  const execute = new URL(request.url).searchParams.get('execute') === 'true';
  try {
    return Response.json(await adoptStoredImages({ execute }));
  } catch (error) {
    console.error('Product image adoption failed', error);
    return Response.json(
      { ok: false, error: 'Product image adoption failed.' },
      { status: 500 },
    );
  }
}
