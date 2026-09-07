# Source access review — 2026-09-06

This is an engineering record of published restrictions, not a legal opinion or
a grant of permission. Before public launch, obtain an appropriate data/feed
agreement or have the intended collection and republication reviewed. Store
prices, product descriptions, branding and images may require different treatment.

- [Woolworths website terms](https://www.woolworths.co.nz/help/terms-conditions/online-shopping-website-app),
  section on use of the site, permits personal-use downloads but requires prior
  written consent for other scraping/copying/republication. The
  [robots file](https://www.woolworths.co.nz/robots.txt) excludes shopping search,
  checkout, accounts and lists. A public endpoint is not a redistribution licence.
- [FreshChoice Epsom online terms](https://epsom.store.freshchoice.co.nz/terms_and_conditions),
  section 1.13, distinguishes personal-use downloads from reproduction or
  distribution requiring written consent. The
  [store robots file](https://epsom.store.freshchoice.co.nz/robots.txt) disallows
  search and several filtered query URLs. The new catalogue implementation uses
  ordinary department URLs and the published navigation resource; this does not
  remove the separate permission question.
- [PAK'nSAVE website terms](https://www.paknsave.co.nz/terms-and-conditions)
  identify intellectual-property protections for site content and require express
  permission for uses that infringe those rights. Its
  [robots file](https://www.paknsave.co.nz/robots.txt) excludes search paths.
  No commercial data licence has been verified for the guest API.
- SuperValue, New World and Four Square still require a source-specific access
  and reuse decision. Shared technical infrastructure does not prove that another
  banner has granted the same permissions.

## What was and was not done in this continuation

Read-only probes checked published terms, robots files, storefront navigation
and a small number of catalogue pages. FreshChoice Epsom and SuperValue Milton
each expose 21 top-level departments. Their first checked category pages included
regular-price items, confirming that a specials-only collector misses inventory.

No nationwide crawl, full-store catalogue refresh, publication, agreement
acceptance or permission request was sent on the user's behalf. The full catalogue
implementation has offline pagination/store/completeness tests and limited live
page-schema evidence, not a completed live end-to-end catalogue validation.

## Release prerequisites

Record the authorised source, allowed fields (including images), covered stores,
permitted request rate, reuse/attribution requirements and licence expiry. Use an
authorised feed when direct automated access is restricted. Do not evade rate
limits, authentication, CAPTCHAs or source access controls. A green application
build or database readiness response does not prove these prerequisites.
