/**
 * Fitting an event inside the ingest's limits (lyrelog: internal/events/events.go,
 * docs/ingest-api.md) *before* it is queued, so a line is never rejected later for something
 * the SDK could have fixed. Pure functions, mirrored from lyrelog-swift's EventPreparation.
 *
 * Policy: never drop an event for its shape. Long strings are cut on a character boundary,
 * extra attributes are dropped and counted in `lyrelog_dropped_attrs`, an oversized payload is
 * replaced by a short summary.
 */

export const MAX_MESSAGE_BYTES = 2048;
export const MAX_ID_BYTES = 128;
export const MAX_RESOURCE_BYTES = 64;
export const MAX_ATTRIBUTES = 200;
export const MAX_ATTRIBUTE_STRING_BYTES = 1024;
export const MAX_ATTRIBUTE_NAME_BYTES = 128;
export const MAX_ARRAY_ITEMS = 64;
export const MAX_DEPTH = 4;
export const MAX_PAYLOAD_BYTES = 64 * 1024;
export const DROPPED_MARKER = "lyrelog_dropped_attrs";
export const REDACTED = "[redacted]";

/**
 * Words whose values never leave the device, wherever they appear as a key in attrs, payload or
 * a value turned into a string: credentials that ride along in request objects (an
 * `Authorization` header in a thrown HTTP error, a cookie jar in a payload). A key is redacted
 * when its name, lowercased and without "-", "_", "." or spaces, is one of these or ends with
 * one: "X-Api-Key", "csrf_token" and "Set-Cookie" match; "token_count" and "max_tokens" don't.
 * The same rule in every Lyrelog SDK (lyrelog: docs/sdk-spec.md rule 9). `redactKeys` replaces
 * this list; extend it with `[...DEFAULT_REDACT_KEYS, "ssn"]`.
 */
export const DEFAULT_REDACT_KEYS: readonly string[] = Object.freeze([
  "authorization",
  "cookie",
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "privatekey",
  "credential",
  "credentials",
  "accesskey",
  "signature",
]);

/** Normalised names to redact (see `normal`), matched as suffixes. */
export type Redact = ReadonlySet<string>;

const SEPARATORS = /[-_. ]/g;

/** A key name as it is matched: lowercased, without "-", "_", "." or spaces. */
export function normal(name: string): string {
  return name.toLowerCase().replace(SEPARATORS, "");
}

const DEFAULT_REDACT: Redact = new Set(DEFAULT_REDACT_KEYS);

/**
 * The names to redact, normalised: the app's own list (`redactKeys`) when given, replacing the
 * defaults (an empty list turns redaction off), else `DEFAULT_REDACT_KEYS`.
 */
export function redactor(keys?: readonly unknown[]): Redact {
  if (keys === undefined) return DEFAULT_REDACT;
  const names = new Set<string>();
  for (const name of keys) {
    if (typeof name !== "string") continue;
    const key = normal(name);
    if (key.length > 0) names.add(key);
  }
  return names;
}

/**
 * An Error, also one made in another realm (an iframe, a `vm` context, a worker's message), where
 * `instanceof Error` is false: its tag says so, or (not a plain object) it has a string message
 * and stack.
 */
export function isError(value: unknown): value is Error {
  if (value instanceof Error) return true;
  if (typeof value !== "object" || value === null) return false;
  try {
    if (Object.prototype.toString.call(value) === "[object Error]") return true;
    // A plain object is data, whatever its fields (an error description is one).
    if (isPlainObject(value)) return false;
    const { message, stack } = value as { message?: unknown; stack?: unknown };
    return typeof message === "string" && typeof stack === "string";
  } catch {
    return false;
  }
}

function secret(key: string, redact: Redact): boolean {
  const name = normal(key);
  if (name.length === 0) return false;
  for (const word of redact) if (name.endsWith(word)) return true;
  return false;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3; // other BMP characters; a lone surrogate becomes U+FFFD (3 bytes)
  }
  return bytes;
}

/** Cut to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncate(text: string, maxBytes: number): string {
  if (text.length * 3 <= maxBytes) return text;
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // Step back over continuation bytes (10xxxxxx) so the cut lands on a code point's start.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

export function message(text: unknown, redact: Redact = DEFAULT_REDACT): string {
  const cut = truncate(typeof text === "string" ? text : stringForm(text, redact), MAX_MESSAGE_BYTES);
  return cut.length === 0 ? "(empty)" : cut;
}

export function identifier(text: unknown): string | undefined {
  if (text === null || text === undefined) return undefined;
  let value: string;
  try {
    value = typeof text === "string" ? text : String(text);
  } catch {
    return undefined; // an object without a string form (no prototype, a throwing toString)
  }
  return value.length === 0 ? undefined : truncate(value, MAX_ID_BYTES);
}

export function category(text: unknown): string | undefined {
  if (typeof text !== "string" || text.length === 0) return undefined;
  return truncate(text, MAX_RESOURCE_BYTES);
}

/**
 * Environment and platform names: lowercase letters, digits, `-` and `_`, up to 32, starting
 * with a letter or digit. Anything else is rewritten; nothing usable left gives `undefined`.
 */
export function name(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let value = raw.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^[-_]+|[-_]+$/g, "");
  if (value.length > 32) value = value.slice(0, 32).replace(/[-_]+$/, "");
  return value.length === 0 ? undefined : value;
}

// MARK: - Attributes

type Json = string | number | boolean | null | string[] | { [key: string]: Json };

export function attributes(input: unknown, redact: Redact = DEFAULT_REDACT): Record<string, Json> | undefined {
  if (!isPlainObject(input)) return undefined;
  const state = { budget: MAX_ATTRIBUTES - 1, dropped: 0, redact }; // keep room for the marker
  const result = object(input, 1, state, new Set());
  if (state.dropped > 0) result[DROPPED_MARKER] = state.dropped;
  return Object.keys(result).length === 0 ? undefined : result;
}

function object(
  input: Record<string, unknown>,
  depth: number,
  state: { budget: number; dropped: number; redact: Redact },
  seen: Set<object>,
): Record<string, Json> {
  seen.add(input);
  const out: Record<string, Json> = {};
  let keys: string[];
  try {
    keys = Object.keys(input).sort();
  } catch {
    state.dropped += 1; // a proxy that refuses to list its keys
    seen.delete(input);
    return out;
  }
  for (const key of keys) {
    let value: unknown;
    try {
      value = input[key];
    } catch {
      state.dropped += 1; // a getter that throws costs only its own field
      continue;
    }
    if (value === undefined || typeof value === "function" || typeof value === "symbol") continue;
    const key2 = attributeName(key);
    if (Object.prototype.hasOwnProperty.call(out, key2)) {
      // `a.b` and `a_b`, `_x` and `x`: the same name once rewritten. The first one stays.
      state.dropped += isPlainObject(value) ? Math.max(1, leafCount(value, new Set())) : 1;
      continue;
    }
    if (secret(key, state.redact)) {
      if (state.budget <= 0) {
        state.dropped += 1;
        continue;
      }
      state.budget -= 1;
      out[key2] = REDACTED;
      continue;
    }
    if (isPlainObject(value) && depth < MAX_DEPTH && !seen.has(value)) {
      const child = object(value, depth + 1, state, seen);
      if (Object.keys(child).length > 0) out[key2] = child;
      continue;
    }
    if (state.budget <= 0) {
      state.dropped += leafCount(value, new Set());
      continue;
    }
    state.budget -= 1;
    out[key2] = leaf(value, state.redact);
  }
  seen.delete(input);
  return out;
}

function leaf(value: unknown, redact: Redact): Json {
  switch (typeof value) {
    case "string":
      return truncate(value, MAX_ATTRIBUTE_STRING_BYTES);
    case "number":
      return Number.isFinite(value) ? value : null;
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
  }
  if (value === null) return null;
  if (Array.isArray(value)) {
    // Attribute arrays hold strings only (`Array.from` visits holes, which `map` would keep as null).
    return Array.from(value.slice(0, MAX_ARRAY_ITEMS), (item: unknown) =>
      truncate(typeof item === "string" ? item : stringForm(item, redact), MAX_ATTRIBUTE_STRING_BYTES),
    );
  }
  // Deeper than MAX_DEPTH, a Date, an Error, a class instance: keep it as a string.
  return truncate(stringForm(value, redact), MAX_ATTRIBUTE_STRING_BYTES);
}

function leafCount(value: unknown, seen: Set<object>): number {
  if (isPlainObject(value) && !seen.has(value)) {
    seen.add(value);
    let count = 0;
    try {
      for (const item of Object.values(value)) {
        if (item !== undefined && typeof item !== "function" && typeof item !== "symbol") count += leafCount(item, seen);
      }
    } catch {
      return Math.max(1, count);
    }
    return count;
  }
  return 1;
}

/** Dots would mean nesting and a leading underscore is reserved, so both are rewritten. */
export function attributeName(key: string): string {
  let result = key.replace(/\./g, "_").replace(/^_+/, "");
  if (result.length === 0) result = "key";
  return truncate(result, MAX_ATTRIBUTE_NAME_BYTES);
}

/** Never throws: a value whose fields throw when read is "[unprintable]". */
export function stringForm(value: unknown, redact: Redact = DEFAULT_REDACT): string {
  try {
    return stringFormOf(value, redact);
  } catch {
    return "[unprintable]";
  }
}

function stringFormOf(value: unknown, redact: Redact): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (isError(value)) return `${value.name}: ${value.message}`;
  if (typeof value === "object") {
    try {
      // Whatever uses a string form keeps at most a couple of KiB of it: stop there.
      const { json } = serialize(value, STRING_FORM_CHARS, redact);
      if (json !== undefined) return json;
    } catch {
      // fall through
    }
  }
  try {
    return String(value);
  } catch {
    return "[unprintable]";
  }
}

// MARK: - Payload

/**
 * The payload as one JSON string, or a summary when it is too big or can't be serialized.
 * Returned serialized so the caller's object is snapshotted at log time.
 */
export function payload(value: unknown, redact: Redact = DEFAULT_REDACT): string | undefined {
  if (value === undefined) return undefined;
  let result: { json: string | undefined; size: number };
  try {
    result = measured(value, MAX_PAYLOAD_BYTES, redact);
    if (result.json === undefined && result.size > MAX_PAYLOAD_BYTES) {
      // Stopped early: the preview comes from a serializer that keeps what it wrote.
      const preview = serialize(value, 1024, redact).json ?? "";
      return JSON.stringify({ lyrelog_truncated: true, bytes: result.size, at_least: true, preview: truncate(preview, 1024) });
    }
  } catch (error) {
    return JSON.stringify({
      lyrelog_unserializable: true,
      error: truncate(isError(error) ? error.message : String(error), 1024),
    });
  }
  const { json } = result;
  if (json === undefined) return undefined;
  const bytes = utf8Length(json);
  if (bytes <= MAX_PAYLOAD_BYTES) return json;
  return JSON.stringify({ lyrelog_truncated: true, bytes, preview: truncate(json, 1024) });
}

/**
 * The native `JSON.stringify`, with BigInt as a string, cycles as "[circular]", Errors as their
 * name, message and stack and secret keys as "[redacted]", that gives up (`json` undefined,
 * `size` past `limit`) once its running estimate of the output (a lower bound, in characters)
 * passes `limit`: a huge object is never serialized whole only to be thrown away.
 */
function measured(value: unknown, limit: number, redact: Redact): { json: string | undefined; size: number } {
  const stack: unknown[] = [];
  let size = 0;
  const replacer = function (this: unknown, key: string, input: unknown): unknown {
    let value = input;
    if (key !== "" && !Array.isArray(this) && secret(key, redact)) value = REDACTED;
    else if (typeof value === "bigint") value = value.toString();
    else if (isError(value)) value = { name: value.name, message: value.message, stack: value.stack };
    // A lower bound of what JSON.stringify writes: `"key":` for a member, a comma for an item.
    size += Array.isArray(this) ? 1 : key.length + 2;
    if (typeof value === "string") size += value.length + 2;
    else if (typeof value === "number") size += 1;
    else if (typeof value === "boolean" || value === null) size += 4;
    if (size > limit) throw OVERFLOW;
    if (typeof value !== "object" || value === null) return value;
    // `this` is the object holding `value`: unwind the stack to it, then check for a cycle.
    while (stack.length > 0 && stack[stack.length - 1] !== this) stack.pop();
    if (stack.includes(value)) return "[circular]";
    stack.push(value);
    return value;
  };
  try {
    return { json: JSON.stringify(value, replacer), size };
  } catch (error) {
    if (error !== OVERFLOW) throw error;
    return { json: undefined, size };
  }
}

/** How much of a value's JSON a string form (attrs, messages: 2 KiB at most) ever needs. */
const STRING_FORM_CHARS = 4096;

const OVERFLOW = Symbol("overflow");

/**
 * The same output as `measured` (and `JSON.stringify`), written by hand so that when it stops,
 * once past `limit` characters, it still has what it wrote: for string forms and previews,
 * which keep only the start. `complete` false means it stopped there.
 */
export function serialize(value: unknown, limit: number, redact: Redact = DEFAULT_REDACT): { json: string | undefined; complete: boolean } {
  let out = "";
  const ancestors: object[] = [];

  const push = (text: string): void => {
    out += text;
    if (out.length > limit) throw OVERFLOW;
  };

  const pushString = (text: string): void => {
    // Escaping a 10 MB string only to cut it: escape only what could still fit.
    const room = limit - out.length;
    push(JSON.stringify(text.length > room ? text.slice(0, Math.max(0, room) + 1) : text));
  };

  /** Writes `value` (held under `key` by `holder`); false when it serializes to nothing. */
  const write = (holder: unknown, key: string, input: unknown): boolean => {
    let value = input;
    if (key !== "" && !Array.isArray(holder) && secret(key, redact)) value = REDACTED;
    else if (typeof value === "object" && value !== null) {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) {
        // Only an instance can be a Date, an Error or a boxed primitive.
        const toJSON = (value as { toJSON?: unknown }).toJSON;
        if (typeof toJSON === "function") value = toJSON.call(value, key);
        if (typeof value === "bigint") value = value.toString();
        else if (isError(value)) value = { name: value.name, message: value.message, stack: value.stack };
        else if (value instanceof Number) value = Number(value);
        else if (value instanceof String) value = String(value);
        else if (value instanceof Boolean) value = value.valueOf();
      } else if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
        value = (value as { toJSON: (key: string) => unknown }).toJSON(key);
      }
    } else if (typeof value === "bigint") {
      value = value.toString();
    }

    switch (typeof value) {
      case "string":
        pushString(value);
        return true;
      case "number":
        push(Number.isFinite(value) ? String(value) : "null");
        return true;
      case "boolean":
        push(value ? "true" : "false");
        return true;
      case "undefined":
      case "function":
      case "symbol":
        return false;
    }
    if (value === null) {
      push("null");
      return true;
    }
    const object = value as object;
    if (ancestors.includes(object)) {
      push('"[circular]"');
      return true;
    }
    ancestors.push(object);
    if (Array.isArray(object)) {
      push("[");
      for (let i = 0; i < object.length; i++) {
        if (i > 0) push(",");
        if (!write(object, String(i), object[i])) push("null");
      }
      push("]");
    } else {
      push("{");
      let first = true;
      for (const name of Object.keys(object)) {
        const before = out;
        push(first ? JSON.stringify(name) + ":" : "," + JSON.stringify(name) + ":");
        if (write(object, name, (object as Record<string, unknown>)[name])) first = false;
        else out = before;
      }
      push("}");
    }
    ancestors.pop();
    return true;
  };

  try {
    return { json: write({ "": value }, "", value) ? out : undefined, complete: true };
  } catch (error) {
    if (error !== OVERFLOW) throw error;
    return { json: out, complete: false };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false; // a proxy whose traps throw
  }
}
