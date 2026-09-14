import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

const request = JSON.parse(process.argv[2] ?? '{}');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
  stdio: 'ignore',
  windowsHide: true,
});
await writeFile(join(request.cacheDir, 'descendant.pid'), String(descendant.pid), 'utf8');
process.send?.({ kind: 'resolved', buildId: '153.0.8010.36' });
process.send?.({ kind: 'phase', phase: 'extracting', interruptible: true });
globalThis.setInterval(() => undefined, 1_000);
