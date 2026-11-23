import { describe, expect, it } from "vitest";
import { BACKOFF_CAP_MS, backoffDelay, classify, parseRetryAfter } from "../src/upload.js";

describe("classify", () => {
  it("2xx is delivered, counting rejected lines", () => {
    expect(classify(200, '{"accepted":2,"rejected":[{"line":3,"error":"bad"}]}', null)).toEqual({
      kind: "delivered",
      accepted: 2,
      rejected: 1,
      firstError: "line 3: bad",
    });
    expect(classify(200, '{"accepted":5,"rejected":[]}', null)).toEqual({ kind: "delivered", accepted: 5, rejected: 0 });
  });

  it("a 2xx it can't read is retried (the server collapses duplicates)", () => {
    expect(classify(200, "<html>", null)).toEqual({ kind: "retry" });
    expect(classify(204, "", null)).toEqual({ kind: "retry" });
  });

  it("400, 413, 415 drop the batch", () => {
    for (const status of [400, 404, 413, 415]) expect(classify(status, "", null)).toEqual({ kind: "drop", status });
  });

  it("401 and 403 stop sending", () => {
    expect(classify(401, "", null)).toEqual({ kind: "unauthorized", status: 401 });
    expect(classify(403, "", null)).toEqual({ kind: "unauthorized", status: 403 });
  });

  it("429 honours Retry-After in seconds or as a date", () => {
    expect(classify(429, "", "7")).toEqual({ kind: "retry", afterMs: 7000 });
    const now = Date.parse("2026-11-18T10:00:00Z");
    expect(classify(429, "", "Wed, 18 Nov 2026 10:00:30 GMT", now)).toEqual({ kind: "retry", afterMs: 30_000 });
    expect(classify(429, "", null)).toEqual({ kind: "retry" });
  });

  it("a 429 whose JSON body names a plan is the monthly quota; anything else is a plain 429", () => {
    const body = '{"error":"the plan\'s events are used","plan":"free","limit":1000000,"used":1000123}';
    expect(classify(429, body, "3600")).toEqual({ kind: "retry", afterMs: 3_600_000, quota: "the plan's events are used" });
    expect(classify(429, '{"plan":"free"}', null)).toEqual({ kind: "retry", quota: "the monthly events of this plan are used" });
    for (const plain of ['{"error":"rate limit for this project"}', "<html>", "", "null", "[1]", '"plan"']) {
      expect(classify(429, plain, "5")).toEqual({ kind: "retry", afterMs: 5000 });
    }
    expect(classify(503, body, null)).toEqual({ kind: "retry" });
  });

  it("408 and 5xx retry", () => {
    for (const status of [408, 500, 502, 503, 504, 599]) expect(classify(status, "", null).kind).toBe("retry");
  });
});

describe("parseRetryAfter", () => {
  it("ignores garbage and clamps past dates to zero", () => {
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("Wed, 18 Nov 2026 09:00:00 GMT", Date.parse("2026-11-18T10:00:00Z"))).toBe(0);
  });
});

describe("backoff", () => {
  it("doubles from 1 s with full jitter, capped at 5 min", () => {
    expect(backoffDelay(0, undefined, () => 1)).toBe(1000);
    expect(backoffDelay(3, undefined, () => 1)).toBe(8000);
    expect(backoffDelay(3, undefined, () => 0.5)).toBe(4000);
    expect(backoffDelay(30, undefined, () => 1)).toBe(BACKOFF_CAP_MS);
  });

  it("never sooner than the server asked", () => {
    expect(backoffDelay(0, 60_000, () => 1)).toBe(60_000);
  });
});
