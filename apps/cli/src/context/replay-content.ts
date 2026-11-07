import { join } from 'node:path';

import { contentIdentity, workflowsRoot } from '@yantra/core';
import type { ContentIdentity } from '@yantra/protocol';

/** Optional files stay optional; required-file errors retain the replay loader's diagnostics. */
export async function replayContent(name: string, paramsFile?: string): Promise<ContentIdentity[]> {
  const files: readonly (readonly [ContentIdentity['kind'], string])[] = [
    ['workflow', join(workflowsRoot(), `${name}.yaml`)],
    ['workflow_locators', join(workflowsRoot(), `${name}.locators.json`)],
    ...(paramsFile === undefined ? [] : [['params_file' as const, paramsFile] as const]),
  ];
  const identities: ContentIdentity[] = [];
  for (const [kind, path] of files) {
    try {
      identities.push(await contentIdentity(kind, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return identities;
}
