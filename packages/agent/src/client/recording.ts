import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Plan } from '@yantra/protocol';
import type { Result } from '@yantra/protocol';

import type {
  GeneratePlanOpts,
  GeneratePlanResult,
  LLMClient,
  LLMError,
  SummarizeOpts,
  SummarizeResult,
} from './interface.js';

export interface GoldenFixture {
  readonly intent: string;
  readonly provider_id: string;
  readonly model: string;
  readonly schema_version: string;
  readonly plan: Plan;
}

/**
 * RecordingLLMClient — wraps any LLMClient and writes golden fixtures on success.
 *
 * Used by the golden-plan suite to capture canonical intent → plan mappings.
 * On diff with an existing fixture, fails with a side-by-side report.
 * Populate fixtures via `pnpm --filter @yantra/agent golden:rerecord`.
 */
export class RecordingLLMClient implements LLMClient {
  public get providerId(): string {
    return this.inner.providerId;
  }

  public constructor(
    private readonly inner: LLMClient,
    private readonly goldenDir: string,
    private readonly slug: string,
  ) {}

  public async generatePlan(opts: GeneratePlanOpts): Promise<Result<GeneratePlanResult, LLMError>> {
    const result = await this.inner.generatePlan(opts);

    if (result.isOk) {
      await this.recordPlan(opts.sanitizedPrompt, result.value.plan);
    }

    return result;
  }

  public async summarize(opts: SummarizeOpts): Promise<Result<SummarizeResult, LLMError>> {
    return this.inner.summarize(opts);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async recordPlan(intent: string, plan: Plan): Promise<void> {
    await mkdir(this.goldenDir, { recursive: true });

    const providerId = this.inner.providerId;
    const safeProviderId = providerId.replace(/[^a-z0-9_-]/gi, '_');
    const filename = `${this.slug}.${safeProviderId}.golden.json`;
    const filePath = join(this.goldenDir, filename);

    const fixture: GoldenFixture = {
      intent,
      provider_id: providerId,
      model: providerId,
      schema_version: plan.schema_version,
      plan,
    };

    await writeFile(filePath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  }
}
