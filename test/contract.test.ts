import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { utf8Length } from "../src/prepare.js";
import { harness } from "./helpers.js";

/**
 * The ingest's parser (lyrelog: internal/events/events.go parseEvent, checkAttrs,
 * parseResource) ported line for line: whatever the SDK is given, every line it sends must pass.
 */
const TOP = new Set(["event_id", "ts", "level", "message", "attrs", "payload", "resource", "category", "user_id", "install_id", "session_id"]);
const RESOURCE = new Set(["app_id", "app_version", "app_build", "os_name", "os_version", "device_model", "locale", "sdk", "environment", "platform"]);
const LEVELS = ["trace", "debug", "info", "notice", "warning", "error", "critical"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkAttrs(value: Record<string, unknown>, depth: number, path: string): number {
  if (depth > 4) throw new Error(`${path} is nested too deep`);
  let count = 0;
  for (const key of Object.keys(value).sort()) {
    if (key === "" || utf8Length(key) > 128 || key.startsWith("_") || key.includes(".")) throw new Error(`bad attribute name ${key}`);
    const item = value[key];
    const where = `${path}.${key}`;
    if (item !== null && typeof item === "object" && !Array.isArray(item)) count += checkAttrs(item as Record<string, unknown>, depth + 1, where);
    else if (Array.isArray(item)) {
      if (item.length > 64) throw new Error(`${where} has more than 64 items`);
      for (const element of item) {
        if (typeof element !== "string") throw new Error(`${where}: arrays may only hold strings`);
        if (utf8Length(element) > 1024) throw new Error(`${where} too long`);
      }
      count++;
    } else if (typeof item === "string") {
      if (utf8Length(item) > 1024) throw new Error(`${where} too long`);
      count++;
    } else if (typeof item === "number" || typeof item === "boolean" || item === null) count++;
    else throw new Error(`${where} has an unsupported type`);
  }
  return count;
}

function parseEvent(line: string): void {
  if (utf8Length(line) > 1024 * 1024) throw new Error("line too long");
  const fields = JSON.parse(line) as Record<string, unknown>;
  for (const key of Object.keys(fields)) if (!TOP.has(key)) throw new Error(`unknown field ${key}`);
  if (typeof fields.event_id !== "string" || !UUID.test(fields.event_id)) throw new Error("event_id");
  if (typeof fields.ts !== "string" || Number.isNaN(Date.parse(fields.ts)) || !/(Z|[+-]\d\d:\d\d)$/.test(fields.ts)) throw new Error("ts");
  if ("level" in fields && !LEVELS.includes(fields.level as string)) throw new Error("level");
  if (typeof fields.message !== "string" || fields.message === "" || utf8Length(fields.message) > 2048) throw new Error("message");
  if (fields.category !== undefined && (typeof fields.category !== "string" || utf8Length(fields.category) > 64)) throw new Error("category");
  for (const id of ["user_id", "install_id", "session_id"]) {
    const value = fields[id];
    if (value !== undefined && (typeof value !== "string" || utf8Length(value) > 128)) throw new Error(id);
  }
  const resource = fields.resource as Record<string, unknown> | undefined;
  if (resource !== undefined) {
    for (const [key, value] of Object.entries(resource)) {
      if (!RESOURCE.has(key)) throw new Error(`unknown resource field ${key}`);
      if (typeof value !== "string" || utf8Length(value) > 64) throw new Error(`resource.${key}`);
    }
    if (resource.environment !== undefined && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(resource.environment as string)) throw new Error("environment");
  }
  if (fields.attrs !== undefined && fields.attrs !== null) {
    if (typeof fields.attrs !== "object" || Array.isArray(fields.attrs)) throw new Error("attrs must be an object");
    if (checkAttrs(fields.attrs as Record<string, unknown>, 1, "attrs") > 200) throw new Error("too many attributes");
  }
  if (fields.payload !== undefined && fields.payload !== null && utf8Length(JSON.stringify(fields.payload)) > 64 * 1024) throw new Error("payload too long");
}

describe("the ingest contract (L9)", () => {
  it("every line the SDK sends passes the server's parser, whatever it was given", async () => {
    const { client, sent } = harness({ environment: "Prod EU!!", platform: "Web App", release: "v".repeat(200), appId: "é".repeat(100) });
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    const loop: Record<string, unknown> = { n: 1n };
    loop.self = loop;
    const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
    client.setUser("u".repeat(500));
    client.screen("s".repeat(5000));
    client.info("", { category: "c".repeat(100), attrs: { "": 1, ".a": 2, "_b": 3, "x.y": 4, x_y: 5, ["n".repeat(300)]: 6, deep, many } });
    client.warning("m".repeat(10_000), {
      attrs: { list: Array.from({ length: 100 }, (_, i) => ({ i })), s: "😀".repeat(1000), nan: Number.NaN, inf: -Infinity, big: 10n, date: new Date(0), fn: () => 1, sym: Symbol("s"), loop },
      payload: { huge: "x".repeat(200_000), loop },
    });
    client.error("e", { payload: loop, attrs: { err: new RangeError("r"), map: new Map([[1, 2]]), nested: [[1, [2]]] } });
    client.captureError(vm.runInNewContext("new TypeError('realm')"));
    client.captureError({ toString: () => "weird" });
    client.captureError(Symbol("thrown"));
    client.captureError(undefined);
    await client.flush();
    const lines = sent.flatMap((s) => s.lines.map((e) => JSON.stringify(e)));
    expect(lines.length).toBe(8);
    for (const line of lines) expect(() => parseEvent(line), line.slice(0, 200)).not.toThrow();
  });

  it("an array with holes still holds only strings", async () => {
    const { client, sent } = harness();
    // eslint-disable-next-line no-sparse-arrays
    client.info("sparse", { attrs: { list: [, "a"], empty: new Array(3) } });
    await client.flush();
    const line = JSON.stringify(sent[0]!.lines[0]);
    expect(() => parseEvent(line)).not.toThrow();
    expect(sent[0]!.lines[0]!.attrs).toEqual({ list: ["undefined", "a"], empty: ["undefined", "undefined", "undefined"] });
  });
});
