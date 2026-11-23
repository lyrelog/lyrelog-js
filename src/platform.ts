import type { Resource } from "./types.js";

/** Gives the session id for an event logged at `now` (ms), starting a new one when due. */
export interface SessionClock {
  touch(now: number): string;
  readonly id: string | undefined;
  /** Whether the session may be kept on the device (consent granted). */
  persist?(on: boolean): void;
}

export interface LifecycleHooks {
  /** The page is going away or hidden: send what fits in a keepalive request, synchronously. */
  hide(): void;
  /** The process is about to exit with nothing left to do: one last flush. */
  exit(): void;
}

/** Called with what was thrown and how it was caught (`onerror`, `uncaughtException`...). */
export type UncaughtHandler = (error: unknown, mechanism: string) => void;

/**
 * Events written synchronously as a process dies, sent by the next client with the same key.
 * Every method may throw; the client guards each call.
 */
export interface Spool {
  append(line: string): void;
  /** The lines waiting, and the file gone. */
  drain(): string[];
  /** Consent denied: the file gone, unread. */
  clear?(): void;
}

/** What differs between the browser and Node. The core never touches a global directly. */
export interface Platform {
  readonly name: "web" | "node";
  /** The context this platform knows (the core adds sdk, environment and platform). */
  resource(): Resource;
  detectEnvironment(): string;
  /**
   * The install id. `persist` false (consent not granted): a new one in memory, without
   * touching storage at all.
   */
  installId(persist: boolean): string;
  session(persist: boolean): SessionClock;
  /** Consent granted: keep this install id on the device. */
  persistIds?(installId: string): void;
  /** Consent denied: remove every id this SDK stored. */
  forgetIds?(): void;
  /** gzip, or `undefined` when this runtime can't. */
  compress(body: Uint8Array): Promise<Uint8Array | undefined>;
  /** Install the lifecycle listeners; returns their removal. */
  install(hooks: LifecycleHooks): () => void;
  /** Install the uncaught error listeners; returns their removal. */
  installErrors?(handler: UncaughtHandler): () => void;
  /** Where a crash's last event waits for the next run (Node only). */
  spool?(apiKey: string): Spool | undefined;
  /** Rewrites a stack before it is sent (web: URLs lose their query strings and fragments). */
  cleanStack?(stack: string): string;
  /** Whether `fetch(..., { keepalive: true })` is how a hidden page gets its last events out. */
  readonly keepalive: boolean;
  /** Sent as `User-Agent` where a runtime allows it (not in browsers: it would break CORS). */
  readonly userAgent?: string;
  /** Lets the periodic timer not hold the process open (Node's `unref`). */
  unrefTimer?(timer: unknown): void;
}

/**
 * One real listener for any number of clients: attached with the first subscriber, removed with
 * the last. Many `init`s then never pile up process listeners (MaxListenersExceededWarning).
 */
export function fanout<A extends unknown[]>(attach: (fire: (...args: A) => void) => () => void): (listener: (...args: A) => void) => () => void {
  const listeners = new Set<{ fn: (...args: A) => void }>();
  let detach: (() => void) | undefined;
  const fire = (...args: A) => {
    for (const entry of [...listeners]) {
      try {
        entry.fn(...args);
      } catch {
        // one client's failure is not another's
      }
    }
  };
  return (fn) => {
    const entry = { fn };
    listeners.add(entry);
    if (!detach) detach = attach(fire);
    return () => {
      if (!listeners.delete(entry)) return;
      if (listeners.size === 0 && detach) {
        detach();
        detach = undefined;
      }
    };
  };
}

export const SDK = "lyrelog-js/1.0.0";
export const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/** A random UUID v4, even where `crypto.randomUUID` is missing (plain-http pages). */
export function uuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      // not a secure context
    }
  }
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A session that lives as long as the process (servers), unless idle for `timeoutMs`. */
export class MemorySession implements SessionClock {
  private current: string | undefined;
  private last = 0;

  constructor(private readonly timeoutMs = Number.POSITIVE_INFINITY) {}

  get id(): string | undefined {
    return this.current;
  }

  touch(now: number): string {
    if (this.current === undefined || now - this.last > this.timeoutMs) this.current = uuid();
    this.last = now;
    return this.current;
  }
}
