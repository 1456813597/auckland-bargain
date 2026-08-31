begin;

create table public.retailers (
  id bigint generated always as identity primary key,
  name text not null,
  slug text not null unique,
  website text,
  created_at timestamptz not null default now()
);

create table public.stores (
  id bigint generated always as identity primary key,
  retailer_id bigint not null references public.retailers(id) on delete cascade,
  source_store_id text not null,
  name text not null,
  city text not null,
  address text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (retailer_id, source_store_id)
);

create index stores_city_active_idx on public.stores (city, active);

create table public.retailer_products (
  id bigint generated always as identity primary key,
  retailer_id bigint not null references public.retailers(id) on delete cascade,
  source_product_id text not null,
  source_name text not null,
  brand text,
  category text,
  size text,
  gtin text,
  image_url text,
  source_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (retailer_id, source_product_id)
);

create index retailer_products_gtin_idx
  on public.retailer_products (gtin)
  where gtin is not null;

create table public.collection_runs (
  id bigint generated always as identity primary key,
  retailer_slug text not null,
  store_source_id text not null,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  offers_seen integer not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error_message text,
  metadata jsonb not null default '{}'::jsonb
);

create index collection_runs_store_started_idx
  on public.collection_runs (retailer_slug, store_source_id, started_at desc);

create unique index collection_runs_one_running_idx
  on public.collection_runs (retailer_slug, store_source_id)
  where status = 'running';

create table public.current_offers (
  id bigint generated always as identity primary key,
  retailer_product_id bigint not null references public.retailer_products(id) on delete cascade,
  store_id bigint not null references public.stores(id) on delete cascade,
  regular_price_cents integer,
  promo_price_cents integer,
  member_price_cents integer,
  promotion_type text,
  promotion_text text,
  valid_until timestamptz,
  collected_at timestamptz not null,
  content_hash text not null,
  active boolean not null default true,
  last_seen_run_id bigint references public.collection_runs(id) on delete set null,
  unique (retailer_product_id, store_id),
  check (coalesce(member_price_cents, promo_price_cents, regular_price_cents) is not null)
);

create index current_offers_store_active_idx
  on public.current_offers (store_id, active, collected_at desc);

create table public.offer_history (
  id bigint generated always as identity primary key,
  retailer_product_id bigint not null references public.retailer_products(id) on delete cascade,
  store_id bigint not null references public.stores(id) on delete cascade,
  regular_price_cents integer,
  promo_price_cents integer,
  member_price_cents integer,
  effective_price_cents integer not null,
  promotion_type text,
  promotion_text text,
  content_hash text not null,
  observed_at timestamptz not null
);

create index offer_history_product_store_date_idx
  on public.offer_history (retailer_product_id, store_id, observed_at desc);

create or replace function public.capture_offer_history()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or old.content_hash is distinct from new.content_hash then
    insert into public.offer_history (
      retailer_product_id,
      store_id,
      regular_price_cents,
      promo_price_cents,
      member_price_cents,
      effective_price_cents,
      promotion_type,
      promotion_text,
      content_hash,
      observed_at
    ) values (
      new.retailer_product_id,
      new.store_id,
      new.regular_price_cents,
      new.promo_price_cents,
      new.member_price_cents,
      coalesce(new.member_price_cents, new.promo_price_cents, new.regular_price_cents),
      new.promotion_type,
      new.promotion_text,
      new.content_hash,
      new.collected_at
    );
  end if;

  return new;
end;
$$;

create trigger current_offers_capture_history
after insert or update on public.current_offers
for each row execute function public.capture_offer_history();

create or replace function public.claim_collection_run(
  p_retailer_slug text,
  p_store_source_id text,
  p_metadata jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id bigint;
begin
  update public.collection_runs
     set status = 'failed',
         finished_at = now(),
         error_message = 'Collection lease expired before completion'
   where retailer_slug = p_retailer_slug
     and store_source_id = p_store_source_id
     and status = 'running'
     and started_at < now() - interval '15 minutes';

  begin
    insert into public.collection_runs (
      retailer_slug,
      store_source_id,
      status,
      metadata
    ) values (
      p_retailer_slug,
      p_store_source_id,
      'running',
      coalesce(p_metadata, '{}'::jsonb)
    )
    returning id into v_run_id;
  exception
    when unique_violation then
      return null;
  end;

  return v_run_id;
end;
$$;

create or replace function public.finalize_collection_run(
  p_run_id bigint,
  p_offers_seen integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_id bigint;
begin
  select s.id
    into v_store_id
  from public.collection_runs cr
  join public.retailers r on r.slug = cr.retailer_slug
  join public.stores s
    on s.retailer_id = r.id
   and s.source_store_id = cr.store_source_id
  where cr.id = p_run_id
    and cr.status = 'running';

  if v_store_id is null then
    raise exception 'Running collection % does not have a matching store', p_run_id;
  end if;

  update public.current_offers
     set active = false
   where store_id = v_store_id
     and active = true
     and last_seen_run_id is distinct from p_run_id;

  update public.collection_runs
     set status = 'succeeded',
         offers_seen = p_offers_seen,
         finished_at = now(),
         error_message = null
   where id = p_run_id;
end;
$$;

create view public.current_deals
with (security_invoker = true)
as
select
  co.id as offer_id,
  co.retailer_product_id,
  co.store_id,
  rp.source_product_id,
  rp.source_name,
  rp.brand,
  rp.category,
  rp.size,
  rp.gtin,
  rp.image_url,
  rp.source_url,
  r.name as retailer_name,
  r.slug as retailer_slug,
  s.name as store_name,
  s.city,
  co.regular_price_cents,
  co.promo_price_cents,
  co.member_price_cents,
  co.promotion_type,
  co.promotion_text,
  co.valid_until,
  co.collected_at,
  coalesce(co.member_price_cents, co.promo_price_cents, co.regular_price_cents) as effective_price_cents,
  case
    when co.regular_price_cents > 0 then
      round(
        100.0 * (
          co.regular_price_cents
          - coalesce(co.member_price_cents, co.promo_price_cents, co.regular_price_cents)
        ) / co.regular_price_cents
      )::integer
    else 0
  end as advertised_discount_percent
from public.current_offers co
join public.retailer_products rp on rp.id = co.retailer_product_id
join public.retailers r on r.id = rp.retailer_id
join public.stores s on s.id = co.store_id
where co.active = true;

alter table public.retailers enable row level security;
alter table public.stores enable row level security;
alter table public.retailer_products enable row level security;
alter table public.collection_runs enable row level security;
alter table public.current_offers enable row level security;
alter table public.offer_history enable row level security;

revoke all on table public.retailers from anon, authenticated;
revoke all on table public.stores from anon, authenticated;
revoke all on table public.retailer_products from anon, authenticated;
revoke all on table public.collection_runs from anon, authenticated;
revoke all on table public.current_offers from anon, authenticated;
revoke all on table public.offer_history from anon, authenticated;
revoke all on table public.current_deals from anon, authenticated;

grant all on table public.retailers to service_role;
grant all on table public.stores to service_role;
grant all on table public.retailer_products to service_role;
grant all on table public.collection_runs to service_role;
grant all on table public.current_offers to service_role;
grant all on table public.offer_history to service_role;
grant select on table public.current_deals to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on function public.claim_collection_run(text, text, jsonb) to service_role;
grant execute on function public.finalize_collection_run(bigint, integer) to service_role;

commit;
