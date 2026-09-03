/**
 * Open Chrome DevTools on a running cloud browser.
 *
 * Paste the printed URL into Chrome and you get the real DevTools. Use it for
 * your own page logic only: the DevTools front-end enables Runtime, Console and
 * Overlay on the target, all of which page script can see, so it is the wrong
 * tool for chasing a detection problem. The session bills until this exits.
 *
 *     export SURFSKY_API_TOKEN=... SURFSKY_API_BASE_URL=...
 *     bun run examples/devtools.ts
 */

import { Surfsky } from "surfsky";

const ATTACH_MS = 20_000;
const WATCH_MS = 60_000;

await using client = new Surfsky();
await using browser = await client.browser();
const inspector = browser.session.inspector;
if (!inspector?.pages?.length) throw new Error("no inspector in the start response");

console.log("devtools :", inspector.pages[0]?.devtools_url);
console.log("page list:", inspector.list);

// navigate only once someone can be attached, or the panels open empty
console.log(`attach now, navigating in ${ATTACH_MS / 1000}s`);
await new Promise((resolve) => setTimeout(resolve, ATTACH_MS));
await browser.goto("https://example.com", { waitUntil: "domcontentloaded" });

console.log(`holding the session for ${WATCH_MS / 1000}s`);
await new Promise((resolve) => setTimeout(resolve, WATCH_MS));
