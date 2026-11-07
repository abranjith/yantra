import {
  collectInitContextGrants,
  type ContextGrantDeps,
  type ContextGrantAnswers,
} from '@yantra/core';
import prompts from 'prompts';
export {
  defaultContextGrantAnswers,
  type ContextGrantAnswers,
  type ContextGrantDeps,
} from '@yantra/core';
export function collectContextGrants(deps: ContextGrantDeps = {}): Promise<ContextGrantAnswers> {
  return collectInitContextGrants({
    confirm: deps.confirm ?? promptConfirm,
    text: deps.text ?? promptText,
  });
}
async function promptConfirm(message: string): Promise<boolean | null> {
  const answer = (await prompts({
    type: 'confirm',
    name: 'value',
    message,
    initial: true,
  })) as { value?: unknown };
  return typeof answer.value === 'boolean' ? answer.value : null;
}

async function promptText(message: string): Promise<string | null> {
  const answer = (await prompts({ type: 'text', name: 'value', message })) as { value?: unknown };
  return typeof answer.value === 'string' ? answer.value : null;
}
