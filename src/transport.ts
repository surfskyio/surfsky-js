import type { APIErrorOptions } from "./errors.js";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  MonthlySessionLimitError,
  NotFoundError,
  PaymentRequiredError,
  PremiumTrafficLimitError,
  RateLimitError,
  ServerError,
  SharedTrafficLimitError,
} from "./errors.js";
import { isRecord } from "./types.js";

export const AUTH_HEADER = "X-Cloud-Api-Token";
export const MAX_BACKOFF = 30_000;

type APIErrorClass = new (message: string, options?: APIErrorOptions) => APIError;

export const STATUS_ERRORS: Record<number, APIErrorClass> = {
  400: BadRequestError,
  401: AuthenticationError,
  402: PaymentRequiredError,
  403: ForbiddenError,
  404: NotFoundError,
  409: ConflictError,
  422: BadRequestError,
  429: RateLimitError,
};

// 429s with these codes are exhausted quotas, not rate limits: never retried
export const QUOTA_ERRORS: Record<string, APIErrorClass> = {
  shared_traffic_limit_reached: SharedTrafficLimitError,
  premium_traffic_limit_reached: PremiumTrafficLimitError,
  monthly_session_limit_reached: MonthlySessionLimitError,
};
// The plan's parallel-browser cap: a 429 the pool treats as backpressure
export const PLAN_FULL = "parallel_browsers_limit_reached";
export const NO_RETRY_CODES: ReadonlySet<string> = new Set([
  ...Object.keys(QUOTA_ERRORS),
  PLAN_FULL,
]);

const IDEMPOTENT: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "PUT",
  "DELETE",
  "OPTIONS",
]);
const RETRY_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);
// A request that failed with one of these was never sent, so a POST may retry it.
// Node (undici) codes first, then Bun's.
const NEVER_SENT: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "ConnectionRefused",
  "FailedToOpenSocket",
  "DNSError",
]);

export type Params = Record<string, string | number | boolean | undefined>;

/** One API call: the request plus how to read its reply. */
export interface Spec<T> {
  method: string;
  path: string;
  json?: unknown;
  params?: Params;
  body?: BodyInit;
  parse?: (data: any) => T;
  acceptError?: (status: number, body: unknown) => boolean;
  timeout?: number;
}

export function spec<T>(s: Spec<T>): Spec<T> {
  return s;
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const noop = (): void => {};

/** Warnings and errors go to the console unless told otherwise; `null` silences all. */
export function makeLogger(given?: Partial<Logger> | null): Logger {
  if (given === null) return { debug: noop, info: noop, warn: noop, error: noop };
  return {
    debug: given?.debug ?? noop,
    info: given?.info ?? noop,
    warn: given?.warn ?? ((message) => console.warn(message)),
    error: given?.error ?? ((message) => console.error(message)),
  };
}

export interface SendOptions {
  fetch: typeof fetch;
  baseUrl: string;
  headers: Record<string, string>;
  retries: number;
  backoff: number;
  timeout: number;
  logger: Logger;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function buildUrl(baseUrl: string, path: string, params?: Params): string {
  const url = new URL(baseUrl + path);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Send with retries. Throws only when no response ever came back. */
export async function send(spec: Spec<unknown>, options: SendOptions): Promise<Response> {
  const method = spec.method.toUpperCase();
  const url = buildUrl(options.baseUrl, spec.path, spec.params);
  const idempotent = IDEMPOTENT.has(method);
  const headers: Record<string, string> = { ...options.headers };
  let body: BodyInit | undefined = spec.body;
  if (spec.json !== undefined) {
    body = JSON.stringify(spec.json);
    headers["Content-Type"] = "application/json";
  }
  const timeout = spec.timeout ?? options.timeout;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined;
    let error: unknown;
    try {
      response = await options.fetch(url, {
        method,
        headers,
        body,
        signal: timeout > 0 ? AbortSignal.timeout(timeout) : undefined,
      });
    } catch (err) {
      error = err;
    }
    const last = attempt >= options.retries;
    let delay: number;
    if (response !== undefined) {
      if (last || !(await retryResponse(response, idempotent))) return response;
      const hinted = retryAfterMs(response);
      delay =
        hinted === undefined
          ? backoffDelay(attempt, options.backoff, random)
          : Math.min(hinted, MAX_BACKOFF);
      await response.body?.cancel();
    } else {
      if (last || !retryError(error, idempotent)) {
        if (!isTransportError(error)) throw error; // a bad argument, not the network
        throw networkError(spec.path, error);
      }
      delay = backoffDelay(attempt, options.backoff, random);
    }
    const got = response !== undefined ? response.status : describe(error);
    options.logger.warn(
      `${method} ${spec.path} -> ${got}, retry in ${(delay / 1000).toFixed(1)}s`,
    );
    await sleep(delay);
  }
}

function backoffDelay(attempt: number, backoff: number, random: () => number): number {
  return Math.min(backoff * 2 ** attempt, MAX_BACKOFF) + random() * backoff;
}

async function retryResponse(response: Response, idempotent: boolean): Promise<boolean> {
  if (response.status === 429) return !neverRetried(await parseBody(response.clone()));
  return idempotent && RETRY_STATUSES.has(response.status);
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const cause = error.cause;
  if (isRecord(cause) && typeof cause.code === "string") return cause.code;
  return typeof error.code === "string" ? error.code : undefined;
}

const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ConnectionTimeout",
]);

function isTimeout(error: unknown): boolean {
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return true;
  }
  const code = errorCode(error);
  return code !== undefined && TIMEOUT_CODES.has(code);
}

/** A failure of the transport itself, as opposed to a bad argument thrown by fetch. */
function isTransportError(error: unknown): boolean {
  if (isTimeout(error) || errorCode(error) !== undefined) return true;
  return error instanceof TypeError && error.cause !== undefined; // undici: "fetch failed"
}

function retryError(error: unknown, idempotent: boolean): boolean {
  const code = errorCode(error);
  if (code !== undefined && NEVER_SENT.has(code)) return true;
  return idempotent && isTransportError(error);
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** JSON when it parses, the text otherwise, `null` when empty. */
export async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Read a reply: map an error status, unwrap `{success, msg, data}`, parse. */
export async function result<T>(spec: Spec<T>, response: Response): Promise<T> {
  const status = response.status;
  const body = await parseBody(response);
  if (status >= 400 && !spec.acceptError?.(status, body)) {
    throw apiError(spec.method, spec.path, response, body);
  }
  let data = body;
  if (isRecord(body) && "data" in body) {
    if (body.success === false && spec.acceptError === undefined) {
      throw new APIError(String(body.msg || "request failed"), { body });
    }
    data = body.data;
  }
  try {
    return spec.parse ? spec.parse(data) : (data as T);
  } catch (err) {
    throw new APIError(
      `unexpected response from ${spec.method} ${spec.path}: ${describe(err)}`,
      {
        statusCode: status,
        body,
        requestId: requestId(response),
        headers: headersOf(response),
        cause: err,
      },
    );
  }
}

export function neverRetried(body: unknown): boolean {
  return isRecord(body) && typeof body.code === "string" && NO_RETRY_CODES.has(body.code);
}

/** The Retry-After header in ms: seconds or an HTTP date. */
export function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const when = Date.parse(value);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - Date.now());
}

export function requestId(response: Response): string | undefined {
  return response.headers.get("cf-ray") ?? undefined;
}

function headersOf(response: Response): Record<string, string> {
  return Object.fromEntries(response.headers);
}

function tokenRejected(body: unknown): boolean {
  if (!isRecord(body) || !isRecord(body.data) || !Array.isArray(body.data.errors))
    return false;
  return body.data.errors.some(
    (error) =>
      isRecord(error) &&
      Array.isArray(error.loc) &&
      error.loc.some((part) => String(part).toLowerCase() === AUTH_HEADER.toLowerCase()),
  );
}

/** Escape one path segment. An empty id would silently hit the list endpoint. */
export function ref(value: string): string {
  if (!value) throw new TypeError("an empty id would address a different endpoint");
  if (value === "." || value === "..")
    throw new TypeError(`'${value}' is not a path segment`);
  return encodeURIComponent(value);
}

function fieldErrors(details: unknown): string {
  if (Array.isArray(details)) {
    // a validation error, field by field
    return details
      .filter(isRecord)
      .map(
        (e) => `${(Array.isArray(e.loc) ? e.loc : []).map(String).join(".")}: ${e.msg}`,
      )
      .join("; ");
  }
  if (isRecord(details)) {
    return Object.entries(details)
      .map(([name, why]) => `${name}: ${why}`)
      .join("; ");
  }
  return "";
}

export function apiError(
  method: string,
  path: string,
  response: Response,
  body: unknown,
): APIError {
  const status = response.status;
  let message = `HTTP ${status}`;
  if (isRecord(body)) {
    message = String(body.msg || body.message || body.detail || body.error || message);
    const details = isRecord(body.data) ? body.data.errors : body.errors;
    const fields = fieldErrors(details);
    if (fields) message += `: ${fields}`;
  } else if (typeof body === "string" && body) {
    message = body.slice(0, 500);
  }
  message = `${method.toUpperCase()} ${path}: ${message}`;

  let error: APIErrorClass =
    STATUS_ERRORS[status] ?? (status >= 500 ? ServerError : APIError);
  let retryAfter: number | undefined;
  if (status === 422 && tokenRejected(body)) error = AuthenticationError;
  if (status === 429) {
    const code = isRecord(body) && typeof body.code === "string" ? body.code : "";
    error = QUOTA_ERRORS[code] ?? RateLimitError;
    if (error === RateLimitError) retryAfter = retryAfterMs(response);
  }
  return new error(message, {
    statusCode: status,
    body,
    requestId: requestId(response),
    headers: headersOf(response),
    retryAfter,
  });
}

export function networkError(path: string, error: unknown): APIError {
  if (isTimeout(error)) {
    return new APITimeoutError(`request to ${path} timed out`, {
      cause: error,
    });
  }
  return new APIConnectionError(`request to ${path} failed: ${describe(error)}`, {
    cause: error,
  });
}
