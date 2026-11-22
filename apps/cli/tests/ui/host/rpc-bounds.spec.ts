// @no-llm
/**
 * REV-013 (GHSA-mrhx-c7xc-m3w5, interim until Zod 4): every array a window
 * can send is bounded. Zod 3 spends memory per failing array element, so the
 * host keeps `.max()` on every array reachable from a registered method's
 * params, and caps the JSON-RPC batch length. The walk runs over the real,
 * fully assembled method registry, so a new method cannot slip past it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as core from '@yantra/core';
import type { ProcessLivenessProbe } from '@yantra/core';
import { JsonRpcRequest } from '@yantra/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { startHostRuntime } from '../../../src/ui/host/host-runtime.js';
import type { RpcMethodRegistry } from '../../../src/ui/host/rpc-server.js';

import { cleanupTempDirs, makeWebBuild } from './support.js';

/** Paths of arrays without a maximum length inside `schema`. */
function unboundedArrays(schema: z.ZodTypeAny, path = '$', seen = new Set<unknown>()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const def = schema._def as Record<string, unknown> & { typeName?: string };
  const walk = (child: unknown, at: string): string[] =>
    child === undefined ? [] : unboundedArrays(child as z.ZodTypeAny, at, seen);
  switch (def.typeName) {
    case 'ZodArray': {
      const own = def.maxLength === null ? [path] : [];
      return [...own, ...walk(def.type, `${path}[]`)];
    }
    case 'ZodObject': {
      const shape = (def.shape as () => Record<string, unknown>)();
      return [
        ...Object.entries(shape).flatMap(([key, child]) => walk(child, `${path}.${key}`)),
        ...walk(def.catchall, `${path}.*`),
      ];
    }
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodCatch':
    case 'ZodReadonly':
      return walk(def.innerType, path);
    case 'ZodEffects':
      return walk(def.schema, path);
    case 'ZodBranded':
      return walk(def.type, path);
    case 'ZodPipeline':
      return [...walk(def.in, path), ...walk(def.out, path)];
    case 'ZodLazy':
      return walk((def.getter as () => unknown)(), path);
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = def.options as unknown[] | Map<unknown, unknown>;
      const list = options instanceof Map ? [...options.values()] : options;
      return list.flatMap((option, index) => walk(option, `${path}|${index}`));
    }
    case 'ZodIntersection':
      return [...walk(def.left, path), ...walk(def.right, path)];
    case 'ZodTuple':
      return [
        ...(def.items as unknown[]).flatMap((item, index) => walk(item, `${path}[${index}]`)),
        ...walk(def.rest ?? undefined, `${path}[...]`),
      ];
    case 'ZodRecord':
    case 'ZodMap':
      return walk(def.valueType, `${path}{}`);
    default:
      return [];
  }
}

const alive: ProcessLivenessProbe = { check: () => Promise.resolve('alive') } as never;
let home: string;
let previous: string | undefined;
let registry: RpcMethodRegistry | null = null;
let stop: (() => Promise<void>) | null = null;

beforeAll(async () => {
  previous = process.env.YANTRA_HOME;
  home = mkdtempSync(join(tmpdir(), 'yantra-rpc-bounds-'));
  process.env.YANTRA_HOME = home;
  core.resetPathCache();
  const host = await startHostRuntime({
    assetsRoot: makeWebBuild(),
    identity: { pid: 990_002, startToken: 'h' },
    yantraVersion: '1',
    lock: new core.FileHostLock({ liveness: alive }),
    probe: alive,
    registerMethods: (methods) => {
      registry = methods;
    },
  });
  stop = () => host.stop();
}, 30_000);

afterAll(async () => {
  await stop?.();
  cleanupTempDirs();
  if (previous === undefined) delete process.env.YANTRA_HOME;
  else process.env.YANTRA_HOME = previous;
  core.resetPathCache();
  rmSync(home, { recursive: true, force: true });
});

describe('@no-llm window input bounds (REV-013)', () => {
  it('has a registry with the methods a window can call', () => {
    expect(registry?.names().length).toBeGreaterThan(20);
  });

  it('bounds every array in every registered method params schema', () => {
    const unbounded = registry!
      .names()
      .flatMap((name) =>
        unboundedArrays(registry!.get(name)!.params as z.ZodTypeAny).map((at) => `${name} ${at}`),
      );
    expect(unbounded).toEqual([]);
  });

  it('bounds the array form of the JSON-RPC params envelope', () => {
    expect(unboundedArrays(JsonRpcRequest as unknown as z.ZodTypeAny)).toEqual([]);
  });
});
