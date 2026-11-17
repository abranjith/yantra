import {
  NodeProcessLivenessProbe,
  NodeProcessTreeTerminator,
  type ProcessIdentity,
} from '@yantra/core';

const probe = new NodeProcessLivenessProbe();

/** Records the identity of a host this test just started, before it can exit. */
export async function identifyTestHost(pid: number): Promise<ProcessIdentity> {
  const identity = await probe.identify(pid);
  if (identity === null || identity.startToken === 'unknown') {
    throw new Error(`Cannot identify the test host ${pid} for cleanup.`);
  }
  return identity;
}

/** Reaps the test host's children too, which can hold its cwd open on Windows. */
export async function stopTestHost(identity: ProcessIdentity): Promise<void> {
  const verdict = await probe.check(identity);
  if (verdict === 'dead') return;
  if (verdict !== 'alive') throw new Error('Cannot verify the test host identity for cleanup.');
  await new NodeProcessTreeTerminator().terminate(identity.pid);
  const deadline = Date.now() + 10_000;
  while ((await probe.check(identity)) !== 'dead') {
    if (Date.now() >= deadline) throw new Error('The test host did not exit after termination.');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
