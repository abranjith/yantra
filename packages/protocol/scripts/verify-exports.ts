import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const packageRoot = path.resolve(import.meta.dirname, '..');
const workspaceRoot = path.resolve(packageRoot, '..', '..');

const TARGET_DIRECTORIES = [
  path.join(workspaceRoot, 'packages', 'core', 'src'),
  path.join(workspaceRoot, 'apps', 'cli', 'src'),
];

const ALLOWLIST: Record<string, string> = {
  // FEAT-011: used by agent integration when that feature lands.
  TOOL_CATALOG: 'FEAT-011',
  // FEAT-001 compatibility: type-level alias for scaffold smoke tests.
  ProtocolVersion: 'FEAT-001',
};

const listFilesRecursively = async (directory: string): Promise<string[]> => {
  const files = await readdir(directory, { withFileTypes: true });
  const output: string[] = [];

  for (const file of files) {
    const absolutePath = path.join(directory, file.name);
    if (file.isDirectory()) {
      output.push(...(await listFilesRecursively(absolutePath)));
      continue;
    }

    if (file.name.endsWith('.ts')) {
      output.push(absolutePath);
    }
  }

  return output;
};

const readAllTargetContent = async (): Promise<string> => {
  const files = (
    await Promise.all(TARGET_DIRECTORIES.map((directory) => listFilesRecursively(directory)))
  ).flat();

  const chunks = await Promise.all(files.map((filePath) => readFile(filePath, 'utf8')));
  return chunks.join('\n');
};

const run = async (): Promise<void> => {
  const indexFile = await readFile(path.join(packageRoot, 'src', 'index.ts'), 'utf8');
  const exportMatches = [
    ...indexFile.matchAll(/export\s+(?:const|class|function|type|interface)\s+([A-Za-z0-9_]+)/g),
  ];
  const exportedNames = exportMatches
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name));

  const allContent = await readAllTargetContent();

  const unused = exportedNames.filter((name) => {
    if (name in ALLOWLIST) {
      return false;
    }

    const usageRegex = new RegExp(`\\b${name}\\b`, 'm');
    return !usageRegex.test(allContent);
  });

  if (unused.length > 0) {
    throw new Error(`Unused protocol exports detected: ${unused.join(', ')}`);
  }
};

await run();
