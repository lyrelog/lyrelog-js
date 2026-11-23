import { describe, expect, it } from "vitest";
import { Lyrelog } from "../src/node.js";

const url = process.env.LYRELOG_E2E_URL;
const key = process.env.LYRELOG_E2E_KEY;

// Against a running Lyrelog: LYRELOG_E2E_URL=http://localhost:8090 LYRELOG_E2E_KEY=lyr_ing_... pnpm test
describe.skipIf(!url || !key)("end to end", () => {
  it("delivers events to a real ingest", async () => {
    const run = `e2e_${Date.now()}`;
    const client = Lyrelog.init({ endpoint: url!, apiKey: key!, environment: "e2e", release: "1.0.0", appId: "lyrelog-js-tests" });
    client.setUser("e2e-user");
    client.info("js_e2e_info", { category: "e2e", attrs: { run, n: 1, nested: { ok: true } }, payload: { hello: "world" } });
    client.logger("e2e").warning("js_e2e_warning", { attrs: { run } });
    client.captureError(new Error("js_e2e_boom"), { category: "e2e", attrs: { run } });
    await client.close();
    expect(client.stats()).toMatchObject({ queued: 0, delivered: 3, rejected: 0, disabled: false });
    console.log(`e2e run ${run}: 3 events delivered`);
  });
});
