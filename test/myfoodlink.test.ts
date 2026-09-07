/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FreshChoiceCollector,
  parseMyFoodLinkPage,
} from '../lib/collectors/myfoodlink';

function fixture({
  name,
  itemId,
  lineId,
  price,
  regularPrice,
  page,
  totalItems = 2,
  totalPages = 2,
}: {
  name: string;
  itemId: string;
  lineId: string;
  price: string;
  regularPrice: string;
  page: number;
  totalItems?: number;
  totalPages?: number;
}) {
  return `
    <script>
      window.cmsDataLayer = window.cmsDataLayer || [{"mfl_shop_update":{"shop":{"id":"epsom-id","name":"FreshChoice Epsom","url":"https://epsom.test/"}}}];
    </script>
    <script>
      window.gtmDataLayer = [{"ecommerce":{"items":[{"item_name":${JSON.stringify(name)},"item_id":"${itemId}","item_brand":"Maggi","item_category":"Groceries","item_category2":"Pantry","item_category3":"Noodles"}]}}];
    </script>
    <div data-sidebar-facet-url="https://epsom.test/facets.json?q%5B%5D=special%3A1"></div>
    <strong>Refine</strong><span>${String(totalItems)} results</span>
    <span class="CatalogueEdition__DateTo">Sunday, Sep 6</span>
    <a aria-label="Page 1" href="/specials?page=1">1</a>
    <a aria-label="Page ${String(totalPages)}" href="/specials?page=${String(totalPages)}">${String(totalPages)}</a>
    <div class="TalkerGrid__Item" role="listitem">
      <div class="talker" id="line_${lineId}">
        <a href="/lines/${itemId}"><figure>
          <img alt="Photo of ${name}" src="https://images.test/${itemId}.png" />
        </figure></a>
        <span class="talker__product-name">${name}</span>
        <span class="talker__prices__was weak">was $${regularPrice}</span>
        <strong class="price__sell">$${price}</strong>
        <span>Page ${String(page)}</span>
      </div>
    </div>`;
}

describe('MyFoodLinkCollector', () => {
  it('uses the full title when the visible name omits the selling quantity', () => {
    const html = fixture({
      name: 'Maggi Noodles Chicken 500g',
      itemId: 'noodles',
      lineId: 'noodles-line',
      price: '3.40',
      regularPrice: '4.70',
      page: 1,
    }).replace(
      '<span class="talker__product-name">Maggi Noodles Chicken 500g</span>',
      '<div class="talker__name talker__section" title="Maggi Noodles Chicken 500g"><span class="talker__product-name">Maggi Noodles Chicken</span></div>',
    );
    const parsed = parseMyFoodLinkPage(html, {
      origin: 'https://epsom.test',
      retailerName: 'FreshChoice',
      collectedAt: new Date('2026-09-06T00:00:00Z'),
    });
    assert.equal(parsed.offers[0].sourceName, 'Maggi Noodles Chicken 500g');
    assert.equal(parsed.offers[0].brand, 'Maggi');
    assert.equal(parsed.offers[0].size, '500g');
    assert.equal(parsed.offers[0].category, 'Noodles');
  });

  it('parses product identity, prices, image and store metadata', () => {
    const parsed = parseMyFoodLinkPage(
      fixture({
        name: "Wattie's Baked Beans Regular 420g",
        itemId: 'beans-id',
        lineId: 'line-id',
        price: '1.99',
        regularPrice: '3.50',
        page: 1,
      }),
      {
        origin: 'https://epsom.test',
        retailerName: 'FreshChoice',
        collectedAt: new Date('2026-09-05T00:00:00Z'),
      },
    );

    assert.deepEqual(parsed.store, {
      id: 'epsom-id',
      name: 'FreshChoice Epsom',
    });
    assert.equal(parsed.totalItems, 2);
    assert.equal(parsed.totalPages, 2);
    assert.equal(parsed.offers[0]?.sourceProductId, 'line-id');
    assert.equal(parsed.offers[0]?.brand, 'Maggi');
    assert.equal(parsed.offers[0]?.category, 'Noodles');
    assert.equal(parsed.offers[0]?.size, '420g');
    assert.equal(parsed.offers[0]?.regularPriceCents, 350);
    assert.equal(parsed.offers[0]?.promoPriceCents, 199);
    assert.equal(
      parsed.offers[0]?.sourceUrl,
      'https://epsom.test/lines/beans-id',
    );
  });

  it('collects every reported page without rejecting a complete run', async () => {
    const pages = new Map([
      [
        1,
        fixture({
          name: 'Maggi Noodles Chicken 5 Pack',
          itemId: 'noodles-1',
          lineId: 'line-1',
          price: '3.40',
          regularPrice: '4.70',
          page: 1,
        }),
      ],
      [
        2,
        fixture({
          name: 'Maggi Noodles Beef 5 Pack',
          itemId: 'noodles-2',
          lineId: 'line-2',
          price: '3.50',
          regularPrice: '4.80',
          page: 2,
        }),
      ],
    ]);
    const visited: number[] = [];
    const transport: typeof fetch = async (input) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input
            : input.url,
      );
      const page = Number(url.searchParams.get('page') ?? '1');
      visited.push(page);
      return new Response(pages.get(page), {
        status: pages.has(page) ? 200 : 404,
        headers: { 'content-type': 'text/html' },
      });
    };
    const collector = new FreshChoiceCollector({
      storeOrigin: 'https://epsom.test',
      fetch: transport,
      pageDelayMs: 0,
      sleep: async () => undefined,
    });

    const [store] = await collector.getStores();
    const result = await collector.collectSpecials(store);

    assert.deepEqual(visited, [1, 2]);
    assert.equal(result.offers.length, 2);
    assert.equal(result.pagesCollected, 2);
    assert.equal(result.totalItemsReported, 2);
  });

  it('partitions result sets that cross the upstream 50-page cap', async () => {
    const global = fixture({
      name: 'Global preview item',
      itemId: 'global-preview',
      lineId: 'global-line',
      price: '2.00',
      regularPrice: '3.00',
      page: 1,
      totalItems: 2,
      totalPages: 51,
    });
    const category = (name: string, id: string) =>
      fixture({
        name,
        itemId: id,
        lineId: `${id}-line`,
        price: '2.00',
        regularPrice: '3.00',
        page: 1,
        totalItems: 1,
        totalPages: 1,
      });
    const transport: typeof fetch = async (input) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input
            : input.url,
      );
      if (url.pathname === '/facets.json') {
        return Response.json({
          more_sections: [
            {
              group: 'categories',
              facets: [
                { url: '/search?q%5B%5D=special%3A1&q%5B%5D=category%3Aa' },
                { url: '/search?q%5B%5D=special%3A1&q%5B%5D=category%3Ab' },
              ],
            },
          ],
        });
      }
      const filters = url.searchParams.getAll('q[]');
      if (filters.includes('category:a')) {
        return new Response(category('Category A item', 'a'));
      }
      if (filters.includes('category:b')) {
        return new Response(category('Category B item', 'b'));
      }
      return new Response(global);
    };
    const collector = new FreshChoiceCollector({
      storeOrigin: 'https://epsom.test',
      fetch: transport,
      pageDelayMs: 0,
      sleep: async () => undefined,
    });

    const [store] = await collector.getStores();
    const result = await collector.collectSpecials(store);

    assert.equal(result.offers.length, 2);
    assert.equal(result.pagesCollected, 3);
    assert.deepEqual(result.offers.map((offer) => offer.sourceName).sort(), [
      'Category A item',
      'Category B item',
    ]);
  });
});
