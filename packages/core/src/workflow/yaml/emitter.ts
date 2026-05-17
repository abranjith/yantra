import type { WorkflowFile } from '@yantra/protocol';
import * as YAML from 'yaml';

import { toShortForm } from './short-form.js';

const DEFAULT_SCHEMA_HREF = './.yantra-schemas/workflow.schema.json';
const DEFAULT_SIDECAR_THRESHOLD = 50;

export interface EmitOptions {
  schemaHref?: string;
  sidecarThreshold?: number;
}

export interface EmitResult {
  yaml: string;
  sidecarJson: string | null;
}

const KEY_ORDER = [
  'version',
  'name',
  'description',
  'security_class',
  'recorded_with',
  'params',
  'secrets',
  'cookies',
  'steps',
  'outputs',
  'outputs_unredacted',
  '_locators',
  '_locators_ref',
];

/** Emit a WorkflowFile to YAML string. */
export function emitWorkflow(workflow: WorkflowFile, opts?: EmitOptions): EmitResult {
  const schemaHref = opts?.schemaHref ?? DEFAULT_SCHEMA_HREF;
  const sidecarThreshold = opts?.sidecarThreshold ?? DEFAULT_SIDECAR_THRESHOLD;

  const locatorCount = Object.keys(workflow._locators).length;
  const useSidecar = locatorCount > sidecarThreshold;

  const obj: Record<string, unknown> = {};

  obj.version = workflow.version;
  obj.name = workflow.name;
  obj.description = workflow.description;

  obj.security_class = workflow.security_class;

  if (workflow.recorded_with !== null) {
    obj.recorded_with = workflow.recorded_with;
  }

  if (Object.keys(workflow.params).length > 0) {
    obj.params = workflow.params;
  }

  if (workflow.secrets.length > 0) {
    obj.secrets = workflow.secrets;
  }

  if (workflow.cookies !== 'none') {
    obj.cookies = workflow.cookies;
  }

  obj.steps = workflow.steps.map((step) => toShortForm(step));

  if (workflow.outputs.length > 0) {
    obj.outputs = workflow.outputs;
  }

  if (workflow.outputs_unredacted) {
    obj.outputs_unredacted = workflow.outputs_unredacted;
  }

  let sidecarJson: string | null = null;

  if (useSidecar) {
    const sidecarName = `./${workflow.name}.locators.json`;
    obj._locators_ref = sidecarName;
    sidecarJson = JSON.stringify(workflow._locators, null, 2);
  } else if (locatorCount > 0) {
    obj._locators = workflow._locators;
  }

  // Build a stable-order object
  const ordered = buildOrderedObject(obj);

  const doc = new YAML.Document(ordered);

  // Add pinned comment before _locators if present
  let yamlStr = doc.toString({ indent: 2 });

  if (!useSidecar && locatorCount > 0) {
    yamlStr = yamlStr.replace(/^_locators:/m, '# Pinned at record time\n_locators:');
  }

  const commentPrefix = `# yaml-language-server: $schema=${schemaHref}\n`;

  return {
    yaml: commentPrefix + yamlStr,
    sidecarJson,
  };
}

function buildOrderedObject(obj: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};

  for (const key of KEY_ORDER) {
    if (key in obj) {
      ordered[key] = obj[key];
    }
  }

  // Append any keys not in KEY_ORDER
  for (const [k, v] of Object.entries(obj)) {
    if (!KEY_ORDER.includes(k)) {
      ordered[k] = v;
    }
  }

  return ordered;
}
