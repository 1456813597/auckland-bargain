# Auckland Bargain MVP

A runnable grocery price-intelligence MVP for Auckland. It separates retailer products, stores, current offers and change-only price history, while the UI demonstrates search, category and retailer filters, member-price handling, deal scoring and a 90-day price trail.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Included

- Interactive deal dashboard with realistic demonstration data
- Search, retailer/category filters and deal sorting
- Product price-history dialog and deal score explanation
- Read-only JSON endpoints at `/api/deals` and `/api/products/:id`
- Cloudflare D1 schema and generated migration for retailers, stores, canonical products, retailer products, current offers, change-only history and collection runs
- A typed retailer collector contract plus a demo collector

The displayed prices are explicitly labelled as demonstration data. Connecting live retailer collectors should be treated as a separate phase with rate limits and a terms-of-service review.
