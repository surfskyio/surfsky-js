import { z } from "zod";
import { ValidationError } from "./errors.js";
import { dropNulls } from "./util.js";

const os = z.enum(["win", "mac", "android"]);
const arch = z.enum(["x86", "arm"]);
const deviceType = z.enum(["phone", "tablet"]);
const waitUntil = z.enum(["domcontentloaded", "load", "networkidle", "commit"]);
const proxyType = z.enum(["residential", "mobile"]);
const profileOrdering = z.enum([
  "created",
  "-created",
  "active",
  "-active",
  "title",
  "-title",
]);
const regionalPool = z.enum([
  "western",
  "europe",
  "westeurope",
  "northamerica",
  "southamerica",
  "asia",
  "centralasia",
  "southasia",
  "eastasia",
  "sea",
  "oceania",
  "mena",
]);

export type OS = z.infer<typeof os>;
export type Arch = z.infer<typeof arch>;
export type DeviceType = z.infer<typeof deviceType>;
export type WaitUntil = z.infer<typeof waitUntil>;
export type ProxyType = z.infer<typeof proxyType>;
export type ProfileOrdering = z.infer<typeof profileOrdering>;
export type RegionalPool = z.infer<typeof regionalPool>;
export type ExportFormat = "json" | "netscape";
export type MouseButton = "left" | "right" | "middle";
export type KeyModifier = "Alt" | "Control" | "Meta" | "Shift";
export type ScrollBehavior = "smooth" | "instant";

/** A known value, or one the server added after this SDK was published. */
export type Loose<T extends string> = T | (string & {});

// a string on the wire, typed so the known values still autocomplete
const loose = <T extends string>(): z.ZodType<Loose<T>, string> =>
  z.string() as z.ZodType<Loose<T>, string>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Closed<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

const noiseSchema = z.looseObject({
  webgl: z.boolean().nullish(),
  canvas: z.boolean().nullish(),
  audio: z.boolean().nullish(),
  client_rects: z.boolean().nullish(),
});
export type Noise = Closed<z.infer<typeof noiseSchema>>;
const noise: z.ZodType<Noise, Noise> = noiseSchema;

const mediaDevicesSchema = z.looseObject({
  video_in: z.number().nullish(),
  audio_out: z.number().nullish(),
  audio_in: z.number().nullish(),
});
export type MediaDevices = Closed<z.infer<typeof mediaDevicesSchema>>;
const mediaDevices: z.ZodType<MediaDevices, MediaDevices> = mediaDevicesSchema;

const geolocationSchema = z.looseObject({
  latitude: z.number().nullish(),
  longitude: z.number().nullish(),
  accuracy: z.number().nullish(),
});
export type Geolocation = Closed<z.infer<typeof geolocationSchema>>;
const geolocation: z.ZodType<Geolocation, Geolocation> = geolocationSchema;

const fingerprintSchema = z.looseObject({
  os: loose<OS>().nullish(),
  os_arch: loose<Arch>().nullish(),
  os_version: z.string().nullish(),
  device_model: z.string().nullish(),
  device_type: loose<DeviceType>().nullish(),
  user_agent: z.string().nullish(),
  cpu: z.number().nullish(),
  ram: z.number().nullish(),
  renderer: z.string().nullish(),
  noise: noise.nullish(),
  media_devices: mediaDevices.nullish(),
  screen: z.string().nullish(),
  languages: z.array(z.string()).nullish(),
  timezone: z.string().nullish(),
  geolocation: geolocation.nullish(),
  dns: z.string().nullish(),
});
export type Fingerprint = Closed<z.infer<typeof fingerprintSchema>>;
const fingerprint: z.ZodType<Fingerprint, Fingerprint> = fingerprintSchema;

const storageOptionsSchema = z.looseObject({
  cookies: z.boolean().nullish(),
  passwords: z.boolean().nullish(),
  extensions: z.boolean().nullish(),
  localstorage: z.boolean().nullish(),
  history: z.boolean().nullish(),
  bookmarks: z.boolean().nullish(),
  serviceworkers: z.boolean().nullish(),
});
export type StorageOptions = Closed<z.infer<typeof storageOptionsSchema>>;
const storageOptions: z.ZodType<StorageOptions, StorageOptions> = storageOptionsSchema;

const browserSettings = z.strictObject({
  inactive_kill_timeout: z.number().int().optional(),
  cache_enabled: z.boolean().optional(),
  cache_key: z.string().optional(),
});

export type BrowserSettings = z.infer<typeof browserSettings>;

const shared = z.strictObject({
  tier: z.literal("shared"),
  country: z.string().min(1).optional(),
});

// no tier: premium if the account has a premium provider, else shared
const premium = z
  .strictObject({
    tier: z.literal("premium").optional(),
    country: z.string().min(1).optional(),
    region: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    type: proxyType.optional(),
    pool: regionalPool.optional(),
    asn: z.number().int().min(1).max(4294967295).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    session_minutes: z.number().int().min(1).max(10080).optional(),
    unique_ip: z.boolean().optional(),
    keep_asn: z.boolean().optional(),
    keep_ip: z.boolean().optional(),
  })
  .superRefine((p, ctx) => {
    const gps = p.lat !== undefined || p.lon !== undefined;
    const set = (v: unknown): boolean => v !== undefined;
    const geo = set(p.country) || set(p.region) || set(p.city) || set(p.asn);
    if ([set(p.pool), gps, geo].filter(Boolean).length > 1) {
      ctx.addIssue(
        "'pool', 'lat'/'lon' and 'country'/'region'/'city'/'asn' are 3 separate targeting modes - use one!",
      );
    }
    if (gps && (p.lat === undefined || p.lon === undefined)) {
      ctx.addIssue("'lat' and 'lon' must be sent together");
    }
    if (set(p.region) && !set(p.country))
      ctx.addIssue("region targeting requires country");
    if (set(p.city) && !set(p.region)) ctx.addIssue("city targeting requires region");
    if (set(p.asn) && !set(p.country)) ctx.addIssue("asn targeting requires country");
  });

const proxySelector = z.discriminatedUnion("tier", [shared, premium], {
  // only the discriminator; a non-object keeps zod's "expected object"
  error: (issue) =>
    issue.code === "invalid_union" ? 'tier must be "shared" or "premium"' : undefined,
});

export type SharedProxy = z.infer<typeof shared>;
export type PremiumProxy = z.infer<typeof premium>;
/** A proxy URL of your own, or a selector for one of Surfsky's pools. */
export type ProxyLike = string | SharedProxy | PremiumProxy;

// a union would report "Invalid input"; this keeps the selector's own messages
const proxyLike = z.custom<ProxyLike>().superRefine((value, ctx) => {
  if (typeof value === "string") return;
  // a class instance (a `URL`, say) keeps its fields on the prototype: it would
  // pass as an empty selector and run the session on an arbitrary premium proxy
  const proto = isRecord(value) ? Object.getPrototypeOf(value) : null;
  if (proto !== null && proto !== Object.prototype) {
    ctx.addIssue("a proxy is a URL string or a plain selector object");
    return;
  }
  for (const issue of proxySelector.safeParse(value).error?.issues ?? []) {
    ctx.addIssue({ ...issue });
  }
});

const domainRoute = z.strictObject({
  proxy: z.string(),
  domain: z.array(z.string()).optional(),
  domain_suffix: z.array(z.string()).optional(),
  domain_keyword: z.array(z.string()).optional(),
  domain_regex: z.array(z.string()).optional(),
});

export type DomainRoute = z.infer<typeof domainRoute>;

const cookieInput = z.union([z.string(), z.array(z.record(z.string(), z.unknown()))], {
  error: "expected a cookie string or an array of cookie objects",
});

export type CookieInput = z.infer<typeof cookieInput>;

const oneTimeStartRequest = z.strictObject({
  fingerprint: fingerprint.optional(),
  proxy: proxyLike.nullish(),
  browser_settings: browserSettings.optional(),
  enable_chromedriver: z.boolean().optional(),
  extensions: z.array(z.string()).max(5).optional(),
  proxy_blacklist: z.array(z.string()).optional(),
  domain_routes: z.array(domainRoute).optional(),
  cookies: cookieInput.optional(),
});

// a profile keeps its own; sending one here is a mistake worth naming
const oneTimeOnly = (field: string): z.ZodType<undefined | null> =>
  z.undefined({ error: `${field} applies to one-time sessions only` }).nullish();

const profileStartRequest = oneTimeStartRequest.extend({
  fingerprint: oneTimeOnly("fingerprint"),
  cookies: oneTimeOnly("cookies"),
});

const profileCreateRequest = z.strictObject({
  title: z.string().min(1),
  fingerprint: fingerprint,
  description: z.string().optional(),
  proxy: proxyLike.nullish(),
  cookies: cookieInput.optional(),
  storage_options: storageOptions.optional(),
});

const profileUpdateRequest = z.strictObject({
  title: z.string().optional(),
  /** `null` clears it. */
  description: z.string().nullish(),
  proxy: proxyLike.nullish(),
  // a profile keeps these for life; an update drops them
  fingerprint: fingerprint
    .transform(({ os, os_arch, os_version, device_model, device_type, ...rest }) => rest)
    .optional(),
  storage_options: storageOptions.nullish(),
});

const listPageRequest = z.strictObject({
  page: z.number().int().min(0).optional(),
  page_len: z.number().int().min(1).optional(),
  ordering: profileOrdering.optional(),
});

const scrapeRequest = z.strictObject({
  url: z.string(),
  screenshot: z.boolean().optional(),
  /** Seconds, 0-60. */
  wait: z.number().min(0).max(60).optional(),
  wait_until: waitUntil.optional(),
  wait_for: z.string().optional(),
  /** 0-3. */
  human_actions: z.number().int().min(0).max(3).optional(),
});

export type OneTimeStartRequest = z.infer<typeof oneTimeStartRequest>;
export type ProfileStartRequest = z.infer<typeof profileStartRequest>;
export type ProfileCreateRequest = z.infer<typeof profileCreateRequest>;
/** As the caller writes it; the parse strips the immutable fingerprint fields. */
export type ProfileUpdateRequest = z.input<typeof profileUpdateRequest>;
export type ListPageRequest = z.infer<typeof listPageRequest>;
export type ScrapeRequest = z.infer<typeof scrapeRequest>;

type Parser<T> = (value: unknown) => T;

// The schema sees the value as given: dropping nulls first would take an
// unknown key with a null value with them, and a typo has to be named. What is
// left over goes at every depth after, the way pydantic's exclude_none did.
const parser =
  <T>(schema: z.ZodType<T>, what: string): Parser<T> =>
  (value) => {
    const result = schema.safeParse(value);
    if (result.success) return dropNulls(result.data);
    throw new ValidationError(`${what}: ${z.prettifyError(result.error)}`, result.error);
  };

export const parseOneTimeStartRequest: Parser<OneTimeStartRequest> = parser(
  oneTimeStartRequest,
  "start_one_time",
);
export const parseProfileStartRequest: Parser<ProfileStartRequest> = parser(
  profileStartRequest,
  "start",
);
export const parseProfileCreateRequest: Parser<ProfileCreateRequest> = parser(
  profileCreateRequest,
  "create",
);
export const parseProfileUpdateRequest: Parser<z.output<typeof profileUpdateRequest>> =
  parser(profileUpdateRequest, "update");
export const parseScrapeRequest: Parser<ScrapeRequest> = parser(scrapeRequest, "scrape");
export const parseListPageRequest: Parser<ListPageRequest> = parser(
  listPageRequest,
  "listPage",
);

export function parseProxyLike(value: unknown, what = "proxy"): ProxyLike {
  return parser(proxyLike, what)(value);
}

// --- response models: cast, not validated, so a field the server adds arrives as is ---

export interface InspectorPage {
  page_title?: string | null;
  page_url?: string | null;
  devtools_url?: string | null;
}

export interface Inspector {
  list?: string | null;
  pages?: InspectorPage[] | null;
  screencast?: string | null;
}

export interface Session {
  internal_uuid: string;
  ws_url: string;
  inspector?: Inspector | null;
}

export interface ProfileRef {
  uuid: string;
}

export interface ActiveProfile {
  internal_uuid: string;
  profile_uuid?: string | null;
  one_time?: boolean | null;
  started_at?: string | null;
  active_seconds?: number | null;
}

export interface ProfileSummary {
  uuid: string;
  title?: string | null;
  description?: string | null;
  proxy?: string | null;
  status?: string | null;
}

export interface Profile {
  uuid: string;
  title?: string | null;
  description?: string | null;
  start_pages?: unknown[] | null;
  pinned_tag?: string | null;
  proxy?: string | null;
  status?: string | null;
  storage_options?: StorageOptions | null;
  last_active?: string | null;
  fingerprint?: Fingerprint | null;
  has_user_password?: boolean | null;
  password_set_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** Cookies are camelCase on the wire, in the API and in CDP. */
export interface Cookie {
  domain?: string | null;
  name?: string | null;
  value?: string | null;
  path?: string | null;
  expirationDate?: number | null;
  hostOnly?: boolean | null;
  httpOnly?: boolean | null;
  sameSite?: string | null;
  secure?: boolean | null;
}

export interface ScrapeResult {
  url?: string | null;
  status?: number | null;
  status_text?: string | null;
  content?: string | null;
  cookies?: Cookie[] | null;
  /** base64 PNG when requested */
  screenshot?: string | null;
}

export interface BatchDeleteResult {
  deleted_uuids: string[];
  active_uuids: string[];
  not_found_uuids: string[];
}

export interface StopAllResult {
  stopped: string[];
  failed: unknown[];
}

export interface ProxyCountry {
  code: string;
  name?: string | null;
}

export interface ProxyRegion {
  code: string;
  name?: string | null;
  country?: string | null;
  country_code?: string | null;
}

export interface ProxyCity {
  code: string;
  name?: string | null;
  region?: string | null;
  region_code?: string | null;
  country?: string | null;
  country_code?: string | null;
}

export interface ProxyQuota {
  remaining_bytes?: number | null;
  remaining_gb?: number | null;
}

/** `-1` means unlimited. */
export interface SharedProxyQuota {
  limit_gb?: number | null;
  limit_bytes?: number | null;
  used_bytes?: number | null;
  remaining_bytes?: number | null;
  remaining_gb?: number | null;
  reset_time?: number | null;
}

export interface TrafficVolume {
  bytes?: number | null;
  gb?: number | null;
}

export interface TrafficStats {
  "24h"?: TrafficVolume | null;
  "7d"?: TrafficVolume | null;
  "30d"?: TrafficVolume | null;
}

export interface Renderer {
  value: string;
  platform?: string | null;
  archs?: string[] | null;
}

export interface Screen {
  value: string;
  platform?: string | null;
  archs?: string[] | null;
}

export interface DeviceModel {
  value: string;
  os?: string | null;
  os_versions?: string[] | null;
  archs?: string[] | null;
  device_type?: string | null;
}

export interface Extension {
  uuid: string;
  name?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface SessionLimits {
  has_session_limits?: boolean | null;
  spm?: number | null;
  remaining?: number | null;
  used?: number | null;
  additional_spm?: number | null;
  reset_time?: number | null;
}

export interface BrowserLimits {
  has_browser_limits?: boolean | null;
  parallel_browsers?: number | null;
  running?: number | null;
  available?: number | null;
}
