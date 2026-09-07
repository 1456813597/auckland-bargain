begin;

-- Configuration is separate from observed stores: discovering a shop is not
-- evidence of a usable catalogue or permission to collect/reuse its contents.
create table public.collection_targets (
  id text primary key check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  retailer_slug text not null check (retailer_slug in ('woolworths', 'paknsave', 'newworld', 'foursquare', 'freshchoice', 'supervalue')),
  source_store_id text not null check (length(btrim(source_store_id)) between 1 and 200),
  name text not null check (length(btrim(name)) > 0),
  city text not null check (length(btrim(city)) > 0),
  address text,
  store_origin text,
  cookie_env text,
  scope text not null check (scope in ('specials', 'catalogue')),
  enabled boolean not null default false,
  access_status text not null default 'pending' check (access_status in ('pending', 'approved', 'denied')),
  access_reference text,
  access_expires_at timestamptz,
  config_version bigint not null default 1,
  updated_at timestamptz not null default now(),
  check (access_status <> 'approved' or coalesce(length(btrim(access_reference)), 0) > 0),
  check (retailer_slug <> 'woolworths' or coalesce(cookie_env ~ '^WOOLWORTHS_COOKIE(_[A-Z0-9]+)*$', false)),
  check (retailer_slug <> 'foursquare' or source_store_id = upper(source_store_id))
);
create unique index collection_targets_source_key on public.collection_targets
  (retailer_slug, (case when retailer_slug = 'foursquare' then lower(source_store_id) else source_store_id end));

create table public.collection_jobs (
  id bigint generated always as identity primary key,
  target_id text not null references public.collection_targets(id),
  week_start date not null check (extract(isodow from week_start) = 1),
  scope text not null check (scope in ('specials', 'catalogue')),
  status text not null default 'queued' check (status in ('queued', 'running', 'retry', 'succeeded', 'failed', 'cancelled')),
  attempts integer not null default 0 check (attempts between 0 and 3),
  current_run_id bigint unique references public.collection_runs(id),
  claimed_config_version bigint,
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (target_id, week_start, scope),
  check (status <> 'running' or (current_run_id is not null and claimed_config_version is not null and attempts > 0))
);
create index collection_jobs_ready_idx on public.collection_jobs (available_at, id)
  where status in ('queued', 'retry');
create index collection_jobs_week_status_idx on public.collection_jobs (week_start, status);
create index collection_jobs_full_success_idx on public.collection_jobs (target_id)
  where status = 'succeeded' and scope = 'catalogue';

create function public.version_collection_target()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.id <> old.id or new.retailer_slug <> old.retailer_slug or new.source_store_id <> old.source_store_id then
    raise exception 'Collection target identity is immutable; disable the old target and register a new one';
  end if;
  if (to_jsonb(new) - 'config_version' - 'updated_at') is distinct from
     (to_jsonb(old) - 'config_version' - 'updated_at') then
    new.config_version := old.config_version + 1;
    new.updated_at := now();
  else
    new.config_version := old.config_version;
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;
create trigger collection_targets_version before update on public.collection_targets
for each row execute function public.version_collection_target();

create function public.collection_target_block_reason(p_target public.collection_targets)
returns text language sql stable set search_path = pg_catalog, public, pg_temp as $$
  select case
    when not p_target.enabled then 'disabled'
    when p_target.access_status <> 'approved' then 'access-' || p_target.access_status
    when p_target.access_expires_at <= now() then 'access-expired'
    when p_target.scope = 'catalogue' and p_target.retailer_slug not in ('freshchoice', 'supervalue') then 'catalogue-unsupported'
    when p_target.scope = 'specials' and (exists (
      select 1 from public.collection_jobs j where j.target_id = p_target.id and j.scope = 'catalogue' and j.status = 'succeeded'
    ) or exists (
      select 1 from public.collection_runs r where r.retailer_slug = p_target.retailer_slug
        and r.store_source_id = p_target.source_store_id and r.status = 'succeeded' and r.metadata->>'scope' = 'catalogue'
    )) then 'scope-downgrade'
    else null
  end;
$$;

-- This BEFORE trigger runs within finalization's transaction, after prices were
-- written but before commit. Raising here rolls back prices and history too.
create function public.guard_queued_collection_publication()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_job public.collection_jobs;
  v_target public.collection_targets;
begin
  if new.status <> 'succeeded' or old.status = 'succeeded' then return new; end if;
  select * into v_job from public.collection_jobs where current_run_id = new.id;
  if not found then return new; end if; -- Legacy single-store collectors.
  select * into v_target from public.collection_targets where id = v_job.target_id for share;
  select * into v_job from public.collection_jobs where id = v_job.id for update;
  if v_job.status <> 'running' or v_job.current_run_id <> new.id
     or v_job.claimed_config_version <> v_target.config_version
     or v_job.scope <> v_target.scope
     or new.retailer_slug <> v_target.retailer_slug
     or new.store_source_id <> v_target.source_store_id
     or public.collection_target_block_reason(v_target) is not null then
    raise exception 'Queued collection lost its target configuration or source access';
  end if;
  if exists (
    select 1 from public.collection_offer_staging
    where run_id = new.id and date_trunc('week', collected_at at time zone 'Pacific/Auckland')::date <> v_job.week_start
  ) then
    raise exception 'Queued collection observations belong to a different NZ week';
  end if;
  return new;
end;
$$;
create trigger collection_runs_guard_job before update of status on public.collection_runs
for each row execute function public.guard_queued_collection_publication();

create function public.record_collection_job_outcome()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_week date := date_trunc('week', now() at time zone 'Pacific/Auckland')::date;
begin
  if new.status = old.status or new.status = 'running' then return new; end if;
  update public.collection_jobs set
    status = case
      when new.status = 'succeeded' then 'succeeded'
      when week_start < v_week then 'cancelled'
      when attempts >= 3 then 'failed'
      else 'retry' end,
    available_at = now() + make_interval(mins => (5 * power(2, greatest(0, attempts - 1)))::integer),
    finished_at = case when new.status = 'succeeded' or attempts >= 3 or week_start < v_week then now() else null end,
    last_error = case when new.status = 'succeeded' then null else left(coalesce(new.error_message, 'Collection failed'), 2000) end
  where current_run_id = new.id and status = 'running';
  return new;
end;
$$;
create trigger collection_runs_record_job after update of status on public.collection_runs
for each row execute function public.record_collection_job_outcome();

create function public.maintain_collection_jobs()
returns void language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_run_id bigint;
begin
  -- Lock runs before their outcome trigger locks jobs, as finalization does.
  -- A bounded sweep avoids holding a transaction across a large national queue.
  for v_run_id in
    select r.id from public.collection_runs r
    join public.collection_jobs j on j.current_run_id = r.id
    where r.status = 'running' and r.started_at < now() - interval '15 minutes'
    order by r.started_at limit 100 for update of r skip locked
  loop
    update public.collection_runs set status = 'failed', finished_at = now(),
      error_message = 'Collection lease expired before completion' where id = v_run_id;
  end loop;
  update public.collection_jobs set status = 'cancelled', finished_at = now(),
    last_error = 'Superseded by a newer NZ calendar week'
  where status in ('queued', 'retry')
    and week_start < date_trunc('week', now() at time zone 'Pacific/Auckland')::date;
end;
$$;

create function public.enqueue_weekly_collection_jobs(p_retailer_slug text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_week date := date_trunc('week', now() at time zone 'Pacific/Auckland')::date;
  v_inserted integer;
begin
  if p_retailer_slug is not null and p_retailer_slug not in ('woolworths', 'paknsave', 'newworld', 'foursquare', 'freshchoice', 'supervalue') then
    raise exception 'Unknown retailer';
  end if;
  perform public.maintain_collection_jobs();
  insert into public.collection_jobs (target_id, week_start, scope)
  select id, v_week, scope from public.collection_targets t
  where (p_retailer_slug is null or retailer_slug = p_retailer_slug)
    and public.collection_target_block_reason(t) is null
  on conflict (target_id, week_start, scope) do nothing;
  get diagnostics v_inserted = row_count;
  return jsonb_build_object('weekStart', v_week, 'inserted', v_inserted);
end;
$$;

create function public.claim_collection_job(p_retailer_slug text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_candidate record;
  v_job public.collection_jobs;
  v_target public.collection_targets;
  v_run_id bigint;
  v_week date := date_trunc('week', now() at time zone 'Pacific/Auckland')::date;
begin
  if p_retailer_slug is not null and p_retailer_slug not in ('woolworths', 'paknsave', 'newworld', 'foursquare', 'freshchoice', 'supervalue') then
    raise exception 'Unknown retailer';
  end if;
  perform public.maintain_collection_jobs();
  for v_candidate in
    select j.id, t.id as target_id, t.retailer_slug, t.source_store_id
    from public.collection_jobs j join public.collection_targets t on t.id = j.target_id
    where j.status in ('queued', 'retry') and j.attempts < 3 and j.available_at <= now()
      and j.week_start = v_week and j.scope = t.scope
      and (p_retailer_slug is null or t.retailer_slug = p_retailer_slug)
      and public.collection_target_block_reason(t) is null
    order by j.available_at, j.id limit 100
  loop
    -- Acquire the store-level advisory lock before any job row lock. Different
    -- scope jobs must not deadlock while expiring the same store's old run.
    if not pg_try_advisory_xact_lock(hashtextextended(jsonb_build_array(v_candidate.retailer_slug, v_candidate.source_store_id)::text, 0)) then continue; end if;
    -- Do not retain multiple target locks while scanning busy jobs: that could
    -- deadlock with a batched registry sync. Configuration versions fence edits.
    select * into v_target from public.collection_targets where id = v_candidate.target_id;
    select * into v_job from public.collection_jobs where id = v_candidate.id for update skip locked;
    if not found then continue; end if;
    if v_job.status not in ('queued', 'retry') or v_job.available_at > now()
       or v_job.attempts >= 3 or v_job.scope <> v_target.scope
       or public.collection_target_block_reason(v_target) is not null then continue; end if;
    v_run_id := public.claim_collection_run(v_target.retailer_slug, v_target.source_store_id,
      jsonb_build_object('trigger', 'durable-queue', 'jobId', v_job.id, 'weekStart', v_week, 'scope', v_job.scope));
    if v_run_id is null then
      update public.collection_jobs set available_at = now() + interval '1 minute' where id = v_job.id;
      continue;
    end if;
    update public.collection_jobs set status = 'running', current_run_id = v_run_id,
      claimed_config_version = v_target.config_version, attempts = attempts + 1,
      claimed_at = now(), finished_at = null, last_error = null where id = v_job.id;
    return jsonb_build_object(
      'jobId', v_job.id, 'runId', v_run_id, 'attempt', v_job.attempts + 1,
      'weekStart', v_week, 'configVersion', v_target.config_version,
      'store', jsonb_strip_nulls(jsonb_build_object(
        'id', v_target.id, 'retailer', v_target.retailer_slug, 'sourceStoreId', v_target.source_store_id,
        'name', v_target.name, 'city', v_target.city, 'address', v_target.address,
        'storeOrigin', v_target.store_origin, 'cookieEnv', v_target.cookie_env,
        'scope', v_target.scope, 'enabled', v_target.enabled,
        'access', jsonb_build_object('status', v_target.access_status, 'reference', v_target.access_reference,
          'expiresAt', to_char(v_target.access_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      )));
  end loop;
  return null;
end;
$$;

create function public.fail_collection_job(p_job_id bigint, p_run_id bigint, p_error text)
returns text language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_status text;
begin
  -- Lock run first, then update its status and let the outcome trigger lock job.
  perform 1 from public.collection_runs where id = p_run_id for update;
  update public.collection_runs r set status = 'failed', finished_at = now(), error_message = left(p_error, 2000)
  where r.id = p_run_id and r.status = 'running' and exists (
    select 1 from public.collection_jobs j where j.id = p_job_id and j.current_run_id = r.id and j.status = 'running'
  );
  select status into v_status from public.collection_jobs where id = p_job_id and current_run_id = p_run_id;
  if not found then raise exception 'Job run is no longer current'; end if;
  return v_status; -- A committed success is never changed by lost-response cleanup.
end;
$$;

create function public.collection_job_access_valid(p_job_id bigint, p_run_id bigint)
returns boolean language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select exists (
    select 1 from public.collection_jobs j
    join public.collection_targets t on t.id = j.target_id
    join public.collection_runs r on r.id = j.current_run_id
    where j.id = p_job_id and j.current_run_id = p_run_id and j.status = 'running'
      and r.status = 'running' and r.started_at >= now() - interval '15 minutes'
      and j.claimed_config_version = t.config_version and j.scope = t.scope
      and public.collection_target_block_reason(t) is null
  );
$$;

create function public.collection_queue_status()
returns jsonb language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object(
    'weekStart', date_trunc('week', now() at time zone 'Pacific/Auckland')::date,
    'targets', coalesce((select jsonb_object_agg(reason, amount) from (
      select coalesce(public.collection_target_block_reason(t), 'eligible') as reason, count(*) as amount
      from public.collection_targets t group by 1
    ) counts), '{}'::jsonb),
    'jobs', coalesce((select jsonb_object_agg(status, amount) from (
      select status, count(*) as amount from public.collection_jobs
      where week_start = date_trunc('week', now() at time zone 'Pacific/Auckland')::date group by status
    ) counts), '{}'::jsonb),
    'expiredLeases', (select count(*) from public.collection_jobs j join public.collection_runs r on r.id = j.current_run_id
      where j.status = 'running' and r.status = 'running' and r.started_at < now() - interval '15 minutes')
  );
$$;

alter table public.collection_targets enable row level security;
alter table public.collection_jobs enable row level security;
revoke all on public.collection_targets, public.collection_jobs from public, anon, authenticated;
grant all on public.collection_targets, public.collection_jobs to service_role;
grant usage, select on sequence public.collection_jobs_id_seq to service_role;

revoke all on function public.version_collection_target() from public, anon, authenticated;
revoke all on function public.collection_target_block_reason(public.collection_targets) from public, anon, authenticated;
revoke all on function public.guard_queued_collection_publication() from public, anon, authenticated;
revoke all on function public.record_collection_job_outcome() from public, anon, authenticated;
revoke all on function public.maintain_collection_jobs() from public, anon, authenticated;
revoke all on function public.enqueue_weekly_collection_jobs(text) from public, anon, authenticated;
revoke all on function public.claim_collection_job(text) from public, anon, authenticated;
revoke all on function public.fail_collection_job(bigint,bigint,text) from public, anon, authenticated;
revoke all on function public.collection_job_access_valid(bigint,bigint) from public, anon, authenticated;
revoke all on function public.collection_queue_status() from public, anon, authenticated;
grant execute on function public.enqueue_weekly_collection_jobs(text) to service_role;
grant execute on function public.claim_collection_job(text) to service_role;
grant execute on function public.fail_collection_job(bigint,bigint,text) to service_role;
grant execute on function public.collection_job_access_valid(bigint,bigint) to service_role;
grant execute on function public.collection_queue_status() to service_role;

create or replace function public.database_readiness()
returns jsonb language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object(
    'schemaVersion', '20260907090000',
    'currentDeals', to_regclass('public.current_deals') is not null,
    'canonicalProducts', to_regclass('public.canonical_products') is not null,
    'productMatches', to_regclass('public.product_matches') is not null,
    'claimCollectionRun', to_regprocedure('public.claim_collection_run(text,text,jsonb)') is not null,
    'atomicWeeklySnapshots', to_regprocedure('public.stage_collection_offers(bigint,jsonb)') is not null,
    'durableCollectionQueue', to_regprocedure('public.claim_collection_job(text)') is not null,
    'ready',
      to_regclass('public.current_deals') is not null
      and to_regclass('public.canonical_products') is not null
      and to_regclass('public.product_matches') is not null
      and to_regclass('public.canonical_products_matching_tokens_idx') is not null
      and to_regprocedure('public.stage_collection_offers(bigint,jsonb)') is not null
      and to_regprocedure('public.claim_collection_run(text,text,jsonb)') is not null
      and to_regprocedure('public.claim_collection_job(text)') is not null
      and to_regprocedure('public.enqueue_weekly_collection_jobs(text)') is not null
  );
$$;

commit;
