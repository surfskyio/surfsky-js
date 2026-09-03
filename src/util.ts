/** Resolve after `ms`, or right away once `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Race a promise against a deadline; the timer is cleared either way. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number | null | undefined,
  onTimeout: () => Error,
): Promise<T> {
  if (ms === null || ms === undefined) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** A one-shot event: `wait()` resolves once `set()` was called. */
export class Flag {
  readonly #resolvers: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  #set = false;

  get isSet(): boolean {
    return this.#set;
  }

  set(): void {
    if (this.#set) return;
    this.#set = true;
    this.#resolvers.resolve();
  }

  wait(): Promise<void> {
    return this.#resolvers.promise;
  }
}

/** Drop `undefined` and `null` values, recursively: what pydantic's `exclude_none` did. */
export function dropNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(dropNulls) as T;
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Blob || value instanceof FormData) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined && item !== null)
      .map(([key, item]) => [key, dropNulls(item)]),
  ) as T;
}

export function fromBase64(text: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(text, "base64"));
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}
