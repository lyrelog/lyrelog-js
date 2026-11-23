import fs from "node:fs";
import { describe, expect, it } from "vitest";
import * as browser from "../src/browser.js";
import * as node from "../src/node.js";
import { SDK } from "../src/platform.js";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  exports: Record<string, unknown>;
  engines: { node: string };
};

describe("package (L8)", () => {
  it("reports the package's own version as its SDK", () => {
    expect(SDK).toBe(`lyrelog-js/${pkg.version}`);
  });

  it("exports only the public API", () => {
    expect(Object.keys(browser).sort()).toEqual(["DEFAULT_REDACT_KEYS", "Lyrelog", "default"]);
    expect(Object.keys(node).sort()).toEqual(["DEFAULT_REDACT_KEYS", "Lyrelog", "default"]);
  });

  it("resolves the node types under the node condition, and exposes package.json", () => {
    const root = pkg.exports["."] as Record<string, unknown>;
    expect(Object.keys(root)[0]).toBe("node");
    expect((root.node as Record<string, string>).types).toBe("./dist/node.d.ts");
    expect(pkg.exports["./package.json"]).toBe("./package.json");
    expect(pkg.engines.node).toBe(">=22.12");
  });
});
