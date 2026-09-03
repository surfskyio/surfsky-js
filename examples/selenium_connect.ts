/**
 * Selenium over the session's own ChromeDriver. Not recommended: WebDriver
 * leaves traces a site can read. Prefer `client.browser()`, or Playwright over CDP.
 *
 *     bun add -d selenium-webdriver
 *     export SURFSKY_API_TOKEN=... SURFSKY_API_BASE_URL=...
 *     bun run examples/selenium_connect.ts
 */

import { Builder, By } from "selenium-webdriver";
import { Surfsky } from "surfsky";

await using client = new Surfsky();
await using session = await client.session({ enable_chromedriver: true });
const driver = await new Builder()
  .usingServer(`${client.baseUrl}/chromedriver/${session.internal_uuid}`)
  .forBrowser("chrome")
  .build();
try {
  await driver.get("https://example.com");
  console.log(await driver.getTitle());
  console.log(await driver.findElement(By.css("h1")).getText());
} finally {
  await driver.quit();
}
