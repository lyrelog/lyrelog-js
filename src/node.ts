import { makeLyrelog } from "./api.js";

export { DEFAULT_REDACT_KEYS } from "./prepare.js";
import { nodePlatform } from "./platform-node.js";

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
 * Lyrelog for Node: structured logs and errors from your service to Lyrelog, the hosted log
 * service (or your own ingest, with `endpoint`).
 *
 * ```ts
 * const log = Lyrelog.init({ apiKey: process.env.LYRELOG_KEY! }); // sends to https://ingest.lyrelog.com
 * log.info("job_done", { category: "jobs", attrs: { ms: 412 } });
 * await log.close();
 * ```
 */
export const Lyrelog = makeLyrelog(nodePlatform);
export default Lyrelog;
