/**
 * Search DuckDuckGo on every browser your plan allows and read the results.
 *
 * One query per browser.
 *
 *     export SURFSKY_API_TOKEN=... SURFSKY_API_BASE_URL=...
 *     bun run examples/duckduckgo.ts
 */

import type { Browser } from "surfsky";
import { Surfsky } from "surfsky";

const QUERIES = ["surfsky", "cloud browser", "headless browser"];

interface Result {
  title: string;
  url: string;
}

async function search(browser: Browser, query: string): Promise<Result[]> {
  const tag = `[${browser.internalUuid.slice(0, 8)}] ${query}`;
  console.log(`${tag}: opening duckduckgo`);
  await browser.goto("https://duckduckgo.com", {
    waitUntil: "domcontentloaded",
  });
  console.log(`${tag}: searching`);
  await browser.type('[name="q"]', query);
  await browser.keyboard.press("Enter");
  console.log(`${tag}: waiting for results`);
  await browser.waitForSelector('[data-testid="result-title-a"]', {
    timeout: 30_000,
  });
  const results: Result[] = await browser.evaluate(`
    [...document.querySelectorAll('[data-testid="result-title-a"]')]
      .slice(0, 5)
      .map(a => ({title: a.innerText, url: a.href}))
  `);
  console.log(`${tag}: ${results.length} results`);
  return results;
}

await using client = new Surfsky();
const outcomes = await client.map(search, QUERIES);

for (const outcome of outcomes) {
  console.log(`\n${outcome.item}`);
  if (!outcome.ok) {
    console.log(`  FAILED: ${String(outcome.error)}`);
    continue;
  }
  for (const hit of outcome.value) console.log(`  ${hit.title}\n    ${hit.url}`);
}
