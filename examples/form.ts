/**
 * A list of queries through a site's search form, on every browser you have.
 *
 * Shows how to work a form: type, submit, wait for the page it loads, read the result.
 *
 *     export SURFSKY_API_TOKEN=... SURFSKY_API_BASE_URL=...
 *     bun run examples/form.ts
 */

import type { Browser } from "surfsky";
import { Surfsky } from "surfsky";

const URL = "https://www.scrapethissite.com/pages/forms/";
const QUERIES = ["Boston", "New York", "Detroit", "Chicago"];
const ROWS = `
  [...document.querySelectorAll("tr.team")].map(tr => ({
    name: tr.querySelector("td.name").innerText.trim(),
    year: tr.querySelector("td.year").innerText.trim(),
    wins: tr.querySelector("td.wins").innerText.trim(),
    losses: tr.querySelector("td.losses").innerText.trim(),
  }))
`;

interface Row {
  name: string;
  year: string;
  wins: string;
  losses: string;
}

async function seasons(browser: Browser, query: string): Promise<Row[]> {
  await browser.goto(URL, { waitUntil: "domcontentloaded" });
  // the form: type into its field, click its button, wait for the page it loads
  await browser.type("#q", query);
  await browser.click("input[type=submit]");
  await browser.waitForUrl("q=");
  await browser.waitForLoadState();
  // a dropdown whose change handler reloads the page: pick, then wait again
  await browser.selectOption("#per_page", "100");
  await browser.waitForUrl("per_page=100");
  await browser.waitForLoadState();
  return browser.evaluate(ROWS);
}

await using client = new Surfsky();
const outcomes = await client.map(seasons, QUERIES, {
  blockResources: ["image", "font"],
});

for (const outcome of outcomes) {
  const rows = outcome.ok ? outcome.value : [];
  if (rows.length === 0) {
    console.log(
      outcome.ok
        ? `${outcome.item}: no rows`
        : `${outcome.item}: ${String(outcome.error)}`,
    );
    continue;
  }
  const teams = [...new Set(rows.map((row) => row.name))].sort().join(", ");
  const best = rows.reduce((a, b) => (Number(b.wins) > Number(a.wins) ? b : a));
  console.log(`${outcome.item}: ${rows.length} seasons (${teams})`);
  console.log(`  best: ${best.name} ${best.year}, ${best.wins}-${best.losses}`);
}
