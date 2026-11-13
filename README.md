# surfsky

TypeScript SDK for [Surfsky](https://surfsky.io), an antidetect cloud browser:
scrape a page in one call, or start a browser session and control it over CDP.

## Install

```sh
npm install surfsky
```

Or `bun add surfsky` / `pnpm add surfsky`. ESM only; needs Node 22+ or Bun.

## Credentials

Token and base URL come from the [dashboard](https://app.surfsky.io).

```sh
export SURFSKY_API_TOKEN='your-token'
export SURFSKY_API_BASE_URL='your-base-url'
```

`new Surfsky({ apiToken, baseUrl })` overrides the environment.

## Scrape

```ts
import { Surfsky } from "surfsky";

const client = new Surfsky();
const page = await client.scrape("https://example.com", { formats: ["markdown"] });
console.log(page.status, page.markdown);
```

The examples use top-level `await`: run them as ES modules (`"type": "module"`,
`.mjs` or `.mts`).

`scrape` runs in a pre-started cloud browser, so there is no session to stop.
Formats: `html` (cleaned, the default), `raw_html`, `markdown`, `links`,
`screenshot`, `cookies`. Scrape options keep the API's snake_case: `wait_for`,
`only_main_content`, `actions`. The [API reference](https://github.com/surfskyio/surfsky-js/blob/main/docs/api.md)
lists them all.

## Browser sessions

```ts
await using browser = await client.browser({
  proxy: { tier: "premium", country: "us" },
});
await browser.goto("https://example.com");
await browser.click("a");
console.log(await browser.title());
```

A session is billed until it stops, idle time included. `await using` closes
the browser and stops the session when the scope ends; it needs Node 24+ or Bun.
On Node 22, compile the TypeScript or call `await browser.close()` in a `finally`.

The cloud also stops a session after 30 seconds without CDP traffic; raise it
with `browser_settings: { inactive_kill_timeout: 600 }` (seconds, up to 3600).
`client.profiles.listActive()` shows what is still running and
`client.profiles.stopAll()` stops it.

Clicks and typing go through Surfsky's [human emulation](https://docs.surfsky.io/human_emulation).
SDK timeouts are in milliseconds.

## Playwright, Puppeteer, Selenium

`client.session()` starts a session without connecting and returns its CDP
WebSocket URL:

```ts
import { chromium } from "playwright-core";
import { Surfsky } from "surfsky";

const client = new Surfsky();
const session = await client.session();
try {
  const browser = await chromium.connectOverCDP(session.ws_url);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://example.com");
  console.log(await page.title());
  await browser.close();
} finally {
  await session.stop();
}
```

Puppeteer: `puppeteer.connect({ browserWSEndpoint: session.ws_url })`. Stock
Puppeteer sends `Runtime.enable`, which a site can detect. Selenium needs
`client.session({ enable_chromedriver: true })`; see the
[example](https://github.com/surfskyio/surfsky-js/blob/main/examples/selenium_connect.ts).

## Profiles and proxies

A profile keeps its fingerprint, proxy and cookies between sessions:

```ts
const profile = await client.profiles.create({
  title: "account-1",
  fingerprint: { os: "win", os_arch: "x86", os_version: "11" },
  proxy: { tier: "premium", country: "us" },
});
await using saved = await client.browser({ profileUuid: profile.uuid });
await saved.goto("https://example.com/login");
```

`proxy` is `{ tier: "premium", ... }` (residential or mobile, targeted by
`country`, `region`, `city`), `{ tier: "shared" }` (for testing) or your own
proxy URL. `client.proxies` lists locations and quota.

SDK options are camelCase (`profileUuid`). API fields keep snake_case
(`internal_uuid`, `os_arch`, `storage_options`).

## Parallel browsers

`client.map` runs a handler over a list on a pool of browsers:

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

`concurrency` defaults to your plan's limit. A handler that throws becomes an
`ok: false` result; it is not retried. The pool stops its browsers when `map`
returns.

For your own loop, lease browsers from the pool:

```ts
await using pool = await client.browsers();
await pool.lease(async (browser) => {
  await browser.goto("https://example.com");
});
```

`lease()` waits for a free browser and returns it after the callback. Cookies
and page state carry over to the next lease.

## Errors

Every error extends `SurfskyError`.

```ts
import { APIError, RateLimitError } from "surfsky";

try {
  await client.scrape("https://example.com");
} catch (err) {
  if (err instanceof RateLimitError) console.error("retry in ms:", err.retryAfter);
  else if (err instanceof APIError) console.error(err.statusCode, err.code, err.message);
  else throw err;
}
```

| Class | Thrown on |
| --- | --- |
| `ConfigurationError` | missing token or base URL |
| `ValidationError` | bad options, before the request is sent |
| `BadRequestError` | 400, 422; a failed scrape, `code` names the cause |
| `AuthenticationError` | 401 |
| `PaymentRequiredError` | 402 |
| `ForbiddenError` | 403 |
| `NotFoundError` | 404 |
| `ConflictError` | 409 |
| `RateLimitError` | 429 |
| `SharedTrafficLimitError`, `PremiumTrafficLimitError`, `MonthlySessionLimitError` | 429, quota used up |
| `ServerError` | 5xx |
| `APIConnectionError`, `APITimeoutError` | no response |
| `CDPError`, `BrowserTimeoutError`, `PageClosedError` | browser commands and waits |

The HTTP classes extend `APIError`, which has `statusCode`, `code`, `body` and
`requestId`. GET, PUT and DELETE retry on 429, 5xx and network errors, 3 times
by default (`maxRetries`). POST and PATCH retry only on a 429 or when the
request never reached the server, so a lost reply cannot start a second billed
session.

## Reference and examples

- [SDK API reference](https://github.com/surfskyio/surfsky-js/blob/main/docs/api.md)
- [REST API](https://docs.surfsky.io/api-reference)
- [Examples](https://github.com/surfskyio/surfsky-js/tree/main/examples): forms, tabs, retries, profiles, a closed shadow root, CDP connections

Run an example from a clone:

```sh
bun install
bun run examples/one_time.ts
# Node 24+:
bun run build && node examples/one_time.ts
```

Run the Playwright example on Node; its WebSocket connection can hang under Bun.

## Development

```sh
bun install
bun run check
bun run build
```

Live tests need credentials and bill your account:

```sh
bun run test:live
```

## License

MIT
