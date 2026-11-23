import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOSE_TIMEOUT_MS, MIN_FLUSH_INTERVAL_MS } from "../src/client.js";
import { Lyrelog } from "../src/node.js";
import { uuid } from "../src/platform.js";
import { MAX_RETRY_AFTER_MS, classify, parseRetryAfter } from "../src/upload.js";
import { fakePlatform, harness, json, ok } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("captureError (0.9.0, decision 3)", () => {
  it("is the name; captureException is a deprecated alias that does the same", async () => {
    const { client, sent } = harness();
    client.captureError(new TypeError("boom"), { category: "checkout", attrs: { step: "pay" } });
    client.captureException(new RangeError("old"));
    await client.flush();
    expect(sent[0]!.lines.map((e) => [e.message, e.category, (e.attrs as Record<string, unknown>).error_type])).toEqual([
      ["exception", "checkout", "TypeError"],
      ["exception", undefined, "RangeError"],
    ]);
    expect((sent[0]!.lines[0]!.attrs as Record<string, unknown>).step).toBe("pay");
  });
});

describe("warn() (0.9.0)", () => {
  it("is warning() under the name JavaScript developers expect, on the client and a logger", async () => {
    const { client, sent } = harness();
    client.warn("slow");
    client.logger("jobs").warn("late");
    await client.flush();
    expect(sent[0]!.lines.map((e) => [e.level, e.message, e.category])).toEqual([
      ["warning", "slow", undefined],
      ["warning", "late", "jobs"],
    ]);
  });
});

describe("init takes only the config (0.9.0)", () => {
  it("a second argument can't swap the network, the clock or the dice", async () => {
    const real = vi.fn(async () => json(200, { accepted: 1, rejected: [] }));
    vi.stubGlobal("fetch", real);
    const injected = vi.fn(async () => json(200, { accepted: 1, rejected: [] }));
    const init = Lyrelog.init as unknown as (config: unknown, deps: unknown) => ReturnType<typeof Lyrelog.init>;
    const client = init({ endpoint: "https://ingest.test", apiKey: `lyr_ing_${uuid()}` }, { fetch: injected, now: () => 0 });
    client.info("a");
    await client.flush();
    expect(injected).not.toHaveBeenCalled();
    expect(real).toHaveBeenCalledTimes(1);
    expect(Lyrelog.init.length).toBe(1);
    await client.close();
  });
});

describe("an invalid consent (0.9.0)", () => {
  it("is pending, with one warning, at init and in setConsent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client, sent } = harness({ consent: "yes" as never });
    client.info("a");
    await client.flush();
    expect(sent).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('consent "yes"');
    client.setConsent("granted");
    await client.flush();
    expect(sent).toHaveLength(1);

    client.setConsent(true as never);
    client.info("b");
    await client.flush();
    expect(sent).toHaveLength(1); // held, not sent
    expect(client.stats().queued).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1); // said once
  });
});

describe("flush and close take a timeout (0.9.0)", () => {
  const hung = () => new Promise<Response>(() => undefined);

  it("close() waits at most 5 s by default, and { timeoutMs } when given", async () => {
    expect(CLOSE_TIMEOUT_MS).toBe(5000);
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    const { client } = harness({}, hung);
    client.info("a");
    const started = Date.now();
    await client.close({ timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(timeouts.mock.calls[0]![0]).toBeLessThanOrEqual(50);

    const other = harness({}, hung);
    other.client.info("a");
    timeouts.mockClear();
    void other.client.close();
    await new Promise((r) => setTimeout(r, 10));
    expect(timeouts.mock.calls[0]![0]).toBeLessThanOrEqual(CLOSE_TIMEOUT_MS);
    expect(timeouts.mock.calls[0]![0]).toBeGreaterThan(CLOSE_TIMEOUT_MS - 1000);
  });

  it("flush({ timeoutMs }) returns by then, even behind an upload already running", async () => {
    const { client } = harness({}, hung);
    client.info("a");
    void client.flush(); // a request that never answers (until its own 30 s timeout)
    client.info("b");
    const started = Date.now();
    await client.flush({ timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("a second close() with its own timeout doesn't wait for the first one's", async () => {
    const { client } = harness({}, hung);
    client.info("a");
    void client.close({ timeoutMs: 10_000 });
    const started = Date.now();
    await client.close({ timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("Retry-After is capped at an hour (0.9.0, decision 4)", () => {
  it("in seconds, as a date, and as a number too big to hold", () => {
    expect(MAX_RETRY_AFTER_MS).toBe(3_600_000);
    expect(parseRetryAfter("86400")).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter("9".repeat(400))).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter("Fri, 01 Jan 2100 00:00:00 GMT", Date.parse("2026-11-21T00:00:00Z"))).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(classify(429, "", "999999")).toEqual({ kind: "retry", afterMs: MAX_RETRY_AFTER_MS });
  });
});

describe("the flush interval is at least 1 s (0.9.0, decision 5)", () => {
  it("raises a smaller value", async () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const { client } = harness({ flushIntervalMs: 10 });
    expect(MIN_FLUSH_INTERVAL_MS).toBe(1000);
    expect(spy.mock.calls.at(-1)![1]).toBe(1000);
    await client.close();
    const kept = harness({ flushIntervalMs: 2500 });
    expect(spy.mock.calls.at(-1)![1]).toBe(2500);
    await kept.client.close();
  });
});

describe("one warning while the network stays down (0.9.0, decision 7)", () => {
  it("after 3 failed uploads in a row, then quiet until one succeeds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let failing = true;
    const { client } = harness({}, (s) => (failing ? new TypeError("offline") : ok(s)), fakePlatform());
    client.info("a");
    const down = (text: unknown) => String(text).includes("in a row");
    await client.flush();
    await client.flush();
    expect(warn.mock.calls.filter((c) => down(c[0]))).toHaveLength(0);
    await client.flush();
    expect(warn.mock.calls.filter((c) => down(c[0]))).toHaveLength(1);
    expect(String(warn.mock.calls.find((c) => down(c[0]))![0])).not.toContain("lyr_ing_test");
    await client.flush();
    await client.flush();
    expect(warn.mock.calls.filter((c) => down(c[0]))).toHaveLength(1);

    failing = false;
    await client.flush(); // accepted: re-arms
    failing = true;
    client.info("b");
    for (let i = 0; i < 3; i++) await client.flush();
    expect(warn.mock.calls.filter((c) => down(c[0]))).toHaveLength(2);
  });

  it("the monthly quota is not a failure: it never says the network is down", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let now = 0;
    const { client } = harness({}, () => json(429, { error: "used", plan: "free" }, { "Retry-After": "1" }), fakePlatform(), {
      now: () => now,
    });
    client.info("q");
    for (let i = 0; i < 5; i++) {
      now += 2000;
      await client.flush();
    }
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("in a row"))).toHaveLength(0);
  });
});
