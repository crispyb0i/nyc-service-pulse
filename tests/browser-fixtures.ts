import { test as base, type Route } from "@playwright/test";

export const STREET_TILE_PATTERN = "https://tile.openstreetmap.org/**";

export function fulfillStreetTile(route: Route) {
  // UI regressions exercise loading without repeatedly downloading public tiles.
  return route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#edf0e8"/><path d="M0 128H256M128 0V256" stroke="white" stroke-width="12"/><text x="12" y="24" fill="#677365" font-size="12">Test basemap</text></svg>',
  });
}

export const test = base.extend({
  page: async ({ page }, providePage) => {
    await page.route(STREET_TILE_PATTERN, fulfillStreetTile);
    await providePage(page);
  },
});
