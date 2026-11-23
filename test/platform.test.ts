import os from "node:os";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeEnvironment, nodePlatform } from "../src/platform-node.js";
import { browserFamily, webEnvironment, webPlatform, WebSession } from "../src/platform-web.js";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  };
}

const throwing = new Proxy({} as Storage, {
  get() {
    throw new DOMException("blocked", "SecurityError");
  },
});

afterEach(() => vi.unstubAllGlobals());

describe("web", () => {
  it("knows the browser family", () => {
    const ua = {
      chrome: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
      edge: "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0",
      safari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
      firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
      crios: "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/131.0 Mobile/15E148 Safari/604.1",
    };
    expect(browserFamily(ua.chrome)).toBe("Chrome");
    expect(browserFamily(ua.edge)).toBe("Edge");
    expect(browserFamily(ua.safari)).toBe("Safari");
    expect(browserFamily(ua.firefox)).toBe("Firefox");
    expect(browserFamily(ua.crios)).toBe("Chrome");
    expect(browserFamily("curl/8")).toBe("Other");
  });

  it("is development on localhost, production elsewhere", () => {
    expect(webEnvironment("localhost")).toBe("development");
    expect(webEnvironment("127.0.0.1")).toBe("development");
    expect(webEnvironment("tilefall.app")).toBe("production");
    expect(webEnvironment(undefined)).toBe("production");
  });

  it("fills the resource from navigator and location", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 Firefox/133.0", language: "es-ES" });
    vi.stubGlobal("location", { hostname: "example.com" });
    expect(webPlatform.resource()).toEqual({ app_id: "example.com", os_name: "web", device_model: "Firefox", locale: "es_ES" });
    expect(webPlatform.detectEnvironment()).toBe("production");
  });

  it("keeps the install id in localStorage", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const id = webPlatform.installId(true);
    expect(webPlatform.installId(true)).toBe(id);
  });

  it("survives storage that throws", () => {
    vi.stubGlobal("localStorage", throwing);
    vi.stubGlobal("sessionStorage", throwing);
    expect(webPlatform.installId(true)).toMatch(/^[0-9a-f-]{36}$/);
    const session = new WebSession();
    expect(session.touch(0)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("continues a session across reloads and starts a new one after 30 min idle", () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    const first = new WebSession().touch(1_000);
    expect(new WebSession().touch(1_000 + 29 * 60_000)).toBe(first); // a reload
    expect(new WebSession().touch(1_000 + 29 * 60_000 + 31 * 60_000)).not.toBe(first);
  });

  it("gzips with CompressionStream", async () => {
    const body = new TextEncoder().encode('{"message":"hi"}');
    const zipped = await webPlatform.compress(body);
    expect(gunzipSync(zipped!).toString()).toBe('{"message":"hi"}');
  });

  it("hides on pagehide and on visibilitychange to hidden", () => {
    const target = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("addEventListener", target.addEventListener.bind(target));
    vi.stubGlobal("removeEventListener", target.removeEventListener.bind(target));
    vi.stubGlobal("document", doc);
    const hide = vi.fn();
    const uninstall = webPlatform.install({ hide, exit: () => undefined });
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(hide).not.toHaveBeenCalled();
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    target.dispatchEvent(new Event("pagehide"));
    expect(hide).toHaveBeenCalledTimes(2);
    uninstall();
    target.dispatchEvent(new Event("pagehide"));
    expect(hide).toHaveBeenCalledTimes(2);
  });
});

describe("node", () => {
  it("reads the OS and NODE_ENV", () => {
    expect(nodePlatform.resource()).toMatchObject({ os_name: process.platform, os_version: os.release() });
    expect(nodeEnvironment("production")).toBe("production");
    expect(nodeEnvironment("test")).toBe("development");
    expect(nodeEnvironment(undefined)).toBe("development");
  });

  it("gzips with zlib", async () => {
    const zipped = await nodePlatform.compress(new TextEncoder().encode("hello"));
    expect(gunzipSync(zipped!).toString()).toBe("hello");
  });
});
