import { gunzipSync } from "node:zlib";
import { Client, type Dependencies } from "../src/client.js";
import { MemorySession, uuid, type LifecycleHooks, type Platform } from "../src/platform.js";
import type { Config } from "../src/types.js";

export interface Sent {
  url: string;
  headers: Record<string, string>;
  lines: Record<string, unknown>[];
  keepalive: boolean;
}

export type Responder = (sent: Sent, index: number) => Response | Promise<Response> | Error;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

export const ok = (sent: Sent) => json(200, { accepted: sent.lines.length, rejected: [] });

export function fakePlatform(overrides: Partial<Platform> = {}): Platform & { hooks?: LifecycleHooks } {
  const platform: Platform & { hooks?: LifecycleHooks } = {
    name: "node",
    keepalive: false,
    resource: () => ({ os_name: "test", os_version: "1" }),
    detectEnvironment: () => "development",
    installId: () => "install-1",
    session: () => new MemorySession(),
    compress: async () => undefined,
    install(hooks) {
      platform.hooks = hooks;
      return () => {
        platform.hooks = undefined;
      };
    },
    ...overrides,
  };
  return platform;
}

export function harness(config: Partial<Config> = {}, responder: Responder = ok, platform = fakePlatform(), deps: Dependencies = {}) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    let text: string;
    if (headers["Content-Encoding"] === "gzip") text = gunzipSync(init.body as Uint8Array).toString("utf8");
    else text = String(init.body);
    const record: Sent = {
      url,
      headers,
      lines: text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
      keepalive: init.keepalive === true,
    };
    sent.push(record);
    const answer = await responder(record, sent.length - 1);
    if (answer instanceof Error) throw answer;
    return answer;
  }) as unknown as typeof globalThis.fetch;
  const client = new Client(
    { endpoint: "https://ingest.test", apiKey: "lyr_ing_test", flushIntervalMs: 3_600_000, ...config },
    platform,
    { fetch, random: () => 0.5, ...deps },
  );
  return { client, sent, platform };
}

export { uuid };
