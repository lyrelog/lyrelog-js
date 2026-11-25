import { afterEach, describe, expect, it } from "vitest";
import { debugIdsByURL, debugIdsOf, frameURL } from "../src/debug-ids.js";
import { stripUrlQueries, webPlatform } from "../src/platform-web.js";
import { harness, ok } from "./helpers.js";

const g = globalThis as Record<string, unknown>;
const ID = "c941b2a1-0e4f-4d6b-9a55-2f3c1d0e9b77";

afterEach(() => {
  delete g._lyrelogDebugIds;
  delete g._sentryDebugIds;
});

/** What the snippet of `lyrelog sourcemaps inject` does, here: register this file's id. */
function register(id: string, name = "_lyrelogDebugIds") {
  const r = (g[name] ??= {}) as Record<string, string>;
  r[new Error().stack!] = id;
}

describe("debug ids", () => {
  it("reads a frame's URL as V8, Firefox and Safari print it", () => {
    expect(frameURL("    at Board.weight (https://shop.test/assets/main-1a2b.js:1:139)")).toBe("https://shop.test/assets/main-1a2b.js");
    expect(frameURL("    at https://shop.test/main.js:1:50")).toBe("https://shop.test/main.js");
    expect(frameURL("    at async loadLevel (file:///srv/app/dist/main.mjs:3:4)")).toBe("file:///srv/app/dist/main.mjs");
    expect(frameURL("weight@https://shop.test/main.js:1:139")).toBe("https://shop.test/main.js");
    expect(frameURL("@https://cdn.test/npm/tilefall@1.2.0/main.js:1:2")).toBe("https://cdn.test/npm/tilefall@1.2.0/main.js");
    expect(frameURL("    at Array.map (<anonymous>)")).toBeUndefined();
    expect(frameURL("TypeError: boom")).toBeUndefined();
  });

  it("sends each bundle's debug id with an exception's stack, causes included", async () => {
    register(ID);
    const { client, sent } = harness();
    client.captureError(new TypeError("boom", { cause: new Error("root") }));
    await client.flush();
    const payload = sent[0]!.lines[0]!.payload as { stack: string; debug_ids?: Record<string, string> };
    const here = frameURL(payload.stack.split("\n")[1]!)!;
    expect(payload.debug_ids).toEqual({ [here]: ID });
  });

  it("sends none when no bundle has an id", async () => {
    const { client, sent } = harness();
    client.captureError(new Error("boom"));
    await client.flush();
    expect(sent[0]!.lines[0]!.payload).not.toHaveProperty("debug_ids");
  });

  it("reads bundles registered later (a lazily loaded chunk) and Sentry's registry", () => {
    const clean = (s: string) => s;
    expect(debugIdsByURL(clean).size).toBe(0);
    (g._sentryDebugIds = {} as Record<string, string>)["Error\n    at https://shop.test/chunk-9.js:1:20"] = ID;
    expect(debugIdsByURL(clean).get("https://shop.test/chunk-9.js")).toBe(ID);
    (g._lyrelogDebugIds = {} as Record<string, string>)["@https://shop.test/main.js:1:20\n"] = "11111111-2222-4333-8444-555555555555";
    expect([...debugIdsByURL(clean).keys()].sort()).toEqual(["https://shop.test/chunk-9.js", "https://shop.test/main.js"]);
  });

  it("matches a bundle loaded with a query string, as the stack is sent without it", () => {
    (g._lyrelogDebugIds = {} as Record<string, string>)["Error\n    at https://shop.test/main.js?v=3:1:20"] = ID;
    const stack = "TypeError: boom\n    at weight (https://shop.test/main.js?v=3:1:139)";
    const clean = (s: string) => webPlatform.cleanStack?.(s) ?? s;
    expect(debugIdsOf([clean(stack)], clean)).toEqual({ "https://shop.test/main.js": ID });
    expect(stripUrlQueries("https://shop.test/main.js?v=3")).toBe("https://shop.test/main.js");
  });

  it("never throws into the app, whatever the registry holds", async () => {
    Object.defineProperty(g, "_lyrelogDebugIds", { configurable: true, get() { throw new Error("hostile"); } });
    const { client, sent } = harness({}, ok);
    client.captureError(new Error("boom"));
    await client.flush();
    expect(sent[0]!.lines[0]!.message).toBe("exception");
    delete g._lyrelogDebugIds;
  });
});

describe("debug ids, as the server reads frames", () => {
  afterEach(() => {
    delete g._lyrelogDebugIds;
    delete g._sentryDebugIds;
  });

  it("reads a URL with parentheses (Next.js route groups)", () => {
    expect(frameURL("    at Board.weight (https://shop.test/_next/static/chunks/app/(shop)/page-1a2b.js:1:139)")).toBe(
      "https://shop.test/_next/static/chunks/app/(shop)/page-1a2b.js",
    );
    (g._lyrelogDebugIds = {} as Record<string, string>)["Error\n    at https://shop.test/_next/static/chunks/app/(shop)/page-1a2b.js:1:20"] = ID;
    const stack = "TypeError: boom\n    at Board.weight (https://shop.test/_next/static/chunks/app/(shop)/page-1a2b.js:1:139)";
    expect(debugIdsOf([stack], (s) => s)).toEqual({ "https://shop.test/_next/static/chunks/app/(shop)/page-1a2b.js": ID });
  });

  it("keeps Lyrelog's id for a bundle Sentry's tools gave one too", () => {
    const key = "Error\n    at https://shop.test/main.js:1:20";
    (g._lyrelogDebugIds = {} as Record<string, string>)[key] = ID;
    (g._sentryDebugIds = {} as Record<string, string>)[key] = "11111111-2222-4333-8444-555555555555";
    expect(debugIdsByURL((s) => s).get("https://shop.test/main.js")).toBe(ID);
  });

  it("reads a bundle loaded again with another id", () => {
    const key = "Error\n    at https://shop.test/main.js:1:20";
    (g._lyrelogDebugIds = {} as Record<string, string>)[key] = ID;
    expect(debugIdsByURL((s) => s).get("https://shop.test/main.js")).toBe(ID);
    (g._lyrelogDebugIds as Record<string, string>)[key] = "11111111-2222-4333-8444-555555555555";
    expect(debugIdsByURL((s) => s).get("https://shop.test/main.js")).toBe("11111111-2222-4333-8444-555555555555");
  });
});
