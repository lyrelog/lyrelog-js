import { Client, type Dependencies } from "./client.js";
import type { Platform } from "./platform.js";
import type { Config } from "./types.js";

export type { Client } from "./client.js";
export type {
  Attributes,
  Config,
  Consent,
  ExceptionOptions,
  FlushOptions,
  Level,
  LogOptions,
  Logger,
  LyrelogEvent,
  Resource,
  Stats,
} from "./types.js";

export interface LyrelogStatic {
  /**
   * Start a client. Logging never blocks or throws; events are sent in batches. Calling it again
   * for the same endpoint and key gives back the live client when the config is the same, and
   * otherwise closes it (sending what it holds) and starts a new one, so a hot reload or a
   * second import never leaves two clients behind.
   */
  init(config: Config): Client;
}

function sameConfig(a: Config, b: Config): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof Config)[]);
  for (const key of keys) {
    const x = a[key];
    const y = b[key];
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length || x.some((item, i) => item !== y[i])) return false;
    } else if (!Object.is(x, y)) return false;
  }
  return true;
}

/**
 * @internal The registry of live clients, with the test seams (`deps`: the network, the clock,
 * the dice). Only tests call it with `deps`; the package's entry points never export it.
 */
export function makeRegistry(platform: Platform): { init(config: Config, deps?: Dependencies): Client } {
  const live = new Map<string, { client: Client; config: Config }>();
  return {
    init(input: Config, deps?: Dependencies): Client {
      // Plain JavaScript can call it with nothing: that is a client without a key (it warns).
      const config: Config = typeof input === "object" && input !== null ? input : ({} as Config);
      const key = `${String(config?.endpoint ?? "")}\u0000${String(config?.apiKey ?? "")}`;
      const existing = live.get(key);
      if (existing) {
        if (!deps && sameConfig(existing.config, config)) return existing.client;
        live.delete(key);
        void existing.client.close();
      }
      const snapshot: Config = { ...config };
      if (Array.isArray(config.redactKeys)) snapshot.redactKeys = [...config.redactKeys];
      const entry = { config: snapshot } as { client: Client; config: Config };
      entry.client = new Client(config, platform, {
        ...deps,
        onClose: () => {
          if (live.get(key) === entry) live.delete(key);
          deps?.onClose?.();
        },
      });
      live.set(key, entry);
      return entry.client;
    },
  };
}

/**
 * @internal The entry points build their `Lyrelog` with it: `init` takes the config and nothing
 * else, so an app can never swap the network, the clock or the dice.
 */
export function makeLyrelog(platform: Platform): LyrelogStatic {
  const registry = makeRegistry(platform);
  return {
    init(config: Config): Client {
      return registry.init(config);
    },
  };
}
