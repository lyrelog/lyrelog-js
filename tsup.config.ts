import { defineConfig } from "tsup";

// Two builds of the same API: `browser` (default condition) and `node` (the `node` condition).
// The core is shared; only the platform glue (storage, gzip, lifecycle, resource) differs.
export default defineConfig({
  entry: { browser: "src/browser.ts", node: "src/node.ts" },
  format: ["esm"],
  dts: false, // TypeScript 7 emits the declarations (pnpm build runs tsc after tsup)
  target: "es2020",
  platform: "neutral",
  external: ["node:crypto", "node:fs", "node:os", "node:path", "node:zlib"],
  clean: true,
  sourcemap: false, // src is not shipped; the build is readable ESM
  splitting: false,
  treeshake: true,
});
