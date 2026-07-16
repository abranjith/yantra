/**
 * Allowlisted transformation script registry + out-of-process executor
 * (FEAT-024 TASK-006, plan_agentic.md §8.8).
 *
 * `script_run` never accepts an arbitrary command string. It accepts only a
 * **registered id** plus validated arguments. Each registered script is a pure,
 * self-contained transformation function (no closures, no ambient capabilities)
 * defined here in code — the code-defined registry *is* the trust boundary.
 *
 * Each invocation runs in a fresh `worker_threads` Worker with:
 *   - an enforced wall-clock timeout (the parent terminates a runaway worker);
 *   - an output-byte cap (oversized output is truncated and flagged);
 *   - a best-effort memory cap (`resourceLimits.maxOldGenerationSizeMb`).
 *
 * **Trust statement (honest, per plan §8.8):** Node cannot fully sandbox a
 * worker — a worker still has the Node standard library available. Yantra does
 * not grant network or filesystem access (no handles/env are passed in), and
 * the scripts are trusted first-party code, so the security boundary is the
 * registry itself, not OS-level isolation. The worker exists for *resource*
 * containment (time/memory/output), not to run untrusted code.
 */

import { Worker } from 'node:worker_threads';

import { DEFAULT_SCRIPTS } from './definitions.js';
import type { ScriptDefinition, ScriptRunOutcome } from './types.js';

export {
  DEFAULT_SCRIPT_LIMITS,
  type ScriptDefinition,
  type ScriptErrorCode,
  type ScriptLimits,
  type ScriptRunOutcome,
} from './types.js';

/** Worker source: reconstruct the transform from its string form and run it. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
try {
  // The transform is a pure function serialized on the parent side. eval wraps
  // it in parentheses so an arrow/function expression parses as a value.
  const fn = eval('(' + workerData.source + ')');
  const output = fn(workerData.args);
  let json = JSON.stringify(output === undefined ? null : output);
  if (typeof json !== 'string') json = 'null';
  let truncated = false;
  if (Buffer.byteLength(json, 'utf8') > workerData.maxOutputBytes) {
    // Truncate on a byte boundary and mark it; the parent surfaces the flag.
    const buf = Buffer.from(json, 'utf8').subarray(0, workerData.maxOutputBytes);
    json = buf.toString('utf8');
    truncated = true;
  }
  parentPort.postMessage({ ok: true, json, truncated });
} catch (err) {
  parentPort.postMessage({ ok: false, message: err && err.message ? String(err.message) : 'script error' });
}
`;

/**
 * A code-defined registry of trusted transformation scripts with an
 * out-of-process, resource-capped executor.
 */
export class ScriptRegistry {
  private readonly scripts = new Map<string, ScriptDefinition>;

  /**
   * @param definitions Registered scripts (defaults to {@link DEFAULT_SCRIPTS}).
   */
  public constructor(definitions: readonly ScriptDefinition[] = DEFAULT_SCRIPTS) {
    for (const def of definitions) {
      if (this.scripts.has(def.id)) {
        throw new Error(`Duplicate script id in registry: "${def.id}".`);
      }
      this.scripts.set(def.id, def);
    }
  }

  /** True when a script id is registered. */
  public has(id: string): boolean {
    return this.scripts.has(id);
  }

  /** Registered script ids in registration order. */
  public ids(): readonly string[] {
    return [...this.scripts.keys()];
  }

  /** Registered script descriptions (for tool documentation). */
  public describe(): readonly { readonly id: string; readonly description: string }[] {
    return [...this.scripts.values()].map(({ id, description }) => ({ id, description }));
  }

  /**
   * Run a registered script out-of-process with enforced caps.
   *
   * @param id Registered script id (never an arbitrary command).
   * @param args Arguments validated against the script's Zod schema.
   * @param opts Abort signal for cooperative cancellation.
   * @returns A structured success/failure; never throws for expected conditions.
   */
  public async run(
    id: string,
    args: unknown,
    opts: { readonly signal: AbortSignal },
  ): Promise<ScriptRunOutcome> {
    const def = this.scripts.get(id);
    if (!def) {
      return {
        ok: false,
        errorCode: 'SCRIPT_NOT_FOUND',
        message: `Unknown script id "${id}". Registered scripts: ${this.ids().join(', ') || '(none)'}.`,
        retryable: false,
      };
    }

    const parsed = def.argsSchema.safeParse(args);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = first && first.path.length > 0 ? ` at "${first.path.join('.')}"` : '';
      return {
        ok: false,
        errorCode: 'SCRIPT_INVALID_ARGS',
        message: `Invalid arguments for "${id}"${where}: ${first?.message ?? 'validation failed'}.`,
        retryable: true,
      };
    }

    if (opts.signal.aborted) {
      return { ok: false, errorCode: 'SCRIPT_ABORTED', message: 'Run aborted.', retryable: false };
    }

    return this.execute(def, parsed.data, opts.signal);
  }

  private execute(
    def: ScriptDefinition,
    args: unknown,
    signal: AbortSignal,
  ): Promise<ScriptRunOutcome> {
    return new Promise<ScriptRunOutcome>((resolve) => {
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { source: def.transform.toString(), args, maxOutputBytes: def.limits.maxOutputBytes },
        resourceLimits: { maxOldGenerationSizeMb: def.limits.memoryMb },
      });

      let settled = false;
      const finish = (outcome: ScriptRunOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        void worker.terminate();
        resolve(outcome);
      };

      const timer = setTimeout(() => {
        finish({
          ok: false,
          errorCode: 'SCRIPT_TIMEOUT',
          message: `Script "${def.id}" exceeded its ${def.limits.timeoutMs}ms time budget.`,
          retryable: false,
        });
      }, def.limits.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      const onAbort = (): void => {
        finish({ ok: false, errorCode: 'SCRIPT_ABORTED', message: 'Run aborted.', retryable: false });
      };
      signal.addEventListener('abort', onAbort, { once: true });

      worker.on('message', (message: WorkerMessage) => {
        if (message.ok) {
          let output: unknown;
          try {
            output = JSON.parse(message.json) as unknown;
          } catch {
            // A truncated payload may no longer be valid JSON; hand back the
            // raw (capped) text so the transformation is not silently lost.
            output = message.json;
          }
          finish({ ok: true, output, truncated: message.truncated });
        } else {
          finish({
            ok: false,
            errorCode: 'SCRIPT_FAILED',
            message: `Script "${def.id}" failed: ${message.message}`,
            retryable: false,
          });
        }
      });

      worker.on('error', (err: Error) => {
        finish({
          ok: false,
          errorCode: 'SCRIPT_FAILED',
          message: `Script "${def.id}" failed: ${err.message}`,
          retryable: false,
        });
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          finish({
            ok: false,
            errorCode: 'SCRIPT_FAILED',
            message: `Script "${def.id}" worker exited with code ${code}.`,
            retryable: false,
          });
        }
      });
    });
  }
}

type WorkerMessage =
  | { readonly ok: true; readonly json: string; readonly truncated: boolean }
  | { readonly ok: false; readonly message: string };
