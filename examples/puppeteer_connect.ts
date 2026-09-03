/**
 * Drive the session with Puppeteer over its CDP endpoint.
 *
 * Use a patched Puppeteer build that skips Runtime.enable; stock Puppeteer
 * leaves traces a site can read.
 *
 *     bun add -d puppeteer-core
 *     export SURFSKY_API_TOKEN=... SURFSKY_API_BASE_URL=...
 *     bun run examples/puppeteer_connect.ts
 */

import puppeteer from "puppeteer-core";
import { Surfsky } from "surfsky";

await using client = new Surfsky();
await using session = await client.session();
const browser = await puppeteer.connect({ browserWSEndpoint: session.ws_url });
try {
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  const response = await page.goto("https://google.com");
  console.log("status:", response?.status());
  console.log("title :", await page.title());
} finally {
  await browser.disconnect();
}
