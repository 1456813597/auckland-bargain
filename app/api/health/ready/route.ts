import { checkDatabaseReadiness } from '@/db/readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const result = await checkDatabaseReadiness();

  if (!result.ready) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Database readiness check failed',
        checks: result.checks,
        error: result.error,
      }),
    );
  }

  return Response.json(
    {
      ready: result.ready,
      schemaVersion: result.schemaVersion,
      checks: result.checks,
    },
    {
      status: result.ready ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
