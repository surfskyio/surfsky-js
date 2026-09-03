/**
 * Run the session with Playwright over its CDP endpoint.
 *
 *     bun add -d playwright-core
 *     bun run build   # node resolves `surfsky` through the package exports
 *     export SURFSKY_API_TOKEN=... SURFSKY_API_BASE_URL=...
 *     node examples/playwright_connect.ts
 */

import { chromium } from "playwright-core";
import { Surfsky } from "surfsky";

await using client = new Surfsky();
await using session = await client.session();
const browser = await chromium.connectOverCDP(session.ws_url);
try {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  const response = await page.goto("https://google.com");
  console.log("status:", response?.status());
  console.log("title :", await page.title());
} finally {
  await browser.close();
}
