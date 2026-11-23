import type { Platform, SessionClock, Spool } from "./platform.js";
import { SDK, uuid } from "./platform.js";
import * as prepare from "./prepare.js";
import { backoffDelay, classify, type Outcome } from "./upload.js";
import {
  LEVELS,
  type Attributes,
  type Config,
  type Consent,
  type ExceptionOptions,
  type FlushOptions,
  type Level,
  type LevelMethods,
  type LogOptions,
  type Logger,
  type LyrelogEvent,
  type Resource,
  type Stats,
} from "./types.js";

export const DEFAULT_ENDPOINT = "https://ingest.lyrelog.com";
export const MAX_BATCH_EVENTS = 500;
export const MAX_BATCH_BYTES = 512 * 1024;
/** The ingest refuses one line over 1 MiB; such an event is dropped here, counted, and never sent. */
export const MAX_LINE_BYTES = 1024 * 1024;
/** Browsers allow 64 KiB of keepalive bodies in flight per page; leave room for the rest. */
export const KEEPALIVE_BUDGET_BYTES = 60 * 1024;
export const REQUEST_TIMEOUT_MS = 30_000;
/** Node's `beforeExit` flush ends by then, so a slow or unreachable ingest never holds a script open. */
export const EXIT_FLUSH_MS = 5000;
/** `close()` waits at most this long unless told otherwise (the same budget as the exit flush). */
export const CLOSE_TIMEOUT_MS = EXIT_FLUSH_MS;
export const DEFAULT_FLUSH_INTERVAL_MS = 5000;
/** A smaller `flushIntervalMs` is raised to it. */
export const MIN_FLUSH_INTERVAL_MS = 1000;
/** Failed uploads in a row (network, 5xx, rate limit; not the monthly quota) before one warning. */
export const FAILURES_BEFORE_WARNING = 3;
export const DEFAULT_MAX_QUEUE = 10_000;
export const DEFAULT_MAX_QUEUE_BYTES = 16 * 1024 * 1024;
/** Automatic captures of uncaught errors: at most this many a minute... */
export const UNCAUGHT_PER_MINUTE = 10;
/** ...and the same error (type, message, top stack line) only once in this window. */
export const UNCAUGHT_REPEAT_MS = 10_000;
/**
 * An exception's message and stack in its payload, per error and cause: four of them (the error
 * and three causes) stay under the 64 KiB payload, so a huge message never costs the stack.
 */
export const ERROR_MESSAGE_BYTES = 2048;
export const ERROR_STACK_BYTES = 12 * 1024;

/** @internal Seams for tests (the network, the clock and the dice): never reachable from `Lyrelog.init`. */
export interface Dependencies {
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  /** Told once when the client closes (the registry of live clients). */
  onClose?: () => void;
}

interface Line {
  text: string;
  bytes: number;
}

/** A batch keeps its lines and body once formed, so a retry resends exactly the same events. */
interface Batch {
  lines: Line[];
  body: string;
  bytes: number;
  compressed?: Uint8Array | null;
  inFlight: boolean;
}

const encoder = new TextEncoder();

/**
 * A Lyrelog client. Logging never blocks and never throws: the event is fitted to the server's
 * limits, serialized, and queued in memory; a timer sends the queue in batches.
 */
export class Client implements LevelMethods<LogOptions> {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly minimum: number;
  private readonly maxQueue: number;
  private readonly maxQueueBytes: number;
  private readonly batchEvents: number;
  private readonly resourceJSON: string;
  private readonly installId: string;
  private readonly session: SessionClock;
  private readonly fetcher: typeof fetch | undefined;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly onClose: (() => void) | undefined;
  private readonly redact: prepare.Redact;
  private readonly beforeSend: Config["beforeSend"];
  private readonly interval: number;
  /** Set while `beforeSend` runs: an event it logs itself is dropped, never filtered again. */
  private inBeforeSend = false;

  private queue: Line[] = [];
  private queueBytes = 0;
  private sealed: Batch[] = [];
  private consent: Consent;
  private userId: string | undefined;
  private currentScreen: string | undefined;
  private screenSince: number | undefined;

  private attempt = 0;
  private notBefore = 0;
  /** The server's own `Retry-After`: unlike the jittered backoff, nothing overrides it. */
  private retryAfterUntil = 0;
  private disabled = false;
  /** Set up wrong (no key, a bad endpoint, no fetch): nothing is queued or sent at all. */
  private inert = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  private running = false;
  private chain: Promise<void> = Promise.resolve();
  private kickScheduled = false;
  private exitFlushed = false;
  private keepaliveInFlight = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private uninstall: (() => void) | undefined;
  private uninstallErrors: (() => void) | undefined;
  private spool: Spool | undefined;
  private uncaughtTimes: number[] = [];
  private uncaughtSeen = new Map<string, number>();
  private counts = { dropped: 0, delivered: 0, rejected: 0, skippedErrors: 0 };
  private told = { rejected: false, unauthorized: false };
  private warned = new Set<string>();
  /** The monthly quota stop was told; cleared by the next accepted batch. */
  private quotaWarned = false;
  /** The "uploads keep failing" warning was given; cleared by the next accepted batch. */
  private downWarned = false;

  /** The resource sent with every event (read-only; for support screens and tests). */
  readonly resource: Readonly<Resource>;

  constructor(config: Config, private readonly platform: Platform, deps: Dependencies = {}) {
    const url = ingestURL(config.endpoint);
    this.url = url ?? "";
    this.apiKey = String(config.apiKey ?? "");
    this.minimum = Math.max(0, LEVELS.indexOf(config.minimumLevel ?? "debug"));
    this.maxQueue = positive(config.maxQueue, DEFAULT_MAX_QUEUE);
    this.maxQueueBytes = positive(config.maxQueueBytes, DEFAULT_MAX_QUEUE_BYTES);
    this.batchEvents = Math.min(MAX_BATCH_EVENTS, this.maxQueue);
    this.consent = this.validConsent(config.consent ?? "granted");
    this.fetcher = deps.fetch ?? (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.onClose = deps.onClose;
    this.redact = prepare.redactor(Array.isArray(config.redactKeys) ? config.redactKeys : undefined);
    this.beforeSend = typeof config.beforeSend === "function" ? config.beforeSend : undefined;
    this.interval = Math.max(MIN_FLUSH_INTERVAL_MS, positive(config.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS));

    const base = safe(() => platform.resource(), {});
    const resource: Resource = {
      ...base,
      app_id: config.appId ?? base.app_id,
      app_version: config.release ?? base.app_version,
      sdk: SDK,
      environment: prepare.name(config.environment) ?? safe(() => platform.detectEnvironment(), "production"),
      platform: prepare.name(config.platform) ?? platform.name,
    };
    const fitted: Resource = {};
    for (const [key, value] of Object.entries(resource) as [keyof Resource, string | undefined][]) {
      if (typeof value === "string" && value.length > 0) fitted[key] = prepare.truncate(value, prepare.MAX_RESOURCE_BYTES);
    }
    this.resource = Object.freeze(fitted);
    this.resourceJSON = JSON.stringify(fitted);
    // No storage is touched before consent: the ids live in memory until it is granted.
    const persist = this.consent === "granted";
    this.installId = prepare.identifier(safe(() => platform.installId(persist), "")) ?? "";
    this.session = platform.session(persist);

    if (url === undefined) {
      this.warnOnce(
        "endpoint",
        `the endpoint ${JSON.stringify(String(config.endpoint))} is not a valid https URL (http only for localhost); nothing will be sent`,
      );
    } else if (this.apiKey.length === 0) {
      this.warnOnce("apiKey", "no apiKey given; nothing will be sent");
    } else if (!this.fetcher) {
      this.warnOnce("fetch", "this runtime has no fetch; nothing will be sent");
    }
    if (!this.fetcher || url === undefined || this.apiKey.length === 0) {
      this.inert = true;
      this.disabled = true;
      return;
    }

    this.startTimer();
    this.uninstall = safe(
      () => platform.install({ hide: () => this.hide(), exit: () => this.exit() }),
      undefined,
    );
    if (config.captureErrors !== false) {
      this.spool = safe(() => platform.spool?.(this.apiKey), undefined);
      if (this.consent === "denied") safe(() => this.spool?.clear?.(), undefined);
      else this.drainSpool();
      this.uninstallErrors = safe(
        () => platform.installErrors?.((error, mechanism) => this.uncaught(error, mechanism)),
        undefined,
      );
    }
  }

  // MARK: - Logging

  log(level: Level, message: string, options?: LogOptions): void {
    try {
      this.record(level, message, options?.category, options?.attrs, options?.payload);
    } catch {
      // Logging never throws in the caller's path.
    }
  }

  trace(message: string, options?: LogOptions): void {
    this.log("trace", message, options);
  }
  debug(message: string, options?: LogOptions): void {
    this.log("debug", message, options);
  }
  info(message: string, options?: LogOptions): void {
    this.log("info", message, options);
  }
  notice(message: string, options?: LogOptions): void {
    this.log("notice", message, options);
  }
  warning(message: string, options?: LogOptions): void {
    this.log("warning", message, options);
  }
  /** The same as `warning` (the level sent is `warning`). */
  warn(message: string, options?: LogOptions): void {
    this.log("warning", message, options);
  }
  error(message: string, options?: LogOptions): void {
    this.log("error", message, options);
  }
  critical(message: string, options?: LogOptions): void {
    this.log("critical", message, options);
  }

  /** A logger for one area of the app: every event it records carries `category`. */
  logger(category: string): Logger {
    const log = (level: Level, message: string, options?: Omit<LogOptions, "category">) =>
      this.log(level, message, { ...options, category });
    const bound = (level: Level) => (message: string, options?: Omit<LogOptions, "category">) =>
      log(level, message, options);
    return {
      category,
      log,
      trace: bound("trace"),
      debug: bound("debug"),
      info: bound("info"),
      notice: bound("notice"),
      warning: bound("warning"),
      warn: bound("warning"),
      error: bound("error"),
      critical: bound("critical"),
    };
  }

  /** Attach your own user or account id to every following event. `null` clears it. */
  setUser(id: string | null | undefined): void {
    try {
      this.userId = prepare.identifier(id);
    } catch {
      // never throws
    }
  }

  /**
   * Say which screen (on the web: page) the person is on: logs `screen_viewed` with the screen
   * before and how long they stayed on it, and tags every following event with `screen`.
   */
  screen(name: string, attrs?: Attributes): void {
    try {
      if (this.closed || typeof name !== "string" || name === this.currentScreen) return;
      const now = this.now();
      const before = this.currentScreen;
      const since = this.screenSince;
      this.currentScreen = name;
      this.screenSince = now;
      const attributes: Attributes = { ...attrs, screen: name };
      if (before !== undefined) attributes.previous_screen = before;
      if (since !== undefined) attributes.seconds_on_previous = Math.round((now - since) / 100) / 10;
      this.record("info", "screen_viewed", "navigation", attributes, undefined);
    } catch {
      // never throws
    }
  }

  /**
   * Record an error: `exception` with its type and message as attributes and the stack (and
   * causes) in the payload.
   */
  captureError(error: unknown, options?: ExceptionOptions): void {
    try {
      this.exception(error, options?.level ?? "error", options?.category, options?.attrs);
    } catch {
      // never throws
    }
  }

  /** @deprecated Use `captureError`, the name every Lyrelog SDK shares. This calls it. */
  captureException(error: unknown, options?: ExceptionOptions): void {
    this.captureError(error, options);
  }

  private exception(error: unknown, level: Level, category: unknown, attrs: Attributes | undefined): Line | undefined {
    const err = prepare.isError(error) ? error : undefined;
    let type: string = typeof error;
    let text: string;
    if (err) {
      const name = field(err, "name");
      const constructorName = field(field(err, "constructor"), "name");
      type = (typeof name === "string" && name) || (typeof constructorName === "string" && constructorName) || "Error";
      const message = field(err, "message");
      text = typeof message === "string" ? message : message === undefined ? "" : prepare.stringForm(message, this.redact);
    } else if (typeof error === "object" && error !== null) {
      // Only what names the problem: a thrown request object would carry its headers.
      const fields = errorFields(error);
      if (typeof fields.name === "string" && fields.name) type = fields.name;
      text = typeof fields.message === "string" ? fields.message : Object.prototype.toString.call(error);
    } else {
      text = prepare.stringForm(error, this.redact);
    }
    return this.record(level, "exception", category, { ...attrs, error_type: type, error_message: text }, describeError(error, 0, this.redact, (stack) => safe(() => this.platform.cleanStack?.(stack) ?? stack, stack)));
  }

  // MARK: - Uncaught errors

  /**
   * An uncaught error from the platform's listeners: recorded like `captureError` with
   * `handled: false`, behind the flood guard, and (Node) written to the spool at once, since the
   * process is about to die before any request could finish.
   */
  private uncaught(error: unknown, mechanism: string): void {
    try {
      if (this.closed || this.consent === "denied") return;
      if (!this.admitUncaught(error)) {
        this.counts.skippedErrors += 1;
        return;
      }
      const line = this.exception(error, "error", undefined, { handled: false, mechanism });
      if (line && this.spool) this.spool.append(line.text);
    } catch {
      // never throws
    }
  }

  private admitUncaught(error: unknown): boolean {
    const now = this.now();
    this.uncaughtTimes = this.uncaughtTimes.filter((t) => now - t < 60_000);
    for (const [key, at] of this.uncaughtSeen) if (now - at >= UNCAUGHT_REPEAT_MS) this.uncaughtSeen.delete(key);
    const key = fingerprint(error);
    if (this.uncaughtSeen.has(key)) return false;
    if (this.uncaughtTimes.length >= UNCAUGHT_PER_MINUTE) return false;
    this.uncaughtSeen.set(key, now);
    this.uncaughtTimes.push(now);
    return true;
  }

  /** The events a crashed run with this key left behind: queued now, the file removed. */
  private drainSpool(): void {
    if (!this.spool || this.consent === "denied") return;
    const lines = safe(() => this.spool!.drain(), [] as string[]);
    for (const text of lines) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      } catch {
        continue; // a torn write
      }
      this.enqueue({ text, bytes: prepare.utf8Length(text) });
    }
    this.enforceCap();
  }

  setConsent(value: Consent): void {
    const consent = this.validConsent(value);
    this.consent = consent;
    safe(() => this.session.persist?.(consent === "granted"), undefined);
    if (consent === "granted") safe(() => this.platform.persistIds?.(this.installId), undefined);
    if (consent === "denied") {
      safe(() => this.platform.forgetIds?.(), undefined);
      safe(() => this.spool?.clear?.(), undefined);
      this.queue = [];
      this.queueBytes = 0;
      this.sealed = this.sealed.filter((batch) => batch.inFlight);
    } else if (consent === "granted") {
      this.kick();
    }
  }

  /** `granted`, `pending` or `denied`; anything else is `pending`, said once. */
  private validConsent(value: unknown): Consent {
    if (value === "granted" || value === "pending" || value === "denied") return value;
    let shown: string;
    try {
      shown = JSON.stringify(value) ?? String(value);
    } catch {
      shown = typeof value;
    }
    this.warnOnce("consent", `consent ${prepare.truncate(shown, 64)} is not "granted", "pending" or "denied"; it is taken as "pending" (events are kept, not sent)`);
    return "pending";
  }

  /** The current session id, e.g. to show in a support screen. */
  get sessionId(): string | undefined {
    return this.session.id;
  }

  stats(): Stats {
    return { queued: this.queuedCount(), queuedBytes: this.queuedBytes(), ...this.counts, disabled: this.disabled };
  }

  /**
   * Send everything queued now, skipping the client's own backoff for one attempt, but never a
   * server's `Retry-After` (a 429 past the quota can ask for up to an hour): then it resolves at
   * once and the events wait. With `timeoutMs` it never waits longer than that; without, each
   * request gives up after 30 s. Never rejects.
   */
  flush(options?: FlushOptions): Promise<void> {
    try {
      const timeout = timeoutOption(options, undefined);
      return within(this.schedule(true, timeout), timeout);
    } catch {
      return Promise.resolve();
    }
  }

  /**
   * Stop the timer and the page/process listeners, then send what is queued, waiting at most
   * `timeoutMs` (default 5000): what isn't sent by then is lost. Idempotent; never rejects.
   */
  close(options?: FlushOptions): Promise<void> {
    try {
      const timeout = timeoutOption(options, CLOSE_TIMEOUT_MS);
      if (!this.closing) this.closing = this.shutDown(timeout);
      return within(this.closing, timeout);
    } catch {
      return Promise.resolve();
    }
  }

  private shutDown(timeout: number | undefined): Promise<void> {
    this.closed = true;
    safe(() => this.onClose?.(), undefined);
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    safe(() => this.uninstall?.(), undefined);
    this.uninstall = undefined;
    safe(() => this.uninstallErrors?.(), undefined);
    this.uninstallErrors = undefined;
    return this.schedule(true, timeout);
  }

  // MARK: - Queue

  private record(
    level: Level,
    message: unknown,
    category: unknown,
    attrs: Attributes | undefined,
    payload: unknown,
  ): Line | undefined {
    if (this.closed || this.inert || this.consent === "denied") return undefined;
    const rank = LEVELS.indexOf(level);
    if (rank < this.minimum) return undefined;
    const now = this.now();
    let attributes = attrs;
    if (this.currentScreen !== undefined && (attrs === undefined || !("screen" in attrs))) {
      attributes = { ...attrs, screen: this.currentScreen };
    }
    let wire = {
      event_id: uuid(),
      ts: new Date(now).toISOString(),
      level,
      category: prepare.category(category),
      message: prepare.message(message, this.redact),
      user_id: this.userId,
      install_id: this.installId || undefined,
      session_id: prepare.identifier(this.session.touch(now)),
      attrs: prepare.attributes(attributes, this.redact),
    };
    let json = prepare.payload(payload, this.redact);
    if (this.beforeSend) {
      if (this.inBeforeSend) {
        this.warnOnce("beforeSendLog", "an event logged from inside beforeSend was dropped");
        return undefined;
      }
      const event: LyrelogEvent = { ...wire, resource: this.resource };
      if (json !== undefined) event.payload = JSON.parse(json) as unknown;
      let result: LyrelogEvent | null | undefined;
      this.inBeforeSend = true;
      try {
        result = this.beforeSend(event);
      } catch (error) {
        this.warnOnce("beforeSend", `beforeSend threw, the event was dropped: ${prepare.stringForm(error, this.redact)}`);
        return undefined;
      } finally {
        this.inBeforeSend = false;
      }
      if (result === null || typeof result !== "object") return undefined;
      wire = {
        ...wire,
        level: LEVELS.includes(result.level) ? result.level : level,
        category: prepare.category(result.category),
        message: prepare.message(result.message, this.redact),
        user_id: prepare.identifier(result.user_id),
        attrs: prepare.attributes(result.attrs, this.redact),
      };
      json = prepare.payload(result.payload, this.redact);
    }
    const head = JSON.stringify(wire).slice(0, -1);
    const text = `${head},"resource":${this.resourceJSON}${json === undefined ? "" : `,"payload":${json}`}}`;
    const line = { text, bytes: prepare.utf8Length(text) };
    if (line.bytes > MAX_LINE_BYTES) {
      this.counts.dropped += 1;
      this.warnOnce("line", `an event of ${line.bytes} bytes is over the ingest's 1 MiB per event and was dropped; keep attrs and payload smaller`);
      return line;
    }
    this.enqueue(line);
    this.startTimer();
    this.exitFlushed = false;
    this.enforceCap();
    if (this.queue.length >= this.batchEvents) this.kick();
    return line;
  }

  private queuedCount(): number {
    return this.queue.length + this.sealed.reduce((sum, batch) => sum + batch.lines.length, 0);
  }

  private enqueue(line: Line): void {
    this.queue.push(line);
    this.queueBytes += line.bytes;
  }

  /** What the queue holds in memory: every line, and the gzipped copy a waiting batch keeps. */
  private queuedBytes(): number {
    let bytes = this.queueBytes;
    for (const batch of this.sealed) bytes += batch.bytes + (batch.compressed?.length ?? 0);
    return bytes;
  }

  /**
   * Beyond `maxQueue` events or `maxQueueBytes`, the oldest events go, one at a time: first from
   * the batches waiting for a retry (a batch that loses lines is rebuilt and compressed again),
   * then from the queue. A batch in flight is never touched.
   */
  private enforceCap(): void {
    let excessCount = this.queuedCount() - this.maxQueue;
    let excessBytes = this.queuedBytes() - this.maxQueueBytes;
    if (excessCount <= 0 && excessBytes <= 0) return;
    for (const batch of [...this.sealed]) {
      if (excessCount <= 0 && excessBytes <= 0) return;
      if (batch.inFlight) continue;
      let n = 0;
      let freed = batch.compressed?.length ?? 0;
      while (n < batch.lines.length && (excessCount - n > 0 || excessBytes - freed > 0)) {
        freed += batch.lines[n]!.bytes + 1;
        n++;
      }
      this.counts.dropped += n;
      excessCount -= n;
      if (n === batch.lines.length) {
        excessBytes -= batch.bytes + (batch.compressed?.length ?? 0);
        this.remove(batch);
      } else {
        // The gzipped copy goes first: it can be made again, the events can't.
        const before = batch.bytes + (batch.compressed?.length ?? 0);
        if (n > 0) {
          batch.lines.splice(0, n);
          batch.body = batch.lines.map((line) => line.text).join("\n");
          batch.bytes = batchBytes(batch.lines);
        }
        batch.compressed = undefined;
        excessBytes -= before - batch.bytes;
      }
    }
    while ((excessCount > 0 || excessBytes > 0) && this.queue.length > 0) {
      const line = this.queue.shift()!;
      this.queueBytes -= line.bytes;
      this.counts.dropped += 1;
      excessCount -= 1;
      excessBytes -= line.bytes;
    }
  }

  /**
   * Lines from the front of the queue, up to the batch limits. `strict` (keepalive) returns
   * nothing when even the first line is too big; otherwise a batch always has one line.
   */
  private take(maxEvents: number, maxBytes: number, strict = false): Line[] {
    let bytes = 0;
    let count = 0;
    while (count < this.queue.length && count < maxEvents) {
      const line = this.queue[count]!;
      const next = bytes + line.bytes + (count > 0 ? 1 : 0);
      if (count > 0 && next > maxBytes) break;
      if (strict && next > maxBytes) return [];
      bytes = next;
      count++;
    }
    const lines = this.queue.splice(0, count);
    for (const line of lines) this.queueBytes -= line.bytes;
    return lines;
  }

  private seal(lines: Line[]): Batch {
    const body = lines.map((line) => line.text).join("\n");
    const batch: Batch = { lines, body, bytes: batchBytes(lines), inFlight: false };
    this.sealed.push(batch);
    return batch;
  }

  /** The oldest batch waiting for a (re)try, else a new one from the queue. */
  private nextBatch(): Batch | undefined {
    const waiting = this.sealed.find((batch) => !batch.inFlight);
    if (waiting) return waiting;
    const lines = this.take(this.batchEvents, MAX_BATCH_BYTES);
    return lines.length > 0 ? this.seal(lines) : undefined;
  }

  // MARK: - Sending

  private canSend(): boolean {
    return !this.disabled && this.consent === "granted";
  }

  private tick(): void {
    if (!this.running) void this.schedule(false);
  }

  /**
   * The periodic timer, unless it runs already. Where timers are refused at first (a Cloudflare
   * Worker's global scope, where `init` usually runs), the next event logged starts it.
   */
  private startTimer(): void {
    if (this.timer !== undefined || this.closed || this.inert) return;
    try {
      this.timer = setInterval(() => this.tick(), this.interval);
    } catch {
      return;
    }
    safe(() => this.platform.unrefTimer?.(this.timer), undefined);
  }

  /** Soon, a round that respects the backoff (a full batch is waiting, consent arrived). */
  private kick(): void {
    if (this.kickScheduled || this.closed || this.timer === undefined) return;
    this.kickScheduled = true;
    try {
      setTimeout(() => {
        this.kickScheduled = false;
        if (!this.running) void this.schedule(false);
      }, 0);
    } catch {
      this.kickScheduled = false;
    }
  }

  /** One upload round at a time, in order; `budgetMs` bounds the whole round (the exit flush). */
  private schedule(force: boolean, budgetMs?: number): Promise<void> {
    const deadline = budgetMs === undefined ? undefined : this.now() + budgetMs;
    const next = this.chain.then(() => this.round(force, deadline));
    this.chain = next.catch(() => undefined);
    return this.chain;
  }

  private async round(force: boolean, deadline?: number): Promise<void> {
    if (!this.canSend()) return;
    const now = this.now();
    if (now < this.retryAfterUntil) return;
    if (!force && now < this.notBefore) return;
    this.running = true;
    try {
      for (;;) {
        if (!this.canSend()) return;
        const left = deadline === undefined ? REQUEST_TIMEOUT_MS : Math.min(REQUEST_TIMEOUT_MS, deadline - this.now());
        if (left <= 0) return;
        const batch = this.nextBatch();
        if (!batch) return;
        batch.inFlight = true;
        const outcome = await this.send(batch, false, left);
        this.settle(batch, outcome);
        if (outcome.kind === "retry" || outcome.kind === "unauthorized") return;
      }
    } finally {
      this.running = false;
    }
  }

  /** A keepalive outcome never grows the backoff: the page was going away, not the server. */
  private settle(batch: Batch, outcome: Outcome, keepalive = false): void {
    batch.inFlight = false;
    switch (outcome.kind) {
      case "delivered":
        this.remove(batch);
        this.counts.delivered += outcome.accepted;
        this.counts.rejected += outcome.rejected;
        this.attempt = 0;
        this.notBefore = 0;
        this.retryAfterUntil = 0;
        this.quotaWarned = false;
        this.downWarned = false;
        if (outcome.rejected > 0 && !this.told.rejected) {
          this.told.rejected = true;
          debugLog(`${outcome.rejected} event(s) rejected by the server (${outcome.firstError ?? "no detail"})`);
        }
        break;
      case "drop":
        this.remove(batch);
        this.counts.rejected += batch.lines.length;
        if (outcome.status >= 300 && outcome.status < 400) {
          this.warnOnce("redirect", `the ingest answered with a redirect (${outcome.status}), which is not followed; set endpoint to the final URL. Events were dropped`);
        } else if (outcome.status === 0) {
          this.warnOnce("redirect", "the ingest answered with a redirect, which is not followed; set endpoint to the final URL. Events were dropped");
        } else {
          this.warnOnce("drop", `the ingest refused a batch (${outcome.status}); its events were dropped. Is the endpoint right?`);
        }
        break;
      case "unauthorized":
        this.disabled = true;
        if (!this.told.unauthorized) {
          this.told.unauthorized = true;
          debugLog(`the ingest key was refused (${outcome.status}); events are kept but not sent until restart`);
        }
        break;
      case "retry":
        if (outcome.quota !== undefined && !this.quotaWarned) {
          this.quotaWarned = true;
          warn(
            `${outcome.quota.replace(/\.+$/, "")}. Events are kept and sent when sending resumes; how many wait depends on the platform ` +
              `(here: in memory, up to ${this.maxQueue} events and ${formatBytes(this.maxQueueBytes)}, oldest dropped first; lost if the process or page ends).`,
          );
        }
        if (outcome.afterMs !== undefined) {
          this.retryAfterUntil = Math.max(this.retryAfterUntil, this.now() + outcome.afterMs);
        }
        if (keepalive) break;
        this.notBefore = this.now() + backoffDelay(this.attempt, outcome.afterMs, this.random);
        // The quota is the plan, not a failing server: it doesn't grow the backoff (sdk-spec 4).
        if (outcome.quota === undefined) this.attempt += 1;
        if (this.attempt >= FAILURES_BEFORE_WARNING && !this.downWarned) {
          this.downWarned = true;
          warn(
            `${this.attempt} uploads in a row failed (no network, or the ingest is down or busy). Events are kept in memory and retried ` +
              `(up to ${this.maxQueue} events and ${formatBytes(this.maxQueueBytes)}, oldest dropped first); this is said once until an upload succeeds.`,
          );
        }
        break;
    }
    if (this.consent === "denied") this.remove(batch);
    this.enforceCap();
  }

  private remove(batch: Batch): void {
    const index = this.sealed.indexOf(batch);
    if (index >= 0) this.sealed.splice(index, 1);
  }

  private async send(batch: Batch, keepalive: boolean, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Outcome> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/x-ndjson",
    };
    if (this.platform.userAgent) headers["User-Agent"] = this.platform.userAgent;
    let body: BodyInit = batch.body;
    // A keepalive request goes out synchronously as the page hides: no time to compress.
    if (!keepalive) {
      if (batch.compressed === undefined) {
        try {
          batch.compressed = (await this.platform.compress(encoder.encode(batch.body))) ?? null;
        } catch {
          batch.compressed = null;
        }
      }
      if (batch.compressed) {
        headers["Content-Encoding"] = "gzip";
        body = batch.compressed as unknown as BodyInit;
      }
    }
    try {
      const init: RequestInit = { method: "POST", headers, body, keepalive, redirect: "manual" };
      const signal = timeoutSignal(timeoutMs);
      if (signal) init.signal = signal;
      const response = await this.fetcher!(this.url, init);
      // Never follow a redirect: it would carry the key to another host, or turn POST into GET.
      if (response.type === "opaqueredirect") return { kind: "drop", status: 0 };
      if (response.status >= 300 && response.status < 400) return { kind: "drop", status: response.status };
      const text = await response.text().catch(() => "");
      return classify(response.status, text, response.headers.get("Retry-After"), this.now());
    } catch {
      return { kind: "retry" };
    }
  }

  private warnOnce(kind: string, text: string): void {
    if (this.warned.has(kind)) return;
    this.warned.add(kind);
    warn(text);
  }

  // MARK: - Lifecycle

  /**
   * The page is hiding (and may be gone for good): at most one keepalive request, uncompressed,
   * now, with the waiting batches and then the queued lines that fit in the keepalive budget.
   * Nothing while the server asked to wait, or while an earlier keepalive is still in flight
   * (browsers share the 64 KiB keepalive budget across a page). The rest stays queued.
   */
  private hide(): void {
    try {
      if (!this.platform.keepalive || !this.canSend()) return;
      const now = this.now();
      if (this.keepaliveInFlight || now < this.notBefore || now < this.retryAfterUntil) return;
      let budget = KEEPALIVE_BUDGET_BYTES;
      const lines: Line[] = [];
      const merged: Batch[] = [];
      for (const batch of this.sealed) {
        if (batch.inFlight) continue;
        const cost = batch.bytes + (lines.length > 0 ? 1 : 0);
        if (cost > budget) continue;
        budget -= cost;
        lines.push(...batch.lines);
        merged.push(batch);
      }
      const fresh = this.take(this.batchEvents - lines.length, budget - (lines.length > 0 ? 1 : 0), true);
      lines.push(...fresh);
      if (lines.length === 0) return;
      for (const batch of merged) this.remove(batch);
      const batch = this.seal(lines);
      batch.inFlight = true;
      this.keepaliveInFlight = true;
      void this.send(batch, true).then((outcome) => {
        this.keepaliveInFlight = false;
        this.settle(batch, outcome, true);
      });
    } catch {
      // never throws
    }
  }

  /** Node's `beforeExit`: one last flush, once per batch of new events (or it would loop). */
  private exit(): void {
    if (this.exitFlushed || !this.canSend() || this.queuedCount() === 0) return;
    this.exitFlushed = true;
    void this.schedule(true, EXIT_FLUSH_MS);
  }
}

/**
 * The batch URL from what the app gave: the hosted ingest when nothing, a base URL with or
 * without `/v1` or `/v1/events:batch`. `undefined` unless it is https, or http on localhost.
 */
export function ingestURL(endpoint: unknown): string | undefined {
  let text = typeof endpoint === "string" ? endpoint.trim() : "";
  if (text.length === 0) text = DEFAULT_ENDPOINT;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  if (!(parsed.protocol === "https:" || (parsed.protocol === "http:" && local)) || host.length === 0) return undefined;
  parsed.search = "";
  parsed.hash = "";
  const base = parsed.pathname.replace(/\/+$/, "").replace(/\/v1(\/events:batch)?$/, "");
  return `${parsed.origin}${base}/v1/events:batch`;
}

function batchBytes(lines: Line[]): number {
  return lines.reduce((sum, line) => sum + line.bytes, 0) + Math.max(0, lines.length - 1);
}

function describeError(error: unknown, depth: number, redact: prepare.Redact, clean: (stack: string) => string): unknown {
  if (!prepare.isError(error)) {
    if (typeof error === "object" && error !== null) return errorFields(error);
    return { value: prepare.stringForm(error, redact) };
  }
  const name = field(error, "name");
  const message = field(error, "message");
  const out: Record<string, unknown> = { name: cut(name, prepare.MAX_ATTRIBUTE_STRING_BYTES), message: cut(message, ERROR_MESSAGE_BYTES) };
  const stack = field(error, "stack");
  if (typeof stack === "string" && stack) {
    // V8 starts the stack with "Name: message": a huge message would push every frame out.
    const header = typeof message === "string" && message ? `${prepare.stringForm(name, redact)}: ${message}` : "";
    const text = header.length > ERROR_MESSAGE_BYTES && stack.startsWith(header)
      ? prepare.truncate(header, ERROR_MESSAGE_BYTES) + stack.slice(header.length)
      : stack;
    out.stack = prepare.truncate(clean(text), ERROR_STACK_BYTES);
  }
  const code = field(error, "code");
  if (code !== undefined) out.code = prepare.truncate(prepare.stringForm(code, redact), prepare.MAX_ATTRIBUTE_STRING_BYTES);
  const cause = field(error, "cause");
  if (cause !== undefined && depth < 3) out.cause = describeError(cause, depth + 1, redact, clean);
  return out;
}

/**
 * From something thrown that isn't an Error, only the fields that name the problem, and only
 * when they are plain values: never the rest of the object (a request with its headers).
 */
function errorFields(value: object): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const key of ["name", "message", "code", "status"] as const) {
    let field: unknown;
    try {
      field = (value as Record<string, unknown>)[key];
    } catch {
      continue; // a getter that throws
    }
    if (typeof field === "string") out[key] = prepare.truncate(field, prepare.MAX_ATTRIBUTE_STRING_BYTES);
    else if ((typeof field === "number" && Number.isFinite(field)) || typeof field === "boolean") out[key] = field;
  }
  return out;
}

/** Type, message and the top stack frame: what makes two uncaught errors the same one. */
function fingerprint(error: unknown): string {
  if (!prepare.isError(error)) return `${typeof error}|${prepare.stringForm(error)}`;
  const stack = field(error, "stack");
  const frames = (typeof stack === "string" ? stack : "").split("\n").slice(1);
  const top = frames.find((line) => /^\s*at\s|@/.test(line))?.trim() ?? "";
  return `${prepare.stringForm(field(error, "name"))}|${prepare.stringForm(field(error, "message"))}|${top}`;
}

/** A field of something thrown, or undefined when reading it throws (a getter, a proxy). */
function field(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** A string cut to `bytes`; anything else as it is (the payload's own limits apply). */
function cut(value: unknown, bytes: number): unknown {
  return typeof value === "string" ? prepare.truncate(value, bytes) : value;
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  } catch {
    // unsupported
  }
  return undefined;
}

/** `timeoutMs` when it is a positive number, else the fallback. */
function timeoutOption(options: FlushOptions | undefined, fallback: number | undefined): number | undefined {
  const value = typeof options === "object" && options !== null ? options.timeoutMs : undefined;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** The promise, or `undefined` once `ms` have passed, whichever comes first (never rejects). */
function within(work: Promise<void>, ms: number | undefined): Promise<void> {
  const settled = work.catch(() => undefined);
  if (ms === undefined) return settled;
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      timer = setTimeout(resolve, ms);
    } catch {
      // no timers: wait for the work itself
    }
    void settled.then(() => {
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    });
  });
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function safe<T>(work: () => T, fallback: T): T {
  try {
    return work();
  } catch {
    return fallback;
  }
}

function warn(text: string): void {
  try {
    console.warn(`[lyrelog] ${text}`);
  } catch {
    // no console
  }
}

/** 16 MiB, 512 KiB, or bytes when it isn't a whole number of either. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} bytes`;
}

function debugLog(text: string): void {
  try {
    console.debug(`[lyrelog] ${text}`);
  } catch {
    // no console
  }
}
