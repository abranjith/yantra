// @no-llm
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  MissingRequiredParamError,
  ParamsValidationError,
} from '../../../src/workflow/replay/errors.js';
import { resolveParams } from '../../../src/workflow/replay/params-resolver.js';
import type { WorkflowParamsSpec } from '../../../src/workflow/replay/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'yantra-params-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('resolveParams', () => {
  describe('CLI params', () => {
    it('returns string params from CLI', async () => {
      const spec: WorkflowParamsSpec = {
        month: { type: 'string', required: true, example: null },
      };
      const result = await resolveParams({
        cli: [{ key: 'month', rawValue: '2026-04' }],
        workflowParams: spec,
      });
      expect(result).toEqual({ month: '2026-04' });
    });

    it('coerces number params', async () => {
      const spec: WorkflowParamsSpec = {
        count: { type: 'number', required: true, example: null },
      };
      const result = await resolveParams({
        cli: [{ key: 'count', rawValue: '42' }],
        workflowParams: spec,
      });
      expect(result['count']).toBe(42);
    });

    it('coerces boolean true', async () => {
      const spec: WorkflowParamsSpec = {
        flag: { type: 'boolean', required: false, example: null },
      };
      const result = await resolveParams({
        cli: [{ key: 'flag', rawValue: 'true' }],
        workflowParams: spec,
      });
      expect(result['flag']).toBe(true);
    });

    it('coerces boolean false', async () => {
      const spec: WorkflowParamsSpec = {
        flag: { type: 'boolean', required: false, example: null },
      };
      const result = await resolveParams({
        cli: [{ key: 'flag', rawValue: 'false' }],
        workflowParams: spec,
      });
      expect(result['flag']).toBe(false);
    });

    it('coerces date params', async () => {
      const spec: WorkflowParamsSpec = {
        start: { type: 'date', required: true, example: null },
      };
      const result = await resolveParams({
        cli: [{ key: 'start', rawValue: '2026-04-01' }],
        workflowParams: spec,
      });
      expect(result['start']).toBeInstanceOf(Date);
    });

    it('throws ParamsValidationError for invalid number', async () => {
      const spec: WorkflowParamsSpec = {
        count: { type: 'number', required: true, example: null },
      };
      await expect(
        resolveParams({ cli: [{ key: 'count', rawValue: 'not-a-number' }], workflowParams: spec }),
      ).rejects.toBeInstanceOf(ParamsValidationError);
    });

    it('throws ParamsValidationError for invalid boolean', async () => {
      const spec: WorkflowParamsSpec = {
        flag: { type: 'boolean', required: true, example: null },
      };
      await expect(
        resolveParams({ cli: [{ key: 'flag', rawValue: 'yes' }], workflowParams: spec }),
      ).rejects.toBeInstanceOf(ParamsValidationError);
    });
  });

  describe('MissingRequiredParamError', () => {
    it('throws MissingRequiredParamError when required param missing', async () => {
      const spec: WorkflowParamsSpec = {
        month: { type: 'string', required: true, example: null },
      };
      await expect(resolveParams({ cli: [], workflowParams: spec })).rejects.toBeInstanceOf(
        MissingRequiredParamError,
      );
    });

    it('does not throw for optional missing param', async () => {
      const spec: WorkflowParamsSpec = {
        month: { type: 'string', required: false, example: null },
      };
      const result = await resolveParams({ cli: [], workflowParams: spec });
      expect(result['month']).toBeUndefined();
    });
  });

  describe('credential rejection', () => {
    it('rejects OpenAI-shaped secret via CLI', async () => {
      const spec: WorkflowParamsSpec = {
        token: { type: 'string', required: true, example: null },
      };
      await expect(
        resolveParams({
          cli: [{ key: 'token', rawValue: 'sk-abcdefghijklmnopqrstuvwxyz1234567890' }],
          workflowParams: spec,
        }),
      ).rejects.toBeInstanceOf(ParamsValidationError);
    });

    it('rejects GitHub token-shaped secret', async () => {
      const spec: WorkflowParamsSpec = {
        token: { type: 'string', required: true, example: null },
      };
      await expect(
        resolveParams({
          cli: [{ key: 'token', rawValue: 'ghp_abcdefghijklmnopqrstuvwxyz1234567' }],
          workflowParams: spec,
        }),
      ).rejects.toBeInstanceOf(ParamsValidationError);
    });
  });

  describe('file params', () => {
    it('reads params from YAML file', async () => {
      const file = join(tmpDir, 'params.yaml');
      await writeFile(file, 'month: 2026-04\ncount: 5\n');
      const spec: WorkflowParamsSpec = {
        month: { type: 'string', required: true, example: null },
        count: { type: 'number', required: true, example: null },
      };
      const result = await resolveParams({ cli: [], file, workflowParams: spec });
      expect(result['month']).toBe('2026-04');
      expect(result['count']).toBe(5);
    });

    it('CLI wins over file on collision', async () => {
      const file = join(tmpDir, 'params.yaml');
      await writeFile(file, 'month: 2026-03\n');
      const spec: WorkflowParamsSpec = {
        month: { type: 'string', required: true, example: null },
      };
      const result = await resolveParams({
        cli: [{ key: 'month', rawValue: '2026-04' }],
        file,
        workflowParams: spec,
      });
      expect(result['month']).toBe('2026-04');
    });

    it('throws ParamsValidationError for non-existent file', async () => {
      const spec: WorkflowParamsSpec = {};
      await expect(
        resolveParams({ cli: [], file: '/nonexistent/path/params.yaml', workflowParams: spec }),
      ).rejects.toBeInstanceOf(ParamsValidationError);
    });

    it('throws ParamsValidationError for non-mapping YAML', async () => {
      const file = join(tmpDir, 'params.yaml');
      await writeFile(file, '- item1\n- item2\n');
      await expect(resolveParams({ cli: [], file, workflowParams: {} })).rejects.toBeInstanceOf(
        ParamsValidationError,
      );
    });
  });
});
