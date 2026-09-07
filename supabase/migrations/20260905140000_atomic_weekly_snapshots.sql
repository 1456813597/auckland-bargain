begin;

-- A retry belongs to the same New Zealand calendar week. It must not displace
-- the previous week's observation or produce a spurious weekly price change.
alter table public.offer_history add column week_start date;
update public.offer_history
set week_start = date_trunc('week', observed_at at time zone 'Pacific/Auckland')::date;
alter table public.offer_history alter column week_start set not null;

delete from public.offer_history
where id in (
  select id from (
    select id, row_number() over (
      partition by retailer_product_id, store_id, week_start
      order by observed_at desc, id desc
    ) as position from public.offer_history
  ) ranked where position > 1
);
delete from public.offer_history
where id in (
  select id from (
    select id, row_number() over (
      partition by retailer_product_id, store_id
      order by week_start desc
    ) as position from public.offer_history
  ) ranked where position > 2
);
alter table public.offer_history add constraint offer_history_one_per_week
  unique (retailer_product_id, store_id, week_start);

create or replace function public.capture_offer_history()
returns trigger language plpgsql set search_path = public as $$
begin
  -- Deactivation and other bookkeeping updates are not price observations.
  if tg_op = 'UPDATE'
     and old.collected_at = new.collected_at
     and old.content_hash = new.content_hash then
    return new;
  end if;
  if not new.active then return new; end if;

  insert into public.offer_history (
    retailer_product_id, store_id, regular_price_cents, promo_price_cents,
    member_price_cents, effective_price_cents, promotion_type, promotion_text,
    content_hash, observed_at, week_start
  ) values (
    new.retailer_product_id, new.store_id, new.regular_price_cents,
    new.promo_price_cents, new.member_price_cents,
    coalesce(new.member_price_cents, new.promo_price_cents, new.regular_price_cents),
    new.promotion_type, new.promotion_text, new.content_hash, new.collected_at,
    date_trunc('week', new.collected_at at time zone 'Pacific/Auckland')::date
  ) on conflict on constraint offer_history_one_per_week do update set
    regular_price_cents = excluded.regular_price_cents,
    promo_price_cents = excluded.promo_price_cents,
    member_price_cents = excluded.member_price_cents,
    effective_price_cents = excluded.effective_price_cents,
    promotion_type = excluded.promotion_type,
    promotion_text = excluded.promotion_text,
    content_hash = excluded.content_hash,
    observed_at = excluded.observed_at
  where excluded.observed_at >= offer_history.observed_at;

  delete from public.offer_history where id in (
    select id from public.offer_history
    where retailer_product_id = new.retailer_product_id and store_id = new.store_id
    order by week_start desc offset 2
  );
  return new;
end;
$$;

-- Network batches are staged away from public current offers and history.
-- The final RPC publishes the entire store in one Postgres transaction.
create table public.collection_offer_staging (
  run_id bigint not null references public.collection_runs(id) on delete cascade,
  retailer_product_id bigint not null references public.retailer_products(id) on delete cascade,
  regular_price_cents integer check (regular_price_cents >= 0),
  promo_price_cents integer check (promo_price_cents >= 0),
  member_price_cents integer check (member_price_cents >= 0),
  promotion_type text,
  promotion_text text,
  valid_until timestamptz,
  collected_at timestamptz not null,
  content_hash text not null,
  primary key (run_id, retailer_product_id),
  check (coalesce(member_price_cents, promo_price_cents, regular_price_cents) is not null)
);
alter table public.collection_offer_staging enable row level security;
revoke all on public.collection_offer_staging from public, anon, authenticated;
grant all on public.collection_offer_staging to service_role;

create function public.stage_collection_offers(p_run_id bigint, p_offers jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_run public.collection_runs;
  v_retailer_id bigint;
begin
  select * into v_run from public.collection_runs where id = p_run_id for update;
  if not found or v_run.status <> 'running'
     or v_run.started_at < now() - interval '15 minutes' then
    raise exception 'Collection % does not hold an active lease', p_run_id;
  end if;
  if p_offers is null or jsonb_typeof(p_offers) <> 'array' then
    raise exception 'Offers must be a nonempty array';
  end if;
  if jsonb_array_length(p_offers) < 1 then
    raise exception 'Offers must be a nonempty array';
  end if;
  select id into v_retailer_id from public.retailers where slug = v_run.retailer_slug;
  if v_retailer_id is null or exists (
    select 1 from jsonb_to_recordset(p_offers) as offer(retailer_product_id bigint)
    left join public.retailer_products rp on rp.id = offer.retailer_product_id
    where rp.retailer_id is distinct from v_retailer_id
  ) then
    raise exception 'Collection contains a product from another retailer';
  end if;

  insert into public.collection_offer_staging (
    run_id, retailer_product_id, regular_price_cents, promo_price_cents,
    member_price_cents, promotion_type, promotion_text, valid_until,
    collected_at, content_hash
  ) select p_run_id, offer.* from jsonb_to_recordset(p_offers) as offer(
    retailer_product_id bigint, regular_price_cents integer, promo_price_cents integer,
    member_price_cents integer, promotion_type text, promotion_text text,
    valid_until timestamptz, collected_at timestamptz, content_hash text
  ) on conflict (run_id, retailer_product_id) do update set
    regular_price_cents = excluded.regular_price_cents,
    promo_price_cents = excluded.promo_price_cents,
    member_price_cents = excluded.member_price_cents,
    promotion_type = excluded.promotion_type,
    promotion_text = excluded.promotion_text,
    valid_until = excluded.valid_until,
    collected_at = excluded.collected_at,
    content_hash = excluded.content_hash;
end;
$$;

create or replace function public.finalize_collection_run(p_run_id bigint, p_offers_seen integer)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_run public.collection_runs;
  v_store_id bigint;
  v_staged integer;
begin
  select * into v_run from public.collection_runs where id = p_run_id for update;
  if not found then raise exception 'Unknown collection %', p_run_id; end if;
  -- Response delivery can fail after commit. Repeating finalization is safe.
  if v_run.status = 'succeeded' and v_run.offers_seen = p_offers_seen then return; end if;
  if v_run.status <> 'running' or v_run.started_at < now() - interval '15 minutes' then
    raise exception 'Collection % does not hold an active lease', p_run_id;
  end if;
  select s.id into v_store_id from public.stores s
  join public.retailers r on r.id = s.retailer_id
  where r.slug = v_run.retailer_slug and s.source_store_id = v_run.store_source_id;
  if v_store_id is null then raise exception 'Collection has no matching store'; end if;

  select count(*) into v_staged from public.collection_offer_staging where run_id = p_run_id;
  if p_offers_seen is null or p_offers_seen < 1 or v_staged <> p_offers_seen then
    raise exception 'Expected % offers but staged %', p_offers_seen, v_staged;
  end if;
  if (select min(collected_at) from public.collection_offer_staging where run_id = p_run_id)
    < (select max(collected_at) from public.current_offers where store_id = v_store_id) then
    raise exception 'An older collection cannot replace newer prices';
  end if;

  insert into public.current_offers (
    retailer_product_id, store_id, regular_price_cents, promo_price_cents,
    member_price_cents, promotion_type, promotion_text, valid_until,
    collected_at, content_hash, active, last_seen_run_id
  ) select retailer_product_id, v_store_id, regular_price_cents, promo_price_cents,
    member_price_cents, promotion_type, promotion_text, valid_until,
    collected_at, content_hash, true, p_run_id
    from public.collection_offer_staging where run_id = p_run_id
  on conflict (retailer_product_id, store_id) do update set
    regular_price_cents = excluded.regular_price_cents,
    promo_price_cents = excluded.promo_price_cents,
    member_price_cents = excluded.member_price_cents,
    promotion_type = excluded.promotion_type,
    promotion_text = excluded.promotion_text,
    valid_until = excluded.valid_until,
    collected_at = excluded.collected_at,
    content_hash = excluded.content_hash,
    active = true,
    last_seen_run_id = excluded.last_seen_run_id;

  update public.current_offers set active = false
  where store_id = v_store_id and active and last_seen_run_id is distinct from p_run_id;
  update public.collection_runs set status = 'succeeded', offers_seen = p_offers_seen,
    finished_at = now(), error_message = null where id = p_run_id;
end;
$$;

create function public.clear_collection_staging()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('succeeded', 'failed') then
    delete from public.collection_offer_staging where run_id = new.id;
  end if;
  return new;
end;
$$;
create trigger collection_runs_clear_staging after update of status on public.collection_runs
for each row execute function public.clear_collection_staging();

revoke all on function public.stage_collection_offers(bigint, jsonb) from public, anon, authenticated;
revoke all on function public.finalize_collection_run(bigint, integer) from public, anon, authenticated;
revoke all on function public.claim_collection_run(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.clear_collection_staging() from public, anon, authenticated;
grant execute on function public.stage_collection_offers(bigint, jsonb) to service_role;
grant execute on function public.finalize_collection_run(bigint, integer) to service_role;
grant execute on function public.claim_collection_run(text, text, jsonb) to service_role;

create or replace function public.database_readiness()
returns jsonb language sql stable security definer set search_path = public, pg_catalog as $$
  select jsonb_build_object(
    'schemaVersion', '20260905140000',
    'currentDeals', to_regclass('public.current_deals') is not null,
    'canonicalProducts', to_regclass('public.canonical_products') is not null,
    'productMatches', to_regclass('public.product_matches') is not null,
    'claimCollectionRun', to_regprocedure('public.claim_collection_run(text,text,jsonb)') is not null,
    'atomicWeeklySnapshots', to_regprocedure('public.stage_collection_offers(bigint,jsonb)') is not null,
    'ready',
      to_regclass('public.current_deals') is not null
      and to_regclass('public.canonical_products') is not null
      and to_regclass('public.product_matches') is not null
      and to_regclass('public.canonical_products_matching_tokens_idx') is not null
      and to_regprocedure('public.stage_collection_offers(bigint,jsonb)') is not null
      and to_regprocedure('public.claim_collection_run(text,text,jsonb)') is not null
  );
$$;

commit;
