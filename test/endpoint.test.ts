import { afterEach, describe, expect, it, vi } from "vitest";
import { harness, json, ok, type Sent } from "./helpers.js";

let warn: ReturnType<typeof vi.spyOn>;
afterEach(() => warn?.mockRestore());
const quiet = () => (warn = vi.spyOn(console, "warn").mockImplementation(() => undefined));

async function urlFor(endpoint: string | undefined): Promise<string | undefined> {
  const { client, sent } = harness({ endpoint } as never);
  client.info("a");
  await client.flush();
  await client.close();
  return sent[0]?.url;
}

describe("endpoint (M5)", () => {
  it("defaults to the hosted ingest and accepts the base URL with or without /v1/events:batch", async () => {
    expect(await urlFor(undefined)).toBe("https://ingest.lyrelog.com/v1/events:batch");
    expect(await urlFor("")).toBe("https://ingest.lyrelog.com/v1/events:batch");
    expect(await urlFor("https://x.test")).toBe("https://x.test/v1/events:batch");
    expect(await urlFor("https://x.test/")).toBe("https://x.test/v1/events:batch");
    expect(await urlFor("https://x.test/v1")).toBe("https://x.test/v1/events:batch");
    expect(await urlFor("https://x.test/v1/")).toBe("https://x.test/v1/events:batch");
    expect(await urlFor("https://x.test/v1/events:batch")).toBe("https://x.test/v1/events:batch");
    expect(await urlFor("https://x.test/logs/")).toBe("https://x.test/logs/v1/events:batch");
    expect(await urlFor("http://localhost:8090")).toBe("http://localhost:8090/v1/events:batch");
    expect(await urlFor("http://127.0.0.1:8090")).toBe("http://127.0.0.1:8090/v1/events:batch");
    expect(await urlFor("http://[::1]:8090")).toBe("http://[::1]:8090/v1/events:batch");
    expect(await urlFor("http://api.localhost")).toBe("http://api.localhost/v1/events:batch");
  });

  it("refuses a URL without https (or http on localhost): one warning, nothing queued", async () => {
    quiet();
    for (const endpoint of ["ingest.lyrelog.com", "http://ingest.example.com", "ftp://x.test", "https://", "not a url"]) {
      warn.mockClear();
      const { client, sent } = harness({ endpoint });
      client.info("a");
      client.info("b");
      await client.flush();
      expect(sent).toHaveLength(0);
      expect(client.stats()).toMatchObject({ queued: 0, disabled: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("endpoint");
      await client.close();
    }
  });

  it("without an API key: one warning, nothing queued", async () => {
    quiet();
    const { client, sent } = harness({ apiKey: "" });
    client.info("a");
    await client.flush();
    expect(sent).toHaveLength(0);
    expect(client.stats()).toMatchObject({ queued: 0, disabled: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("apiKey");
  });

  it("a dropped batch (a wrong path's 404) warns once", async () => {
    quiet();
    const { client } = harness({}, () => json(404, "not found"));
    client.info("a");
    await client.flush();
    client.info("b");
    await client.flush();
    expect(client.stats()).toMatchObject({ queued: 0, rejected: 2 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("404");
  });
});

describe("redirects", () => {
  it("are not followed: a 3xx drops the batch and warns once", async () => {
    quiet();
    const inits: RequestInit[] = [];
    const { client, sent } = harness({}, (s: Sent, i) => {
      if (i === 0) return new Response(null, { status: 301, headers: { Location: "https://elsewhere.test/" } });
      if (i === 1) return { status: 0, type: "opaqueredirect", headers: new Headers(), text: async () => "" } as unknown as Response;
      return ok(s);
    });
    // Capture the RequestInit too.
    const original = (client as unknown as { fetcher: typeof fetch }).fetcher;
    (client as unknown as { fetcher: typeof fetch }).fetcher = ((url: string, init: RequestInit) => {
      inits.push(init);
      return original(url, init);
    }) as typeof fetch;
    client.info("a");
    await client.flush();
    client.info("b");
    await client.flush();
    expect(sent).toHaveLength(2);
    expect(inits.every((init) => init.redirect === "manual")).toBe(true);
    expect(client.stats()).toMatchObject({ queued: 0, rejected: 2, delivered: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/redirect/i);
  });
});
