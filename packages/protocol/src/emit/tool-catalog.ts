import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { type z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import {
  AssertStep,
  BranchStep,
  CallWorkflowStep,
  ClickStep,
  ExtractStep,
  FillStep,
  LLMSummarizeStep,
  LoopStep,
  NavigateStep,
  WaitForStep,
} from '../schemas/steps.js';

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: unknown;
  output_schema: unknown;
}

export type ToolCatalog = ToolDefinition[];

const STEP_VARIANTS: Record<string, z.AnyZodObject> = {
  navigate: NavigateStep,
  click: ClickStep,
  fill: FillStep,
  extract: ExtractStep,
  wait_for: WaitForStep,
  assert: AssertStep,
  branch: BranchStep,
  loop: LoopStep,
  call_workflow: CallWorkflowStep,
  llm_summarize: LLMSummarizeStep,
} as const;

export const createToolCatalog = (): ToolCatalog =>
  Object.entries(STEP_VARIANTS).map(([name, schema]) => {
    const inputSchema = zodToJsonSchema(schema.omit({ type: true }), {
      name: `${name}_input`,
      target: 'jsonSchema7',
      $refStrategy: 'root',
    });

    return {
      name,
      description: schema.description ?? `${name} step`,
      input_schema: inputSchema,
      output_schema: null,
    };
  });

export const emitToolCatalog = async (outputDirectory: string): Promise<void> => {
  await mkdir(outputDirectory, { recursive: true });

  const catalog = createToolCatalog();
  const jsonPath = path.join(outputDirectory, 'tool-catalog.json');
  await writeFile(jsonPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');

  const tsPath = path.join(outputDirectory, 'tool-catalog.ts');
  const source = [
    '// This file is generated. Do not edit manually.',
    '// This catalog is intentionally vendor-neutral; provider-specific mapping belongs in packages/agent.',
    '',
    'export interface ToolDefinition {',
    '  name: string;',
    '  description: string;',
    '  input_schema: unknown;',
    '  output_schema: unknown | null;',
    '}',
    '',
    'export type ToolCatalog = ToolDefinition[];',
    '',
    `export const TOOL_CATALOG: ToolCatalog = ${JSON.stringify(catalog, null, 2)};`,
    '',
  ].join('\n');

  await writeFile(tsPath, source, 'utf8');
};
