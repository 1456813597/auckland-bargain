begin;

create table public.canonical_products (
  id bigint generated always as identity primary key,
  slug text not null unique,
  display_name text not null,
  normalized_name text not null,
  brand text,
  normalized_brand text,
  category text,
  size text,
  gtin text,
  image_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index canonical_products_brand_idx
  on public.canonical_products (normalized_brand);
create index canonical_products_gtin_idx
  on public.canonical_products (gtin)
  where gtin is not null;

create table public.product_matches (
  id bigint generated always as identity primary key,
  retailer_product_id bigint not null unique
    references public.retailer_products(id) on delete cascade,
  canonical_product_id bigint not null
    references public.canonical_products(id) on delete cascade,
  match_method text not null
    check (match_method in ('gtin', 'attributes', 'seed', 'manual')),
  confidence numeric(5, 4) not null check (confidence between 0 and 1),
  explanation jsonb not null default '{}'::jsonb,
  status text not null default 'accepted'
    check (status in ('accepted', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index product_matches_canonical_idx
  on public.product_matches (canonical_product_id);

create table public.product_match_reviews (
  id bigint generated always as identity primary key,
  retailer_product_id bigint not null
    references public.retailer_products(id) on delete cascade,
  candidate_canonical_product_id bigint not null
    references public.canonical_products(id) on delete cascade,
  score numeric(5, 4) not null check (score between 0 and 1),
  explanation jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (retailer_product_id, candidate_canonical_product_id)
);

create index product_match_reviews_status_idx
  on public.product_match_reviews (status, score desc);

-- Each successful weekly crawl writes one observation, even when the price did
-- not change. The retention step below keeps the current observation and the
-- immediately preceding observation, which is exactly one historical result.
create or replace function public.capture_offer_history()
returns trigger
language plpgsql
set search_path = public
as $$
begin
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

  return new;
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

  -- current_offers is the live snapshot. Keeping two history rows means the UI
  -- can compare it with exactly one prior weekly observation.
  delete from public.offer_history history
   where history.id in (
     select ranked.id
       from (
         select oh.id,
                row_number() over (
                  partition by oh.retailer_product_id, oh.store_id
                  order by oh.observed_at desc, oh.id desc
                ) as position
           from public.offer_history oh
          where oh.store_id = v_store_id
       ) ranked
      where ranked.position > 2
   );

  update public.collection_runs
     set status = 'succeeded',
         offers_seen = p_offers_seen,
         finished_at = now(),
         error_message = null
   where id = p_run_id;
end;
$$;

create or replace view public.current_deals
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
  end as advertised_discount_percent,
  cp.id as canonical_product_id,
  cp.slug as canonical_slug,
  cp.display_name as canonical_name,
  cp.brand as canonical_brand,
  cp.size as canonical_size,
  cp.category as canonical_category,
  pm.confidence::double precision as match_confidence,
  pm.match_method
from public.current_offers co
join public.retailer_products rp on rp.id = co.retailer_product_id
join public.retailers r on r.id = rp.retailer_id
join public.stores s on s.id = co.store_id
left join public.product_matches pm
  on pm.retailer_product_id = rp.id
 and pm.status = 'accepted'
left join public.canonical_products cp on cp.id = pm.canonical_product_id
where co.active = true;

alter table public.canonical_products enable row level security;
alter table public.product_matches enable row level security;
alter table public.product_match_reviews enable row level security;

revoke all on table public.canonical_products from anon, authenticated;
revoke all on table public.product_matches from anon, authenticated;
revoke all on table public.product_match_reviews from anon, authenticated;
grant all on table public.canonical_products to service_role;
grant all on table public.product_matches to service_role;
grant all on table public.product_match_reviews to service_role;
grant usage, select on all sequences in schema public to service_role;

create or replace function public.database_readiness()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select jsonb_build_object(
    'schemaVersion', '20260905120000',
    'currentDeals', to_regclass('public.current_deals') is not null,
    'canonicalProducts', to_regclass('public.canonical_products') is not null,
    'productMatches', to_regclass('public.product_matches') is not null,
    'claimCollectionRun',
      to_regprocedure('public.claim_collection_run(text,text,jsonb)') is not null,
    'ready',
      to_regclass('public.current_deals') is not null
      and to_regclass('public.canonical_products') is not null
      and to_regclass('public.product_matches') is not null
      and to_regprocedure('public.claim_collection_run(text,text,jsonb)') is not null
  );
$$;

revoke all on function public.database_readiness() from public, anon, authenticated;
grant execute on function public.database_readiness() to service_role;

commit;
