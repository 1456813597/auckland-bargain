begin;

-- The product image mirror no longer writes to Vercel Blob. Images are stored
-- on a disk this deployment owns (a Docker volume, or any directory the
-- reverse proxy can serve), so the index records a path or URL instead of a
-- blob URL, and the cost being defended against is disk space rather than
-- per-operation billing.
alter table public.product_image_mirrors rename column blob_url to stored_url;

-- The old column had an inline `^https://` check whose generated name is not
-- worth guessing; a stored image is now usually served from a relative path.
do $$
declare
  v_constraint record;
begin
  for v_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.product_image_mirrors'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%https://%'
  loop
    execute format(
      'alter table public.product_image_mirrors drop constraint %I',
      v_constraint.conname
    );
  end loop;
end;
$$;

alter table public.product_image_mirrors
  add constraint product_image_mirrors_stored_url_check
  check (stored_url is null or stored_url ~ '^(https?://|/product-images/)');

-- Recorded per image so the store's total size is a database question, the way
-- "is this image already mirrored?" already is.
alter table public.product_image_mirrors
  add column if not exists byte_size bigint
  check (byte_size is null or byte_size >= 0);

-- Vercel's monthly advanced-operation budget has no meaning on a self-hosted
-- store, and the counter it needed cannot be kept honest without it.
drop function if exists public.claim_blob_upload_slots(integer, integer);
drop table if exists public.blob_upload_budget;

create or replace function public.product_image_store_bytes()
returns bigint
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(sum(byte_size), 0)::bigint
  from public.product_image_mirrors
  where status = 'mirrored';
$$;

revoke all on function public.product_image_store_bytes()
  from public, anon, authenticated;
grant execute on function public.product_image_store_bytes() to service_role;

create or replace function public.database_readiness()
returns jsonb language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object(
    'schemaVersion', '20260909120000',
    'currentDeals', to_regclass('public.current_deals') is not null,
    'canonicalProducts', to_regclass('public.canonical_products') is not null,
    'productMatches', to_regclass('public.product_matches') is not null,
    'claimCollectionRun', to_regprocedure('public.claim_collection_run(text,text,jsonb)') is not null,
    'atomicWeeklySnapshots', to_regprocedure('public.stage_collection_offers(bigint,jsonb)') is not null,
    'durableCollectionQueue', to_regprocedure('public.claim_collection_job(text)') is not null,
    'productImageMirrorIndex',
      to_regclass('public.product_image_mirrors') is not null
      and to_regprocedure('public.product_image_store_bytes()') is not null,
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
      and to_regprocedure('public.product_image_store_bytes()') is not null
  );
$$;

revoke all on function public.database_readiness() from public, anon, authenticated;
grant execute on function public.database_readiness() to service_role;

commit;
