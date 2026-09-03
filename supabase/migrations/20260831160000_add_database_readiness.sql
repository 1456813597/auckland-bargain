begin;

create or replace function public.database_readiness()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select jsonb_build_object(
    'schemaVersion', '20260831160000',
    'currentDeals', to_regclass('public.current_deals') is not null,
    'claimCollectionRun',
      to_regprocedure('public.claim_collection_run(text,text,jsonb)') is not null,
    'ready',
      to_regclass('public.current_deals') is not null
      and to_regprocedure('public.claim_collection_run(text,text,jsonb)') is not null
  );
$$;

revoke all on function public.database_readiness() from public, anon, authenticated;
grant execute on function public.database_readiness() to service_role;

commit;
