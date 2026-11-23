import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fileSpool, nodePlatform, spoolDir, spoolPath } from "../src/platform-node.js";
import { harness, ok, uuid } from "./helpers.js";

const base = () => fs.mkdtempSync(path.join(os.tmpdir(), "lyrelog-spool-test-"));
const uid = process.getuid?.();

describe.skipIf(process.platform === "win32")("crash spool safety (L7)", () => {
  it("lives in a per-user directory, mode 700", () => {
    const file = spoolPath("lyr_ing_x");
    expect(path.dirname(file)).toBe(path.join(os.tmpdir(), `lyrelog-${uid}`));
    expect(path.basename(file)).toMatch(/^[0-9a-f]{12}\.ndjson$/);

    const dir = spoolDir(base());
    const spool = fileSpool(spoolPath("k", dir));
    spool.append('{"a":1}');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(spoolPath("k", dir)).mode & 0o777).toBe(0o600);

    fs.chmodSync(dir, 0o777); // someone loosened it: tightened again before writing
    spool.append('{"a":2}');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(spool.drain()).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("never writes or reads through a symlink", () => {
    const root = base();
    const victim = path.join(root, "victim.txt");
    fs.writeFileSync(victim, "precious\n");
    const dir = spoolDir(root);
    fs.mkdirSync(dir, { mode: 0o700 });
    const file = spoolPath("k", dir);
    fs.symlinkSync(victim, file);
    const spool = fileSpool(file);
    expect(() => spool.append('{"evil":1}')).toThrow();
    expect(spool.drain()).toEqual([]);
    expect(fs.readFileSync(victim, "utf8")).toBe("precious\n");

    // A directory planted as a symlink is refused too.
    const other = base();
    fs.mkdirSync(path.join(other, "real"), { mode: 0o700 });
    fs.symlinkSync(path.join(other, "real"), spoolDir(other));
    expect(() => fileSpool(spoolPath("k", spoolDir(other))).append('{"a":1}')).toThrow();
    expect(fs.readdirSync(path.join(other, "real"))).toEqual([]);
  });

  it("is deleted when consent is denied, and not sent", async () => {
    const apiKey = `lyr_ing_${uuid()}`;
    const file = spoolPath(apiKey);
    fileSpool(file).append(JSON.stringify({ message: "left from a crash" }));
    const { client, sent } = harness({ apiKey, consent: "denied" }, ok, nodePlatform);
    expect(fs.existsSync(file)).toBe(false);
    await client.close();
    expect(sent).toHaveLength(0);

    fileSpool(file).append(JSON.stringify({ message: "another" }));
    const pending = harness({ apiKey: `lyr_ing_${uuid()}`, consent: "pending" }, ok, { ...nodePlatform, spool: () => fileSpool(file) });
    expect(fs.existsSync(file)).toBe(false); // claimed into memory
    pending.client.setConsent("denied");
    fileSpool(file).append(JSON.stringify({ message: "late" }));
    pending.client.setConsent("denied");
    expect(fs.existsSync(file)).toBe(false);
    await pending.client.close();
  });
});
