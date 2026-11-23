import {
  SESSION_TIMEOUT_MS,
  uuid,
  type LifecycleHooks,
  type Platform,
  type SessionClock,
  type UncaughtHandler,
} from "./platform.js";
import { isError } from "./prepare.js";
import type { Resource } from "./types.js";

const INSTALL_KEY = "lyrelog.install_id";
const SESSION_KEY = "lyrelog.session";

/** Every storage access can throw (private mode, blocked cookies, sandboxed iframes). */
function storage(kind: "localStorage" | "sessionStorage"): Storage | undefined {
  try {
    return (globalThis as Record<string, unknown>)[kind] as Storage | undefined;
  } catch {
    return undefined;
  }
}

function read(kind: "localStorage" | "sessionStorage", key: string): string | null {
  try {
    return storage(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(kind: "localStorage" | "sessionStorage", key: string, value: string): void {
  try {
    storage(kind)?.setItem(key, value);
  } catch {
    // full or blocked: the id lives in memory for this page
  }
}

function erase(kind: "localStorage" | "sessionStorage", key: string): void {
  try {
    storage(kind)?.removeItem(key);
  } catch {
    // blocked: nothing was stored either
  }
}

/** A coarse browser family from the user agent: enough to group by, nothing to fingerprint. */
export function browserFamily(userAgent: string): string {
  if (/Edg(e|A|iOS)?\//.test(userAgent)) return "Edge";
  if (/OPR\/|Opera/.test(userAgent)) return "Opera";
  if (/SamsungBrowser\//.test(userAgent)) return "Samsung Internet";
  if (/Firefox\/|FxiOS\//.test(userAgent)) return "Firefox";
  if (/Chrome\/|CriOS\/|Chromium\//.test(userAgent)) return "Chrome";
  if (/Safari\//.test(userAgent)) return "Safari";
  return "Other";
}

/** `development` on localhost, `production` everywhere else. */
export function webEnvironment(hostname: string | undefined): string {
  const host = (hostname ?? "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost")) return "development";
  return "production";
}

/**
 * A session per tab, kept in sessionStorage with its last activity so a reload continues it;
 * a new one starts after 30 minutes without an event. Without consent (`persisted` false) it
 * lives in memory only and storage is never touched.
 */
export class WebSession implements SessionClock {
  private current: string | undefined;
  private last = 0;
  private persisted = 0;

  constructor(
    private readonly timeoutMs = SESSION_TIMEOUT_MS,
    private stored = true,
  ) {
    if (!stored) return;
    try {
      const saved = JSON.parse(read("sessionStorage", SESSION_KEY) ?? "null") as { id?: unknown; last?: unknown } | null;
      if (saved && typeof saved.id === "string" && typeof saved.last === "number") {
        this.current = saved.id;
        this.last = saved.last;
      }
    } catch {
      // nothing usable saved
    }
  }

  get id(): string | undefined {
    return this.current;
  }

  persist(on: boolean): void {
    if (on === this.stored) return;
    this.stored = on;
    if (on && this.current !== undefined) {
      this.persisted = this.last;
      write("sessionStorage", SESSION_KEY, JSON.stringify({ id: this.current, last: this.last }));
    }
  }

  touch(now: number): string {
    let changed = false;
    if (this.current === undefined || now - this.last > this.timeoutMs) {
      this.current = uuid();
      changed = true;
    }
    this.last = now;
    // One write a second at most: sessionStorage is synchronous.
    if (this.stored && (changed || now - this.persisted >= 1000)) {
      this.persisted = now;
      write("sessionStorage", SESSION_KEY, JSON.stringify({ id: this.current, last: now }));
    }
    return this.current;
  }
}

/**
 * A URL's query string and fragment, up to the `:line:column` a stack frame puts after it. They
 * carry tokens (`?token=`, `#access_token=`) that have no place in a log.
 */
const URL_QUERY = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#()]*)[?#][^\s()]*?(?=(?::\d+){0,2}(?:[\s()]|$))/gi;

/** Every URL in `text` without its query string and fragment. */
export function stripUrlQueries(text: string): string {
  return text.replace(URL_QUERY, "$1");
}

interface ErrorEventLike {
  error?: unknown;
  message?: unknown;
  filename?: unknown;
  lineno?: unknown;
  colno?: unknown;
}

/**
 * What a window `error` event carries: its `error` when that is an Error, else one built from
 * the message and location. `undefined` for the opaque "Script error." a cross-origin script
 * without CORS gives, which says nothing.
 */
export function errorFromEvent(event: ErrorEventLike): unknown {
  if (isError(event.error)) return event.error;
  const message = typeof event.message === "string" ? event.message : "";
  const filename = typeof event.filename === "string" ? stripUrlQueries(event.filename) : "";
  const line = typeof event.lineno === "number" ? event.lineno : 0;
  const column = typeof event.colno === "number" ? event.colno : 0;
  if (event.error !== undefined && event.error !== null) return event.error; // `throw "text"`
  if (/^(Uncaught )?Script error\.?$/i.test(message.trim()) && !filename && !line) return undefined;
  if (!message && !filename) return undefined;
  const error = new Error(message || "Unknown error");
  error.stack = `Error: ${message}\n    at ${filename || "<anonymous>"}:${line}:${column}`;
  return error;
}

async function gzip(body: Uint8Array): Promise<Uint8Array | undefined> {
  if (typeof CompressionStream === "undefined" || typeof Response === "undefined" || typeof Blob === "undefined") {
    return undefined;
  }
  const stream = new Blob([body as unknown as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const webPlatform: Platform = {
  name: "web",
  keepalive: true,
  resource(): Resource {
    const nav = (globalThis as { navigator?: Navigator }).navigator;
    const loc = (globalThis as { location?: Location }).location;
    return {
      app_id: loc?.hostname || undefined,
      os_name: "web",
      device_model: nav?.userAgent ? browserFamily(nav.userAgent) : undefined,
      locale: nav?.language ? nav.language.replace(/-/g, "_") : undefined,
    };
  },
  detectEnvironment(): string {
    return webEnvironment((globalThis as { location?: Location }).location?.hostname);
  },
  installId(persist: boolean): string {
    if (!persist) return uuid();
    const saved = read("localStorage", INSTALL_KEY);
    if (saved) return saved;
    const id = uuid();
    write("localStorage", INSTALL_KEY, id);
    return id;
  },
  session(persist: boolean): SessionClock {
    return new WebSession(SESSION_TIMEOUT_MS, persist);
  },
  persistIds(installId: string): void {
    if (installId) write("localStorage", INSTALL_KEY, installId);
  },
  forgetIds(): void {
    erase("localStorage", INSTALL_KEY);
    erase("sessionStorage", SESSION_KEY);
  },
  compress: gzip,
  cleanStack: stripUrlQueries,
  install(hooks: LifecycleHooks): () => void {
    const target = globalThis as unknown as Window;
    const doc = (globalThis as { document?: Document }).document;
    if (typeof target.addEventListener !== "function") return () => undefined;
    const onHide = () => hooks.hide();
    const onVisibility = () => {
      if (doc?.visibilityState === "hidden") hooks.hide();
    };
    target.addEventListener("pagehide", onHide);
    doc?.addEventListener("visibilitychange", onVisibility);
    return () => {
      target.removeEventListener("pagehide", onHide);
      doc?.removeEventListener("visibilitychange", onVisibility);
    };
  },
  /** Listens only: never `preventDefault`, so the console still shows every error. */
  installErrors(handler: UncaughtHandler): () => void {
    const target = globalThis as unknown as Window;
    if (typeof target.addEventListener !== "function") return () => undefined;
    const onError = (event: Event) => {
      const error = errorFromEvent(event as ErrorEventLike);
      if (error !== undefined) handler(error, "onerror");
    };
    const onRejection = (event: Event) => handler((event as { reason?: unknown }).reason, "onunhandledrejection");
    target.addEventListener("error", onError);
    target.addEventListener("unhandledrejection", onRejection);
    return () => {
      target.removeEventListener("error", onError);
      target.removeEventListener("unhandledrejection", onRejection);
    };
  },
};
