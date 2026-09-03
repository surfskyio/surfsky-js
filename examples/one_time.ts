/**
 * A one-time session: a browser that exists for this run and no longer.
 *
 * Nothing is stored server-side - the profile is gone when the session ends.
 *
 *     export SURFSKY_API_TOKEN=... SURFSKY_API_BASE_URL=...
 *     bun run examples/one_time.ts
 */

import { Surfsky } from "surfsky";

await using client = new Surfsky();
await using browser = await client.browser();
await browser.goto("https://example.com", { waitUntil: "domcontentloaded" });
console.log("status :", browser.status);
console.log("title  :", await browser.title());
console.log(await browser.content());
