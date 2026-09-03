/**
 * Set a fingerprint, then read it back from browserleaks.
 *
 * Surfsky gives every session a fingerprint out of the box, and the default is
 * fine almost every time. Pass your own when you want to pin some of the values.
 *
 *     export SURFSKY_API_TOKEN=... SURFSKY_API_BASE_URL=...
 *     bun run examples/fingerprint.ts
 */

import type { Fingerprint } from "surfsky";
import { Surfsky } from "surfsky";

await using client = new Surfsky();
const screens = await client.fingerprints.screens("win", "x86");
const fingerprint: Fingerprint = {
  os: "win",
  os_arch: "x86",
  os_version: "11",
  cpu: 8,
  ram: 8,
  screen: screens[0]?.value,
  languages: ["de-DE", "de", "en"],
  timezone: "Europe/Berlin",
};
console.log("fingerprint:", fingerprint);

const fields = [
  "userAgent",
  "platform",
  "languages",
  "timeZone",
  "hardwareConcurrency",
  "deviceMemory",
  "width",
  "height",
];

let seen: Record<string, string>;
{
  await using browser = await client.browser({ fingerprint });
  await browser.goto("https://browserleaks.com/javascript", { waitUntil: "load" });
  await browser.hover("#js-userAgent");
  seen = await browser.evaluate(
    `ids => Object.fromEntries(ids.map(
      id => [id, document.querySelector('#js-' + id)?.textContent.trim()]))`,
    { args: [fields] },
  );
}

for (const [name, value] of Object.entries(seen))
  console.log(`${name.padEnd(20)} ${value}`);
