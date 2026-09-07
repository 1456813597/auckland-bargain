begin;

-- Vercel Blob bills `put`, `copy` and `list` as "advanced operations" and caps
-- them per plan (10,000/month on Hobby, after which the whole store is locked
-- for 30 days). The collector used to call `list` over the retailer prefix on
-- every store run, so the per-run cost grew with the size of the mirror and was
-- paid again for every store of the same banner. This index moves the question
-- "is this image already mirrored?" into Postgres, where answering it is free.
create table public.product_image_mirrors (
  pathname text primary key check (pathname ~ '^product-images/[a-z0-9-]+/[a-z0-9-]+\.(avif|gif|jpg|png|webp)$'),
  retailer_slug text not null check (length(btrim(retailer_slug)) > 0),
  -- Null only for rows adopted from a store that already held the blob, where
  -- the listing knows the pathname but not the retailer URL it came from.
  source_url text check (source_url is null or length(btrim(source_url)) between 1 and 2000),
  blob_url text check (blob_url is null or blob_url ~ '^https://'),
  status text not null check (status in ('mirrored', 'failed')),
  attempts integer not null default 1 check (attempts between 1 and 1000000),
  last_error text,
  -- A source image that cannot be mirrored is remembered so the next run keeps
  -- the retailer URL instead of paying for the same failing upload every week.
  retry_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'mirrored' or blob_url is not null),
  check (status <> 'failed' or retry_after is not null)
);

create index product_image_mirrors_retailer_idx
  on public.product_image_mirrors (retailer_slug, status);

-- The mirror is best-effort, so the safe failure mode is "spend nothing more
-- this month and keep serving retailer URLs". A counter shared by every
-- deployment makes that ceiling real instead of per-invocation.
create table public.blob_upload_budget (
  period text primary key check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  uploads integer not null default 0 check (uploads >= 0),
  updated_at timestamptz not null default now()
);

create function public.claim_blob_upload_slots(
  p_requested integer,
  p_monthly_limit integer
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  -- Vercel resets included usage on the billing cycle; the UTC calendar month
  -- is the closest boundary this database can compute on its own, and being a
  -- few days early only ever spends less than the plan allows.
  v_period text := to_char(now() at time zone 'utc', 'YYYY-MM');
  v_used integer;
  v_granted integer;
begin
  if p_requested is null or p_requested < 0 then
    raise exception 'Requested blob upload slots must not be negative';
  end if;
  if p_monthly_limit is null or p_monthly_limit < 0 then
    raise exception 'Monthly blob upload limit must not be negative';
  end if;
  if p_requested = 0 then
    return 0;
  end if;

  insert into public.blob_upload_budget (period) values (v_period)
  on conflict (period) do nothing;

  -- Serialise concurrent collections on the counter row. Reading the remaining
  -- budget without the lock would let parallel store runs both believe the full
  -- remainder is theirs and jointly exceed the plan quota.
  select uploads into v_used from public.blob_upload_budget
  where period = v_period for update;

  v_granted := least(p_requested, greatest(p_monthly_limit - v_used, 0));
  if v_granted > 0 then
    update public.blob_upload_budget
    set uploads = v_used + v_granted, updated_at = now()
    where period = v_period;
  end if;
  return v_granted;
end;
$$;

alter table public.product_image_mirrors enable row level security;
alter table public.blob_upload_budget enable row level security;

revoke all on table public.product_image_mirrors from anon, authenticated;
revoke all on table public.blob_upload_budget from anon, authenticated;
grant all on table public.product_image_mirrors to service_role;
grant all on table public.blob_upload_budget to service_role;

revoke all on function public.claim_blob_upload_slots(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_blob_upload_slots(integer, integer)
  to service_role;

create or replace function public.database_readiness()
returns jsonb language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object(
    'schemaVersion', '20260907140000',
    'currentDeals', to_regclass('public.current_deals') is not null,
    'canonicalProducts', to_regclass('public.canonical_products') is not null,
    'productMatches', to_regclass('public.product_matches') is not null,
    'claimCollectionRun', to_regprocedure('public.claim_collection_run(text,text,jsonb)') is not null,
    'atomicWeeklySnapshots', to_regprocedure('public.stage_collection_offers(bigint,jsonb)') is not null,
    'durableCollectionQueue', to_regprocedure('public.claim_collection_job(text)') is not null,
    'productImageMirrorIndex',
      to_regclass('public.product_image_mirrors') is not null
      and to_regprocedure('public.claim_blob_upload_slots(integer,integer)') is not null,
    'ready',
      to_regclass('public.current_deals') is not null
      and to_regclass('public.canonical_products') is not null
      and to_regclass('public.product_matches') is not null
      and to_regclass('public.canonical_products_matching_tokens_idx') is not null
      and to_regclass('public.product_image_mirrors') is not null
      and to_regprocedure('public.stage_collection_offers(bigint,jsonb)') is not null
      and to_regprocedure('public.claim_collection_run(text,text,jsonb)') is not null
      and to_regprocedure('public.claim_collection_job(text)') is not null
      and to_regprocedure('public.enqueue_weekly_collection_jobs(text)') is not null
      and to_regprocedure('public.claim_blob_upload_slots(integer,integer)') is not null
  );
$$;

revoke all on function public.database_readiness() from public, anon, authenticated;
grant execute on function public.database_readiness() to service_role;

commit;
