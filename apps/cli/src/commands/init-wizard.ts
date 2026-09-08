import {
  createKeychainProvider,
  parseConfigRef,
  YANTRA_KEYCHAIN_SERVICE,
  type ConfigRef,
} from '@yantra/core';
import prompts from 'prompts';

export interface InitWizardAnswers {
  readonly provider: 'anthropic' | 'ollama' | 'none';
  readonly modelId: string | null;
  readonly baseUrl: string | null;
  readonly apiKey: ConfigRef | null;
  readonly dataDir: string | null;
}

export interface InitWizardDeps {
  readonly select?: (message: string, choices: readonly string[]) => Promise<string | null>;
  readonly text?: (message: string, initial?: string) => Promise<string | null>;
  readonly password?: (message: string) => Promise<string | null>;
}

export async function runInitWizard(deps: InitWizardDeps = {}): Promise<InitWizardAnswers> {
  const select = deps.select ?? promptSelect;
  const text = deps.text ?? promptText;
  const password = deps.password ?? promptPassword;
  const provider = normalizeProvider(
    await select('Model provider', ['anthropic', 'ollama', 'none']),
  );
  if (provider === 'none')
    return { provider, modelId: null, baseUrl: null, apiKey: null, dataDir: await storage(text) };

  const credentialMode =
    (await select('Credential source', ['environment variable', 'keychain', 'skip'])) ?? 'skip';
  let apiKey: ConfigRef | null = null;
  if (credentialMode === 'environment variable') {
    const defaultName = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OLLAMA_API_KEY';
    const name =
      nonEmpty((await text('Environment variable name', defaultName))?.trim()) ?? defaultName;
    const parsed = parseConfigRef(`\${env:${name}}`);
    if (!parsed.isOk) throw new Error(parsed.error);
    apiKey = parsed.value;
  } else if (credentialMode === 'keychain') {
    const key = `${provider}.api_key`;
    const value = await password(`Secret value for ${key}`);
    if (value) {
      const keychain = await createKeychainProvider();
      if (!(await keychain.isAvailable()))
        throw new Error(
          'OS keychain is unavailable; choose an environment-variable reference instead',
        );
      await keychain.set(YANTRA_KEYCHAIN_SERVICE, key, value);
      const parsed = parseConfigRef(`\${secret:${key}}`);
      if (!parsed.isOk) throw new Error(parsed.error);
      apiKey = parsed.value;
    }
  }
  const defaultModel = provider === 'anthropic' ? 'claude-opus-4-7' : 'llama3.1:8b';
  const modelId = nonEmpty((await text('Model id', defaultModel))?.trim()) ?? defaultModel;
  const baseUrl =
    provider === 'ollama'
      ? (nonEmpty((await text('Ollama base URL', 'http://localhost:11434'))?.trim()) ??
        'http://localhost:11434')
      : null;
  return { provider, modelId, baseUrl, apiKey, dataDir: await storage(text) };
}

async function storage(text: NonNullable<InitWizardDeps['text']>): Promise<string | null> {
  const value = (await text('Data directory (blank for ~/.yantra/data)'))?.trim();
  return nonEmpty(value) ?? null;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function normalizeProvider(value: string | null): InitWizardAnswers['provider'] {
  return value === 'anthropic' || value === 'ollama' ? value : 'none';
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
