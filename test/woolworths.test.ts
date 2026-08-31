/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  WoolworthsCollector,
  toWoolworthsOffer,
} from "../lib/collectors/woolworths";

const collectedAt = new Date("2026-08-30T10:00:00.000Z");

function requestUrl(input: Parameters<typeof fetch>[0]) {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

describe("toWoolworthsOffer", () => {
  it("maps a public special into integer NZ cents", () => {
    const offer = toWoolworthsOffer(
      {
        type: "Product",
        sku: "73034",
        name: "woolworths nz chicken breast",
        brand: "woolworths nz",
        barcode: "9400597055734",
        slug: "woolworths-nz-chicken-breast",
        price: {
          originalPrice: 15.4,
          salePrice: 12.99,
          savePrice: 2.41,
          isSpecial: true,
        },
        images: { big: "https://assets.woolworths.com.au/product.jpg" },
        size: { volumeSize: "min order 1kg" },
        productTag: { tagType: "IsSpecial" },
        departments: [{ name: "Meat & Poultry" }],
      },
      collectedAt,
    );

    assert.ok(offer);
    assert.equal(offer.sourceProductId, "73034");
    assert.equal(offer.regularPriceCents, 1540);
    assert.equal(offer.promoPriceCents, 1299);
    assert.equal(offer.memberPriceCents, null);
    assert.equal(offer.promotionType, "SPECIAL");
    assert.equal(offer.promotionText, "Save $2.41");
    assert.equal(offer.category, "Meat & Poultry");
  });

  it("keeps member pricing separate from public promo pricing", () => {
    const offer = toWoolworthsOffer(
      {
        sku: "123",
        name: "member product",
        price: {
          originalPrice: 5,
          salePrice: 4,
          isClubPrice: true,
        },
      },
      collectedAt,
    );

    assert.ok(offer);
    assert.equal(offer.regularPriceCents, 500);
    assert.equal(offer.promoPriceCents, null);
    assert.equal(offer.memberPriceCents, 400);
    assert.equal(offer.promotionType, "MEMBER_PRICE");
  });

  it("rejects products without an SKU or usable price", () => {
    assert.equal(
      toWoolworthsOffer({ name: "missing sku" }, collectedAt),
      null,
    );
    assert.equal(
      toWoolworthsOffer({ sku: "123", name: "missing price" }, collectedAt),
      null,
    );
  });
});

describe("WoolworthsCollector", () => {
  it("paginates, deduplicates products, and preserves one store context", async () => {
    const requestedPages: number[] = [];
    const transport: typeof fetch = async (input) => {
      const url = requestUrl(input);
      const page = Number(url.searchParams.get("page"));
      requestedPages.push(page);
      return Response.json({
        isSuccessful: true,
        products: {
          totalItems: 2,
          items: [
            {
              type: "Product",
              sku: String(page),
              name: `product ${page}`,
              price: { originalPrice: page + 1, isSpecial: true },
            },
          ],
        },
        context: {
          fulfilment: {
            fulfilmentStoreId: 9171,
            address: "Glenfield",
          },
        },
      });
    };

    const collector = new WoolworthsCollector({
      fetch: transport,
      pageSize: 1,
      maxPages: 3,
      pageDelayMs: 0,
      sleep: async () => undefined,
    });
    const collection = await collector.collectSpecials();

    assert.deepEqual(requestedPages, [1, 2]);
    assert.equal(collection.store.sourceStoreId, "9171");
    assert.equal(collection.store.name, "Woolworths Glenfield");
    assert.equal(collection.offers.length, 2);
    assert.equal(collection.pagesCollected, 2);
  });

  it("retries transient upstream failures", async () => {
    let calls = 0;
    const transport: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response(null, { status: 503 });
      return Response.json({
        isSuccessful: true,
        products: {
          totalItems: 1,
          items: [
            {
              type: "Product",
              sku: "1",
              name: "product",
              price: { originalPrice: 2, isSpecial: true },
            },
          ],
        },
        context: {
          fulfilment: {
            fulfilmentStoreId: 9171,
            address: "Glenfield",
          },
        },
      });
    };

    const collector = new WoolworthsCollector({
      fetch: transport,
      retries: 1,
      sleep: async () => undefined,
    });
    const result = await collector.collectSpecials();

    assert.equal(calls, 2);
    assert.equal(result.offers.length, 1);
  });

  it("aborts if the fulfilment store changes between pages", async () => {
    const transport: typeof fetch = async (input) => {
      const page = Number(requestUrl(input).searchParams.get("page"));
      return Response.json({
        isSuccessful: true,
        products: {
          totalItems: 2,
          items: [
            {
              type: "Product",
              sku: String(page),
              name: "product",
              price: { originalPrice: 2, isSpecial: true },
            },
          ],
        },
        context: {
          fulfilment: {
            fulfilmentStoreId: page === 1 ? 9171 : 9999,
            address: "Test",
          },
        },
      });
    };

    const collector = new WoolworthsCollector({
      fetch: transport,
      pageSize: 1,
      pageDelayMs: 0,
      sleep: async () => undefined,
    });

    await assert.rejects(
      collector.collectSpecials(),
      /fulfilment store changed/,
    );
  });
});
