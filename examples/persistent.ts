/**
 * A persistent profile: 1 browser that keeps its state between runs.
 *
 *     export SURFSKY_API_TOKEN=... SURFSKY_API_BASE_URL=...
 *     bun run examples/persistent.ts
 */

import { Surfsky } from "surfsky";

await using client = new Surfsky();
const profile = await client.profiles.create({
  title: "demo-persistent",
  fingerprint: { os: "mac", os_arch: "arm", os_version: "15" },
  storage_options: { cookies: true, localstorage: true },
});
console.log("created", profile.uuid);
try {
  {
    await using browser = await client.browser({ profileUuid: profile.uuid });
    await browser.goto("https://google.com", { waitUntil: "domcontentloaded" });
    console.log("session 1 completed");
  }
  {
    await using browser = await client.browser({ profileUuid: profile.uuid });
    await browser.goto("https://google.com", { waitUntil: "domcontentloaded" });
    console.log("session 2 completed");
  }
} finally {
  await client.profiles.delete(profile.uuid);
  console.log("deleted", profile.uuid);
}
