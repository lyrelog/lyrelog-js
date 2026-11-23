/** Severity, lowest first. Same names as every Lyrelog SDK and the ingest. */
export type Level = "trace" | "debug" | "info" | "notice" | "warning" | "error" | "critical";

export const LEVELS: readonly Level[] = ["trace", "debug", "info", "notice", "warning", "error", "critical"];

/**
 * `granted` sends, `pending` keeps events in memory unsent until you decide, `denied` drops
 * everything queued and everything that follows. Any other value is taken as `pending`, with one
 * warning.
 */
export type Consent = "granted" | "pending" | "denied";

/** For `flush()` and `close()`. */
export interface FlushOptions {
  /**
   * The longest the returned promise waits, in milliseconds; what isn't sent by then stays
   * queued. `close()` defaults to 5000; `flush()` to no overall limit (each request still gives
   * up after 30 s).
   */
  timeoutMs?: number;
}

/**
 * Small fields to filter and chart by: strings, numbers, booleans, null, string arrays and nested
 * objects (up to 4 levels). Anything else is turned into one of those; nothing throws.
 */
export type Attributes = Record<string, unknown>;

export interface LogOptions {
  /** The area of the app (`checkout`, `auth`); the dashboard filters by it. */
  category?: string;
  attrs?: Attributes;
  /** Any JSON, for detail you only read when opening one event (up to 64 KiB serialized). */
  payload?: unknown;
}

export interface ExceptionOptions {
  category?: string;
  attrs?: Attributes;
  /** Defaults to `error`. */
  level?: Level;
}

export interface Config {
  /**
   * The ingest. Default `https://ingest.lyrelog.com` (hosted Lyrelog); set it only for your own
   * server. https, or http on localhost; `/v1/events:batch` is added unless already there.
   */
  endpoint?: string;
  /** The project's ingest key `lyr_ing_...`. Safe in client code: it can only append events. */
  apiKey: string;
  /** `production`, `development` or any name. Detected when left out. */
  environment?: string;
  /** Which part of the product sends: `web` in a browser and `node` on Node unless you say (`api`, `worker`). */
  platform?: string;
  /** Your app's version, sent as `resource.app_version`. */
  release?: string;
  /** Your app's id (site, package or service name), sent as `resource.app_id`. */
  appId?: string;
  /** Events below this level are dropped before queueing. Default `debug`. */
  minimumLevel?: Level;
  /** How often queued events are sent. Default 5000. */
  flushIntervalMs?: number;
  /** Events waiting in memory; beyond it the oldest are dropped. Default 10000. */
  maxQueue?: number;
  /**
   * Bytes waiting in memory (the serialized events, and the gzipped copy of a batch waiting for
   * a retry); beyond it the oldest events are dropped. Default 16 MiB.
   */
  maxQueueBytes?: number;
  /** Default `granted`. */
  consent?: Consent;
  /**
   * Record uncaught errors and unhandled promise rejections as `exception` with `handled: false`
   * (web: `window` `error` / `unhandledrejection`; Node: `uncaughtExceptionMonitor`). Default true.
   */
  captureErrors?: boolean;
  /**
   * The key names to redact. Left out, the defaults (`DEFAULT_REDACT_KEYS`): `authorization`,
   * `cookie`, `password`, `passwd`, `secret`, `token`, `apikey`, `privatekey`, `credential`,
   * `credentials`, `accesskey`, `signature`. Your list replaces them (extend them with
   * `[...DEFAULT_REDACT_KEYS, "ssn"]`); an empty list turns redaction off. A key is redacted when
   * its name, lowercased and without `-`, `_`, `.` or spaces, is one of these or ends with one
   * (`X-Api-Key`, `csrf_token`, `Set-Cookie` match; `token_count`, `max_tokens` don't); your
   * names are normalised the same way. Their values become `"[redacted]"` in attrs, payload and
   * anything turned into a string.
   */
  redactKeys?: readonly string[];
  /**
   * Called with every event before it is queued (after redaction): return it, changed or not, or
   * `null` to drop it. What it returns is fitted to the limits again. A hook that throws drops
   * the event.
   */
  beforeSend?: (event: LyrelogEvent) => LyrelogEvent | null | undefined;
}

/** An event as `beforeSend` sees it. The ids, timestamp and resource can't be changed. */
export interface LyrelogEvent {
  readonly event_id: string;
  readonly ts: string;
  level: Level;
  category?: string;
  message: string;
  user_id?: string;
  readonly install_id?: string;
  readonly session_id?: string;
  attrs?: Attributes;
  payload?: unknown;
  readonly resource: Readonly<Resource>;
}

/** What `client.stats()` reports. */
export interface Stats {
  /** Events waiting to be sent. */
  queued: number;
  /** The memory they take: serialized events plus gzipped copies kept for a retry. */
  queuedBytes: number;
  /** Events dropped because the queue was full, since `init`. */
  dropped: number;
  /** Events the server stored, since `init`. */
  delivered: number;
  /** Events the server refused (bad shape) or dropped with their batch (400, 413...). */
  rejected: number;
  /** Uncaught errors not recorded by the flood guard (10 a minute, the same one once per 10 s). */
  skippedErrors: number;
  /** True after a 401/403: the key is wrong or revoked, nothing more is sent until a restart. */
  disabled: boolean;
}

/** The context sent with every event (only these keys: the server rejects unknown ones). */
export interface Resource {
  app_id?: string;
  app_version?: string;
  app_build?: string;
  os_name?: string;
  os_version?: string;
  device_model?: string;
  locale?: string;
  sdk?: string;
  environment?: string;
  platform?: string;
}

export interface LevelMethods<Options> {
  trace(message: string, options?: Options): void;
  debug(message: string, options?: Options): void;
  info(message: string, options?: Options): void;
  notice(message: string, options?: Options): void;
  warning(message: string, options?: Options): void;
  /** The same as `warning` (the level sent is `warning`). */
  warn(message: string, options?: Options): void;
  error(message: string, options?: Options): void;
  critical(message: string, options?: Options): void;
}

/** A logger for one area of the app: every event it records carries its `category`. */
export interface Logger extends LevelMethods<Omit<LogOptions, "category">> {
  readonly category: string;
  log(level: Level, message: string, options?: Omit<LogOptions, "category">): void;
}
