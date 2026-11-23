import { afterEach, describe, expect, it, vi } from "vitest";
import { webPlatform } from "../src/platform-web.js";
import { harness, ok } from "./helpers.js";

/** A Storage that records every access. */
function spyStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const access: string[] = [];
  const storage: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (access.push(`get ${k}`), map.get(k) ?? null),
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => (access.push(`remove ${k}`), void map.delete(k)),
    setItem: (k, v) => (access.push(`set ${k}`), void map.set(k, v)),
  };
  return { storage, map, access };
}

afterEach(() => vi.unstubAllGlobals());

function stub() {
  const local = spyStorage();
  const session = spyStorage();
  vi.stubGlobal("localStorage", local.storage);
  vi.stubGlobal("sessionStorage", session.storage);
  return { local, session };
}

describe("ids and consent on the web (M4)", () => {
  it("pending: nothing is stored until consent is granted, then the same ids are", async () => {
    const { local, session } = stub();
    const { client, sent } = harness({ consent: "pending", captureErrors: false }, ok, webPlatform);
    client.info("a");
    expect(local.access).toEqual([]);
    expect(session.access).toEqual([]);
    client.setConsent("granted");
    await client.flush();
    const [event] = sent[0]!.lines;
    expect(local.map.get("lyrelog.install_id")).toBe(event!.install_id);
    expect(JSON.parse(session.map.get("lyrelog.session")!).id).toBe(event!.session_id);
    await client.close();
  });

  it("denied: nothing is stored, and what an earlier visit stored is removed", async () => {
    const { local, session } = stub();
    local.map.set("lyrelog.install_id", "old-install");
    session.map.set("lyrelog.session", JSON.stringify({ id: "old-session", last: 0 }));
    const { client } = harness({ consent: "granted", captureErrors: false }, ok, webPlatform);
    client.setConsent("denied");
    expect(local.map.has("lyrelog.install_id")).toBe(false);
    expect(session.map.has("lyrelog.session")).toBe(false);
    local.access.length = 0;
    session.access.length = 0;
    client.info("ignored");
    client.setConsent("pending");
    client.info("held");
    expect(local.access).toEqual([]);
    expect(session.access).toEqual([]);
    await client.close();

    const fresh = harness({ consent: "denied", captureErrors: false }, ok, webPlatform);
    fresh.client.info("x");
    expect(local.access.filter((a) => a.startsWith("set"))).toEqual([]);
    expect(session.access.filter((a) => a.startsWith("set"))).toEqual([]);
    await fresh.client.close();
  });

  it("granted: the install id an earlier visit stored is used", async () => {
    const { local } = stub();
    local.map.set("lyrelog.install_id", "kept-install");
    const { client, sent } = harness({ captureErrors: false }, ok, webPlatform);
    client.info("a");
    await client.flush();
    expect(sent[0]!.lines[0]!.install_id).toBe("kept-install");
    await client.close();
  });
});
