import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { InterventionLogEntry } from '@yantra/protocol';
import type { InterventionLogEntry as InterventionLogEntryType } from '@yantra/protocol';

/** Durable append-only log for live intervention state. */
export class InterventionLog {
  public constructor(private readonly filePath: string) {}

  public async append(entry: InterventionLogEntryType): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const file = await open(this.filePath, 'a', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(entry)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
  }

  public async readAll(): Promise<InterventionLogEntryType[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries: InterventionLogEntryType[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = InterventionLogEntry.safeParse(JSON.parse(trimmed));
        if (parsed.success) entries.push(parsed.data);
      } catch {
        // Ignore malformed or partial lines; the append-only tail is recoverable.
      }
    }
    return entries;
  }
}

/** Append one entry to a supplied intervention log path. */
export async function appendInterventionLogEntry(
  filePath: string,
  entry: InterventionLogEntryType,
): Promise<void> {
  await new InterventionLog(filePath).append(entry);
}
