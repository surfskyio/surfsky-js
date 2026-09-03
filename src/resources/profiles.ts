import type { Surfsky } from "../client.js";
import type { ProxyInput } from "../proxy.js";
import { resolveProxy } from "../proxy.js";
import type { Spec } from "../transport.js";
import { ref } from "../transport.js";
import type {
  ActiveProfile,
  BatchDeleteResult,
  Cookie,
  ExportFormat,
  ListPageRequest,
  OneTimeStartRequest,
  Profile,
  ProfileCreateRequest,
  ProfileRef,
  ProfileSummary,
  ProfileUpdateRequest,
  ProxyLike,
  ScrapeRequest,
  ScrapeResult,
  Session,
  StopAllResult,
} from "../types.js";
import {
  isRecord,
  parseListPageRequest,
  parseOneTimeStartRequest,
  parseProfileCreateRequest,
  parseProfileStartRequest,
  parseProfileUpdateRequest,
  parseScrapeRequest,
} from "../types.js";
import { dropNulls, withTimeout } from "../util.js";

type WithProxyInput<T> = Omit<T, "proxy"> & { proxy?: ProxyInput | null };

export type SessionOptions = WithProxyInput<OneTimeStartRequest>;
export type ProfileUpdate = WithProxyInput<ProfileUpdateRequest>;
export type ProfileCreate = WithProxyInput<ProfileCreateRequest>;

export type ScrapeOptions = Omit<ScrapeRequest, "url">;

export type ListPageOptions = ListPageRequest;

export const SCRAPE_TIMEOUT = 150_000;

function sessionUuid(session: Session | string): string {
  return ref(typeof session === "string" ? session : session.internal_uuid);
}

export function startOneTimeSpec(
  options: SessionOptions,
  proxy: ProxyLike | null | undefined,
): Spec<Session> {
  const request = parseOneTimeStartRequest({ ...options, proxy });
  return { method: "POST", path: "/profiles/one_time", json: request };
}

export function startSpec(
  uuid: string,
  options: SessionOptions,
  proxy: ProxyLike | null | undefined,
): Spec<Session> {
  const request = parseProfileStartRequest({ ...options, proxy });
  return {
    method: "POST",
    path: `/profiles/${ref(uuid)}/start`,
    json: request,
  };
}

export function stopSpec(session: Session | string): Spec<ProfileRef | null> {
  return {
    method: "POST",
    path: `/profiles/${sessionUuid(session)}/stop`,
    parse: (data) => (data ? (data as ProfileRef) : null),
  };
}

export function stopAllSpec(): Spec<StopAllResult> {
  return { method: "POST", path: "/profiles/stop" };
}

export function listActiveSpec(): Spec<ActiveProfile[]> {
  return {
    method: "GET",
    path: "/profiles/active",
    parse: (data) => data ?? [],
  };
}

export function createSpec(
  options: ProfileCreate,
  proxy: ProxyLike | null | undefined,
): Spec<ProfileRef> {
  const request = parseProfileCreateRequest({ ...options, proxy });
  return { method: "POST", path: "/profiles", json: request };
}

export function getSpec(uuid: string): Spec<Profile> {
  return { method: "GET", path: `/profiles/${ref(uuid)}` };
}

export function updateSpec(uuid: string, fields: ProfileUpdateRequest): Spec<Profile> {
  const body: Record<string, unknown> = parseProfileUpdateRequest(fields);
  for (const [key, value] of Object.entries(fields)) if (value === null) body[key] = null;
  return { method: "PATCH", path: `/profiles/${ref(uuid)}`, json: body };
}

export function deleteSpec(uuid: string): Spec<ProfileRef> {
  return { method: "DELETE", path: `/profiles/${ref(uuid)}` };
}

export function deleteManySpec(uuids: string[]): Spec<BatchDeleteResult> {
  return {
    method: "DELETE",
    path: "/profiles",
    json: { uuids },
    // a 400 that still lists deleted_uuids is a partial success
    acceptError: (status, body) =>
      status === 400 &&
      isRecord(body) &&
      isRecord(body.data) &&
      "deleted_uuids" in body.data,
  };
}

export function listPageSpec(options: ListPageOptions): Spec<ProfileSummary[]> {
  const { page, page_len, ordering } = parseListPageRequest(options);
  return {
    method: "GET",
    path: "/profiles",
    params: { page, page_len, ordering },
    parse: (data) => data ?? [],
  };
}

export function exportCookiesSpec(
  uuid: string,
  exportFormat: ExportFormat,
): Spec<Cookie[] | string> {
  return {
    method: "GET",
    path: `/profiles/${ref(uuid)}/cookies`,
    params: { export_format: exportFormat },
    parse: (data) => {
      const cookies = isRecord(data) ? data.cookies : undefined;
      if (typeof cookies === "string") return cookies; // the netscape export is 1 text blob
      return (cookies as Cookie[] | null | undefined) ?? [];
    },
  };
}

export function importCookiesSpec(uuid: string, cookies: string | Cookie[]): Spec<void> {
  const text = typeof cookies === "string" ? cookies : JSON.stringify(dropNulls(cookies));
  return {
    method: "POST",
    path: `/profiles/${ref(uuid)}/cookies`,
    json: { cookies: text },
    parse: () => undefined,
  };
}

export function scrapeSpec(
  session: Session | string,
  request: ScrapeRequest,
): Spec<ScrapeResult> {
  return {
    method: "POST",
    path: `/profiles/${sessionUuid(session)}/scrape`,
    json: parseScrapeRequest(request),
    timeout: SCRAPE_TIMEOUT,
  };
}

const STOP_TIMEOUT = 8_000;
const STOP_DEADLINE = 10_000;

/** One fast attempt to stop a session; a failure is logged, never thrown. */
export async function stopSession(client: Surfsky, internalUuid: string): Promise<void> {
  const fast = client.withOptions({ timeout: STOP_TIMEOUT, maxRetries: 0 });
  const timedOut = Symbol("timed out");
  try {
    await withTimeout(fast.profiles.stop(internalUuid), STOP_DEADLINE, () =>
      Object.assign(new Error("stop timed out"), { [timedOut]: true }),
    );
  } catch (err) {
    if (err instanceof Error && timedOut in err) {
      client.logger.warn(
        `stopping session ${internalUuid} timed out; it may keep billing`,
      );
    } else {
      client.logger.warn(`failed to stop session ${internalUuid}: ${String(err)}`);
    }
  }
}

export class Profiles {
  readonly client: Surfsky;

  constructor(client: Surfsky) {
    this.client = client;
  }

  /** Start a session on a fresh browser that is gone once stopped. */
  async startOneTime(options: SessionOptions = {}): Promise<Session> {
    const proxy = await resolveProxy(options.proxy);
    return this.client.call(startOneTimeSpec(options, proxy));
  }

  /** Start a session on a saved profile. */
  async start(uuid: string, options: SessionOptions = {}): Promise<Session> {
    const proxy = await resolveProxy(options.proxy);
    return this.client.call(startSpec(uuid, options, proxy));
  }

  async stop(session: Session | string): Promise<ProfileRef | null> {
    return this.client.call(stopSpec(session));
  }

  async stopAll(): Promise<StopAllResult> {
    return this.client.call(stopAllSpec());
  }

  async listActive(): Promise<ActiveProfile[]> {
    return this.client.call(listActiveSpec());
  }

  async create(options: ProfileCreate): Promise<ProfileRef> {
    const proxy = await resolveProxy(options.proxy);
    return this.client.call(createSpec(options, proxy));
  }

  async get(uuid: string): Promise<Profile> {
    return this.client.call(getSpec(uuid));
  }

  async update(uuid: string, fields: ProfileUpdate): Promise<Profile> {
    const { proxy, ...rest } = fields;
    return this.client.call(
      updateSpec(uuid, { ...rest, proxy: await resolveProxy(proxy) }),
    );
  }

  async delete(uuid: string): Promise<ProfileRef> {
    return this.client.call(deleteSpec(uuid));
  }

  async deleteMany(uuids: string[]): Promise<BatchDeleteResult> {
    return this.client.call(deleteManySpec(uuids));
  }

  async listPage(options: ListPageOptions = {}): Promise<ProfileSummary[]> {
    return this.client.call(listPageSpec(options));
  }

  /** Every profile, page by page. */
  async *iterAll(
    options: Omit<ListPageOptions, "page"> = {},
  ): AsyncGenerator<ProfileSummary, void, undefined> {
    const pageLen = Math.max(1, Math.min(options.page_len ?? 100, 100));
    const ordering = options.ordering ?? "created";
    for (let page = 0; ; page++) {
      const batch = await this.listPage({ page, page_len: pageLen, ordering });
      yield* batch;
      if (batch.length < pageLen) return;
    }
  }

  exportCookies(uuid: string, options?: { export_format?: "json" }): Promise<Cookie[]>;
  exportCookies(uuid: string, options: { export_format: "netscape" }): Promise<string>;
  async exportCookies(
    uuid: string,
    options: { export_format?: ExportFormat } = {},
  ): Promise<Cookie[] | string> {
    return this.client.call(exportCookiesSpec(uuid, options.export_format ?? "json"));
  }

  async importCookies(uuid: string, cookies: string | Cookie[]): Promise<void> {
    return this.client.call(importCookiesSpec(uuid, cookies));
  }

  async scrape(
    session: Session | string,
    url: string,
    options: ScrapeOptions = {},
  ): Promise<ScrapeResult> {
    return this.client.call(scrapeSpec(session, { url, ...options }));
  }
}
