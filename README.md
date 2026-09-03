# Auckland Bargain

A Vercel-hosted Next.js grocery price tracker for Auckland. Live collectors
read anonymous PAK'nSAVE and Woolworths NZ specials for selected stores and
store current offers, change-only price history, and collection health in
Supabase.

## What is live

- Woolworths NZ public specials API
- Anonymous default fulfilment store: Woolworths Glenfield (source id 9171)
- PAK'nSAVE anonymous guest API, defaulting to the real Royal Oak store
- Royal Oak source id: `e1925ea7-01bc-4358-ae7c-c6502da5ab12`
- Integer NZ-cent price storage, with public promo and member prices separated
- Supabase-backed current offers and 90-day history
- Public Vercel Blob copies of collected product images
- Daily Vercel Cron endpoints at `/api/cron/woolworths` and
  `/api/cron/paknsave`
- Dashboard and read-only APIs that use Supabase when configured
- JSON snapshot fallback for local UI work without database credentials

The Woolworths endpoint is public but undocumented. Collection is deliberately
low-frequency, paginated, timeout-bounded, and retried only for transient
failures. A database lease prevents overlapping runs. Only a complete run can
deactivate offers that disappeared from the latest specials snapshot.

## Local setup

Requirement: Node.js 22.13 or newer. Supabase is optional for local UI work.

1. Install dependencies:

   ```bash
   npm install
   ```

2. To run against a database, link the Supabase CLI and apply all tracked
   migrations:

   ```bash
   supabase link --project-ref your-project-ref
   supabase db push
   ```

   Do not apply production schema changes through an application HTTP route or
   directly in the Supabase SQL editor. Keeping every change in
   `supabase/migrations` preserves migration history and lets CI verify the
   database before deployment.

3. Copy `.env.example` to `.env.local`. For database-backed development, set:

   - `SUPABASE_URL`
   - `SUPABASE_SECRET_KEY` (server-only; legacy
     `SUPABASE_SERVICE_ROLE_KEY` also works)
   - `CRON_SECRET` (a random value of at least 16 characters)
   - `BLOB_READ_WRITE_TOKEN` from a public Vercel Blob store

4. Run:

   ```bash
   npm run dev
   ```

Never prefix the Supabase secret with `NEXT_PUBLIC_` and never commit
`.env.local`.

### Local JSON fallback

To collect current specials without Supabase, run:

```bash
npm run deals:refresh
```

This calls the existing Woolworths and PAK'nSAVE collectors directly and
writes the normalized result to `data/deals.json`. By default it retains the
top 100 deals per retailer; set `LOCAL_DEALS_PER_RETAILER` to change that limit.
You can refresh only one retailer while retaining the other retailer's last
snapshot:

```bash
npm run deals:refresh -- --retailer woolworths
npm run deals:refresh -- --retailer paknsave
```

The `/api/deals` and `/api/products/:id` endpoints try Supabase first. When
Supabase is not configured or cannot be read, they use `data/deals.json`; if
that file has no collected deals, they use the small built-in demo dataset.
The dev server watches the JSON file, so refresh the dashboard after the script
finishes. The JSON snapshot is intentionally tracked and may be committed when
you want a shared fallback dataset.

## Vercel deployment

Create a Vercel project from this repository and add the required variables to
the Production environment. Preview deployments should use a separate Supabase
project or no database credentials. Vercel's Git integration automatically
builds commits pushed to `main`; GitHub Actions is not part of the deployment
pipeline and the GitHub repository requires no deployment secrets.

`vercel.json` runs `npm run build:vercel` as the Build Command. Every Vercel
build runs the tests, type checking, lint, the HTTP migration-route guard and
the Next.js production build. When `VERCEL_ENV=production`, the same command
also applies pending Supabase migrations and verifies database readiness before
building. Preview builds never link to or migrate the production database.

The connected Supabase integration injects `POSTGRES_URL_NON_POOLING`, which the
Production build uses for migrations without a Supabase access token or GitHub
secret. If the integration is not connected, add `POSTGRES_URL_NON_POOLING` as
a Sensitive Environment Variable scoped only to Vercel Production. Configure
the remaining application variables documented in `.env.example` in Vercel as
well.

Before the first workflow run, compare local and remote migration history:

```bash
supabase migration list
```

If `20260830110000` appears only locally but its tables, view and functions
already exist because the removed HTTP migration route executed the SQL, record
that one existing migration without rerunning it:

```bash
supabase migration repair --status applied 20260830110000
supabase migration list
```

Only use `migration repair` after confirming the schema objects already exist.
Subsequent migrations are applied automatically by the Vercel Production build.

On every push to `main`, Vercel runs the complete production pipeline and only
publishes a successful build. Keep production migrations backward compatible
with the currently running application because the migration is applied during
the build, before the replacement deployment becomes live.

Create a public Blob store and connect it to the Vercel project. Vercel injects
`BLOB_READ_WRITE_TOKEN` for the connected environments. During collection,
retailer product images are copied to immutable paths under `product-images/`
before the Blob URL is saved to Supabase. Existing products move to Blob the
next time their retailer collector runs. If Blob is not configured or one image
cannot be copied, that offer keeps its retailer image URL so price collection
can still complete.

`vercel.json` runs Woolworths at `17:10 UTC` and PAK'nSAVE at `17:25 UTC`
each day. That is early morning in Auckland; Vercel cron schedules are always
UTC. Cron invocations run only on the production deployment.

Vercel sends `CRON_SECRET` as an authorization bearer token for scheduled
invocations. Both cron routes fail closed with HTTP 401 when the variable is
missing or the token does not match.

For a manual production check:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://your-project.vercel.app/api/cron/woolworths

curl -H "Authorization: Bearer $CRON_SECRET" \
  https://your-project.vercel.app/api/cron/paknsave
```

The read-only readiness endpoint verifies that the expected database RPC and
view exist and that `current_deals` is readable:

```bash
curl https://your-project.vercel.app/api/health/ready
```

It returns HTTP 200 only when the application and database schema are ready;
otherwise it returns HTTP 503. The Vercel Production build runs the same check
directly against the production Supabase environment before `next build`.

Never add a route such as `/api/internal/apply-migration`. If an old immutable
Preview Deployment contains one, remove that deployment from Vercel rather than
reusing or exposing the route.

## Selecting the PAK'nSAVE store

The first configured store is PAK'nSAVE Royal Oak. Set `PAKNSAVE_STORE_ID` to
an exact store UUID when changing stores. `PAKNSAVE_STORE_QUERY` is a readable
fallback used to resolve a store from the live PAK'nSAVE store list. The
collector records the upstream physical address and refuses to finalize a
snapshot when pagination exceeds `PAKNSAVE_MAX_PAGES`.

## Selecting another Woolworths store

Without credentials or cookies, Woolworths currently returns Glenfield as the
anonymous fulfilment context. To intentionally collect a different selected
store, set `WOOLWORTHS_COOKIE` to a server-only cookie header from a browser
session after choosing that store. Never commit or log it.

The collector verifies the fulfilment store on every page and aborts if the
context changes mid-run.

## Checks

```bash
npm test
npm run typecheck
npm run build
```

The dashboard reads `/api/deals`. Product details are available at
`/api/products/:id`. Both endpoints report `meta.source` as `database`,
`local-json`, or `demo`.
