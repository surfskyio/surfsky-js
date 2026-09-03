/**
 * Retry a failed item, taking a fresh browser only when the browser is at fault.
 *
 *     export SURFSKY_API_TOKEN=... SURFSKY_API_BASE_URL=...
 *     bun run examples/retry.ts
 */

import type { Browser, PoolOutcome } from "surfsky";
import { BrowserTimeoutError, Surfsky } from "surfsky";

const URLS = ["https://example.com", "https://surfsky.io", "https://httpstat.us/503"];
const ATTEMPTS = 3;
// errors worth another attempt at all
const RETRY_ERRORS = /blocked|captcha|HTTP 5\d\d/i;
const RETIRE_ERRORS = /blocked|captcha/i;

async function scrape(browser: Browser, url: string): Promise<string> {
  await browser.goto(url, { waitUntil: "domcontentloaded" });
  if (browser.status !== undefined && browser.status >= 500) {
    throw new Error(`HTTP ${browser.status}`); // the site is down, not our browser
  }
  return browser.title();
}

function shouldRetry(err: unknown): boolean {
  return err instanceof BrowserTimeoutError || RETRY_ERRORS.test(String(err));
}

function shouldRetire(err: unknown): boolean {
  return err instanceof BrowserTimeoutError || RETIRE_ERRORS.test(String(err));
}

await using client = new Surfsky();
await using pool = await client.browsers();

async function withRetry(url: string): Promise<PoolOutcome<string, string>> {
  for (let attempt = 1; ; attempt++) {
    try {
      const value = await pool.lease(async (browser) => {
        try {
          return await scrape(browser, url);
        } catch (err) {
          if (shouldRetire(err)) browser.retire(); // the next lease pays for a fresh browser
          throw err;
        }
      });
      return { ok: true, item: url, index: 0, value };
    } catch (err) {
      if (attempt >= ATTEMPTS || !shouldRetry(err)) {
        return { ok: false, item: url, index: 0, error: err };
      }
      console.log(`${url}: attempt ${attempt} failed (${String(err)}), retrying`);
      // outside the lease: hold no browser while waiting
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
}

const outcomes = await Promise.all(URLS.map(withRetry));
for (const o of outcomes)
  console.log(o.item, o.ok ? o.value : `FAILED: ${String(o.error)}`);
