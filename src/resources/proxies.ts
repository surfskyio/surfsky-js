import type { Surfsky } from "../client.js";
import type { Spec } from "../transport.js";
import { ref } from "../transport.js";
import type {
  ProxyCity,
  ProxyCountry,
  ProxyQuota,
  ProxyRegion,
  SharedProxyQuota,
  TrafficStats,
} from "../types.js";

const list = (data: unknown): any => data ?? [];

export function countriesSpec(): Spec<ProxyCountry[]> {
  return { method: "GET", path: "/proxies/countries", parse: list };
}

export function regionsSpec(country: string): Spec<ProxyRegion[]> {
  return {
    method: "GET",
    path: `/proxies/regions/${ref(country)}`,
    parse: list,
  };
}

export function citiesSpec(country: string, region: string): Spec<ProxyCity[]> {
  return {
    method: "GET",
    path: `/proxies/cities/${ref(country)}/${ref(region)}`,
    parse: list,
  };
}

export function quotaSpec(): Spec<ProxyQuota> {
  return { method: "GET", path: "/proxies/quota" };
}

export function premiumStatsSpec(): Spec<TrafficStats> {
  return { method: "GET", path: "/proxies/premium/stats" };
}

export function sharedCountriesSpec(): Spec<string[]> {
  return { method: "GET", path: "/proxies/shared/countries", parse: list };
}

export function sharedQuotaSpec(): Spec<SharedProxyQuota> {
  return { method: "GET", path: "/proxies/shared/quota" };
}

export function sharedStatsSpec(): Spec<TrafficStats> {
  return { method: "GET", path: "/proxies/shared/stats" };
}

export class Proxies {
  readonly client: Surfsky;

  constructor(client: Surfsky) {
    this.client = client;
  }

  async countries(): Promise<ProxyCountry[]> {
    return this.client.call(countriesSpec());
  }

  async regions(country: string): Promise<ProxyRegion[]> {
    return this.client.call(regionsSpec(country));
  }

  async cities(country: string, region: string): Promise<ProxyCity[]> {
    return this.client.call(citiesSpec(country, region));
  }

  async quota(): Promise<ProxyQuota> {
    return this.client.call(quotaSpec());
  }

  async premiumStats(): Promise<TrafficStats> {
    return this.client.call(premiumStatsSpec());
  }

  async sharedCountries(): Promise<string[]> {
    return this.client.call(sharedCountriesSpec());
  }

  async sharedQuota(): Promise<SharedProxyQuota> {
    return this.client.call(sharedQuotaSpec());
  }

  async sharedStats(): Promise<TrafficStats> {
    return this.client.call(sharedStatsSpec());
  }
}
