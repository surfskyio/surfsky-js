/**
 * Log in once per browser, then reuse it for many pages.
 *
 *     export SURFSKY_API_TOKEN=... SURFSKY_API_BASE_URL=...
 *     bun run examples/login.ts
 */

import type { Browser } from "surfsky";
import { Surfsky } from "surfsky";

async function logIn(browser: Browser): Promise<void> {
  if (browser.data.loggedIn) return;
  await browser.goto("https://the-internet.herokuapp.com/login", {
    waitUntil: "domcontentloaded",
  });
  await browser.type("#username", "tomsmith");
  await browser.type("#password", "SuperSecretPassword!");
  await browser.click('button[type="submit"]');
  await browser.waitForUrl("/secure", { timeout: 15_000 });
  browser.data.loggedIn = true;
}

async function job(browser: Browser, n: number): Promise<string> {
  await logIn(browser);
  await browser.goto("https://the-internet.herokuapp.com/secure", {
    waitUntil: "domcontentloaded",
  });
  const state = (await browser.url()).endsWith("/secure") ? "login ok" : "login failed";
  if (browser.useCount >= 3) browser.retire(); // the next lease gets a fresh browser
  return `job ${n} on ${browser.internalUuid.slice(0, 8)} lease ${browser.useCount}: ${state}`;
}

await using client = new Surfsky();
const outcomes = await client.map(job, [0, 1, 2, 3, 4, 5], { concurrency: 2 });
for (const outcome of outcomes) {
  console.log(outcome.ok ? outcome.value : `FAILED: ${String(outcome.error)}`);
}
