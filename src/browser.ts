import { makeLyrelog } from "./api.js";

export { DEFAULT_REDACT_KEYS } from "./prepare.js";
import { webPlatform } from "./platform-web.js";

export type {
  Attributes,
  Client,
  Config,
  Consent,
  ExceptionOptions,
  FlushOptions,
  Level,
  LogOptions,
  Logger,
  LyrelogEvent,
  LyrelogStatic,
  Resource,
  Stats,
} from "./api.js";

/**
 * Lyrelog for the browser: structured logs and errors from your website to Lyrelog, the hosted
 * log service (or your own ingest, with `endpoint`).
 *
 * ```ts
 * const log = Lyrelog.init({ apiKey: "lyr_ing_..." }); // sends to https://ingest.lyrelog.com
 * log.info("checkout_done", { category: "checkout", attrs: { items: 3 } });
 * ```
 */
export const Lyrelog = makeLyrelog(webPlatform);
export default Lyrelog;
