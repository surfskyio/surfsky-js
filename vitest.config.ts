import type { ViteUserConfig } from "vitest/config";
import { defineConfig } from "vitest/config";
import pkg from "./package.json" with { type: "json" };

const live = process.env.SURFSKY_LIVE_TESTS === "1";

const config: ViteUserConfig = defineConfig({
  define: { __SURFSKY_VERSION__: JSON.stringify(pkg.version) },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: live ? [] : ["tests/live.test.ts"],
    testTimeout: 10_000,
  },
});

export default config;
