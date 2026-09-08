# Auckland Bargain

A New Zealand grocery comparison app built with Next.js 16 and Postgres, and
deployed as two containers on a server you control. It follows PriceSpy's
useful core flow (search, compare equivalent offers, inspect recent movement,
then visit the retailer) but applies it to store-aware supermarket prices.

The database can be a Supabase project or a Postgres you installed yourself;
product images are stored on a mounted volume; collection is scheduled by a
sidecar container. [中文部署教程（宝塔面板）](docs/deploy-baota.md) covers a
full server setup step by step.

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

`/api/cron/collect` runs hourly and is the registry-driven path. Each invocation
enqueues this NZ week's jobs for every `collection_targets` row whose recorded
source permission is approved, unexpired and enabled, then claims at most three
of them (`?limit=` up to 10, `?retailer=` to narrow a banner). It stops claiming
after 120 seconds so the job already in flight keeps the rest of the function's
300-second budget; whatever is left stays queued for the next hour. Enqueueing is
idempotent per store, scope and NZ week, so the repeated invocations exist to
land backed-off retries inside the same week, not to collect more often. With the
default limit that is up to 504 store-jobs a week. An invocation with nothing
eligible costs three database calls and contacts no supermarket — which is the
current state, because every bundled registry entry is `access.status: pending`.

`deploy/cron-jobs.json` also keeps six protected weekly jobs, every Monday in
New Zealand time. These are the legacy environment-selected single-store
routes; they do **not** read the registry or its access gate:

- `/api/cron/woolworths` at `04:10`
- `/api/cron/supermarkets?retailer=paknsave` at `05:20`
- `/api/cron/supermarkets?retailer=newworld` at `06:30`
- `/api/cron/supermarkets?retailer=foursquare` at `07:40`
- `/api/cron/supermarkets?retailer=freshchoice` at `08:50`
- `/api/cron/supermarkets?retailer=supervalue` at `10:00`

The scheduler container renders that table into a crontab at startup, reading
the times in `CRON_TZ` (`Pacific/Auckland` by default), so daylight saving does
not move them. Every job can be re-timed with its own environment variable, or
switched off entirely with `off`. Jobs are spaced 70 minutes apart so two
collections never overlap. Retire a legacy route once its store is an
approved registry target, so the same store is not collected twice a week; until
then a same-week overlap replaces that store's current observation rather than
corrupting it. The unfiltered supermarkets endpoint remains
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

## Databases

The application talks to one narrow interface (`db/client.ts`) with two drivers
behind it:

- **Supabase**, through `@supabase/supabase-js`, when `SUPABASE_URL` and
  `SUPABASE_SECRET_KEY` are set.
- **Any Postgres**, through a direct connection, when `DATABASE_URL` is set —
  including one installed by the aaPanel/Baota PostgreSQL manager. The
  PostgREST call shapes the application uses are answered with SQL by
  `db/postgres/rest.ts`, which `test/postgres-client.test.ts` exercises against
  the real migrated schema.

`DATABASE_URL` wins when both are configured; `DATABASE_DRIVER` forces one.
Migrations are the same files either way:

```bash
npm run db:migrate          # apply pending migrations
npm run db:migrate:check    # list them without applying
```

The runner records applied files in `supabase_migrations.schema_migrations`,
the table the Supabase CLI uses, so `supabase db push` and this runner never
apply the same file twice. On a self-hosted server it also creates the `anon`,
`authenticated` and `service_role` roles the migrations grant to.

## Local setup

Requires Node.js 22.13 or newer. A database is optional for fallback UI work.

```bash
npm install
cp .env.example .env.local
npm run dev
```

For database-backed collection set `DATABASE_URL` (or the Supabase pair) and
`CRON_SECRET` (at least 16 random characters). Never prefix a database secret
with `NEXT_PUBLIC_`, and never commit `.env.local`.

### Product images

Mirrored retailer images are written to `PRODUCT_IMAGE_DIR` (a mounted volume
in production) and served from `/product-images/...`, either by the app or
directly by a reverse proxy pointed at the same directory. Whether an image is
already stored is answered by the `product_image_mirrors` table rather than by
touching the disk, so the same product collected at a second store of the same
banner costs nothing, and an image that cannot be fetched is retried no sooner
than 30 days later.

`PRODUCT_IMAGE_MIRROR_MAX_BYTES` caps the store (8 GiB by default). Reaching it
keeps retailer URLs instead of filling the volume. `PRODUCT_IMAGE_MIRROR=off`
stops mirroring new images while still serving the ones already stored.

After restoring a volume backup or moving the store to another server, register
the files that are on disk but missing from the index:

```bash
npm run images:index          # preview: no writes
npm run images:index:adopt    # write the adopted rows
```

On a server, the same operation is available to an authenticated caller at
`GET /api/cron/images` (`?execute=true` to write).

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
- `GET /api/health/live` answers 200 while the process is serving. Container
  health checks use it, because readiness is a real 503 when the database is
  not migrated yet.

Responses identify `database`, `local-json` or `demo` as their source. The
comparison endpoints also report `weekly` cadence and one retained historical
snapshot.

The compatibility field `weeklyChange` describes the difference between the
latest and prior retained observations for the same offers. It is not a guarantee
that those observations are exactly seven days apart.

## Deployment

Two containers and one volume, described by `docker-compose.yml`:

- `app` — the Next.js server, the `/api/cron/*` collection routes and the
  `/product-images/*` files.
- `scheduler` — Alpine plus busybox `crond`, calling those routes on the
  schedule in `deploy/cron-jobs.json`.
- `product-images` — the volume the mirrored images live on.

On the server:

```bash
cp .env.example .env                                   # then fill it in
docker compose pull
docker compose --profile migrate run --rm migrate      # apply migrations
docker compose up -d
```

[docs/deploy-baota.md](docs/deploy-baota.md) is the full walkthrough in
Chinese, including the aaPanel/Baota reverse proxy, HTTPS, PostgreSQL manager
setup, backups and troubleshooting.

### Images and CI

`.github/workflows/ci.yml` runs the tests, type check, lint and build on every
pull request. `.github/workflows/docker-publish.yml` builds both Dockerfiles on
a pull request, and on a merge to `main` pushes them to the repository owner's
GitHub Container Registry:

- `ghcr.io/<owner>/auckland-bargain`
- `ghcr.io/<owner>/auckland-bargain-scheduler`

Tags are `latest` on the default branch, `sha-<commit>` for every build, and
semver tags for `v*` releases. Roll back by pointing `APP_IMAGE` at an older
`sha-` tag. A fork publishes into its own namespace, so a pull request merged
upstream is what updates the images the upstream deployment pulls.

### Scheduling and authorization

The scheduler sends `CRON_SECRET` as a bearer token; every `/api/cron` route
rejects anything else. The same call by hand:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  http://127.0.0.1:3000/api/cron/woolworths

curl -H "Authorization: Bearer $CRON_SECRET" \
  "http://127.0.0.1:3000/api/cron/collect?limit=1"
```

`COLLECTION_JOB_LIMIT`, `COLLECTION_JOB_MAX_LIMIT` and
`COLLECTION_CLAIM_DEADLINE_MS` bound one queue drain. These used to be dictated
by a serverless function's 300-second ceiling; on a server you own, raise them
to whatever the machine can actually sustain.

The queue itself is inspected and seeded with database credentials, never from
the browser or a cron route:

```bash
npm run queue:sync              # preview data/stores.json against the database
npm run queue:sync -- --execute # upsert those targets
npm run queue:status            # eligible targets, this week's jobs, expired leases
npm run queue:enqueue           # queue this NZ week (idempotent)
npm run queue:work              # run one claimed job locally
```

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
