/** What to do with a batch after a request. Decided by a pure function so it can be tested. */
export type Outcome =
  /** Stored. `rejected` lines were invalid and are gone for good (never resend them). */
  | { kind: "delivered"; accepted: number; rejected: number; firstError?: string }
  /**
   * Temporary problem: keep the batch and try again later, not before `afterMs` if given.
   * `quota` is the server's message when the 429 is the organization's monthly quota.
   */
  | { kind: "retry"; afterMs?: number; quota?: string }
  /** The batch itself is wrong (400, 413, 415...): resending would fail the same way. */
  | { kind: "drop"; status: number }
  /** The key is unknown, revoked or read-only: stop sending until restart, keep the data. */
  | { kind: "unauthorized"; status: number };

export function classify(status: number, body: string, retryAfter: string | null | undefined, now = Date.now()): Outcome {
  if (status >= 200 && status < 300) {
    // A 2xx we can't read may not mean "stored": retry; the server drops duplicates.
    try {
      const answer = JSON.parse(body) as { accepted?: unknown; rejected?: unknown };
      if (typeof answer.accepted !== "number" || !Array.isArray(answer.rejected)) return { kind: "retry" };
      const first = answer.rejected[0] as { line?: unknown; error?: unknown } | undefined;
      return {
        kind: "delivered",
        accepted: answer.accepted,
        rejected: answer.rejected.length,
        ...(first ? { firstError: `line ${String(first.line)}: ${String(first.error)}` } : {}),
      };
    } catch {
      return { kind: "retry" };
    }
  }
  if (status === 401 || status === 403) return { kind: "unauthorized", status };
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    const afterMs = parseRetryAfter(retryAfter, now);
    const quota = status === 429 ? quotaMessage(body) : undefined;
    return {
      kind: "retry",
      ...(afterMs === undefined ? {} : { afterMs }),
      ...(quota === undefined ? {} : { quota }),
    };
  }
  return { kind: "drop", status };
}

const QUOTA_MESSAGE_MAX = 300;

/**
 * The monthly quota 429 is JSON with a `plan` field (`{"error", "plan", "limit", "used"}`); the
 * rate-limit 429 has only `error`. Returns the server's message, or undefined for a plain 429.
 */
function quotaMessage(body: string): string | undefined {
  try {
    const answer: unknown = JSON.parse(body);
    if (typeof answer !== "object" || answer === null || Array.isArray(answer) || !("plan" in answer)) return undefined;
    const error = (answer as { error?: unknown }).error;
    const text = typeof error === "string" ? error.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() : "";
    if (!text) return "the monthly events of this plan are used";
    return text.length > QUOTA_MESSAGE_MAX ? `${text.slice(0, QUOTA_MESSAGE_MAX)}...` : text;
  } catch {
    return undefined;
  }
}

/** The most the server ever asks to wait (the monthly quota's 429): anything longer is cut to it. */
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

/**
 * `Retry-After` is either seconds or an HTTP date. Returns milliseconds from `now`, at most
 * `MAX_RETRY_AFTER_MS` (a huge number of seconds, even one too big to hold, is an hour).
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(text)) {
    ms = Number(text) * 1000;
  } else {
    const date = Date.parse(text);
    if (Number.isNaN(date)) return undefined;
    ms = date - now;
  }
  if (Number.isNaN(ms)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms));
}

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CAP_MS = 5 * 60 * 1000;

/** Full jitter: uniform(0, min(cap, base * 2^attempt)), but never sooner than the server asked. */
export function backoffDelay(attempt: number, retryAfterMs?: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(Math.max(attempt, 0), 16));
  return Math.max(random() * ceiling, retryAfterMs ?? 0);
}
