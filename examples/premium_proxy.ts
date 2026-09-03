/**
 * Premium proxies: 100M+ residential and mobile IPs, checked before use.
 *
 * Targeting is by country, region, city or ASN, by coordinates, or a regional
 * pool. `session_minutes`, `keep_ip`, `unique_ip` and `keep_asn` set how long
 * the IP lasts and when it may change.
 *
 *     export SURFSKY_API_TOKEN=... SURFSKY_API_BASE_URL=...
 *     bun run examples/premium_proxy.ts
 */

import type { PremiumProxy } from "surfsky";
import { Surfsky } from "surfsky";

const COUNTRY = "us";
const REGION = "california";

await using client = new Surfsky();
// const countries = await client.proxies.countries();
// const regions = await client.proxies.regions(COUNTRY);
const cities = await client.proxies.cities(COUNTRY, REGION);

const proxy: PremiumProxy = {
  tier: "premium",
  country: COUNTRY,
  region: REGION,
  city: cities[0]?.code,
  type: "residential", // residential or mobile
  session_minutes: 10,
  keep_ip: true,
};
await using browser = await client.browser({ proxy });
await browser.goto("https://google.com", { waitUntil: "domcontentloaded" });
console.log(await browser.title());
