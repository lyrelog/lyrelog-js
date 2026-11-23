import { describe, expect, it, vi } from "vitest";
import { Lyrelog } from "../src/node.js";
import { uuid } from "../src/platform.js";

const counts = () => ({
  exit: process.listenerCount("beforeExit"),
  monitor: process.listenerCount("uncaughtExceptionMonitor"),
});

describe("repeated init (M6)", () => {
  it("many clients share one process listener of each kind", async () => {
    const warnings: Error[] = [];
    const onWarning = (w: Error) => warnings.push(w);
    process.on("warning", onWarning);
    const before = counts();
    const clients = Array.from({ length: 30 }, () => Lyrelog.init({ endpoint: "https://ingest.test", apiKey: `lyr_ing_${uuid()}` }));
    expect(counts()).toEqual({ exit: before.exit + 1, monitor: before.monitor + 1 });
    await Promise.all(clients.map((c) => c.close()));
    expect(counts()).toEqual(before);
    await new Promise((r) => setTimeout(r, 0));
    process.off("warning", onWarning);
    expect(warnings.filter((w) => w.name === "MaxListenersExceededWarning")).toEqual([]);
  });

  it("the same config gives the same client; a changed one replaces it and closes the old", async () => {
    const apiKey = `lyr_ing_${uuid()}`;
    const first = Lyrelog.init({ endpoint: "https://ingest.test", apiKey, release: "1" });
    const again = Lyrelog.init({ endpoint: "https://ingest.test", apiKey, release: "1" });
    expect(again).toBe(first);

    const before = counts();
    const changed = Lyrelog.init({ endpoint: "https://ingest.test", apiKey, release: "2" });
    expect(changed).not.toBe(first);
    expect(counts()).toEqual(before); // the old one's listeners went with it
    first.info("ignored");
    expect(first.stats().queued).toBe(0);
    await changed.close();

    const reopened = Lyrelog.init({ endpoint: "https://ingest.test", apiKey, release: "2" });
    expect(reopened).not.toBe(changed); // a closed client is never handed back
    await reopened.close();
  });
});

describe("init from plain JavaScript (1.0 audit)", () => {
  it("never throws without a config, and gives an inert client", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const init = Lyrelog.init as (config?: unknown) => ReturnType<typeof Lyrelog.init>;
    for (const config of [undefined, null, "lyr_ing_x", 42]) {
      let client: ReturnType<typeof Lyrelog.init> | undefined;
      expect(() => (client = init(config))).not.toThrow();
      client!.info("nothing");
      expect(client!.stats()).toMatchObject({ queued: 0, disabled: true });
      await client!.close();
    }
    warn.mockRestore();
  });
});
