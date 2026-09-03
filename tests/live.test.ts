/**
 * Live tests: real sessions, real billing.
 *
 *     SURFSKY_LIVE_TESTS=1 SURFSKY_API_TOKEN=... SURFSKY_API_BASE_URL=... bun run test:live
 */

import { describe, expect, test } from "vitest";
import type { Browser } from "../src/index.js";
import { Surfsky } from "../src/index.js";

const READY = Boolean(
  process.env.SURFSKY_LIVE_TESTS &&
    process.env.SURFSKY_API_TOKEN &&
    process.env.SURFSKY_API_BASE_URL,
);

const POOL_WORKERS = 5;
const CHURN_SESSIONS = 8;
const TEST_DEADLINE = 600_000;
const RECORDS_DRAIN_DEADLINE = 120_000;

const URLS = Array(5)
  .fill(["https://example.com", "https://example.org", "https://example.net"])
  .flat();

async function activeUuids(client: Surfsky): Promise<Set<string>> {
  return new Set((await client.profiles.listActive()).map((p) => p.internal_uuid));
}

async function waitRecordsDrained(
  client: Surfsky,
  ours: Set<string>,
): Promise<Set<string>> {
  const until = Date.now() + RECORDS_DRAIN_DEADLINE;
  let leftover = ours;
  while (Date.now() < until) {
    const active = await activeUuids(client);
    leftover = new Set([...ours].filter((uuid) => active.has(uuid)));
    if (leftover.size === 0) return leftover;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return leftover;
}

describe.skipIf(!READY)("live", () => {
  test(
    "N workers scrape M urls concurrently; every task completes, no records leak",
    async () => {
      const used = new Set<string>();
      await using client = new Surfsky();
      const outcomes = await client.map(
        async (browser: Browser, url: string) => {
          used.add(browser.internalUuid);
          await browser.goto(url, { waitUntil: "domcontentloaded" });
          return { url, title: await browser.title() };
        },
        URLS,
        { concurrency: POOL_WORKERS },
      );
      expect(
        outcomes.filter((o) => !o.ok).map((o) => (o.ok ? "" : String(o.error))),
      ).toEqual([]);
      const scraped = new Set(outcomes.map((o) => (o.ok ? o.value.url : "")));
      expect(scraped).toEqual(new Set(URLS));
      expect(used.size).toBe(POOL_WORKERS);
      expect(await waitRecordsDrained(client, used)).toEqual(new Set());
    },
    TEST_DEADLINE,
  );

  test(
    "a parallel burst of short start->navigate->close sessions; all clean up",
    async () => {
      const sessions: string[] = [];
      await using client = new Surfsky();
      const one = async (): Promise<void> => {
        await using browser = await client.browser();
        sessions.push(browser.internalUuid);
        await browser.goto("https://example.com", { waitUntil: "domcontentloaded" });
        expect(await browser.title()).toContain("Example");
      };
      await Promise.all(Array.from({ length: CHURN_SESSIONS }, one));
      expect(sessions).toHaveLength(CHURN_SESSIONS);
      expect(await waitRecordsDrained(client, new Set(sessions))).toEqual(new Set());
    },
    TEST_DEADLINE,
  );
});
