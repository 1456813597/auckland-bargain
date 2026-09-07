# Auckland Bargain

A New Zealand grocery comparison app built with Next.js 16, Supabase and
Vercel. It follows PriceSpy's useful core flow—search, compare equivalent
offers, inspect recent movement, then visit the retailer—but applies it to
store-aware supermarket prices.

## Current product flow

1. Search by product, brand, size or category.
2. Filter by locality, supermarket or require a cross-retailer match. Search,
   filters, sort and pagination are shareable in the URL.
3. Open a canonical product to compare retailer offers from lowest to highest.
4. Check the latest observed prices against the one retained prior observation.
5. Review why products were matched and follow the source offer to the store.

The UI reads Supabase first, then the tracked `data/deals.json` snapshot, and
finally a small demo dataset. Fallback content is clearly labelled and never
presented as live data.

## Retailer coverage

The collectors support selected stores from six New Zealand grocery banners:

- Woolworths NZ, using a public but undocumented specials endpoint
- PAK'nSAVE, using the Foodstuffs guest API
- New World, using the Foodstuffs guest API
- Four Square, using its public local-specials page and nationwide store directory
- FreshChoice, using its store-specific online department catalogue
- SuperValue, using its store-specific online department catalogue

Every observation is tied to a physical store because prices can differ by
location. Defaults use Auckland stores where each source offers one, plus
SuperValue Milton for the South Island banner. Four Square exposes 213 stores
to the collector; each run still selects one locality so prices from different
cities are not mixed into a misleading comparison. Independent grocers and
stores without a remotely accessible catalogue still require a source-specific
adapter. The UI never treats missing coverage as proof that no offer exists.

See [docs/product-comparison-architecture.md](docs/product-comparison-architecture.md)
for the matching, collection and retention design.
The latest verified progress and remaining coverage/deployment work are recorded
in [docs/implementation-status.md](docs/implementation-status.md).
Review [source access and reuse restrictions](docs/source-access-review.md)
before running automated collection or publishing the data. Technical access
does not establish permission to republish product content or images.

## Product identity and matching

Retailer names are preserved as source data and linked to a separate canonical
product. Matching uses:

- exact GTIN/barcode when both sources provide it;
- otherwise a weighted score: brand 28%, product wording 42%, pack size 22%,
  category 8%;
- an automatic-match threshold of `0.86` and a review threshold of `0.72`;
- hard rejection for different GTINs, incompatible sizes, weak brands, or
  protected variants such as salted/unsalted and regular/diet/zero.

Ambiguous candidates are written to `product_match_reviews`. A source product
is never silently merged below the automatic threshold.

## Weekly collection and retention

`vercel.json` defines six protected weekly production jobs every Sunday UTC,
which is Monday morning in Auckland:

- `/api/cron/woolworths` at `16:10 UTC`
- `/api/cron/supermarkets?retailer=paknsave` at `17:20 UTC`
- `/api/cron/supermarkets?retailer=newworld` at `18:30 UTC`
- `/api/cron/supermarkets?retailer=foursquare` at `19:40 UTC`
- `/api/cron/supermarkets?retailer=freshchoice` at `20:50 UTC`
- `/api/cron/supermarkets?retailer=supervalue` at `22:00 UTC`

Each banner gets its own function invocation and time budget. Jobs are spaced
70 minutes apart to accommodate Hobby's hour-level scheduling precision;
current [Vercel limits](https://vercel.com/docs/cron-jobs/usage-and-pricing)
allow 100 cron jobs per project. The unfiltered supermarkets endpoint remains
available for an authenticated manual batch. Later banners can match canonical
products created by earlier jobs. Each adapter retries
transient requests and validates its reported page/item totals. The MyFoodLink
adapter automatically partitions by department when its upstream search limit
would otherwise hide results after page 50. Database leases prevent overlapping
retailer/store runs and only a complete run deactivates missing offers.

FreshChoice and SuperValue comparison jobs now select the normal department
catalogue, including regular prices. The collector reads the storefront's
published department tree and recurses into child categories when a parent
exceeds the page limit. Every visited category must match its advertised unique
product count; store changes, missing pages, invalid navigation and exhausted
page budgets fail the run. Unpriced items are counted separately, never assigned
a made-up price. The virtual "All Departments" node is not requested as a URL.
No catalogue failure silently falls back to a specials-only snapshot.

Offers are first written to `collection_offer_staging`. Finalization verifies
the expected count and publishes all store prices, removes missing offers and
updates history in a single database transaction. Failed and expired runs clear
their staging rows without publishing partial prices.

`current_offers` stores the live state. `offer_history` retains at most two
distinct New Zealand calendar weeks per product and store: the current capture
and one prior capture. Same-week retries replace that week's observation;
unchanged prices still create a new observation the following week. The local
JSON refresh uses the same week boundaries, including daylight saving. Legacy
JSON labels without an absolute date are not used to invent a prior week.

Displayed price movements compare the same offers with both observations.
Newly covered, cheaper stores do not count as price reductions. Prior captures
can be older than last week after a missed run; the interface shows collection
dates and does not label them as last week's prices.

## Local setup

Requires Node.js 22.13 or newer. Supabase is optional for fallback UI work.

```bash
npm install
supabase link --project-ref your-project-ref
supabase db push
```

Copy `.env.example` to `.env.local`. For database-backed collection set:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` (server-only; the legacy service-role name also works)
- `CRON_SECRET` (at least 16 random characters)
- `BLOB_READ_WRITE_TOKEN` for durable product images

Then run:

```bash
npm run dev
```

Never prefix a Supabase secret with `NEXT_PUBLIC_` or commit `.env.local`.

### Local snapshot refresh

For permission-aware, multi-store collection, start with the read-only plan:

```bash
npm run stores:plan
# Only after source-access review and registry configuration:
npm run stores:refresh -- --store freshchoice-epsom
```

`data/stores.json` explicitly lists source IDs, locality, scope and access status.
All bundled entries are pending, so the registered runner makes no source
requests for them. Approved due stores are processed independently; same-week
successes are skipped on retry. Checkpoints preserve other stores and use an
exclusive lock and atomic file replacement. See [registered store collection](docs/store-registry.md)
for configuration, failure handling and the remaining production queue work.

The legacy environment-selected commands below remain available. Their source
selection and the existing cron routes do not yet read the registry's permission
gate; do not run them or activate deployment until source access is reviewed.

```bash
npm run deals:refresh
npm run deals:refresh -- --retailer woolworths
npm run deals:refresh -- --retailer paknsave
npm run deals:refresh -- --retailer newworld
npm run deals:refresh -- --retailer foursquare
npm run deals:refresh -- --retailer freshchoice
npm run deals:refresh -- --retailer supervalue
# Explicit catalogue scope fails before collection for unsupported banners:
npm run deals:refresh -- --retailer freshchoice --scope catalogue
# Source diagnostics only:
npm run deals:refresh -- --retailer freshchoice --scope specials
```

The script writes every collected, priced offer to `data/deals.json`, including
modest discounts and offers without a claimed discount. The old 100-item
strong-deal limit no longer applies to comparison data. The default `auto` scope
chooses full published departments for FreshChoice/SuperValue, and the currently
supported specials sources for the other four banners. Snapshot metadata records
the scope and number of items without usable prices. This is not yet nationwide
or all-banner regular-price coverage. Each product retains its current and one
prior weekly observation. The bundled snapshot has not yet been refreshed with
the new full-catalogue adapters.

## Read-only APIs

- `GET /api/comparisons?q=&category=&retailer=&city=&matched=&sort=&page=&limit=` returns canonical
  products and sorted offers with `total`, `page`, `pageSize` and `totalPages`
  metadata. The page size is capped at 250; every result remains addressable.
- `GET /api/products/:id` returns one comparison, accepting a canonical or
  retailer-offer ID.
- `GET /api/deals` remains as a compatibility endpoint for offer-level data.
- `GET /api/health/ready` verifies that the required view and RPC exist.

Responses identify `database`, `local-json` or `demo` as their source. The
comparison endpoints also report `weekly` cadence and one retained historical
snapshot.

The compatibility field `weeklyChange` describes the difference between the
latest and prior retained observations for the same offers. It is not a guarantee
that those observations are exactly seven days apart.

## Deployment

`npm run build:vercel` runs tests, type checking, lint, migration guards and the
Next.js production build. In the Vercel Production environment it applies
tracked Supabase migrations before building. Preview builds never migrate the
production database.

Vercel sends `CRON_SECRET` as the bearer token for scheduled calls. Manual
checks use the same authorization:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://your-project.vercel.app/api/cron/woolworths

curl -H "Authorization: Bearer $CRON_SECRET" \
  https://your-project.vercel.app/api/cron/supermarkets
```

Create a public Vercel Blob store if retailer images should be copied to stable
URLs. If Blob is unavailable, price ingestion continues with the upstream image
URL.

## Checks

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run stores:plan
npx tsx scripts/audit-comparisons.ts 0
# With a local production server running on port 3100:
npx tsx scripts/verify-comparison-app.ts
```

The test suite executes all SQL migrations against an isolated in-memory
Postgres engine (PGlite). It verifies atomic publication, incomplete-batch
rejection, idempotent finalization, weekly retention, failed-worker fencing and
store isolation without needing production credentials.
