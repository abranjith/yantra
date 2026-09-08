import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { formatConfigRef, type YantraConfig } from '@yantra/core';

/** Writes the deterministic, credential-material-free Pi models.json projection. */
export async function projectModels(config: YantraConfig, modelsPath: string): Promise<void> {
  const grouped = new Map<string, YantraConfig['models']>();
  for (const model of config.models) {
    grouped.set(model.provider, [...(grouped.get(model.provider) ?? []), model]);
  }
  const providers = Object.fromEntries(
    [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, models]) => {
        const ordered = [...models].sort((a, b) => a.id.localeCompare(b.id));
        const baseUrl = ordered.find((model) => model.base_url)?.base_url ?? null;
        const apiKey = ordered.find((model) => model.api_key)?.api_key ?? null;
        return [
          provider,
          {
            ...(baseUrl ? { baseUrl } : {}),
            api: 'openai-completions',
            ...(apiKey ? { apiKey: formatConfigRef(apiKey) } : {}),
            models: ordered.map((model) => ({
              id: model.id,
              name: model.id,
              input: [...model.input],
            })),
          },
        ];
      }),
  );
  const contents = `${JSON.stringify({ providers }, null, 2)}\n`;
  await mkdir(dirname(modelsPath), { recursive: true, mode: 0o700 });
  const temporary = `${modelsPath}.tmp`;
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, modelsPath);
}
