/**
 * Several pages open in 1 browser, driven in turn.
 *
 *     export SURFSKY_API_TOKEN=... SURFSKY_API_BASE_URL=...
 *     bun run examples/tabs.ts
 */

import type { Page } from "surfsky";
import { Surfsky } from "surfsky";

const URLS = [
  "https://example.com",
  "https://quotes.toscrape.com",
  "https://the-internet.herokuapp.com",
];

await using client = new Surfsky();
await using browser = await client.browser();
const tabs: Page[] = [browser];
for (const _ of URLS.slice(1)) tabs.push(await browser.newPage());
console.log(`opened ${browser.pages.length} pages`);

for (const [i, tab] of tabs.entries()) {
  const url = URLS[i] as string;
  await tab.goto(url, { waitUntil: "domcontentloaded" });
  console.log(`  page ${i} loaded ${url}`);
}

console.log("\neach page keeps its own document:");
for (const [i, tab] of tabs.entries()) {
  console.log(`  page ${i}: ${await tab.title()} - ${await tab.url()}`);
}

console.log("\nreading two of them, in any order, no switching:");
console.log("  page 0 h1   :", await tabs[0]?.innerText("h1"));
console.log("  page 1 quote:", await tabs[1]?.innerText(".quote .text"));

const last = tabs[2] as Page;
await last.bringToFront();
const png = await last.screenshot();
console.log(`\npage 2 brought to the front, screenshot: ${png.length} bytes`);

for (const tab of tabs.slice(1)) await tab.close();
console.log(
  `closed the rest: ${browser.pages.length} page left, on ${await browser.url()}`,
);
