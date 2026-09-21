/**
 * Click a Turnstile checkbox that lives inside a closed shadow root.
 *
 *     export SURFSKY_API_TOKEN=... SURFSKY_API_BASE_URL=...
 *     bun run examples/shadow_root.ts
 */

import { Surfsky } from "surfsky";

const PAGE = "https://www.scrapingcourse.com/login/cf-turnstile";
const WIDGET = 'iframe[src*="challenges.cloudflare.com"]';
const TOKEN = 'input[name="cf-turnstile-response"]';

await using client = new Surfsky();
await using browser = await client.browser();
console.log("devtools:", browser.session.inspector?.pages?.[0]?.devtools_url);
await browser.goto(PAGE);
await browser.waitForSelector(WIDGET);
await new Promise((resolve) => setTimeout(resolve, 2000));
const box = await browser.boundingBox(WIDGET);
if (!box) throw new Error(`${WIDGET} has no box`);
await browser.mouse.click(box.x + 28, box.y + box.height / 2);
const token: string = await browser.waitForFunction(
  "s => document.querySelector(s).value",
  {
    args: [TOKEN],
    timeout: 30_000,
  },
);
console.log("token:", `${token.slice(0, 24)}...`);
