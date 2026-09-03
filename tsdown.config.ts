import type { UserConfig } from "tsdown";
import { defineConfig } from "tsdown";
import pkg from "./package.json" with { type: "json" };

const config: UserConfig = defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  dts: true,
  fixedExtension: false,
  publint: true,
  attw: { profile: "esm-only" },
  define: { __SURFSKY_VERSION__: JSON.stringify(pkg.version) },
});

export default config;
