import type { Surfsky } from "../client.js";
import { NotFoundError } from "../errors.js";
import type { Spec } from "../transport.js";
import type { BrowserLimits, SessionLimits } from "../types.js";

export const DEFAULT_MAX_BROWSERS = 10;

export function sessionLimitsSpec(): Spec<SessionLimits> {
  return { method: "GET", path: "/users/session-limits" };
}

export function browserLimitsSpec(): Spec<BrowserLimits> {
  return { method: "GET", path: "/users/browser-limits" };
}

export function envMaxBrowsers(): number | undefined {
  const value = process.env.SURFSKY_MAX_BROWSERS ?? "";
  return /^\d+$/.test(value) ? Math.max(1, Number(value)) : undefined;
}

export class Account {
  readonly client: Surfsky;

  constructor(client: Surfsky) {
    this.client = client;
  }

  async sessionLimits(): Promise<SessionLimits> {
    return this.client.call(sessionLimitsSpec());
  }

  async browserLimits(): Promise<BrowserLimits> {
    return this.client.call(browserLimitsSpec());
  }

  /** The plan's parallel-browser cap; `SURFSKY_MAX_BROWSERS` overrides it. */
  async maxBrowsers(): Promise<number> {
    return (
      envMaxBrowsers() ??
      ((await this.#limits()).parallel_browsers || DEFAULT_MAX_BROWSERS)
    );
  }

  async #limits(): Promise<BrowserLimits> {
    try {
      return await this.browserLimits();
    } catch (err) {
      if (err instanceof NotFoundError) return {};
      throw err;
    }
  }
}
