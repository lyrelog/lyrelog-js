import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "../src/client.js";
import { fileSpool, nodePlatform, spoolPath, SPOOL_MAX_BYTES } from "../src/platform-node.js";
import { errorFromEvent, webPlatform } from "../src/platform-web.js";
import type { UncaughtHandler } from "../src/platform.js";
import { fakePlatform, harness, ok, uuid } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

/** A stubbed `window`: listeners on an EventTarget, counted so a test can see them go. */
function stubWindow() {
  const target = new EventTarget();
  const live = new Map<string, number>();
  vi.stubGlobal("addEventListener", (type: string, fn: EventListener) => {
    live.set(type, (live.get(type) ?? 0) + 1);
    target.addEventListener(type, fn);
  });
  vi.stubGlobal("removeEventListener", (type: string, fn: EventListener) => {
    live.set(type, (live.get(type) ?? 0) - 1);
    target.removeEventListener(type, fn);
  });
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  const fire = (type: string, fields: Record<string, unknown>) => {
    const event = Object.assign(new Event(type, { cancelable: true }), fields);
    target.dispatchEvent(event);
    return event;
  };
  return { live, fire };
}

describe("browser", () => {
  it("records window error and unhandledrejection as unhandled exceptions, without preventDefault", async () => {
    const win = stubWindow();
    const { client, sent } = harness({}, ok, webPlatform);
    const error = new TypeError("x is undefined");
    const first = win.fire("error", { error, message: "Uncaught TypeError: x is undefined", filename: "https://a.test/app.js", lineno: 3, colno: 7 });
    const second = win.fire("unhandledrejection", { reason: new RangeError("too far") });
    win.fire("unhandledrejection", { reason: "plain text" });
    win.fire("error", { error: null, message: "boom", filename: "https://a.test/b.js", lineno: 10, colno: 2 });
    expect(first.defaultPrevented).toBe(false);
    expect(second.defaultPrevented).toBe(false);
    await client.flush();

    const events = sent.flatMap((s) => s.lines);
    expect(events.map((e) => [e.message, e.level, e.attrs])).toEqual([
      ["exception", "error", { handled: false, mechanism: "onerror", error_type: "TypeError", error_message: "x is undefined" }],
      ["exception", "error", { handled: false, mechanism: "onunhandledrejection", error_type: "RangeError", error_message: "too far" }],
      ["exception", "error", { handled: false, mechanism: "onunhandledrejection", error_type: "string", error_message: "plain text" }],
      ["exception", "error", { handled: false, mechanism: "onerror", error_type: "Error", error_message: "boom" }],
    ]);
    expect((events[0]!.payload as { stack: string }).stack).toContain("TypeError: x is undefined");
    expect((events[3]!.payload as { stack: string }).stack).toContain("https://a.test/b.js:10:2");
    await client.close();
  });

  it("strips query strings and fragments from URLs in stacks and file names (M3)", async () => {
    const win = stubWindow();
    const { client, sent } = harness({}, ok, webPlatform);
    const error = new Error("boom");
    error.stack = [
      "Error: boom",
      "    at load (https://a.test/app.js?token=abc123&x=1:3:7)",
      "    at https://a.test/b.js?v=2#frag:10:2",
      "f@https://a.test/c.js?session=zzz:5:1",
      "    at native (https://a.test/d.js:1:1)",
    ].join("\n");
    const cause = new Error("inner");
    cause.stack = "Error: inner\n    at https://a.test/e.js?key=k:2:3";
    (error as { cause?: unknown }).cause = cause;
    win.fire("error", { error, message: "Uncaught Error: boom", filename: "https://a.test/app.js?token=abc123", lineno: 3, colno: 7 });
    win.fire("error", { error: null, message: "boom2", filename: "https://a.test/f.js?token=abc123#x", lineno: 4, colno: 1 });
    await client.flush();
    const text = JSON.stringify(sent.flatMap((s) => s.lines));
    for (const leak of ["token", "abc123", "session=", "zzz", "key=k", "#frag", "v=2"]) expect(text).not.toContain(leak);
    const [first, second] = sent.flatMap((s) => s.lines);
    expect((first!.payload as { stack: string }).stack).toBe(
      [
        "Error: boom",
        "    at load (https://a.test/app.js:3:7)",
        "    at https://a.test/b.js:10:2",
        "f@https://a.test/c.js:5:1",
        "    at native (https://a.test/d.js:1:1)",
      ].join("\n"),
    );
    expect((second!.payload as { stack: string }).stack).toContain("https://a.test/f.js:4:1");
    await client.close();
  });

  it("ignores the opaque cross-origin \"Script error.\"", async () => {
    const win = stubWindow();
    const { client, sent } = harness({}, ok, webPlatform);
    win.fire("error", { error: null, message: "Script error.", filename: "", lineno: 0, colno: 0 });
    await client.flush();
    expect(sent).toHaveLength(0);
    expect(client.stats().skippedErrors).toBe(0);
    expect(errorFromEvent({ message: "Script error.", filename: "", lineno: 0, colno: 0 })).toBeUndefined();
    await client.close();
  });

  it("removes its listeners on close", async () => {
    const win = stubWindow();
    const { client, sent } = harness({}, ok, webPlatform);
    expect(win.live.get("error")).toBe(1);
    expect(win.live.get("unhandledrejection")).toBe(1);
    await client.close();
    expect(win.live.get("error")).toBe(0);
    expect(win.live.get("unhandledrejection")).toBe(0);
    win.fire("error", { error: new Error("late") });
    await client.flush();
    expect(sent).toHaveLength(0);
  });

  it("adds nothing with captureErrors: false", async () => {
    const win = stubWindow();
    const { client } = harness({ captureErrors: false }, ok, webPlatform);
    expect(win.live.get("error")).toBeUndefined();
    expect(win.live.get("unhandledrejection")).toBeUndefined();
    await client.close();
  });
});

describe("flood guard", () => {
  function withHandler(now: () => number) {
    let handler: UncaughtHandler | undefined;
    const platform = fakePlatform({
      installErrors(h) {
        handler = h;
        return () => {
          handler = undefined;
        };
      },
    });
    const h = harness({}, ok, platform, { now });
    return { ...h, raise: (error: unknown) => handler!(error, "onerror") };
  }

  it("records the same error once per 10 s", async () => {
    let now = 1_000_000;
    const { client, sent, raise } = withHandler(() => now);
    const error = new Error("same");
    raise(error);
    raise(error);
    now += 9_999;
    raise(error);
    now += 1;
    raise(error);
    raise(new Error("other"));
    await client.flush();
    expect(sent.flatMap((s) => s.lines).map((e) => (e.attrs as { error_message: string }).error_message)).toEqual(["same", "same", "other"]);
    expect(client.stats().skippedErrors).toBe(2);
    await client.close();
  });

  it("records at most 10 a minute", async () => {
    let now = 1_000_000;
    const { client, sent, raise } = withHandler(() => now);
    for (let i = 0; i < 15; i++) raise(new Error(`error ${i}`));
    now += 60_000;
    raise(new Error("a minute later"));
    await client.flush();
    expect(sent.flatMap((s) => s.lines)).toHaveLength(11);
    expect(client.stats().skippedErrors).toBe(5);
    await client.close();
  });

  it("leaves captureError alone", async () => {
    const { client, sent } = withHandler(() => 0);
    for (let i = 0; i < 20; i++) client.captureError(new Error("handled"));
    await client.flush();
    expect(sent.flatMap((s) => s.lines)).toHaveLength(20);
    expect(client.stats().skippedErrors).toBe(0);
    await client.close();
  });
});

describe("node", () => {
  const fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch;

  function newListeners<T>(event: string, before: unknown[]): T[] {
    return process.listeners(event as "uncaughtExceptionMonitor").filter((l) => !before.includes(l)) as T[];
  }

  it("uses uncaughtExceptionMonitor, never uncaughtException or unhandledRejection", async () => {
    const counts = () => ({
      monitor: process.listenerCount("uncaughtExceptionMonitor"),
      exception: process.listenerCount("uncaughtException"),
      rejection: process.listenerCount("unhandledRejection"),
    });
    const before = counts();
    const client = new Client({ endpoint: "https://ingest.test", apiKey: `lyr_ing_${uuid()}` }, nodePlatform, { fetch });
    expect(counts()).toEqual({ ...before, monitor: before.monitor + 1 });
    await client.close();
    expect(counts()).toEqual(before);

    const off = new Client({ endpoint: "https://ingest.test", apiKey: `lyr_ing_${uuid()}`, captureErrors: false }, nodePlatform, { fetch });
    expect(counts()).toEqual(before);
    await off.close();
  });

  it("spools a crash synchronously and sends it on the next init with the same key", async () => {
    const apiKey = `lyr_ing_${uuid()}`;
    const file = spoolPath(apiKey);
    expect(file).toMatch(/lyrelog-[^/]+\/[0-9a-f]{12}\.ndjson$/);
    const before = process.listeners("uncaughtExceptionMonitor");
    const crashed = new Client({ endpoint: "https://ingest.test", apiKey, release: "1.0" }, nodePlatform, { fetch });
    const [monitor] = newListeners<(e: Error, origin: string) => void>("uncaughtExceptionMonitor", before);
    monitor!(new Error("kaboom"), "unhandledRejection");

    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const spooled = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(spooled).toHaveLength(1);
    await crashed.close(); // as if it died: the fake fetch drops nothing that matters here

    const next = harness({ apiKey }, ok, nodePlatform);
    expect(fs.existsSync(file)).toBe(false);
    await next.client.flush();
    const [event] = next.sent.flatMap((s) => s.lines);
    expect(event).toMatchObject({
      message: "exception",
      level: "error",
      attrs: { handled: false, mechanism: "unhandledRejection", error_type: "Error", error_message: "kaboom" },
      resource: { app_version: "1.0" },
    });
    expect(JSON.stringify(event)).toBe(spooled[0]);
    await next.client.close();
  });

  it("caps the spool and skips torn lines", async () => {
    const file = spoolPath(`lyr_ing_${uuid()}`);
    const spool = fileSpool(file);
    const big = JSON.stringify({ text: "x".repeat(100 * 1024) });
    spool.append(big);
    spool.append(big);
    spool.append(big); // would pass 256 KiB
    expect(fs.statSync(file).size).toBeLessThanOrEqual(SPOOL_MAX_BYTES);
    expect(spool.drain()).toHaveLength(2);
    expect(fs.existsSync(file)).toBe(false);
    expect(spool.drain()).toEqual([]);

    fs.writeFileSync(file, '{"message":"ok"}\n{"message":"to', { mode: 0o600 });
    let sent: string[] = [];
    const client = new Client({ endpoint: "https://ingest.test", apiKey: "unused" }, { ...nodePlatform, compress: async () => undefined, spool: () => fileSpool(file) }, {
      fetch: (async (_url: string, init: RequestInit) => {
        sent = String(init.body).split("\n");
        return new Response("{}", { status: 200 });
      }) as unknown as typeof globalThis.fetch,
    });
    expect(client.stats().queued).toBe(1);
    await client.close();
    expect(sent).toEqual(['{"message":"ok"}']);
  });
});
