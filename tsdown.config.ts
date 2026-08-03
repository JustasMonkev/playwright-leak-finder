import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: "esm",
  target: "node18",
  dts: true,
  sourcemap: true,
});
