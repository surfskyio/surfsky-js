/**
 * Scrape page titles and HTML across all your Surfsky browsers.
 *
 * Both settings come from the environment, or from
 * `new Surfsky({ apiToken, baseUrl })`.
 *
 *     export SURFSKY_API_TOKEN=... SURFSKY_API_BASE_URL=...
 *     bun run examples/basic_scrape.ts
 */

import type { Browser } from "surfsky";
import { Surfsky } from "surfsky";

const URLS = ["https://example.com", "https://surfsky.io"];

async function scrape(browser: Browser, url: string): Promise<[string, string]> {
  await browser.goto(url, { waitUntil: "domcontentloaded" });
  return [await browser.title(), await browser.content()];
}

await using client = new Surfsky();
const outcomes = await client.map(scrape, URLS); // concurrency: "auto"

for (const outcome of outcomes) {
  if (!outcome.ok) {
    console.log(`FAILED ${outcome.item}: ${String(outcome.error)}`);
    continue;
  }
  const [title, html] = outcome.value;
  console.log(`\n${outcome.item} -> ${title}`);
  console.log(`${html.slice(0, 200)}...`);
}

// The same list through `pool.lease()` instead of `map`:
//
//     await using pool = await client.browsers();
//     for (const url of URLS) {
//       await pool.lease(async (browser) => {
//         await browser.goto(url);
//       });
//     }
