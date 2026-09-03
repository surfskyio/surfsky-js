import type { z } from "zod";

export class SurfskyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** No API token, or another unusable client setting. */
export class ConfigurationError extends SurfskyError {}

/** A request that failed validation before it was sent. `cause` is the ZodError. */
export class ValidationError extends SurfskyError {
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(message: string, error: z.ZodError) {
    super(message, { cause: error });
    this.issues = error.issues;
  }
}

export interface APIErrorOptions {
  statusCode?: number;
  body?: unknown;
  requestId?: string;
  headers?: Record<string, string>;
  retryAfter?: number;
  cause?: unknown;
}

/** An error response from the API, or a request that never got one. */
export class APIError extends SurfskyError {
  readonly statusCode: number | undefined;
  readonly body: unknown;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly headers: Record<string, string> | undefined;
  readonly retryAfter: number | undefined;

  constructor(message: string, options: APIErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.statusCode = options.statusCode;
    this.body = options.body;
    this.code = errorCode(options.body);
    this.requestId = options.requestId;
    this.headers = options.headers;
    this.retryAfter = options.retryAfter;
  }

  override toString(): string {
    if (this.statusCode === undefined) return this.message;
    return `[${this.statusCode}] ${this.message}`;
  }
}

function errorCode(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "code" in body) {
    const code = (body as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** The request never reached the API. */
export class APIConnectionError extends APIError {}

/** No response within the timeout. */
export class APITimeoutError extends APIConnectionError {}

/** 400 or 422. */
export class BadRequestError extends APIError {}

/** 401, or a 422 that rejects the token header. */
export class AuthenticationError extends APIError {}

/** 402. */
export class PaymentRequiredError extends APIError {}

/** 403. */
export class ForbiddenError extends APIError {}

/** 404. */
export class NotFoundError extends APIError {}

/** 409. */
export class ConflictError extends APIError {}

/** 429. `retryAfter` is the server's hint in ms. */
export class RateLimitError extends APIError {}

/** 429 with `shared_traffic_limit_reached`. */
export class SharedTrafficLimitError extends APIError {}

/** 429 with `premium_traffic_limit_reached`. */
export class PremiumTrafficLimitError extends APIError {}

/** 429 with `monthly_session_limit_reached`. */
export class MonthlySessionLimitError extends APIError {}

/** 5xx. */
export class ServerError extends APIError {}

/** An error reply to a CDP command, or a lost connection. */
export class CDPError extends SurfskyError {
  readonly code: number | undefined;

  constructor(message: string, options: { code?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code;
  }
}

/** A browser wait or command ran out of time. */
export class BrowserTimeoutError extends SurfskyError {}

/** The page is gone. */
export class PageClosedError extends SurfskyError {}
