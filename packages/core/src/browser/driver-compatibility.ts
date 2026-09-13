/**
 * The single driver compatibility descriptor.
 *
 * Chrome ships Stable faster than this repository bumps Puppeteer, so an
 * installed build outside the tested pairing is the *normal* case, not an
 * exception: `testedBuild` is a recorded baseline, never a minimum major, never
 * the Stable resolver, and never an expectation that installed builds match it.
 *
 * The required primitives are declared data rather than prose. Adding one is a
 * row here plus a probe-revision bump, the evidence cache invalidates by
 * construction through {@link capabilityTableHash}, and `browser check` renders
 * pass/fail per row without the CLI restating the list.
 */

import { createHash } from 'node:crypto';

import type {
  CapabilityId,
  CapabilityRequirement,
  DriverCompatibilityDescriptor,
  ManagedPlatform,
  ProbeProfile,
} from './installation-types.js';

/** Host platform/architecture pairs Chrome for Testing publishes builds for. */
const CFT_PLATFORMS: Readonly<Record<string, ManagedPlatform>> = Object.freeze({
  'darwin:arm64': 'mac_arm',
  'darwin:x64': 'mac',
  'linux:x64': 'linux',
  'win32:x64': 'win64',
  'win32:ia32': 'win32',
});

/**
 * Every primitive Yantra needs from a browser, why, and which caller needs it.
 *
 * The automation rows are required by the recorder too: recorder compatibility
 * is the automation set *plus* its three additional rows, which is what makes
 * automation-only evidence unable to approve recording.
 */
const CAPABILITY_TABLE: readonly CapabilityRequirement[] = Object.freeze([
  {
    id: 'pipe-version',
    why: 'Yantra talks to the browser over a CDP pipe and must be able to read its version over that transport.',
    requiredBy: ['automation', 'recorder'],
    dependsOn: [],
  },
  {
    id: 'runtime-evaluate',
    why: 'Every observation and every action evaluates JavaScript in the page.',
    requiredBy: ['automation', 'recorder'],
    dependsOn: ['pipe-version'],
  },
  {
    id: 'dom-handles',
    why: 'The locator engine collects element handles and must be able to release them again.',
    requiredBy: ['automation', 'recorder'],
    dependsOn: ['runtime-evaluate'],
  },
  {
    id: 'click-replace',
    why: 'Filling a field that already has a value must replace it, not append to it.',
    requiredBy: ['automation', 'recorder'],
    dependsOn: ['dom-handles'],
  },
  {
    id: 'frame-token',
    why: 'Actions inside non-main frames are addressed by public frame tokens that must resolve only their live owning frame.',
    requiredBy: ['automation', 'recorder'],
    dependsOn: ['dom-handles'],
  },
  {
    id: 'popup-session',
    why: 'A popup the site opens must be associated with its own page and its own CDP session, and cleaned up with it.',
    requiredBy: ['automation', 'recorder'],
    dependsOn: ['runtime-evaluate'],
  },
  {
    id: 'recorder-binding',
    why: 'The recorder receives in-page events through a CDP binding on the exact recording session.',
    requiredBy: ['recorder'],
    dependsOn: ['runtime-evaluate'],
  },
  {
    id: 'recorder-preload',
    why: 'The recorder overlay must be installed before page scripts run, or the first interactions are lost.',
    requiredBy: ['recorder'],
    dependsOn: ['recorder-binding'],
  },
  {
    id: 'recorder-page-domain',
    why: 'The recorder tracks navigation and frame attachment through the Page domain.',
    requiredBy: ['recorder'],
    dependsOn: ['pipe-version'],
  },
]);

/** The pairing this driver was tested against. A baseline, not a floor. */
export const TESTED_BUILD = '152.0.7977.75';

/** Exact `puppeteer-core` version this repository pins. */
export const DRIVER_VERSION = '25.10.0';

/**
 * Bumped whenever the probe implementation changes.
 *
 * Forgetting to bump it cannot serve stale evidence on its own, because the
 * cache key also includes {@link capabilityTableHash} — but a probe change that
 * leaves the table alone still needs this.
 */
export const PROBE_REVISION = 1;

export const DRIVER_COMPATIBILITY: DriverCompatibilityDescriptor = Object.freeze({
  driverVersion: DRIVER_VERSION,
  testedBuild: TESTED_BUILD,
  probeRevision: PROBE_REVISION,
  capabilities: CAPABILITY_TABLE,
  cftPlatforms: CFT_PLATFORMS,
  isSupportedHost(platform: NodeJS.Platform, arch: string): boolean {
    return `${platform}:${arch}` in CFT_PLATFORMS;
  },
});

/** The Chrome for Testing platform for a host, or null when unsupported. */
export function cftPlatformFor(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  descriptor: DriverCompatibilityDescriptor = DRIVER_COMPATIBILITY,
): ManagedPlatform | null {
  return descriptor.cftPlatforms[`${platform}:${arch}`] ?? null;
}

/** Rows a given caller requires, in dependency order. */
export function requiredCapabilities(
  profile: ProbeProfile,
  descriptor: DriverCompatibilityDescriptor = DRIVER_COMPATIBILITY,
): readonly CapabilityRequirement[] {
  const required = descriptor.capabilities.filter((row) => row.requiredBy.includes(profile));
  return topologicalOrder(required);
}

/**
 * Orders rows so every prerequisite precedes its dependents.
 *
 * The probe reports a row whose prerequisite failed as `not-run` naming that
 * prerequisite, which is only meaningful if the run order respects `dependsOn`.
 */
function topologicalOrder(
  rows: readonly CapabilityRequirement[],
): readonly CapabilityRequirement[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered: CapabilityRequirement[] = [];
  const placed = new Set<CapabilityId>();

  const place = (row: CapabilityRequirement, seen: ReadonlySet<CapabilityId>): void => {
    if (placed.has(row.id)) return;
    if (seen.has(row.id)) throw new Error(`Capability table has a dependency cycle at "${row.id}"`);
    const nextSeen = new Set(seen).add(row.id);
    for (const dependency of row.dependsOn) {
      const prerequisite = byId.get(dependency);
      if (prerequisite !== undefined) place(prerequisite, nextSeen);
    }
    placed.add(row.id);
    ordered.push(row);
  };

  for (const row of rows) place(row, new Set());
  return ordered;
}

/**
 * Stable hash of the declared capability table.
 *
 * Including it in the evidence cache key makes a table edit invalidate cached
 * evidence *by construction*, so a forgotten {@link PROBE_REVISION} bump cannot
 * serve evidence that was gathered under a different set of requirements.
 */
export function capabilityTableHash(
  descriptor: DriverCompatibilityDescriptor = DRIVER_COMPATIBILITY,
): string {
  const canonical = descriptor.capabilities
    .map((row) => [row.id, row.why, [...row.requiredBy].sort(), [...row.dependsOn].sort()])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
}

/** Whether an actual build is the tested pairing or merely capability-checked. */
export function pairingFor(
  version: string,
  descriptor: DriverCompatibilityDescriptor = DRIVER_COMPATIBILITY,
): 'tested' | 'capability-checked' {
  return version === descriptor.testedBuild ? 'tested' : 'capability-checked';
}
