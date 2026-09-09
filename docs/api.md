# API reference

Every browser method is async. `Browser` is a `Page` plus the connection: page
methods on it act on the session's first tab. Waits take `timeout` in
milliseconds, default 30 000, and throw `BrowserTimeoutError`.

## Client

`new Surfsky({ apiToken, baseUrl, timeout: 30_000, maxRetries: 3, backoff: 500, headers, logger, fetch })`.

| Method | Description |
| --- | --- |
| `session({ profileUuid, ...options })` | Start a session. Returns the `Session` (`internal_uuid`, `ws_url`) with `stop()` and `await using` support. |
| `browser({ profileUuid, blockResources, blockUrls, connectTimeout, commandTimeout, ...options })` | Start a session and connect a `Browser`. `close()` stops both. |
| `browsers({ concurrency: "auto", blockResources, blockUrls, ...options })` | An open `BrowserPool`. `close()` stops every browser. |
| `map(handler, items, poolOptions)` | `browsers()` and `pool.map()` in one call. |
| `withOptions({ timeout, maxRetries, headers })` | Copy with overrides. Same fetch and logger. |
| `request(method, path, { json, params, body, headers, timeout })` | Raw call. Returns the fetch `Response`, never throws on status. |
| `close()` | Nothing to release; here for `await using`. |

Session options: `fingerprint`, `proxy`, `browser_settings`
(`inactive_kill_timeout`, `cache_enabled`, `cache_key`), `enable_chromedriver`,
`extensions` (up to 5 uuids), `proxy_blacklist`, `domain_routes`, `cookies`.
`fingerprint` and `cookies` apply to one-time sessions only. Requests are
validated with [zod](https://zod.dev) before they leave: an unknown key, a
bad range or an impossible proxy targeting throws `ValidationError`, so a typo
never starts a billed session.

`logger` takes `{ debug, info, warn, error }` (any subset). By default warnings
and errors go to the console; `logger: null` silences the SDK.

## Pool

| Member | Description |
| --- | --- |
| `pool.lease(fn)` | Runs `fn(browser)` on a live browser and hands it back after. Waits while all are busy. |
| `pool.map(handler, items)` | `handler(browser, item)` per item, `capacity` at a time. Returns `PoolOutcome` list in input order: `{ ok: true, item, index, value }` or `{ ok: false, item, index, error }`. Throw `StopRun` to end early. |
| `pool.capacity` | Max live browsers. `"auto"` is the plan's limit, `SURFSKY_MAX_BROWSERS` overrides it. |
| `browser.data` | Per-browser object. Survives leases. |
| `browser.useCount` | Leases so far, current included. |
| `browser.retire()` | Replace this browser with a fresh one after the lease. |
| `browser.internalUuid` | Session id. |
| `browser.connected` | Socket is up. |

The plan limit counts browsers started elsewhere with the same token. `lease()`
waits for one of its own and throws `RateLimitError` only if it has none.

## Navigation

| Method | Description |
| --- | --- |
| `goto(url, { waitUntil: "load", timeout })` | Navigate. `waitUntil`: `commit`, `domcontentloaded`, `load`, `networkidle`. Follows redirects. |
| `reload({ waitUntil, timeout })` | Reload. |
| `goBack({ timeout })`, `goForward({ timeout })` | Returns the new URL, `null` at the end of history. |
| `waitForLoadState(state = "load", { timeout })` | Wait for the current document to reach `state`. |
| `waitForUrl(fragment, { timeout })` | Wait until the URL contains `fragment`. Returns the URL. |
| `status` | HTTP status of the current document. Set even when `goto` throws. |

## Reading

`selector` is CSS, or XPath when it starts with `//`, `..` or `xpath=`. XPath
covers the DOM reads below and `screenshot({ selector })`; `innerText`,
`allInnerTexts`, `selectOption` and the input methods take CSS only.

| Method | Description |
| --- | --- |
| `url()`, `title()` | Current URL and title. |
| `content()` | Full HTML. |
| `outerHtml(selector)` | HTML of the first match, `null` if none. |
| `innerText(selector)`, `allInnerTexts(selector)` | Rendered text of the first match, or of every match. Runs script in the isolated world. |
| `getAttribute(selector, name)` | `null` if missing. |
| `count(selector)` | Number of matches. |
| `isVisible(selector)` | First match has a bounding box. |
| `waitForSelector(selector, { visible: true, timeout })` | Wait for the element, visible by default. |
| `screenshot({ selector, fullPage, format: "png", quality })` | `Uint8Array`. Viewport, one element or the full page. `format`: `png`, `jpeg`, `webp`. |

## Input

Server-side human emulation. The first CSS match is used. `click`, `dblclick`
and `hover` also take `waitForVisible`, `scrollIntoView`, `preDelay`,
`postDelay`, `timeout`.

| Method | Description |
| --- | --- |
| `click(selector, { button, clickCount, modifiers })` | `button`: `left`, `right`, `middle`. `modifiers`: `Alt`, `Control`, `Meta`, `Shift`. Waits up to 30s for the element. |
| `dblclick(selector, ...)` | Double-click. |
| `hover(selector)` | Move the mouse over it. |
| `type(selector, text)` | Click, then type after the existing text. |
| `fill(selector, text)` | Select the existing text, then type over it. |
| `selectOption(selector, value)` / `selectOption(selector, { label })` | Pick an `<option>` by value or label. Returns the value. |
| `scroll({ deltaX, deltaY, duration })` | Animated scroll. |
| `scrollIntoView(selector, { behavior })`, `scrollTo({ x, y, behavior })` | `behavior`: `smooth`, `instant`. |
| `keyboard.type(text)`, `keyboard.press(key, { modifiers, delay })` | Keys to the focused element. `press("Enter")` submits a form; older pods need the button. |
| `mouse.move(x, y)`, `mouse.click(x, y)`, `mouse.down(x, y)`, `mouse.up(x, y)`, `mouse.wheel({ deltaX, deltaY })`, `mouse.drag({ startX, startY, endX, endY })` | Viewport coordinates. |

## Script

| Method | Description |
| --- | --- |
| `evaluate(expression, { args, isolated: true, awaitPromise: true })` | Run JS. A function, or a string that looks like one, is called with `args` as JSON; anything else is an expression. Isolated world by default. |
| `waitForFunction(expression, { args, isolated, timeout })` | Poll until truthy. Returns the value. |
| `send(method, params)` | Raw page-level CDP command. |
| `browser.cdp` | Raw browser-level client: `send`, `post`, `on`. |

## Cookies and storage

| Method | Description |
| --- | --- |
| `cookies()` | All cookies, `httpOnly` included. |
| `setCookies(cookies)` | Cookie objects. |
| `clearCookies()` | Remove every cookie. |
| `localStorage()`, `setLocalStorage(values)` | Current origin, as an object. |
| `sessionStorage()`, `setSessionStorage(values)` | Same for sessionStorage. |

## Network

| Method | Description |
| --- | --- |
| `captureResponses(...fragments)` | Record responses whose URL contains a fragment. Call before navigating. |
| `waitForResponse(fragment, { timeout })` | First captured match. `CapturedResponse`: `url`, `status`, `headers`, `body` (`Uint8Array`), `text`, `json()`. |
| `responses` | Everything captured, oldest first. |
| `stopCapturing()` | Drop captures, stop recording. |

## Dialogs

`page.onDialog = (kind, message) => ...`. `kind`: `alert`, `confirm`, `prompt`,
`beforeunload`. Return `true` to accept, `false` to dismiss, a string to answer
a prompt, `undefined` for the default. Default: dismiss, except `beforeunload`
is accepted.

## Pages

| Member | Description |
| --- | --- |
| `browser.pages` | Every open page. The browser's own first, newest last. |
| `browser.newPage()` | Blank page in a new window. |
| `browser.waitForPage(action, { timeout })` | Await `action` (a click promise, or a function) and return the page it opened. |
| `page.close()` | Close the tab. On the browser itself: close the connection. |
| `page.closed` | `true` once gone. Commands then throw `PageClosedError`. |
| `page.bringToFront()` | Make it the visible tab. Screenshots of hidden tabs hang. |
| `page.targetId` | CDP target id. |

## REST

| Namespace | Methods |
| --- | --- |
| `client.profiles` | `startOneTime(options)`, `start(uuid, options)`, `stop(session)`, `stopAll()`, `listActive()`, `create({ title, fingerprint, description, proxy, cookies, storage_options })`, `get(uuid)`, `update(uuid, fields)`, `delete(uuid)`, `deleteMany(uuids)`, `listPage({ page, page_len, ordering })`, `iterAll({ page_len, ordering })`, `exportCookies(uuid, { export_format })`, `importCookies(uuid, cookies)`, `scrape(session, url, { screenshot, wait, wait_until, wait_for, human_actions })` |
| `client.proxies` | `countries()`, `regions(country)`, `cities(country, region)`, `quota()`, `premiumStats()`, `sharedCountries()`, `sharedQuota()`, `sharedStats()`. The first four need a premium provider on the account. |
| `client.fingerprints` | `renderers(os, osArch)`, `screens(os, osArch)`, `deviceModels({ os, os_arch, os_version, device_type })` |
| `client.extensions` | `upload(file, name)` (path, bytes or Blob, zip up to 100 MB), `listAll()`, `get(uuid)`, `update(uuid, { name })`, `delete(uuid)` |
| `client.account` | `sessionLimits()`, `browserLimits()`, `maxBrowsers()` |

## Errors

All subclasses of `SurfskyError`. `ValidationError` for a request that failed
validation before it was sent (`issues` lists the fields). HTTP: `APIError`
subclasses named after the status (`NotFoundError`, `RateLimitError`, ...) with
`statusCode`, `code`, `body`, `requestId`, `retryAfter` (ms). Browser:
`CDPError`, `BrowserTimeoutError`, `PageClosedError`. Idempotent requests retry
on 429, 5xx and connection errors. POST and PATCH retry on a 429 or a failure
that proves the request never left (a refused connection, a DNS error), so a
lost reply can't start a second billed session.
