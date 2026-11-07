import { collectInitProviderAnswers, type InitAnswers, type InitProviderInput } from '@yantra/core';
import prompts from 'prompts';
export type InitWizardAnswers = InitAnswers;
export type InitWizardDeps = Partial<InitProviderInput>;
export function runInitWizard(deps: InitWizardDeps = {}): Promise<InitAnswers> {
  return collectInitProviderAnswers({
    select: deps.select ?? promptSelect,
    text: deps.text ?? promptText,
    password: deps.password ?? promptPassword,
    ...(deps.keychain ? { keychain: deps.keychain } : {}),
  });
}
async function promptSelect(message: string, choices: readonly string[]): Promise<string | null> {
  const answer = await prompts({
    type: 'select',
    name: 'value',
    message,
    choices: choices.map((title) => ({ title, value: title })),
  });
  return typeof answer.value === 'string' ? answer.value : null;
}
async function promptText(message: string, initial?: string): Promise<string | null> {
  const answer = await prompts({ type: 'text', name: 'value', message, initial });
  return typeof answer.value === 'string' ? answer.value : null;
}
async function promptPassword(message: string): Promise<string | null> {
  const answer = await prompts({ type: 'password', name: 'value', message });
  return typeof answer.value === 'string' ? answer.value : null;
}
