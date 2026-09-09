# surfsky

TypeScript SDK for [Surfsky](https://surfsky.io), a cloud-based antidetect browser.

## Install

```sh
npm install surfsky
```

Or `bun add surfsky` / `pnpm add surfsky`. ESM only; requires Node 22+ or Bun.

## Quick start

Get your API token and base URL from the [dashboard](https://app.surfsky.io):

```sh
export SURFSKY_API_TOKEN='your-token'
export SURFSKY_API_BASE_URL='your-base-url'
```

```ts
import { Surfsky } from "surfsky";

await using client = new Surfsky();
await using browser = await client.browser({
  proxy: { tier: "premium", country: "us" },
});
await browser.goto("https://example.com");
console.log(await browser.title());
```

`await using` closes the browser and stops its session when the scope ends.
It requires Node 24+ or Bun; compile TypeScript for Node 22, or use
`try/finally` with `await browser.close()`. Sessions are billed until stopped,
including idle time.

You can also pass `apiToken` and `baseUrl` to `new Surfsky()`.
Browser methods are async. SDK timeouts are in milliseconds; cloud input
timing options use the server's units. Input uses Surfsky's
[human emulation](https://docs.surfsky.io/human_emulation).

## Profiles and proxies

A profile preserves its fingerprint, proxy and cookies across sessions:

```ts
const profile = await client.profiles.create({
  title: "account-1",
  fingerprint: { os: "win", os_arch: "x86", os_version: "11" },
  proxy: { tier: "premium", country: "us" },
});
await using saved = await client.browser({ profileUuid: profile.uuid });
await saved.goto("https://example.com/login");
```

Reuse the profile ID for subsequent sessions. `proxy` accepts a premium or
shared configuration, or your own proxy URL. Premium supports residential and
mobile IPs; shared is for testing. `client.proxies` lists locations and quota.

SDK methods and options use camelCase. API fields keep snake_case, such as
`internal_uuid`, `os_arch` and `storage_options`.

## Parallel browsers

`client.map` distributes items across a browser pool:

```ts
import type { Browser } from "surfsky";

async function title(browser: Browser, url: string) {
  await browser.goto(url);
  return browser.title();
}

const urls = ["https://example.com", "https://example.org"];
for (const result of await client.map(title, urls, { concurrency: 2 })) {
  console.log(result.item, result.ok ? result.value : result.error);
}
```

Without a concurrency limit, the pool uses your plan's maximum. Results include
per-item errors.

To use a browser from the pool:

```ts
await using pool = await client.browsers();
await pool.lease(async (browser) => {
  await browser.goto("https://example.com");
  console.log(await browser.title());
});
```

`lease()` waits for a free browser and returns it to the pool after the callback.
Cookies and browser state persist between leases. Handlers are not retried.

## Reference and examples

- [SDK API reference](https://github.com/surfskyio/surfsky-js/blob/main/docs/api.md)
- [REST API](https://docs.surfsky.io/api-reference)
- [Examples](https://github.com/surfskyio/surfsky-js/tree/main/examples): forms, tabs, retries, profiles and CDP connections.

`client.session()` exposes a WebSocket URL for external browser clients.
See the [Playwright](https://github.com/surfskyio/surfsky-js/blob/main/examples/playwright_connect.ts),
[Puppeteer](https://github.com/surfskyio/surfsky-js/blob/main/examples/puppeteer_connect.ts)
and [Selenium](https://github.com/surfskyio/surfsky-js/blob/main/examples/selenium_connect.ts) examples.

From the repository, run examples with Bun or Node 24+:

```sh
bun install
bun run examples/one_time.ts
# Or, on Node 24+:
bun run build && node examples/one_time.ts
```

On Node 22, compile the examples first. Run the Playwright example on Node;
its WebSocket connection can hang under Bun.

## Development

```sh
bun install
bun run check
bun run build
```

Live tests require credentials and bill your account:

```sh
SURFSKY_LIVE_TESTS=1 bun run test:live
```

## License

MIT
