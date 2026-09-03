/**
 * Scrape a list of URLs across every browser your plan allows.
 *
 * The SDK hands out live browsers and stops them; the loop, the deadlines and the
 * browser rotation are yours (`client.map` is this loop, packaged).
 *
 *     export SURFSKY_API_TOKEN=... SURFSKY_API_BASE_URL=...
 *     bun run examples/parallel_urls.ts
 */

import type { Browser } from "surfsky";
import { Surfsky } from "surfsky";

const URLS = [
  "https://google.com",
  "https://bing.com",
  "https://amazon.com",
  "https://surfsky.io",
];

async function scrape(browser: Browser, url: string): Promise<string> {
  await browser.goto(url, { waitUntil: "domcontentloaded" }); // its own 30s deadline
  const title = await browser.title();
  if (browser.useCount >= 20) browser.retire(); // a fresh browser every 20 leases
  return title;
}

await using client = new Surfsky();
await using browsers = await client.browsers(); // concurrency: "auto", the plan's cap
const urls = URLS[Symbol.iterator]();

async function worker(): Promise<void> {
  for (let next = urls.next(); !next.done; next = urls.next()) {
    const url = next.value;
    try {
      const title = await browsers.lease((browser) => scrape(browser, url));
      console.log(`${url} -> ${title}`);
    } catch (err) {
      console.log(`FAILED ${url}: ${String(err)}`);
    }
  }
}

await Promise.all(Array.from({ length: browsers.capacity }, worker));
