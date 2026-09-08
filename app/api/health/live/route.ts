export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Liveness only: the process is up and serving. Container health checks use
// this, because `/api/health/ready` answers 503 whenever the database is not
// migrated yet — a real answer, but not a reason to restart the container.
export function GET() {
  return Response.json(
    { alive: true },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
