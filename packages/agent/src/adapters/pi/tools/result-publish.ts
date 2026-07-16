/**
 * `result_publish` tool spec (FEAT-024 TASK-007, plan_agentic.md §5/§8.9/§13).
 *
 * The terminal completion contract: raw prose is not success. The agent must
 * publish a validated Brief. The tool validates the candidate against the
 * protocol Brief schema (which enforces citation integrity), persists
 * `brief.json/md/html` on success, and closes the run's action phase so later
 * mutating tools are rejected. Exactly one *successful* publication is allowed;
 * a second attempt returns `ALREADY_PUBLISHED`, and a validation failure returns
 * a structured, correctable error listing the offending references.
 */

import { writeBriefArtifacts } from '@yantra/core';
import { validateBrief, type Brief, type BriefValidationError, type Result } from '@yantra/protocol';
import { Type, type Static } from 'typebox';

import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { PublishOutcome, PublishToolDeps, RunServices } from '../../../runtime/run-services.js';

const ResultPublishParams = Type.Object(
  {
    brief: Type.Unknown({
      description:
        'The final Brief document (matching the Yantra Brief schema): title, overview with ' +
        'inline [n] citations, key_findings, sources, etc.',
    }),
  },
  { additionalProperties: false },
);

type ResultPublishParamsType = Static<typeof ResultPublishParams>;

/**
 * Build the `result_publish` tool spec for one run.
 *
 * @param _services Reserved for symmetry with the other tool factories.
 * @returns The provider-neutral tool spec consumed by `wrapTool`.
 */
export function resultPublishSpec(
  _services: RunServices,
): ToolWrapperSpec<typeof ResultPublishParams> {
  return {
    name: 'result_publish',
    label: 'Publish Result',
    description:
      'Publish the final answer as a validated Brief. This is the ONLY way to complete a task — ' +
      'raw chat text is not a completed result. Call it once, after you have verified your ' +
      'evidence. Do NOT call it with unverified or uncited claims; invalid Briefs are rejected ' +
      'with the specific problems to fix.',
    parameters: ResultPublishParams,
    sanitizationProfile: 'public',
    run: (params: ResultPublishParamsType, ctx): Promise<DomainResult> =>
      runPublish(params, ctx.services),
  };
}

async function runPublish(
  params: ResultPublishParamsType,
  services: RunServices,
): Promise<DomainResult> {
  // The action phase closing is the single-successful-publication latch.
  if (services.actionPhase.isClosed()) {
    return {
      ok: false,
      errorCode: 'ALREADY_PUBLISHED',
      message: 'A result has already been published for this run.',
      retryable: false,
    };
  }

  const result = await services.domain.publish.publish(params.brief);
  if (!result.isOk) {
    return {
      ok: false,
      errorCode: 'BRIEF_INVALID',
      message: result.error.message,
      retryable: true,
      details: { issues: result.error.issues },
    };
  }

  services.actionPhase.close();
  return {
    ok: true,
    model: { published: true, summary: result.value.summary, html_path: result.value.htmlPath },
    details: { brief_id: result.value.brief.brief_id },
    terminate: true,
  };
}

/**
 * Default Brief publisher: validate the candidate against the protocol Brief
 * schema (citation integrity included) and persist `brief.json/md/html`.
 *
 * @param runDir The owning run directory.
 * @returns A {@link PublishToolDeps} for wiring into RunServices.
 */
export function createBriefPublisher(runDir: string): PublishToolDeps {
  return {
    publish: async (raw: unknown): Promise<Result<PublishOutcome, BriefValidationError>> => {
      const validated = validateBrief(raw);
      if (!validated.isOk) {
        return validated;
      }
      const brief: Brief = validated.value;
      const written = await writeBriefArtifacts(runDir, brief);
      if (!written.isOk) {
        // A persistence failure is not a Brief-validity failure; surface it as a
        // schema-shaped error so the single publish contract still holds.
        return {
          isOk: false,
          error: {
            name: 'BriefValidationError',
            code: 'brief_validation_error',
            message: `Brief validated but could not be persisted: ${written.error.message}`,
            issues: [],
          } as unknown as BriefValidationError,
        };
      }
      return {
        isOk: true,
        value: {
          brief,
          htmlPath: written.value.htmlPath,
          summary: briefSummary(brief),
        },
      };
    },
  };
}

/** One-line human summary for the model-visible publish result. */
function briefSummary(brief: Brief): string {
  const firstLine = brief.overview.split('\n').find((line) => line.trim().length > 0) ?? '';
  return `Published "${brief.title}" with ${brief.sources.length} source(s). ${firstLine}`.trim();
}
