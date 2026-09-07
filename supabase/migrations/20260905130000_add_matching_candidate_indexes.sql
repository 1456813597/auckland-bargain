begin;

alter table public.canonical_products
  add column if not exists matching_measure text,
  add column if not exists matching_tokens text[] not null default '{}';

-- Existing canonical rows predate the JavaScript blocking-key generator. The
-- title token backfill keeps them discoverable; future rows store the tighter
-- three-token set and normalized measure key at creation time.
update public.canonical_products product
   set matching_tokens = coalesce(
     (
       select array_agg(distinct token)
       from unnest(regexp_split_to_array(product.normalized_name, '\s+')) token
       where length(token) >= 3
     ),
     '{}'
   )
 where cardinality(product.matching_tokens) = 0;

create index if not exists canonical_products_matching_measure_idx
  on public.canonical_products (matching_measure)
  where matching_measure is not null;

create index if not exists canonical_products_matching_tokens_idx
  on public.canonical_products using gin (matching_tokens);

create or replace function public.database_readiness()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select jsonb_build_object(
    'schemaVersion', '20260905130000',
    'currentDeals', to_regclass('public.current_deals') is not null,
    'canonicalProducts', to_regclass('public.canonical_products') is not null,
    'productMatches', to_regclass('public.product_matches') is not null,
    'matchingCandidateIndexes',
      exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'canonical_products'
          and column_name = 'matching_tokens'
      ),
    'claimCollectionRun',
      to_regprocedure('public.claim_collection_run(text,text,jsonb)') is not null,
    'ready',
      to_regclass('public.current_deals') is not null
      and to_regclass('public.canonical_products') is not null
      and to_regclass('public.product_matches') is not null
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'canonical_products'
          and column_name = 'matching_tokens'
      )
      and to_regprocedure('public.claim_collection_run(text,text,jsonb)') is not null
  );
$$;

revoke all on function public.database_readiness() from public, anon, authenticated;
grant execute on function public.database_readiness() to service_role;

commit;
