import type { Surfsky } from "../client.js";
import type { Spec } from "../transport.js";
import { ref } from "../transport.js";
import type { Extension } from "../types.js";
import { isRecord } from "../types.js";

export type ExtensionFile = string | Uint8Array | Blob;

export async function readExtension(
  file: ExtensionFile,
): Promise<{ name: string; blob: Blob }> {
  if (typeof file === "string") {
    const [{ readFile }, { basename }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    const bytes = new Uint8Array(await readFile(file));
    return {
      name: basename(file),
      blob: new Blob([bytes], { type: "application/zip" }),
    };
  }
  if (file instanceof Blob) {
    const name =
      "name" in file && typeof file.name === "string" ? file.name : "extension.zip";
    return { name, blob: file };
  }
  return {
    name: "extension.zip",
    blob: new Blob([new Uint8Array(file)], { type: "application/zip" }),
  };
}

export function uploadSpec(name: string, filename: string, blob: Blob): Spec<Extension> {
  const form = new FormData();
  form.append("file", blob, filename);
  form.append("name", name);
  return { method: "POST", path: "/extensions", body: form };
}

export function listAllSpec(): Spec<Extension[]> {
  // the payload is {"extensions": [...], "count": n}
  return {
    method: "GET",
    path: "/extensions",
    parse: (data) =>
      isRecord(data) ? ((data.extensions as Extension[] | null) ?? []) : [],
  };
}

export function getSpec(uuid: string): Spec<Extension> {
  return { method: "GET", path: `/extensions/${ref(uuid)}` };
}

export function updateSpec(uuid: string, name: string): Spec<Extension> {
  return { method: "PATCH", path: `/extensions/${ref(uuid)}`, json: { name } };
}

export function deleteSpec(uuid: string): Spec<void> {
  return {
    method: "DELETE",
    path: `/extensions/${ref(uuid)}`,
    parse: () => undefined,
  };
}

export class Extensions {
  readonly client: Surfsky;

  constructor(client: Surfsky) {
    this.client = client;
  }

  /** Upload a zip (max 100 MB) given as a path, bytes or a Blob. */
  async upload(file: ExtensionFile, name: string): Promise<Extension> {
    const { name: filename, blob } = await readExtension(file);
    return this.client.call(uploadSpec(name, filename, blob));
  }

  async listAll(): Promise<Extension[]> {
    return this.client.call(listAllSpec());
  }

  async get(uuid: string): Promise<Extension> {
    return this.client.call(getSpec(uuid));
  }

  async update(uuid: string, options: { name: string }): Promise<Extension> {
    return this.client.call(updateSpec(uuid, options.name));
  }

  async delete(uuid: string): Promise<void> {
    return this.client.call(deleteSpec(uuid));
  }
}
