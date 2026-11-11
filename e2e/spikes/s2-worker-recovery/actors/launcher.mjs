// Spike S2 — the single detached-spawn helper, as a process the runner can kill.
// Usage: node launcher.mjs --launch <file> --out <pids.json> [--stay] [--via trampoline|wmi]
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
};
const launchFile = arg('--launch');
const out = arg('--out');
const via = arg('--via') ?? 'direct';
const stay = process.argv.includes('--stay');
const workerPath = join(here, 'worker.mjs');

function spawnDetached(file, args) {
  const child = spawn(process.execPath, [file, ...args], {
    detached: true,
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

let workerPid = null;
if (via === 'direct') {
  workerPid = spawnDetached(workerPath, ['--launch', launchFile]);
} else if (via === 'trampoline') {
  // Double spawn: the intermediate exits at once, so the worker's parent is a dead PID
  // and a tree kill of this process (taskkill /T walks ParentProcessId) cannot reach it.
  spawnDetached(join(here, 'launcher.mjs'), ['--launch', launchFile, '--out', out]);
} else if (via === 'wmi') {
  // Windows only: WMI creates the process outside the caller's Job object.
  const commandLine = `"${process.execPath}" "${workerPath}" --launch "${launchFile}"`;
  const script = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}' }; "$($r.ReturnValue) $($r.ProcessId)"`;
  const [code, pid] = execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  )
    .trim()
    .split(/\s+/)
    .map(Number);
  if (code !== 0) process.exit(2);
  workerPid = pid;
}

if (workerPid !== null) {
  writeFileSync(out, JSON.stringify({ launcherPid: process.pid, workerPid, via }));
} else {
  writeFileSync(`${out}.outer`, JSON.stringify({ launcherPid: process.pid, via }));
}
// Keep-alive timer for --stay: the runner kills this process itself.
if (stay) setInterval(() => undefined, 1_000);
