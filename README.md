# surfsky

TypeScript SDK for [Surfsky](https://surfsky.io), a cloud-based antidetect browser.

![Node 22+](https://img.shields.io/badge/node-22%2B-blue)
![Bun](https://img.shields.io/badge/bun-1.x-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

- Raw CDP, without the automation traces stock Playwright, Puppeteer or
  Selenium leave in the page.
- Input goes through our
  [human-emulation](https://docs.surfsky.io/human_emulation) framework: real
  timing, typing, cursor movement.
- Residential and mobile proxies, 100M+ IPs, with geo, ASN and sticky-session
  targeting. Or use your own.
- Real browser fingerprints from a pool of 2.5M+ devices, not synthetic ones.
- Browsers run in the cloud. Playwright-style API, fully typed, Node 22+ and
  Bun.

REST API docs for the service: https://docs.surfsky.io/api-reference

## Installation

```sh
npm install surfsky
```

or `bun add surfsky`, `pnpm add surfsky`. Requires Node 22 or newer, or Bun.
ESM only.

## Quick start

Sign up at [surfsky.io](https://surfsky.io). Once you're logged in, the
[dashboard](https://app.surfsky.io) shows your API token and base URL. Put them
in the environment:

```sh
export SURFSKY_API_TOKEN=...
export SURFSKY_API_BASE_URL=...
```

Then start a browser:

```ts
import { Surfsky } from "surfsky";

// or new Surfsky({ apiToken: "...", baseUrl: "..." }) instead of env vars
await using client = new Surfsky();
// starts a session, stops it when the block ends so it doesn't keep billing
await using browser = await client.browser({
  proxy: { tier: "premium", country: "us" },
});
await browser.goto("https://duckduckgo.com", { waitUntil: "domcontentloaded" });
await browser.type('[name="q"]', "surfsky cloud browser");
await browser.click("#searchbox_homepage button[type=submit]");
console.log(await browser.waitForUrl("?q="));
```

`await using` needs Node 24+ or Bun (TypeScript compiles it down for Node 22).
Without it, `try { ... } finally { await browser.close() }` does the same.

More examples in [`examples/`](https://github.com/surfskyio/surfsky-js/tree/main/examples).

## Browser automation

The API sticks to Playwright's names and semantics where it can: `click`,
`fill`, `hover`, `waitForSelector`, `innerText`, `selectOption`,
`keyboard.press`, `mouse.move` and so on. Input goes through Surfsky's
[human emulation](https://docs.surfsky.io/human_emulation). Reads use plain CDP
and run no JavaScript in the page.

When you need JavaScript:

```ts
await browser.evaluate("document.title");
await browser.evaluate("(a, b) => a + b", { args: [1, 2] });
await browser.evaluate(() => document.title); // a function is stringified
```

Scripts run in an isolated world the page can't see. Pass `isolated: false` to
use the page's own context.

Also useful:

- `client.browser({ blockResources: ["image", "font", "media"] })` skips those
  downloads and saves proxy traffic.
- Grab the JSON a page fetches instead of parsing its HTML:

  ```ts
  await browser.captureResponses("/api/search");
  await browser.goto(url);
  const data = (await browser.waitForResponse("/api/search")).json();
  ```

- Work with several pages at once. `browser.pages` has every open tab, popups
  included, and `newPage()` adds one:

  ```ts
  await browser.newPage();
  await browser.pages[1].goto("https://example.com");
  console.log(await browser.pages[0].title(), await browser.pages[1].title());
  ```

Every method is listed in the [API reference](#api-reference).

## Running multiple browsers

`client.map` runs a function over a list of items in parallel, one browser per
item, and collects the results:

```ts
async function title(browser: Browser, url: string) {
  await browser.goto(url);
  return browser.title();
}

for (const o of await client.map(title, urls)) {
  console.log(o.item, o.ok ? o.value : o.error);
}
```

Errors land in `o.error` instead of throwing, so one bad page doesn't stop the
run. By default the pool uses every browser your plan allows
(`concurrency: "auto"`). Pass `concurrency: 5` to cap it.

If you need more control, write your own loop on top of the pool:

```ts
await using pool = await client.browsers();
await pool.lease(async (browser) => {
  // waits for a free browser
  await browser.goto("https://example.com");
  console.log(await browser.title());
});
```

A browser keeps its fingerprint, proxy and cookies between leases.
`browser.data` carries your own state across them, `browser.retire()` swaps in
a fresh browser.

Neither `map` nor `lease` retries: an error is reported and the run goes on.
Retries belong to your handler, since only it knows a timeout from a 404. Loop
around `lease` and `retire()` the browser first, so the next attempt gets a
fresh browser: [`examples/retry.ts`](https://github.com/surfskyio/surfsky-js/blob/main/examples/retry.ts).

## Using Playwright or Puppeteer

You don't have to use the SDK's browser API. `client.session` starts a browser
and gives you its WebSocket URL, so Playwright, Puppeteer or any other CDP
client can connect to it. The SDK still handles profiles, proxies and the
session lifecycle:

```ts
import { chromium } from "playwright-core";
import { Surfsky } from "surfsky";

await using client = new Surfsky();
await using session = await client.session();
const browser = await chromium.connectOverCDP(session.ws_url);
const page = browser.contexts()[0].pages()[0];
await page.goto("https://example.com");
```

Don't use stock Playwright or Puppeteer: both put back the traces this SDK
avoids, `Runtime.enable` above all. The patched forks strip them and are
drop-in replacements.

Selenium works too (`enable_chromedriver: true`, see
[`examples/selenium_connect.ts`](https://github.com/surfskyio/surfsky-js/blob/main/examples/selenium_connect.ts)) but isn't
recommended: chromedriver is easy to detect.

## Proxies

Every session start accepts `proxy`. Use your own, or one of Surfsky's
built-in pools:

- Premium: clean residential and mobile IPs, targeted by country, region,
  city, ASN or coordinates, with sticky sessions. Use it for production.
- Shared: a pool for testing. Don't rely on it against sites that matter.

```ts
import { ProxyCycle, ProxyTemplate } from "surfsky";

proxy = { tier: "premium", country: "us", region: "ny", type: "mobile" }; // Surfsky premium
proxy = { tier: "shared", country: "us" }; // Surfsky shared, for tests
proxy = { country: "de" }; // premium if set up, else shared
proxy = "socks5://user:pass@host:1080"; // your own
proxy = new ProxyCycle(myProxies); // round-robin over your own list
proxy = new ProxyTemplate(
  "http://user-sessid-{session}:pw@gate.example.com:7000",
);
proxy = async () => pickOne(); // any function, sync or async
```

`client.proxies` lists available countries, regions and cities, plus your quota.

## Profiles and the REST API

Profiles, proxies, fingerprints, extensions and account limits are all typed
calls on the client. You'll mostly use profiles: a profile is a saved browser,
so every session started on it gets the same fingerprint, proxy and cookies.

```ts
await using client = new Surfsky();
const profile = await client.profiles.create({
  title: "account-1",
  fingerprint: { os: "win", os_arch: "x86", os_version: "11" },
  proxy: { tier: "premium", country: "us" },
});
await using browser = await client.browser({ profileUuid: profile.uuid });
await browser.goto("https://example.com/login");
// log in once, the cookies stay with the profile
```

Next time, `client.browser({ profileUuid })` brings back the same browser,
still logged in. `client.profiles.iterAll()` lists your profiles and
`delete(uuid)` removes one.

Fields on request and response objects use the API's own names
(`internal_uuid`, `os_arch`, `storage_options`), so the
[API reference](https://docs.surfsky.io/api-reference) maps 1:1. For endpoints
the SDK doesn't cover, `client.request(method, path, options)` sends the
request and returns the raw fetch `Response`.

## API reference

Every browser method is async. `Browser` is a `Page` plus the connection: page
methods on it act on the session's first tab. Waits take `timeout` in
milliseconds, default 30 000, and throw `BrowserTimeoutError`.

### Client

`new Surfsky({ apiToken, baseUrl, timeout: 30_000, maxRetries: 3, backoff: 500, headers, logger, fetch })`.

| Method                                                                                            | Description                                                                                                 |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `session({ profileUuid, ...options })`                                                            | Start a session. Returns the `Session` (`internal_uuid`, `ws_url`) with `stop()` and `await using` support. |
| `browser({ profileUuid, blockResources, blockUrls, connectTimeout, commandTimeout, ...options })` | Start a session and connect a `Browser`. `close()` stops both.                                              |
| `browsers({ concurrency: "auto", blockResources, blockUrls, ...options })`                        | An open `BrowserPool`. `close()` stops every browser.                                                       |
| `map(handler, items, poolOptions)`                                                                | `browsers()` and `pool.map()` in one call.                                                                  |
| `withOptions({ timeout, maxRetries, headers })`                                                   | Copy with overrides. Same fetch and logger.                                                                 |
| `request(method, path, { json, params, body, headers, timeout })`                                 | Raw call. Returns the fetch `Response`, never throws on status.                                             |
| `close()`                                                                                         | Nothing to release; here for `await using`.                                                                 |

Session options: `fingerprint`, `proxy`, `browser_settings`
(`inactive_kill_timeout`, `cache_enabled`, `cache_key`), `enable_chromedriver`,
`extensions` (up to 5 uuids), `proxy_blacklist`, `domain_routes`, `cookies`.
`fingerprint` and `cookies` apply to one-time sessions only. Requests are
validated with [zod](https://zod.dev) before they leave: an unknown key, a
bad range or an impossible proxy targeting throws `ValidationError`, so a typo
never starts a billed session.

`logger` takes `{ debug, info, warn, error }` (any subset). By default warnings
and errors go to the console; `logger: null` silences the SDK.

### Pool

| Member                     | Description                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pool.lease(fn)`           | Runs `fn(browser)` on a live browser and hands it back after. Waits while all are busy.                                                                                                                      |
| `pool.map(handler, items)` | `handler(browser, item)` per item, `capacity` at a time. Returns `PoolOutcome` list in input order: `{ ok: true, item, index, value }` or `{ ok: false, item, index, error }`. Throw `StopRun` to end early. |
| `pool.capacity`            | Max live browsers. `"auto"` is the plan's limit, `SURFSKY_MAX_BROWSERS` overrides it.                                                                                                                        |
| `browser.data`             | Per-browser object. Survives leases.                                                                                                                                                                         |
| `browser.useCount`         | Leases so far, current included.                                                                                                                                                                             |
| `browser.retire()`         | Replace this browser with a fresh one after the lease.                                                                                                                                                       |
| `browser.internalUuid`     | Session id.                                                                                                                                                                                                  |
| `browser.connected`        | Socket is up.                                                                                                                                                                                                |

The plan limit counts browsers started elsewhere with the same token. `lease()`
waits for one of its own and throws `RateLimitError` only if it has none.

### Navigation

| Method                                          | Description                                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `goto(url, { waitUntil: "load", timeout })`     | Navigate. `waitUntil`: `commit`, `domcontentloaded`, `load`, `networkidle`. Follows redirects. |
| `reload({ waitUntil, timeout })`                | Reload.                                                                                        |
| `goBack({ timeout })`, `goForward({ timeout })` | Returns the new URL, `null` at the end of history.                                             |
| `waitForLoadState(state = "load", { timeout })` | Wait for the current document to reach `state`.                                                |
| `waitForUrl(fragment, { timeout })`             | Wait until the URL contains `fragment`. Returns the URL.                                       |
| `status`                                        | HTTP status of the current document. Set even when `goto` throws.                              |

### Reading

| Method                                                       | Description                                                                             |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `url()`, `title()`                                           | Current URL and title.                                                                  |
| `content()`                                                  | Full HTML.                                                                              |
| `outerHtml(selector)`                                        | HTML of the first match, `null` if none.                                                |
| `innerText(selector)`, `allInnerTexts(selector)`             | Rendered text of the first match, or of every match. Runs script in the isolated world. |
| `getAttribute(selector, name)`                               | `null` if missing.                                                                      |
| `count(selector)`                                            | Number of matches.                                                                      |
| `isVisible(selector)`                                        | First match has a bounding box.                                                         |
| `waitForSelector(selector, { visible: true, timeout })`      | Wait for the element, visible by default.                                               |
| `screenshot({ selector, fullPage, format: "png", quality })` | `Uint8Array`. Viewport, one element or the full page. `format`: `png`, `jpeg`, `webp`.  |

### Input

Server-side human emulation. The first CSS match is used. `click`, `dblclick`
and `hover` also take `waitForVisible`, `scrollIntoView`, `preDelay`,
`postDelay`, `timeout`.

| Method                                                                                                                                                         | Description                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `click(selector, { button, clickCount, modifiers })`                                                                                                           | `button`: `left`, `right`, `middle`. `modifiers`: `Alt`, `Control`, `Meta`, `Shift`. Waits up to 30s for the element. |
| `dblclick(selector, ...)`                                                                                                                                      | Double-click.                                                                                                         |
| `hover(selector)`                                                                                                                                              | Move the mouse over it.                                                                                               |
| `type(selector, text)`                                                                                                                                         | Click, then type after the existing text.                                                                             |
| `fill(selector, text)`                                                                                                                                         | Select the existing text, then type over it.                                                                          |
| `selectOption(selector, value)` / `selectOption(selector, { label })`                                                                                          | Pick an `<option>` by value or label. Returns the value.                                                              |
| `scroll({ deltaX, deltaY, duration })`                                                                                                                         | Animated scroll.                                                                                                      |
| `scrollIntoView(selector, { behavior })`, `scrollTo({ x, y, behavior })`                                                                                       | `behavior`: `smooth`, `instant`.                                                                                      |
| `keyboard.type(text)`, `keyboard.press(key, { modifiers, delay })`                                                                                             | Keys to the focused element. `press("Enter")` submits a form; older pods need the button.                             |
| `mouse.move(x, y)`, `mouse.click(x, y)`, `mouse.down(x, y)`, `mouse.up(x, y)`, `mouse.wheel({ deltaX, deltaY })`, `mouse.drag({ startX, startY, endX, endY })` | Viewport coordinates.                                                                                                 |

### Script

| Method                                                               | Description                                                                                                                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `evaluate(expression, { args, isolated: true, awaitPromise: true })` | Run JS. A function, or a string that looks like one, is called with `args` as JSON; anything else is an expression. Isolated world by default. |
| `waitForFunction(expression, { args, isolated, timeout })`           | Poll until truthy. Returns the value.                                                                                                          |
| `send(method, params)`                                               | Raw page-level CDP command.                                                                                                                    |
| `browser.cdp`                                                        | Raw browser-level client: `send`, `post`, `on`.                                                                                                |

### Cookies and storage

| Method                                          | Description                       |
| ----------------------------------------------- | --------------------------------- |
| `cookies()`                                     | All cookies, `httpOnly` included. |
| `setCookies(cookies)`                           | Cookie objects.                   |
| `clearCookies()`                                | Remove every cookie.              |
| `localStorage()`, `setLocalStorage(values)`     | Current origin, as an object.     |
| `sessionStorage()`, `setSessionStorage(values)` | Same for sessionStorage.          |

### Network

| Method                                   | Description                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `captureResponses(...fragments)`         | Record responses whose URL contains a fragment. Call before navigating.                                        |
| `waitForResponse(fragment, { timeout })` | First captured match. `CapturedResponse`: `url`, `status`, `headers`, `body` (`Uint8Array`), `text`, `json()`. |
| `responses`                              | Everything captured, oldest first.                                                                             |
| `stopCapturing()`                        | Drop captures, stop recording.                                                                                 |

### Dialogs

`page.onDialog = (kind, message) => ...`. `kind`: `alert`, `confirm`, `prompt`,
`beforeunload`. Return `true` to accept, `false` to dismiss, a string to answer
a prompt, `undefined` for the default. Default: dismiss, except `beforeunload`
is accepted.

### Pages

| Member                                     | Description                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| `browser.pages`                            | Every open page. The browser's own first, newest last.                         |
| `browser.newPage()`                        | Blank page in a new window.                                                    |
| `browser.waitForPage(action, { timeout })` | Await `action` (a click promise, or a function) and return the page it opened. |
| `page.close()`                             | Close the tab. On the browser itself: close the connection.                    |
| `page.closed`                              | `true` once gone. Commands then throw `PageClosedError`.                       |
| `page.bringToFront()`                      | Make it the visible tab. Screenshots of hidden tabs hang.                      |
| `page.targetId`                            | CDP target id.                                                                 |

### REST

| Namespace             | Methods                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.profiles`     | `startOneTime(options)`, `start(uuid, options)`, `stop(session)`, `stopAll()`, `listActive()`, `create({ title, fingerprint, description, proxy, cookies, storage_options })`, `get(uuid)`, `update(uuid, fields)`, `delete(uuid)`, `deleteMany(uuids)`, `listPage({ page, page_len, ordering })`, `iterAll({ page_len, ordering })`, `exportCookies(uuid, { export_format })`, `importCookies(uuid, cookies)`, `scrape(session, url, { screenshot, wait, wait_until, wait_for, human_actions })` |
| `client.proxies`      | `countries()`, `regions(country)`, `cities(country, region)`, `quota()`, `premiumStats()`, `sharedCountries()`, `sharedQuota()`, `sharedStats()`. The first four need a premium provider on the account.                                                                                                                                                                                                                                                                                          |
| `client.fingerprints` | `renderers(os, osArch)`, `screens(os, osArch)`, `deviceModels({ os, os_arch, os_version, device_type })`                                                                                                                                                                                                                                                                                                                                                                                          |
| `client.extensions`   | `upload(file, name)` (path, bytes or Blob, zip up to 100 MB), `listAll()`, `get(uuid)`, `update(uuid, { name })`, `delete(uuid)`                                                                                                                                                                                                                                                                                                                                                                  |
| `client.account`      | `sessionLimits()`, `browserLimits()`, `maxBrowsers()`                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### Errors

All subclasses of `SurfskyError`. `ValidationError` for a request that failed
validation before it was sent (`issues` lists the fields). HTTP: `APIError`
subclasses named after the status (`NotFoundError`, `RateLimitError`, ...) with
`statusCode`, `code`, `body`, `requestId`, `retryAfter` (ms). Browser:
`CDPError`, `BrowserTimeoutError`, `PageClosedError`. Idempotent requests retry
on 429, 5xx and connection errors. POST and PATCH retry on a 429 or a failure
that proves the request never left (a refused connection, a DNS error), so a
lost reply can't start a second billed session.

## Examples

More examples in [`examples/`](https://github.com/surfskyio/surfsky-js/tree/main/examples). They import `surfsky` by name:

```sh
bun run examples/one_time.ts                 # Bun resolves it to src/ directly
bun run build && node examples/one_time.ts   # Node 24 runs .ts (and `await using`) natively, resolves dist/
```

On Node 22 compile the examples first (`await using` is syntax Node 22 lacks):
`npx tsc -p tsconfig.json --noEmit false --outDir out` and run the output.

The Playwright, Puppeteer and Selenium examples need their dev dependencies
(`bun install` brings them in). Run `playwright_connect.ts` on Node: under Bun,
Playwright's own WebSocket transport opens the socket and then never sends a
command, so `connectOverCDP` times out. Bun runs the SDK and the Puppeteer
example fine.

## Development

```sh
bun install
bun run check      # lint, typecheck, tests
bun run build
```

Live tests start real sessions and bill your account:

```sh
SURFSKY_LIVE_TESTS=1 SURFSKY_API_TOKEN=... SURFSKY_API_BASE_URL=... bun run test:live
```

## License

MIT
