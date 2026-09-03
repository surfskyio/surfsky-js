/**
 * Follow a `target="_blank"` link into the window it opens.
 *
 *     export SURFSKY_API_TOKEN=... SURFSKY_API_BASE_URL=...
 *     bun run examples/popup.ts
 */

import { Surfsky } from "surfsky";

await using client = new Surfsky();
await using browser = await client.browser();
await browser.goto("https://the-internet.herokuapp.com/windows", {
  waitUntil: "domcontentloaded",
});
const popup = await browser.waitForPage(browser.click('a[href="/windows/new"]'));
await popup.waitForSelector("h3");
console.log("opened :", await popup.url());
console.log("heading:", await popup.outerHtml("h3"));

await popup.close();
console.log("back on:", await browser.url());
console.log("pages  :", browser.pages.length);
