import type { Step } from '@yantra/protocol';

import type { StepHandler } from '../types.js';

import { handleAssert } from './assert.js';
import { handleBranch } from './branch.js';
import { handleCallWorkflow } from './call_workflow.js';
import { handleClick } from './click.js';
import { handleExtract } from './extract.js';
import { handleFillElement } from './fill-element.js';
import { handleFill } from './fill.js';
import { handleLlmSummarize } from './llm_summarize.js';
import { handleLoop } from './loop.js';
import { handleNavigate } from './navigate.js';
import { handleWaitFor } from './wait_for.js';

export {
  handleAssert,
  handleBranch,
  handleCallWorkflow,
  handleClick,
  handleExtract,
  handleFill,
  handleFillElement,
  handleLlmSummarize,
  handleLoop,
  handleNavigate,
  handleWaitFor,
};

/**
 * Step verb dispatch map.
 *
 * Routes `step.type` to its handler. Adding a new verb is one import + one entry.
 * The executor uses this map exclusively — no switch statement in executor.ts.
 */
export const STEP_DISPATCH: ReadonlyMap<Step['type'], StepHandler<Step>> = new Map<
  Step['type'],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  StepHandler<any>
>([
  ['navigate', handleNavigate],
  ['click', handleClick],
  ['fill', handleFill],
  ['fill_element', handleFillElement],
  ['extract', handleExtract],
  ['wait_for', handleWaitFor],
  ['assert', handleAssert],
  ['branch', handleBranch],
  ['loop', handleLoop],
  ['call_workflow', handleCallWorkflow],
  ['llm_summarize', handleLlmSummarize],
]);
