import {
  createKeychainProvider,
  parseConfigRef,
  YANTRA_KEYCHAIN_SERVICE,
  type ConfigRef,
  type KeychainProvider,
} from '@yantra/core';
import prompts from 'prompts';

export interface InitWizardAnswers {
  readonly provider: 'anthropic' | 'ollama' | 'none';
  readonly modelId: string | null;
  readonly baseUrl: string | null;
  readonly apiKey: ConfigRef | null;
  readonly dataDir: string | null;
  /** What the optional search-key step did (FEAT-050). */
  readonly searchKey: SearchKeyOutcome;
}

/** The keyed search providers `init` offers to store a key for. */
export type KeyedSearchProvider = 'tavily' | 'brave';

/**
 * The optional search-key step's outcome: nothing stored, a key stored in the
 * keychain, or — when the keychain is unavailable — the command the user can
 * run later instead. The step never fails `init`.
 */
export type SearchKeyOutcome =
  | { readonly status: 'skipped' }
  | { readonly status: 'stored'; readonly provider: KeyedSearchProvider }
  | { readonly status: 'manual'; readonly provider: KeyedSearchProvider; readonly command: string };

export interface InitWizardDeps {
  readonly select?: (message: string, choices: readonly string[]) => Promise<string | null>;
  readonly text?: (message: string, initial?: string) => Promise<string | null>;
  readonly password?: (message: string) => Promise<string | null>;
  /** The OS keychain secrets are stored in; injectable for tests. */
  readonly keychain?: () => Promise<KeychainProvider>;
}

export async function runInitWizard(deps: InitWizardDeps = {}): Promise<InitWizardAnswers> {
  const select = deps.select ?? promptSelect;
  const text = deps.text ?? promptText;
  const password = deps.password ?? promptPassword;
  const keychain = deps.keychain ?? createKeychainProvider;
  const provider = normalizeProvider(
    await select('Model provider', ['anthropic', 'ollama', 'none']),
  );
  if (provider === 'none') {
    const searchKey = await searchKeyStep(select, password, keychain);
    return {
      provider,
      modelId: null,
      baseUrl: null,
      apiKey: null,
      dataDir: await storage(text),
      searchKey,
    };
  }

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
      const store = await keychain();
      if (!(await store.isAvailable()))
        throw new Error(
          'OS keychain is unavailable; choose an environment-variable reference instead',
        );
      await store.set(YANTRA_KEYCHAIN_SERVICE, key, value);
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
  const searchKey = await searchKeyStep(select, password, keychain);
  return { provider, modelId, baseUrl, apiKey, dataDir: await storage(text), searchKey };
}

/**
 * Offer to store a keyed search provider's API key (FEAT-050). Without one,
 * web search scrapes a results page, which Yantra serializes and stops at the
 * first challenge. Same password prompt and keychain account convention as the
 * model step (`<provider>.api_key`). An unavailable keychain does not fail
 * `init`: the outcome carries the `yantra secret set` command to run later.
 */
async function searchKeyStep(
  select: NonNullable<InitWizardDeps['select']>,
  password: NonNullable<InitWizardDeps['password']>,
  keychain: NonNullable<InitWizardDeps['keychain']>,
): Promise<SearchKeyOutcome> {
  const choice = await select('Search provider key (optional)', ['tavily', 'brave', 'skip']);
  if (choice !== 'tavily' && choice !== 'brave') return { status: 'skipped' };
  const account = `${choice}.api_key`;
  const value = await password(`Secret value for ${account}`);
  if (!value) return { status: 'skipped' };
  const manual: SearchKeyOutcome = {
    status: 'manual',
    provider: choice,
    command: `yantra secret set ${account}`,
  };
  let store: KeychainProvider;
  try {
    store = await keychain();
  } catch {
    // swallow-ok: an unavailable keychain is reported through the manual command.
    return manual;
  }
  if (!(await store.isAvailable())) return manual;
  await store.set(YANTRA_KEYCHAIN_SERVICE, account, value);
  return { status: 'stored', provider: choice };
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
