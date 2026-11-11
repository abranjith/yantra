import { writeFileAtomic } from '@yantra/core';
import { WorkerResult, type CommandResultMessage } from '@yantra/protocol';

/**
 * Writes a detached worker's {@link WorkerResult} exactly once: atomically
 * (published by exclusive link, so a reader never sees a partial file), owner-
 * only, and never over an existing result (FEAT-064 TASK-012).
 */
export class WorkerResultSink {
  private written = false;

  public constructor(
    private readonly path: string,
    private readonly identity: { readonly invocationId: string; readonly runId?: string },
  ) {}

  /** True once a result was published. */
  public get done(): boolean {
    return this.written;
  }

  /**
   * Publishes the result. A second call, or a result file that already
   * exists, is refused (returns false) and changes nothing.
   */
  public async write(outcome: CommandResultMessage): Promise<boolean> {
    if (this.written) return false;
    this.written = true;
    const result = WorkerResult.parse({
      schema_version: 1,
      invocation_id: this.identity.invocationId,
      ...(this.identity.runId === undefined ? {} : { run_id: this.identity.runId }),
      outcome,
    });
    try {
      await writeFileAtomic(this.path, `${JSON.stringify(result)}\n`, {
        exclusive: true,
        fsync: true,
        mode: 0o600,
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }
}
