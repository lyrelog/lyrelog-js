import { describe, expect, it } from "vitest";
import * as prepare from "../src/prepare.js";

describe("truncate", () => {
  it("keeps short strings and cuts long ones on a character boundary", () => {
    expect(prepare.truncate("hello", 10)).toBe("hello");
    expect(prepare.truncate("ñññ", 5)).toBe("ññ"); // ñ is 2 bytes; a 5-byte cut would split one
    expect(prepare.truncate("a😀b", 4)).toBe("a"); // the emoji is 4 bytes
    expect(prepare.utf8Length(prepare.truncate("€".repeat(1000), 1024))).toBeLessThanOrEqual(1024);
  });

  it("counts UTF-8 bytes like the server", () => {
    expect(prepare.utf8Length("aé€😀")).toBe(1 + 2 + 3 + 4);
  });
});

describe("message, ids and names", () => {
  it("never sends an empty or oversized message", () => {
    expect(prepare.message("")).toBe("(empty)");
    expect(prepare.utf8Length(prepare.message("x".repeat(5000)))).toBe(2048);
  });

  it("drops empty ids and cuts long ones to 128 bytes", () => {
    expect(prepare.identifier("")).toBeUndefined();
    expect(prepare.identifier(null)).toBeUndefined();
    expect(prepare.identifier("u".repeat(300))).toHaveLength(128);
  });

  it("rewrites environment and platform names to the server's rule", () => {
    expect(prepare.name("Staging EU")).toBe("staging-eu");
    expect(prepare.name("__api__")).toBe("api");
    expect(prepare.name("x".repeat(40))).toHaveLength(32);
    expect(prepare.name("!!!")).toBeUndefined();
  });
});

describe("attributes", () => {
  it("keeps the supported types and rewrites bad names", () => {
    const attrs = prepare.attributes({
      "a.b": 1,
      _private: true,
      nested: { deep: { deeper: { deepest: { gone: 1 } } } },
      list: ["x", 2, null],
      missing: undefined,
      nan: Number.NaN,
      when: new Date("2026-11-18T10:00:00Z"),
      big: 10n,
    });
    expect(attrs).toEqual({
      a_b: 1,
      private: true,
      nested: { deep: { deeper: { deepest: '{"gone":1}' } } },
      list: ["x", "2", "null"],
      nan: null,
      when: "2026-11-18T10:00:00.000Z",
      big: "10",
    });
  });

  it("caps leaves at 200 and counts what it dropped", () => {
    const input: Record<string, number> = {};
    for (let i = 0; i < 250; i++) input[`k${String(i).padStart(3, "0")}`] = i;
    const attrs = prepare.attributes(input)!;
    expect(Object.keys(attrs)).toHaveLength(200);
    expect(attrs[prepare.DROPPED_MARKER]).toBe(51);
  });

  it("cuts long strings and long arrays", () => {
    const attrs = prepare.attributes({ s: "x".repeat(2000), a: Array.from({ length: 100 }, (_, i) => `${i}`) })!;
    expect(attrs.s).toHaveLength(1024);
    expect(attrs.a).toHaveLength(64);
  });

  it("keeps the first of names that collide once rewritten and counts the rest (L5)", () => {
    // "First" in the sorted order of the original names, so the outcome never depends on order.
    expect(prepare.attributes({ "a.b": 1, a_b: 2, _x: 3, x: 4, __x: 5 })).toEqual({ a_b: 1, x: 5, [prepare.DROPPED_MARKER]: 3 });
    expect(prepare.attributes({ "n.m": { p: 1, q: 2 }, n_m: "leaf" })).toEqual({ n_m: { p: 1, q: 2 }, [prepare.DROPPED_MARKER]: 1 });
    expect(prepare.attributes({ n_m: "leaf", "n.m": { p: 1, q: 2 } })).toEqual({ n_m: { p: 1, q: 2 }, [prepare.DROPPED_MARKER]: 1 });
  });

  it("survives cycles", () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    expect(prepare.attributes({ loop })).toEqual({ loop: { a: 1, self: '{"a":1,"self":"[circular]"}' } });
  });

  it("returns undefined for nothing", () => {
    expect(prepare.attributes(undefined)).toBeUndefined();
    expect(prepare.attributes({})).toBeUndefined();
  });
});

describe("payload", () => {
  it("serializes any JSON", () => {
    expect(prepare.payload({ a: [1, { b: "c" }] })).toBe('{"a":[1,{"b":"c"}]}');
    expect(prepare.payload(undefined)).toBeUndefined();
  });

  it("replaces a payload over 64 KiB by a summary", () => {
    const summary = JSON.parse(prepare.payload({ blob: "x".repeat(70_000) })!) as Record<string, unknown>;
    expect(summary.lyrelog_truncated).toBe(true);
    expect(summary.bytes as number).toBeGreaterThan(64 * 1024);
    expect(summary.at_least).toBe(true);
    expect((summary.preview as string).length).toBeLessThanOrEqual(1024);
    expect(summary.preview as string).toMatch(/^\{"blob":"xxx/);

    // Under 64 Ki characters but over 64 KiB of UTF-8: the exact size is known.
    const wide = JSON.parse(prepare.payload({ blob: "é".repeat(40_000) })!) as Record<string, unknown>;
    expect(wide).toMatchObject({ lyrelog_truncated: true, bytes: 80_011 });
    expect(wide.at_least).toBeUndefined();
  });

  it("stops serializing a huge value once past the budget (L4)", () => {
    let reads = 0;
    const item = {
      get v() {
        reads++;
        return "some value";
      },
    };
    const huge = Array.from({ length: 200_000 }, () => item);
    const summary = JSON.parse(prepare.payload({ huge })!) as Record<string, unknown>;
    expect(summary.lyrelog_truncated).toBe(true);
    expect(reads).toBeLessThan(10_000);

    reads = 0;
    expect(prepare.stringForm(huge).length).toBeLessThan(10_000);
    expect(reads).toBeLessThan(1_000);
    reads = 0;
    prepare.attributes({ big: [{ deep: { deeper: { deepest: { huge } } } }] });
    expect(reads).toBeLessThan(1_000);
  });

  it("serializes exactly like JSON.stringify (L4)", () => {
    const values: unknown[] = [
      { a: [1, "two", null, undefined, () => 1, Symbol("s"), Number.NaN, -0, 1e21, true] },
      { d: new Date(0), u: undefined, f() {}, nested: { s: 'quo"te\\ \n \u2028 😀 \ud800' } },
      [new Number(3), new String("s"), new Boolean(false), { toJSON: (k: string) => `key:${k}` }],
      Object.assign(Object.create(null), { z: 1, a: 2 }),
      new Map([[1, 2]]),
      new Uint8Array([1, 2]),
      { 2: "b", 1: "a", x: "c" },
      [],
      {},
      "plain",
      42,
      null,
    ];
    for (const value of values) {
      expect(prepare.payload(value)).toBe(JSON.stringify(value));
      expect(prepare.serialize(value, 1e9)).toEqual({ json: JSON.stringify(value), complete: true });
    }
    const loop: Record<string, unknown> = { n: 1n, e: new RangeError("r"), password: "p" };
    loop.self = loop;
    expect(prepare.serialize(loop, 1e9).json).toBe(prepare.payload(loop));
    expect(prepare.serialize({ s: "x".repeat(100) }, 20)).toEqual({ json: `{"s":"${"x".repeat(16)}"`, complete: false });
    expect(prepare.payload(() => 1)).toBeUndefined();
  });

  it("never throws on cycles or BigInt", () => {
    const loop: Record<string, unknown> = {};
    loop.loop = loop;
    expect(prepare.payload(loop)).toBe('{"loop":"[circular]"}');
    expect(prepare.payload({ n: 1n })).toBe('{"n":"1"}');
  });

  it("keeps a payload that fits, however many small items it has", () => {
    const numbers = Array.from({ length: 10_000 }, () => 1); // 20 KB of JSON
    expect(prepare.payload(numbers)).toBe(JSON.stringify(numbers));
    const flags = Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`k${i}`, 0])); // ~56 KB
    expect(prepare.payload(flags)).toBe(JSON.stringify(flags));
  });
});

describe("values that throw when read", () => {
  it("keeps the event: a getter or a proxy that throws costs only its own field", () => {
    const getter = { ok: 1, get boom(): number {
      throw new Error("getter");
    } };
    expect(prepare.attributes(getter)).toEqual({ ok: 1, lyrelog_dropped_attrs: 1 });
    const proxy = new Proxy({}, { ownKeys() {
      throw new Error("ownKeys");
    } });
    expect(() => prepare.attributes(proxy)).not.toThrow();
    expect(() => prepare.attributes({ p: proxy })).not.toThrow();
    const odd = new Error("m");
    Object.defineProperty(odd, "name", { get() {
      throw new Error("name");
    } });
    expect(prepare.stringForm(odd)).toBe("[unprintable]");
  });
});

