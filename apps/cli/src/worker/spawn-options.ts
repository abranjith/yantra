/**
 * The one set of options every detached worker is spawned with (FEAT-064):
 * no shell (no argument is ever interpreted), its own process group or
 * session, no inherited terminal, and no console window on Windows.
 */
export const WORKER_SPAWN_OPTIONS = {
  detached: true,
  shell: false,
  stdio: 'ignore',
  windowsHide: true,
} as const;
