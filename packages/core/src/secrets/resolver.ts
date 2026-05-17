import type { ValueRef } from '@yantra/protocol';

import type { SecretsJsonlEntry } from '../audit/log-writer.js';

import { SecretNotFoundError } from './errors.js';
import type { KeychainProvider } from './keychain.js';
import { YANTRA_KEYCHAIN_SERVICE } from './keychain.js';

export interface ResolutionContext {
  readonly taskParams: Readonly<Record<string, unknown>>;
  readonly captures: Readonly<Record<string, unknown>>;
  readonly stepId: string;
  readonly taskId: string;
  readonly secretFieldExpected?: boolean;
}

export interface ResolvedValue {
  readonly value: string;
  readonly isSecret: boolean;
  readonly source: 'secret' | 'param' | 'capture' | 'literal' | 'template';
  readonly sourceKey: string | null;
  dispose(): void;
}

export interface OpaqueRefResolver {
  resolve(ref: ValueRef, ctx: ResolutionContext): Promise<ResolvedValue>;
}

interface SecretResolutionAuditWriter {
  appendSecretResolution(entry: SecretsJsonlEntry): Promise<void>;
}

export interface OpaqueRefResolverOptions {
  readonly keychain: KeychainProvider;
  readonly auditLogWriter?: SecretResolutionAuditWriter | null;
  readonly serviceName?: string;
}

/**
 * Resolves protocol ValueRef references at step execution boundaries.
 */
export class DefaultOpaqueRefResolver implements OpaqueRefResolver {
  private readonly serviceName: string;

  public constructor(private readonly options: OpaqueRefResolverOptions) {
    this.serviceName = options.serviceName ?? YANTRA_KEYCHAIN_SERVICE;
  }

  public async resolve(ref: ValueRef, ctx: ResolutionContext): Promise<ResolvedValue> {
    switch (ref.kind) {
      case 'secret': {
        return this.resolveSecret(ref.key, ctx);
      }

      case 'param': {
        if (!(ref.key in ctx.taskParams)) {
          throw new Error(`Missing param reference: ${ref.key}`);
        }
        return resolvedValue(toStringValue(ctx.taskParams[ref.key]), false, 'param', ref.key);
      }

      case 'capture': {
        const captured = ctx.captures[ref.step_id];
        if (captured === undefined) {
          throw new Error(`Missing capture reference: ${ref.step_id}`);
        }

        if (ref.field === null) {
          return resolvedValue(toStringValue(captured), false, 'capture', ref.step_id);
        }

        if (typeof captured !== 'object' || captured === null) {
          throw new Error(`Capture ${ref.step_id} is not object-like.`);
        }

        const record = captured as Record<string, unknown>;
        if (!(ref.field in record)) {
          throw new Error(`Capture field ${ref.field} not found in ${ref.step_id}.`);
        }

        return resolvedValue(
          toStringValue(record[ref.field]),
          false,
          'capture',
          `${ref.step_id}.${ref.field}`,
        );
      }

      case 'literal': {
        if (ctx.secretFieldExpected) {
          throw new Error('Literal value provided for a secret-only field.');
        }
        return resolvedValue(toStringValue(ref.value), false, 'literal', null);
      }

      case 'template': {
        let output = ref.template;
        for (const [bindingKey, bindingRef] of Object.entries(ref.bindings)) {
          if (bindingRef.kind === 'secret') {
            throw new Error('Secret references are forbidden inside template bindings.');
          }
          const resolved = await this.resolve(bindingRef, {
            ...ctx,
            secretFieldExpected: false,
          });
          try {
            output = output.replaceAll(`{{${bindingKey}}}`, resolved.value);
          } finally {
            resolved.dispose();
          }
        }

        return resolvedValue(output, false, 'template', null);
      }

      default:
        throw new Error(
          `Unsupported ValueRef kind: ${(ref as { kind?: string }).kind ?? 'unknown'}`,
        );
    }
  }

  private async resolveSecret(secretKey: string, ctx: ResolutionContext): Promise<ResolvedValue> {
    try {
      const secretValue = await this.options.keychain.get(this.serviceName, secretKey);

      if (secretValue === null) {
        await this.appendSecretAudit(secretKey, ctx, 'not_found');
        throw new SecretNotFoundError({
          key: secretKey,
          stepId: ctx.stepId,
          taskId: ctx.taskId,
        });
      }

      await this.appendSecretAudit(secretKey, ctx, 'resolved');
      const secretBuffer = Buffer.from(secretValue, 'utf8');
      let disposed = false;

      return {
        value: secretBuffer.toString('utf8'),
        isSecret: true,
        source: 'secret',
        sourceKey: secretKey,
        dispose: () => {
          if (disposed) {
            return;
          }
          disposed = true;
          secretBuffer.fill(0);
        },
      };
    } catch (error) {
      if (error instanceof SecretNotFoundError) {
        throw error;
      }

      await this.appendSecretAudit(secretKey, ctx, 'error');
      throw error;
    }
  }

  private async appendSecretAudit(
    key: string,
    ctx: ResolutionContext,
    outcome: 'resolved' | 'not_found' | 'error',
  ): Promise<void> {
    if (!this.options.auditLogWriter) {
      return;
    }

    await this.options.auditLogWriter.appendSecretResolution({
      ts: new Date().toISOString(),
      task_id: ctx.taskId,
      step_id: ctx.stepId,
      key,
      outcome,
    });
  }
}

function resolvedValue(
  value: string,
  isSecret: boolean,
  source: ResolvedValue['source'],
  sourceKey: string | null,
): ResolvedValue {
  return {
    value,
    isSecret,
    source,
    sourceKey,
    dispose: () => undefined,
  };
}

function toStringValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  if (value === null || value === undefined) {
    return '';
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized ?? '';
  } catch {
    return '[unserializable value]';
  }
}
