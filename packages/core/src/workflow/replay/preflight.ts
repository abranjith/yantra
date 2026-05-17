/**
 * Pre-flight checks performed before any browser is launched.
 *
 * Fails fast with typed errors — cheap and high-signal.
 *
 * @example
 * await preflightSecrets(['bank.username', 'bank.password'], keychain);
 * await preflightEthics(plan, ethicsGate);
 * preflightWorkflow(workflow);
 */

import type { Plan, WorkflowFile } from '@yantra/protocol';

import type { EthicsGate } from '../../executor/types.js';
import type { KeychainProvider } from '../../secrets/keychain.js';
import { YANTRA_KEYCHAIN_SERVICE } from '../../secrets/keychain.js';
import { lint } from '../lint/index.js';

import type { PreflightResult } from './types.js';

// ---------------------------------------------------------------------------
// Secrets preflight
// ---------------------------------------------------------------------------

class SecretsMissingError extends Error {
  override readonly name = 'SecretsMissingError';

  public constructor(public readonly missing: readonly string[]) {
    super(
      `The following secrets are declared in the workflow but not found in the keychain: ` +
        missing.map((k) => `"${k}"`).join(', ') +
        `.\nRun "yantra secrets set <key>" to store each missing secret.`,
    );
  }
}

/**
 * Checks that all declared workflow secrets exist in the keychain.
 *
 * Collects ALL missing keys before throwing (not just the first).
 *
 * @throws SecretsMissingError if any declared key is absent from the keychain.
 */
export async function preflightSecrets(
  declaredKeys: readonly string[],
  keychain: KeychainProvider,
): Promise<PreflightResult> {
  const missing: string[] = [];

  await Promise.all(
    declaredKeys.map(async (key) => {
      const value = await keychain.get(YANTRA_KEYCHAIN_SERVICE, key);
      if (value === null) {
        missing.push(key);
      }
    }),
  );

  if (missing.length > 0) {
    throw new SecretsMissingError(missing.sort());
  }

  return { ok: true };
}

export { SecretsMissingError };

// ---------------------------------------------------------------------------
// Ethics preflight
// ---------------------------------------------------------------------------

class EthicsPreflightError extends Error {
  override readonly name = 'EthicsPreflightError';

  public constructor(
    public readonly stepId: string,
    public readonly host: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Pre-validates that no navigate step targets a blocked host.
 *
 * This is belt-and-suspenders — the executor also checks at run time.
 */
export async function preflightEthics(
  plan: Plan,
  ethicsGate: EthicsGate,
  context: { taskId: string; runId: string },
): Promise<void> {
  for (const step of plan.steps) {
    if (step.type !== 'navigate') continue;
    const url = step.url;
    if (url.kind !== 'literal' || typeof url.value !== 'string') continue;

    try {
      await ethicsGate.check(url.value, 'navigate', {
        taskId: context.taskId,
        runId: context.runId,
        stepId: step.id,
      });
    } catch {
      const host = safeHost(url.value);
      throw new EthicsPreflightError(
        step.id,
        host,
        `Step "${step.id}" targets host "${host}" which is blocked by the ethics gate.`,
      );
    }
  }
}

export { EthicsPreflightError };

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Workflow lint preflight
// ---------------------------------------------------------------------------

class WorkflowLintError extends Error {
  override readonly name = 'WorkflowLintError';

  public constructor(
    public readonly workflowName: string,
    public readonly errorCount: number,
    public readonly messages: readonly string[],
  ) {
    super(
      `Workflow "${workflowName}" has ${errorCount} lint error(s):\n` +
        messages.map((m) => `  • ${m}`).join('\n') +
        `\nRun "yantra lint ${workflowName}" for details.`,
    );
  }
}

/**
 * Runs the lint rule set in-process against the workflow.
 *
 * Warnings do not block the run — only errors do.
 *
 * @throws WorkflowLintError if the workflow has any lint errors.
 */
export function preflightWorkflow(workflow: WorkflowFile): void {
  const report = lint(workflow);
  if (report.errors.length === 0) return;

  throw new WorkflowLintError(
    workflow.name,
    report.errors.length,
    report.errors.map((e) => `${e.code} at ${e.path}: ${e.message}`),
  );
}

export { WorkflowLintError };
