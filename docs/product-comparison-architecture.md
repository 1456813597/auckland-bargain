# Product comparison architecture

## Experience benchmark

The product flow takes four durable ideas from PriceSpy: a search-first entry,
one page per comparable product, offers ordered by payable price, and visible
price history. Grocery data needs two extra trust layers: store context and an
explainable product-identity decision.

```text
Search or category
        |
        v
Canonical result list -- filter by retailer / matched products / sort mode
        |
        v
Product comparison -- lowest offer / all stores / weekly delta / match reason
        |
        v
Retailer source page
```

## Automated data flow

```text
Weekly scheduler container
        |
        +-- Woolworths collector
        |
        +-- five individually scheduled banner jobs
             PAK'nSAVE / New World / Four Square
                       / FreshChoice / SuperValue
                        |
                        v
             normalize retailer products
                        |
                        v
           resolve canonical product identity
          /              |                 \
 exact GTIN       score >= 0.86       0.72 <= score < 0.86
 auto-match        auto-match             review queue
          \              |                 /
                        v
              stage complete store offers
                        |
                        v
        atomic publish + retain two distinct NZ weeks
```

Collection runs use a database lease. A retailer/store snapshot is staged only
after every expected page succeeds. A transactional RPC verifies the staged
count, publishes the entire snapshot, deactivates missing offers and records
history together. Failed or expired workers cannot publish; repeating a
successful finalization has no effect.

MyFoodLink full-catalogue collection follows the published department tree,
recursing into child categories when a department exceeds the 50-page source
limit. Each visited category must match its advertised unique product count,
and parent preview IDs must survive partitioning; overlapping departments are
deduplicated. The "all" node is virtual, not a requestable category. Regular
prices are retained without inventing a promotion; identified unpriced items
are counted separately. The legacy specials path uses separate facet-based
partitioning and is never a fallback for a failed full catalogue.

Four Square establishes the site's session cookies before selecting a store
so a cached default location cannot be mistaken for the requested one.
Woolworths refuses changed totals, missing SKUs and duplicate-page gaps before
publication, and reports identified products without usable prices separately.

## Matching model

Each retailer product keeps its original name. `canonical_products` supplies
the comparison identity and `product_matches` stores the relationship plus the
decision evidence.

| Signal          | Weight | Rule                                                                              |
| --------------- | -----: | --------------------------------------------------------------------------------- |
| Brand           |    28% | Exact normalized brand is strongest; a weak brand is a hard stop.                 |
| Product wording |    42% | Jaccard token overlap plus character bigrams handles reordered names.             |
| Pack size       |    22% | Normalizes kg/g and l/ml, including multipacks; incompatible totals stop a merge. |
| Category        |     8% | Supporting evidence, not enough to create a match by itself.                      |
| GTIN            |  Exact | Equal values override the weighted model; conflicting values reject.              |

Protected variant groups stop dangerous false positives, including
salted/unsalted, decaf/caffeinated, milk-fat variants, liquid/powder, common
flavours, and regular/diet/zero. The tests include reordered names, unit
normalization, variant conflicts and GTIN decisions.

Numeric identity attributes (egg grades, formula stages, hair shades and SPF)
are preserved separately from selling quantities. Dedicated pack size takes
priority over wearer-weight ranges in nappy names. Differing quantities are
not treated as equivalent just because they are within 5%; unknown quantities
cannot auto-match without barcode evidence. Local groups require every member
to agree, and a retailer run cannot reuse a canonical match for another SKU.

Candidate reads use keyset pagination, including when the API's configured
row cap is below the requested page size. New canonical products use bounded,
retry-safe insert batches and accepted matches are also written in batches.

Product identity and quote identity are separate. A source SKU is scoped to a
retailer; a quote ID also includes the physical store. Local matching can group
the same source SKU across stores, and equivalent different source IDs from
different stores must still pass the attribute checks. Different SKUs from the
same store cannot collapse into one automatic group. Repeated observations of
one store/SKU keep only the latest quote. Local snapshot publication replaces
only refreshed stores, preserving other stores of the same banner and their
independent histories. The product API retains legacy retailer/SKU aliases.

Candidate generation is indexed before scoring. GTIN, normalized brand,
normalized measure and up to three distinctive title tokens form blocking
keys in both the local fallback and Supabase paths. This keeps missing-brand
products discoverable without comparing every new offer with every canonical
product; the weighted score and hard conflicts still make the final decision.

## Retention interpretation

The live price belongs in `current_offers`. After each successful weekly crawl,
the observation is upserted into `offer_history` by product, store and New Zealand
calendar week. Pruning keeps only the two newest distinct weeks. A manual rerun
in the current week cannot displace the prior week. Bookkeeping updates do not
create observations; an unchanged price collected the next week does.

## Coverage expansion

Coverage is adapter-based. Adding another banner requires a collector that
emits the shared `CompleteCollection` / `RawOffer` contract, a retailer identity, a scheduled
run, fixtures for pagination/store validation, and a source-terms review. Store
coverage is a separate dimension: execute a banner collector for every enabled
store ID and let the existing `(product, store)` keys preserve local prices.

The [local store registry and batch runner](store-registry.md) now model that
dimension explicitly. Weekly plans distinguish due/current/disabled/blocked
stores, recheck source access at execution, validate physical identity and
checkpoint successful stores independently. Existing cron routes remain
single-store jobs; the registry is not yet wired to a durable production queue.
PAK'nSAVE/New World/Four Square have directory methods, but the tracked registry
still contains only the six previously sampled stores with permission pending.

| Banner      | Default locality | Source shape                        |
| ----------- | ---------------- | ----------------------------------- |
| Woolworths  | Auckland         | paginated public specials API       |
| PAK'nSAVE   | Royal Oak        | Foodstuffs guest search API         |
| New World   | Metro Queen St   | Foodstuffs guest search API         |
| Four Square | Lancaster        | Next Flight data + 213-store index  |
| FreshChoice | Epsom            | MyFoodLink HTML + department facets |
| SuperValue  | Milton           | MyFoodLink HTML + department facets |

The UI should only show retailers observed for the selected product and store
context. Missing coverage is unknown, never a claim that an offer does not
exist.
