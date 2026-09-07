import { SiteHeader } from '@/components/site-header';
import { Skeleton } from '@/components/ui/skeleton';

export default function ProductLoading() {
  return (
    <>
      <SiteHeader />
      <main
        id="main-content"
        className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8"
      >
        <Skeleton className="h-11 w-32 rounded-lg" />
        <div className="mt-5 grid gap-8 lg:grid-cols-[360px_minmax(0,1fr)]">
          <Skeleton className="aspect-square rounded-xl" />
          <div className="space-y-4 py-8">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-14 w-full max-w-2xl" />
            <Skeleton className="h-28 w-full rounded-xl" />
          </div>
        </div>
      </main>
    </>
  );
}
