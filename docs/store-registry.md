# Registered store collection

This is a local, sequential collection runner and a foundation for nationwide
dispatch. It is **not** a deployed queue or an inventory of all NZ supermarkets.
The six entries in `data/stores.json` come from the existing bundled snapshot;
all have `access.status: "pending"`. No source permission has been granted by
this implementation.

## Preview first

```bash
# Read local configuration and snapshot metadata only; no source requests/writes:
npm run stores:plan
npm run stores:plan -- --store freshchoice-epsom
npm run stores:plan -- --registry path/to/stores.json
```

Each result includes the source store identity, exact collection scope,
Pacific/Auckland week start, deterministic job key, last successful capture and
one of `due`, `current`, `disabled` or `blocked`. Source credentials and permission
references are not included in the plan. A job key is stable for a store, scope
and NZ week; it is not a persisted job or proof that a task was scheduled.

Blocked reasons distinguish pending/denied/expired access, missing credentials,
unsupported complete catalogues, invalid/future snapshot dates and a requested
downgrade from a published full catalogue to specials. Legacy snapshots without
scope are treated as specials, so they cannot satisfy a full-catalogue job.

## Register an additional store

Each record requires:

- `id`: unique readable lowercase slug.
- `retailer`: one of the six implemented banners.
- `sourceStoreId`, `name`, `city`: verified store identity, not a national price.
- `address`: optional; custom stores no longer inherit a sample store's address.
- `enabled`: explicit operator switch.
- `scope`: `catalogue` or `specials`; only FreshChoice/SuperValue currently support
  `catalogue`. Their full live crawls have not yet been accepted.
- `access.status`: `pending`, `denied` or `approved`.
- For approved access, `access.reference`: a non-secret operator-reviewed
  permission/agreement reference covering collection and the intended reuse.
  Optional `access.expiresAt` is an ISO UTC timestamp. A flag is a record of a
  human source-access decision, not a licence or an automated legal assessment.
- FreshChoice/SuperValue: `storeOrigin`, restricted to that banner's official
  HTTPS `*.store.<banner>.co.nz` origin without path, credentials or query string.
- Woolworths: `cookieEnv`, a variable name such as `WOOLWORTHS_COOKIE_GLENFIELD`.
  Put its value only in the private runtime environment, never in this registry.
  A cookie does not establish permission. Its resolved store must match the ID.

Unknown fields, duplicate source identities, duplicate storefronts, unsafe URLs,
blank IDs, control characters and invalid dates are rejected before execution.
Four Square's case-insensitive store IDs are treated as the same registry target.

PAK'nSAVE and New World now expose `getAllStores()` on their adapters, alongside
the existing Four Square directory method. Foodstuffs results exclude another
banner and explicitly offline/closed records; island context is validated and
kept for each store's category queries. Discovery does not automatically approve
or enable new stores. These new directory paths have been tested with offline
fixtures, not run to produce a verified nationwide inventory. Woolworths and
MyFoodLink still need source-specific discovery/import workflows.

## Execute after source-access review

```bash
# Performs source requests only for approved, supported, enabled, due stores:
npm run stores:refresh -- --store freshchoice-epsom
npm run stores:refresh
```

Each store gets an isolated collector instance. Its source identity is checked
before catalogue requests and again before publishing; a changed identity,
scope, empty price set or older snapshot is rejected. Permission expiry is checked
again before each store, including after waiting for earlier stores to finish.

Successful stores are checkpointed individually into `data/deals.json`; a source
failure retains that store's previous data and the runner continues with other
due stores. Re-running in the same NZ week skips already successful stores and
retries failed ones. New stores are not given invented historical observations.
Any blocked/failed store makes execution exit with code 1; all-current or disabled
plans make no writes. Disk write failures stop the runner immediately.

Both this runner and the legacy `deals:refresh` command share a local exclusive
lock and same-directory temporary-file replacement. Readers see complete JSON,
and two local refresh processes cannot overwrite each other's updates. If a
worker crashes, check the PID recorded in `data/deals.json.lock` and verify it has
stopped before manually removing that specific lock. The runner does not infer
that a long-running process is dead. This is not a distributed lease.

## Durable queue and scheduled dispatch

`data/stores.json` is the reviewed manifest; `collection_targets` is the
database copy the deployed queue actually reads. They are synchronised
explicitly, never as a side effect of a request:

```bash
npm run queue:sync              # preview only, no writes
npm run queue:sync -- --execute # upsert targets (identity fields are immutable)
npm run queue:status
npm run queue:enqueue
npm run queue:work              # claim and run exactly one job
```

`/api/cron/collect` is the deployed form of `queue:enqueue` + `queue:work`,
scheduled hourly in `vercel.json`. One invocation enqueues this NZ week's
eligible targets, then claims at most `?limit=` jobs (default 3, maximum 10,
optionally narrowed with `?retailer=`), stopping after a 120-second claim
deadline so the remaining function budget belongs to the job already running.
It never loops over the whole registry in one invocation, and it never syncs
targets. A job the platform kills mid-collection stays `running` until the
database lease reaper releases it after 15 minutes; a later invocation retries
it under the same three-attempt budget with 5- and 10-minute backoff, which is
why the schedule repeats through the week instead of firing once.

Eligibility is decided in the database, not by the caller:
`collection_target_block_reason` excludes disabled targets, pending/denied/
expired access, catalogue scope on banners that do not support it, and a
downgrade from an already-published catalogue to specials. Every bundled target
is `access.status: pending`, so today the route enqueues nothing and requests no
supermarket. The publication guard re-checks the lease, configuration version,
store identity and NZ week inside the price-publishing transaction, so a target
whose permission is revoked mid-run rolls back its prices and history.

## Legacy production boundary

The six per-banner Vercel cron routes still use their single-store environment
configuration. They do **not** read this registry or apply its access gate;
neither does the legacy `deals:refresh` source-selection path. Do not activate
them without separately completing source-access review. Retire each one as its
store becomes an approved registry target, so a store is not collected by both
paths in the same week.

The local batch path was verified with fixtures and a blocked real-config run:
pending FreshChoice access yielded no saves, a nonzero execution result, unchanged
snapshot bytes and a released lock. No new live catalogue was collected.
