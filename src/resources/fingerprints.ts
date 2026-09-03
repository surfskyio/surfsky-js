import type { Surfsky } from "../client.js";
import type { Spec } from "../transport.js";
import type { Arch, DeviceModel, DeviceType, OS, Renderer, Screen } from "../types.js";

const list = (data: unknown): any => data ?? [];

export interface DeviceModelsOptions {
  os?: OS;
  os_arch?: Arch;
  os_version?: string;
  device_type?: DeviceType;
}

export function renderersSpec(os: OS, osArch: Arch): Spec<Renderer[]> {
  return {
    method: "GET",
    path: "/fingerprint/renderers",
    params: { os, os_arch: osArch },
    parse: list,
  };
}

export function screensSpec(os: OS, osArch: Arch): Spec<Screen[]> {
  return {
    method: "GET",
    path: "/fingerprint/screens",
    params: { os, os_arch: osArch },
    parse: list,
  };
}

export function deviceModelsSpec(options: DeviceModelsOptions): Spec<DeviceModel[]> {
  return {
    method: "GET",
    path: "/fingerprint/device_models",
    params: {
      os: options.os,
      os_arch: options.os_arch,
      os_version: options.os_version,
      device_type: options.device_type,
    },
    parse: list,
  };
}

export class Fingerprints {
  readonly client: Surfsky;

  constructor(client: Surfsky) {
    this.client = client;
  }

  async renderers(os: OS, osArch: Arch): Promise<Renderer[]> {
    return this.client.call(renderersSpec(os, osArch));
  }

  async screens(os: OS, osArch: Arch): Promise<Screen[]> {
    return this.client.call(screensSpec(os, osArch));
  }

  async deviceModels(options: DeviceModelsOptions = {}): Promise<DeviceModel[]> {
    return this.client.call(deviceModelsSpec(options));
  }
}
