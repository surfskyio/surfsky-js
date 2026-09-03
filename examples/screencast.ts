/**
 * Watch a cloud browser live: the screencast stream, view-only.
 *
 * The session bills until this exits, so WATCH_MS is billed time.
 * See https://docs.surfsky.io/screencast for the viewer.
 *
 *     export SURFSKY_API_TOKEN=... SURFSKY_API_BASE_URL=...
 *     bun run examples/screencast.ts
 */

import { Surfsky } from "surfsky";

const WATCH_MS = 60_000;

await using client = new Surfsky();
await using browser = await client.browser();
const stream = browser.session.inspector?.screencast;
if (!stream) throw new Error("no screencast in the start response");

// the stream URL carries its own query, so it has to be encoded
const query = new URLSearchParams({ ws: stream });
console.log(`viewer: https://${new URL(stream).host}/screencast?${query}`);

await browser.goto("https://example.com");
console.log(`watching for ${WATCH_MS / 1000}s`);
await new Promise((resolve) => setTimeout(resolve, WATCH_MS));
