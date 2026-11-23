<p align="center">
  <a href="https://lyrelog.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://lyrelog.com/readme/js-dark.png">
      <img alt="Lyrelog for JavaScript" src="https://lyrelog.com/readme/js-light.png" width="600">
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://docs.lyrelog.com/sdks/javascript"><b>Documentation</b></a> ·
  <a href="https://docs.lyrelog.com/quickstart">Quickstart</a> ·
  <a href="https://lyrelog.com">lyrelog.com</a>
</p>

Structured logs and errors from your website or Node service to [Lyrelog](https://lyrelog.com),
the hosted log service. TypeScript, no dependencies. Browsers and Node 22.12+.

## Install

```bash
pnpm add @lyrelog/js
```

The same import works everywhere: bundlers pick the browser build, Node picks the Node build.
The package is **ESM only**: `import` it, or `require()` it on Node 22.12+, which loads ES modules
without a flag.

## Use

In the browser:

```ts
import { Lyrelog } from "@lyrelog/js";

const log = Lyrelog.init({
  apiKey: "lyr_ing_...",            // ingest-only: it can append events, never read them
  release: "2.0.1",
  consent: "granted",               // or "pending" until the person chooses
});

log.setUser(accountId);             // optional; attached to every following event
log.screen("Checkout");             // the page the person is on
log.info("checkout_done", { category: "checkout", attrs: { items: 3, total_cents: 4200 } });

try {
  await pay();
} catch (error) {
  log.captureError(error, { category: "checkout", attrs: { step: "pay" } });
}
```

On Node:

```ts
import { Lyrelog } from "@lyrelog/js";

const log = Lyrelog.init({
  apiKey: process.env.LYRELOG_KEY!,
  platform: "api",                  // optional: "node" unless you say
});

// One logger per area of the app.
const jobs = log.logger("jobs");
jobs.info("job_done", { attrs: { job: "digest", ms: 412 } });
jobs.error("job_failed", { attrs: { job: "digest" }, payload: { response: raw } });

process.on("SIGTERM", async () => {
  await log.close();                // sends what is queued, then stops
  process.exit(0);
});
```

Events go to `https://ingest.lyrelog.com`. Pass `endpoint` only to send them somewhere else (your
own ingest).

**Serverless** (AWS Lambda, Vercel and Netlify functions, Cloudflare Workers): the runtime freezes
or ends the function as soon as it answers, before the timer fires. `await log.flush()` before
returning:

```ts
export async function handler(event) {
  log.info("order_created", { attrs: { id: event.id } });
  await log.flush();
  return { statusCode: 200 };
}
```

**`process.exit()` skips `beforeExit`**, so a script that ends with `process.exit()` loses what is
still queued: `await log.close()` first, as in the `SIGTERM` handler above.

**Websites with a Content Security Policy**: allow the ingest in `connect-src`:

```
Content-Security-Policy: connect-src 'self' https://ingest.lyrelog.com
```

- `message`: a stable event name (`checkout_done`), not prose.
- `category`: the area of the app (`checkout`, `auth`, `jobs`); the dashboard filters by it.
- `attrs`: small fields to filter and chart by: ids, durations, codes, flags.
- `payload`: the big stuff you only read when you open one event: responses, traces.

## The API

```ts
const log = Lyrelog.init(config);

log.trace / debug / info / notice / warning / error / critical(message, { category?, attrs?, payload? })
log.warn(message, options?)        // the same as warning (sent as level `warning`)
log.log(level, message, options?)
log.logger(category)               // the same level methods, every event tagged with `category`
log.setUser(id | null)
log.screen(name, attrs?)           // `screen_viewed`, and `screen` on every following event
log.captureError(error, { category?, attrs?, level? })
log.setConsent("granted" | "pending" | "denied")
log.sessionId                      // the current session, e.g. for a support screen
log.stats()                        // { queued, queuedBytes, dropped, delivered, rejected, skippedErrors, disabled }
await log.flush({ timeoutMs? })    // rarely needed: the timer and page hide already send
await log.close({ timeoutMs? })    // waits at most 5 s unless you say
```

`captureException` still works and does the same as `captureError`, the name every Lyrelog SDK
shares; it is deprecated.

**`flush()` and `close()` never wait longer than `timeoutMs`.** `close()` waits at most 5 s by
default (the same budget as Node's `beforeExit` flush); what isn't sent by then is lost. `flush()`
has no overall limit unless you give one, and each request gives up after 30 s. Both never reject.

**Exceptions**: `captureError` records `exception` (level `error`) with `error_type` and
`error_message` as attributes, and the name, message, stack, `code` and up to three `cause`s in the
payload. Anything thrown works, not only `Error` (also an Error from another realm, such as an
iframe). From a thrown value that isn't an Error, only its `name`, `message`, `code` and `status`
are kept: never the rest of the object, which for an HTTP client's error would include its
request headers. In the browser, URLs in stacks lose their query string and fragment.

**Uncaught errors**: on by default (`captureErrors: false` turns it off). They are recorded like
`captureError`, with `handled: false` and a `mechanism`:

- Browser: `window` `error` (`mechanism: "onerror"`) and `unhandledrejection`
  (`"onunhandledrejection"`). Lyrelog only listens: it never calls `preventDefault`, so the console
  still shows them. The opaque `Script error.` of a cross-origin script without CORS carries
  nothing and is ignored.
- Node: `process.on("uncaughtExceptionMonitor")`, which observes without changing anything: the
  process still crashes exactly as it would without Lyrelog. `mechanism` is `uncaughtException` or
  `unhandledRejection`. A dying process has no time for a request, so the event is also written
  synchronously to `os.tmpdir()/lyrelog-<uid>/<sha256(apiKey), 12 hex>.ndjson` (the directory
  mode 700 and checked to be yours, the file mode 600, never through a symlink, at most 256 KiB)
  and the next `init` with the same key sends it and deletes the file. Consent `denied` deletes
  it unread. If the process
  survives (your own `uncaughtException` handler), the event is sent twice with the same id and
  the server keeps one.
- A flood guard: at most 10 a minute per client, and the same error (type, message, top stack
  frame) once per 10 s. What it skips is counted in `stats().skippedErrors`. `captureError`
  is never limited.
- `close()` removes the listeners.

**Screens**: `screen("Settings")` logs `screen_viewed` in the `navigation` area with the screen
before and the seconds spent on it, and every following event carries `screen`. On the web, call
it from your router when the page changes.

## Configuration

| Option | Default | |
|---|---|---|
| `apiKey` | required | The project's ingest key `lyr_ing_...`. Safe in client code. Without it the client warns once and does nothing. |
| `endpoint` | `https://ingest.lyrelog.com` | Only to send somewhere else. https (http only for `localhost`); a trailing `/v1` or `/v1/events:batch` is fine. Anything else warns once and the client does nothing. |
| `environment` | detected | Node: `production` when `NODE_ENV=production`, else `development`, **also when `NODE_ENV` is unset**: set `NODE_ENV=production` (or `environment`) on your servers. Web: `development` on `localhost`/`127.0.0.1`, else `production`. Any name works: lowercase letters, digits, `-` and `_`, up to 32. |
| `platform` | `web` / `node` | Which part of the product sends, when one project holds an app, its website and its backend (`api`, `worker`). |
| `release` | Node: `npm_package_version` | Your version, as `app_version`. |
| `appId` | web: the host name; Node: `npm_package_name` | As `app_id`. |
| `minimumLevel` | `debug` | Events below it are dropped before queueing. |
| `flushIntervalMs` | `5000` | How often the queue is sent. At least `1000`: a smaller value is raised to it. |
| `maxQueue` | `10000` | Events waiting in memory; beyond it the oldest go. |
| `maxQueueBytes` | 16 MiB | The memory they may take (with the gzipped copy of a batch waiting for a retry); beyond it the oldest go. |
| `consent` | `granted` | `pending` keeps events in memory unsent, `denied` drops everything. Any other value (`"yes"`, `true`) is taken as `pending` and warns once. |
| `captureErrors` | `true` | Record uncaught errors and unhandled rejections (see above). |
| `redactKeys` | `DEFAULT_REDACT_KEYS` | The key names to redact; your list replaces the defaults, `[]` turns it off (see Privacy). |
| `beforeSend` | | `(event) => event \| null`: change or drop any event before it is queued. |

Calling `init` again with the same endpoint and key gives back the live client when the config
is the same, and otherwise closes it and starts a new one (hot reload, a module loaded twice).

## Privacy

- **Secrets are redacted.** A value becomes `"[redacted]"` in attrs, payload and anything turned
  into a string when its key name, lowercased and without `-`, `_`, `.` or spaces, is or ends
  with one of: `authorization`, `cookie`, `password`, `passwd`, `secret`, `token`, `apikey`,
  `privatekey`, `credential`, `credentials`, `accesskey`, `signature`. So `X-Api-Key`,
  `csrf_token`, `Set-Cookie` and `user_token` are redacted; `token_count` and `max_tokens` are
  not. `redactKeys` replaces this list (your names are normalised and matched the same way; an
  empty list turns redaction off). To add to it, spread the exported defaults:
  `redactKeys: [...DEFAULT_REDACT_KEYS, "ssn"]` (`import { Lyrelog, DEFAULT_REDACT_KEYS } from "@lyrelog/js"`).
- **`beforeSend`** sees every event (ids, level, category, message, attrs, payload, resource) and
  returns it changed, or `null` to drop it. What it returns is fitted to the limits again; a hook
  that throws drops the event, and so does an event the hook logs itself (it would recurse).
- **Consent.** Until `consent` is `granted`, the browser build keeps the install and session ids in
  memory only and touches neither `localStorage` nor `sessionStorage`. Granting stores the same
  ids; `denied` deletes the queue, the stored ids and (Node) the crash spool.

## What it does for you

| | |
|---|---|
| Never blocks or throws | A log call fits the event to the server's limits, serializes it (so later changes to your objects don't leak in) and queues it. Bad input is turned into something valid, never an exception. |
| Batches | Up to 500 events or 512 KiB per request, NDJSON, gzip (`CompressionStream` in browsers, `zlib` on Node). |
| When it sends | Every 5 s, as soon as 500 events wait, on `flush()` and `close()`. In the browser also when the page hides (`pagehide`, `visibilitychange`: one keepalive request at most); on Node on `beforeExit` (not on `process.exit()`; it gives up after 5 s, so an unreachable ingest never holds a script open), and the timer never keeps the process alive. |
| Retries | Exponential backoff with full jitter (1 s doubling to 5 min), honours `Retry-After` (at most 1 hour, the most the server asks), also in `flush()`, `close()` and page hide. After 3 failed uploads in a row (no network, 5xx, rate limit) one `console.warn` says so, then nothing more until an upload succeeds. A retry resends the same events with the same ids, which the server collapses. A bad batch (400, 404, 413) is dropped with one `console.warn`; a refused key (401, 403) stops sending until restart and keeps the events. Redirects are never followed: a 3xx drops the batch and warns once. |
| Quota | Past your plan's monthly events the ingest answers 429 with a `Retry-After` of up to an hour. The client waits that long (`flush()` returns at once meanwhile) and events pile up in memory within `maxQueue` / `maxQueueBytes`, the oldest dropped first and counted in `stats().dropped`. The first quota 429 logs one `console.warn` with the server's message; it stays quiet until a batch is accepted again, so a later quota stop warns again. The quota is not a failed upload: it doesn't grow the backoff or count toward the "uploads keep failing" warning. |
| Consent | `pending` holds, `granted` sends, `denied` deletes. |
| Context | Web: `os_name: "web"`, the browser family as `device_model`, `navigator.language` as `locale`, an install id in `localStorage` and a session id in `sessionStorage` (new after 30 min idle), both only once consent is granted. Node: `process.platform`, `os.release()`, the CPU architecture, and an install and session id per process. Storage that throws (private mode, blocked cookies) falls back to memory. |
| Limits | Fits every event before queueing: message 2,048 bytes, strings in attrs 1,024, string arrays 64 items, 4 levels of nesting, 200 attributes (the extra ones counted in `lyrelog_dropped_attrs`), ids 128, payload 64 KiB (bigger ones become `{ lyrelog_truncated, bytes, preview }`, with `at_least: true` when serializing stopped early: a huge object is never serialized whole). Strings are cut on a character boundary; dots in attribute names become `_`, and of two names that end up the same (`a.b`, `a_b`) the first stays and the other is counted as dropped. |

## Limits worth knowing

- **The queue lives in memory.** Events still waiting when a tab is closed for good, or a process
  is killed with `SIGKILL` or ends with `process.exit()`, are lost. Call `close()` in your shutdown
  path on servers, and `flush()` at the end of a serverless handler.
- **A hiding page sends at most ~60 KB, in one request.** Browsers allow 64 KiB of `keepalive`
  requests in flight per page and there is no time to compress, so the rest waits for the page to
  come back. Nothing goes while the server asked to wait (`Retry-After`). Normal sending every 5 s
  keeps that remainder small.
- **The ingest key is public on the web.** It can only append events to its project; anyone who
  reads your page source can do the same, so don't treat incoming events as trusted input.
- **Uncaught errors are not everything.** Errors a framework catches (a React error boundary, an
  Express error handler) never reach `window` or the process: call `captureError` there.

## Tests

```bash
pnpm test
LYRELOG_E2E_URL=http://localhost:8090 LYRELOG_E2E_KEY=lyr_ing_... pnpm test   # also against a running ingest
pnpm build
```

## Licence

MIT.
