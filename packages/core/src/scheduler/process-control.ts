import { spawn } from 'node:child_process';

import type { ProcessLivenessProbe } from '../browser/installation-types.js';
import { NodeProcessLivenessProbe } from '../browser/process-identity.js';

import type { DaemonLockInfo } from './daemon-lock.js';

export interface CommandProcessControl {
  readonly pid: number;
  spawnDaemon(): Promise<number>;
  signalDaemon(owner: DaemonLockInfo): Promise<void>;
}
/** OS boundary shared by terminal and worker adapters; never signals a bare recorded PID. */
export class NodeDaemonProcessControl implements CommandProcessControl {
  readonly pid = process.pid;
  constructor(
    private readonly options: {
      readonly entrypoint: string;
      readonly cwd: string;
      readonly env: Readonly<NodeJS.ProcessEnv>;
      readonly spawn?: typeof spawn;
      readonly liveness?: ProcessLivenessProbe;
      readonly signal?: (pid: number, signal: NodeJS.Signals) => void;
    },
  ) {}
  async spawnDaemon(): Promise<number> {
    const child = (this.options.spawn ?? spawn)(
      process.execPath,
      [this.options.entrypoint, 'daemon', 'start', '--foreground'],
      {
        cwd: this.options.cwd,
        env: this.options.env,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    const pid = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () =>
        child.pid === undefined
          ? reject(new Error('Daemon did not acquire a process id'))
          : resolve(child.pid),
      );
    });
    child.unref();
    return pid;
  }
  async signalDaemon(owner: DaemonLockInfo): Promise<void> {
    if (
      owner.identity?.pid !== owner.pid ||
      (await (this.options.liveness ?? new NodeProcessLivenessProbe()).check(owner.identity)) !==
        'alive'
    )
      throw new Error(
        'Cannot verify the daemon owner creation identity. Stop it from its owning terminal.',
      );
    (
      this.options.signal ??
      ((pid, signal) => {
        process.kill(pid, signal);
      })
    )(owner.identity.pid, 'SIGTERM');
  }
}
