import { describe, expect, it, vi } from "vitest";
import * as browser from "../src/browser.js";
import * as node from "../src/node.js";
import * as prepare from "../src/prepare.js";
import { harness } from "./helpers.js";

const SECRET = "Bearer s3cr3t-value";

describe("secrets stay out (M2)", () => {
  it("a thrown non-Error keeps only name, message, code and status", async () => {
    const { client, sent } = harness();
    const thrown = { name: "HTTPError", message: "request failed", status: 500, code: "E_HTTP", config: { headers: { Authorization: SECRET } } };
    client.captureError(thrown);
    client.captureError(new Error("wrapped", { cause: thrown }));
    await client.flush();
    const [first, second] = sent[0]!.lines;
    expect(JSON.stringify(sent[0]!.lines)).not.toContain("s3cr3t");
    expect(first).toMatchObject({
      attrs: { error_type: "HTTPError", error_message: "request failed" },
      payload: { name: "HTTPError", message: "request failed", status: 500, code: "E_HTTP" },
    });
    expect(Object.keys(first!.payload as object).sort()).toEqual(["code", "message", "name", "status"]);
    expect((second!.payload as { cause: unknown }).cause).toEqual({ name: "HTTPError", message: "request failed", status: 500, code: "E_HTTP" });
  });

  it("a thrown object without a message says what it is, not what it holds", async () => {
    const { client, sent } = harness();
    client.captureError({ Authorization: SECRET });
    client.captureError("plain text");
    await client.flush();
    const [first, second] = sent[0]!.lines;
    expect(JSON.stringify(first)).not.toContain("s3cr3t");
    expect(first).toMatchObject({ attrs: { error_type: "object", error_message: "[object Object]" } });
    expect(second).toMatchObject({ attrs: { error_message: "plain text" }, payload: { value: "plain text" } });
  });

  it("redacts the usual secret names in attrs, payload and string forms", async () => {
    const { client, sent } = harness();
    client.info("req", {
      attrs: { Authorization: SECRET, nested: { password: "p", ok: 1 }, "x-api-key": "k", obj: new Map(), list: [{ token: "t" }] },
      payload: { headers: { cookie: "c=1", "Set-Cookie": "s=1", accept: "json" }, access_token: "a", deep: [{ refresh_token: "r" }] },
    });
    client.info({ secret: "x", fine: 1 } as unknown as string);
    await client.flush();
    const [event, second] = sent[0]!.lines;
    expect(event!.attrs).toMatchObject({ Authorization: "[redacted]", nested: { password: "[redacted]", ok: 1 }, "x-api-key": "[redacted]" });
    expect((event!.attrs as { list: string[] }).list[0]).toBe('{"token":"[redacted]"}');
    expect(event!.payload).toEqual({
      headers: { cookie: "[redacted]", "Set-Cookie": "[redacted]", accept: "json" },
      access_token: "[redacted]",
      deep: [{ refresh_token: "[redacted]" }],
    });
    expect(second!.message).toBe('{"secret":"[redacted]","fine":1}');
    for (const key of ["passwd", "secret", "api_key", "apikey", "token"]) {
      expect(prepare.stringForm({ [key]: "v" })).toBe(`{"${key}":"[redacted]"}`);
    }
  });

  it("matches a name that, lowercased and without - _ . or spaces, is or ends with a secret word (the shared rule)", async () => {
    const secrets = [
      "X-Api-Key", "csrf_token", "Set-Cookie", "user_token", "access_token", "refresh_token", "api_key", "API.KEY",
      "Private Key", "private_key", "aws_access_key", "AWSAccessKey", "db_credentials", "Credential", "x-signature",
      "client_secret", "session.cookie", "Proxy-Authorization", "old_password", "passwd", "TOKEN",
    ];
    const clear = ["token_count", "max_tokens", "tokenizer", "author", "cookies_enabled", "keyboard", "signed", "secretary"];
    for (const key of secrets) expect(prepare.stringForm({ [key]: "v" }), key).toBe(`{"${key}":"[redacted]"}`);
    for (const key of clear) expect(prepare.stringForm({ [key]: "v" }), key).toBe(`{"${key}":"v"}`);

    const { client, sent } = harness();
    const fields = Object.fromEntries([...secrets, ...clear].map((key) => [key, "v"]));
    client.info("req", { attrs: fields, payload: { nested: { ...fields } } });
    await client.flush();
    const [event] = sent[0]!.lines;
    // Attribute names are rewritten for the wire ("." becomes "_"); the decision is on the original.
    const attrs = event!.attrs as Record<string, unknown>;
    for (const key of secrets) expect(attrs[prepare.attributeName(key)], key).toBe("[redacted]");
    for (const key of clear) expect(attrs[prepare.attributeName(key)], key).toBe("v");
    const nested = (event!.payload as { nested: Record<string, unknown> }).nested;
    for (const key of secrets) expect(nested[key], key).toBe("[redacted]");
    for (const key of clear) expect(nested[key], key).toBe("v");
    expect(prepare.DEFAULT_REDACT_KEYS).toEqual([
      "authorization", "cookie", "password", "passwd", "secret", "token", "apikey", "privatekey",
      "credential", "credentials", "accesskey", "signature",
    ]);
  });

  it("redactKeys entries are normalised the same way and match as suffixes", async () => {
    const { client, sent } = harness({ redactKeys: ["Social-Security.Number"] });
    client.info("x", { payload: { social_security_number: "1", "home socialSecurityNumber": "2", number: "3", user_token: "t" } });
    await client.flush();
    expect(sent[0]!.lines[0]!.payload).toEqual({
      social_security_number: "[redacted]",
      "home socialSecurityNumber": "[redacted]",
      number: "3",
      user_token: "t", // the list replaces the defaults
    });
  });

  it("redactKeys replaces the default list (the shared rule)", async () => {
    const { client, sent } = harness({ redactKeys: ["SSN"] });
    client.info("x", { attrs: { ssn: "123", password: "p" }, payload: { Ssn: "1", token: "t" } });
    await client.flush();
    expect(sent[0]!.lines[0]).toMatchObject({ attrs: { ssn: "[redacted]", password: "p" }, payload: { Ssn: "[redacted]", token: "t" } });
  });

  it("redactKeys: [\"foo\"] stops redacting password", async () => {
    const { client, sent } = harness({ redactKeys: ["foo"] });
    client.info("x", { attrs: { password: "p", foo: "f" } });
    await client.flush();
    expect(sent[0]!.lines[0]!.attrs).toEqual({ password: "p", foo: "[redacted]" });
  });

  it("an empty redactKeys turns redaction off", async () => {
    const { client, sent } = harness({ redactKeys: [] });
    client.info("x", { attrs: { password: "p", Authorization: "a" }, payload: { cookie: "c" } });
    await client.flush();
    expect(sent[0]!.lines[0]).toMatchObject({ attrs: { password: "p", Authorization: "a" }, payload: { cookie: "c" } });
  });

  it("DEFAULT_REDACT_KEYS is exported from both entry points and spreads to extend the list", async () => {
    expect(browser.DEFAULT_REDACT_KEYS).toBe(prepare.DEFAULT_REDACT_KEYS);
    expect(node.DEFAULT_REDACT_KEYS).toBe(prepare.DEFAULT_REDACT_KEYS);
    expect(Object.isFrozen(node.DEFAULT_REDACT_KEYS)).toBe(true);
    const { client, sent } = harness({ redactKeys: [...node.DEFAULT_REDACT_KEYS, "ssn"] });
    client.info("x", { attrs: { ssn: "1", password: "p", ok: 1 } });
    await client.flush();
    expect(sent[0]!.lines[0]!.attrs).toEqual({ ssn: "[redacted]", password: "[redacted]", ok: 1 });
  });

  it("redactKeys left out keeps the defaults", async () => {
    const { client, sent } = harness({});
    client.info("x", { attrs: { password: "p", ssn: "1" } });
    await client.flush();
    expect(sent[0]!.lines[0]!.attrs).toEqual({ password: "[redacted]", ssn: "1" });
  });
});

describe("beforeSend (M2)", () => {
  it("can change an event, drop it with null, and a hook that throws drops it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client, sent } = harness({
      beforeSend(event) {
        if (event.message === "drop") return null;
        if (event.message === "boom") throw new Error("hook bug");
        event.attrs = { ...event.attrs, email: undefined, scrubbed: true };
        event.payload = { kept: (event.payload as { a?: number } | undefined)?.a ?? null };
        event.message = `${event.message}!`;
        return event;
      },
    });
    client.info("keep", { attrs: { email: "a@b.c" }, payload: { a: 1, b: 2 } });
    client.info("drop");
    client.info("boom");
    client.info("boom");
    await client.flush();
    expect(sent[0]!.lines).toHaveLength(1);
    expect(sent[0]!.lines[0]).toMatchObject({ message: "keep!", attrs: { scrubbed: true }, payload: { kept: 1 } });
    expect((sent[0]!.lines[0]!.attrs as Record<string, unknown>).email).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("sees the resource and ids, and cannot break the wire format", async () => {
    let seen: unknown;
    const { client, sent } = harness({
      beforeSend(event) {
        seen = event;
        return { ...event, level: "nope" as never, message: "x".repeat(5000), attrs: { "a.b": 1 } };
      },
    });
    client.warning("w");
    await client.flush();
    expect(seen).toMatchObject({ level: "warning", message: "w", install_id: "install-1", resource: { os_name: "test" } });
    const [event] = sent[0]!.lines;
    expect(event!.level).toBe("warning");
    expect((event!.message as string).length).toBe(2048);
    expect(event!.attrs).toEqual({ a_b: 1 });
  });
});
