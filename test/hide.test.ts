import { describe, expect, it } from "vitest";
import { fakePlatform, harness, json, ok } from "./helpers.js";

const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const web = () => fakePlatform({ name: "web", keepalive: true });

describe("page hide does not multiply requests (H1)", () => {
  it("one keepalive request per hide, even while the server keeps failing", async () => {
    const platform = web();
    const { client, sent } = harness({}, () => json(503, ""), platform);
    for (let switches = 0; switches < 5; switches++) {
      client.info(`e${switches}`);
      platform.hooks!.hide();
      await tick();
    }
    expect(sent).toHaveLength(5);
    for (const s of sent) expect(s.keepalive).toBe(true);
    // The last request carries everything still waiting, merged.
    expect(sent.at(-1)!.lines.map((e) => e.message)).toEqual(["e0", "e1", "e2", "e3", "e4"]);
    expect((client as unknown as { attempt: number }).attempt).toBe(0);
  });

  it("merges waiting batches and new lines into a single request", async () => {
    const platform = web();
    const { client, sent } = harness({}, (s, i) => (i === 0 ? json(503, "") : ok(s)), platform);
    client.info("a");
    await client.flush(); // fails: a waits as a sealed batch
    client.info("b");
    client.info("c");
    (client as unknown as { notBefore: number }).notBefore = 0; // the backoff has passed
    platform.hooks!.hide();
    await tick();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.lines.map((e) => e.message)).toEqual(["a", "b", "c"]);
    expect(client.stats().queued).toBe(0);
  });

  it("sends nothing while the server asked to wait (Retry-After)", async () => {
    let now = 1_000_000;
    const platform = web();
    const { client, sent } = harness({}, () => json(429, "", { "Retry-After": "60" }), platform, { now: () => now });
    client.info("a");
    await client.flush();
    expect(sent).toHaveLength(1);
    platform.hooks!.hide();
    platform.hooks!.hide();
    await tick();
    expect(sent).toHaveLength(1);
    now += 61_000;
    platform.hooks!.hide();
    await tick();
    expect(sent).toHaveLength(2);
  });

  it("does not stack a second keepalive while one is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const platform = web();
    const { client, sent } = harness({}, async (s) => {
      await gate;
      return ok(s);
    }, platform);
    client.info("a");
    platform.hooks!.hide();
    client.info("b");
    platform.hooks!.hide();
    await tick();
    expect(sent).toHaveLength(1);
    release();
    await tick();
    await client.flush();
    expect(client.stats()).toMatchObject({ queued: 0, delivered: 2 });
  });
});
