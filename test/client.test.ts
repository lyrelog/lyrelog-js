import { describe, expect, it, vi } from "vitest";
import { EXIT_FLUSH_MS } from "../src/client.js";
import { MemorySession } from "../src/platform.js";
import { fakePlatform, harness, json, ok } from "./helpers.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("event shape", () => {
  it("sends one NDJSON line per event, exactly the wire format", async () => {
    const { client, sent } = harness({ environment: "Staging", release: "2.0", appId: "com.example" });
    client.setUser("player-1");
    client.info("checkout_done", { category: "checkout", attrs: { items: 3 }, payload: { cart: ["a"] } });
    await client.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://ingest.test/v1/events:batch");
    expect(sent[0]!.headers.Authorization).toBe("Bearer lyr_ing_test");
    expect(sent[0]!.headers["Content-Type"]).toBe("application/x-ndjson");
    const [event] = sent[0]!.lines;
    expect(Object.keys(event!).sort()).toEqual(
      ["attrs", "category", "event_id", "install_id", "level", "message", "payload", "resource", "session_id", "ts", "user_id"].sort(),
    );
    expect(event).toMatchObject({
      level: "info",
      category: "checkout",
      message: "checkout_done",
      user_id: "player-1",
      install_id: "install-1",
      attrs: { items: 3 },
      payload: { cart: ["a"] },
      resource: {
        app_id: "com.example",
        app_version: "2.0",
        os_name: "test",
        os_version: "1",
        sdk: "lyrelog-js/0.9.1",
        environment: "staging",
        platform: "node",
      },
    });
    expect(event!.event_id).toMatch(UUID);
    expect(event!.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it("snapshots attrs and payload at log time", async () => {
    const { client, sent } = harness();
    const attrs = { n: 1 };
    const payload = { n: 1 };
    client.info("x", { attrs, payload });
    attrs.n = 2;
    payload.n = 2;
    await client.flush();
    expect(sent[0]!.lines[0]).toMatchObject({ attrs: { n: 1 }, payload: { n: 1 } });
  });

  it("drops levels below minimumLevel (debug by default)", async () => {
    const { client, sent } = harness({ minimumLevel: "warning" });
    client.trace("a");
    client.info("b");
    client.warning("c");
    client.critical("d");
    await client.flush();
    expect(sent[0]!.lines.map((e) => e.message)).toEqual(["c", "d"]);

    const fresh = harness();
    fresh.client.trace("t");
    fresh.client.debug("d");
    await fresh.client.flush();
    expect(fresh.sent[0]!.lines.map((e) => e.level)).toEqual(["debug"]);
  });

  it("logger(category) tags every event", async () => {
    const { client, sent } = harness();
    const auth = client.logger("auth");
    auth.warning("token_expired", { attrs: { retry: true } });
    auth.log("error", "token_refresh_failed");
    await client.flush();
    expect(sent[0]!.lines.map((e) => [e.category, e.level, e.message])).toEqual([
      ["auth", "warning", "token_expired"],
      ["auth", "error", "token_refresh_failed"],
    ]);
  });

  it("setUser(null) clears the user", async () => {
    const { client, sent } = harness();
    client.setUser("u");
    client.info("a");
    client.setUser(null);
    client.info("b");
    await client.flush();
    expect(sent[0]!.lines.map((e) => e.user_id)).toEqual(["u", undefined]);
  });

  it("screen() logs screen_viewed and tags what follows", async () => {
    let now = 1_000_000;
    const { client, sent } = harness({}, ok, fakePlatform(), { now: () => now });
    client.screen("Home");
    now += 2500;
    client.screen("Settings");
    client.screen("Settings"); // same screen: nothing
    client.info("toggled");
    await client.flush();
    const lines = sent[0]!.lines;
    expect(lines.map((e) => e.message)).toEqual(["screen_viewed", "screen_viewed", "toggled"]);
    expect(lines[1]).toMatchObject({
      category: "navigation",
      attrs: { screen: "Settings", previous_screen: "Home", seconds_on_previous: 2.5 },
    });
    expect(lines[2]!.attrs).toEqual({ screen: "Settings" });
  });

  it("captureError puts type and message in attrs, the stack in the payload", async () => {
    const { client, sent } = harness();
    const error = new TypeError("boom", { cause: new Error("root") });
    client.captureError(error, { category: "checkout", attrs: { step: 2 } });
    client.captureError("a string");
    await client.flush();
    const [first, second] = sent[0]!.lines;
    expect(first).toMatchObject({
      level: "error",
      message: "exception",
      category: "checkout",
      attrs: { step: 2, error_type: "TypeError", error_message: "boom" },
      payload: { name: "TypeError", message: "boom", cause: { name: "Error", message: "root" } },
    });
    expect((first!.payload as { stack: string }).stack).toContain("TypeError: boom");
    expect(second).toMatchObject({ attrs: { error_type: "string", error_message: "a string" }, payload: { value: "a string" } });
  });

  it("never throws, whatever it is given", () => {
    const { client } = harness();
    const hostile = {
      get boom() {
        throw new Error("getter");
      },
    };
    expect(() => client.info(undefined as unknown as string, { attrs: hostile, payload: hostile })).not.toThrow();
    expect(() => client.captureError(hostile)).not.toThrow();
  });

  it("starts a new session after 30 minutes idle when the platform says so", () => {
    const session = new MemorySession(30 * 60 * 1000);
    const a = session.touch(0);
    expect(session.touch(29 * 60 * 1000)).toBe(a);
    expect(session.touch(60 * 60 * 1000)).not.toBe(a);
  });
});

describe("batching", () => {
  it("up to 500 events per request", async () => {
    const { client, sent } = harness();
    for (let i = 0; i < 1201; i++) client.info(`e${i}`);
    await client.flush();
    expect(sent.map((s) => s.lines.length)).toEqual([500, 500, 201]);
    expect(sent.flatMap((s) => s.lines.map((e) => e.message))[1200]).toBe("e1200");
  });

  it("about 512 KiB per request", async () => {
    const { client, sent } = harness();
    const big = "x".repeat(60_000);
    for (let i = 0; i < 20; i++) client.info("big", { payload: { big } });
    await client.flush();
    expect(sent.length).toBeGreaterThanOrEqual(3);
    for (const s of sent) expect(JSON.stringify(s.lines).length).toBeLessThan(600 * 1024);
    expect(sent.reduce((n, s) => n + s.lines.length, 0)).toBe(20);
  });

  it("gzips when the platform can", async () => {
    const { gzipSync } = await import("node:zlib");
    const platform = fakePlatform({ compress: async (body) => new Uint8Array(gzipSync(body)) });
    const { client, sent } = harness({}, ok, platform);
    client.info("zipped");
    await client.flush();
    expect(sent[0]!.headers["Content-Encoding"]).toBe("gzip");
    expect(sent[0]!.lines[0]!.message).toBe("zipped");
  });

  it("sends on the timer", async () => {
    vi.useFakeTimers();
    try {
      const { client, sent } = harness({ flushIntervalMs: 5000 });
      client.info("later");
      expect(sent).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(sent).toHaveLength(1);
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("delivery outcomes", () => {
  it("2xx with rejected lines: delivered, never resent", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const { client, sent } = harness({}, () => json(200, { accepted: 1, rejected: [{ line: 2, error: "bad" }] }));
    client.info("a");
    client.info("b");
    await client.flush();
    await client.flush();
    expect(sent).toHaveLength(1);
    expect(client.stats()).toMatchObject({ queued: 0, delivered: 1, rejected: 1 });
    expect(debug).toHaveBeenCalledTimes(1);
    debug.mockRestore();
  });

  it("400 and 413 drop the batch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const status of [400, 413]) {
      const { client, sent } = harness({}, () => json(status, { error: "no" }));
      client.info("a");
      await client.flush();
      await client.flush();
      expect(sent).toHaveLength(1);
      expect(client.stats().queued).toBe(0);
    }
  });

  it("401 stops sending and keeps the data", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const { client, sent } = harness({}, () => json(401, { error: "unauthorized" }));
    client.info("a");
    await client.flush();
    client.info("b");
    await client.flush();
    expect(sent).toHaveLength(1);
    expect(client.stats()).toMatchObject({ queued: 2, disabled: true });
    debug.mockRestore();
  });

  it("429 with Retry-After: the same events again, not before the server said", async () => {
    let now = 0;
    const answers = [json(429, "", { "Retry-After": "30" }), undefined];
    const { client, sent } = harness({}, (s, i) => answers[i] ?? ok(s), fakePlatform(), { now: () => now });
    client.info("a");
    await client.flush();
    expect(client.stats().queued).toBe(1);

    // The timer respects the backoff...
    await (client as unknown as { schedule(force: boolean): Promise<void> }).schedule(false);
    expect(sent).toHaveLength(1);
    now = 31_000;
    await (client as unknown as { schedule(force: boolean): Promise<void> }).schedule(false);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.lines[0]!.event_id).toBe(sent[0]!.lines[0]!.event_id);
    expect(sent[1]!.lines[0]!.ts).toBe(sent[0]!.lines[0]!.ts);
    expect(client.stats().queued).toBe(0);
  });

  it("flush() and close() never override the server's Retry-After, and return at once (M1)", async () => {
    let now = 0;
    const { client, sent } = harness({}, (s, i) => (i === 0 ? json(429, "", { "Retry-After": "3600" }) : ok(s)), fakePlatform(), {
      now: () => now,
    });
    client.info("a");
    await client.flush();
    expect(sent).toHaveLength(1);
    await client.flush();
    client.info("b");
    await client.flush();
    expect(sent).toHaveLength(1);
    now = 3_600_001;
    await client.flush();
    expect(sent.slice(1).flatMap((s) => s.lines.map((e) => e.message))).toEqual(["a", "b"]);
    expect(client.stats()).toMatchObject({ queued: 0, delivered: 2 });

    const closing = harness({}, () => json(429, "", { "Retry-After": "3600" }));
    closing.client.info("a");
    await closing.client.flush();
    await closing.client.close();
    expect(closing.sent).toHaveLength(1);
  });

  it("the monthly quota 429 warns once, and again after a batch is accepted; a rate-limit 429 doesn't", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = "this organization's free plan includes 1000000 events a month and they're used: upgrade it, or events resume on 1 December";
    const quota = () =>
      json(429, { error, plan: "free", limit: 1_000_000, used: 1_000_123 }, { "Content-Type": "application/json", "Retry-After": "3600" });
    const rateLimit = () => json(429, { error: "rate limit for this project" }, { "Content-Type": "application/json", "Retry-After": "1" });
    let now = 0;
    const answers = [rateLimit, quota, quota, ok, quota, () => json(429, "<html>busy</html>", { "Retry-After": "1" }), ok];
    const { client, sent } = harness({ maxQueue: 2_000, maxQueueBytes: 4 * 1024 * 1024 }, (s, i) => (answers[i] ?? ok)(s), fakePlatform(), {
      now: () => now,
    });
    client.info("a");
    const step = async () => {
      now += 3_600_001;
      await client.flush();
    };

    await step(); // rate limit
    expect(warn).not.toHaveBeenCalled();
    await step(); // quota
    await step(); // quota again: quiet
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe(
      `[lyrelog] ${error}. Events are kept and sent when sending resumes; how many wait depends on the platform ` +
        "(here: in memory, up to 2000 events and 4 MiB, oldest dropped first; lost if the process or page ends).",
    );
    expect(String(warn.mock.calls[0]![0])).not.toContain("lyr_ing_test");
    expect(client.stats()).toMatchObject({ queued: 1, delivered: 0 });

    await step(); // accepted: resets
    client.info("b");
    await step(); // quota: warns again
    expect(warn).toHaveBeenCalledTimes(2);
    await step(); // a 429 with a body that isn't JSON is a plain retry
    await step();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(7);
    expect(client.stats()).toMatchObject({ queued: 0, delivered: 2 });
    warn.mockRestore();
  });

  it("5xx and network errors retry; flush() ignores the backoff", async () => {
    const answers: (Response | Error)[] = [json(503, ""), new TypeError("offline")];
    const { client, sent } = harness({}, (s, i) => answers[i] ?? ok(s));
    client.info("a");
    await client.flush();
    await client.flush();
    expect(client.stats().queued).toBe(1);
    await client.flush();
    expect(sent).toHaveLength(3);
    expect(client.stats()).toMatchObject({ queued: 0, delivered: 1 });
  });

  it("a retried batch is resent with the same body", async () => {
    const bodies: string[] = [];
    const { client } = harness({}, (s, i) => {
      bodies.push(JSON.stringify(s.lines));
      return i === 0 ? json(500, "") : ok(s);
    });
    client.info("a");
    await client.flush();
    client.info("b"); // arrives while the first batch waits: goes in the next batch
    await client.flush();
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies).toHaveLength(3);
  });
});

describe("queue cap", () => {
  it("drops the oldest beyond maxQueue and counts them", async () => {
    const { client, sent } = harness({ maxQueue: 100 });
    for (let i = 0; i < 150; i++) client.info(`e${i}`);
    expect(client.stats()).toMatchObject({ queued: 100, dropped: 50 });
    await client.flush();
    const messages = sent.flatMap((s) => s.lines.map((e) => e.message));
    expect(messages[0]).toBe("e50");
    expect(messages).toHaveLength(100);
  });

  it("counts a batch waiting for a retry and drops its oldest events first, one by one (L6)", async () => {
    let fail = true;
    const { client, sent } = harness({ maxQueue: 10 }, (s) => (fail ? json(503, "") : ok(s)));
    for (let i = 0; i < 10; i++) client.info(`old${i}`);
    await client.flush(); // one batch of 10 now waits for a retry
    client.info("new");
    expect(client.stats()).toMatchObject({ queued: 10, dropped: 1 });
    fail = false;
    await client.flush();
    expect(sent.slice(1).flatMap((s) => s.lines.map((e) => e.message))).toEqual([
      ...Array.from({ length: 9 }, (_, i) => `old${i + 1}`),
      "new",
    ]);
  });

  it("is bounded in bytes too: maxQueueBytes, 16 MiB by default (H2)", async () => {
    const { client, sent } = harness({ maxQueueBytes: 100_000 });
    const filler = "x".repeat(1000);
    for (let i = 0; i < 300; i++) client.info(`e${i}`, { attrs: { a: filler, b: filler, c: filler, d: filler, e: filler, f: filler, g: filler, h: filler, i: filler, j: filler } });
    const stats = client.stats();
    expect(stats.queuedBytes).toBeLessThanOrEqual(100_000);
    expect(stats.dropped).toBeGreaterThan(200);
    expect(stats.queued + stats.dropped).toBe(300);
    await client.flush();
    expect(sent.flatMap((s) => s.lines).at(-1)!.message).toBe("e299");

    const defaults = harness();
    const big = "y".repeat(60 * 1024);
    for (let i = 0; i < 400; i++) defaults.client.info("big", { payload: { big } });
    expect(defaults.client.stats().queuedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(defaults.client.stats().dropped).toBeGreaterThan(100);
  });

  it("counts a waiting batch's gzipped copy in the byte cap (H2)", async () => {
    const platform = fakePlatform({ compress: async (body) => new Uint8Array(body.length + 50_000) });
    const { client } = harness({ maxQueueBytes: 60_000 }, () => json(503, ""), platform);
    client.info("a");
    await client.flush(); // waits, with a 50 KB compressed copy
    expect(client.stats().queuedBytes).toBeGreaterThan(50_000);
    client.info("b", { payload: { pad: "z".repeat(20_000) } });
    // The copy goes before any event: it can be made again.
    expect(client.stats().queuedBytes).toBeLessThanOrEqual(60_000);
    expect(client.stats()).toMatchObject({ queued: 2, dropped: 0 });
    client.info("c", { payload: { pad: "z".repeat(50_000) } });
    expect(client.stats().queuedBytes).toBeLessThanOrEqual(60_000);
    expect(client.stats()).toMatchObject({ queued: 1, dropped: 2 });
  });
});

describe("consent", () => {
  it("pending keeps events unsent until granted; denied drops everything", async () => {
    const { client, sent } = harness({ consent: "pending" });
    client.info("a");
    await client.flush();
    expect(sent).toHaveLength(0);
    client.setConsent("granted");
    await client.flush();
    expect(sent[0]!.lines.map((e) => e.message)).toEqual(["a"]);

    client.setConsent("pending");
    client.info("b");
    client.setConsent("denied");
    client.info("c");
    expect(client.stats().queued).toBe(0);
  });
});

describe("close", () => {
  it("flushes what is queued and ignores logging afterwards", async () => {
    const { client, sent, platform } = harness();
    client.info("a");
    client.info("b");
    await client.close();
    expect(sent[0]!.lines.map((e) => e.message)).toEqual(["a", "b"]);
    expect(platform.hooks).toBeUndefined();
    client.info("c");
    await client.flush();
    expect(sent).toHaveLength(1);
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("waits for an upload already running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { client, sent } = harness({}, async (s) => {
      await gate;
      return ok(s);
    });
    client.info("a");
    const first = client.flush();
    client.info("b");
    const closing = client.close();
    release();
    await Promise.all([first, closing]);
    expect(sent.flatMap((s) => s.lines.map((e) => e.message))).toEqual(["a", "b"]);
  });

  it("Node's beforeExit flushes once per new batch of events", async () => {
    const { client, sent, platform } = harness({}, () => json(503, ""));
    client.info("a");
    platform.hooks!.exit();
    await client.flush();
    platform.hooks!.exit(); // nothing new since: no loop
    await Promise.resolve();
    expect(sent).toHaveLength(2); // the exit flush and the explicit one
  });

  it("the flush at beforeExit stops after EXIT_FLUSH_MS: a slow or hung ingest never holds the process", async () => {
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    let now = 0;
    // Each request takes 4 s: the first gets the whole budget, the second what is left, no third.
    const { client, sent, platform } = harness({ maxQueue: 2000 }, (s) => {
      now += 4000;
      return ok(s);
    }, fakePlatform(), { now: () => now });
    for (let i = 0; i < 1500; i++) client.info("a"); // three batches
    platform.hooks!.exit();
    await (client as unknown as { chain: Promise<void> }).chain;
    expect(timeouts.mock.calls.map((c) => c[0])).toEqual([EXIT_FLUSH_MS, EXIT_FLUSH_MS - 4000]);
    expect(sent).toHaveLength(2);
    await client.close();
  });
});

describe("page hide (web)", () => {
  it("sends uncompressed with keepalive, within the 64 KB budget", async () => {
    const { gzipSync } = await import("node:zlib");
    const platform = fakePlatform({ name: "web", keepalive: true, compress: async (b) => new Uint8Array(gzipSync(b)) });
    const { client, sent } = harness({}, ok, platform);
    const filler = "x".repeat(1000);
    for (let i = 0; i < 100; i++) client.info(`e${i}`, { attrs: { filler } }); // ~110 KB
    platform.hooks!.hide();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.length).toBeGreaterThanOrEqual(1);
    for (const s of sent) {
      expect(s.keepalive).toBe(true);
      expect(s.headers["Content-Encoding"]).toBeUndefined();
    }
    const total = sent.reduce((n, s) => n + s.lines.map((e) => JSON.stringify(e)).join("\n").length, 0);
    expect(total).toBeLessThanOrEqual(60 * 1024);
    const rest = client.stats().queued;
    expect(rest).toBeGreaterThan(0);
    expect(rest + sent.reduce((n, s) => n + s.lines.length, 0)).toBe(100);

    await client.flush(); // the page came back: the rest goes the normal way
    expect(client.stats().queued).toBe(0);
    expect(sent.at(-1)!.keepalive).toBe(false);
  });

  it("puts a keepalive batch back when it fails", async () => {
    const platform = fakePlatform({ name: "web", keepalive: true });
    const { client, sent } = harness({}, (s, i) => (i === 0 ? new TypeError("unloading") : ok(s)), platform);
    client.info("a");
    platform.hooks!.hide();
    await new Promise((r) => setTimeout(r, 0));
    expect(client.stats().queued).toBe(1);
    await client.flush();
    expect(sent).toHaveLength(2);
    expect(client.stats()).toMatchObject({ queued: 0, delivered: 1 });
  });
});

describe("configuration", () => {
  it("without endpoint or key it logs nothing and never throws", async () => {
    vi.spyOn(console, "warn").mockImplementationOnce(() => undefined);
    const { client, sent } = harness({ apiKey: "" });
    client.info("a");
    await client.flush();
    await client.close();
    expect(sent).toHaveLength(0);
  });

  it("platform and environment can be overridden and are normalised", () => {
    const { client } = harness({ platform: "API", environment: "Prod EU" });
    expect(client.resource.platform).toBe("api");
    expect(client.resource.environment).toBe("prod-eu");
  });
});

describe("event size", () => {
  it("drops an event over the ingest's 1 MiB per line instead of sending it", async () => {
    const { client, sent } = harness();
    const big: Record<string, string[]> = {};
    for (let i = 0; i < 60; i++) big[`k${i}`] = Array.from({ length: 64 }, () => "x".repeat(1000));
    client.info("huge", { attrs: big });
    client.info("small");
    await client.flush();
    const lines = sent.flatMap((s) => s.lines);
    expect(lines.map((l) => (l as { message: string }).message)).toEqual(["small"]);
    expect(client.stats().dropped).toBe(1);
  });
});

describe("never throws into the host (1.0 audit)", () => {
  it("setUser with a value that can't be made a string", async () => {
    const { client, sent } = harness();
    expect(() => client.setUser(Symbol("id") as unknown as string)).not.toThrow();
    expect(() => client.setUser({ toString: () => { throw new Error("no"); } } as unknown as string)).not.toThrow();
    expect(() => client.setUser(Object.create(null) as string)).not.toThrow();
    client.info("after");
    await client.flush();
    expect(sent[0]!.lines[0]!.user_id).toBeUndefined();
  });

  it("starts where timers are refused at first (Cloudflare Workers' global scope), and sends later", async () => {
    const setInterval = globalThis.setInterval;
    const refuse = () => {
      throw new Error("Disallowed operation called within global scope");
    };
    vi.stubGlobal("setInterval", refuse);
    let made: ReturnType<typeof harness> | undefined;
    try {
      expect(() => (made = harness())).not.toThrow();
    } finally {
      vi.stubGlobal("setInterval", setInterval);
    }
    const { client, sent } = made!;
    client.info("in_a_request");
    expect((client as unknown as { timer: unknown }).timer).toBeDefined(); // started on first use
    await client.flush();
    expect(sent).toHaveLength(1);
    await client.close();
  });

  it("an event logged from inside beforeSend doesn't recurse", async () => {
    let calls = 0;
    const { client, sent } = harness({
      beforeSend(event) {
        calls++;
        client.info("from_before_send");
        return event;
      },
    });
    client.info("outer");
    await client.flush();
    expect(calls).toBe(1);
    expect(sent.flatMap((s) => s.lines.map((l) => l.message))).toEqual(["outer"]);
  });
});

describe("exceptions with odd shapes (1.0 audit)", () => {
  it("a huge message keeps the stack in the payload", async () => {
    const { client, sent } = harness();
    client.captureError(new Error("x".repeat(100_000)));
    await client.flush();
    const payload = sent[0]!.lines[0]!.payload as Record<string, unknown>;
    expect(payload.lyrelog_truncated).toBeUndefined();
    expect(typeof payload.stack).toBe("string");
    expect(payload.name).toBe("Error");
    expect(payload.stack as string).toMatch(/\n\s+at /);
  });

  it("an Error whose stack or name getter throws is still recorded", async () => {
    const { client, sent } = harness();
    const odd = new Error("odd");
    Object.defineProperty(odd, "stack", { get() {
      throw new Error("stack");
    } });
    Object.defineProperty(odd, "name", { get() {
      throw new Error("name");
    } });
    client.captureError(odd);
    await client.flush();
    expect(sent[0]!.lines[0]).toMatchObject({ message: "exception", attrs: { error_message: "odd" } });
  });
});

describe("monthly quota (1.0 audit)", () => {
  it("is not counted as a failed attempt (sdk-spec rule 4)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client } = harness({}, () => json(429, { error: "used", plan: "free" }, { "Retry-After": "0" }));
    client.info("q");
    await client.flush();
    await client.flush();
    expect((client as unknown as { attempt: number }).attempt).toBe(0);
  });
});
