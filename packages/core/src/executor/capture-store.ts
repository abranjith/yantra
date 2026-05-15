import type { CaptureSnapshot, CaptureStore } from './types.js';

const DEFAULT_INLINE_LIMIT_BYTES = 64 * 1024; // 64 KB

/**
 * In-memory capture store for one run execution.
 *
 * Captures over `inlineLimitBytes` in their serialized form are flagged
 * as sidecar references in the snapshot rather than inlined.
 */
export class InMemoryCaptureStore implements CaptureStore {
  private readonly store = new Map<string, unknown>();

  get(name: string): unknown | undefined {
    return this.store.get(name);
  }

  set(name: string, value: unknown): void {
    this.store.set(name, value);
  }

  has(name: string): boolean {
    return this.store.has(name);
  }

  keys(): string[] {
    return [...this.store.keys()];
  }

  snapshot(opts?: { inlineLimitBytes?: number }): CaptureSnapshot {
    const limit = opts?.inlineLimitBytes ?? DEFAULT_INLINE_LIMIT_BYTES;
    const entries: Record<string, unknown> = {};
    const sidecars: Record<string, string> = {};

    for (const [key, value] of this.store) {
      const serialized = trySerialize(value);
      if (serialized !== null && Buffer.byteLength(serialized, 'utf8') > limit) {
        sidecars[key] = key;
        entries[key] = { $ref: key };
      } else {
        entries[key] = value;
      }
    }

    return { entries, sidecars };
  }

  restore(snapshot: CaptureSnapshot): void {
    this.store.clear();
    for (const [key, value] of Object.entries(snapshot.entries)) {
      if (
        typeof value === 'object' &&
        value !== null &&
        '$ref' in value &&
        typeof (value as Record<string, unknown>)['$ref'] === 'string'
      ) {
        // Sidecar reference — skip inline restore (sidecar loader not needed here)
        continue;
      }
      this.store.set(key, value);
    }
  }
}

function trySerialize(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}
