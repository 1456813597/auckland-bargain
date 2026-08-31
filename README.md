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
- Daily Vercel Cron endpoints at `/api/cron/woolworths` and
  `/api/cron/paknsave`
- Dashboard and read-only APIs that use Supabase when configured
- Demo fallback for local UI work without database credentials

The Woolworths endpoint is public but undocumented. Collection is deliberately
low-frequency, paginated, timeout-bounded, and retried only for transient
failures. A database lease prevents overlapping runs. Only a complete run can
deactivate offers that disappeared from the latest specials snapshot.

## Local setup

Requirements: Node.js 22.13 or newer and a Supabase project.

1. Install dependencies:

   ```bash
   npm install
   ```

2. Apply
   `supabase/migrations/20260830110000_initial_price_history.sql` through the
   Supabase SQL editor or Supabase CLI.

3. Copy `.env.example` to `.env.local` and set:

   - `SUPABASE_URL`
   - `SUPABASE_SECRET_KEY` (server-only; legacy
     `SUPABASE_SERVICE_ROLE_KEY` also works)
   - `CRON_SECRET` (at least 16 random characters)

4. Run:

   ```bash
   npm run dev
   ```

Never prefix the Supabase secret with `NEXT_PUBLIC_` and never commit
`.env.local`.

## Vercel deployment

Create a Vercel project from this repository and add the required variables to
the Production environment. Preview deployments should use a separate Supabase
project or no database credentials.

`vercel.json` runs Woolworths at `17:10 UTC` and PAK'nSAVE at `17:25 UTC`
each day. That is early morning in Auckland; Vercel cron schedules are always
UTC. Cron invocations run only on the production deployment.

Vercel automatically sends `Authorization: Bearer <CRON_SECRET>`. The route
rejects requests without that exact header.

For a manual production check:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://your-project.vercel.app/api/cron/woolworths

curl -H "Authorization: Bearer $CRON_SECRET" \
  https://your-project.vercel.app/api/cron/paknsave
```

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
npx tsc --noEmit
npm run build
```

The dashboard reads `/api/deals`. Product details are available at
`/api/products/:id`. When Supabase is not configured, both endpoints clearly
report `meta.demo: true`.
