/**
 * Log several accounts in, each on its own persistent profile.
 *
 *     export SURFSKY_API_TOKEN=... SURFSKY_API_BASE_URL=...
 *     bun run examples/multi_account.ts
 */

import type { Browser, Fingerprint } from "surfsky";
import { Surfsky } from "surfsky";

const PREFIX = "demo-account-";
const LOGIN = "https://the-internet.herokuapp.com/login";
const SECURE = "https://the-internet.herokuapp.com/secure";
const ACCOUNTS: Record<string, [Fingerprint, string]> = {
  account1: [{ os: "win", os_arch: "x86", os_version: "11" }, "us"],
  account2: [{ os: "mac", os_arch: "arm", os_version: "15" }, "de"],
  account3: [{ os: "win", os_arch: "x86", os_version: "10" }, "fr"],
};

async function ourProfiles(client: Surfsky): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for await (const profile of client.profiles.iterAll()) {
    if (profile.title?.startsWith(PREFIX))
      found.set(profile.title.slice(PREFIX.length), profile.uuid);
  }
  return found;
}

async function ensureProfiles(client: Surfsky): Promise<Map<string, string>> {
  const profiles = await ourProfiles(client);
  for (const [name, [fingerprint, country]] of Object.entries(ACCOUNTS)) {
    if (profiles.has(name)) continue;
    const created = await client.profiles.create({
      title: PREFIX + name,
      fingerprint,
      proxy: { country }, // premium if the account has it, else shared
      storage_options: { cookies: true, localstorage: true },
    });
    profiles.set(name, created.uuid);
    console.log(`${name}: created profile ${created.uuid}`);
  }
  return profiles;
}

async function loggedIn(browser: Browser): Promise<boolean> {
  await browser.goto(SECURE, { waitUntil: "domcontentloaded" });
  return browser.isVisible('a[href="/logout"]');
}

async function logIn(browser: Browser): Promise<void> {
  await browser.goto(LOGIN, { waitUntil: "domcontentloaded" });
  await browser.fill("#username", "tomsmith");
  await browser.fill("#password", "SuperSecretPassword!");
  await browser.click("button[type=submit]");
  await browser.waitForUrl("/secure");
}

async function runAccount(client: Surfsky, name: string, uuid: string): Promise<void> {
  try {
    await using browser = await client.browser({ profileUuid: uuid });
    if (await loggedIn(browser)) {
      console.log(`${name}: still logged in from an earlier run`);
      return;
    }
    await logIn(browser);
    console.log(`${name}: logged in, ${(await loggedIn(browser)) ? "ok" : "FAILED"}`);
  } catch (err) {
    console.log(`${name}: FAILED ${String(err)}`);
  }
}

await using client = new Surfsky();
const profiles = await ensureProfiles(client);
try {
  // no more starts at once than the plan allows; one past the cap is a 429
  const slots = await client.account.maxBrowsers();
  const queue = [...profiles.entries()];
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      await runAccount(client, next[0], next[1]);
    }
  };
  await Promise.all(Array.from({ length: slots }, worker));
} finally {
  await client.profiles.deleteMany([...profiles.values()]);
}
