import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { errorFromEvent } from "../src/platform-web.js";
import * as prepare from "../src/prepare.js";
import { harness } from "./helpers.js";

const foreign = (code: string) => vm.runInNewContext(code) as Error;

describe("Errors from another realm (L3)", () => {
  it("are recognised without instanceof", async () => {
    const error = foreign("const e = new TypeError('from an iframe'); e.code = 'E_X'; e.cause = new Error('root'); e");
    expect(error instanceof Error).toBe(false);
    expect(prepare.isError(error)).toBe(true);
    expect(prepare.isError(Object.assign(Object.create({}), { message: "m", stack: "s" }))).toBe(true);
    expect(prepare.isError({ message: "m", stack: "s" })).toBe(false); // plain data
    expect(prepare.isError({ message: "m" })).toBe(false);
    expect(prepare.stringForm(error)).toBe("TypeError: from an iframe");
    expect(errorFromEvent({ error })).toBe(error);

    const { client, sent } = harness();
    client.captureError(error);
    client.info("x", { payload: { error } });
    await client.flush();
    const [exception, info] = sent[0]!.lines;
    expect(exception).toMatchObject({
      attrs: { error_type: "TypeError", error_message: "from an iframe" },
      payload: { name: "TypeError", message: "from an iframe", code: "E_X", cause: { name: "Error", message: "root" } },
    });
    expect((exception!.payload as { stack: string }).stack).toContain("from an iframe");
    expect(info!.payload).toMatchObject({ error: { name: "TypeError", message: "from an iframe" } });
  });
});
