import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzip } from "node:zlib";
import {
  fanout,
  MemorySession,
  SDK,
  uuid,
  type LifecycleHooks,
  type Platform,
  type SessionClock,
  type Spool,
  type UncaughtHandler,
} from "./platform.js";
import type { Resource } from "./types.js";

/** `production` when NODE_ENV says so, `development` otherwise. */
export function nodeEnvironment(nodeEnv: string | undefined): string {
  return nodeEnv === "production" ? "production" : "development";
}

function locale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale.replace(/-/g, "_");
  } catch {
    return undefined;
  }
}

/** A crash spool never grows past this: a crash loop must not fill the disk. */
export const SPOOL_MAX_BYTES = 256 * 1024;

/**
 * `<tmp>/lyrelog-<uid>`: the user's own directory (mode 700) in the shared temp directory, so
 * nobody else can read the crash events, plant a file or a symlink in their place.
 */
export function spoolDir(base = os.tmpdir()): string {
  let owner: string;
  try {
    owner = typeof process.getuid === "function" ? String(process.getuid()) : os.userInfo().username;
  } catch {
    owner = "user";
  }
  return path.join(base, `lyrelog-${owner.replace(/[^A-Za-z0-9_.-]/g, "_")}`);
}

/** `<spoolDir>/<first 12 hex of sha256(apiKey)>.ndjson`: one file per project key. */
export function spoolPath(apiKey: string, dir = spoolDir()): string {
  const digest = createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
  return path.join(dir, `${digest}.ndjson`);
}

/** Opening never follows a symlink in the last component (where the OS has the flag). */
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** Creates the directory (700) or checks the one there: a real directory, ours, private. */
function secureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`lyrelog: ${dir} is not a directory`);
  if (typeof process.getuid === "function") {
    if (stat.uid !== process.getuid()) throw new Error(`lyrelog: ${dir} belongs to another user`);
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  }
}

/** Synchronous on purpose: the process writing it is about to die. */
export function fileSpool(file: string): Spool {
  return {
    append(line: string): void {
      const text = `${line.replace(/\n/g, " ")}\n`;
      secureDir(path.dirname(file));
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW, 0o600);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size + Buffer.byteLength(text) > SPOOL_MAX_BYTES) return;
        fs.writeSync(fd, text);
      } finally {
        fs.closeSync(fd);
      }
    },
    drain(): string[] {
      // Moved aside first, so two processes starting together don't both send it. A rename
      // moves a symlink itself, and the read below refuses one.
      const claimed = `${file}.${process.pid}.${uuid()}`;
      try {
        fs.renameSync(file, claimed);
      } catch {
        return [];
      }
      try {
        const fd = fs.openSync(claimed, fs.constants.O_RDONLY | NOFOLLOW);
        try {
          if (!fs.fstatSync(fd).isFile()) return [];
          return fs.readFileSync(fd, "utf8").split("\n").filter((line) => line.length > 0);
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return [];
      } finally {
        try {
          fs.unlinkSync(claimed);
        } catch {
          // already gone
        }
      }
    },
    clear(): void {
      try {
        fs.unlinkSync(file);
      } catch {
        // nothing there
      }
    },
  };
}

const onBeforeExit = fanout<[]>((fire) => {
  process.on("beforeExit", fire);
  return () => process.off("beforeExit", fire);
});

const onUncaughtMonitor = fanout<[Error, string]>((fire) => {
  process.on("uncaughtExceptionMonitor", fire);
  return () => process.off("uncaughtExceptionMonitor", fire);
});

export const nodePlatform: Platform = {
  name: "node",
  keepalive: false,
  userAgent: SDK,
  resource(): Resource {
    const env = process.env;
    return {
      app_id: env.npm_package_name || undefined,
      app_version: env.npm_package_version || undefined,
      os_name: process.platform,
      os_version: os.release(),
      device_model: typeof os.machine === "function" ? os.machine() : os.arch(),
      locale: locale(),
    };
  },
  detectEnvironment(): string {
    return nodeEnvironment(process.env.NODE_ENV);
  },
  /** Per process: a server has no installation to remember. */
  installId(): string {
    return uuid();
  },
  /** Per process. */
  session(): SessionClock {
    return new MemorySession();
  },
  compress(body: Uint8Array): Promise<Uint8Array | undefined> {
    return new Promise((resolve) => {
      gzip(body, (error, result) => resolve(error ? undefined : new Uint8Array(result.buffer, result.byteOffset, result.byteLength)));
    });
  },
  install(hooks: LifecycleHooks): () => void {
    return onBeforeExit(() => hooks.exit());
  },
  /**
   * The monitor event only observes: the process still crashes exactly as it would without
   * Lyrelog. (`uncaughtException` and `unhandledRejection` listeners would change that.)
   */
  installErrors(handler: UncaughtHandler): () => void {
    return onUncaughtMonitor((error, origin) => handler(error, origin));
  },
  spool(apiKey: string): Spool {
    return fileSpool(spoolPath(apiKey));
  },
  unrefTimer(timer: unknown): void {
    (timer as { unref?: () => void }).unref?.();
  },
};
